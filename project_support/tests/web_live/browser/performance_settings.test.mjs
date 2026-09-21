import test from 'node:test';
import assert from 'node:assert/strict';
import {performanceProfile,layerBudgets,PERFORMANCE_LIMITS} from '../../../../digital_twin/visualization/web/performance_profile.js';
import {performanceSettings} from '../../../../user_application/web/performance_settings.js';
import {LiveGlobe} from '../../../../digital_twin/visualization/web/globe.js';
import {CameraRenderBudget} from '../../../../digital_twin/visualization/web/render_budget.js';
import {LABEL_FADE_MS} from '../../../../digital_twin/visualization/web/label_fade.js';
import {fakeDocument} from './fake_dom.mjs';
const args={document:fakeDocument,profile:performanceProfile,limits:PERFORMANCE_LIMITS};
test('untrusted local preferences are bounded and defaults retain nearby terrain detail',()=>{
  assert.equal(performanceProfile(null).terrainError,2);
  assert.equal(performanceProfile({preset:'quality'}).terrainError,1.5);
  assert.equal(performanceProfile({preset:'fleet'}).terrainError,2);
  for(const [key,[min,max]] of Object.entries(PERFORMANCE_LIMITS)){
    assert.equal(performanceProfile({[key]:-1e9})[key],min);
    assert.equal(performanceProfile({[key]:1e9})[key],max);
    for(const bad of ['',' ',null,Infinity,'bad'])assert.equal(performanceProfile({[key]:bad})[key],performanceProfile()[key]);
  }
  assert.equal(layerBudgets({maxModels:160}).entities.maxResidentModels,256);
  assert.equal(layerBudgets({preset:'quality'}).buildings.builds,1,'downloads never authorize a burst of GPU builds');
  const quality=performanceProfile({preset:'quality'});
  assert.equal(layerBudgets({...quality,preset:'custom',annotationHz:30}).buildings.retainedCells,96);
});
test('presets and manual controls persist per browser and attach applies the saved values',()=>{
  const saved=new Map(),storage={getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)};
  const changes=[],ui=performanceSettings({...args,storage});
  ui.attach(p=>changes.push(p));
  ui.select.value='quality';ui.select.onchange();
  assert.equal(changes.at(-1).maxModels,96);
  const input=ui.controls.get('maxModels').input;
  input.value='56';input.oninput();assert.equal(changes.at(-1).maxModels,96,'dragging does not reconfigure all layers');
  input.onchange();assert.equal(changes.at(-1).maxModels,56);assert.equal(ui.select.value,'custom');
  const restored=performanceSettings({...args,storage});
  restored.attach(p=>changes.push(p));assert.equal(changes.at(-1).maxModels,56);assert.equal(restored.select.value,'custom');
  ui.select.value='fleet';ui.select.onchange();assert.equal(changes.at(-1).maxModels,24);
  assert.equal(changes.at(-1).terrainError,2);
});
test('blocked or malformed storage does not prevent controls or metrics',()=>{
  const ui=performanceSettings({...args,storage:{getItem(){throw Error('blocked')},setItem(){throw Error('blocked')}}});
  ui.select.value='quality';assert.doesNotThrow(()=>ui.select.onchange());
  ui.report({fps:59.5,p95Ms:21.2,models:12});assert.match(ui.status.textContent,/60 FPS/);assert.match(ui.status.textContent,/12개/);
  const malformed=performanceSettings({...args,storage:{getItem:()=>'{not json'}});assert.equal(malformed.value.preset,'balanced');
});
test('globe applies budgets to display layers only and getter diagnostics remain readable',()=>{
  const got={},g=Object.create(LiveGlobe.prototype);
  g.viewer={targetFrameRate:0,scene:{globe:{},fog:{},requestRender(){got.render=true}}};
  g.entityScene={setPerformanceOptions:p=>got.entity=p,stats:{models:7}};
  g.vworldBuildings={setStreamingBudget:p=>got.buildings=p,get stats(){return {loading:2}}};
  g.vertiportLayer={setPerformanceOptions:p=>got.port=p};
  g.renderBudget=new CameraRenderBudget();g.detail={};g.timing={summary:()=>({fps:60})};
  g.setPerformanceOptions({preset:'fleet',fog:0,targetFps:45});
  assert.equal(g.viewer.targetFrameRate,45);assert.equal(got.entity.maxModels,24);
  g.setPerformanceOptions({preset:'fleet',fog:0,targetFps:60});
  assert.equal(g.viewer.targetFrameRate,undefined,'no gate at the full cadence: Cesium skips rAF frames that land on the gate');
  g.setPerformanceOptions({preset:'fleet',fog:0,targetFps:45});
  assert.equal(got.buildings.builds,1);assert.equal(got.port.detailDistance,4000);
  assert.equal(g.detail.base,2);assert.equal(g.viewer.scene.fog.enabled,false);
  assert.deepEqual(g.performanceSummary().buildings,{loading:2});assert.equal(g.performanceSummary().models,7);
});
test('manual sharp motion floor stays crisp, and a 30 FPS cap is not classified as overload',()=>{
  const camera={positionWC:{x:0,y:0,z:0},directionWC:{x:0,y:0,z:-1},upWC:{x:0,y:1,z:0}};
  for(const config of [{minimumScale:1,targetFps:60},{minimumScale:.7,targetFps:30}]){
    const b=new CameraRenderBudget();b.configure(config);
    for(let now=0;now<3000;now+=33){camera.positionWC.x++;b.update(camera,{now,frameMs:33});}
    assert.equal(b.scale,1);
  }
  const b=new CameraRenderBudget();b.configure({minimumScale:.6});
  for(let now=0;now<6000;now+=50){camera.positionWC.x++;b.update(camera,{now,frameMs:50});}
  assert.equal(b.scale,.6,'manual lower floors are reachable under sustained movement load');
});
test('annotation cadence does not throttle aircraft position updates or suppress arrival initialization',()=>{
  const g=Object.create(LiveGlobe.prototype);let updates=0;
  const camera={positionWC:{x:0,y:0,z:0},directionWC:{x:0,y:0,z:-1}};
  g.viewer={isDestroyed:()=>false,camera};g.C={};g.performanceOptions={annotationHz:30};
  g.routeLayer={owned:[],visible:true};g.infrastructureLabelFade={update(){updates++}};
  g.routeGeometryFade={update(){}};
  // A camera on the move: every pass has distances to re-read.
  for(let now=0;now<1000;now+=1000/60){camera.positionWC.x+=1;g.paintInfrastructureFade(now);}
  assert.ok(updates>=20&&updates<=31);
  const before=updates;g.startArrivalFade(1001);assert.equal(updates,before+1);
});

test('an idle map is not walked: the fade pass rests until the camera, the layers or a fade change',()=>{
  const g=Object.create(LiveGlobe.prototype);let updates=0;
  const camera={positionWC:{x:0,y:0,z:0},directionWC:{x:0,y:0,z:-1}};
  // A cadence finer than the 16 ms steps below, so every step is a candidate pass.
  g.viewer={isDestroyed:()=>false,camera};g.C={};g.performanceOptions={annotationHz:120};
  g.routeLayer={owned:[],visible:true,revision:0};g.vertiportLayer={owned:new Map(),visible:true,revision:0};
  g.infrastructureLabelFade={update(){updates++},started:0};g.routeGeometryFade={update(){},started:0};
  for(let now=0;now<2000;now+=16)g.paintInfrastructureFade(now);
  assert.equal(updates,1,'one pass settles the picture; nothing changes after it');
  // A redraw of the network: the new entities are faded in, for one fade length.
  g.routeLayer.revision=1;g.infrastructureLabelFade.update=()=>{updates++;g.infrastructureLabelFade.started=1;};
  for(let now=2000;now<2000+LABEL_FADE_MS+500;now+=16)g.paintInfrastructureFade(now);
  const faded=updates;
  assert.ok(faded>=LABEL_FADE_MS/16-3&&faded<=LABEL_FADE_MS/16+4,`the fade ran to its end and stopped: ${faded}`);
  for(let now=4000;now<5000;now+=16)g.paintInfrastructureFade(now);
  assert.equal(updates,faded,'then the map rests again');
  // The camera moves: every tick has distances to re-read, and a label
  // entering its band on the way starts a fade.
  for(let now=5000;now<5500;now+=16){camera.directionWC.x+=.001;if(now===5000)g.infrastructureLabelFade.started=2;g.paintInfrastructureFade(now);}
  assert.ok(updates-faded>=25,'a moving camera is followed at the annotation cadence');
  const moved=updates;
  for(let now=5500;now<5500+LABEL_FADE_MS+200;now+=16)g.paintInfrastructureFade(now);
  const afterMove=updates;
  for(let now=7000;now<8000;now+=16)g.paintInfrastructureFade(now);
  assert.equal(updates,afterMove,'and rests once the camera stops and the last fade is done');
  assert.ok(afterMove>moved,'the fade that the move began finishes first');
  // The layers change with the camera still: a deck was placed.
  g.vertiportLayer.revision=1;g.paintInfrastructureFade(8000);
  assert.equal(updates,afterMove+1);
});

test('hybrid keeps plain fallback active beside photo tiles and provider switches release its mask',()=>{
  const g=Object.create(LiveGlobe.prototype),states={};g.buildingsEnabled=true;
  for(const key of ['buildings','vworldBuildings','vworld3d','hybridBuildings'])g[key]={setEnabled:value=>states[key]=value};
  g.setBuildingsProvider('vworld_hybrid');
  assert.equal(g.buildingProvider,'vworld_hybrid');
  assert.deepEqual(states,{buildings:false,vworldBuildings:true,vworld3d:true,hybridBuildings:true});
  g.setBuildingsEnabled(false);
  assert.ok(Object.values(states).every(value=>value===false));
  g.setBuildingsEnabled(true);g.setBuildingsProvider('vworld_3d');
  assert.deepEqual(states,{buildings:false,vworldBuildings:false,vworld3d:true,hybridBuildings:false});
  g.setBuildingsProvider('vworld');
  assert.deepEqual(states,{buildings:false,vworldBuildings:true,vworld3d:false,hybridBuildings:false});
});

test('top-level 30/60 selector applies immediately, persists and survives quality preset changes',()=>{
 const saved=new Map(),changes=[],storage={getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)};
 const ui=performanceSettings({...args,storage,apply:v=>changes.push(v)});
 assert.equal(ui.frameSelect.value,'60');assert.equal(ui.controls.has('targetFps'),false);
 ui.frameSelect.value='30';ui.frameSelect.onchange();assert.equal(changes.at(-1).targetFps,30);
 ui.select.value='quality';ui.select.onchange();assert.equal(changes.at(-1).targetFps,30);assert.equal(changes.at(-1).maxModels,96);
 const restored=performanceSettings({...args,storage});assert.equal(restored.frameSelect.value,'30');
 restored.frameSelect.value='60';restored.frameSelect.onchange();assert.equal(restored.value.targetFps,60);
 ui.report({fps:24,p95Ms:48});assert.match(ui.status.textContent,/현재 24 FPS/);
});
