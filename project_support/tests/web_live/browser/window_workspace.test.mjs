import test from 'node:test';import assert from 'node:assert/strict';
import {WindowWorkspace} from '../../../../user_application/web/window_workspace.js';
test('unchanged visibility does not mutate observed attributes and schedule itself forever',()=>{
 let writes=0;const content={},tab={setAttribute(){},get hidden(){return false;},set hidden(v){writes++;}};
 const e={id:'selection',node:{isConnected:true,parentElement:content},content,tab,shell:{hidden:false},open:true,minimized:false};
 const w=Object.create(WindowWorkspace.prototype);Object.assign(w,{entries:new Map([['selection',e]]),document:{querySelectorAll:()=>[]},visible:()=>true});w.scan();assert.equal(writes,0);
});
test('cancelled drag restores geometry and snap instead of saving a partial move',()=>{
 let moved,up,cancel,stored=0;const handle={setPointerCapture(){},releasePointerCapture(){},addEventListener(k,f){if(k==='pointermove')moved=f;if(k==='pointerup')up=f;if(k==='pointercancel')cancel=f;},removeEventListener(){}};
 const w=Object.create(WindowWorkspace.prototype),e={rect:{x:100,y:100,width:300,height:300},snap:'left'};
 Object.assign(w,{raise(){},paint(){},area:()=>({x:88,y:80,width:1000,height:650}),save(){stored++;},document:{body:{classList:{add(){},remove(){}}}},preview:{hidden:true,style:{}},previewLabel:{}});
 w.begin(e,{button:0,pointerId:1,clientX:200,clientY:110,currentTarget:handle,preventDefault(){},stopPropagation(){}});moved({pointerId:1,clientX:250,clientY:150});cancel();assert.deepEqual(e.rect,{x:100,y:100,width:300,height:300});assert.equal(e.snap,'left');assert.equal(stored,0);
});

test('minimizing only hides the shell and retains the live panel node',()=>{
 const w=Object.create(WindowWorkspace.prototype);let saved=0,focused=0;const node={hidden:false},e={node,open:true,minimized:false,menu:{open:true},rect:{x:88,y:80,width:300,height:300},shell:{style:{},dataset:{}},tab:{setAttribute(){},focus(){focused++;}}};
 Object.assign(w,{save(){saved++;}});w.minimize(e);assert.equal(e.shell.hidden,true);assert.equal(node.hidden,false);assert.equal(e.open,true);assert.equal(saved,1);assert.equal(focused,1);
});


import {FakeElement} from './fake_dom.mjs';
function workspaceFixture(){
 const document={createElement:tag=>element(tag),getElementById:()=>null,querySelector:selector=>document.body.querySelector(selector),querySelectorAll:selector=>document.body.querySelectorAll(selector)};
 function element(tag){const n=new FakeElement(tag);Object.defineProperties(n,{parentNode:{get:()=>n.parent},parentElement:{get:()=>n.parent},isConnected:{get:()=>n===document.body||Boolean(n.parent?.isConnected)}});n.classList={add:c=>{n.className+=' '+c;},remove:c=>{n.className=n.className.split(' ').filter(x=>x!==c).join(' ');}};n.addEventListener=()=>{};n.focus=()=>{};n.before=other=>{const p=n.parent;if(!p)return;other.remove();other.parent=p;p.children.splice(p.children.indexOf(n),0,other);};n.remove=()=>{if(n.parent)n.parent.children=n.parent.children.filter(c=>c!==n);n.parent=null;};n.append=(...nodes)=>{for(const child of nodes){child.remove();child.parent=n;n.children.push(child);}};return n;}
 document.body=element('body');const window={innerWidth:1280,innerHeight:800,getComputedStyle:n=>({display:n.style.display??'block'})};const w=new WindowWorkspace({document,window,storage:{getItem:()=>null,setItem(){}}});w.tabs=element('nav');document.body.append(w.tabs);return {w,document,element};
}
test('same-kind panel roots are registered independently and rescanning preserves identities',()=>{
 const {w,document,element}=workspaceFixture();const a=element('div'),b=element('div');a.className=b.className='prediction-workspace';document.body.append(a,b);w.scan();assert.equal(w.entries.size,2);const entries=[...w.entries.values()];assert.notEqual(entries[0].id,entries[1].id);assert.equal(entries[0].kind,'prediction');w.scan();assert.deepEqual([...w.entries.values()],entries);
});
test('manage returns a stable entry and create provides an independent content root',()=>{
 const {w,element,document}=workspaceFixture();const n=element('div');document.body.append(n);const a=w.manage(n,{kind:'simulation',label:'Simulation'});assert.equal(w.manage(n,{kind:'simulation'}),a);const b=w.create({kind:'simulation',label:'Simulation'});assert.notEqual(a.id,b.entry.id);assert.equal(b.entry.node,b.node);assert.equal(w.entries.size,2);assert.equal(b.entry.open,true);
 assert.deepEqual(a.header.querySelectorAll('button').filter(b=>b.className.includes('ww-control')).map(b=>b.textContent),['−','×']);
});
test('closing one managed window is callback-safe and does not close its sibling',()=>{
 const {w}=workspaceFixture();let closed=0,activated=0;const a=w.create({kind:'simulation',label:'Simulation',onClose:()=>{closed++;w.close(a.entry);},onActivate:()=>activated++});const b=w.create({kind:'simulation',label:'Simulation'});w.raise(a.entry);assert.ok(activated>0);w.close(a.entry);assert.equal(closed,1);assert.equal(a.node.hidden,true);assert.equal(b.node.hidden,false);assert.equal(b.entry.open,true);
});
test('fallback close never invokes simulation controls and hides only presentation',()=>{
 const {w}=workspaceFixture();let stopped=0;const {node,entry}=w.create({kind:'simulation',label:'Simulation'});node.append(w.el('button',{class:'sc-close',text:'닫기',onclick:()=>stopped++}));w.close(entry);assert.equal(stopped,0);assert.equal(node.hidden,true);
});
test('reset includes all generic and repeated windows',()=>{
 const {w}=workspaceFixture();const a=w.create({kind:'custom',width:400,height:300}),b=w.create({kind:'custom',width:450,height:350});a.entry.snap=b.entry.snap='left';w.reset();assert.equal(a.entry.snap,null);assert.equal(b.entry.snap,null);assert.equal(b.entry.rect.width,450);
});

test('release removes detached presentation registration without invoking the close callback',()=>{
 const {w}=workspaceFixture();let closed=0;const {node,entry}=w.create({kind:'panel',onClose:()=>closed++});node.remove();w.release(node);w.release(node);assert.equal(w.entries.size,0);assert.equal(entry.shell.isConnected,false);assert.equal(closed,0);
});
test('explicit management of an autodetected root installs independent behavior and callbacks',()=>{
 const {w,document,element}=workspaceFixture();const node=element('div');node.className='prediction-workspace';document.body.append(node);w.scan();const e=[...w.entries.values()][0];let closed=0;assert.equal(w.manage(node,{kind:'prediction',onClose:()=>closed++}),e);assert.equal(e.independent,true);w.close(e);assert.equal(closed,1);
});
test('legacy selection and port info close buttons remain the presentation dismissal targets',()=>{
 const {w,element,document}=workspaceFixture();for(const [kind,label] of [['selection','정보 창 숨기기'],['port-info','버티포트 정보 닫기']]){let dismissed=0;const node=element('div');document.body.append(node);const button=w.el('button',{onclick:()=>dismissed++});node.querySelector=selector=>selector===`button[aria-label="${label}"]`?button:null;const entry=w.manage(node,{kind});w.close(entry);assert.equal(dismissed,1);}
});

test('placement choices show screen diagrams and retain labelled snap actions',()=>{
 const {w}=workspaceFixture();const {entry}=w.create({kind:'panel',label:'시험'});
 const choices=entry.menu.querySelectorAll('button');assert.equal(choices.length,10);
 for(const button of choices){assert.ok(button.querySelector('.ww-layout-picture'));assert.ok(button.getAttribute('aria-label'));}
 const left=choices.find(b=>b.getAttribute('aria-label')==='왼쪽');left.onclick();assert.equal(entry.snap,'left');
 const bottom=choices.find(b=>b.getAttribute('aria-label')==='왼쪽 아래');bottom.onclick();assert.equal(entry.snap,'left-bottom');
 const fill=bottom.querySelector('.ww-layout-fill');assert.ok(parseFloat(fill.style.top)>40);assert.ok(parseFloat(fill.style.height)<51);
 assert.ok(entry.menu.querySelector('summary').querySelector('.ww-layout-picture'));
});

test('reveal restores a minimized window without changing its placement',()=>{
 const {w}=workspaceFixture(),{node,entry}=w.create({kind:'panel'});const rect={...entry.rect};w.minimize(entry);assert.equal(entry.shell.hidden,true);w.reveal(node);assert.equal(entry.minimized,false);assert.equal(entry.shell.hidden,false);assert.deepEqual(entry.rect,rect);
});
