import test from 'node:test';
import assert from 'node:assert/strict';
import {SettingsWindows} from '../../../../user_application/web/settings_windows.js';
class TextNode {
 constructor(value){this.nodeType=3;this.nodeValue=String(value);this.childNodes=[];}
 get textContent(){return this.nodeValue;}cloneNode(){return new TextNode(this.nodeValue);}
 remove(){if(this.parentNode)this.parentNode.childNodes=this.parentNode.childNodes.filter(n=>n!==this);}
}
class Element {
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.nodeType=1;this.attrs={};this.childNodes=[];this.listeners={};this.hidden=false;this.value='';this.checked=false;this.disabled=false;this._text='';}
 get children(){return this.childNodes.filter(n=>n.nodeType===1);}get textContent(){return this.childNodes.map(n=>n.textContent).join("");}set textContent(v){this.replaceChildren(...(String(v)?[new TextNode(v)]:[]));}
 getAttribute(k){return this.attrs[k]??null;}getAttributeNames(){return Object.keys(this.attrs);}setAttribute(k,v){this.attrs[k]=String(v);}removeAttribute(k){delete this.attrs[k];}
 append(...nodes){for(const n of nodes){n.parentNode=this;this.childNodes.push(n);}}replaceChildren(...nodes){this.childNodes=[];this.append(...nodes);}remove(){if(this.parentNode)this.parentNode.childNodes=this.parentNode.childNodes.filter(n=>n!==this);}
 cloneNode(deep){const c=new Element(this.tagName);Object.assign(c,{attrs:{...this.attrs},value:this.value,checked:this.checked,disabled:this.disabled,hidden:this.hidden,_text:this._text});if(deep)c.append(...this.childNodes.map(n=>n.cloneNode(true)));return c;}
 addEventListener(k,fn){(this.listeners[k]??=[]).push(fn);}removeEventListener(k,fn){this.listeners[k]=(this.listeners[k]??[]).filter(f=>f!==fn);}
 dispatchEvent(e){if(!e.target)e.target=this;for(const fn of this.listeners[e.type]??[])fn(e);this['on'+e.type]?.(e);if(e.bubbles&&!e.stopped)this.parentNode?.dispatchEvent(e);return true;}
 insertBefore(node,reference){node.remove();node.parentNode=this;const i=reference?this.childNodes.indexOf(reference):this.childNodes.length;this.childNodes.splice(i,0,node);} contains(n){return n===this||this.childNodes.some(c=>c===n||c.contains?.(n));}
}
class DomEvent{constructor(type,opts={}){Object.assign(this,{type,...opts});}stopPropagation(){this.stopped=true;}preventDefault(){}}
function setup(){
 const template=new Element('section');template.setAttribute('id','settings-panel');template.setAttribute('class','glass');
 const label=new Element('label');label.setAttribute('for','volume');const input=new Element('input');input.setAttribute('id','volume');input.setAttribute('type','range');input.value='45';
 const button=new Element('button');button.setAttribute('id','toggle');button.setAttribute('aria-describedby','status');const status=new Element('p');status.setAttribute('id','status');status.textContent='ready';template.append(label,input,button,status);
 let timer,cleared=0;const document={body:new Element('body'),activeElement:null,defaultView:{Event:DomEvent,MouseEvent:DomEvent,setInterval(fn){timer=fn;return 1;},clearInterval(){cleared++;}}};document.body.append(template);
 const workspace={entries:new Map(),manage(n,o){this.entries.set(n,o);},release(n){this.entries.delete(n);}};
 return {template,input,button,status,document,workspace,tick:()=>timer?.(),cleared:()=>cleared};
}
test('each settings window namespaces references and leaves template hidden',()=>{
 const s=setup(),windows=new SettingsWindows(s),a=windows.open(),b=windows.open();assert.notEqual(a.root,b.root);assert.notEqual(a.root.childNodes[1].getAttribute('id'),b.root.childNodes[1].getAttribute('id'));assert.equal(a.root.childNodes[0].getAttribute('for'),a.root.childNodes[1].getAttribute('id'));assert.equal(a.root.childNodes[2].getAttribute('aria-describedby'),a.root.childNodes[3].getAttribute('id'));assert.equal(s.template.hidden,true);assert.equal(a.root.hidden,false);assert.equal(s.workspace.entries.size,2);windows.destroy();
});
test('button callback executes once and source value/status synchronizes all views',()=>{
 const s=setup();let clicks=0,changes=0;s.button.onclick=()=>{clicks++;s.status.textContent='changed';};s.input.oninput=()=>{changes++;};const windows=new SettingsWindows(s),a=windows.open(),b=windows.open();a.root.childNodes[2].dispatchEvent(new DomEvent('click',{bubbles:true}));assert.equal(clicks,1);assert.equal(b.root.childNodes[3].textContent,'changed');a.root.childNodes[1].value='70';a.root.childNodes[1].dispatchEvent(new DomEvent('input',{bubbles:true}));assert.equal(changes,1);assert.equal(s.input.value,'70');assert.equal(b.root.childNodes[1].value,'70');windows.destroy();
});
test('focused input draft survives background sync and closing one view retains the other',()=>{
 const s=setup(),windows=new SettingsWindows(s),a=windows.open(),b=windows.open();const input=a.root.childNodes[1];s.document.activeElement=input;input.value='draft';s.input.value='22';s.tick();assert.equal(input.value,'draft');assert.equal(b.root.childNodes[1].value,'22');a.close();assert.equal(s.workspace.entries.size,1);assert.equal(windows.instances.size,1);windows.destroy();assert.equal(s.workspace.entries.size,0);assert.ok(s.cleared()>0);
});
test('workspace management class survives sync and removed source attributes clear in mirrors',()=>{
 const s=setup();s.button.setAttribute('aria-pressed','true');const windows=new SettingsWindows(s),v=windows.open();v.root.setAttribute('class',v.root.getAttribute('class')+' ww-managed');s.button.removeAttribute('aria-pressed');windows.sync();assert.match(v.root.getAttribute('class'),/ww-managed/);assert.equal(v.root.childNodes[2].getAttribute('aria-pressed'),null);windows.destroy();
});
test('source structure updates add namespaced controls without copying handlers',()=>{
 const s=setup(),windows=new SettingsWindows(s),v=windows.open();const extra=new Element('button');extra.setAttribute('id','new-control');extra.setAttribute('onclick','bad()');s.template.append(extra);windows.sync();const copy=v.root.childNodes.at(-1);assert.match(copy.getAttribute('id'),/settings-copy-/);assert.equal(copy.getAttribute('onclick'),null);windows.destroy();
});
test('custom mirror identity and dimensions preserve template classes without source marker',()=>{
 const s=setup();s.template.setAttribute('class','glass flight-control-bar');s.template.setAttribute('data-workspace-source','true');
 const windows=new SettingsWindows({...s,kind:'flight-control',label:'비행 조작',width:600,height:240,className:'ww-flight-control'}),v=windows.open();
 assert.deepEqual({...s.workspace.entries.get(v.root),onClose:null},{kind:'flight-control',label:'비행 조작',width:600,height:240,onClose:null});
 assert.match(v.root.getAttribute('class'),/flight-control-bar/);assert.match(v.root.getAttribute('class'),/ww-flight-control/);assert.equal(v.root.getAttribute('data-workspace-source'),null);windows.sync();assert.equal(v.root.getAttribute('data-workspace-source'),null);assert.equal(s.template.hidden,true);windows.destroy();
});

test('clock text node replacement preserves buttons and updates focused play label with one dispatch',()=>{
 const s=setup();let clicks=0;s.button.textContent='Play';s.button.onclick=()=>clicks++;
 const windows=new SettingsWindows(s),v=windows.open(),button=v.root.children[2],clock=v.root.children[3];
 for(let i=0;i<3;i++){s.status.textContent=String(i);windows.sync();assert.equal(v.root.children[2],button);assert.equal(clock.textContent,String(i));}
 s.document.activeElement=button;s.button.textContent='Pause';s.status.textContent='4';windows.sync();
 assert.equal(v.root.children[2],button);assert.equal(button.textContent,'Pause');assert.equal(clock.textContent,'4');
 button.dispatchEvent(new DomEvent('click',{bubbles:true}));assert.equal(clicks,1);windows.destroy();
});
test('adding and removing direct text siblings retains nested controls',()=>{
 const s=setup(),windows=new SettingsWindows(s),v=windows.open(),button=v.root.children[2];
 s.template.insertBefore(new TextNode('before'),s.button);s.template.append(new TextNode('after'));windows.sync();
 assert.equal(v.root.children[2],button);assert.equal(v.root.childNodes[2].textContent,'before');assert.equal(v.root.childNodes.at(-1).textContent,'after');
 s.template.childNodes[2].remove();s.template.childNodes.at(-1).remove();windows.sync();assert.equal(v.root.children[2],button);assert.equal(v.root.childNodes.length,4);windows.destroy();
});

test('singleton settings restores one existing view and recreates only after close',()=>{
 const s=setup();let shown=0;s.workspace.reveal=()=>shown++;const windows=new SettingsWindows({...s,singleton:true}),a=windows.open();assert.equal(windows.open(),a);assert.equal(shown,1);assert.equal(windows.instances.size,1);a.close();assert.notEqual(windows.open(),a);windows.destroy();
});

test('a disclosure the viewer opened belongs to the viewer, and the beat does not shut it',()=>{
 // The window is a copy kept level with the template, and every attribute the
 // template does not have was being taken off the copy. `open` on <details> is
 // not the template's: it is what the person reading this window just did with
 // their hand. It was removed within the quarter-second beat, so 세부 성능 조정
 // opened and shut again and the sliders under it could not be reached.
 const s=setup();
 const fold=new Element('details'),summary=new Element('summary');
 summary.textContent='세부 성능 조정';fold.append(summary);
 const slider=new Element('input');slider.setAttribute('id','max-models');slider.setAttribute('type','range');slider.value='4';
 fold.append(slider);s.template.append(fold);
 const windows=new SettingsWindows(s),view=windows.open();
 const copy=view.root.children.at(-1);
 assert.equal(copy.tagName,'DETAILS');

 copy.setAttribute('open','');
 windows.sync();
 assert.equal(copy.getAttribute('open'),'','펼친 것은 다음 박자에도 펼쳐져 있다');
 s.tick();
 assert.equal(copy.getAttribute('open'),'','250 ms 뒤에도');

 // Closing it is the viewer's too, and closing does not come back open.
 copy.removeAttribute('open');
 windows.sync();
 assert.equal(copy.getAttribute('open'),null);

 // Everything else about the fold still tracks the template, so this is one
 // attribute set aside rather than a hole in the mirror.
 s.template.children.at(-1).setAttribute('class','performance-detail');
 windows.sync();
 assert.equal(copy.getAttribute('class'),'performance-detail');
 assert.equal(view.root.children.at(-1).children.at(-1).value,'4');
 windows.destroy();
});

test('a fold survives the copy being rebuilt when the template grows a control',()=>{
 // A structural change throws the whole copy away and clones it again. That is
 // the other way a fold could shut under a reading hand, and it is rarer rather
 // than impossible -- the settings panel does gain and lose rows.
 const s=setup();
 const fold=new Element('details');fold.append(new Element('summary'));s.template.append(fold);
 const windows=new SettingsWindows(s),view=windows.open();
 view.root.children.at(-1).setAttribute('open','');
 const extra=new Element('button');extra.setAttribute('id','new-control');s.template.append(extra);
 windows.sync();
 const folds=view.root.children.filter(node=>node.tagName==='DETAILS');
 assert.equal(folds.length,1,'복사본은 다시 만들어졌다');
 assert.equal(folds[0].getAttribute('open'),'','펼친 것은 그대로 펼쳐져 있다');
 assert.match(view.root.children.at(-1).getAttribute('id'),/settings-copy-/,'새 컨트롤도 왔다');
 windows.destroy();
});
