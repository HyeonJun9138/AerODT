/**
 * Read-only, isolated-browser comparison of the served renderer and staged JS.
 *
 * node project_support/tools/web_visualization/renderer_performance_check.mjs --baseline-root ORIGINAL_COPY --dry-run
 * node project_support/tools/web_visualization/renderer_performance_check.mjs \
 *   --url http://127.0.0.1:18766/?diagnostics --baseline-root ORIGINAL_COPY --output path/to/result.json
 *
 * Only GET/HEAD/OPTIONS can reach the server. The actual scenario is never
 * started, paused, edited, or replaced: synthetic display samples live in this
 * disposable browser page. Do not run beside other GPU measurements.
 * This measures the LOCAL headless Edge renderer, not the remote desktop FPS.
 */
import {access,readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import os from 'node:os';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const DEFAULT_BROWSER='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SAFE_METHODS=new Set(['GET','HEAD','OPTIONS']);

function options(argv){
  const out={url:'http://127.0.0.1:18766/?diagnostics',root:ROOT,baselineRoot:null,browser:DEFAULT_BROWSER,
    output:path.join(ROOT,'data/workspace/visualization_checks/renderer_performance.json'),
    counts:[100,400],variants:['original','modified'],warmupMs:12000,sampleMs:7000,
    startupMs:60000,buildings:'retain',buildingProvider:null,headless:true,dryRun:false,uiSmoke:false,cpuProfile:false,viewport:{width:1600,height:900}};
  const values=new Set(['url','root','baseline-root','browser','output','counts','variants','buildings','building-provider','warmup-ms','sample-ms','startup-ms','playwright','viewport']);
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==='--dry-run'){out.dryRun=true;continue;}
    if(arg==='--ui-smoke'){out.uiSmoke=true;continue;}
    if(arg==='--cpu-profile'){out.cpuProfile=true;continue;}
    if(arg==='--headed'){out.headless=false;continue;}
    if(arg==='--help'||arg==='-h'){out.help=true;continue;}
    const key=arg.startsWith('--')?arg.slice(2):'';
    if(!values.has(key)||!argv[i+1]||argv[i+1].startsWith('--'))throw new Error(`Unknown/incomplete option: ${arg}`);
    const value=argv[++i];
    if(key==='counts')out.counts=value.split(',').map(Number);
    else if(key==='variants')out.variants=value.split(',');
    else if(key==='baseline-root')out.baselineRoot=value;
    else if(key==='building-provider')out.buildingProvider=value;
    else if(key==='viewport'){
      if(!/^\d+x\d+$/.test(value))throw new Error('Viewport must be WIDTHxHEIGHT');
      const [width,height]=value.split('x').map(Number);
      if(width<320||height<240||width>8192||height>8192)throw new Error('Viewport dimensions are out of range');
      out.viewport={width,height};
    }
    else if(key.endsWith('-ms'))out[key.replace(/-m/,'M')]=Number(value);
    else out[key]=value;
  }
  if(out.help)return out;
  const url=new URL(out.url);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Use an HTTP(S) URL without embedded credentials');
  url.searchParams.set('diagnostics','');out.url=url.href;
  if(!out.counts.length||out.counts.some(n=>!Number.isInteger(n)||n<1||n>1000))throw new Error('Counts must be integers from 1 through 1,000');
  if(out.variants.some(v=>!['original','modified'].includes(v)))throw new Error('Variants must be original and/or modified');
  if(out.variants.includes('original')&&!out.baselineRoot)throw new Error('Pass --baseline-root with the captured original source tree; the live server is not an immutable baseline');
  if(!['retain','off'].includes(out.buildings))throw new Error('Buildings must be retain or off');
  if(out.buildingProvider!==null&&!['osm','vworld','vworld_3d','vworld_hybrid'].includes(out.buildingProvider))throw new Error('Unknown building provider');
  for(const key of ['warmupMs','sampleMs','startupMs'])if(!Number.isFinite(out[key])||out[key]<1000||out[key]>120000)throw new Error(`${key} must be between 1,000 and 120,000`);
  for(const key of ['root','output','browser'])out[key]=path.resolve(out[key]);
  if(out.baselineRoot)out.baselineRoot=path.resolve(out.baselineRoot);
  if(out.baselineRoot===out.root)throw new Error('The original and modified source roots must be different');
  return out;
}

async function playwright(options){
  const modulePath=options.playwright??process.env.PLAYWRIGHT_MODULE_PATH??
    path.resolve(path.dirname(process.execPath),'../node_modules/playwright/index.mjs');
  const specifier=path.isAbsolute(modulePath)?pathToFileURL(modulePath).href:modulePath;
  const imported=await import(specifier);
  if(!imported.chromium)throw new Error('The specified Playwright module does not export chromium');
  return imported;
}

function safeUrl(value){
  try{const u=new URL(value);return `${u.origin}${u.pathname}`;}catch{return String(value).split('?')[0];}
}
function safeMessage(message){
  return String(message).replace(/https?:\/\/[^\s'"<>]+/g,safeUrl).split('\n')[0].slice(0,280);
}
async function save(output,result){
  await mkdir(path.dirname(output),{recursive:true});
  const temporary=`${output}.tmp`;
  await writeFile(temporary,JSON.stringify(result,null,2)+'\n','utf8');
  await rename(temporary,output);
}

// A diagnostics handle exists before the loading veil hands off to ENTRY.fly.
// Only a hidden veil and a finished, non-aborted entry establish a stable camera.
function rendererStartupReady(){
  const d=globalThis.aerodtDiagnostics,g=d?.globe,loading=globalThis.document?.getElementById('loading');
  return Boolean(d?.client&&g?.entityScene?.assets?.size&&loading?.hidden===true
    &&loading.dataset.phase==='leaving'&&g.entryAbort?.signal&&!g.entryAbort.signal.aborted
    &&g.entryActive===false&&!g.transitioning&&!globalThis.document.hidden);
}

async function settingsSmoke(page,output){
  const startedAt=new Date().toISOString(),observations={startedAt};
  await page.locator('#settings').click();
  // SettingsWindows presents a cloned window; the original ID controls are a
  // hidden template. Operate the visible copy, which forwards normal events.
  const panel=page.locator('[data-settings-source-id="settings-panel"]:visible');
  await panel.locator('.performance-settings .performance-detail > summary').click();
  observations.sliders=await panel.locator('.performance-settings input[type="range"]').evaluateAll(inputs=>
    inputs.map(input=>({id:input.id,enabled:!input.disabled,value:input.value})));
  const preset=panel.locator('[data-settings-source-id="performance-preset"]');
  await preset.selectOption('fleet');
  await page.waitForFunction(()=>{
    const g=aerodtDiagnostics.globe;
    return g.performanceOptions.preset==='fleet'&&g.performanceOptions.hybridDistance===1000&&g.entityScene.performance.maxModels===24;
  });
  observations.fleet=await page.evaluate(()=>({profile:aerodtDiagnostics.globe.performanceOptions,
    entityMaxModels:aerodtDiagnostics.globe.entityScene.performance.maxModels,storage:JSON.parse(localStorage.getItem('aerodt.performance.v1'))}));
  const radius=panel.locator('[data-settings-source-id="performance-hybridDistance"]');
  await radius.scrollIntoViewIfNeeded();await radius.press('Home');
  for(let i=0;i<6;i++)await radius.press('ArrowRight');
  await page.waitForFunction(()=>{
    const g=aerodtDiagnostics.globe,s=JSON.parse(localStorage.getItem('aerodt.performance.v1'));
    return g.performanceOptions.preset==='custom'&&g.performanceOptions.hybridDistance===2000&&s.preset==='custom'&&s.hybridDistance===2000;
  });
  observations.custom=await page.evaluate(()=>({profile:aerodtDiagnostics.globe.performanceOptions,
    entityMaxModels:aerodtDiagnostics.globe.entityScene.performance.maxModels,storage:JSON.parse(localStorage.getItem('aerodt.performance.v1')),
    selectedPreset:document.getElementById('performance-preset').value,sliderValue:document.getElementById('performance-hybridDistance').value}));
  const quality=panel.locator('[data-settings-source-id="display-quality"]');
  await quality.selectOption('sharp');
  observations.sharp=await page.evaluate(()=>{
    const g=aerodtDiagnostics.globe,r=g.displayResolution;
    r.applyMotion(.7);
    return {mode:r.mode,base:r.profile.pixelRatio,applied:g.viewer.resolutionScale};
  });
  await quality.selectOption('auto');
  await preset.scrollIntoViewIfNeeded();
  observations.layout=await panel.evaluate(panel=>{
    const r=panel.getBoundingClientRect();
    return {bounds:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},
      panelWithinViewport:r.x>=-1&&r.y>=-1&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,
      horizontalOverflow:panel.scrollWidth>panel.clientWidth+1||document.documentElement.scrollWidth>innerWidth+1};
  });
  observations.screenshot=path.join(path.dirname(output),'renderer_settings_ui_smoke.png');
  await page.screenshot({path:observations.screenshot});
  observations.passed=observations.sliders.length===10&&observations.sliders.every(slider=>slider.enabled)
    &&observations.sharp.mode==='sharp'&&Math.abs(observations.sharp.base-observations.sharp.applied)<1e-6
    &&observations.layout.panelWithinViewport&&!observations.layout.horizontalOverflow;
  observations.backendWritesSent=0;observations.finishedAt=new Date().toISOString();
  await save(path.join(path.dirname(output),'renderer_settings_ui_smoke.json'),observations);
  if(!observations.passed)throw new Error('Performance settings UI smoke failed');
  return observations;
}

// Serialized into the inspected page by Playwright. No network calls belong in
// this function: only application display methods and Cesium's local renderer.
function installBrowserProbe({count,fixture,buildings,buildingProvider}){
  const diagnostics=globalThis.aerodtDiagnostics,C=globalThis.Cesium,g=diagnostics.globe;
  const scene=g.entityScene,v=g.viewer;
  diagnostics.client.setPaused(true);
  if(globalThis.rendererBenchmark)globalThis.rendererBenchmark.dispose();
  const available=[...scene.items.values()].filter(item=>item.entity.kind==='uam'&&item.entity.source==='scenario'&&scene.assets.has(item.entity.visual_asset_id));
  let templates=fixture?.templates??available.slice(0,100).map(item=>structuredClone(item.entity));
  let fixtureKind=fixture?.fixtureKind??'captured-existing-scenario';
  if(!templates.length){
    // An idle server must stay idle. If no scenario is displayed, reuse real
    // authored UAM flight-model catalog entries without preparing a backend day.
    let assets=['projectairsim_airtaxi','joby_s4','kp2a','evtol','x_57'].map(id=>scene.assets.get(id)).filter(asset=>asset?.flight_visual?.uri);
    if(!assets.length)assets=[...scene.assets.values()].filter(asset=>asset.flight_visual?.uri).slice(0,5);
    templates=assets.map(asset=>({kind:'uam',source:'scenario',provenance:'fixture',quality:'valid',visual_asset_id:asset.asset_id}));
    fixtureKind='catalog-seeded-synthetic-uam';
  }
  if(!templates.length)throw new Error('No authored UAM flight-model catalog entry is available for the visual fixture');
  for(const template of templates)if(!scene.assets.has(template.visual_asset_id))throw new Error('A baseline fixture asset is missing from this page catalog');
  const centre=fixture?.centre??{longitude:126.978,latitude:37.5665,height:350};
  const currentEpoch=Number(scene.samples.epoch);
  const epoch=(Number.isFinite(currentEpoch)?currentEpoch:0)+1;
  scene.ownSource?.('scenario');
  g.stopTracking();g.motion.cancel();v.camera.cancelFlight();
  const buildingSettings=fixture?.buildingSettings??{enabled:g.buildingsEnabled,provider:g.buildingProvider,appearance:structuredClone(g.buildingAppearance)};
  g.setBuildingsProvider(buildingProvider??buildingSettings.provider);g.setBuildingAppearance(buildingSettings.appearance);
  g.setBuildingsEnabled(buildings==='off'?false:buildingSettings.enabled);
  g.setEntityDisplay('uam',{all:true,models:true,labels:true});
  // Terrain, imagery, routes and vertiports remain. Building settings are copied
  // from the first original page unless an explicit isolated run disables them.
  g.viewer.camera.cancelFlight();
  const profileApplied=Boolean(g.setPerformanceOptions);
  if(profileApplied)g.setPerformanceOptions({preset:'balanced'});
  const started=performance.now();let sequence=0,phase=null,disposed=false;
  const columns=Math.ceil(Math.sqrt(count)),spacing=55;
  const identities=Array.from({length:count},(_,i)=>`renderer-bench-${count}-${i}`);
  function entitiesAt(t){
    return identities.map((id,i)=>{
      const angle=t*.12+i*2.399963229728653;
      const east=((i%columns)-(columns-1)/2)*spacing+100*Math.cos(angle);
      const north=(Math.floor(i/columns)-(Math.ceil(count/columns)-1)/2)*spacing+100*Math.sin(angle);
      const longitude=centre.longitude+east/(111320*Math.cos(centre.latitude*Math.PI/180));
      const latitude=centre.latitude+north/111320,altitude=centre.height+20*Math.sin(angle*.4);
      const p=C.Cartesian3.fromDegrees(longitude,latitude,altitude);
      const dt=.01,next=angle+dt*.12;
      const pn=C.Cartesian3.fromDegrees(centre.longitude+(((i%columns)-(columns-1)/2)*spacing+100*Math.cos(next))/(111320*Math.cos(centre.latitude*Math.PI/180)),
        centre.latitude+(Math.floor(i/columns)-(Math.ceil(count/columns)-1)/2)*spacing/111320+100*Math.sin(next)/111320,
        centre.height+20*Math.sin(next*.4));
      return {...templates[i%templates.length],entity_id:id,name:`Renderer Bench ${i+1}`,kind:'uam',source:'scenario',provenance:'fixture',quality:'valid',
        continuity_id:1,discontinuity:false,surface_reference:null,longitude_deg:longitude,latitude_deg:latitude,altitude_m:altitude,
        position_ecef_m:[p.x,p.y,p.z],velocity_ecef_mps:[(pn.x-p.x)/dt,(pn.y-p.y)/dt,(pn.z-p.z)/dt],
        orientation_source:'attitude',heading_deg:((90-angle*180/Math.PI)%360+360)%360,pitch_deg:0,roll_deg:0,tilt_deg:85,rotor_radps:100};
    });
  }
  function inject(){
    if(disposed)return;
    const t=(performance.now()-started)/1000;
    scene.replace({epoch,sequence:++sequence,state_time:1000+t,clock_rate:1,entities:entitiesAt(t)});
  }
  const restores=[];
  function wrap(owner,key,label){
    if(!owner||typeof owner[key]!=='function')return;
    const original=owner[key];
    const replacement=function(...args){
      const measuring=phase,start=performance.now();
      try{return original.apply(this,args);}finally{
        if(measuring&&phase===measuring){
          const elapsed=performance.now()-start,bucket=measuring.cpu[label]??={calls:0,totalMs:0,maxMs:0,samplesMs:[]};
          bucket.calls++;bucket.totalMs+=elapsed;bucket.maxMs=Math.max(bucket.maxMs,elapsed);
          if(bucket.samplesMs.length<8192)bucket.samplesMs.push(elapsed);
        }
      }
    };
    owner[key]=replacement;restores.push(()=>{if(owner[key]===replacement)owner[key]=original;});
  }
  wrap(g,'frame','globe.frame');wrap(g,'paintInfrastructureFade','annotations');wrap(g,'select','selection');
  wrap(scene,'updatePositions','entities.positions');wrap(scene,'updateLod','entities.lod');wrap(scene,'replace','fixture.ingestion');
  wrap(scene.labelOcclusion,'update','labels.occlusion');wrap(v.scene,'pickPosition','scene.pickPosition');
  wrap(g.vertiportLayer,'tickLights','vertiports.lights');wrap(g.vertiportLayer,'show','vertiports.presentation');
  wrap(g.routeGeometryFade,'updateMeshes','routes.meshAppearance');wrap(g.scenarioPassengers,'update','passengers');
  wrap(g.vworldBuildings,'update','buildings.selection');
  inject();const injectionTimer=setInterval(inject,100);
  const summarize=values=>{
    if(!values.length)return {samples:0,meanMs:null,p50Ms:null,p95Ms:null,maxMs:null};
    const sorted=[...values].sort((a,b)=>a-b);
    return {samples:sorted.length,meanMs:sorted.reduce((sum,n)=>sum+n,0)/sorted.length,
      p50Ms:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.ceil(sorted.length*.95)-1],maxMs:sorted.at(-1)};
  };
  function counts(){
    const out={items:scene.items.size,visible:0,requestedModels:0,residentModels:0,readyModels:0,shownModels:0,pendingModels:0,preparingModels:0,
      invalidFallbacks:0,invalidPositions:0};
    for(const item of scene.items.values()){
      const visible=item.lod!=='hidden'&&scene.layers[item.entity.kind]?.visible;
      const shown=Boolean(item.model&&item.model.ready!==false&&item.model.show&&item.modelAttached!==false);
      if(visible)out.visible++;
      if(item.lod==='model')out.requestedModels++;
      if(item.model){out.residentModels++;if(item.model.ready===true)out.readyModels++;else out.preparingModels++;}
      if(shown)out.shownModels++;
      if(item.loading)out.pendingModels++;
      if(visible&&item.lod==='model'&&!shown&&!item.billboard?.show&&!item.point?.show)out.invalidFallbacks++;
      if(![item.position?.x,item.position?.y,item.position?.z].every(Number.isFinite))out.invalidPositions++;
    }
    return out;
  }
  const overviewCentre=C.Cartesian3.fromDegrees(centre.longitude,centre.latitude,centre.height);
  let overviewPosition,overviewDirection;
  const vector=value=>[value.x,value.y,value.z];
  function cameraPose(){
    const camera=v.camera,p=camera.positionCartographic,selected=scene.items.get(g.selected);
    return {longitudeDeg:C.Math.toDegrees(p.longitude),latitudeDeg:C.Math.toDegrees(p.latitude),heightM:p.height,
      positionWC:vector(camera.positionWC),directionWC:vector(camera.directionWC),upWC:vector(camera.upWC),
      heading:camera.heading,pitch:camera.pitch,roll:camera.roll,
      centreDistanceM:C.Cartesian3.distance(camera.positionWC,overviewCentre),
      selectedDistanceM:selected?C.Cartesian3.distance(camera.positionWC,selected.position):null,
      entryActive:Boolean(g.entryActive),motionActive:Boolean(g.motion.active),approaching:Boolean(g.approach),tracking:Boolean(g.tracking),
      loadingHidden:document.getElementById('loading')?.hidden===true};
  }
  function overviewDrift(){
    return {positionM:C.Cartesian3.distance(v.camera.positionWC,overviewPosition),
      directionError:1-C.Cartesian3.dot(v.camera.directionWC,overviewDirection)};
  }
  function setOverview(){
    g.stopTracking();g.motion.cancel();v.camera.cancelFlight();
    v.camera.lookAt(overviewCentre,new C.HeadingPitchRange(0,-.65,1400));
    v.camera.lookAtTransform(C.Matrix4.IDENTITY);
    overviewPosition=C.Cartesian3.clone(v.camera.positionWC);overviewDirection=C.Cartesian3.clone(v.camera.directionWC);
    g.lastLod=0;v.scene.requestRender();
  }
  function assertOverview(){
    const pose=cameraPose(),drift=overviewDrift();
    if(pose.entryActive||!pose.loadingHidden||pose.motionActive||pose.approaching||pose.tracking
      ||pose.centreDistanceM<1000||pose.centreDistanceM>2000||drift.positionM>5||drift.directionError>1e-5)
      throw new Error(`Overview camera was overwritten or is unstable: ${JSON.stringify({pose,drift})}`);
    return pose;
  }
  function renderingQuality(){
    const tileInfo=tiles=>tiles?{shown:Boolean(tiles.show),tilesLoaded:tiles.tilesLoaded??null,
      maximumScreenSpaceError:tiles.maximumScreenSpaceError??null,memoryAdjustedScreenSpaceError:tiles.memoryAdjustedScreenSpaceError??null,
      cacheBytes:tiles.cacheBytes??null,totalMemoryUsageInBytes:tiles.totalMemoryUsageInBytes??null}:null;
    const footprints=g.vworldBuildings?.stats;
    return {canvas:{width:v.canvas.width,height:v.canvas.height,resolutionScale:v.resolutionScale},
      scenePrimitiveCollections:v.scene.primitives.length,viewerEntities:v.entities.values.length,
      modelCollectionPrimitives:Object.fromEntries(Object.entries(scene.layers).map(([kind,layer])=>[kind,layer.models.length])),
      buildingProvider:g.buildingProvider,buildingsEnabled:g.buildingsEnabled,footprintCells:typeof footprints==='function'?footprints.call(g.vworldBuildings):footprints??null,
      nativeBuildings:{osm:tileInfo(g.buildings?.tileset),vworld:tileInfo(g.vworld3d?.tileset)},
      terrain:{tileCacheSize:v.scene.globe.tileCacheSize,maximumScreenSpaceError:v.scene.globe.maximumScreenSpaceError,
        tilesLoaded:v.scene.globe.tilesLoaded,pendingTiles:g.pendingTiles??null},
      infrastructure:{vertiports:g.vertiportLayer?.owned?.size??null,
        vertiportEntities:g.vertiportLayer?.owned?[...g.vertiportLayer.owned.values()].reduce((sum,items)=>sum+items.length,0):null,
        routeEntities:g.routeLayer?.owned?.length??null}};
  }
  const removePostRender=v.scene.postRender.addEventListener(()=>{
    if(!phase)return;
    const began=performance.now(),now=began;
    if(phase.previous!==null)phase.intervals.push(now-phase.previous);
    phase.previous=now;phase.frames++;
    const sample=counts();phase.last=sample;
    for(const [key,value] of Object.entries(sample))phase.max[key]=Math.max(phase.max[key]??0,value);
    if(sample.invalidFallbacks)phase.framesWithInvalidFallback++;
    if(sample.invalidPositions)phase.framesWithInvalidPositions++;
    phase.scales.add(v.resolutionScale);
    if(g.renderBudget?.moving)phase.movingFrames++;
    if(phase.selectedId){
      const item=scene.items.get(phase.selectedId);
      if(item?.model?.ready===true&&item.model.show&&phase.firstSelectedReadyMs===null)phase.firstSelectedReadyMs=now-phase.start;
      if(!g.approach&&g.tracking&&phase.approachSettledMs===null)phase.approachSettledMs=now-phase.start;
    }
    const pose=cameraPose();phase.cameraEnd=pose;
    phase.cameraRange.minHeightM=Math.min(phase.cameraRange.minHeightM,pose.heightM);
    phase.cameraRange.maxHeightM=Math.max(phase.cameraRange.maxHeightM,pose.heightM);
    phase.cameraRange.minCentreDistanceM=Math.min(phase.cameraRange.minCentreDistanceM,pose.centreDistanceM);
    phase.cameraRange.maxCentreDistanceM=Math.max(phase.cameraRange.maxCentreDistanceM,pose.centreDistanceM);
    if(pose.entryActive||!pose.loadingHidden)phase.invalidCameraFrames++;
    if(phase.name==='overview'){
      const drift=overviewDrift();phase.cameraRange.maxOverviewDriftM=Math.max(phase.cameraRange.maxOverviewDriftM,drift.positionM);
      if(pose.centreDistanceM<1000||pose.centreDistanceM>2000||drift.positionM>5||drift.directionError>1e-5)phase.invalidCameraFrames++;
    }
    if(phase.frames%30===0&&phase.observations.length<32)phase.observations.push({elapsedMs:now-phase.start,...sample,camera:pose});
    phase.probeCpuMs+=performance.now()-began;
  });
  setOverview();
  let renderer=null,vendor=null;
  try{
    const gl=v.canvas.getContext('webgl2')??v.canvas.getContext('webgl');
    const extension=gl?.getExtension('WEBGL_debug_renderer_info');
    renderer=gl?.getParameter(extension?.UNMASKED_RENDERER_WEBGL??gl.RENDERER)??null;
    vendor=gl?.getParameter(extension?.UNMASKED_VENDOR_WEBGL??gl.VENDOR)??null;
  }catch{}
  const api={
    fixture:{templates,centre,buildingSettings,fixtureKind},
    info:{count,fixtureKind,sourceTemplateCount:templates.length,sourceAssets:[...new Set(templates.map(e=>e.visual_asset_id))],
      fixtureEpoch:epoch,centre,profileApplied,profile:g.performanceOptions??null,cesiumVersion:C.VERSION,
      viewport:{width:v.canvas.clientWidth,height:v.canvas.clientHeight},renderer,vendor,
      buildingsEnabled:g.buildingsEnabled,buildingProvider:g.buildingProvider,buildingAppearance:g.buildingAppearance,
      terrainSource:g.activeTerrainSource??null,visibility:document.visibilityState,initialCamera:cameraPose()},
    counts,cameraPose,assertOverview,
    begin(name,index=null){
      if(phase)throw new Error('Finish the previous measurement phase first');
      if(name==='overview'){assertOverview();setOverview();}
      phase={name,start:performance.now(),previous:null,frames:0,intervals:[],cpu:{},max:{},last:null,observations:[],
        scales:new Set(),probeCpuMs:0,movingFrames:0,framesWithInvalidFallback:0,framesWithInvalidPositions:0,
        cameraStart:cameraPose(),cameraEnd:null,invalidCameraFrames:0,
        cameraRange:{minHeightM:Infinity,maxHeightM:-Infinity,minCentreDistanceM:Infinity,maxCentreDistanceM:-Infinity,maxOverviewDriftM:0},
        selectedId:index===null?null:identities[index%count],firstSelectedReadyMs:null,approachSettledMs:null};
      if(phase.selectedId)g.select(phase.selectedId,{focus:true});
      return {name,selectedId:phase.selectedId};
    },
    finish(){
      if(!phase)return null;
      const value=phase;phase=null;const elapsedMs=performance.now()-value.start;
      const frame=summarize(value.intervals),cpu={};
      for(const [key,bucket] of Object.entries(value.cpu))cpu[key]={...summarize(bucket.samplesMs),calls:bucket.calls,totalMs:bucket.totalMs,
        maxMs:bucket.maxMs,msPerRenderedFrame:bucket.totalMs/Math.max(1,value.frames),msPerWallSecond:bucket.totalMs/(elapsedMs/1000)};
      return {name:value.name,elapsedMs,frames:value.frames,frame:{...frame,fps:frame.meanMs?1000/frame.meanMs:0,
        over50Ms:value.intervals.filter(n=>n>50).length,over100Ms:value.intervals.filter(n=>n>100).length,
        schedulingGapsOver250Ms:value.intervals.filter(n=>n>=250).length},cpu,max:value.max,last:value.last,
        selectedId:value.selectedId,firstSelectedReadyMs:value.firstSelectedReadyMs,approachSettledMs:value.approachSettledMs,
        cameraStart:value.cameraStart,cameraEnd:value.cameraEnd,cameraRange:value.cameraRange,invalidCameraFrames:value.invalidCameraFrames,
        framesWithInvalidFallback:value.framesWithInvalidFallback,framesWithInvalidPositions:value.framesWithInvalidPositions,
        movingFrames:value.movingFrames,resolutionScales:[...value.scales],probeCpuMs:value.probeCpuMs,observations:value.observations,
        renderingQuality:renderingQuality()};
    },
    dispose(){disposed=true;clearInterval(injectionTimer);removePostRender();for(const restore of restores.reverse())restore();phase=null;}
  };
  globalThis.rendererBenchmark=api;
  return {fixture:api.fixture,info:api.info};
}

async function run(options){
  const {chromium}=await playwright(options);
  await access(options.browser,fsConstants.R_OK);
  await access(path.join(options.root,'digital_twin/visualization/web/globe.js'),fsConstants.R_OK);
  if(options.variants.includes('original'))await access(path.join(options.baselineRoot,'digital_twin/visualization/web/globe.js'),fsConstants.R_OK);
  if(options.dryRun){
    console.log(JSON.stringify({dryRun:true,browserExists:true,playwrightImported:true,stagedSourceExists:true,baselineSourceExists:options.variants.includes('original'),
      variants:options.variants,counts:options.counts,endpoint:safeUrl(options.url),headless:options.headless,
      viewport:options.viewport,buildings:options.buildings,buildingProvider:options.buildingProvider,
      estimatedSamplingSeconds:options.counts.length*options.variants.length*(options.warmupMs+options.sampleMs*4)/1000}));
    return;
  }
  const result={schemaVersion:2,createdAt:new Date().toISOString(),scope:'LOCAL isolated Edge renderer with browser-only synthetic display trajectories; NOT remote desktop FPS or authoritative flight validation',
    server:safeUrl(options.url),headless:options.headless,viewport:options.viewport,counts:options.counts,variants:options.variants,
    warmupMs:options.warmupMs,sampleMs:options.sampleMs,buildings:options.buildings,buildingProvider:options.buildingProvider,
    startupGate:'Loading veil hidden in leaving phase, ENTRY.fly started and finished without abort, and no scene transition before fixture installation; overview pose checked after warmup and on every sampled frame.',
    sourceMethod:'Existing scenario entities when available, otherwise authored UAM flight-model catalog entries; explicitly synthetic local ECEF trajectories injected at 10 Hz with a new display epoch',
    backendWritesSent:0,host:{platform:os.platform(),arch:os.arch(),cpu:os.cpus()[0]?.model??null,logicalCpus:os.cpus().length},
    sourceBinding:'Both original and modified /visualization/*.js and /static/*.js/css are fulfilled from separate local source roots; the remote server only supplies unchanged HTML, data, assets and other support modules.',
    limitations:['One local browser/page runs sequentially; browser/driver caches may favor later trials despite identical bounded warmup.',
      'Playwright request routing disables browser HTTP cache. Asset network timings are cold-cache measurements through the local relay, not ordinary browser cache performance.',
      options.buildings==='off'?'Building layers are explicitly disabled in both variants; terrain, imagery, routes and vertiports remain.':'Building settings are retained from the initial original page; terrain, imagery, routes and vertiports remain.',
      'CPU timings are synchronous inclusive method-entry timings; nested methods must not be summed and asynchronous preparation is reflected in readiness and render intervals.',
      'Synthetic paths are visual fixtures, not simulated flights. Timings include local read-only relay latency and browser scheduling.',
      'Model and terrain budgets are counts, not an exact GPU byte limit. No other GPU workload should run alongside this benchmark.'],trials:[]};
  const browser=await chromium.launch({executablePath:options.browser,headless:options.headless,args:['--no-first-run','--no-default-browser-check']});
  let fixture=null,current=null,variant='original';
  const bodyCache=new Map();
  try{
    const context=await browser.newContext({viewport:options.viewport,deviceScaleFactor:1,reducedMotion:'reduce',serviceWorkers:'block'});
    await context.addInitScript(()=>{try{localStorage.removeItem('aerodt.performance.v1');}catch{}});
    const page=await context.newPage();page.setDefaultTimeout(options.startupMs);
    const profiler=options.cpuProfile?await context.newCDPSession(page):null;
    if(profiler){await profiler.send('Profiler.enable');await profiler.send('Profiler.setSamplingInterval',{interval:1000});}
    page.on('pageerror',error=>{if(current&&current.pageErrors.length<20)current.pageErrors.push({name:error.name,message:safeMessage(error.message),
      stack:String(error.stack??'').split('\n').slice(0,12).map(safeMessage)});});
    page.on('requestfailed',request=>{if(current){current.network.failed++;if(current.network.failurePaths.length<12)current.network.failurePaths.push(safeUrl(request.url()));}});
    await context.route('**/*',async route=>{
      const request=route.request(),method=request.method(),url=new URL(request.url());
      if(!SAFE_METHODS.has(method)){
        if(current){current.network.blockedWrites++;const key=`${method} ${url.pathname}`;if(!current.network.blockedWritePaths.includes(key))current.network.blockedWritePaths.push(key);}
        await route.fulfill({status:204,body:''});return;
      }
      if(current)current.network.readRequests++;
      if(url.origin===new URL(options.url).origin&&/\.(js|css)$/.test(url.pathname)){
        const sourceRoot=variant==='modified'?options.root:options.baselineRoot;
        let mount=null,relative=null;
        if(url.pathname.startsWith('/visualization/')){mount=path.join(sourceRoot,'digital_twin/visualization/web');relative=url.pathname.slice('/visualization/'.length);}
        else if(url.pathname.startsWith('/static/')){mount=path.join(sourceRoot,'user_application/web');relative=url.pathname.slice('/static/'.length);}
        if(mount){
          const file=path.resolve(mount,decodeURIComponent(relative)),within=path.relative(mount,file);
          if(within.startsWith('..')||path.isAbsolute(within))throw new Error('Staged source path escaped its mount');
          let cached=bodyCache.get(file);
          if(!cached){try{const body=await readFile(file);cached={body,sha256:createHash('sha256').update(body).digest('hex')};bodyCache.set(file,cached);}catch(error){if(error.code!=='ENOENT')throw error;}}
          if(cached){
            if(current)current.sourceModules[url.pathname]=cached.sha256;
            await route.fulfill({status:200,contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript',body:cached.body,headers:{'cache-control':'no-store'}});return;
          }
          // Falling through here would silently compare a mixed live/local
          // module graph after deployment. Fail closed if the capture is incomplete.
          if(current)current.missingSourceModules.push(url.pathname);
          await route.fulfill({status:404,contentType:'text/plain',body:'Captured benchmark source is missing'});return;
        }
      }
      await route.continue();
    });
    for(const count of options.counts)for(variant of options.variants){
      await page.goto('about:blank');
      current={variant,count,startedAt:new Date().toISOString(),pageErrors:[],network:{readRequests:0,failed:0,failurePaths:[],blockedWrites:0,blockedWritePaths:[]},sourceModules:{},missingSourceModules:[],phases:[]};
      result.trials.push(current);console.log(JSON.stringify({event:'start',variant,count}));
      try{
        await page.goto(options.url,{waitUntil:'domcontentloaded',timeout:options.startupMs});
        await page.waitForFunction(rendererStartupReady,null,{timeout:options.startupMs});
        await dismissRendererWelcome(page);
        current.startup=await page.evaluate(()=>{
          const g=aerodtDiagnostics.globe,loading=document.getElementById('loading');
          return {loadingHidden:loading.hidden,loadingPhase:loading.dataset.phase,entryStarted:Boolean(g.entryAbort),
            entryActive:g.entryActive,entryAborted:g.entryAbort.signal.aborted,cameraHeightM:g.viewer.camera.positionCartographic.height};
        });
        await page.evaluate(()=>globalThis.aerodtDiagnostics.client.setPaused(true));
        // Let already-posted worker messages drain before the local epoch is installed.
        await page.waitForTimeout(250);
        const installed=await page.evaluate(installBrowserProbe,{count,fixture,buildings:options.buildings,buildingProvider:options.buildingProvider});
        fixture??=installed.fixture;current.environment=installed.info;
        console.log(JSON.stringify({event:'warmup',variant,count,milliseconds:options.warmupMs}));
        await page.waitForTimeout(options.warmupMs);
        current.afterWarmup=await page.evaluate(()=>rendererBenchmark.counts());
        current.cameraAfterWarmup=await page.evaluate(()=>rendererBenchmark.assertOverview());
        const phases=[['overview',null],['close_a',0],['switch_b',Math.floor(count*.6)],['revisit_a',0]];
        for(const [name,index] of phases){
          await page.evaluate(({name,index})=>rendererBenchmark.begin(name,index),{name,index});
          if(profiler)await profiler.send('Profiler.start');
          await page.waitForTimeout(options.sampleMs);
          const phase=await page.evaluate(()=>rendererBenchmark.finish());current.phases.push(phase);
          if(profiler){
            const {profile}=await profiler.send('Profiler.stop');
            phase.cpuProfile=path.join(path.dirname(options.output),`${path.basename(options.output,'.json')}-${variant}-${count}-${name}.cpuprofile`);
            await save(phase.cpuProfile,profile);
          }
          phase.screenshot=path.join(path.dirname(options.output),`${path.basename(options.output,'.json')}-${variant}-${count}-${name}.png`);
          await page.screenshot({path:phase.screenshot});
          console.log(JSON.stringify({event:'phase',variant,count,name,fps:phase.frame.fps,p95Ms:phase.frame.p95Ms,
            shownModels:phase.max.shownModels,invalidFallbackFrames:phase.framesWithInvalidFallback,
            cameraHeightM:phase.cameraEnd?.heightM,cameraCentreDistanceM:phase.cameraEnd?.centreDistanceM,invalidCameraFrames:phase.invalidCameraFrames}));
          await save(options.output,result);
          if(phase.invalidCameraFrames||!phase.frames)throw new Error(`Invalid camera or no rendered frames in ${name}`);
        }
        current.completed=true;
        await page.evaluate(()=>rendererBenchmark.dispose());
        // Settings persist in this context. Do not change the baseline's
        // preferences before the modified renderer has been measured.
        if(options.uiSmoke&&variant==='modified')current.uiSmoke=await settingsSmoke(page,options.output);
      }catch(error){current.completed=false;current.failure={name:error.name,message:safeMessage(error.message)};console.log(JSON.stringify({event:'trial-failed',variant,count,...current.failure}));}
      await save(options.output,result);
    }
    await context.close();
  }finally{
    await browser.close();result.finishedAt=new Date().toISOString();await save(options.output,result);
  }
  console.log(JSON.stringify({event:'complete',trials:result.trials.length,passedTrials:result.trials.filter(t=>t.completed).length,output:options.output}));
  if(result.trials.some(t=>!t.completed))process.exitCode=1;
}

// The modal applies a full-screen backdrop blur. Measuring through it is not
// an operator-view benchmark, even though Cesium continues to render behind it.
async function dismissRendererWelcome(page){
  if(!await page.evaluate(()=>Boolean(document.getElementById('welcome')?.open)))return;
  await page.waitForFunction(()=>document.getElementById('welcome')?.dataset.phase==='ready',null,{timeout:30000});
  await page.click('#welcome-start');
  await page.waitForFunction(()=>!document.getElementById('welcome')?.open,null,{timeout:10000});
}

export {options as rendererOptions,rendererStartupReady,dismissRendererWelcome};

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{
  const parsed=options(process.argv.slice(2));
  if(parsed.help)console.log('Renderer comparison: --url URL --root STAGED_ROOT --baseline-root ORIGINAL_COPY --output JSON --counts 100,400 --viewport 3440x1384 --variants original,modified --buildings retain|off --building-provider osm|vworld|vworld_3d|vworld_hybrid --warmup-ms 12000 --sample-ms 7000 --startup-ms 60000 --browser EDGE_EXE --playwright INDEX_MJS --headed --dry-run --ui-smoke --cpu-profile');
  else await run(parsed);
}catch(error){console.error(`${error.name}: ${safeMessage(error.message)}`);process.exitCode=1;}
