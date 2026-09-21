import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BuildingTileFocus,BuildingViewCache,BUILDING_PROFILES,buildingTileOptions,cameraBuildingView,COVERAGE_GLSL,loadVWorldBuildings,buildingRange,buildingGroundFocus,buildingAltitudeFade,BUILDING_NEAR_HEIGHT,BUILDING_FAR_HEIGHT} from '../../../../digital_twin/visualization/web/building_streaming.js';
import {BuildingLayer} from '../../../../digital_twin/visualization/web/building_layer.js';

function cesium(){
  return {Cartesian3:class{constructor(x,y,z){Object.assign(this,{x,y,z});}static fromRadians(x,y,z){return {x,y,z};}static fromDegrees(x,y,z){return {x,y,z};}},
    Matrix4:class{static inverse(value,result){return Object.assign(result,{inverseOf:value});}static multiply(a,b,result){return Object.assign(result,{a,b});}},
    Transforms:{eastNorthUpToFixedFrame:origin=>({origin})},
    ClippingPlane:class{constructor(normal,distance){Object.assign(this,{normal,distance});}},
    ClippingPlaneCollection:class{constructor(options){Object.assign(this,options);this.modelMatrix={};}get length(){return this.planes.length;}get(i){return this.planes[i];}},
    CustomShader:class{constructor(options){Object.assign(this,options);}setUniform(key,value){this.uniforms[key].value=value;}isDestroyed(){return !!this.dead;}destroy(){this.dead=true;}},
    UniformType:{FLOAT:1},CustomShaderTranslucencyMode:{INHERIT:0,TRANSLUCENT:2},ShadowMode:{DISABLED:0},Math:{toDegrees:r=>r*180/Math.PI},
    BoundingSphere:class{constructor(centre,radius){Object.assign(this,{centre,radius});}},Intersect:{OUTSIDE:-1}};
}

test('a camera environment bounds native clipping and haze together, including hybrid mode',()=>{
 const C=cesium(),tiles={},focus=new BuildingTileFocus(C,tiles,{textured:true});
 focus.setAppearance({distance:'metro'});
 const camera={positionCartographic:{longitude:2.2,latitude:.65,height:350}};
 const view={longitude:126,latitude:37,height:350,range:1800,offset:200,hazeStrength:.92};
 focus.update(camera,{view});
 assert.ok(tiles.clippingPlanes.planes.every(p=>p.distance===1800));
 assert.equal(focus.shader.uniforms.u_buildingHazeDistance.value,2000);
 assert.equal(focus.shader.uniforms.u_buildingHazeStrength.value,.92);
 focus.rangeOverride=3500;focus.update(camera,{view});
 assert.ok(tiles.clippingPlanes.planes.every(p=>p.distance===1800),'hybrid maximum cannot widen the near view');
});
test('streaming limits cache, preserves parent LOD coverage and continues a moving-camera pursuit',()=>{
 const options=buildingTileOptions(cesium());
 assert.equal(options.skipLevelOfDetail,false);assert.equal(options.cullRequestsWhileMoving,false);
 assert.equal(options.loadSiblings,false);assert.equal(options.preloadFlightDestinations,false);
 assert.equal(options.enablePick,false);assert.ok(options.dynamicScreenSpaceErrorFactor>=32);
 assert.equal(options.cacheBytes,192*1024*1024);assert.equal(options.maximumCacheOverflowBytes,64*1024*1024);
});
test('camera-local clipping uses the root transform inverse, not the distant tileset centre',()=>{
 const C=cesium(),tiles={show:true,clippingPlanesOriginMatrix:'actual-root-transform'};
 const focus=new BuildingTileFocus(C,tiles,{textured:true});
 focus.setAppearance({quality:'compact',opacity:.75});
 const camera={positionCartographic:{longitude:2.21,latitude:.65}};
 focus.update(camera,{now:0});
 assert.equal(tiles.clippingPlanes.unionClippingRegions,true,'outside any plane is culled');
 assert.equal(tiles.clippingPlanes.length,8);
 assert.ok(tiles.clippingPlanes.planes.every(p=>p.distance===8000));
 assert.equal(tiles.clippingPlanes.modelMatrix.a.inverseOf,'actual-root-transform');
 assert.deepEqual(tiles.clippingPlanes.modelMatrix.b.origin,{x:C.Math.toDegrees(2.21),y:C.Math.toDegrees(.65),z:0});
 assert.equal(tiles.customShader.uniforms.u_buildingOpacity.value,.83);
 assert.equal(tiles.cacheBytes,96*1024*1024);
 camera.positionCartographic.longitude=2.22;focus.update(camera);
 assert.equal(tiles.clippingPlanes.modelMatrix.b.origin.x,C.Math.toDegrees(2.22));
 assert.equal(tiles.style,undefined,'never paint over facade photographs');
 focus.destroy();assert.equal(tiles.customShader.dead,true);
});
test('quality relaxes only under sustained load and recovers slowly without touching textures or geometry',()=>{
 const C=cesium(),tiles={show:true},focus=new BuildingTileFocus(C,tiles),camera={positionCartographic:{longitude:2,latitude:.6}};
 focus.update(camera,{frameMs:60,now:0});focus.update(camera,{frameMs:60,now:1000});assert.equal(tiles.maximumScreenSpaceError,10);
 focus.update(camera,{frameMs:60,now:2100});assert.equal(tiles.maximumScreenSpaceError,12);
 for(let now=4200;now<60000;now+=2100)focus.update(camera,{frameMs:60,now});
 assert.equal(tiles.maximumScreenSpaceError,24,'bounded degradation');
 focus.update(camera,{frameMs:16,now:60000});focus.update(camera,{frameMs:16,now:63000});assert.equal(tiles.maximumScreenSpaceError,24);
 focus.update(camera,{frameMs:16,now:67000});assert.equal(tiles.maximumScreenSpaceError,22);
 assert.equal(BUILDING_PROFILES.wide.cache,256);
});

test('a deliberate 30 FPS cap recovers previous load degradation and retains full building detail',()=>{
 const tiles={},focus=new BuildingTileFocus(cesium(),tiles),camera={positionCartographic:{longitude:2,latitude:.6}};
 focus.update(camera,{frameMs:60,now:0});focus.update(camera,{frameMs:60,now:2100});
 focus.update(camera,{frameMs:60,now:4200});assert.equal(focus.extraError,4);
 const shader=focus.shader;
 for(let now=5000;now<=26000;now+=1000)focus.update(camera,{frameMs:1000/30,targetFps:30,now});
 assert.equal(focus.extraError,0);assert.equal(tiles.maximumScreenSpaceError,10);assert.equal(focus.shader,shader);
 for(let now=27000;now<=36000;now+=1000)focus.update(camera,{frameMs:40,targetFps:30,now});
 assert.equal(focus.extraError,0,'ordinary variation around the capped cadence is not sustained overload');
 for(let now=37000;now<=46000;now+=1000)focus.update(camera,{frameMs:1000,targetFps:30,now});
 assert.equal(focus.extraError,0,'long scheduling gaps remain excluded at a lower cap');
 focus.setAppearance({opacity:.7});assert.equal(focus.lastOptions.targetFps,30,'appearance changes preserve the selected cadence');
});

test('building timing normalizes invalid targets and still responds to actual load at 30 FPS',()=>{
 const make=()=>new BuildingTileFocus(cesium(),{}),camera={positionCartographic:{longitude:2,latitude:.6}};
 const capped=make();capped.update(camera,{frameMs:60,targetFps:30,now:0});
 capped.update(camera,{frameMs:60,targetFps:30,now:2100});assert.equal(capped.extraError,2);
 const invalid=make();invalid.update(camera,{frameMs:40,targetFps:NaN,now:0});
 invalid.update(camera,{frameMs:40,targetFps:Infinity,now:2100});assert.equal(invalid.extraError,2);assert.equal(invalid.lastOptions.targetFps,60);
 const low=make();low.update(camera,{frameMs:40,targetFps:0,now:0});
 low.update(camera,{frameMs:40,targetFps:0,now:2100});assert.equal(low.extraError,0);assert.equal(low.lastOptions.targetFps,30);
 low.update(camera,{targetFps:120,now:3000});assert.equal(low.lastOptions.targetFps,60);
});
test('frustum culling tests a conservative volume including building heights rather than only the base',()=>{
 const C=cesium();let sphere;
 const viewer={camera:{positionCartographic:{longitude:126.978*Math.PI/180,latitude:37.5665*Math.PI/180},
  frustum:{computeCullingVolume:()=>({computeVisibility:s=>{sphere=s;return 0;}})}}};
 const view=cameraBuildingView(C,viewer);
 assert.ok(Math.abs(view.longitude-126.978)<1e-10);assert.ok(view.accepts({column:12697,row:3756}));
 assert.equal(sphere.radius,1050);assert.equal(sphere.centre.z,300);
});
test('coverage thresholds cover each of sixteen samples once and never animate with time',()=>{
 const values=[];
 for(let x=0;x<4;x++)for(let y=0;y<4;y++){const a=x%2,b=y%2,c=Math.floor(x/2),d=Math.floor(y/2);values.push(8*Math.abs(a-b)+4*b+2*Math.abs(c-d)+d);}
 assert.deepEqual(values.sort((a,b)=>a-b),Array.from({length:16},(_,i)=>i));
 assert.doesNotMatch(COVERAGE_GLSL,/time|random|frameNumber/);
});
test('textured loader keeps attribution and same-origin URLs, without applying an OSM colour style',async(t)=>{
 let options,url,credits;
 t.mock.method(globalThis,'fetch',async()=>new Response('{"asset":{"version":"0.0"},"root":{}}'));
 const C={...cesium(),Resource:class{constructor(o){Object.assign(this,o);}},Credit:class{constructor(text,onScreen){Object.assign(this,{text,onScreen});}},
  Cesium3DTileset:{fromUrl:async(resource,o)=>{url=resource.url;credits=resource.credits;options=o;return {};}}};
 await loadVWorldBuildings(C);assert.ok(url.startsWith('/api/visualization/vworld/3d/'));
 assert.match(credits[0].text,/국토교통부.*브이월드/);assert.equal(credits[0].onScreen,true);
 assert.equal(options.style,undefined);
});
test('unchanged SSE never resets Cesium memory-adjusted LOD (no texture cache thrashing)',()=>{
 const C=cesium();let writes=0,value=10;
 const tiles={show:true,get maximumScreenSpaceError(){return value;},set maximumScreenSpaceError(v){writes++;value=v;}};
 const focus=new BuildingTileFocus(C,tiles),camera={positionCartographic:{longitude:2,latitude:.65}};
 for(let now=0;now<2000;now+=200)focus.update(camera,{now,frameMs:16});
 assert.equal(writes,0,'a no-op property write would evict textures forever');
 focus.setAppearance({quality:'compact'});focus.update(camera);assert.equal(writes,1);
});
test('navigation temporarily relaxes building detail, preserves cache pressure and restores on idle',()=>{
 const C=cesium();let value=10,floor=10,writes=0;
 const tiles={get memoryAdjustedScreenSpaceError(){return floor;},get maximumScreenSpaceError(){return value;},
  set maximumScreenSpaceError(v){writes++;value=v;floor=v;}};
 const focus=new BuildingTileFocus(C,tiles),camera={positionCartographic:{longitude:2,latitude:.65}};
 const shader=focus.shader;focus.update(camera,{height:500,now:0,moving:true});assert.equal(value,16);
 const extent=focus.planes.get(0).distance;
 for(let now=200;now<1000;now+=200)focus.update(camera,{height:500,now,moving:true});assert.equal(writes,1);
 focus.update(camera,{height:500,now:1000,moving:false});assert.equal(value,10);assert.equal(writes,2);
 assert.equal(focus.shader,shader);assert.equal(focus.planes.get(0).distance,extent,'range never shrinks during navigation');
 floor=100;focus.update(camera,{height:500,now:1200,moving:true});focus.update(camera,{height:500,now:1400});
 assert.equal(writes,2,'real memory pressure is never reset by a motion toggle');
});
test('settings keep readable native option backgrounds and expose quality and opacity controls',()=>{
 const css=readFileSync(new URL('../../../../user_application/web/styles.css',import.meta.url),'utf8');
 assert.match(css,/select option[^}]*background:#182630;color:#f1f6fa/);
 const app=readFileSync(new URL('../../../../user_application/web/app.js',import.meta.url),'utf8');
 assert.match(app,/id:'building-quality'/);assert.match(app,/id:'building-opacity'/);assert.match(app,/setBuildingAppearance\(values\)/);
 assert.match(app,/id:'building-distance'/);assert.match(app,/append\(buildingDistanceRow.row/);
});

test('memory floor survives adaptive updates; explicit quality changes reset it only once',()=>{
 const C=cesium();let writes=0,value=18;
 const tiles={memoryAdjustedScreenSpaceError:100,get maximumScreenSpaceError(){return value;},set maximumScreenSpaceError(v){writes++;value=v;}};
 const focus=new BuildingTileFocus(C,tiles),camera={positionCartographic:{longitude:2,latitude:.65}};
 focus.update(camera,{frameMs:16,now:0});assert.equal(writes,0);
 focus.setAppearance({quality:'compact'});assert.equal(writes,1);assert.equal(value,16);
 focus.setAppearance({quality:'compact',opacity:.55});focus.update(camera,{now:1000});assert.equal(writes,1);
});

test('near-field opacity uses smooth alpha, with an opaque fast path for sharp facade photos',()=>{
 const C=cesium(),tiles={},plain=new BuildingTileFocus(C,tiles);
 assert.equal(plain.shader.translucencyMode,C.CustomShaderTranslucencyMode.TRANSLUCENT);
 assert.match(plain.shader.fragmentShaderText,/material.alpha \*= coverage/);
 assert.match(plain.shader.fragmentShaderText,/material.diffuse = vec3/);
 plain.setAppearance({opacity:1});assert.equal(plain.shader.translucencyMode,C.CustomShaderTranslucencyMode.INHERIT);
 const photo=new BuildingTileFocus(C,{}, {textured:true});photo.setAppearance({opacity:.9});
 assert.equal(photo.shader.uniforms.u_buildingOpacity.value,1);
 assert.equal(photo.shader.translucencyMode,C.CustomShaderTranslucencyMode.INHERIT);
 assert.doesNotMatch(photo.shader.fragmentShaderText,/material.diffuse = vec3/,'facade photos keep their original colour');
 const old=photo.shader;photo.setAppearance({opacity:.55});assert.equal(old.dead,true);
 assert.equal(photo.shader.translucencyMode,C.CustomShaderTranslucencyMode.TRANSLUCENT);
});

test('automatic distance widens continuously with height, independently of texture detail',()=>{
 assert.equal(buildingRange('auto',0),8000);assert.equal(buildingRange('auto',10000),24000);
 assert.equal(buildingRange('auto',20000),40000);assert.equal(buildingRange('auto',1e7),40000);
 assert.equal(buildingRange('city',0),20000);assert.equal(buildingRange('near',20000),8000);
 assert.equal(buildingRange('metro',0),40000);assert.equal(buildingRange('bad',NaN),8000);
 for(const h of [8000,11000,20000,50000])assert.equal(buildingAltitudeFade(h),1);
 assert.ok(buildingAltitudeFade(95000)>0&&buildingAltitudeFade(95000)<1);
 assert.equal(buildingAltitudeFade(120000),0);
});

test('long scheduling gaps do not repeatedly degrade building detail',()=>{
 const tiles={},focus=new BuildingTileFocus(cesium(),tiles),camera={positionCartographic:{longitude:2,latitude:.65}};
 for(let now=0;now<30000;now+=1000)focus.update(camera,{frameMs:1000,now});
 assert.equal(focus.extraError,0);assert.equal(tiles.maximumScreenSpaceError,10);
});

test('returning from an overview resets a stranded memory floor once, never every stationary frame',()=>{
 const C=cesium();let writes=0,value=16;
 const tiles={memoryAdjustedScreenSpaceError:800,get maximumScreenSpaceError(){return value;},set maximumScreenSpaceError(v){writes++;value=v;}};
 const focus=new BuildingTileFocus(C,tiles),camera={positionCartographic:{longitude:2,latitude:.65}};
 focus.update(camera,{height:20000,now:0});assert.equal(writes,0);
 focus.update(camera,{height:6000,now:4000});assert.equal(writes,1);
 for(let now=4200;now<30000;now+=200)focus.update(camera,{height:6000,now});
 assert.equal(writes,1,'retained wide-view memory must not turn a static view into a download loop');
 focus.update(camera,{height:6000,now:31000,view:null});assert.equal(writes,1);
 focus.update(camera,{height:220,now:32000});assert.equal(writes,2,'next meaningful close-up gets its own LOD decision');
});

test('tilt targets visible ground ahead, reverses with heading, and bounds a horizon outlier',()=>{
 const base={longitude:126.978,latitude:37.5635,height:550,pitch:-25*Math.PI/180,heading:0};
 const north=buildingGroundFocus(base,8000),south=buildingGroundFocus({...base,heading:Math.PI},8000);
 assert.ok(north.latitude>base.latitude+.01);assert.ok(south.latitude<base.latitude-.01);
 const high=buildingGroundFocus({...base,height:20000},40000);
 assert.ok(high.offset>30000);assert.ok(high.offset<=32000.001);
 const sky=buildingGroundFocus(base,8000,{longitude:127,latitude:39});
 assert.ok(sky.offset<=6400.001,'a distant horizon never steals the request budget');
 const vertical=buildingGroundFocus({...base,pitch:-Math.PI/2},8000);
 assert.ok(vertical.offset<1e-6);
});

test('visible ground pick prefers centre then lower screen, not a distant view rectangle or roof',()=>{
 const C=cesium(),pixels=[];
 C.Cartesian2=class{constructor(x,y){Object.assign(this,{x,y});}};
 C.Cartographic={fromCartesian:p=>p};C.Ellipsoid={WGS84:{}};
 const viewer={canvas:{clientWidth:1000,clientHeight:600},scene:{globe:{pick:ray=>ray.y>300?{longitude:127*Math.PI/180,latitude:37.59*Math.PI/180}:undefined}},
  camera:{positionCartographic:{longitude:126.978*Math.PI/180,latitude:37.56*Math.PI/180,height:1000},
    getPickRay:p=>{pixels.push(p);return p;},pickEllipsoid:()=>undefined,
    frustum:{computeCullingVolume:()=>({computeVisibility:()=>0})}}};
 const view=cameraBuildingView(C,viewer);assert.equal(pixels.length,2);
 assert.ok(Math.abs(view.longitude-127)<1e-9);assert.ok(Math.abs(view.latitude-37.59)<1e-9);
 assert.equal(view.range,9600);
});

test('12/20 km overview retains native tiles, but orbital view stops requesting',async()=>{
 const tiles={show:false,trimLoadedTiles(){this.trimmed=true;}};let calls=0;
 const layer=new BuildingLayer({load:async()=>{calls++;return tiles;},attach:()=>{},nearMetres:BUILDING_NEAR_HEIGHT,farMetres:BUILDING_FAR_HEIGHT});
 layer.update(20000);await new Promise(setImmediate);assert.equal(tiles.show,true);
 for(const h of [8000,12000,20000,60000]){layer.update(h);assert.equal(tiles.show,true);}
 assert.equal(calls,1);layer.update(130000,0);assert.equal(tiles.show,false);assert.equal(tiles.trimmed,undefined);
 layer.update(130000,15001);assert.equal(tiles.trimmed,true,'sustained orbital views eventually release the cache');
});

test('ground-space shader and clip box share the same forward focus; height alone never hides the city',()=>{
 const C=cesium(),tiles={},focus=new BuildingTileFocus(C,tiles,{textured:true});
 const camera={positionCartographic:{longitude:126.978*Math.PI/180,latitude:37.56*Math.PI/180,height:20000},pitch:-.44,heading:0};
 focus.setAppearance({quality:'compact',distance:'metro'});focus.update(camera);
 const shader=focus.shader;
 assert.ok(focus.view.latitude>37.8);assert.equal(shader.uniforms.u_buildingRange.value,40000);
 assert.deepEqual(shader.uniforms.u_buildingFocus.value,tiles.clippingPlanes.modelMatrix.b.origin);
 assert.equal(shader.uniforms.u_buildingAltitudeFade.value,1);assert.equal(tiles.cacheBytes,96*1024*1024);
 assert.match(shader.fragmentShaderText,/positionWC - u_buildingFocus/);
 assert.doesNotMatch(shader.fragmentShaderText,/length\(fsInput.attributes.positionEC\)/);
 focus.setAppearance({distance:'city'});assert.equal(focus.shader,shader,'distance changes uniforms, not GPU programs');
 assert.equal(shader.uniforms.u_buildingRange.value,20000);
});
test('stationary view reuses expensive ground/frustum work but motion, resize and terrain invalidate it',()=>{
 const C=cesium(),cache=new BuildingViewCache(C);
 const viewer={canvas:{clientWidth:1000,clientHeight:600},scene:{globe:{tilesLoaded:true}},terrainProvider:{},
   camera:{heading:0,pitch:-.5,roll:0,positionCartographic:{longitude:2.2,latitude:.65},frustum:{fov:1,computeCullingVolume:()=>({computeVisibility:()=>0})}}};
 const options={height:500,distance:'auto'},first=cache.read(viewer,options,0);
 for(let now=200;now<5000;now+=200)assert.equal(cache.read(viewer,options,now),first);
 assert.equal(cache.scans,1,'24 redundant ground scans avoided');
 viewer.camera.heading=.1;assert.notEqual(cache.read(viewer,options,4801),first);
 viewer.canvas.clientWidth=1100;cache.read(viewer,options,4802);assert.equal(cache.scans,3);
 viewer.scene.globe.tilesLoaded=false;cache.read(viewer,options,4803);
 cache.read(viewer,options,5000);assert.equal(cache.scans,4);
 cache.read(viewer,options,5500);assert.equal(cache.scans,5);
 viewer.scene.globe.tilesLoaded=true;cache.read(viewer,options,5501);assert.equal(cache.scans,6);
 viewer.terrainProvider={};cache.read(viewer,options,5502);assert.equal(cache.scans,7);
 cache.read(viewer,{...options,distance:'metro'},5503);assert.equal(cache.view.range,40000);
});
