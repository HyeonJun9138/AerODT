import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DOMAINS,scopeSnapshot,scopeDescription,scopedLibraryApi} from '../../../../user_application/web/domains/domain_catalog.js';
import {DomainChooser} from '../../../../user_application/web/domains/domain_chooser.js';
import {prepareDomainEntry} from '../../../../user_application/web/domains/domain_entry.js';
import {earthView} from '../../../../user_application/web/domains/satellite/workspace.js';

const snapshot=Object.freeze({state_time:123,epoch:2,sequence:4,entities:Object.freeze([
  Object.freeze({entity_id:'u',kind:'uam'}),Object.freeze({entity_id:'a',kind:'aircraft'}),Object.freeze({entity_id:'s',kind:'satellite'})]),
  sources:[{id:'opensky'},{id:'celestrak'}]});
test('no selected domain exposes entities or sources',()=>{
  const scoped=scopeSnapshot(snapshot,null);assert.deepEqual(scoped.entities,[]);assert.deepEqual(scoped.sources,[]);
});
test('UAM presentation retains aircraft and UAM but not satellite state',()=>{
  const result=scopeSnapshot(snapshot,'uam');assert.deepEqual(result.entities.map(e=>e.entity_id),['u','a']);
  assert.equal(result.entities[0],snapshot.entities[0]);assert.equal(result.epoch,2);assert.equal(snapshot.entities.length,3);
  assert.deepEqual(result.sources.map(s=>s.id),['opensky']);
});
test('Satellite cannot expose UAM traffic or its collection source',()=>{
  const result=scopeSnapshot(snapshot,'satellite');assert.deepEqual(result.entities.map(e=>e.entity_id),['s']);
  assert.deepEqual(result.sources.map(s=>s.id),['celestrak']);assert.equal(DOMAINS.satellite.sound,false);
});
const description={sources:[{id:'satellite',group:'assets'},{id:'uam',group:'assets'},{id:'terrain',group:'map'},{id:'uam_prediction',group:'ai'}],
  groups:[{id:'assets',kind:'sources'},{id:'map',kind:'sources'},{id:'ai',kind:'sources'}],
  values:{satellite:{enabled:true},uam:{enabled:true},terrain:{enabled:true},uam_prediction:{enabled:true}},
  state:[{id:'satellite'},{id:'uam'}]};
test('Satellite settings contain only its source and shared map settings',()=>{
  const result=scopeDescription(description,'satellite');assert.deepEqual(Object.keys(result.values),['satellite','terrain']);
  assert.deepEqual(result.groups.map(g=>g.id),['assets','map']);assert.deepEqual(result.state,[{id:'satellite'}]);
  assert.ok(description.values.uam);
});
test('scoped API cannot write another domain, and reading never writes collection switches',async()=>{
  let writes=0;const api=scopedLibraryApi({describe:async()=>description,apply:async()=>{writes++;return description;}},()=> 'satellite');
  await api.describe();assert.equal(writes,0);
  await assert.rejects(api.apply({sources:{uam:{enabled:false}}}),/현재 도메인/);assert.equal(writes,0);
  await api.apply({sources:{terrain:{enabled:false}}});assert.equal(writes,1);
  assert.throws(()=>api.exports(),/UAM/);
});
function chooser(onSelect,options={}){
  const status={textContent:''};const buttons=['satellite','uam'].map(id=>({dataset:{domainChoice:id},disabled:false,addEventListener(){},removeEventListener(){},focus(){}}));
  const root={dataset:{},open:false,querySelectorAll:()=>buttons,querySelector:()=>status,addEventListener(){},removeEventListener(){},showModal(){this.open=true;},close(){this.open=false;}};
  return {root,buttons,status,screen:new DomainChooser({root,onSelect,transitionMs:0,...options})};
}
test('opening chooser neither selects nor moves camera',()=>{
  let calls=0;const c=chooser(()=>calls++);c.screen.show();assert.equal(calls,0);assert.equal(c.root.open,true);c.screen.destroy();
});
test('one click activates exactly one domain; duplicate and unknown choices are ignored',async()=>{
  let finish;const selected=[];const c=chooser(id=>{selected.push(id);return new Promise(r=>finish=r);});c.screen.show();
  const pending=c.screen.choose('satellite');assert.ok(c.buttons.every(b=>b.disabled));
  assert.equal(await c.screen.choose('uam'),false);assert.equal(await c.screen.choose('invalid'),false);
  finish();assert.equal(await pending,true);assert.deepEqual(selected,['satellite']);assert.equal(c.root.open,false);
});
test('failed activation remains visible and allows retry instead of hiding the error',async()=>{
  const c=chooser(async()=>{throw new Error('renderer failed');});c.screen.show();assert.equal(await c.screen.choose('uam'),false);
  assert.equal(c.root.open,true);assert.match(c.status.textContent,/renderer failed/);assert.ok(c.buttons.every(b=>!b.disabled));
});
test('successful selection fades the chooser before close and reveals the prepared scene afterwards',async()=>{
  const jobs=[];let revealed=0;
  const c=chooser(async()=>{}, {transitionMs:420,setTimer:(fn,ms)=>{jobs.push({fn,ms});return 1;},clearTimer:()=>{},onAfterClose:()=>revealed++});
  c.screen.show();const pending=c.screen.choose('satellite');
  await Promise.resolve();await Promise.resolve();
  assert.equal(c.root.dataset.phase,'leaving');assert.equal(c.root.open,true);assert.equal(revealed,0);
  assert.equal(jobs[0].ms,420);jobs[0].fn();assert.equal(await pending,true);
  assert.equal(c.root.open,false);assert.equal(c.root.dataset.phase,'closed');assert.equal(revealed,1);
});
test('disposing during the fade cancels a late close/reveal',async()=>{
  const jobs=[];let revealed=0;
  const c=chooser(async()=>{}, {transitionMs:420,setTimer:fn=>{jobs.push(fn);return 1;},clearTimer:()=>{},onAfterClose:()=>revealed++});
  c.screen.show();const pending=c.screen.choose('uam');await Promise.resolve();await Promise.resolve();c.screen.destroy();
  assert.equal(await pending,false);assert.equal(revealed,0);assert.equal(c.root.open,false);
});
test('disposed chooser cannot activate a domain',async()=>{let calls=0;const c=chooser(()=>calls++);c.screen.destroy();await c.screen.choose('uam');assert.equal(calls,0);});
test('default fade timers retain the browser global receiver',async()=>{
 const set=globalThis.setTimeout,clear=globalThis.clearTimeout;let fired,cancelled=false;
 try{
  globalThis.setTimeout=function(fn){assert.equal(this,globalThis);fired=fn;return 42;};
  globalThis.clearTimeout=function(id){assert.equal(this,globalThis);assert.equal(id,42);cancelled=true;};
  const c=chooser(()=>{},{transitionMs:420,reducedMotion:false});
  const first=c.screen.leave();fired();assert.equal(await first,true);
  const second=c.screen.leave();c.screen.cancelLeave();assert.equal(await second,false);assert.equal(cancelled,true);
 }finally{globalThis.setTimeout=set;globalThis.clearTimeout=clear;}
});
test('satellite Earth framing stops tracking and places the camera above two Earth radii',()=>{
  let view,cancel=0,stop=0,render=0;earthView({motion:{cancel(){cancel++;}},stopTracking(){stop++;},C:{Cartesian3:{fromDegrees:(longitude,latitude,height)=>({longitude,latitude,height})}},viewer:{camera:{setView(v){view=v;}},scene:{requestRender(){render++;}}}});
  assert.ok(view.destination.height>12742000);assert.equal(view.orientation.pitch,-Math.PI/2);assert.deepEqual([cancel,stop,render],[1,1,1]);
});
test('app starts sound, UAM refresh and Seoul entry only in the UAM branch',()=>{
  const app=readFileSync(new URL('../../../../user_application/web/app.js',import.meta.url),'utf8');
  const branch=app.slice(app.indexOf('    if(uam){'),app.indexOf('  const domainChooser='));
  assert.match(branch,/new EntitySoundControls/);assert.match(branch,/simulationPanel\.refresh/);
  assert.match(branch,/prepareDomainEntry\(beforeReveal=>globe\.entry\(\{reducedMotion,prepare:true,beforeReveal\}\)\)/);
  assert.match(branch,/await uamEntry\.ready/);
  assert.match(branch,/else\{[\s\S]*earthView\(globe\)/);
  assert.equal((app.match(/new EntitySoundControls/g)??[]).length,1);
  assert.match(app,/activeDomain!=='uam'\|\|document.hidden\)changeWatch.stop/);
  assert.match(app,/activeDomain==='uam'&&!document.hidden\)void operatingEnvironment.refresh/);
  assert.match(app,/const replayPoll=setInterval\(\(\)=>\{if\(activeDomain!=='uam'\|\|document.hidden\)return/);
  assert.match(app,/onLeave:\(\)=>domainChooser.show\(\)/);
});

test('UAM camera arrival starts after the chooser closes and its cover is removed',async()=>{
  const app=readFileSync(new URL('../../../../user_application/web/app.js',import.meta.url),'utf8');
  assert.match(app,/onAfterClose:id=>\{[\s\S]*?if\(id==='uam'\)\{\s*hideDomainReveal\(\);\s*uamEntry\?\.reveal\(\)/);
  const events=[];
  const c=chooser(async()=>events.push('prepared'),{onAfterClose:id=>{
    assert.equal(c.root.open,false);assert.equal(id,'uam');events.push('camera');
  }});
  c.screen.show();assert.equal(await c.screen.choose('uam'),true);
  assert.deepEqual(events,['prepared','camera']);
});

test('prepared domain flight waits for the chooser reveal and forwards preparation failure',async()=>{
 const events=[];
 const entry=prepareDomainEntry(async beforeReveal=>{events.push('prepared');await beforeReveal();events.push('visible');});
 await entry.ready;assert.deepEqual(events,['prepared']);entry.reveal();await entry.flight;
 assert.deepEqual(events,['prepared','visible']);
 const failed=prepareDomainEntry(async()=>{throw new Error('GPU failure');});
 await assert.rejects(failed.ready,/GPU failure/);await assert.rejects(failed.flight,/GPU failure/);
});

test('UAM keeps injected birds and drones for the camera/risk pipeline',()=>{
 const received={...snapshot,entities:[{kind:'bird'},{kind:'drone'},...snapshot.entities]};
 assert.deepEqual(scopeSnapshot(received,'uam').entities.map(e=>e.kind),['bird','drone','uam','aircraft']);
 assert.deepEqual(scopeSnapshot(received,'satellite').entities.map(e=>e.kind),['satellite']);
});

test('domain switch shares the topbar glass style and the operations guide is removed',()=>{
 const read=name=>readFileSync(new URL('../../../../user_application/web/'+name,import.meta.url),'utf8');
 const html=read('index.html'),css=read('domains/domain_shell.css');
 assert.doesNotMatch(html,/id="operations"|STATUS &amp; GUIDE|operation-help/);
 assert.match(html,/id="domain-badge" class="glass"/);
 assert.match(html,/id="runtime-status" hidden aria-hidden="true"/);
 for(const id of ['notices','transport-status','snapshot-time','terrain-status','building-status','place-status','sources'])assert.ok(html.includes(`id="${id}"`));
 assert.match(css,/#domain-badge\{[^}]*top:var\(--edge\)/);
 assert.match(css,/#domain-badge\{[^}]*border-radius:var\(--top-bar-radius\)/);
 assert.doesNotMatch(css,/#domain-badge\{[^}]*background:/);
 assert.match(html,/id="domain-reveal" data-phase="idle" hidden aria-hidden="true"/);
 assert.match(css,/#domain-reveal\[data-phase="revealing"\]\{opacity:0;transition:opacity \.95s/);
 assert.match(css,/#welcome\[data-phase="leaving"\] \.welcome-content\{opacity:0/);
});
