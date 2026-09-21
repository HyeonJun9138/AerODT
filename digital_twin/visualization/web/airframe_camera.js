import {loadOsmBuildings} from './building_layer.js';
import {loadVWorldBuildings} from './building_streaming.js';
import {VWorldBuildingLayer,fetchCell,cellKey} from './vworld_building_layer.js';
import {releaseWidgetContext} from './webgl_release.js';
import {retainShaderPrograms} from './shader_retention.js';
const LABELS={front:'FWD',right:'RGT',rear:'AFT',left:'LFT',down:'DOWN',around:'TOP'};
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=v=>{const n=Math.hypot(...v);return n>1e-9?v.map(x=>x/n):null;};
const corrected=v=>[v[0],-v[2],v[1]];

// Frame-relative mounts; around is one elevated, own-aircraft top view.
export function airframeCameraPose(matrix,profile,mode,radius=6,surfaceUp=null){
  if(!matrix||!Array.from({length:16},(_,i)=>matrix[i]).every(Number.isFinite))return null;
  const f=profile?.forward&&unit(corrected(profile.forward)),u=profile?.up&&unit(corrected(profile.up));
  const r=f&&u&&unit(cross(f,u));if(!r)return null;
  radius=Number.isFinite(radius)?Math.max(2,Math.min(40,radius)):6;
  let direction,up=u,offset;
  const side=mode==='left'?r.map(x=>-x):mode==='right'?r:mode==='rear'?f.map(x=>-x):f;
  if(mode==='around'){direction=u.map(x=>-x);up=f;offset=u.map(x=>x*radius*3);}
  else if(mode==='down'){direction=u.map(x=>-x);up=f;offset=u.map(x=>x*.5);}
  else{direction=unit(side.map((x,i)=>x*.94-u[i]*.342));offset=side.map((x,i)=>x*radius+u[i]*(mode==='front'?Math.max(1.2,radius*.35):.25));}
  const transform=(v,point)=>[0,1,2].map(i=>matrix[i]*v[0]+matrix[4+i]*v[1]+matrix[8+i]*v[2]+(point?matrix[12+i]:0));
  let worldDirection=unit(transform(direction,false)),worldUp=unit(transform(up,false)),position=transform(offset,true);
  if(mode==='around'&&surfaceUp){
    const vertical=unit(surfaceUp);if(!vertical)return null;
    position=vertical.map((x,i)=>matrix[12+i]+x*radius*3);
    worldDirection=vertical.map(x=>-x);
    const forward=transform(f,false),dot=forward.reduce((v,x,i)=>v+x*vertical[i],0);
    worldUp=unit(forward.map((x,i)=>x-dot*vertical[i]))??unit(transform(r,false));
  }
  const right=worldDirection&&worldUp&&unit(cross(worldDirection,worldUp));
  return right?{position,direction:worldDirection,up:cross(right,worldDirection)}:null;
}

// How long to wait before the next frame.
//
// This widget renders on the page's main thread, in the same turn as the map
// the operator is actually flying over, so every millisecond it spends is a
// millisecond the map and the manual-control uplink do not get.
//
// The wait used to be `cost * FRAME_SHARE`, which reads as "the camera gets a
// quarter of the thread" but is not: the cost cancels out of cost/(k*cost), so
// the share was k regardless. A frame made twice as cheap was simply asked for
// twice as often and the share stayed exactly where it was - making the image
// cheaper returned nothing to the map. The wait is now set by two floors that
// do not cancel, so a cheaper frame finally buys idle time:
//
//   cost / DUTY_BUDGET      the camera may not exceed this share of the thread
//   mapFrameMs * MAP_FRAME_MULTIPLE
//                           and may not interleave faster than every second
//                           map frame, so a struggling map sheds the camera
//                           before the camera makes it struggle further
//
// FRAME_MIN_MS is the detector's submission period (the panel refuses to send
// a frame sooner). A frame produced faster than that is a frame nobody reads,
// and pacing to exactly that period means every frame rendered is used.
//
// FRAME_MAX_MS still caps the wait, so a very expensive frame overshoots the
// duty budget rather than freezing the image: 100 ms of work every 400 ms is
// 25%, not the 20% asked for. That is deliberate - an image that stops is
// worse than one that costs a little more than its budget.
export const FRAME_MIN_MS=200,FRAME_MAX_MS=400,DUTY_BUDGET=.2,MAP_FRAME_MULTIPLE=2;
export function framePacing(costMs,mapFrameMs){
  if(!Number.isFinite(costMs)||costMs<0)return FRAME_MAX_MS;
  const floor=Math.max(costMs/DUTY_BUDGET,Number.isFinite(mapFrameMs)&&mapFrameMs>0?mapFrameMs*MAP_FRAME_MULTIPLE:0);
  return Math.max(FRAME_MIN_MS,Math.min(FRAME_MAX_MS,floor));
}
// Cockpit viewing has no detector throughput requirement: preserve map headroom.
export function cockpitFramePacing(costMs,mapFrameMs){
  const cost=Number.isFinite(costMs)?Math.max(0,costMs):60;
  return Math.max(200,Math.min(1500,Math.max(cost/.12,(mapFrameMs||0)*3)));
}
// Read loaded DEM tiles only: no network request or terrain sampling per frame.
// The aircraft centre is a safe fallback for the downward lens, including decks.
export function protectCameraSurface(C,pose,frame,mainGlobe,cameraGlobe){
  if(!C.Cartographic?.fromCartesian||!C.Cartesian3?.fromRadians)return pose;
  const c=C.Cartographic.fromCartesian(new C.Cartesian3(...pose.position));if(!c)return pose;
  const heights=[mainGlobe?.getHeight?.(c),cameraGlobe?.getHeight?.(c)].filter(Number.isFinite);
  if(pose.mode==='down'){
    const origin=C.Cartographic.fromCartesian(new C.Cartesian3(frame.matrix[12],frame.matrix[13],frame.matrix[14]));
    if(Number.isFinite(origin?.height))heights.push(origin.height);
  }
  if(heights.length&&c.height<Math.max(...heights)+.5){
    const p=C.Cartesian3.fromRadians(c.longitude,c.latitude,Math.max(...heights)+.5);
    return {...pose,position:[p.x,p.y,p.z]};
  }
  return pose;
}
// Which buildings the camera draws: the same family the map is drawing, so
// the image out of the window shows the city the operator sees on the map.
// `vworld` on the map is the footprint layer, not a tileset; the camera used
// to answer that with ion's OSM buildings, which stream slowly into a second
// context and left the view empty for most of a flight.
export function buildingSourceFor(provider,enabled=true){
  if(!enabled)return null;
  if(['vworld_3d','vworld_hybrid'].includes(provider))return 'vworld_3d';
  if(provider==='vworld')return 'footprints';
  return 'osm';
}
// How far out the footprint city is built around the camera. Far enough to
// fill the horizon of a 95-degree lens at a few hundred metres up; near
// enough that it is a dozen cells, not the map's forty-eight.
export const FOOTPRINT_RANGE_M=2500;
// How far the lens has to move before the city around it is selected again.
// The cells are CELL_DEGREES (about 1.1 km) wide, so a camera that has moved a
// couple of hundred metres is looking at the same cells it was looking at
// before; re-selecting them is work with no result on screen.
export const FOOTPRINT_REFOCUS_M=200;
// One lazily created, low-resolution rendering context. The primary Cesium
// camera and physics clocks are never moved to capture an external frame.
export class AirframeCamera {
  constructor(globe,canvas,onStatus=()=>{},options={}){
    Object.assign(this,{globe,canvas,onStatus,options});this.frameNumber=0;this.enabled=false;this.mode='front';this.generation=0;this.models=new Map();this.last=-Infinity;this.interval=160;
    // Smoothed cost of a frame and what the last two seconds came to; the
    // panel shows these, so a slow camera is a number rather than a feeling.
    this.cost=NaN;this.frameTimes=[];this.stats={fps:0,ms:0,last:0,duty:0};this.hostFrameMs=NaN;
  }
  set({enabled,mode='front'}){
    if(!enabled){this.stop();return;}
    if(mode!==this.mode)this.clear();
    this.mode=['front','rear','left','right','down','around'].includes(mode)?mode:'front';this.enabled=true;this.last=-Infinity;
    this.retryCount=0;this.retryAt=0;
    if(!this.widget)this.start();
  }
  clear(){const c=this.canvas.getContext?.('2d');if(c){c.fillStyle='#08131b';c.fillRect(0,0,this.canvas.width,this.canvas.height);}}
  start(){
    const C=this.globe.C,source=this.globe.viewer;this.clear();
    try{
      const doc=this.canvas.ownerDocument;
      this.host=doc.createElement('div');this.host.className='airframe-camera-render-host';this.host.setAttribute('aria-hidden','true');Object.assign(this.host.style,{position:'fixed',left:'-10000px',top:'0',width:'576px',height:this.options.cockpit?'360px':'288px',pointerEvents:'none'});doc.body.append(this.host);
      // This widget draws the same imagery the map already draws, so the map's
      // own credit plate already carries every attribution it owes. Pointing it
      // at that plate as well printed the Cesium mark and the data link twice,
      // side by side, which reads as a bug rather than as a second credit. Its
      // own container lives inside this offscreen host: still rendered, still
      // there for anything that inspects it, and gone when the camera stops.
      this.credits=doc.createElement('div');this.host.append(this.credits);
      this.widget=new C.CesiumWidget(this.host,{baseLayer:false,terrainProvider:source.terrainProvider,
        useDefaultRenderLoop:false,scene3DOnly:true,shouldAnimate:false,shadows:false,msaaSamples:1,
        contextOptions:{webgl:{alpha:false,antialias:false}},showRenderLoopErrors:false,
        creditContainer:this.credits});
      const scene=this.widget.scene;
      if(this.options.cockpit){this.widget.useBrowserRecommendedResolution=true;this.widget.resolutionScale=.75;}
      // The second context compiles its own programs; a model that leaves the
      // lens and comes back must not pay its link wait a second time.
      retainShaderPrograms(scene);
      this.dataSources=new C.DataSourceCollection();
      this.dataDisplay=new C.DataSourceDisplay({scene,dataSourceCollection:this.dataSources});
      this.graphicsEntities=this.dataDisplay.defaultDataSource.entities;
      // A 576-pixel view needs far less terrain than the map, and each tile
      // it does take is decoded on the main thread inside `render()`: the
      // 100-500 ms spikes measured on this widget were tile processing, not
      // drawing. Fewer tiles per frame, no preloading, no post-processing.
      scene.globe.maximumScreenSpaceError=6;scene.globe.tileCacheSize=64;
      scene.globe.loadingDescendantLimit=4;scene.globe.preloadSiblings=false;scene.globe.preloadAncestors=false;
      scene.globe.showGroundAtmosphere=false;scene.highDynamicRange=false;
      if(scene.postProcessStages?.fxaa)scene.postProcessStages.fxaa.enabled=false;
      if(scene.shadowMap)scene.shadowMap.enabled=false;
      scene.globe.depthTestAgainstTerrain=true;scene.fog.enabled=source.scene.fog.enabled;
      scene.screenSpaceCameraController.enableInputs=false;scene.screenSpaceCameraController.enableCollisionDetection=false;
      this.widget.camera.frustum.near=.15;this.widget.camera.frustum.fov=95*Math.PI/180;
      this.removeError=scene.renderError.addEventListener((scene,error)=>{
        const generation=this.generation;this.renderFault=true;
        queueMicrotask(()=>{if(generation===this.generation)this.recover(error,'render');});
      });
      this.widget.resize();this.syncImagery();if(!this.options.cockpit)this.loadBuildings();this.onStatus({text:'외부 시점 준비 · 지형 불러오는 중',age:'LOADING'});
    }catch(error){this.recover(error,'start');}
  }
  syncImagery(){
    const C=this.globe.C,source=this.globe.viewer,w=this.widget;
    if(w.terrainProvider!==source.terrainProvider)w.terrainProvider=source.terrainProvider;
    const layers=Array.from({length:source.imageryLayers.length},(_,i)=>source.imageryLayers.get(i)).filter(l=>l.show&&l.imageryProvider).slice(0,5);
    const same=this.imagery?.length===layers.length&&layers.every((l,i)=>this.imagery[i]===l);
    if(!same){w.imageryLayers.removeAll(true);this.imagery=layers;for(const layer of layers)w.imageryLayers.add(new C.ImageryLayer(layer.imageryProvider,{alpha:layer.alpha,brightness:layer.brightness,contrast:layer.contrast,saturation:layer.saturation}));}
    w.scene.globe.enableLighting=source.scene.globe.enableLighting;
  }
  loadBuildings(){
    const source=buildingSourceFor(this.globe.buildingProvider,this.globe.buildingsEnabled);
    if(!source)return;
    if(source==='footprints'){this.startFootprints();return;}
    const widget=this.widget,C=this.globe.C;
    const load=source==='vworld_3d'?loadVWorldBuildings:loadOsmBuildings;
    load(C).then(tiles=>{
      if(widget!==this.widget){tiles.destroy();return;}
      tiles.maximumScreenSpaceError=24;tiles.cacheBytes=64*1024*1024;tiles.maximumCacheOverflowBytes=16*1024*1024;
      this.widget.scene.primitives.add(tiles);this.tiles=tiles;
      this.tileFailure=tiles.tileFailed.addEventListener(()=>{this.buildingError=true;});
    }).catch(()=>{if(widget===this.widget)this.buildingError=true;});
  }
  // The map's footprint city, built again in this context. A primitive belongs
  // to the WebGL context that compiled it, so the map's cannot be shown here;
  // the data can, and a cell the map has already fetched is not fetched twice.
  startFootprints(){
    const C=this.globe.C,main=this.globe.vworldBuildings;
    const load=(column,row,options)=>{
      const cell=main?.cells?.get(cellKey(column,row));
      return cell?.data?Promise.resolve({buildings:cell.data}):fetchCell(column,row,options);
    };
    const layer=new VWorldBuildingLayer({C,scene:this.widget.scene,load,groundHeights:points=>this.globe.groundHeights(points),
      onStatus:status=>{if(['error','unavailable'].includes(status))this.buildingError=true;}});
    layer.setAppearance({...(this.globe.buildingAppearance??{}),quality:'compact'});
    if(main)layer.setCleared(main.cleared,main.overlapsCleared);
    layer.setEnabled(true);this.footprints=layer;
  }
  updateFootprints(pose,now){
    const layer=this.footprints;if(!layer)return;
    // Cell selection is cheap but not free, and the camera moves tens of
    // metres a second against cells a kilometre wide.
    if(now-(this.footprintsAt??-Infinity)<500)return;this.footprintsAt=now;
    const C=this.globe.C,carto=C.Cartographic.fromCartesian(new C.Cartesian3(...pose.position));if(!carto)return;
    const longitude=carto.longitude*180/Math.PI,latitude=carto.latitude*180/Math.PI;
    // The layer decides whether it may keep its cell selection by comparing
    // this focus BY IDENTITY. A fresh object literal every half second answered
    // "no" every single time, so the whole grid was re-selected for a lens that
    // had moved a few dozen metres across cells a kilometre wide - the one
    // input here that was never actually reused. So one object is kept, and
    // replaced only when the lens has moved far enough to be able to change the
    // selection, or when the selection is old enough not to be trusted.
    const moved=!this.footprintFocus||Math.hypot((longitude-this.footprintFocus.longitude)*88300,(latitude-this.footprintFocus.latitude)*111320)>FOOTPRINT_REFOCUS_M;
    if(moved||now-(this.footprintFocusAt??-Infinity)>5000){
      this.footprintFocus={longitude,latitude,range:FOOTPRINT_RANGE_M,cameraLongitude:longitude,cameraLatitude:latitude,offset:0,hazeStrength:.58};
      this.footprintFocusAt=now;
    }
    layer.update(carto.height,null,now,this.footprintFocus,{moving:false});
  }
  syncObjects(frame){
    const C=this.globe.C,w=this.widget;
    // Reuse read-only graphic properties for authored pads/structures. Own
    // entities and models belong exclusively to this small rendering context.
    const origin=new C.Cartesian3(frame.matrix[12],frame.matrix[13],frame.matrix[14]),time=this.globe.viewer.clock.currentTime;
    // Route/airspace volumes are UI overlays, not objects a body camera sees.
    // A thousand map entities are walked to find the port structures near the
    // camera. Structures do not move and the camera covers tens of metres a
    // second, so once a second is often enough for a 3 km radius.
    const scanAt=performance.now();
    if(!this.objectScan||scanAt-this.objectScan.at>1000){
      const objects=this.globe.viewer.entities.values.filter(e=>String(e.id).startsWith('vertiport:')&&e.isShowing!==false&&e.show!==false&&(e.model||e.polygon||e.box||e.cylinder)).map(e=>{
        const position=e.position?.getValue(time)??e.polygon?.hierarchy?.getValue(time)?.positions?.[0];
        return {e,distance:position?C.Cartesian3.distance(origin,position):Infinity};
      }).filter(x=>x.distance<3000).sort((a,b)=>a.distance-b.distance).slice(0,180).map(x=>x.e);
      this.objectScan={at:scanAt,objects};
    }
    const objects=this.objectScan.objects;
    if(!this.graphics)this.graphics=new Map();
    const entities=this.graphicsEntities??w.entities;
    const ids=new Set(objects.map(e=>e.id));
    for(const [id,e] of this.graphics)if(!ids.has(id)){entities.remove(e);this.graphics.delete(id);}
    for(const e of objects)if(!this.graphics.has(e.id)){
      this.graphics.set(e.id,entities.add(new C.Entity({id:e.id,position:e.position,orientation:e.orientation,
        model:e.model?.clone(),polygon:e.polygon?.clone(),box:e.box?.clone(),cylinder:e.cylinder?.clone()})));
    }
    const targets=this.options.hideOwn?[]:[{id:'own',assetId:frame.assetId,matrix:frame.matrix,uri:frame.uri,scale:frame.scale??1}];
    // What this camera's own detector placed in the world must not be drawn
    // back into this camera's image, or the detector sees its own answer.
    targets.push(...[...this.globe.items.values()].filter(i=>i.entity.entity_id!==frame.entityId&&['uam','aircraft','helicopter','drone','bird'].includes(i.entity.kind)&&i.position&&i.entity.provenance!=='camera_ai')
      .map(i=>({i,d:C.Cartesian3.distance(origin,i.position)})).filter(x=>x.d<1500)
      // An object the operator just put in front of the camera goes first: on
      // a busy deck the parked neighbours are nearer, and the loader takes two
      // at a time, so a crossing that queued behind them could be over before
      // its model arrived.
      .sort((a,b)=>(Number(Boolean(b.i.entity.intruder?.injected))-Number(Boolean(a.i.entity.intruder?.injected)))||a.d-b.d).slice(0,8)
      // The file and the number that scales it are one decision, taken where
      // the map takes it. Picked apart - the uri unconditionally from the
      // flight rig, the scale from a different predicate - this drew an
      // injected intruder's rig at the base model's scale: 1.469x too small,
      // and every range the detector derived from apparent size inherited it.
      .map(({i})=>{const visual=this.globe.entityScene.visualOf?.(i)??{};
        return {id:i.entity.entity_id,assetId:i.assetId,matrix:this.globe.entityScene.matrix?.(i)??i.model?.modelMatrix,
          uri:visual.uri,scale:visual.scale??1,body:i.entity.intruder?.injected?i.entity.intruder.size_m:0};}));
    const kept=new Set(targets.map(t=>t.id));
    for(const [id,entry] of this.models)if(!kept.has(id)){if(entry.model)w.scene.primitives.remove(entry.model);this.models.delete(id);}
    // A bird that has crossed is gone from `targets`, so its body has just been
    // removed above; nothing else is needed to end a crossing.
    let loading=[...this.models.values()].filter(m=>m.pending).length;
    for(const target of targets){
      if(!target.matrix||!Array.from({length:16},(_,i)=>target.matrix[i]).every(Number.isFinite))continue;
      // `target.uri` was chosen together with `target.scale` and is the only
      // pair that may be drawn. The fallback serves the own-aircraft target,
      // which is always an articulated flight rig and whose pair was decided
      // by the frame it arrived on.
      const asset=this.globe.entityScene.assets.get(target.assetId),uri=target.uri??asset?.flight_visual?.uri??asset?.uri;
      let existing=this.models.get(target.id);
      if(existing&&existing.uri!==uri){if(existing.model)w.scene.primitives.remove(existing.model);this.models.delete(target.id);existing=null;}
      if(existing?.model){existing.model.modelMatrix=C.Matrix4.clone(target.matrix,existing.model.modelMatrix);existing.model.scale=target.scale;existing.model.show=target.id!=='own'||this.mode!=='down';continue;}
      if(!uri&&target.body){
        // Something with no glTF of its own - an injected bird - still has to
        // be in the frame, or the vision model is being asked about an empty
        // sky. A small dark body at the right size is not a bird, and it is
        // not pretending to be: it is an obstacle of the right scale in the
        // right place, which is what the crossing is for.
        if(existing?.model){existing.model.modelMatrix=C.Matrix4.clone(target.matrix,existing.model.modelMatrix);continue;}
        if(existing)continue;
        const radius=Math.max(.2,target.body/2);
        const body=w.scene.primitives.add(new C.Primitive({
          geometryInstances:new C.GeometryInstance({
            geometry:new C.EllipsoidGeometry({radii:new C.Cartesian3(radius*1.6,radius,radius*.55),
              vertexFormat:C.PerInstanceColorAppearance.VERTEX_FORMAT}),
            modelMatrix:C.Matrix4.clone(target.matrix),
            attributes:{color:C.ColorGeometryInstanceAttribute.fromColor(C.Color.fromBytes(38,34,30,255))}}),
          appearance:new C.PerInstanceColorAppearance({flat:true,translucent:false}),
          asynchronous:false,allowPicking:false}));
        this.models.set(target.id,{model:body,uri:null,body:true});
        continue;
      }
      if(!uri||!target.matrix||existing||loading>=2)continue;
      loading++;const entry={pending:true,uri};this.models.set(target.id,entry);
      C.Model.fromGltfAsync({url:uri,forwardAxis:C.Axis.X,upAxis:C.Axis.Y,modelMatrix:C.Matrix4.clone(target.matrix),scale:target.scale,environmentMapOptions:{enabled:false},incrementallyLoadTextures:true,allowPicking:false}).then(model=>{
        if(w!==this.widget||this.models.get(target.id)!==entry){model.destroy();return;}
        model.show=target.id!=='own'||this.mode!=='down';w.scene.primitives.add(model);this.models.set(target.id,{model,uri});
      }).catch(()=>{if(w===this.widget&&this.models.get(target.id)===entry)this.models.set(target.id,{failed:true,uri});});
    }
  }
  update(frame,now){
    if(this.enabled&&!this.widget&&this.retryAt&&performance.now()>=this.retryAt){this.retryAt=0;this.start();}
    // What the host is costing per frame. `update` is called once per host
    // frame - the panel's rAF, the cockpit's postRender - so the gap between
    // calls is the map's own frame time, which is the thing the camera has to
    // stay underneath. Measured here because it is the only place that sees it.
    const gap=now-(this.updatedAt??NaN);this.updatedAt=now;
    if(Number.isFinite(gap)&&gap>0&&gap<1000)this.hostFrameMs=Number.isFinite(this.hostFrameMs)?this.hostFrameMs*.8+gap*.2:gap;
    if(!this.enabled||!this.widget||this.canvas.ownerDocument.hidden)return;
    // update can be called by the main scene's postRender. Never recursively
    // render a second Cesium context from inside another scene's frame.
    // The newest pose is kept every host frame, so the frame that is finally
    // rendered is rendered from where the aircraft is now, not from where it
    // was when the wait began.
    this.pendingFrame=frame?.matrix?{...frame,matrix:this.globe.C.Matrix4.clone(frame.matrix)}:frame;
    if(this.renderTask!=null)return;
    // Waited out on a timer of its own rather than on the host's frame grid.
    // Gating on `now` here rounded every interval up to the next host frame - a
    // 125 ms wait on a 62 ms grid is really 186 ms - so the share of the thread
    // the camera took never matched the share the pacing law asked for.
    const generation=this.generation,wait=Math.max(0,this.interval-(now-this.last));
    this.renderTask=setTimeout(()=>{
      this.renderTask=null;
      const next=this.pendingFrame;this.pendingFrame=null;
      if(generation===this.generation&&this.enabled&&this.widget)this.renderFrame(next,performance.now());
    },wait);
  }
  cancelFrame(){if(this.renderTask!=null)clearTimeout(this.renderTask);this.renderTask=null;this.pendingFrame=null;}
  renderFrame(frame,now){
    if(!this.enabled||!this.widget||this.canvas.ownerDocument.hidden||now-this.last<this.interval)return;
    if(!frame?.matrix||!frame.profile){this.onStatus({text:'기체 시점 수신 대기',age:'WAITING'});return;}
    const w=this.widget,C=this.globe.C;this.last=now;const started=performance.now();
    try{
      // Focus/layout changes can briefly collapse the source canvas. Resize
      // before rendering and never drawImage a zero-sized source.
      if(!w.canvas.width||!w.canvas.height)w.resize();
      if(!w.canvas.width||!w.canvas.height){
        this.onStatus({text:'카메라 표시 영역 준비 중',age:'WAITING'});return;
      }
      this.renderFault=false;this.errorStage='imagery';this.syncImagery();this.errorStage='objects';this.syncObjects(frame);
      const mode=this.mode;
      const normal=mode==='around'?this.globe.viewer.scene.globe.ellipsoid?.geodeticSurfaceNormal?.(new C.Cartesian3(frame.matrix[12],frame.matrix[13],frame.matrix[14])):null;
      let pose=airframeCameraPose(frame.matrix,frame.profile,mode,frame.radius,normal?[normal.x,normal.y,normal.z]:null);if(!pose)return;
      pose=protectCameraSurface(C,{...pose,mode},frame,this.globe.viewer.scene.globe,w.scene.globe);
      // Kept with the frame number: the detector's answer for this image is
      // placed in the world from the pose it was rendered from, not from
      // wherever the camera is by the time the answer arrives.
      this.lastPose={frame:this.frameNumber+1,mode,position:pose.position,direction:pose.direction,up:pose.up,at:now};
      w.camera.setView({destination:new C.Cartesian3(...pose.position),orientation:{direction:new C.Cartesian3(...pose.direction),up:new C.Cartesian3(...pose.up)},endTransform:C.Matrix4.IDENTITY});
      this.errorStage='buildings';this.updateFootprints(pose,now);
      // Fixed aspect per consumer; resizing occurs only at adaptive quality changes.
      w.clock.currentTime=C.JulianDate.clone(this.globe.viewer.clock.currentTime,w.clock.currentTime);this.errorStage='entities';this.dataDisplay?.update(w.clock.currentTime);this.errorStage='render';w.render();if(this.renderFault)return;
      this.errorStage='copy';const ctx=this.canvas.getContext('2d');if(!ctx)return;
      const surround=this.mode==='around',width=this.canvas.width,height=this.canvas.height;
      if(!w.canvas.width||!w.canvas.height)return;
      ctx.drawImage(w.canvas,0,0,width,height);
      this.frameNumber++;
      if(!this.options.cleanFrame){
        ctx.fillStyle='#051019d9';ctx.fillRect(0,0,width,20);ctx.font='11px Consolas,monospace';ctx.fillStyle='#d8fff3';
        ctx.fillText(LABELS[mode],8,14);
      }
      const ms=performance.now()-started;
      // Smoothed, so one tile-decode spike does not slow the next second of
      // frames; the spike itself is reported as `last`.
      this.cost=Number.isFinite(this.cost)?this.cost*.7+ms*.3:ms;this.interval=framePacing(this.cost,this.hostFrameMs);
      if(this.options.cockpit){
        this.interval=cockpitFramePacing(Math.max(this.cost,ms),this.hostFrameMs);
        // Lower resolution under sustained load, recover slowly without resize churn.
        if(now-(this.resolutionAt??-Infinity)>3000){
          const scale=this.cost>35||this.hostFrameMs>45?.6:this.cost<18&&this.hostFrameMs<30?.85:.75;
          if(w.resolutionScale!==scale){w.resolutionScale=scale;w.resize();}this.resolutionAt=now;
        }
        if(!this.buildingsStarted&&this.frameNumber>=2){this.buildingsStarted=true;this.loadBuildings();}
      }
      this.frameTimes.push(now);while(this.frameTimes.length&&now-this.frameTimes[0]>2000)this.frameTimes.shift();
      const span=now-this.frameTimes[0];
      const fps=this.frameTimes.length>1&&span>0?Math.round((this.frameTimes.length-1)*1000/span):0;
      // What this camera actually took of the main thread over the window just
      // measured, as a percentage - not what the pacing law intended it to
      // take. Those two came apart once already and nobody could see it: the
      // old law's share was scale-free and the host's frame grid rounded every
      // wait up. So it is measured, shown, and can be argued with.
      this.stats={fps,ms:Math.round(this.cost),last:Math.round(ms),duty:Math.round(fps*this.cost/10)};
      this.onStatus({fps:this.stats.fps,ms:this.stats.ms,last:this.stats.last,duty:this.stats.duty,age:frame.stale?'HELD POSE':'● 3D LIVE',text:frame.stale?'오래된 기체 위치 · 마지막 시점 유지':this.buildingError?'지형 영상 · 건물 일부 불러오기 실패':surround?'기체 상공 탑뷰':w.scene.globe.tilesLoaded?'기체 장착 시점 · 현재 3D 장면':'현재 3D 장면 · 지형 세부 로딩'});
    }catch(error){this.recover(error,this.errorStage??'frame');}
  }
  recover(error,stage){
    const count=(this.retryCount??0)+1;
    this.lastError={stage,message:String(error?.message??error),stack:error?.stack};
    console.warn('[AirframeCamera]',stage,error);
    this.release();this.retryCount=count;
    if(count<=2){this.enabled=true;this.retryAt=performance.now()+count*1000;this.onStatus({text:'카메라 영상 재연결 중 · '+stage,age:'RECONNECTING'});}
    else this.onStatus({text:'영상 오류 · '+stage+' · '+this.lastError.message,age:'NO VIDEO'});
  }
  fail(text){this.release();this.onStatus({text,age:'NO VIDEO'});}
  // Off, but kept: pending resource loads are scoped to the widget lifetime,
  // not the power generation, so an OFF/ON cannot strand a pending model.
  // The widget, its terrain and imagery, the city cells and the
  // models it has loaded stay, so the next start draws at once instead of
  // creating a context and compiling every program again (measured 1.8 s of
  // link waits and 3 s of long tasks on one opening). A camera that failed,
  // or a page going away, releases everything through release().
  stop(){
    this.cancelFrame();
    this.enabled=false;this.generation++;this.last=-Infinity;
    // The structures near the lens are scanned again on the next start: the
    // aircraft, and with it the lens, may be somewhere else by then.
    this.objectScan=null;
    // The host's frame time is measured from the gap between update() calls,
    // and the gap across a stop is not a frame time. Forgotten, not carried.
    this.updatedAt=undefined;
  }
  // The panel draws into a canvas of its own that it recreates when it is
  // opened again; the camera keeps working, into the new one.
  attach(canvas){this.canvas=canvas;this.clear();}
  release(){
    this.cancelFrame();
    this.enabled=false;this.generation++;this.removeError?.();this.tileFailure?.();this.removeError=this.tileFailure=null;
    this.buildingsStarted=false;this.resolutionAt=undefined;this.footprints?.destroy();this.footprints=null;this.footprintsAt=undefined;this.objectScan=null;
    this.dataDisplay?.destroy();this.dataDisplay=null;this.dataSources?.destroy();this.dataSources=null;this.graphicsEntities=null;
    // Destroyed AND released: this camera is restarted often (tab hidden,
    // aircraft changed, direction changed) and each start is a new context;
    // a dozen of them left un-released got the map's own context evicted.
    releaseWidgetContext(this.widget);this.widget=null;this.host?.remove();this.host=null;this.credits=null;this.models.clear();this.graphics=null;this.tiles=null;this.imagery=null;this.buildingError=false;this.last=-Infinity;this.cost=NaN;this.frameTimes=[];this.stats={fps:0,ms:0,last:0,duty:0};this.hostFrameMs=NaN;this.updatedAt=undefined;this.footprintFocus=null;this.footprintFocusAt=undefined;this.clear();
  }
  destroy(){this.release();}
}
