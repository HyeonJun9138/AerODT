/**
 * Real-browser interaction stutter probe for the AeroDT Live Twin page.
 *
 * node project_support/tools/web_visualization/interaction_stutter_check.mjs \
 *   --url http://127.0.0.1:8766/?diagnostics --label before [--root D:/AeroDT] [--headed] \
 *   [--phases idle,wheel,drag,fly,place,edit,route,ticks,camera] [--output path.json]
 *
 * Drives the served page in a separate Chrome (Playwright) and records, per
 * interaction phase: rendered frame intervals (postRender), browser long tasks
 * (PerformanceObserver 'longtask'), inclusive CPU time of the display methods
 * that matter (globe.frame, entity LOD/positions, vertiport/route/building
 * layers, GPU picks, terrain samples) and the slow calls that line up with the
 * long tasks. With --root the page's /static, /visualization and /communication
 * modules are served from that source tree instead of the server, so two trees
 * can be compared against the same live data.
 *
 * Only GET requests and two stateless POST previews (vertiport preview, route
 * conflicts) reach the server; every other write is answered 204 locally and
 * counted. The scenario is never started, saved or changed. The page is
 * disposable: the fixture aircraft used for the camera window exist only in
 * that browser tab.
 */
import {access,readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import os from 'node:os';
import {rendererStartupReady} from './renderer_performance_check.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const DEFAULT_BROWSER='C:/Program Files/Google/Chrome/Application/chrome.exe';
const ALLOWED_POSTS=new Set(['/api/simulation/vertiports/preview','/api/simulation/routes/conflicts']);
const ALL_PHASES=['idle','wheel','drag','fly','place','edit','route','ticks','camera'];

function options(argv){
  const out={url:'http://127.0.0.1:8766/?diagnostics',root:null,label:'live',browser:DEFAULT_BROWSER,headless:true,
    output:null,phases:ALL_PHASES,startupMs:120000,viewport:{width:1600,height:900},playwright:null,vertiport:null};
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==='--headed'){out.headless=false;continue;}
    if(arg==='--help'||arg==='-h'){out.help=true;continue;}
    const key=arg.startsWith('--')?arg.slice(2):'';
    const value=argv[++i];
    if(!key||value===undefined)throw new Error(`Unknown/incomplete option: ${arg}`);
    if(key==='url')out.url=value;
    else if(key==='root')out.root=path.resolve(value);
    else if(key==='label')out.label=value.replace(/[^\w.-]+/g,'_');
    else if(key==='browser')out.browser=value;
    else if(key==='output')out.output=path.resolve(value);
    else if(key==='phases')out.phases=value.split(',').map(s=>s.trim()).filter(Boolean);
    else if(key==='startup-ms')out.startupMs=Number(value);
    else if(key==='playwright')out.playwright=value;
    else if(key==='vertiport')out.vertiport=value;
    else if(key==='viewport'){const [w,h]=value.split('x').map(Number);out.viewport={width:w,height:h};}
    else throw new Error(`Unknown option: ${arg}`);
  }
  if(out.help)return out;
  const url=new URL(out.url);url.searchParams.set('diagnostics','');out.url=url.href;
  for(const p of out.phases)if(!ALL_PHASES.includes(p))throw new Error(`Unknown phase ${p}; choose from ${ALL_PHASES.join(',')}`);
  out.output??=path.join(ROOT,'data/workspace/performance',`interaction_stutter_${out.label}.json`);
  return out;
}

async function playwright(options){
  const modulePath=options.playwright??process.env.PLAYWRIGHT_MODULE_PATH??
    path.resolve(path.dirname(process.execPath),'../node_modules/playwright/index.mjs');
  const specifier=path.isAbsolute(modulePath)?pathToFileURL(modulePath).href:modulePath;
  return import(specifier);
}
const safeUrl=value=>{try{const u=new URL(value);return `${u.origin}${u.pathname}`;}catch{return String(value).split('?')[0];}};
const safeMessage=message=>String(message).replace(/https?:\/\/[^\s'"<>]+/g,safeUrl).split('\n')[0].slice(0,300);
async function save(output,result){
  await mkdir(path.dirname(output),{recursive:true});
  const temporary=`${output}.tmp`;
  await writeFile(temporary,JSON.stringify(result,null,2)+'\n','utf8');
  await rename(temporary,output);
}

// Runs before any page script: catches long tasks from the first byte, and
// times the WebGL calls that stall a frame (shader compile/link, texture and
// buffer uploads, GPU read-backs) on every context the page creates. The
// wrapper itself costs a performance.now() pair per call on the wrapped
// methods only; draw calls are left alone.
function initScript(){
  globalThis.__aerodtLongTasks=[];globalThis.__aerodtProbeT0=performance.timeOrigin;
  try{new PerformanceObserver(list=>{for(const e of list.getEntries())if(globalThis.__aerodtLongTasks.length<50000)globalThis.__aerodtLongTasks.push({t:e.startTime,d:e.duration});})
    .observe({type:'longtask',buffered:true});}catch{}
  const gl=globalThis.__aerodtGl={stats:{},slow:[],contexts:0};
  const WRAP=['compileShader','linkProgram','getProgramParameter','getShaderParameter','getProgramInfoLog','texImage2D','texSubImage2D','compressedTexImage2D','texImage3D',
    'bufferData','bufferSubData','readPixels','getError','finish','generateMipmap','clientWaitSync','getBufferSubData'];
  const describe=(name,a)=>{
    try{
      if(name==='texImage2D'||name==='texSubImage2D'){const src=a[a.length-1];const w=a.length>=9?a[3]:src?.width,h=a.length>=9?a[4]:src?.height;return `${w}x${h}`;}
      if(name==='bufferData'||name==='bufferSubData'){const d=a[1]?.byteLength??a[2]?.byteLength??a[1];return typeof d==='number'?`${Math.round(d/1024)}KB`:'';}
      if(name==='readPixels')return `${a[2]}x${a[3]}`;
    }catch{}
    return '';
  };
  // Which program a link wait belongs to: shader sources are remembered per
  // shader object, attached shaders per program, and a slow link-status read
  // records the head of each source (enough to tell a globe surface program
  // from a footprint, a material or a model program).
  const sources=new WeakMap(),programs=new WeakMap();
  const MARKERS=[['brdf','brdfLut'],['czm_OIT|translucentDepth|czm_translucent','oit'],['FXAA','fxaa'],['webMercator|mercator','reproject'],['u_hybrid','footprint'],['czm_batchTable','batched'],
    ['HAS_NORMALS|HAS_TEXCOORD|model_','model'],['czm_pickColor','pick'],['depthTexture|PassThroughDepth','depth-copy'],['skyBox|u_cubeMap','skybox'],['SUN|sun_','sun'],['GROUND_ATMOSPHERE|INCLUDE_WEB_MERCATOR_Y','globe-surface'],['POLYLINE','polyline'],['SDF','label-sdf'],['INSTANCED','billboard']];
  const head=source=>{const text=String(source??'');const defines=(text.match(/#define [A-Z_0-9]+/g)??[]).slice(0,12).join(' ');
    const tags=MARKERS.filter(([re])=>new RegExp(re).test(text)).map(([,tag])=>tag).join(',');
    const body=text.replace(/^\s*(precision[^\n]*|#[^\n]*|\/\/[^\n]*)\n/gm,'').slice(0,160).replace(/\s+/g,' ');return ('['+tags+'] '+defines+' | '+body).slice(0,320);};
  const wrap=ctx=>{
    if(!ctx||ctx.__aerodtWrapped)return;ctx.__aerodtWrapped=true;gl.contexts++;
    const shaderSource=ctx.shaderSource,attachShader=ctx.attachShader,getShaderParameter=ctx.getShaderParameter;
    if(typeof shaderSource==='function')ctx.shaderSource=function(shader,source){try{sources.set(shader,{source,type:getShaderParameter?.call(this,shader,this.SHADER_TYPE)});}catch{}return shaderSource.call(this,shader,source);};
    if(typeof attachShader==='function')ctx.attachShader=function(program,shader){try{const list=programs.get(program)??[];list.push(shader);programs.set(program,list);}catch{}return attachShader.call(this,program,shader);};
    for(const name of WRAP){
      const original=ctx[name];if(typeof original!=='function')continue;
      ctx[name]=function(...a){
        const t=performance.now();
        try{return original.apply(this,a);}
        finally{const ms=performance.now()-t;const s=gl.stats[name]??={calls:0,totalMs:0,maxMs:0};s.calls++;s.totalMs+=ms;if(ms>s.maxMs)s.maxMs=ms;
          if(ms>=4&&gl.slow.length<20000){
            let detail=describe(name,a);
            if(name==='getProgramParameter'&&ms>=8){try{const shaders=programs.get(a[0])??[];
              detail=shaders.map(shader=>{const s=sources.get(shader);return s?((s.type===this.FRAGMENT_SHADER?'FS ':'VS ')+head(s.source)):'?';}).join(' || ');}catch{}}
            gl.slow.push({t,name,ms,detail});}}
      };
    }
  };
  const originalGetContext=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(type,...args){
    const ctx=originalGetContext.call(this,type,...args);
    if(ctx&&(type==='webgl2'||type==='webgl'||type==='experimental-webgl'))wrap(ctx);
    return ctx;
  };
  if(globalThis.OffscreenCanvas){
    const originalOffscreen=OffscreenCanvas.prototype.getContext;
    OffscreenCanvas.prototype.getContext=function(type,...args){const ctx=originalOffscreen.call(this,type,...args);if(ctx&&(type==='webgl2'||type==='webgl'))wrap(ctx);return ctx;};
  }
}

// Serialized into the page. No network of its own: it wraps display methods
// and reads Cesium counters. Everything is restored by dispose().
function installProbe(){
  const d=globalThis.aerodtDiagnostics,g=d.globe,v=g.viewer,C=globalThis.Cesium,scene=g.entityScene;
  if(globalThis.aerodtProbe)globalThis.aerodtProbe.dispose();
  const restores=[],cpu={},slow=[],marks=[];let phase=null;
  const wrap=(owner,key,label,{asyncNote=false}={})=>{
    if(!owner||typeof owner[key]!=='function')return false;
    const original=owner[key];
    const replacement=function(...args){
      const start=performance.now();
      try{return original.apply(this,args);}finally{
        const elapsed=performance.now()-start;
        if(phase){
          const bucket=phase.cpu[label]??={calls:0,totalMs:0,maxMs:0,samples:[]};
          bucket.calls++;bucket.totalMs+=elapsed;bucket.maxMs=Math.max(bucket.maxMs,elapsed);
          if(bucket.samples.length<20000)bucket.samples.push(elapsed);
          if(elapsed>=12&&phase.slow.length<4000)phase.slow.push({t:start,ms:elapsed,label,async:asyncNote});
        }
      }
    };
    owner[key]=replacement;restores.push(()=>{if(owner[key]===replacement)owner[key]=original;});
    return true;
  };
  const wrapped={};
  const W=(owner,key,label,opts)=>{wrapped[label]=wrap(owner,key,label,opts);};
  W(g,'frame','globe.frame');W(g,'paintInfrastructureFade','globe.annotationFade');W(g,'updateGroundScale','globe.updateGroundScale');
  W(g,'keepAboveGround','globe.keepAboveGround');W(g,'groundAt','globe.groundAt');W(g,'replace','globe.replace');
  W(g,'showVertiports','globe.showVertiports',{asyncNote:true});W(g,'previewVertiport','globe.previewVertiport',{asyncNote:true});
  W(g,'followVertiport','globe.followVertiport');W(g,'moveVertiportPreview','globe.moveVertiportPreview');
  W(g,'showRoutes','globe.showRoutes',{asyncNote:true});W(g,'select','globe.select');W(g,'handleClick','globe.handleClick');W(g,'handleRightClick','globe.handleRightClick');
  W(g,'trackGroundPick','globe.trackGroundPick');W(g,'clearGroundUnderVertiports','globe.clearGroundUnder');W(g,'viewRectangle','globe.viewRectangle');
  W(g,'flyToVertiport','globe.flyToVertiport');W(g,'stepApproach','globe.stepApproach');
  W(scene,'updatePositions','entities.updatePositions');W(scene,'updateLod','entities.updateLod');W(scene,'replace','entities.replace');
  W(scene,'updateLabelFades','entities.labelFades');W(scene,'captureView','entities.captureView');W(scene,'trimModels','entities.trimModels');
  W(g.vertiportLayer,'show','vertiports.show',{asyncNote:true});W(g.vertiportLayer,'preview','vertiports.preview',{asyncNote:true});
  W(g.vertiportLayer,'follow','vertiports.follow');W(g.vertiportLayer,'moveFollow','vertiports.moveFollow');W(g.vertiportLayer,'rebuild','vertiports.rebuild');
  W(g.vertiportLayer,'build','vertiports.build');W(g.vertiportLayer,'tickLights','vertiports.tickLights');W(g.vertiportLayer,'setHovered','vertiports.setHovered');
  W(g.vertiportLayer,'pick','vertiports.pick');W(g.vertiportLayer,'painting','vertiports.painting');W(g.vertiportLayer,'remove','vertiports.remove');
  W(g.routeLayer,'draw','routes.draw');W(g.routeLayer,'show','routes.show',{asyncNote:true});W(g.routeLayer,'restyle','routes.restyle');
  W(g.routeLayer,'setPixelScale','routes.setPixelScale');W(g.routeLayer,'hover','routes.hover');W(g.routeLayer,'pick','routes.pick');
  W(g.routeLayer,'moveNode','routes.moveNode');W(g.routeLayer,'drawMove','routes.drawMove');W(g.routeLayer,'clear','routes.clear');W(g.routeLayer,'drawNode','routes.drawNode');
  W(g.vworldBuildings,'update','buildings.update');W(g.vworldBuildings,'apply','buildings.apply');W(g.vworldBuildings,'pump','buildings.pump');
  W(g.vworldBuildings,'build','buildings.build',{asyncNote:true});W(g.vworldBuildings,'setCleared','buildings.setCleared');W(g.vworldBuildings,'evict','buildings.evict');
  W(g.hybridBuildings,'update','hybrid.update');W(g.osmBuildingFocus,'update','osmFocus.update');W(g.buildings,'update','osm.update');
  W(g.routeGeometryFade,'updateMeshes','routes.fadeMeshes');W(g.infrastructureLabelFade,'update','labels.fade');
  W(g.placeLabels,'update','placeLabels.update');W(g.trajectory,'follow','trajectory.follow');W(g.trajectory,'update','trajectory.update');
  W(g.clouds,'apply','clouds.apply');W(g.airspaceLayer,'setPixelScale','airspace.setPixelScale');
  W(v.scene,'pick','scene.pick');W(v.scene,'pickPosition','scene.pickPosition');W(v.scene,'drillPick','scene.drillPick');
  W(v.scene.globe,'getHeight','globe.getHeight');W(v.scene.globe,'pick','globe.pick');W(v.camera,'getPickRay','camera.getPickRay');
  W(C,'sampleTerrainMostDetailed','terrain.sampleMostDetailed',{asyncNote:true});W(C,'sampleTerrain','terrain.sample',{asyncNote:true});
  W(v,'resize','viewer.resize');W(v.scene,'requestRender','scene.requestRender');W(v.scene,'render','scene.render');
  W(v.entities,'add','entities.add');W(v.entities,'remove','entities.remove');W(v.scene.primitives,'add','primitives.add');W(v.scene.primitives,'remove','primitives.remove');
  if(g.cockpit)W(g.cockpit,'update','cockpit.update');
  if(g.scenarioPassengers)W(g.scenarioPassengers,'update','passengers.update');
  if(g.flightTrack)W(g.flightTrack,'update','flightTrack.update');
  if(g.destinationPreparation)W(g.destinationPreparation,'update','destination.update');
  // The snapshot fan-out lives in app.js: measure the client's callback as one.
  if(d.client&&typeof d.client.onSnapshot==='function'){
    const original=d.client.onSnapshot;
    d.client.onSnapshot=function(snapshot){const start=performance.now();try{return original.call(this,snapshot);}finally{
      const elapsed=performance.now()-start;
      if(phase){const bucket=phase.cpu['app.onSnapshot']??={calls:0,totalMs:0,maxMs:0,samples:[]};
        bucket.calls++;bucket.totalMs+=elapsed;bucket.maxMs=Math.max(bucket.maxMs,elapsed);if(bucket.samples.length<20000)bucket.samples.push(elapsed);
        if(elapsed>=12)phase.slow.push({t:start,ms:elapsed,label:'app.onSnapshot',entities:snapshot?.entities?.length??null});}
    }};
    restores.push(()=>{if(d.client.onSnapshot!==original)d.client.onSnapshot=original;});wrapped['app.onSnapshot']=true;
  }
  const counters=()=>{
    const cam=v.camera.positionCartographic;
    let models=0,ready=0,visible=0;
    for(const item of scene.items.values()){if(item.model){models++;if(item.model.ready===true)ready++;}if(item.lod!=='hidden')visible++;}
    const cells=g.vworldBuildings?.cells;let cellStates={};
    if(cells)for(const cell of cells.values())cellStates[cell.state]=(cellStates[cell.state]??0)+1;
    return {items:scene.items.size,visibleItems:visible,residentModels:models,readyModels:ready,
      viewerEntities:v.entities.values.length,primitives:v.scene.primitives.length,
      pendingTiles:g.pendingTiles??null,tilesLoaded:v.scene.globe.tilesLoaded,terrainSSE:v.scene.globe.maximumScreenSpaceError,
      resolutionScale:v.resolutionScale,budgetScale:g.renderBudget?.scale??null,cameraHeightM:cam.height,
      buildingCells:cells?cells.size:null,cellStates,buildingPrimitives:cells?[...cells.values()].filter(c=>c.primitive).length:null,
      routeEntities:g.routeLayer?.owned?.length??null,vertiports:g.vertiportLayer?.owned?.size??null,
      vertiportEntities:g.vertiportLayer?.owned?[...g.vertiportLayer.owned.values()].reduce((s,e)=>s+e.length,0):null,
      lights:g.vertiportLayer?.lights?.points?.length??null,lodScan:Boolean(scene.lodScan),fps:g.timing?.summary?.()??null};
  };
  let lastScale=v.resolutionScale,lastSSE=v.scene.globe.maximumScreenSpaceError;
  const removePostRender=v.scene.postRender.addEventListener(()=>{
    if(!phase)return;
    const now=performance.now();
    if(phase.previous!==null)phase.intervals.push(now-phase.previous);
    phase.previous=now;phase.frames++;
    if(v.resolutionScale!==lastScale){phase.resolutionChanges++;lastScale=v.resolutionScale;}
    const sse=v.scene.globe.maximumScreenSpaceError;if(sse!==lastSSE){phase.sseChanges++;lastSSE=sse;}
    if(g.renderBudget?.moving)phase.movingFrames++;
    if(g.pendingTiles>phase.maxPendingTiles)phase.maxPendingTiles=g.pendingTiles;
  });
  const summarize=values=>{
    if(!values.length)return {samples:0,meanMs:null,p50Ms:null,p95Ms:null,maxMs:null};
    const sorted=[...values].sort((a,b)=>a-b);
    return {samples:sorted.length,meanMs:sorted.reduce((s,n)=>s+n,0)/sorted.length,p50Ms:sorted[Math.floor(sorted.length*.5)],
      p95Ms:sorted[Math.ceil(sorted.length*.95)-1],maxMs:sorted.at(-1)};
  };
  const glSnapshot=()=>{const out={};for(const [k,s] of Object.entries(globalThis.__aerodtGl?.stats??{}))out[k]={...s};return out;};
  const glDelta=(before,after)=>{const out={};for(const [k,s] of Object.entries(after)){const b=before[k]??{calls:0,totalMs:0};const calls=s.calls-b.calls;if(calls>0)out[k]={calls,totalMs:s.totalMs-b.totalMs,maxMs:s.maxMs};}return out;};
  let renderer=null;
  try{const gl=v.canvas.getContext('webgl2')??v.canvas.getContext('webgl');const ext=gl?.getExtension('WEBGL_debug_renderer_info');
    renderer=gl?.getParameter(ext?.UNMASKED_RENDERER_WEBGL??gl.RENDERER)??null;}catch{}
  const api={
    info:{renderer,cesiumVersion:C.VERSION,wrapped,viewport:{width:v.canvas.clientWidth,height:v.canvas.clientHeight},
      canvas:{width:v.canvas.width,height:v.canvas.height},profile:g.performanceOptions??null,buildingProvider:g.buildingProvider,
      buildingsEnabled:g.buildingsEnabled,terrainSource:g.activeTerrainSource??null,useBrowserRecommendedResolution:v.useBrowserRecommendedResolution,
      targetFrameRate:v.targetFrameRate,requestRenderMode:v.scene.requestRenderMode,msaa:v.scene.msaaSamples,fxaa:v.scene.postProcessStages?.fxaa?.enabled??null,
      shaderWarmUp:g.shaderWarmUp??null,shaderRetention:g.shaderRetention?.stats?.()??null,
      logDepth:v.scene.logarithmicDepthBuffer,tileCacheSize:v.scene.globe.tileCacheSize,preloadSiblings:v.scene.globe.preloadSiblings,
      preloadAncestors:v.scene.globe.preloadAncestors,loadingDescendantLimit:v.scene.globe.loadingDescendantLimit,fog:v.scene.fog?.enabled??null,
      shadows:v.shadows,percentageChanged:v.camera.percentageChanged,transport:d.client?.transportMode??null},
    counters,
    mark(label,extra){const t=performance.now();(phase?phase.marks:marks).push({label,t,sinceStartMs:phase?t-phase.start:null,...(extra??{})});return t;},
    begin(name){
      if(phase)throw new Error('finish the previous phase first');
      phase={name,start:performance.now(),previous:null,frames:0,intervals:[],cpu:{},slow:[],marks:[],resolutionChanges:0,sseChanges:0,movingFrames:0,
        maxPendingTiles:0,before:counters(),longTaskIndex:globalThis.__aerodtLongTasks?.length??0,gl:glSnapshot(),glSlowIndex:globalThis.__aerodtGl?.slow.length??0};
      return {name,start:phase.start};
    },
    finish(){
      if(!phase)return null;
      const p=phase;phase=null;const end=performance.now(),elapsedMs=end-p.start;
      const tasks=(globalThis.__aerodtLongTasks??[]).filter(e=>e.t>=p.start&&e.t<=end);
      const cpu={};
      for(const [label,b] of Object.entries(p.cpu))cpu[label]={...summarize(b.samples),calls:b.calls,totalMs:b.totalMs,maxMs:b.maxMs,
        msPerWallSecond:b.totalMs/(elapsedMs/1000),msPerFrame:b.totalMs/Math.max(1,p.frames)};
      const intervals=summarize(p.intervals);
      const slow=p.slow.sort((a,b)=>b.ms-a.ms).slice(0,60).map(e=>({...e,sinceStartMs:e.t-p.start}));
      const glSlow=(globalThis.__aerodtGl?.slow??[]).slice(p.glSlowIndex).filter(e=>e.t>=p.start&&e.t<=end);
      const glCalls=glDelta(p.gl,glSnapshot());
      // Which wrapped calls sit inside each long task: attribution by overlap,
      // application methods first, then the WebGL calls that stalled inside them.
      const attributed=tasks.slice().sort((a,b)=>b.d-a.d).slice(0,25).map(task=>({sinceStartMs:task.t-p.start,durationMs:task.d,
        inside:p.slow.filter(e=>e.t>=task.t-1&&e.t<=task.t+task.d).sort((a,b)=>b.ms-a.ms).slice(0,6).map(e=>`${e.label} ${e.ms.toFixed(1)}ms`),
        gl:(()=>{const inside=glSlow.filter(e=>e.t>=task.t-1&&e.t<=task.t+task.d);const by={};
          for(const e of inside){const b=by[e.name]??={calls:0,totalMs:0,maxMs:0,worst:''};b.calls++;b.totalMs+=e.ms;if(e.ms>b.maxMs){b.maxMs=e.ms;b.worst=e.detail;}}
          return Object.entries(by).sort((a,b)=>b[1].totalMs-a[1].totalMs).map(([k,v])=>`${k} x${v.calls} ${v.totalMs.toFixed(0)}ms (max ${v.maxMs.toFixed(0)} ${v.worst})`);})()}));
      return {name:p.name,elapsedMs,frames:p.frames,fps:p.frames/(elapsedMs/1000),frame:{...intervals,
          over33Ms:p.intervals.filter(n=>n>33).length,over50Ms:p.intervals.filter(n=>n>50).length,over100Ms:p.intervals.filter(n=>n>100).length,over250Ms:p.intervals.filter(n=>n>=250).length},
        longTasks:{count:tasks.length,totalMs:tasks.reduce((s,t)=>s+t.d,0),maxMs:tasks.reduce((m,t)=>Math.max(m,t.d),0),
          over100:tasks.filter(t=>t.d>=100).length,over250:tasks.filter(t=>t.d>=250).length,perWallSecond:tasks.length/(elapsedMs/1000),attributed},
        cpu,glCalls,glSlow:glSlow.sort((a,b)=>b.ms-a.ms).slice(0,40).map(e=>({...e,sinceStartMs:e.t-p.start})),
        slowCalls:slow,marks:p.marks,resolutionChanges:p.resolutionChanges,sseChanges:p.sseChanges,movingFrames:p.movingFrames,maxPendingTiles:p.maxPendingTiles,
        before:p.before,after:counters()};
    },
    dispose(){removePostRender();for(const restore of restores.reverse())restore();phase=null;globalThis.aerodtProbe=null;},
  };
  globalThis.aerodtProbe=api;
  return api.info;
}

// A handful of UAM fixtures near a deck, injected while the live client is
// paused, so the camera window has an aircraft to look out of.
function installFixture({centre,count}){
  const d=globalThis.aerodtDiagnostics,g=d.globe,C=globalThis.Cesium,scene=g.entityScene;
  d.client.setPaused(true);
  let assets=['projectairsim_airtaxi','joby_s4','kp2a','evtol','x_57'].map(id=>scene.assets.get(id)).filter(asset=>asset?.flight_visual?.uri);
  if(!assets.length)assets=[...scene.assets.values()].filter(asset=>asset.flight_visual?.uri).slice(0,5);
  if(!assets.length)throw new Error('no UAM flight-visual asset in the catalog');
  const live=[...scene.items.values()].map(item=>item.entity).filter(e=>e.source!=='scenario');
  const epoch=(Number(scene.samples.epoch)||0)+1;const started=performance.now();let sequence=0;
  const ids=Array.from({length:count},(_,i)=>`stutter-probe-uam-${i}`);
  const cos=Math.cos(centre.latitude*Math.PI/180);
  function entitiesAt(t){
    return ids.map((id,i)=>{
      const angle=t*.1+i*2.4,radius=120+i*25;
      const east=radius*Math.cos(angle),north=radius*Math.sin(angle);
      const lon=centre.longitude+east/(111320*cos),lat=centre.latitude+north/111320,alt=centre.height+60+i*8;
      const p=C.Cartesian3.fromDegrees(lon,lat,alt);
      const next=angle+.001,pn=C.Cartesian3.fromDegrees(centre.longitude+radius*Math.cos(next)/(111320*cos),centre.latitude+radius*Math.sin(next)/111320,alt);
      const asset=assets[i%assets.length];
      return {kind:'uam',source:'scenario',provenance:'fixture',quality:'valid',visual_asset_id:asset.asset_id,entity_id:id,name:`Probe UAM ${i+1}`,
        continuity_id:1,discontinuity:false,surface_reference:null,longitude_deg:lon,latitude_deg:lat,altitude_m:alt,
        position_ecef_m:[p.x,p.y,p.z],velocity_ecef_mps:[(pn.x-p.x)/.01,(pn.y-p.y)/.01,(pn.z-p.z)/.01],
        orientation_source:'attitude',heading_deg:((90-angle*180/Math.PI)%360+360)%360,pitch_deg:0,roll_deg:0,tilt_deg:85,rotor_radps:100};
    });
  }
  function inject(){
    const t=(performance.now()-started)/1000;
    g.replace({schema_version:1,epoch,sequence:++sequence,state_time:1000+t,clock_rate:1,entities:live.concat(entitiesAt(t))});
  }
  inject();const timer=setInterval(inject,200);
  globalThis.aerodtFixture={ids,stop(){clearInterval(timer);globalThis.aerodtFixture=null;}};
  return {ids,assets:assets.map(a=>a.asset_id),live:live.length};
}

async function run(options){
  const {chromium}=await playwright(options);
  await access(options.browser,fsConstants.R_OK);
  if(options.root)await access(path.join(options.root,'digital_twin/visualization/web/globe.js'),fsConstants.R_OK);
  const result={schemaVersion:1,createdAt:new Date().toISOString(),label:options.label,server:safeUrl(options.url),sourceRoot:options.root,
    headless:options.headless,viewport:options.viewport,phasesRequested:options.phases,
    scope:'LOCAL Chrome via Playwright against the live server (GET + two stateless previews only). Frame intervals, long tasks and inclusive method timings; not the remote desktop refresh rate.',
    host:{platform:os.platform(),arch:os.arch(),cpu:os.cpus()[0]?.model??null,logicalCpus:os.cpus().length},
    pageErrors:[],consoleErrors:0,network:{readRequests:0,blockedWrites:0,blockedWritePaths:[],allowedPosts:0,failed:0,failurePaths:[]},sourceModules:{},phases:[]};
  const browser=await chromium.launch({executablePath:options.browser,headless:options.headless,
    args:['--no-first-run','--no-default-browser-check','--ignore-gpu-blocklist','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
  const bodyCache=new Map();
  try{
    const context=await browser.newContext({viewport:options.viewport,deviceScaleFactor:1,serviceWorkers:'block'});
    await context.addInitScript(initScript);
    const page=await context.newPage();page.setDefaultTimeout(options.startupMs);
    page.on('pageerror',error=>{if(result.pageErrors.length<30)result.pageErrors.push({name:error.name,message:safeMessage(error.message)});});
    page.on('console',message=>{if(message.type()==='error'){result.consoleErrors++;(result.consoleErrorSamples??=[]).length<12&&result.consoleErrorSamples.push(safeMessage(message.text()));}});
    page.on('requestfailed',request=>{result.network.failed++;if(result.network.failurePaths.length<20)result.network.failurePaths.push(safeUrl(request.url()));});
    await context.route('**/*',async route=>{
      const request=route.request(),method=request.method(),url=new URL(request.url());
      if(!['GET','HEAD','OPTIONS'].includes(method)){
        if(method==='POST'&&ALLOWED_POSTS.has(url.pathname)){result.network.allowedPosts++;await route.continue();return;}
        result.network.blockedWrites++;const key=`${method} ${url.pathname}`;
        if(!result.network.blockedWritePaths.includes(key))result.network.blockedWritePaths.push(key);
        await route.fulfill({status:204,body:''});return;
      }
      result.network.readRequests++;
      if(options.root&&url.origin===new URL(options.url).origin&&/\.(js|css)$/.test(url.pathname)){
        let mount=null,relative=null;
        for(const [prefix,dir] of [['/visualization/','digital_twin/visualization/web'],['/static/','user_application/web'],['/communication/','communication/browser']]){
          if(url.pathname.startsWith(prefix)){mount=path.join(options.root,dir);relative=url.pathname.slice(prefix.length);break;}
        }
        if(mount){
          const file=path.resolve(mount,decodeURIComponent(relative)),within=path.relative(mount,file);
          if(within.startsWith('..')||path.isAbsolute(within))throw new Error('source path escaped its mount');
          let cached=bodyCache.get(file);
          if(!cached){try{cached={body:await readFile(file)};bodyCache.set(file,cached);}catch(error){if(error.code!=='ENOENT')throw error;}}
          if(cached){result.sourceModules[url.pathname]='root';
            await route.fulfill({status:200,contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript',body:cached.body,headers:{'cache-control':'no-store'}});return;}
          result.sourceModules[url.pathname]='missing-in-root';
        }
      }
      await route.continue();
    });
    // ---- map load -----------------------------------------------------------
    const navigationStarted=Date.now();
    await page.goto(options.url,{waitUntil:'domcontentloaded',timeout:options.startupMs});
    const diagnosticsAt=await page.waitForFunction(()=>globalThis.aerodtDiagnostics?.globe?performance.now():false,null,{timeout:options.startupMs}).then(h=>h.jsonValue());
    await page.waitForFunction(rendererStartupReady,null,{timeout:options.startupMs});
    // The opening guide is a modal dialog: until START is pressed no wheel,
    // drag or click reaches the map. Press it the way an operator does.
    await page.waitForFunction(()=>document.getElementById('welcome')?.dataset.phase==='ready',null,{timeout:30000}).catch(()=>{});
    const welcomeOpen=await page.$eval('#welcome',d=>Boolean(d.open)).catch(()=>false);
    if(welcomeOpen){
      await page.click('#welcome-start');
      await page.waitForFunction(()=>{const d=document.getElementById('welcome');return !d||!d.open;},null,{timeout:10000}).catch(()=>{});
    }
    result.mapLoad=await page.evaluate(({diagnosticsAt})=>{
      const readyAt=performance.now(),nav=performance.getEntriesByType('navigation')[0];
      const tasks=globalThis.__aerodtLongTasks??[];
      const gl=globalThis.__aerodtGl??{stats:{},slow:[]};
      const glSlowByName={};for(const e of gl.slow){const b=glSlowByName[e.name]??={calls:0,totalMs:0,maxMs:0,worst:''};b.calls++;b.totalMs+=e.ms;if(e.ms>b.maxMs){b.maxMs=e.ms;b.worst=e.detail;}}
      const taskGl=tasks.slice().sort((a,b)=>b.d-a.d).slice(0,12).map(task=>({atMs:task.t,ms:task.d,
        gl:gl.slow.filter(e=>e.t>=task.t-1&&e.t<=task.t+task.d).reduce((by,e)=>{const b=by[e.name]??{calls:0,totalMs:0};b.calls++;b.totalMs+=e.ms;by[e.name]=b;return by;},{})}));
      const resources=performance.getEntriesByType('resource').map(r=>({name:r.name.replace(/^https?:\/\/[^/]+/,'').split('?')[0],ms:r.duration,bytes:r.transferSize||r.encodedBodySize||0,start:r.startTime}));
      const byKind={};for(const r of resources){const k=/\.js$/.test(r.name)?'js':/\.css$/.test(r.name)?'css':/\.(glb|gltf)$/.test(r.name)?'glb':/\/api\//.test(r.name)?'api':/\.(png|jpe?g|webp)$/.test(r.name)?'image':'other';
        const b=byKind[k]??={count:0,bytes:0,ms:0};b.count++;b.bytes+=r.bytes;b.ms+=r.ms;}
      const g=globalThis.aerodtDiagnostics.globe;
      return {readyAtMs:readyAt,diagnosticsAtMs:diagnosticsAt,domContentLoadedMs:nav?.domContentLoadedEventEnd??null,loadEventMs:nav?.loadEventEnd??null,
        welcomeClosedAtMs:readyAt,
        longTasks:{count:tasks.length,totalMs:tasks.reduce((s,t)=>s+t.d,0),maxMs:tasks.reduce((m,t)=>Math.max(m,t.d),0),
          over100:tasks.filter(t=>t.d>=100).length,top:tasks.slice().sort((a,b)=>b.d-a.d).slice(0,15).map(t=>({atMs:t.t,ms:t.d})),withGl:taskGl},
        gl:{contexts:gl.contexts,calls:gl.stats,slowByName:glSlowByName},
        resources:{count:resources.length,bytes:resources.reduce((s,r)=>s+r.bytes,0),byKind,
          slowest:resources.slice().sort((a,b)=>b.ms-a.ms).slice(0,15),largest:resources.slice().sort((a,b)=>b.bytes-a.bytes).slice(0,10)},
        timing:g.timing?.summary?.()??null,cameraHeightM:g.viewer.camera.positionCartographic.height,entities:g.entityScene.items.size};
    },{diagnosticsAt});
    result.mapLoad.wallMs=Date.now()-navigationStarted;
    console.log(JSON.stringify({event:'ready',readyMs:Math.round(result.mapLoad.readyAtMs),longTasks:result.mapLoad.longTasks.count,longTaskMs:Math.round(result.mapLoad.longTasks.totalMs)}));
    // Let the entry hand-over settle before anything is wrapped. From here on a
    // control that fails to appear is a finding, not a reason to wait a minute.
    await page.waitForTimeout(1500);
    page.setDefaultTimeout(20000);
    result.environment=await page.evaluate(installProbe);
    console.log(JSON.stringify({event:'probe',renderer:result.environment.renderer}));
    const vertiports=await page.evaluate(async()=>{const r=await fetch('/api/simulation/vertiports');return (await r.json()).vertiports??[];});
    const target=vertiports.find(v=>v.id===options.vertiport)??vertiports.find(v=>v.layout?.frame)??null;
    result.targetVertiport=target?{id:target.id,name:target.name}:null;
    const cx=Math.round(options.viewport.width/2),cy=Math.round(options.viewport.height/2);
    const phaseOutput=[];
    async function phase(name,actions,{sampleMs=0}={}){
      await page.evaluate(n=>aerodtProbe.begin(n),name);
      const started=Date.now();let failure=null;
      try{await actions();if(sampleMs)await page.waitForTimeout(sampleMs);}catch(error){failure={name:error.name,message:safeMessage(error.message)};}
      const out=await page.evaluate(()=>aerodtProbe.finish());
      out.wallMs=Date.now()-started;if(failure)out.failure=failure;
      out.screenshot=path.join(path.dirname(options.output),`interaction_stutter_${options.label}_${name}.png`);
      try{await page.screenshot({path:out.screenshot});}catch{}
      result.phases.push(out);phaseOutput.push(out);
      console.log(JSON.stringify({event:'phase',name,fps:Number(out.fps.toFixed(1)),p95:Math.round(out.frame.p95Ms??0),max:Math.round(out.frame.maxMs??0),
        over50:out.frame.over50Ms,over100:out.frame.over100Ms,longTasks:out.longTasks.count,longMs:Math.round(out.longTasks.totalMs),failure:failure?.message}));
      await save(options.output,result);
      return out;
    }
    const mark=(label,extra)=>page.evaluate(({label,extra})=>aerodtProbe.mark(label,extra),{label,extra});
    // A panel control is pressed the way an operator would, but a control
    // that Playwright refuses (covered for a moment, still settling) is
    // pressed from script: the probe measures the display, not the pointer.
    const press=async selector=>{
      try{await page.click(selector,{timeout:5000});}
      catch{await page.$eval(selector,el=>el.click());}
    };
    const setRange=async(selector,value)=>{await page.$eval(selector,(el,v)=>{el.value=String(v);el.dispatchEvent(new Event('input',{bubbles:true}));},value);};
    const has=name=>options.phases.includes(name);
    // ---- idle at the opening view ------------------------------------------
    if(has('idle'))await phase('idle_home',async()=>{},{sampleMs:6000});
    // ---- wheel zoom in / out ------------------------------------------------
    if(has('wheel')){
      await phase('wheel_zoom_in',async()=>{
        await page.mouse.move(cx,cy);
        for(let i=0;i<14;i++){await page.mouse.wheel(0,-120);await page.waitForTimeout(90);}
      },{sampleMs:3500});
      await phase('wheel_zoom_out',async()=>{
        for(let i=0;i<14;i++){await page.mouse.wheel(0,120);await page.waitForTimeout(90);}
      },{sampleMs:3000});
    }
    // ---- orbit / pan drags --------------------------------------------------
    if(has('drag')){
      await phase('drag_pan',async()=>{
        await page.mouse.move(cx-250,cy+120);await page.mouse.down();
        for(let i=1;i<=30;i++){await page.mouse.move(cx-250+i*16,cy+120-i*6);await page.waitForTimeout(33);}
        await page.mouse.up();
      },{sampleMs:2500});
      await phase('drag_tilt',async()=>{
        await page.mouse.move(cx,cy+150);await page.mouse.down({button:'middle'});
        for(let i=1;i<=24;i++){await page.mouse.move(cx,cy+150-i*8);await page.waitForTimeout(33);}
        await page.mouse.up({button:'middle'});
      },{sampleMs:2500});
    }
    // ---- fly to a city deck: terrain + buildings streaming ------------------
    if(has('fly')&&target){
      const frame=target.layout.frame;
      await phase('fly_to_vertiport',async()=>{
        await page.evaluate(frame=>aerodtDiagnostics.globe.flyToVertiport(frame,520),frame);
        await page.waitForFunction(()=>{const g=aerodtDiagnostics.globe;const a=g.destinationPreparation?.active;return !a||a.arrivedAt!==null;},null,{timeout:15000}).catch(()=>{});
        await mark('arrived');
      },{sampleMs:5000});
      await phase('city_idle',async()=>{},{sampleMs:6000});
    }
    // ---- place a vertiport: follow the cursor, tools, sliders ---------------
    const openSimulation=async(tab)=>{
      const expanded=await page.$eval('#mode-simulation',b=>b.getAttribute('aria-expanded'));
      if(expanded!=='true')await press('#mode-simulation');
      await page.waitForSelector(`#sim-tab-${tab}`,{timeout:10000});
      const selected=await page.$eval(`#sim-tab-${tab}`,b=>b.getAttribute('aria-selected'));
      if(selected!=='true')await press(`#sim-tab-${tab}`);
    };
    if(has('place')){
      await phase('vertiport_place',async()=>{
        await openSimulation('vertiports');
        await page.waitForSelector('#vertiport-pick',{timeout:10000});
        await mark('panel-open');
        await press('#vertiport-pick');
        await mark('pick-armed');
        for(let i=0;i<=30;i++){await page.mouse.move(cx-300+i*20,cy-90+i*6);await page.waitForTimeout(100);}
        await mark('follow-done');
        await page.mouse.click(cx+300,cy+90,{button:'right'});
        await page.waitForSelector('#place-menu',{timeout:10000});
        await mark('tools-open');
        for(const value of [6,12,18,24,30,36])await Promise.all([setRange('#place-menu input[name=platform_height_m]',value),page.waitForTimeout(160)]);
        await page.waitForTimeout(1200);await mark('height-done');
        for(const value of [15,30,45,60,75,90])await Promise.all([setRange('#place-menu input[name=heading_deg]',value),page.waitForTimeout(160)]);
        await page.waitForTimeout(1200);await mark('heading-done');
        await page.$eval('#place-menu select[name=pattern]',el=>{const o=[...el.options].find(o=>o.value!==el.value);if(o){el.value=o.value;el.dispatchEvent(new Event('change',{bubbles:true}));}});
        await page.waitForTimeout(1500);await mark('pattern-done');
        await page.keyboard.press('Escape');await page.waitForTimeout(300);await page.keyboard.press('Escape');
        await mark('cancelled');
      },{sampleMs:1500});
    }
    // ---- edit a saved vertiport in place ------------------------------------
    if(has('edit')&&target){
      await phase('vertiport_edit',async()=>{
        await openSimulation('vertiports');
        const frame=target.layout.frame;
        const screen=await page.evaluate(({frame,id})=>{const g=aerodtDiagnostics.globe;const top=g.deckTopOf(id);return g.screenOf({longitude:frame.longitude,latitude:frame.latitude,height:Number.isFinite(top)?top:0});},{frame,id:target.id});
        if(!screen)throw new Error('vertiport is not on screen');
        await mark('click-deck',{screen});
        await page.mouse.click(screen.x,screen.y);
        await page.waitForSelector('#place-menu',{timeout:10000});
        await mark('tools-open');
        for(const value of [12,18,24,30])await Promise.all([setRange('#place-menu input[name=platform_height_m]',value),page.waitForTimeout(160)]);
        await page.waitForTimeout(2500);await mark('height-done');
        for(const value of [10,20,30])await Promise.all([setRange('#place-menu input[name=heading_deg]',value),page.waitForTimeout(160)]);
        await page.waitForTimeout(2000);await mark('heading-done');
        const dismissed=await page.$$eval('#place-menu button',buttons=>{const b=buttons.find(b=>b.textContent.trim()==='취소');if(b){b.click();return true;}return false;});
        if(!dismissed)await page.keyboard.press('Escape');
        await mark('cancelled');
      },{sampleMs:2000});
    }
    // ---- route editing: hover picks, adding, a node card --------------------
    if(has('route')){
      await phase('route_edit',async()=>{
        await openSimulation('routes');
        await page.waitForSelector('#route-add',{timeout:15000});
        await page.waitForFunction(()=>Boolean(aerodtDiagnostics.globe.routeEditor),null,{timeout:10000}).catch(()=>{});
        await mark('editor-armed');
        for(let i=0;i<=30;i++){await page.mouse.move(cx-300+i*20,cy+80-i*5);await page.waitForTimeout(100);}
        await mark('hover-done');
        await press('#route-add');await mark('adding');
        for(let i=0;i<=20;i++){await page.mouse.move(cx+300-i*25,cy-70+i*6);await page.waitForTimeout(100);}
        await mark('adding-hover-done');
        await page.mouse.click(cx-200,cy+50);await page.waitForTimeout(1200);await mark('node-card');
        await page.keyboard.press('Escape');await page.waitForTimeout(300);await page.keyboard.press('Escape');await page.waitForTimeout(300);
        await mark('cancelled');
        await page.click('#drawer-close').catch(()=>{});
      },{sampleMs:1500});
    }
    // ---- live snapshot ticks at rest ----------------------------------------
    if(has('ticks'))await phase('snapshot_ticks',async()=>{await page.click('#drawer-close').catch(()=>{});},{sampleMs:10000});
    // ---- the aircraft camera window (fixture UAM; live client paused) -------
    if(has('camera')&&target){
      const frame=target.layout.frame;
      const centre=await page.evaluate(({frame,id})=>{const g=aerodtDiagnostics.globe;const top=g.deckTopOf(id);return {longitude:frame.longitude,latitude:frame.latitude,height:Number.isFinite(top)?top:(frame.altitude_m??30)};},{frame,id:target.id});
      await phase('model_update',async()=>{
        result.fixture=await page.evaluate(installFixture,{centre,count:8});
        await mark('injected');
        await page.evaluate(id=>aerodtDiagnostics.globe.select(id,{focus:true}),result.fixture.ids[0]);
        await page.waitForFunction(id=>{const item=aerodtDiagnostics.globe.items.get(id);return Boolean(item?.model?.ready===true);},result.fixture.ids[0],{timeout:20000}).catch(()=>{});
        await mark('model-ready');
      },{sampleMs:4000});
      await phase('camera_window',async()=>{
        // The selection card lives in a workspace window; its camera button is
        // the visible clone, not the hidden template's #camera-live.
        const clicked=await page.evaluate(()=>{
          const buttons=[...document.querySelectorAll('.ww-shell .camera-live, .selection-window .camera-live, #camera-live')];
          const button=buttons.find(b=>!b.hidden&&b.offsetParent!==null)??buttons.find(b=>!b.hidden);
          if(!button)return null;button.click();return button.id||button.className;
        });
        await mark('camera-button',{clicked});
        await page.waitForSelector('.aircraft-camera-panel',{timeout:15000});
        await mark('window-open');
        await page.waitForFunction(()=>Boolean(document.querySelector('.aircraft-camera-panel canvas')),null,{timeout:10000}).catch(()=>{});
        await page.waitForTimeout(8000);await mark('watched');
        await page.$eval('.aircraft-camera-panel',panel=>panel.closest('.ww-shell')?.querySelector('.ww-close')?.click());
        await mark('closed');
      },{sampleMs:2000});
      await page.evaluate(()=>{globalThis.aerodtFixture?.stop();aerodtDiagnostics.client.setPaused(false);});
    }
    await page.evaluate(()=>aerodtProbe.dispose());
    result.completed=true;
    await context.close();
  }catch(error){result.completed=false;result.failure={name:error.name,message:safeMessage(error.message)};console.log(JSON.stringify({event:'failed',...result.failure}));}
  finally{await browser.close();result.finishedAt=new Date().toISOString();await save(options.output,result);}
  console.log(JSON.stringify({event:'complete',phases:result.phases.length,output:options.output,completed:result.completed}));
  if(!result.completed)process.exitCode=1;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{
  const parsed=options(process.argv.slice(2));
  if(parsed.help)console.log('Interaction stutter probe: --url URL --label NAME [--root SOURCE_ROOT] [--headed] [--phases a,b,c] [--output JSON] [--browser CHROME_EXE] [--playwright INDEX_MJS] [--vertiport ID] [--viewport 1600x900]');
  else await run(parsed);
}catch(error){console.error(`${error.name}: ${safeMessage(error.message)}`);process.exitCode=1;}
