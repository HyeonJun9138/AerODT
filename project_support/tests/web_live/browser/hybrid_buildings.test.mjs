import test from 'node:test';
import assert from 'node:assert/strict';
import {HybridBuildingCoordinator,HYBRID_REGION_LIMIT,HYBRID_MASK_GLSL,validCoverageRegion,hybridDistance} from '../../../../digital_twin/visualization/web/hybrid_buildings.js';
import {BuildingTileFocus} from '../../../../digital_twin/visualization/web/building_streaming.js';
import {VWorldBuildingLayer} from '../../../../digital_twin/visualization/web/vworld_building_layer.js';
class Event{
  listeners=new Set();
  addEventListener(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
  raiseEvent(...args){for(const fn of this.listeners)fn(...args);}
}
const radians=value=>value*Math.PI/180;
function cesium(){
  class Cartesian3{
    constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}
    static fromRadians(lon,lat,height=0,ellipsoid,result=new Cartesian3()){
      const radius=6378137+height;Object.assign(result,{x:radius*Math.cos(lat)*Math.cos(lon),y:radius*Math.cos(lat)*Math.sin(lon),z:radius*Math.sin(lat)});return result;
    }
    static fromDegrees(lon,lat,height){return this.fromRadians(radians(lon),radians(lat),height);}
  }
  return {Cartesian3,Cartesian4:class{constructor(x=0,y=0,z=0,w=0){Object.assign(this,{x,y,z,w});}},
    Math:{toDegrees:value=>value*180/Math.PI},UniformType:{FLOAT:0,VEC3:1,VEC4:2},
    Matrix4:class{static inverse(value,out){return Object.assign(out,{inverseOf:value});}static multiply(a,b,out){return Object.assign(out,{a,b});}},
    Transforms:{eastNorthUpToFixedFrame:origin=>({origin})},
    ClippingPlane:class{constructor(normal,distance){Object.assign(this,{normal,distance});}},
    ClippingPlaneCollection:class{constructor(options){Object.assign(this,options);this.modelMatrix={};}get length(){return this.planes.length;}get(i){return this.planes[i];}},
    CustomShader:class{constructor(options){Object.assign(this,options);}setUniform(key,value){this.uniforms[key].value=value;}destroy(){this.dead=true;}isDestroyed(){return !!this.dead;}},
    PerInstanceColorAppearance:class{constructor(options){Object.assign(this,options);}},CustomShaderTranslucencyMode:{INHERIT:0,TRANSLUCENT:1}};
}
function harness(){
  const C=cesium(),scene={preRender:new Event(),primitives:{},requestRender(){}},footprints=new VWorldBuildingLayer({C,scene});
  const tileset={tileVisible:new Event(),show:true,clippingPolygons:{preserve:'vertiports'}},focus=new BuildingTileFocus(C,tileset,{textured:true});
  const coordinator=new HybridBuildingCoordinator({C,scene,footprints});coordinator.attach(focus);
  coordinator.update({view:{longitude:126.98,latitude:37.56,range:20000,offset:800},distance:1500});coordinator.setEnabled(true);
  return {C,scene,footprints,tileset,focus,coordinator};
}
function tile(lon=126.98,lat=37.56,size=.001){return {content:{geometryByteLength:5000},
  extras:{aerodtCoverageRegion:[radians(lon-size),radians(lat-size),radians(lon+size),radians(lat+size),0,100]}};}
// CPU oracle for the shared shader ownership rule, evaluated in the same ENU
// rectangle plane. This checks observable handoff without mocking a tile as
// loaded merely because its container tileset finished requesting.
function ownership(coordinator,x,y,threshold=.5){
  const values=coordinator.values,c=values.u_hybridControl;let amount=0;
  if(c.x>.5){
    const distance=Math.hypot(x,y),t=Math.max(0,Math.min(1,(distance-c.z*.8)/(c.z*.2))),fade=1-t*t*(3-2*t);
    for(let i=0;i<c.y;i++){const r=values[`u_hybridRegion${i}`];if(x>=r.x&&y>=r.y&&x<=r.z&&y<=r.w){amount=fade;break;}}
  }
  return {photo:c.x>.5&&amount>=threshold,plain:c.x<.5||amount<threshold};
}
test('only actual visible bounded binary geometry removes fallback, in the same frame',()=>{
  const {coordinator,tileset,scene,focus,footprints}=harness(),visible=tile();
  scene.preRender.raiseEvent();assert.deepEqual(ownership(coordinator,0,0),{photo:false,plain:true});
  tileset.tilesLoaded=true;assert.equal(coordinator.stats.visibleRegions,0,'container readiness is not coverage');
  tileset.tileVisible.raiseEvent({content:{geometryByteLength:0},extras:visible.extras});
  tileset.tileVisible.raiseEvent({content:{geometryByteLength:10000}});
  tileset.tileVisible.raiseEvent(tile(126.98,37.56,.1));
  assert.equal(coordinator.stats.visibleRegions,0);assert.equal(coordinator.stats.rejectedRegions,3);
  tileset.tileVisible.raiseEvent(visible);assert.equal(coordinator.stats.visibleRegions,1);
  assert.deepEqual(ownership(coordinator,0,0),{photo:true,plain:false});
  assert.equal(focus.shader.uniforms.u_hybridControl.value,coordinator.values.u_hybridControl);
  assert.equal(footprints.uniforms.u_hybridControl,coordinator.values.u_hybridControl,'both draw passes read the very same current-frame vector');
  tileset.tileVisible.raiseEvent(visible);assert.equal(coordinator.stats.visibleRegions,1,'duplicate traversal reports do not consume slots');
  scene.preRender.raiseEvent();assert.deepEqual(ownership(coordinator,0,0),{photo:false,plain:true},'unloaded/offscreen tiles restore fallback immediately');
});
test('distance clipping limits real tile requests while ordinary haze and vertiport clipping survive',()=>{
  const {coordinator,focus,tileset,C}=harness(),polygons=tileset.clippingPolygons;
  const camera={positionCartographic:{longitude:radians(126.97),latitude:radians(37.55),height:500},pitch:-.5,heading:0};
  focus.setAppearance({distance:'city'});focus.update(camera,{view:coordinator.view});
  assert.equal(focus.planes.get(0).distance,1500);assert.equal(focus.shader.uniforms.u_buildingRange.value,1500);
  assert.equal(focus.shader.uniforms.u_buildingHazeDistance.value,20800);
  assert.deepEqual(focus.shader.uniforms.u_buildingFocus.value,C.Cartesian3.fromDegrees(126.98,37.56,0));
  const shader=focus.shader;coordinator.update({view:coordinator.view,distance:3000});focus.update(camera,{view:coordinator.view});
  assert.equal(focus.planes.get(0).distance,3000);assert.equal(focus.shader,shader,'moving distance changes uniforms, not programs');
  assert.equal(tileset.clippingPolygons,polygons);
  coordinator.setEnabled(false);focus.update(camera,{view:coordinator.view});assert.equal(focus.planes.get(0).distance,20000);
});
test('near feather is complementary, horizontal, and distant/uncovered plain buildings remain',()=>{
  const {coordinator,tileset,scene}=harness();scene.preRender.raiseEvent();
  // Valid tile region spans the entire transition band on the east side.
  tileset.tileVisible.raiseEvent(tile(126.995,37.56,.01));
  for(let x=0;x<=2000;x+=37)for(let sample=0;sample<16;sample++){
    const ownershipAt=ownership(coordinator,x,0,(sample+.5)/16);
    assert.notEqual(ownershipAt.photo,ownershipAt.plain,'exactly one representation owns each sample');
  }
  assert.equal(ownership(coordinator,1900,0).plain,true);assert.equal(ownership(coordinator,-1200,0).plain,true);
  assert.match(HYBRID_MASK_GLSL,/dot\(delta, u_hybridEast\)/);assert.match(HYBRID_MASK_GLSL,/dot\(delta, u_hybridNorth\)/);
  assert.ok(HYBRID_MASK_GLSL.indexOf('amount <= 0.0')<HYBRID_MASK_GLSL.indexOf('hybridInRegion(p,'),'distant fragments never scan region slots');
  assert.match(HYBRID_MASK_GLSL,/u_hybridControl.y < 1.5\) return 0.0/,'scan ends after the actual count');
});
test('camera teleports invalidate coverage and selection is bounded without stale masks',()=>{
  const {coordinator,scene,tileset}=harness();scene.preRender.raiseEvent();
  for(let i=0;i<HYBRID_REGION_LIMIT+20;i++)tileset.tileVisible.raiseEvent(tile());
  assert.equal(coordinator.stats.visibleRegions,HYBRID_REGION_LIMIT);assert.equal(coordinator.stats.overflowRegions,20);
  const vector=coordinator.values.u_hybridRegion0;
  coordinator.update({view:{longitude:127.1,latitude:37.6,range:20000},distance:1000});scene.preRender.raiseEvent();
  tileset.tileVisible.raiseEvent(tile());assert.equal(coordinator.stats.visibleRegions,0,'old region lies outside the newly clipped near view');
  tileset.tileVisible.raiseEvent(tile(127.1,37.6));assert.equal(coordinator.stats.visibleRegions,1);assert.equal(coordinator.values.u_hybridRegion0,vector);
  assert.deepEqual(ownership(coordinator,0,0),{photo:true,plain:false});
});
test('disable, hidden tileset and destroy always restore plain fallback and release listeners',()=>{
  const {coordinator,scene,tileset,focus,footprints}=harness();scene.preRender.raiseEvent();tileset.tileVisible.raiseEvent(tile());
  coordinator.setEnabled(false);assert.equal(ownership(coordinator,0,0).plain,true);assert.equal(focus.rangeOverride,null);
  coordinator.setEnabled(true);tileset.show=false;scene.preRender.raiseEvent();tileset.tileVisible.raiseEvent(tile());assert.equal(coordinator.stats.visibleRegions,0);
  coordinator.destroy();assert.equal(tileset.tileVisible.listeners.size,0);assert.equal(scene.preRender.listeners.size,0);
  assert.equal(footprints.uniforms.u_hybridControl.x,0);assert.equal(focus.shader.uniforms.u_hybridControl.value.x,0);
});
test('mask metadata and user distances reject invalid or overly broad coverage',()=>{
  assert.equal(validCoverageRegion(tile().extras.aerodtCoverageRegion),true);
  for(const region of [undefined,[],[1,2,3,4],[0,0,NaN,.1],[0,0,1,1],[.1,0,0,.1]])assert.equal(validCoverageRegion(region),false);
  assert.equal(hybridDistance(NaN),1500);assert.equal(hybridDistance(Infinity),1500);assert.equal(hybridDistance(100),500);assert.equal(hybridDistance(9000),4000);
});
