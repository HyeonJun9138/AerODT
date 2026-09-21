// Distance is independent of detail. A city overview must not disappear just
// because the operator chose a small texture budget.
import {hybridUniformValues,hybridShaderUniforms,HYBRID_MASK_GLSL} from './hybrid_buildings.js';
export const BUILDING_PROFILES={compact:{error:16,cache:96,cells:32},balanced:{error:10,cache:192,cells:48},wide:{error:8,cache:256,cells:64}};
export const BUILDING_DISTANCES={near:8000,city:20000,metro:40000};
export const BUILDING_NEAR_HEIGHT=100000,BUILDING_FAR_HEIGHT=120000;
export const BUILDING_COLOURS=[[150,'#b7c0c9'],[80,'#a5b1bd'],[30,'#929fac'],[0,'#81909f']];
export const DEFAULT_OPACITY=.9;
export function profileFor(name){return BUILDING_PROFILES[name]??BUILDING_PROFILES.balanced;}
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
export function buildingRange(distance='auto',height=0){
  return BUILDING_DISTANCES[distance]??clamp(8000+Math.max(0,Number.isFinite(height)?height:0)*1.6,8000,40000);
}
export function buildingAltitudeFade(height){
  const t=clamp((height-70000)/50000,0,1);return 1-t*t*(3-2*t);
}
// A bounded ground focus, NOT the centre of computeViewRectangle (which can
// extend hundreds of kilometres toward the horizon). The centre/lower-screen
// ground hits are preferred; heading/pitch is a deterministic fallback while
// terrain or canvas sizes are not ready. Never pick building rooftops.
export function buildingGroundFocus({longitude,latitude,height=0,pitch=-Math.PI/2,heading=0,focusFraction=.8},range,sample=null){
  const cos=Math.max(.2,Math.cos(latitude*Math.PI/180));
  let east=0,north=0;
  if(sample&&Number.isFinite(sample.longitude)&&Number.isFinite(sample.latitude)){
    east=(sample.longitude-longitude)*111320*cos;north=(sample.latitude-latitude)*111320;
  }else if(pitch<0){
    const forward=Math.max(0,height)/Math.max(.035,Math.tan(-pitch));
    east=Math.sin(heading)*forward;north=Math.cos(heading)*forward;
  }
  // Keep the foreground inside the same region as the distant visual focus.
  const scale=Math.min(1,range*focusFraction/Math.max(1,Math.hypot(east,north)));
  east*=scale;north*=scale;
  return {longitude:longitude+east/(111320*cos),latitude:latitude+north/111320,
    cameraLongitude:longitude,cameraLatitude:latitude,range,height,offset:Math.hypot(east,north)};
}
export function buildingTileOptions(C){return {
  show:false,maximumScreenSpaceError:10,cacheBytes:192*1024*1024,maximumCacheOverflowBytes:64*1024*1024,
  preloadWhenHidden:false,preloadFlightDestinations:false,cullRequestsWhileMoving:false,
  skipLevelOfDetail:false,loadSiblings:false,dynamicScreenSpaceError:true,
  dynamicScreenSpaceErrorDensity:.0002,dynamicScreenSpaceErrorFactor:32,
  foveatedScreenSpaceError:true,foveatedConeSize:.35,foveatedTimeDelay:.15,
  progressiveResolutionHeightFraction:.3,shadows:C.ShadowMode.DISABLED,
  enableCollision:false,enablePick:false,showCreditsOnScreen:true};}

// Stable ordered coverage avoids an extra translucent city pass and sorting.
// No time/random term; FXAA softens the screen-door pattern without shimmer.
export const COVERAGE_GLSL=`
float buildingThreshold() {
    vec2 p = mod(floor(gl_FragCoord.xy), 4.0);
    float a = mod(p.x, 2.0), b = mod(p.y, 2.0);
    float c = floor(p.x / 2.0), d = floor(p.y / 2.0);
    return (8.0 * abs(a-b) + 4.0 * b + 2.0 * abs(c-d) + d + 0.5) / 16.0;
}`;
export function cameraBuildingView(C,viewer,{distance='auto',height=viewer.camera.positionCartographic?.height??0,environment=null}={}){
  const camera=viewer.camera,p=camera.positionCartographic;
  if(!p||!Number.isFinite(p.longitude)||!Number.isFinite(p.latitude))return null;
  const volume=camera.frustum.computeCullingVolume(camera.positionWC,camera.directionWC,camera.upWC);
  const range=Math.min(buildingRange(distance,height),environment?.range??Infinity),canvas=viewer.canvas??viewer.scene?.canvas;
  let sample=null;
  if(canvas?.clientWidth>0&&canvas?.clientHeight>0&&camera.getPickRay&&C.Cartesian2){
    for(const y of [.5,.7,.9]){
      const pixel=new C.Cartesian2(canvas.clientWidth*.5,canvas.clientHeight*y),ray=camera.getPickRay(pixel);
      const hit=(ray&&viewer.scene.globe.pick(ray,viewer.scene))??camera.pickEllipsoid?.(pixel,C.Ellipsoid.WGS84);
      if(!hit)continue;
      const ground=C.Cartographic.fromCartesian(hit);
      if(ground){sample={longitude:C.Math.toDegrees(ground.longitude),latitude:C.Math.toDegrees(ground.latitude)};break;}
    }
  }
  const focus=buildingGroundFocus({longitude:C.Math.toDegrees(p.longitude),latitude:C.Math.toDegrees(p.latitude),height,
    pitch:camera.pitch,heading:camera.heading,focusFraction:environment?.focusFraction??.8},range,sample);
  return {...focus,hazeStrength:environment?.hazeStrength??.58,accepts:({column,row})=>{
    // Full cell sphere including towers, not a point on the ground.
    const centre=C.Cartesian3.fromDegrees((column+.5)*.01,(row+.5)*.01,300);
    return volume.computeVisibility(new C.BoundingSphere(centre,1050))!==C.Intersect.OUTSIDE;
  }};
}
export class BuildingViewCache{
  constructor(C){this.C=C;this.scans=0;}
  read(viewer,options,now){
    const c=viewer.camera,p=c.positionCartographic,f=c.frustum,canvas=viewer.canvas??viewer.scene.canvas;
    const stamp=[p?.longitude,p?.latitude,options.height,c.heading,c.pitch,c.roll,canvas?.clientWidth,canvas?.clientHeight,
      f.fov,f.aspectRatio,f.left,f.right,f.top,f.bottom,options.distance,options.environment?.range,options.environment?.hazeStrength,viewer.terrainProvider];
    const pending=!viewer.scene.globe.tilesLoaded;
    // Refresh while terrain streams, and once when it settles, even if the
    // camera is stationary. Moving or resizing invalidates immediately.
    const same=this.stamp&&stamp.every((v,i)=>v===this.stamp[i]);
    if(same&&this.pending===pending&&now-this.at<(pending?500:5000))return this.view;
    this.stamp=stamp;this.pending=pending;this.at=now;this.scans++;
    return this.view=cameraBuildingView(this.C,viewer,options);
  }
}
export class BuildingTileFocus{
  constructor(C,tileset,{textured=false}={}){
    Object.assign(this,{C,tileset,textured});this.quality='balanced';this.opacity=DEFAULT_OPACITY;this.distance='auto';
    this.extraError=0;this.slowSince=null;this.fastSince=null;this.hybridValues=hybridUniformValues(C);
    this.planes=new C.ClippingPlaneCollection({unionClippingRegions:true,edgeWidth:0,
      // An octagon follows circular haze closely, culling the square's distant
      // corners during tile traversal instead of only in the fragment shader.
      planes:[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],
        ...[[1,1],[-1,1],[1,-1],[-1,-1]].map(([x,y])=>[x*Math.SQRT1_2,y*Math.SQRT1_2,0])]
        .map(n=>new C.ClippingPlane(new C.Cartesian3(...n),8000))});
    tileset.clippingPlanes=this.planes;
    this.createShader();
  }
  createShader(){
    const C=this.C,solid=this.opacity>=1||(this.textured&&this.opacity>=.9);
    if(this.shader&&this.solid===solid)return;
    const previous=this.shader;this.solid=solid;
    this.shader=new C.CustomShader({translucencyMode:solid?C.CustomShaderTranslucencyMode?.INHERIT:C.CustomShaderTranslucencyMode?.TRANSLUCENT,
      uniforms:{u_buildingOpacity:{type:C.UniformType.FLOAT,value:this.opacity},u_buildingRange:{type:C.UniformType.FLOAT,value:8000},
        u_buildingFocus:{type:C.UniformType.VEC3,value:new C.Cartesian3()},u_buildingEyeGround:{type:C.UniformType.VEC3,value:new C.Cartesian3()},
        u_buildingHazeDistance:{type:C.UniformType.FLOAT,value:8000},u_buildingHazeStrength:{type:C.UniformType.FLOAT,value:.58},u_buildingAltitudeFade:{type:C.UniformType.FLOAT,value:1},
        ...hybridShaderUniforms(C,this.hybridValues)},
      fragmentShaderText:`${COVERAGE_GLSL}\n${HYBRID_MASK_GLSL}
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
    ${this.textured?'':'material.diffuse = vec3(0.32, 0.40, 0.48);'}
    // Ground-space distance: climbing the camera no longer makes every
    // building transparent. The soft circular edge lies inside the clip box.
    float distanceToFocus = length(fsInput.attributes.positionWC - u_buildingFocus);
    float distanceToGround = length(fsInput.attributes.positionWC - u_buildingEyeGround);
    float haze = smoothstep(u_buildingHazeDistance * 0.2, u_buildingHazeDistance, distanceToGround);
    bool hybrid = u_hybridControl.x > 0.5;
    if (hybrid && hybridPhotoCoverage(fsInput.attributes.positionWC) < buildingThreshold()) discard;
    float coverage = u_buildingOpacity * u_buildingAltitudeFade * (hybrid ? 1.0 : (1.0 - smoothstep(u_buildingRange * 0.72, u_buildingRange * 0.98, distanceToFocus)));
    ${solid?'if (coverage < buildingThreshold()) discard;':'material.alpha *= coverage;'}
    material.diffuse = mix(material.diffuse, vec3(0.50, 0.58, 0.63), haze * u_buildingHazeStrength);
}`});this.tileset.customShader=this.shader;previous?.destroy();
  }
  setHybridMask(values){
    this.hybridValues=values??hybridUniformValues(this.C);
    // Constructor binding retains the shared mutable vector objects. Rebind
    // only when a coordinator attaches/detaches, never on camera movement.
    this.solid=undefined;this.createShader();
  }
  setAppearance({quality=this.quality,opacity=this.opacity,distance=this.distance}={}){
    const previousQuality=this.quality,previousDistance=this.distance;
    this.quality=BUILDING_PROFILES[quality]?quality:'balanced';
    this.distance=distance;
    this.opacity=Number.isFinite(opacity)?Math.max(.35,Math.min(1,opacity)):DEFAULT_OPACITY;
    const p=profileFor(this.quality);
    this.createShader();
    if(this.tileset.cacheBytes!==p.cache*1024*1024)this.tileset.cacheBytes=p.cache*1024*1024;
    // An explicit quality change gets one fresh LOD decision. Repeated saved
    // settings/status updates do not reset Cesium's adaptive memory floor.
    if(previousQuality!==this.quality||previousDistance!==this.distance){this.extraError=0;this.lodAnchor=null;this.tileset.maximumScreenSpaceError=p.error;}
    this.shader.setUniform('u_buildingOpacity',this.solid?1:this.textured?Math.min(1,this.opacity+.08):this.opacity);
    if(this.lastCamera)this.update(this.lastCamera,this.lastOptions);
  }
  update(camera,{height=camera.positionCartographic?.height??0,frameMs=0,now=performance.now(),view=null,moving=false,targetFps=60,rangeOverride=this.rangeOverride}={}){
    const C=this.C,p=camera.positionCartographic;if(!p)return;
    targetFps=Number.isFinite(targetFps)?Math.max(30,Math.min(60,targetFps)):60;
    if(this.targetFps!==targetFps){this.targetFps=targetFps;this.slowSince=null;this.fastSince=null;}
    this.lastCamera=camera;this.lastOptions={height,frameMs,now,view,moving,targetFps};
    const outerRange=Math.min(buildingRange(this.distance,height),view?.range??Infinity),range=Number.isFinite(rangeOverride)?Math.min(outerRange,clamp(rangeOverride,500,4000)):outerRange;
    const focus=view&&(view.range===range||Number.isFinite(rangeOverride))?view:buildingGroundFocus({longitude:C.Math.toDegrees(p.longitude),latitude:C.Math.toDegrees(p.latitude),
      height,pitch:camera.pitch,heading:camera.heading},range);
    this.view=focus;
    const origin=C.Cartesian3.fromDegrees(focus.longitude,focus.latitude,0),local=C.Transforms.eastNorthUpToFixedFrame(origin);
    const inverse=C.Matrix4.inverse(this.tileset.clippingPlanesOriginMatrix,new C.Matrix4());
    this.planes.modelMatrix=C.Matrix4.multiply(inverse,local,this.planes.modelMatrix);
    for(let i=0;i<this.planes.length;i++)this.planes.get(i).distance=range;
    this.shader.setUniform('u_buildingRange',range);this.shader.setUniform('u_buildingFocus',origin);
    this.shader.setUniform('u_buildingEyeGround',C.Cartesian3.fromRadians(p.longitude,p.latitude,0));
    this.shader.setUniform('u_buildingHazeDistance',outerRange+(focus.offset??0));
    this.shader.setUniform('u_buildingHazeStrength',view?.hazeStrength??.58);
    this.shader.setUniform('u_buildingAltitudeFade',buildingAltitudeFade(height));
    // Sustained load only, not a single shader compile. Recover more slowly.
    // Multi-hundred-ms frame gaps are not a reliable LOD signal (idle/browser
    // scheduling and unrelated work also cause them). Cache pressure remains
    // Cesium's responsibility; never erase detail indefinitely on those gaps.
    // An intentional 30 FPS cap is a healthy 33 ms frame, not persistent GPU
    // pressure. Judge recovery against the chosen cadence while retaining the
    // original 60 FPS tolerances and ignoring long browser scheduling gaps.
    const slowFrame=Math.max(35,1000/targetFps*1.5),fastFrame=Math.max(23,1000/targetFps*1.1);
    if(frameMs>slowFrame&&frameMs<250){this.fastSince=null;this.slowSince??=now;if(now-this.slowSince>2000){this.extraError=Math.min(14,this.extraError+2);this.slowSince=now;}}
    else if(frameMs>0&&frameMs<fastFrame){this.slowSince=null;this.fastSince??=now;if(now-this.fastSince>6000){this.extraError=Math.max(0,this.extraError-2);this.fastSince=now;}}
    else{this.fastSince=null;this.slowSince=null;}
    // Keep the city extent and resident textures; only temporarily request
    // coarser detail while navigating. Existing distance haze stays continuous.
    const error=profileFor(this.quality).error+this.extraError+Math.min(12,Math.floor(height/6000)*2)+(moving?6:0);
    // The Cesium setter RESETS memoryAdjustedScreenSpaceError even when the
    // value is identical. Setting it every pass defeats the memory budget and
    // endlessly evicts/re-downloads textures. Let its internal floor survive.
    const memoryFloor=this.tileset.memoryAdjustedScreenSpaceError;
    const anchor=this.lodAnchor;
    const moved=anchor?Math.hypot((focus.longitude-anchor.longitude)*Math.cos(focus.latitude*Math.PI/180),focus.latitude-anchor.latitude)*111320:0;
    const zoomed=anchor&&(height>Math.max(100,anchor.height)*1.8||height<anchor.height*.55);
    const changedView=anchor&&now-anchor.at>=3000&&(zoomed||moved>Math.max(4000,range*.6));
    // A huge memory floor from a previous city overview must not keep the
    // next close-up permanently coarse. Re-evaluate ONCE per substantial zoom
    // or relocation, never on a stationary frame or small orbit jitter.
    if(changedView&&Number.isFinite(memoryFloor)&&memoryFloor>error*2)this.tileset.maximumScreenSpaceError=error;
    else if(this.tileset.maximumScreenSpaceError!==error&&(!Number.isFinite(memoryFloor)||memoryFloor<=Math.max(error,this.tileset.maximumScreenSpaceError??0)))this.tileset.maximumScreenSpaceError=error;
    if(!anchor||changedView)this.lodAnchor={height,longitude:focus.longitude,latitude:focus.latitude,at:now};
  }
  destroy(){if(!this.shader.isDestroyed())this.shader.destroy();}
}
export async function loadVWorldBuildings(C){
  const url='/api/visualization/vworld/3d/vworld_3d_facility.json?v=5';
  const response=await fetch(url,{signal:AbortSignal.timeout(20000)});
  if(!response.ok){const error=new Error('3D building provider unavailable');error.disabled=response.status===404;throw error;}
  await response.json();
  return C.Cesium3DTileset.fromUrl(new C.Resource({url,credits:[new C.Credit('국토교통부 · V-World (브이월드)',true)]}),buildingTileOptions(C));
}
