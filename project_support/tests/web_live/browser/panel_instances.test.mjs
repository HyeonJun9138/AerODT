import test from 'node:test';
import assert from 'node:assert/strict';
import {createPanel,copyPanel,repeatPanel} from '../../../../user_application/web/panel_instances.js';
class Panel {
 constructor(options={}){this.options=options;this.root=null;this.selected=[];this.destroyed=0;}
 get isOpen(){return Boolean(this.root);}
 open(value){this.selected.push(value);this.root={removed:false,remove(){this.removed=true;}};}
 observe(value){this.snapshot=value;}
 close(){this.root?.remove();this.root=null;}
 destroy(){this.destroyed++;this.close();}
}
const workspace=()=>({entries:new Map(),manage(node,opts){this.entries.set(node,opts);},release(node){this.entries.delete(node);}});
test('copies constructor dependencies but never mutable view state',()=>{
 const api={};const source=createPanel(Panel,{api,role:'a'});source.selected.push('source');
 const copy=copyPanel(source,{role:'b'});assert.equal(copy.options.api,api);assert.equal(copy.options.role,'b');assert.deepEqual(copy.selected,[]);
});
test('each open creates independent controller and closing native window disposes only it',()=>{
 const source=createPanel(Panel);const w=workspace();const group=repeatPanel(w,source,{kind:'panel',label:'Panel'});
 const a=source.open('a'),b=source.open('b');assert.notEqual(a,b);assert.deepEqual(a.selected,['a']);assert.deepEqual(b.selected,['b']);assert.equal(source.isOpen,true);assert.equal(w.entries.size,2);
 a.close();assert.equal(a.destroyed,1);assert.equal(group.instances.size,1);assert.equal(b.isOpen,true);assert.equal(w.entries.size,1);
 source.destroy();assert.equal(b.destroyed,1);assert.equal(w.entries.size,0);assert.equal(source.isOpen,false);
});
test('feed fans out and last snapshot seeds new windows by reference',()=>{
 const source=createPanel(Panel),snapshot={id:1};const group=repeatPanel(workspace(),source,{feedMethods:['observe']});
 source.observe(snapshot);const a=source.open();assert.equal(a.snapshot,snapshot);const b=source.open();const next={id:2};source.observe(next);
 assert.equal(source.snapshot,next);assert.equal(a.snapshot,next);assert.equal(b.snapshot,next);a.close();source.observe(snapshot);assert.equal(a.snapshot,next);group.destroy();
});
test('workspace close disposes instance and custom creation and prepare isolate selection',()=>{
 const source=createPanel(Panel),w=workspace();source.selected=['a'];repeatPanel(w,source,{create:s=>copyPanel(s,{special:true}),prepare:(c,s)=>c.selected=[...s.selected]});
 const child=source.open('b');assert.equal(child.options.special,true);assert.deepEqual(source.selected,['a']);w.entries.get(child.root).onClose();assert.equal(child.destroyed,1);assert.equal(w.entries.size,0);
});
test('asynchronous root is managed before open settles and closing cannot resurrect it',async()=>{
 let resume;class AsyncPanel extends Panel{async open(){super.open();await new Promise(r=>resume=r);this.root={remove(){this.removed=true;}};}}
 const w=workspace(),source=createPanel(AsyncPanel);const group=repeatPanel(w,source);const opened=source.open();assert.equal(w.entries.size,1);
 const child=[...group.instances][0];child.close();resume();await opened;assert.equal(group.instances.size,0);assert.equal(w.entries.size,0);assert.equal(child.root,null);
});
test('failed async opens clean up their controller',async()=>{
 class Bad extends Panel{async open(){super.open();throw new Error('failed');}}
 const w=workspace(),s=createPanel(Bad),g=repeatPanel(w,s);await assert.rejects(s.open(),/failed/);assert.equal(g.instances.size,0);assert.equal(w.entries.size,0);
});
test('native opening may close an old root before mounting without disposing new child',()=>{
 class Replacing extends Panel{open(value){this.close();super.open(value);}}
 const w=workspace(),s=createPanel(Replacing),g=repeatPanel(w,s);const child=s.open('a');assert.equal(child.isOpen,true);assert.equal(child.destroyed,0);assert.equal(g.instances.size,1);assert.equal(w.entries.size,1);child.close();assert.equal(g.instances.size,0);
});
test('alternate close method releases only the child window',()=>{
 class Info extends Panel{showInfo(){this.info={remove(){}};}closeInfo(){this.info?.remove();this.info=null;}}
 const w=workspace(),s=createPanel(Info),g=repeatPanel(w,s,{method:'showInfo',root:'info',closeMethod:'closeInfo'});const c=s.showInfo();c.closeInfo();assert.equal(g.instances.size,0);assert.equal(w.entries.size,0);
});
test('child internal reopen updates same controller instead of multiplying windows',()=>{
 class Replacing extends Panel{open(value){this.close();super.open(value);}}
 const w=workspace(),s=createPanel(Replacing),g=repeatPanel(w,s);const c=s.open('a');c.open('b');assert.equal(g.instances.size,1);assert.equal(w.entries.size,1);assert.equal(c.destroyed,0);assert.deepEqual(c.selected,['a','b']);g.destroy();
});
test('source destruction permits legacy writable isOpen cleanup',()=>{
 class Writable extends Panel{constructor(opts){super(opts);Object.defineProperty(this,'isOpen',{configurable:true,writable:true,value:false});}destroy(){this.isOpen=false;super.destroy();}}
 const s=createPanel(Writable);repeatPanel(workspace(),s);s.open();assert.equal(s.isOpen,true);assert.doesNotThrow(()=>s.destroy());assert.equal(s.isOpen,false);
});
test('root mounted after an await is registered while later await is still pending',async()=>{
 let mount,finish;class Delayed extends Panel{async open(){await new Promise(r=>mount=r);super.open();await new Promise(r=>finish=r);}}
 const w=workspace(),s=createPanel(Delayed);const g=repeatPanel(w,s);const pending=s.open();assert.equal(w.entries.size,0);mount();await Promise.resolve();await Promise.resolve();assert.equal(w.entries.size,1);finish();await pending;g.destroy();
});

test('closing a parent facade does not close its independently launched detail windows',()=>{
 const source=createPanel(Panel),w=workspace();const group=repeatPanel(w,source,{retainChildrenOnSourceDestroy:true});const a=source.open('a');source.destroy();assert.equal(a.destroyed,0);assert.equal(w.entries.size,1);group.destroy();assert.equal(a.destroyed,1);assert.equal(w.entries.size,0);
});

test('single window policy reuses an existing controller and permits reopen after close',()=>{
 const source=createPanel(Panel),w=workspace();let shown=0;w.reveal=()=>shown++;repeatPanel(w,source,{kind:'panel',singleton:true});
 const a=source.open('a'),b=source.open('a');assert.equal(a,b);assert.equal(shown,1);a.close();assert.notEqual(source.open('a'),a);
});

test('singleton is shared by launchers of the same kind',()=>{
 const w=workspace(),a=createPanel(Panel),b=createPanel(Panel);repeatPanel(w,a,{kind:'pilot',singleton:true});repeatPanel(w,b,{kind:'pilot',singleton:true});assert.equal(a.open(),b.open());assert.equal(w.entries.size,1);a.destroy();b.destroy();
});

test('a launcher whose group was destroyed says so instead of silently doing nothing', () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    class Panel {constructor(o = {}) {this.options = o; this.root = null;} open() {this.root = {remove() {}}; return this;} close() {} destroy() {}}
    const workspace = {manage() {return {};}, release() {}, reveal() {}};
    const source = new Panel();
    repeatPanel(workspace, source, {kind: 'demo', label: '데모', create: () => new Panel()});
    source.destroy();
    assert.equal(source.open(), undefined);
    assert.ok(warnings.some(w => /데모 창을 여는 원본 패널이 이미 정리/.test(w)), warnings.join(' | '));
  } finally {console.warn = original;}
});
