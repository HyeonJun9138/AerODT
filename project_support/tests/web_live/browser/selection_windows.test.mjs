import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
class Node {
 constructor(id=''){this.id=id;this.dataset={};this.children=[];this.attributes={};this.hidden=true;this.classList={add:()=>{}};}
 append(...children){for(const n of children){n.parent=this;this.children.push(n);}}
 querySelectorAll(selector){const all=this.children.flatMap(n=>[n,...n.querySelectorAll('*')]);return selector==='[id]'?all.filter(n=>n.id):all;}
 cloneNode(){const n=new Node(this.id);n.attributes={...this.attributes};n.append(...this.children.map(c=>c.cloneNode(true)));return n;}
 getAttribute(k){return this.attributes[k]??null;} setAttribute(k,v){this.attributes[k]=v;} removeAttribute(k){delete this.attributes[k];}
 replaceChildren(...nodes){this.children=[];this.append(...nodes);} remove(){this.parent.children=this.parent.children.filter(n=>n!==this);}
}
function harness(){
 const source=readFileSync(new URL('../../../../user_application/web/selection_windows.js',import.meta.url),'utf8').replace(/^import .*;$/mg,'').replace('export class SelectionWindows','class SelectionWindows')+'\nglobalThis.Result=SelectionWindows';
 const timers=new Map();let timer=0;
 class SelectionPanel {constructor(C,options){this.options=options;this.values=[];this.preview={close(){}};}setAssets(a){this.assets=a;}show(e){this.entity=e;this.values.push(e);}setMission(d){this.mission=d;}setSensors(d){this.sensors=d;}setTrajectory(d){this.trajectory=d;}destroy(){this.destroyed=true;}}
 const ctx={SelectionPanel,mapEntityName:e=>e.entity_id,setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id)};
 vm.runInNewContext(source,ctx);
 const template=new Node('selection');for(const id of ['model-preview','preview-credits','selected-name','focus','track','cockpit-view','clear'])template.append(new Node(id));
 const label=new Node('label');label.setAttribute('aria-labelledby','selected-name');template.append(label);
 const body=new Node('body');body.append(template);const document={body,createElement:()=>new Node()};const entries=[];
 const workspace={manage(root,options){const e={root,options,close(){options.onClose();}};entries.push(e);return e;}};
 return {Windows:ctx.Result,document,template,workspace,entries,timers};
}
test('every open owns a panel and namespaced markup; snapshots update only its target',()=>{
 const h=harness(),windows=new h.Windows(h);const a=windows.open({entity_id:'a'}),b=windows.open({entity_id:'b'}),again=windows.open({entity_id:'a'});
 assert.notEqual(a.panel,b.panel);assert.notEqual(a.id,again.id);assert.equal(h.entries.length,3);
 const ids=[a,b,again].flatMap(c=>[c.root,...c.root.querySelectorAll('[id]')].map(n=>n.id));assert.equal(ids.length,new Set(ids).size);
 const label=a.root.querySelectorAll('*').find(n=>n.dataset.selectionId==='label');assert.equal(label.getAttribute('aria-labelledby'),a.root.querySelectorAll('*').find(n=>n.dataset.selectionId==='selected-name').id);
 const next={entity_id:'a',altitude_m:42};windows.observe({entities:[next]});assert.equal(a.panel.entity,next);assert.equal(again.panel.entity,next);assert.equal(b.panel.entity.entity_id,'b');windows.destroy();
});
test('callbacks retain their own target and closing disposes monitor and late detail results',async()=>{
 const h=harness(),follow=[];let resolve;
 const windows=new h.Windows({...h,onFollow:id=>follow.push(id),getMission:()=>new Promise(r=>{resolve=r;})});
 const a=windows.open({entity_id:'a',kind:'uam'});a.root.querySelectorAll('*').find(n=>n.dataset.selectionId==='track').onclick();assert.deepEqual(follow,['a']);
 a.close();resolve({state:{aircraft_id:'a'}});await Promise.resolve();await Promise.resolve();assert.equal(a.panel.destroyed,true);assert.equal(a.panel.mission,undefined);assert.equal(h.timers.size,0);assert.equal(h.document.body.children.length,1);
});

test('closing releases the workspace registration as well as the panel',()=>{
 const h=harness(),released=[];h.workspace.release=root=>released.push(root);
 const windows=new h.Windows(h),controller=windows.open({entity_id:'a'});controller.close();controller.close();
 assert.deepEqual(released,[controller.root]);
});
test('independent inspection styles use stable scoped identifiers without drawer positioning',()=>{
 const css=readFileSync(new URL('../../../../user_application/web/selection_windows.css',import.meta.url),'utf8');
 assert.match(css,/\.selection-window/);assert.match(css,/\[data-selection-id="model-preview"\]/);
 assert.match(css,/\.selection-body[^}]*overflow:auto/);assert.match(css,/\.selection-readouts/);
 assert.doesNotMatch(css,/#selection\b|#selected-|#model-preview|translateX|scenario-console-height/);
});

test('singleton selection reuses same target and replaces different target without duplication',()=>{
 const h=harness();let shown=0;h.workspace.reveal=()=>shown++;const windows=new h.Windows({...h,singleton:true});const a=windows.open({entity_id:'a'});assert.equal(windows.open({entity_id:'a'}),a);assert.equal(shown,1);const b=windows.open({entity_id:'b'});assert.equal(a.closed,true);assert.equal(windows.windows.size,1);assert.equal(b.entityId,'b');windows.destroy();
});

test('duplicate preview credits stay hidden while the existing page attribution remains',()=>{
 const h=harness(),attribution=new Node('attribution');h.document.body.append(attribution);h.document.getElementById=id=>id==='attribution'?attribution:null;
 const windows=new h.Windows(h),view=windows.open({entity_id:'a'}),credits=view.panel.options.creditContainer;
 assert.equal(credits.parent,attribution);assert.equal(credits.hidden,true);assert.equal(credits.getAttribute('aria-hidden'),'true');view.close();assert.equal(attribution.children.length,0);windows.destroy();
});

test('the window carries the camera button: shown for what carries a camera, opening it for that aircraft',()=>{
 // The window clones the page's template, button included, hidden. Without its
 // own wiring the button stayed hidden and did nothing - which is how a user
 // asked where it was.
 const h=harness();h.template.append(new Node('camera-live'));
 const opened=[];
 const windows=new h.Windows({...h,onCamera:id=>opened.push(id),supportsCamera:entity=>entity.kind==='uam'});
 const a=windows.open({entity_id:'a',kind:'uam'});
 const button=a.root.querySelectorAll('*').find(n=>n.dataset.selectionId==='camera-live');
 assert.equal(button.hidden,false,'a UAM carries a camera');
 button.onclick();assert.deepEqual(opened,['a'],'and the button opens it for this window\'s aircraft');
 const s=windows.open({entity_id:'s',kind:'satellite'});
 assert.equal(s.root.querySelectorAll('*').find(n=>n.dataset.selectionId==='camera-live').hidden,true,'a satellite does not');
 windows.destroy();
});
test('explicit dismissal notifies once, replacement and destruction do not dismiss map selection',()=>{
 const h=harness(),dismissed=[];const windows=new h.Windows({...h,singleton:true,onDismiss:id=>dismissed.push(id)});
 windows.open({entity_id:'a'});const b=windows.open({entity_id:'b'});assert.deepEqual(dismissed,[]);
 b.entry.close();b.close();assert.deepEqual(dismissed,['b']);
 windows.open({entity_id:'c'});windows.destroy();assert.deepEqual(dismissed,['b']);
});
test('page dismiss handler clears only its selected aircraft, not a newer target',()=>{
 const source=readFileSync(new URL('../../../../user_application/web/app.js',import.meta.url),'utf8');
 const callback=source.match(/onDismiss:id=>\{([\s\S]*?)\n    \},/);assert.ok(callback);
 const calls=[],globe={selected:'a',detailId:null,select:id=>calls.push(id),refreshDetails:()=>calls.push('refresh')};
 const context={globe,replayPresentation:null};vm.runInNewContext(`handler=id=>{${callback[1]}}`,context);
 context.handler('a');assert.deepEqual(calls,[null]);calls.length=0;
 globe.selected='b';context.handler('a');assert.deepEqual(calls,[]);
 globe.detailId='a';context.handler('a');assert.equal(globe.detailId,null);assert.deepEqual(calls,['refresh']);
});

test('radar button opens the window target, not another selected aircraft',()=>{
 const h=harness();h.template.append(new Node('radar-live'));const targets=[];
 const windows=new h.Windows({...h,onRadar:id=>targets.push(id)});
 const view=windows.open({entity_id:'a',kind:'uam'});
 view.root.querySelectorAll('*').find(n=>n.dataset.selectionId==='radar-live').onclick();
 assert.deepEqual(targets,['a']);windows.destroy();
});

test('selection actions use three view buttons and two auxiliary buttons in two rows',()=>{
 const base=new URL('../../../../user_application/web/',import.meta.url);
 const html=readFileSync(new URL('index.html',base),'utf8');
 assert.match(html,/<button id="radar-live"[^>]*>주변 교통 레이더<\/button>/);
 const css=readFileSync(new URL('selection_windows.css',base),'utf8');
 assert.match(css,/grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
 assert.match(css,/\.actions button\{grid-column:span 2/);
 assert.match(css,/\.actions \.radar-live\{grid-column:span 3/);
});
