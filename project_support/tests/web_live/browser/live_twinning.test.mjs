import test from 'node:test';
import assert from 'node:assert/strict';
import {TwinTelemetry,LiveTwinningPanel} from '../../../../user_application/web/domains/uam/live_twinning/live_twinning_panel.js';
import {fakeDocument,FakeElement} from './fake_dom.mjs';

const snapshot=(sequence=1,changes={})=>({sequence,epoch:1,state_time:100,sources:[],capabilities:{},entities:[
  {kind:'aircraft',derivation:'extrapolated',observation_time:80},
  {kind:'satellite',derivation:'propagated'},
  {kind:'uam',derivation:'simulated',provenance:'simulation'},
],...changes});
test('counts actual entities separately from saved infrastructure and classifies provenance',()=>{
  const t=new TwinTelemetry();t.observe(snapshot(),1000);
  assert.deepEqual(t.counts,{aircraft:1,satellite:1,uam:1});assert.equal(t.total,3);
  assert.deepEqual(t.derivations,{observed:0,estimated:2,simulated:1,other:0});assert.equal(t.observationAge,20);
});
test('no packets means unknown latency and disconnected, never healthy zero',()=>{
  const t=new TwinTelemetry(),v=t.view(10000,'ready');assert.equal(v.connected,false);assert.equal(v.age,null);
  assert.ok(v.bars.every(b=>!b.known&&!b.count));assert.equal(t.interval,null);
});
test('arrival latency is wall time while a paused simulation clock stays separate',()=>{
  const t=new TwinTelemetry();t.observe(snapshot(),1000);t.observe(snapshot(2),6500);
  const v=t.view(6600,'ready');assert.equal(v.connected,true);assert.equal(v.frozen,true);assert.equal(v.age,.1);assert.equal(t.interval,5.5);
  assert.equal(t.view(12000,'ready').connected,false);assert.equal(t.view(6600,'error').connected,false);
});
test('duplicate or out of order snapshots cannot masquerade as fresh data',()=>{
  const t=new TwinTelemetry();t.observe(snapshot(5),1000);assert.equal(t.observe(snapshot(4),8000),false);
  assert.equal(t.observe(snapshot(5),9000),false);assert.equal(t.receivedAt,1000);assert.equal(t.view(9000,'ready').connected,false);
});
test('epoch change clears interval and old counts, permitting a restarted sequence',()=>{
  const t=new TwinTelemetry();t.observe(snapshot(99),1000);t.observe(snapshot(1,{epoch:2,entities:[]}),10000);
  assert.equal(t.total,0);assert.equal(t.interval,null);assert.equal(t.sequence,1);assert.equal(t.buckets.length,1);
});
test('live restart at the same epoch accepts a newer UTC with a reset sequence immediately',()=>{
  const t=new TwinTelemetry();t.observe(snapshot(500,{epoch:0}),1000);
  assert.equal(t.observe(snapshot(1,{epoch:0,state_time:200}),10000),true);
  assert.equal(t.sequence,1);assert.equal(t.stateTime,200);assert.equal(t.interval,null);
  assert.equal(t.view(10100,'ready').connected,true);
  assert.equal(t.observe(snapshot(501,{epoch:0,state_time:100}),11000),false);
  assert.equal(t.stateTime,200);
});
test('chart keeps only 60 seconds, draws genuine missing buckets, and ages out on disconnect',()=>{
  const t=new TwinTelemetry();for(let i=0;i<1000;i++)t.observe(snapshot(i),i*1000);
  assert.equal(t.buckets.length,30);const v=t.view(999000,'ready');assert.equal(v.bars.reduce((n,b)=>n+b.count,0),60);
  assert.ok(t.view(1100000,'ready').bars.every(b=>b.count===0));
});
test('unavailable capabilities and test data are retained without claimed AI results',()=>{
  const t=new TwinTelemetry();t.observe(snapshot(1,{entities:[{kind:'uam',provenance:'fixture'}],capabilities:{situation_assessment:false}}),0);
  assert.equal(t.fixture,true);assert.equal(t.capabilities.situation_assessment,false);assert.equal(t.derivations.other,1);
});
class QuietPanel extends LiveTwinningPanel {draw(){this.draws=(this.draws??0)+1;}applyDisplay(){}paint(){} }
const answer={sources:[],groups:[],values:{state_estimation:{enabled:true}},state:[]};
test('late initial response after leaving does not paint into the next panel',async()=>{
  let resolve;const p=new QuietPanel({document:fakeDocument,api:{describe:()=>new Promise(r=>resolve=r)}});
  const body=new FakeElement('div');p.render(body);const ready=p.ready;p.leave();body.textContent='Library';resolve(answer);await ready;
  assert.equal(body.textContent,'Library');assert.equal(p.draws,undefined);assert.equal(p.timer,null);
});
test('status refresh preserves unsaved baseline while reflecting applied settings from another client',async()=>{
  const p=new QuietPanel({document:fakeDocument,api:{describe:async()=>({...answer,values:{state_estimation:{enabled:false}}})}});
  p.active=true;p.body=new FakeElement('div');p.take(answer);await p.refreshState();
  assert.equal(p.values.state_estimation.enabled,true);assert.equal(p.liveValues.state_estimation.enabled,false);assert.equal(p.statusFailure,false);p.leave();
});
test('failed polling is visible, overlapping polls are suppressed and hidden panels do not poll',async()=>{
  let calls=0,fail;const p=new QuietPanel({document:fakeDocument,api:{describe:()=>{calls++;return new Promise((_,r)=>fail=r);}}});
  p.active=true;const first=p.refreshState();await p.refreshState();assert.equal(calls,1);fail(new Error('offline'));await first;
  assert.equal(p.statusFailure,true);p.leave();await p.refreshState();assert.equal(calls,1);
});

test('light motion runs only for a visible, advancing, connected stream',()=>{
  let visible=true;
  const document={...fakeDocument,hidden:false};
  const p=new QuietPanel({document,isVisible:()=>visible});
  p.monitor=new FakeElement('div');p.active=true;p.transport='ready';
  p.telemetry.observe(snapshot(),1000);
  p.updateMotion(1100);assert.equal(p.monitor.dataset.motion,'running');
  document.hidden=true;p.updateMotion(1200);assert.equal(p.monitor.dataset.motion,'paused');
  document.hidden=false;visible=false;p.updateMotion(1300);assert.equal(p.monitor.dataset.motion,'paused');
  visible=true;p.telemetry.observe(snapshot(2),6500);p.updateMotion(6600);assert.equal(p.monitor.dataset.motion,'paused');
  p.telemetry.observe(snapshot(3,{state_time:101}),6700);p.updateMotion(6800);assert.equal(p.monitor.dataset.motion,'running');
  p.updateMotion(13000);assert.equal(p.monitor.dataset.motion,'paused');
  p.leave();assert.equal(p.monitor,null);
});

test('decorative light uses bounded SVG motion and reduced-motion fallback',async()=>{
  const {readFile}=await import('node:fs/promises');
  const css=await readFile(new URL('../../../../user_application/web/live_twinning_panel.css',import.meta.url),'utf8');
  const js=await readFile(new URL('../../../../user_application/web/domains/uam/live_twinning/live_twinning_panel.js',import.meta.url),'utf8');
  assert.match(js,/lt-light lt-light-out/);assert.match(js,/lt-light lt-light-back/);
  assert.match(css,/@keyframes lt-out/);assert.match(css,/@keyframes lt-back/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)\{\.lt-light\{animation:none!important\}/);
  assert.match(css,/body:not\(\[data-drawer-section=live\]\) \.lt-light\{animation-play-state:paused\}/);
  for(const block of css.matchAll(/@keyframes lt-(?:out|back|source|twin|check)\{([^\r\n]+)/g)){
    assert.doesNotMatch(block[1],/filter:|box-shadow:|width:|height:/);
  }
});

