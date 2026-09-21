import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeElement,fakeDocument} from './fake_dom.mjs';

// A missing component is an explicit first RED, not an import failure.
const geometry=await import('../../../../user_application/web/risk_radar_geometry.js').catch(()=>({}));
const ui=await import('../../../../user_application/web/domains/uam/prediction/risk_radar.js').catch(()=>({}));
const ownship={entity_id:'uam:1',kind:'uam',name:'Ownship',latitude_deg:37,longitude_deg:127,altitude_m:300,heading_deg:90,continuity_id:1,state_time:100};
const neighbor={...ownship,entity_id:'uam:2',name:'Nearby',latitude_deg:37.005,altitude_m:600};
const snapshot=(patch={})=>({epoch:1,state_time:100,entities:[ownship,neighbor],...patch});
const response=(patch={})=>({schema_version:1,model_id:'prism_2d_v1',status:'ready',basis:'experimental observation covariance',epoch:1,state_time:100,
  ownship_id:ownship.entity_id,ownship,radius_m:3000,horizon_s:15,tracks:[{...neighbor,status:'ready',distance_m:556,relative_altitude_m:300,prediction:{
    branches:[.6,.3,.1].map((weight,i)=>({weight,points:[0,5,10,15].map(t_s=>({t_s,east_m:t_s*10+i*50,north_m:556+t_s*10,cov_ee:400,cov_nn:100,cov_en:0}))})),
    type_probabilities:[{type:'aircraft',probability:.75},{type:'unknown',probability:.25}]}}],...patch});
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function setup({api,now=()=>1000000}={}){
  assert.equal(typeof ui.RiskRadar,'function','RiskRadar component must exist');
  const listeners=new Map(),frames=new Map(),timers=new Map();let id=0;
  const window={innerWidth:1280,innerHeight:800,requestAnimationFrame:fn=>{frames.set(++id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id),
    setInterval:fn=>{timers.set(++id,fn);return id;},clearInterval:id=>timers.delete(id),addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:key=>listeners.delete(key)};
  const document={...fakeDocument,body:new FakeElement('body'),defaultView:window,hidden:false,
    createElement:tag=>{const element=new FakeElement(tag);element.eventOptions={};
      element.addEventListener=(name,handler,options)=>{element[`on${name}`]=handler;element.eventOptions[name]=options;};
      element.removeEventListener=(name,handler)=>{if(element[`on${name}`]===handler)delete element[`on${name}`];};return element;},
    addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:key=>listeners.delete(key)};
  const calls=[];let settingsCalls=0;
  const view=new ui.RiskRadar({document,now,onSettings:()=>settingsCalls++,getJSON:(url,options)=>{calls.push({url,options});return api?api(url,options):Promise.resolve(response());}});
  view.observe(snapshot());
  return {view,document,calls,frames,timers,listeners,get settingsCalls(){return settingsCalls;}};
}

function wheel(view,deltaY,extra={}){
  assert.equal(typeof view.plot.onwheel,'function','radar plot must handle the wheel');
  let prevented=false,stopped=false;
  view.plot.onwheel({deltaY,deltaMode:0,clientX:10,clientY:290,...extra,
    preventDefault:()=>{prevented=true;},stopPropagation:()=>{stopped=true;}});
  return {prevented,stopped};
}
function flushFrames(frames){const queued=[...frames.values()];frames.clear();for(const callback of queued)callback();}

test('injected tracks send bounded test history with matching IDs and disappear from requests on removal',async()=>{
  let now=1000000;const {view,calls}=setup({now:()=>now});
  const injected={...neighbor,entity_id:'intruder:test:drone:1',kind:'drone',source:'intruder',
    intruder:{injected:true},position_ecef_m:[6378237,100,0]};
  for(const t of [100,100.5,101])view.observe(snapshot({state_time:t,entities:[ownship,{...injected,state_time:t}]}));
  view.select(ownship);await settle();
  const call=calls.find(c=>c.options?.method==='POST');assert.ok(call);
  const body=JSON.parse(call.options.body);assert.equal(body.tracks[0].entity_id,injected.entity_id);
  assert.equal(body.tracks[0].samples.length,3);assert.equal(body.epoch,1);
  view.observe(snapshot({state_time:102,entities:[ownship]}));now+=1000;
  await view.refresh();assert.notEqual(calls.at(-1).options?.method,'POST');view.destroy();
});

test('wheel zoom is ownship-centered, updates distance scale and consumes map/panel scrolling',async()=>{
  const {view,frames}=setup();view.select(ownship);await settle();
  try{
    assert.equal(typeof view.plot.onwheel,'function','radar plot must handle the wheel');
    assert.equal(view.plot.eventOptions.wheel.passive,false);
    const before=JSON.stringify(view.snapshot),ownPath=view.plot.querySelector('.risk-ownship').getAttribute('d');
    const marker=view.plot.querySelector('.risk-track').getAttribute('transform');
    assert.deepEqual(wheel(view,-100),{prevented:true,stopped:true});flushFrames(frames);
    const radius=view.getConfig().radius_m;assert.ok(radius<3000&&radius>500);
    assert.equal(view.plot.querySelector('.risk-ownship').getAttribute('d'),ownPath);
    assert.equal(view.plot.querySelector('.risk-own-ring').getAttribute('cx'),'150');
    assert.equal(view.plot.querySelector('.risk-own-ring').getAttribute('cy'),'150');
    assert.notEqual(view.plot.querySelector('.risk-track').getAttribute('transform'),marker);
    assert.equal(view.radiusSelect.value,String(radius));
    assert.equal(view.plot.querySelectorAll('.risk-ring-label').at(-1).textContent,`${Number((radius/1000).toFixed(2))} km`);
    wheel(view,100,{clientX:290,clientY:10});flushFrames(frames);assert.ok(view.getConfig().radius_m>radius);
    assert.equal(JSON.stringify(view.snapshot),before);
  }finally{view.destroy();}
});

test('wheel normalizes pixel/line/page input, clamps 0.5-10 km and keeps radius options bounded',async()=>{
  const {view,frames}=setup();view.select(ownship);await settle();
  try{
    wheel(view,-48);const pixel=view.getConfig().radius_m;view.setConfig({radius_m:3000});
    wheel(view,-3,{deltaMode:1});assert.equal(view.getConfig().radius_m,pixel);
    view.setConfig({radius_m:3000});wheel(view,-1,{deltaMode:2});assert.ok(view.getConfig().radius_m<3000);
    for(let i=0;i<40;i++){wheel(view,-120);flushFrames(frames);}assert.equal(view.getConfig().radius_m,500);
    assert.deepEqual(wheel(view,-120),{prevented:true,stopped:true});assert.equal(view.getConfig().radius_m,500);
    for(let i=0;i<40;i++){wheel(view,120);flushFrames(frames);}assert.equal(view.getConfig().radius_m,10000);
    for(const delta of [0,NaN,Infinity,-Infinity])wheel(view,delta);
    assert.equal(view.getConfig().radius_m,10000);assert.ok(view.radiusSelect.children.length<=6,'one transient custom radius, not a growing option per wheel tick');
  }finally{view.destroy();}
});

test('continuous wheel input coalesces rendering and defers inference without clearing valid paths',async()=>{
  let now=1000000;const {view,calls,frames}=setup({now:()=>now,api:url=>Promise.resolve(response({radius_m:Number(new URL(url,'https://test').searchParams.get('radius_m'))}))});
  view.select(ownship);await settle();const prediction=view.result;
  try{
    for(let i=0;i<12;i++){now+=100;wheel(view,-2);void view.refresh();}
    assert.equal(frames.size,1);assert.equal(calls.length,1,'wheel must not dispatch inference while moving');
    assert.equal(view.result,prediction,'valid forecast geometry remains anchored while changing only the view range');
    flushFrames(frames);assert.equal(view.plot.querySelectorAll('.risk-branch').length,3);
    now+=200;await view.refresh();assert.equal(calls.length,2);
    assert.equal(Number(new URL(calls.at(-1).url,'https://test').searchParams.get('radius_m')),view.getConfig().radius_m);
    now+=200;await view.refresh();assert.equal(calls.length,2,'existing 2 Hz ceiling remains');
  }finally{view.destroy();}
});

test('wheel retains zoom through size changes/reopen but is inactive hidden and detached on destroy',async()=>{
  const {view,frames}=setup();view.select(ownship);await settle();
  try{
    wheel(view,-60);flushFrames(frames);const radius=view.getConfig().radius_m;
    view.expandButton.click();assert.equal(view.getConfig().radius_m,radius);
    view.hide();wheel(view,100);assert.equal(view.getConfig().radius_m,radius);assert.equal(frames.size,0);
    view.open();assert.equal(view.getConfig().radius_m,radius);
    const plot=view.plot;view.destroy();assert.equal(plot.onwheel,undefined);
  }finally{view.destroy();}
});

test('heading-up rotates east to ahead at heading 90 and preserves north at heading 0',()=>{
  assert.equal(typeof geometry.headingUp,'function');
  for(const [e,n,h,x,y] of [[100,0,90,0,-100],[0,100,90,-100,0],[100,0,0,100,0],[0,100,180,0,100]]){
    const point=geometry.headingUp(e,n,h);assert.ok(Math.abs(point.x-x)<1e-8);assert.ok(Math.abs(point.y-y)<1e-8);
  }
});
test('geographic projection wraps the dateline and centers the ownship without mutation',()=>{
  assert.equal(typeof geometry.localEnu,'function');
  assert.deepEqual(geometry.localEnu(ownship,ownship),{east_m:0,north_m:0});
  const point=geometry.localEnu({latitude_deg:0,longitude_deg:-179.999},{latitude_deg:0,longitude_deg:179.999});
  assert.ok(Math.abs(point.east_m-222.63898)<.001);assert.equal(point.north_m,0);
  assert.equal(geometry.localEnu({...ownship,latitude_deg:null},ownship),null);
});
test('covariance rotation produces 2-sigma ellipse in screen axes and rejects non-PSD uncertainty',()=>{
  assert.equal(typeof geometry.uncertaintyEllipse,'function');
  const north=geometry.uncertaintyEllipse({cov_ee:400,cov_nn:100,cov_en:0},0);
  assert.equal(north.rx,40);assert.equal(north.ry,20);assert.ok(Math.abs(north.angle)<1e-8);
  const east=geometry.uncertaintyEllipse({cov_ee:400,cov_nn:100,cov_en:0},90);
  assert.ok(Math.abs(Math.abs(east.angle)-90)<1e-7);
  for(const value of [{cov_ee:-1,cov_nn:2,cov_en:0},{cov_ee:1,cov_nn:1,cov_en:2},{cov_ee:NaN,cov_nn:1,cov_en:0}])assert.equal(geometry.uncertaintyEllipse(value,0),null);
});
test('response validation rejects mismatched identity, epoch, time, radius and malformed branch results',()=>{
  assert.equal(typeof geometry.checkedRiskResponse,'function');
  const options={entityId:ownship.entity_id,epoch:1,stateTime:100,radius:3000,horizon:15};
  const before=JSON.stringify(response());assert.equal(geometry.checkedRiskResponse(response(),options).status,'ready');
  for(const patch of [{schema_version:2},{ownship_id:'x'},{epoch:2},{state_time:90},{state_time:110},{radius_m:1000},{horizon_s:240},{ownship:{...ownship,latitude_deg:NaN}}]){
    assert.equal(geometry.checkedRiskResponse(response(patch),options),null);
  }
  const bad=response();bad.tracks[0].prediction.branches[0].points[1].east_m=NaN;
  assert.equal(geometry.checkedRiskResponse(bad,options).tracks[0].prediction,null,'bad forecast cannot partially imply complete branches');
  assert.equal(JSON.stringify(response()),before);
});
test('selection opens read-only radar with current traffic, altitude dimming and actual branch uncertainty',async()=>{
  const {view,calls}=setup();view.select(ownship);await settle();view.paint();
  try{
    assert.equal(view.isOpen,true);assert.equal(calls.length,1);assert.match(calls[0].url,/radius_m=3000/);
    assert.match(calls[0].url,/altitude_band_m=150/);assert.ok(calls[0].options.signal);
    assert.equal(view.root.querySelectorAll('.risk-track').length,1);assert.equal(view.root.querySelector('.risk-track').getAttribute('data-altitude'),'outside');
    assert.equal(view.root.querySelectorAll('.risk-branch').length,3);assert.equal(view.root.querySelectorAll('.risk-uncertainty').length,9);
    assert.match(view.root.textContent,/충돌확률이 아닙니다/);assert.match(view.root.textContent,/실험/);
    view.root.querySelector('.risk-track').click();assert.match(view.detail.textContent,/75%/);assert.match(view.detail.textContent,/60%/);
    assert.equal(JSON.stringify(view.snapshot),JSON.stringify(snapshot()));
  }finally{view.destroy();}
});
test('an unknown contact remains visible and missing altitude is not treated as zero',async()=>{
  const {view}=setup();view.observe(snapshot({entities:[ownship,{...neighbor,kind:'unknown',altitude_m:null}]}));view.select(ownship);await settle();view.paint();
  try{const marker=view.root.querySelector('.risk-track');assert.equal(marker.getAttribute('data-kind'),'unknown');assert.equal(marker.getAttribute('data-altitude'),'unknown');assert.match(marker.textContent,/고도 미상/);}
  finally{view.destroy();}
});
test('polling never overlaps and starts at most two inference requests per second',async()=>{
  let now=1000000,resolve;const {view,calls}=setup({now:()=>now,api:()=>new Promise(r=>resolve=r)});view.select(ownship);
  try{for(let i=0;i<20;i++){now+=100;void view.refresh();}assert.equal(calls.length,1);
    resolve(response());await settle();view.refresh();assert.equal(calls.length,2);resolve(response());await settle();
    now+=499;view.refresh();assert.equal(calls.length,2);now++;view.refresh();assert.equal(calls.length,3);
  }finally{view.destroy();resolve(response());await settle();}
});
test('hiding cancels pending inference and RAF, leaves reopen chip, and ignores a late response',async()=>{
  let resolve;const {view,calls,frames,timers}=setup({api:()=>new Promise(r=>resolve=r)});view.select(ownship);
  view.hide();assert.equal(view.isOpen,false);assert.equal(calls[0].options.signal.aborted,true);assert.equal(frames.size,0);assert.equal(timers.size,0);
  assert.equal(view.chip.hidden,false);resolve(response());await settle();assert.equal(view.result,null);view.destroy();
});
test('a tab visibility change cancels work immediately and visible again resumes safely',async()=>{
  let now=1000000,resolve;const {view,document,calls,listeners,timers,frames}=setup({now:()=>now,api:()=>new Promise(r=>resolve=r)});view.select(ownship);
  document.hidden=true;listeners.get('visibilitychange')();assert.equal(calls[0].options.signal.aborted,true);assert.equal(timers.size,0);assert.equal(frames.size,0);
  resolve(response());await settle();now+=500;document.hidden=false;listeners.get('visibilitychange')();assert.equal(calls.length,2);view.destroy();resolve(response());await settle();
});
test('selection and epoch changes cannot accept the preceding response',async()=>{
  let now=1000000;const pending=[];const {view,calls}=setup({now:()=>now,api:()=>new Promise(resolve=>pending.push(resolve))});view.select(ownship);now+=500;view.select(neighbor);
  assert.equal(calls[0].options.signal.aborted,true);pending[0](response());await settle();assert.equal(view.result,null);
  view.observe(snapshot({epoch:2}));pending[1](response({ownship_id:neighbor.entity_id,ownship:neighbor}));await settle();assert.equal(view.result,null);
  view.destroy();pending.slice(2).forEach(r=>r(response()));await settle();
});
test('stale reception and a reused entity continuity clear forecasts but retain observable traffic',async()=>{
  let now=1000000;const {view}=setup({now:()=>now});view.select(ownship);await settle();view.paint();assert.equal(view.root.querySelectorAll('.risk-branch').length,3);
  now+=9000;view.paint();assert.equal(view.root.querySelectorAll('.risk-branch').length,0);assert.match(view.status.textContent,/지연/);
  view.observe(snapshot({entities:[{...ownship,continuity_id:2},neighbor]}));assert.equal(view.result,null);view.destroy();
});
test('disabled or unavailable prediction never manufactures paths or a safe-airspace claim',async()=>{
  for(const status of ['disabled','unavailable','warming_up']){
    const {view}=setup({api:async()=>response({status,reason:'model unavailable',tracks:[{...neighbor,status,prediction:null}]})});
    view.select(ownship);await settle();view.paint();assert.equal(view.root.querySelectorAll('.risk-branch').length,0);
    assert.equal(view.root.querySelectorAll('.risk-track').length,1);assert.doesNotMatch(view.status.textContent,/안전|문제없/);view.destroy();
  }
});
test('local range controls, settings callback, expand and reopen preserve lifecycle',async()=>{
  const ctx=setup(),{view,calls}=ctx;view.select(ownship);await settle();
  const select=view.radiusSelect;select.value='10000';select.onchange({target:select});assert.equal(view.getConfig().radius_m,10000);
  view.setConfig({altitude_band_m:null});assert.equal(view.getConfig().altitude_band_m,null);
  view.root.querySelector('.risk-settings').click();assert.equal(ctx.settingsCalls,1);
  view.root.querySelector('.risk-expand').click();assert.equal(view.root.getAttribute('data-size'),'expanded');
  view.hide();view.chip.click();assert.equal(view.isOpen,true);assert.equal(view.root.getAttribute('data-size'),'expanded');
  view.select({entity_id:'port',kind:'vertiport'});assert.equal(view.isOpen,false);assert.equal(view.chip.hidden,true);
  assert.ok(calls.every(c=>!c.options.method));view.destroy();
});
test('compact and expanded layout stay inside desktop and narrow viewport, avoiding visible selection panel',()=>{
  assert.equal(typeof geometry.radarLayout,'function');
  for(const [width,height,expanded] of [[1920,1080,false],[1280,720,true],[640,800,false],[390,700,true]]){
    const box=geometry.radarLayout({width,height,expanded,selection:{left:90,right:456,top:88,bottom:500}});
    assert.ok(box.left>=8);assert.ok(box.top>=8);assert.ok(box.left+box.width<=width-8);assert.ok(box.top+box.height<=height-8);
    assert.ok(box.left>=456+8||box.top>=500+8||box.collapsed,'overlap must be offset or explicitly collapsed for narrow layout');
  }
});
test('rapid selection, config changes and reopen cannot bypass the global 2 Hz inference ceiling',async()=>{
  let now=1000000;const {view,calls}=setup({now:()=>now});view.select(ownship);await settle();
  view.select(neighbor);await settle();view.setConfig({radius_m:5000});await settle();view.hide();view.open();await settle();
  assert.equal(calls.length,1);now+=500;await view.refresh();assert.equal(calls.length,2);view.destroy();
});
test('persisted all-altitude zero normalizes to all query and horizon control requests a bounded forecast',async()=>{
  let now=1000000;const {view,calls}=setup({now:()=>now});view.setConfig({altitude_band_m:0});view.select(ownship);await settle();
  assert.equal(new URL(calls[0].url,'https://test').searchParams.get('altitude_band_m'),'all');
  assert.ok(view.horizonSelect);now+=500;view.horizonSelect.value='5';view.horizonSelect.onchange({target:view.horizonSelect});
  assert.equal(view.getConfig().horizon_s,5);assert.equal(new URL(calls.at(-1).url,'https://test').searchParams.get('horizon_s'),'5');view.destroy();
});
test('layout collision collapses rather than obscuring the selection and pauses requests until space returns',async()=>{
  const ctx=setup(),{view,document,calls,listeners,timers}=ctx;
  document.defaultView.innerWidth=390;document.defaultView.innerHeight=700;
  const selection=new FakeElement('aside');selection.setAttribute('data-open','true');selection.getBoundingClientRect=()=>({left:12,right:378,top:88,bottom:680});
  document.getElementById=id=>id==='selection'?selection:null;
  view.select(ownship);await settle();assert.equal(view.root.hidden,true);assert.equal(view.chip.hidden,false);assert.equal(calls.length,0);assert.equal(timers.size,0);
  document.defaultView.innerWidth=1280;listeners.get('resize')();view.paint();await settle();assert.equal(view.root.hidden,false);
  view.destroy();
});
test('saved non-preset radius and altitude settings remain selected and are sent without changing their values',async()=>{
  const {view,calls}=setup();view.setConfig({radius_m:2500,altitude_band_m:100});view.select(ownship);await settle();view.paint();
  assert.equal(view.getConfig().radius_m,2500);assert.equal(view.getConfig().altitude_band_m,100);
  assert.equal(view.radiusSelect.value,'2500');assert.ok(view.radiusSelect.children.some(option=>option.value==='2500'));
  assert.equal(view.altitudeSelect.value,'100');assert.ok(view.altitudeSelect.children.some(option=>option.value==='100'));
  assert.equal(view.root.querySelectorAll('.risk-ring-label').at(-1).textContent,'2.5 km','outer ring must not round to a different radius');
  assert.match(calls[0].url,/radius_m=2500/);assert.match(calls[0].url,/altitude_band_m=100/);view.destroy();
});
test('simulation and assumed covariance provenance is legible without exposing raw objects',async()=>{
  const {view}=setup({api:async()=>response({provenance:{input_basis:['experimental_simulation_state'],covariance_basis:['assumed_isotropic_10m_sigma'],
    ownship_covariance:'original_assumed_0.5m_sigma',note:'실제 교통 정확도 미검증'}})});view.select(ownship);await settle();view.paint();
  assert.match(view.provenance.textContent,/시뮬레이션/);assert.match(view.provenance.textContent,/10 m/);assert.match(view.provenance.textContent,/0.5 m/);
  assert.match(view.provenance.textContent,/미검증/);assert.doesNotMatch(view.provenance.textContent,/\[object Object\]|experimental_simulation/);view.destroy();
});
test('forecast ENU and covariance follow the response anchor rather than silently using the newest aircraft origin',()=>{
  assert.equal(typeof geometry.reanchorPrediction,'function');
  const anchor={latitude_deg:0,longitude_deg:0,altitude_m:0},current={latitude_deg:0,longitude_deg:.01,altitude_m:0};
  const point=geometry.reanchorPrediction({east_m:100,north_m:200,cov_ee:400,cov_nn:100,cov_en:20},anchor,current);
  assert.ok(Math.abs(point.east_m+1013.1949038)<.001);assert.equal(point.north_m,200);
  assert.ok(Math.abs(point.cov_ee-399.9999878)<.001);assert.equal(point.cov_nn,100);assert.ok(Math.abs(point.cov_en-19.99999969)<.001);
});
test('frozen or invalid observation quality suppresses forecasts, not the last observed contact',async()=>{
  for(const quality of ['frozen','invalid','unavailable']){
    const {view}=setup();view.select(ownship);await settle();view.observe(snapshot({entities:[ownship,{...neighbor,quality}]}));view.paint();
    assert.equal(view.root.querySelectorAll('.risk-track').length,1);assert.equal(view.root.querySelectorAll('.risk-branch').length,0);
    view.observe(snapshot({entities:[{...ownship,quality},neighbor]}));view.paint();assert.match(view.status.textContent,/지연/);view.destroy();
  }
});
test('neighbor continuity changes cannot revive cached paths after the one-frame discontinuity flag clears',async()=>{
  let now=1000000;const raw=response(),{view}=setup({now:()=>now,api:async()=>raw});view.select(ownship);await settle();view.paint();
  assert.equal(view.result.tracks[0].continuity_id,1);assert.equal(view.root.querySelectorAll('.risk-branch').length,3);
  view.observe(snapshot({entities:[ownship,{...neighbor,continuity_id:2,discontinuity:true}]}));view.paint();
  assert.equal(view.root.querySelectorAll('.risk-branch').length,0);
  view.observe(snapshot({entities:[ownship,{...neighbor,continuity_id:2,discontinuity:false}]}));view.paint();
  assert.equal(view.root.querySelectorAll('.risk-track').length,1);assert.equal(view.root.querySelectorAll('.risk-branch').length,0);
  assert.equal(view.root.querySelectorAll('.risk-uncertainty').length,0);assert.match(view.stats.textContent,/예측 0대/);
  view.root.querySelector('.risk-track').click();assert.doesNotMatch(view.detail.textContent,/가중치:/);
  raw.tracks[0].continuity_id=2;now+=500;await view.refresh();view.paint();
  assert.equal(view.root.querySelectorAll('.risk-branch').length,3,'only a forecast for the new continuity restores paths');view.destroy();
});
test('a late neighbor forecast from the former continuity never draws against its reused current entity id',async()=>{
  let resolve;const {view}=setup({api:()=>new Promise(r=>resolve=r)});view.select(ownship);
  view.observe(snapshot({entities:[ownship,{...neighbor,continuity_id:2,discontinuity:true}]}));
  view.observe(snapshot({entities:[ownship,{...neighbor,continuity_id:2,discontinuity:false}]}));
  resolve(response());await settle();view.paint();
  assert.equal(view.root.querySelectorAll('.risk-track').length,1);assert.equal(view.root.querySelectorAll('.risk-branch').length,0);
  assert.match(view.stats.textContent,/예측 0대/);view.destroy();
});
test('missing or invalid forecast track continuity fails closed while retaining the current contact',async()=>{
  for(const continuity of [undefined,null,-1,NaN,'1']){
    const raw=response();raw.tracks[0].continuity_id=continuity;
    const {view}=setup({api:async()=>raw});view.select(ownship);await settle();view.paint();
    assert.equal(view.result.tracks[0].prediction,null);assert.equal(view.root.querySelectorAll('.risk-track').length,1);
    assert.equal(view.root.querySelectorAll('.risk-branch').length,0);view.destroy();
  }
});

test('unselected traffic detail is hidden while selected traffic and status stay available',async()=>{
 const {view}=setup();view.select(ownship);await settle();view.paint();assert.equal(view.detail.hidden,true);
 view.detailId=neighbor.entity_id;view.paint();assert.equal(view.detail.hidden,false);assert.match(view.detail.textContent,/Nearby/);assert.ok(view.status.textContent);view.destroy();
});
