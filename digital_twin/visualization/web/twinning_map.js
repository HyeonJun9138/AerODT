import {loadVisualModel} from './visual_asset_loader.js';
import {releaseWidgetContext} from './webgl_release.js';

// Where the model is drawn when nothing has reported a height. It is a viewing
// choice, not a measurement: on the ground the airframe is buried in terrain and
// read as landed, which is a claim the sender never made. 300 m is the band these
// vehicles are shown cruising in elsewhere in the dashboard.
export const DEFAULT_DISPLAY_HEIGHT_M=300;

// User-selected preview anchor near Konkuk Seoul campus, not a GPS observation.
export const DEFAULT_TEST_POSITION=Object.freeze({latitude:37.5435,longitude:127.077,height:DEFAULT_DISPLAY_HEIGHT_M});

// Display history only. No integration, prediction or authoritative state writes.
export function nextGpsRenderState(previous,snapshot={}) {
  let state=previous;
  if(!state || state.session!==snapshot.session_id)state={session:snapshot.session_id,position:null,heightDelta:null,track:[],timestamp:null};
  const gps=snapshot.gps;
  if(snapshot.sensors?.gps?.status!=='receiving'||!gps ||
    ![gps.latitude_deg,gps.longitude_deg,gps.observed_at_unix_ms].every(Number.isFinite) ||
    Math.abs(gps.latitude_deg)>90||Math.abs(gps.longitude_deg)>180)return state;
  // A sender that reports no height at all is a different case from one that
  // reports a height nobody can reference. The first is a position with the
  // height left open, drawn at the default viewing height; the second is a
  // height in dispute, and drawing it anywhere would be inventing the baseline
  // the server would not give.
  const reportsAltitude=gps.altitude_m!==null&&gps.altitude_m!==undefined;
  if(reportsAltitude&&!Number.isFinite(snapshot.gps_height_above_start_m))return state;
  if(state.timestamp!==null&&gps.observed_at_unix_ms<=state.timestamp)return state;
  // The server owns the origin and altitude reference. Null is deliberately
  // unknown, never permission to reconstruct a baseline in visualization.
  // heightDelta stays null when nothing was sent, so no reader downstream can
  // mistake the viewing height for a reported one.
  const heightDelta=reportsAltitude?snapshot.gps_height_above_start_m:null;
  const position={latitude:gps.latitude_deg,longitude:gps.longitude_deg,
    height:reportsAltitude?Math.max(0,heightDelta):DEFAULT_DISPLAY_HEIGHT_M};
  return {...state,position,heightDelta,timestamp:gps.observed_at_unix_ms,track:[...state.track,position].slice(-300)};
}

// Column-major rotation: canonical Cesium X-forward/Y-left/Z-up model -> FRD
// -> calibrated NED reference -> ENU. Mount correction is a body Z rotation.
export function modelToEnuRotation(q=[1,0,0,0],mountDegrees=0) {
  if(!Array.isArray(q)||q.length!==4||!q.every(Number.isFinite))q=[1,0,0,0];
  const norm=Math.hypot(...q)||1;const [w,x,y,z]=q.map(n=>n/norm);
  const a=(Number.isFinite(mountDegrees)?mountDegrees:0)*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
  const rotate=([vx,vy,vz])=>{
    const tx=2*(y*vz-z*vy),ty=2*(z*vx-x*vz),tz=2*(x*vy-y*vx);
    const north=vx+w*tx+y*tz-z*ty,east=vy+w*ty+z*tx-x*tz,down=vz+w*tz+x*ty-y*tx;
    return [east,north,-down];
  };
  return [...rotate([c,s,0]),...rotate([s,-c,0]),...rotate([0,0,-1])];
}

export class TwinningPreview {
  constructor(C,container,onStatus=()=>{},options={}) {
    Object.assign(this,{C,container,onStatus,creditContainer:options.creditContainer,loadModel:options.loadModel||loadVisualModel});
    this.generation=0;this.view='locked';this.toySize=null;this.cleanups=[];
    // The first sender keeps this.model and this.trackLine, because the camera,
    // the toy scale and every existing view already read them there. Senders
    // after it get their own model and trail here, drawn but never followed.
    this.others=new Map();this.loading=new Set();
  }
  async show(asset) {
    if(!asset?.uri?.startsWith('/visual-assets/')){this.close();this.onStatus('unavailable');return;}
    if(this.assetId===asset.asset_id&&this.widget)return;
    this.close();this.assetId=asset.asset_id;this.asset=asset;const generation=this.generation,C=this.C;
    this.onStatus('loading');let model,attached=false;
    try {
      const widget=this.widget=new C.CesiumWidget(this.container,{baseLayer:false,terrainProvider:new C.EllipsoidTerrainProvider(),
        skyBox:false,skyAtmosphere:false,scene3DOnly:true,shouldAnimate:false,requestRenderMode:true,
        maximumRenderTimeChange:Infinity,targetFrameRate:30,showRenderLoopErrors:false,creditContainer:this.creditContainer});
      const scene=widget.scene;scene.globe.enableLighting=false;
      if(scene.camera?.frustum)scene.camera.frustum.near=.01;
      if(scene.screenSpaceCameraController)scene.screenSpaceCameraController.minimumZoomDistance=.1;
      this.setView(this.view);
      const fail=()=>{if(generation===this.generation){this.close();this.onStatus('error');}};
      this.cleanups.push(scene.renderError.addEventListener(fail));
      // Imagery only: never load terrain or buildings, and keep provider credits.
      C.ArcGisMapServerImageryProvider.fromUrl('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer').then(provider=>{
        if(generation!==this.generation)return;
        this.cleanups.push(provider.errorEvent.addEventListener(()=>this.onStatus('imagery_error')));
        widget.imageryLayers.addImageryProvider(provider);scene.requestRender();
      }).catch(()=>{if(generation===this.generation)this.onStatus('imagery_error');});
      const resize=new ResizeObserver(()=>{widget.resize();scene.requestRender();});resize.observe(this.container);
      this.cleanups.push(()=>resize.disconnect());
      const visibility=()=>{widget.useDefaultRenderLoop=!document.hidden;if(!document.hidden)scene.requestRender();};
      document.addEventListener('visibilitychange',visibility);this.cleanups.push(()=>document.removeEventListener('visibilitychange',visibility));visibility();
      this.trackCollection=scene.primitives.add(new C.PolylineCollection());
      this.trackLine=this.trackCollection.add({positions:[],width:2,material:C.Material.fromType('Color',{color:C.Color.CYAN.withAlpha(.75)})});
      model=await this.loadModel(C,asset,'twinning-gps-aircraft',C.Matrix4.IDENTITY);
      if(generation!==this.generation){if(!model.isDestroyed?.())model.destroy();return;}
      this.model=model;scene.primitives.add(model);attached=true;
      const ready=()=>{
        if(generation!==this.generation)return;
        this.ready=true;clearTimeout(this.readyTimer);
        // Normalize the bounding diameter, not GPS distances or source assets.
        this.sourceRadius=model.boundingSphere.radius;
        this.sourceScale=model.scale||1;
        this.setToySize(this.toySize);
        this.applyPose();this.onStatus('ready');
      };
      this.cleanups.push(model.readyEvent.addEventListener(ready),model.errorEvent.addEventListener(fail));
      this.readyTimer=setTimeout(fail,20000);if(model.ready)ready();scene.requestRender();
    }catch {
      if(model&&!attached&&!model.isDestroyed?.())model.destroy();
      if(generation===this.generation){this.close();this.onStatus('error');}
    }
  }
  update(snapshot,mountDegrees=0) {
    this.snapshot=snapshot||{};this.mountDegrees=mountDegrees;
    const old=this.gpsState;
    if(old&&old.session!==this.snapshot.session_id)this.center=null;
    this.gpsState=nextGpsRenderState(old,this.snapshot);
    this.newFix=old!==this.gpsState;
    this.applyPose();
    this.updateOthers();
  }
  // Every sender past the first. The primary one is already drawn by applyPose
  // from the top of the snapshot, so this only has to cover the rest -- and it
  // never moves the camera, which belongs to whichever sender is selected.
  updateOthers() {
    const devices=Array.isArray(this.snapshot?.devices)?this.snapshot.devices:[];
    const primary=this.snapshot?.selected_device??devices[0]?.device_id;
    const live=new Set();
    for(const device of devices) {
      const id=device?.device_id;
      if(!id||id===primary)continue;
      live.add(id);
      const twin=this.others.get(id);
      if(!twin){void this.addTwin(id);continue;}
      const previous=twin.gpsState;
      if(previous&&previous.session!==device.session_id)twin.gpsState=null;
      twin.gpsState=nextGpsRenderState(twin.gpsState,device);
      this.drawTwin(twin,device);
    }
    for(const [id,twin] of [...this.others])if(!live.has(id)){this.dropTwin(twin);this.others.delete(id);}
    this.widget?.scene?.requestRender?.();
  }
  async addTwin(id) {
    // One load in flight per sender: update() runs many times a second and
    // would otherwise start a model for every frame until the first returns.
    if(this.loading.has(id)||!this.widget||!this.asset||!this.ready)return;
    this.loading.add(id);
    const generation=this.generation,C=this.C;
    try {
      const model=await this.loadModel(C,this.asset,`twinning-gps-aircraft-${id}`,C.Matrix4.IDENTITY);
      if(generation!==this.generation||!this.widget){if(!model.isDestroyed?.())model.destroy();return;}
      const line=this.trackCollection?.add({positions:[],width:2,
        material:C.Material.fromType('Color',{color:C.Color.ORANGE.withAlpha(.75)})});
      this.widget.scene.primitives.add(model);
      const twin={model,line,gpsState:null};
      this.others.set(id,twin);
      this.scaleTwin(twin);
      const device=(this.snapshot?.devices||[]).find(d=>d?.device_id===id);
      if(device){twin.gpsState=nextGpsRenderState(null,device);this.drawTwin(twin,device);}
      this.widget.scene.requestRender();
    }catch{ /* One sender failing to draw must not disturb the others. */ }
    finally{this.loading.delete(id);}
  }
  scaleTwin(twin) {
    if(!Number.isFinite(this.sourceRadius)||this.sourceRadius<=0)return;
    const scale=this.toySize===null?this.sourceScale:this.sourceScale*this.toySize/(2*this.sourceRadius);
    twin.model.maximumScale=scale;twin.model.scale=scale;twin.model.minimumPixelSize=0;
  }
  drawTwin(twin,device) {
    const C=this.C,state=twin.gpsState,position=state?.position;
    twin.model.show=Boolean(position);
    if(!position){if(twin.line)twin.line.positions=[];return;}
    const origin=C.Cartesian3.fromDegrees(position.longitude,position.latitude,position.height+(this.clearance||0));
    const rotation=C.Matrix3.fromArray(modelToEnuRotation(device?.quaternion_wxyz,this.mountDegrees));
    twin.model.modelMatrix=C.Matrix4.multiply(C.Transforms.eastNorthUpToFixedFrame(origin),
      C.Matrix4.fromRotationTranslation(rotation),new C.Matrix4());
    if(twin.line)twin.line.positions=state.track.map(p=>C.Cartesian3.fromDegrees(p.longitude,p.latitude,p.height+.1));
  }
  dropTwin(twin) {
    if(twin.line&&this.trackCollection?.remove)this.trackCollection.remove(twin.line);
    if(twin.model){this.widget?.scene?.primitives?.remove?.(twin.model);if(!twin.model.isDestroyed?.())twin.model.destroy?.();}
  }
  applyPose() {
    if(!this.model||!this.ready)return;
    const C=this.C,state=this.gpsState,position=state?.position||DEFAULT_TEST_POSITION;
    this.model.show=!!position;
    if(!state?.position&&this.trackLine)this.trackLine.positions=[];
    const origin=C.Cartesian3.fromDegrees(position.longitude,position.latitude,position.height+this.clearance);
    const rotation=C.Matrix3.fromArray(modelToEnuRotation(this.snapshot?.quaternion_wxyz,this.mountDegrees));
    this.model.modelMatrix=C.Matrix4.multiply(C.Transforms.eastNorthUpToFixedFrame(origin),C.Matrix4.fromRotationTranslation(rotation),new C.Matrix4());
    const previousCenter=this.center,first=!previousCenter,fresh=this.newFix;this.center=origin;
    if(fresh&&state?.position){this.trackLine.positions=state.track.map(p=>C.Cartesian3.fromDegrees(p.longitude,p.latitude,p.height+.1));this.newFix=false;}
    if(first)this.recenter();
    else if(fresh&&this.view==='locked')this.recenter();
    else if(fresh&&this.view!=='free')this.followPosition(previousCenter);
    this.widget.scene.requestRender();
  }
  followPosition(previousCenter) {
    const C=this.C,camera=this.widget.scene.camera;
    // Transport the user's current local camera offset, including wheel zoom
    // and orbit direction, instead of resetting a fixed HeadingPitchRange.
    const inverse=C.Matrix4.inverseTransformation(C.Transforms.eastNorthUpToFixedFrame(previousCenter),new C.Matrix4());
    const offset=C.Matrix4.multiplyByPoint(inverse,camera.positionWC,new C.Cartesian3());
    camera.lookAt(this.center,offset);camera.lookAtTransform(C.Matrix4.IDENTITY);
  }
  recenter() {
    if(!this.center||!this.widget)return;
    const C=this.C,camera=this.widget.scene.camera;
    camera.lookAt(this.center,new C.HeadingPitchRange(.6,this.view==='top'?-Math.PI/2:-.5,this.range||50));
    camera.lookAtTransform(C.Matrix4.IDENTITY);this.widget.scene.requestRender();
  }
  setToySize(metres) {
    if(metres!==null&&(!Number.isFinite(metres)||metres<.05||metres>2))throw new RangeError('toy size must be 0.05–2 m');
    this.toySize=metres;
    if(!this.model||!Number.isFinite(this.sourceRadius)||this.sourceRadius<=0)return;
    const scale=metres===null?this.sourceScale:this.sourceScale*metres/(2*this.sourceRadius);
    this.model.maximumScale=scale;this.model.scale=scale;this.model.minimumPixelSize=0;
    this.clearance=metres===null?Math.max(.15,Math.min(3,this.sourceRadius*.12)):metres*.06;
    this.range=metres===null?Math.max(25,this.sourceRadius*6):metres*3;
    for(const twin of this.others.values())this.scaleTwin(twin);
    this.applyPose();this.recenter();
  }
  setView(view) {
    if(!['locked','follow','free','top'].includes(view))return;
    this.view=view;
    const controller=this.widget?.scene?.screenSpaceCameraController;
    if(controller)controller.enableInputs=view!=='locked';
    if(view!=='free')this.recenter();
  }
  close() {
    this.generation++;clearTimeout(this.readyTimer);for(const cleanup of this.cleanups.splice(0))cleanup?.();
    for(const twin of this.others.values())this.dropTwin(twin);
    this.others.clear();this.loading.clear();this.asset=null;
    releaseWidgetContext(this.widget);this.widget=null;this.model=null;this.ready=false;this.assetId=null;
    this.sourceRadius=null;this.sourceScale=null;this.gpsState=null;this.snapshot=null;this.center=null;this.trackLine=null;this.trackCollection=null;
  }
}
