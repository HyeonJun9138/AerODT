import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const module=await import('../../../../user_application/web/welcome_screen.js').catch(()=>({}));
function setup() {
  assert.equal(typeof module.WelcomeScreen,'function','welcome controller exists');
  const events=new Map(),jobs=new Map();let seq=0,focused=0;
  const button={disabled:false,focus(){focused++;},addEventListener(k,v){events.set('button:'+k,v);},removeEventListener(k){events.delete('button:'+k);}};
  const root={open:false,dataset:{},showModal(){this.open=true;},close(){this.open=false;},
    addEventListener(k,v){events.set(k,v);},removeEventListener(k){events.delete(k);},querySelectorAll(){return [];}};
  const scope={innerWidth:1440,innerHeight:900,addEventListener(k,v){events.set('window:'+k,v);},removeEventListener(k){events.delete('window:'+k);}};
  const screen=new module.WelcomeScreen({root,button,scope,document:{getElementById(){return null;}},
    setTimer:function(fn){assert.equal(this,undefined,'native timers must not receive the controller as their Window receiver');jobs.set(++seq,fn);return seq;},
    clearTimer:function(id){assert.equal(this,undefined);jobs.delete(id);}});
  const flush=()=>{for(const [id,fn] of [...jobs]){jobs.delete(id);fn();}};
  return {screen,root,button,events,jobs,flush,focused:()=>focused};
}
test('welcome waits for arrival, then locks the page through a native modal before fading in',async()=>{
  const s=setup();let arrive;const entry=new Promise(resolve=>arrive=resolve);
  const opening=s.screen.afterEntry(entry);assert.equal(s.root.open,false);
  arrive();await opening;assert.equal(s.root.open,true);assert.equal(s.root.dataset.phase,'preparing');
  assert.equal(s.button.disabled,true);s.flush();assert.equal(s.root.dataset.phase,'ready');
  assert.equal(s.button.disabled,false);assert.equal(s.focused(),1);
});
test('START fades away once; background stays inert until the exit is finished',async()=>{
  const s=setup();await s.screen.afterEntry(Promise.resolve());s.flush();
  s.events.get('button:click')();s.events.get('button:click')();
  assert.equal(s.root.dataset.phase,'leaving');assert.equal(s.root.open,true);assert.equal(s.jobs.size,1);
  s.flush();assert.equal(s.root.open,false);assert.equal(s.root.dataset.phase,'closed');
  await s.screen.afterEntry(Promise.resolve());assert.equal(s.root.open,false,'not twice in the same boot');
});
test('reduced motion opens and closes immediately; Escape cannot bypass START',async()=>{
  const s=setup();await s.screen.afterEntry(Promise.resolve(),{reducedMotion:true});
  assert.equal(s.root.dataset.phase,'ready');assert.equal(s.jobs.size,0);
  let prevented=false;s.events.get('cancel')({preventDefault(){prevented=true;}});assert.ok(prevented);
  let stopped=false,escapePrevented=false;s.events.get('keydown')({key:'Escape',stopPropagation(){stopped=true;},preventDefault(){escapePrevented=true;}});assert.ok(stopped);assert.ok(escapePrevented);
  s.events.get('button:click')();assert.equal(s.root.open,false);
});
test('failed entry does not show a false ready screen; disposed arrival cannot reopen',async()=>{
  const a=setup();await assert.rejects(a.screen.afterEntry(Promise.reject(new Error('entry failed'))),/entry failed/);
  assert.equal(a.root.open,false);
  const b=setup();let arrive;const opening=b.screen.afterEntry(new Promise(r=>arrive=r));b.screen.destroy();arrive();await opening;
  assert.equal(b.root.open,false);assert.equal(b.events.size,0);
  const c=setup();await c.screen.afterEntry(Promise.resolve());const late=[...c.jobs.values()][0];c.screen.destroy();late();
  assert.equal(c.root.open,false);assert.equal(c.jobs.size,0);
});
test('markup identifies the real UI regions and the repository version, without a remembered bypass',()=>{
  const read=path=>readFileSync(new URL('../../../../'+path,import.meta.url),'utf8');
  const html=read('user_application/web/index.html'),app=read('user_application/web/app.js');
  assert.match(html,/<dialog id="welcome"[^>]*aria-labelledby="welcome-title"/);
  for(const domain of ['satellite','uam'])assert.ok(html.includes(`data-domain-choice="${domain}"`));
  assert.doesNotMatch(html,/id="welcome-start"/);
  const version=read('CMakeLists.txt').match(/project\(AeroDT VERSION ([\d.]+)/)[1];
  assert.ok(html.includes(`v${version}`));
  assert.match(app,/onLeave:\(\)=>domainChooser\.show\(\)/);
  assert.match(app,/domainChooser\.destroy\(\)/);
  const js=read('user_application/web/domains/domain_chooser.js');assert.doesNotMatch(js,/localStorage|sessionStorage|setInterval/);
});
test('hints follow actual target rectangles and update only while the dialog is open',async()=>{
  const s=setup(),values={};let reads=0,left=76;
  s.root.querySelectorAll=()=>[{dataset:{welcomeTarget:'rail'},style:{setProperty(k,v){values[k]=v;}}}];
  s.screen.document={getElementById:()=>({getBoundingClientRect(){reads++;return {left,top:0,width:76,height:900};}})};
  await s.screen.afterEntry(Promise.resolve(),{reducedMotion:true});assert.equal(values['--target-left'],'76px');
  left=56;s.events.get('window:resize')();assert.equal(values['--target-left'],'56px');
  left=58;s.flush();assert.equal(values['--target-left'],'58px','responsive CSS transitions are measured after settling');
  s.screen.dismiss();const before=reads;s.events.get('window:resize')();assert.equal(reads,before);
});
