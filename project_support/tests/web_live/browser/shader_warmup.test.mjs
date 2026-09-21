import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {warmUpShaders,WARM_UP_FRAMES,MODEL_FRAMES} from '../../../../digital_twin/visualization/web/shader_warmup.js';

// Enough of Cesium to build the warm-up primitives: geometry, appearances,
// materials, a primitive collection and a scene with a render event and a pick.
function engine(){
 const C={
  Cartesian3:class{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}static clone(v,r={}){return Object.assign(r,{x:v.x,y:v.y,z:v.z});}},
  Cartesian2:class{constructor(x=0,y=0){Object.assign(this,{x,y});}},
  Matrix4:class{static fromTranslation(t,r=new C.Matrix4()){r.t=t;return r;}},
  BoxGeometry:{fromDimensions:options=>({box:true,...options})},
  BoxOutlineGeometry:{fromDimensions:options=>({outline:true,...options})},
  GeometryInstance:class{constructor(options){Object.assign(this,options);}},
  Primitive:class{constructor(options){Object.assign(this,options);this.show=true;}destroy(){this.destroyed=true;}},
  PerInstanceColorAppearance:class{constructor(options){this.options=options;this.flat=options?.flat===true;}},
  MaterialAppearance:class{constructor(options){this.options=options;}},
  Material:{fromType:(type,uniforms)=>({type,uniforms})},
  ColorGeometryInstanceAttribute:{fromColor:color=>({color})},
  Color:{WHITE:{white:true},fromCssColorString:css=>({css})},
 };
 C.PerInstanceColorAppearance.VERTEX_FORMAT='position+normal';
 C.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT='position';
 C.MaterialAppearance.MaterialSupport={TEXTURED:{vertexFormat:'position+normal+st'}};
 return C;
}
function sceneStub(){
 const listeners=[],picks=[],added=[];
 const scene={
  primitives:{add(p){added.push(p);return p;},remove(p){const at=added.indexOf(p);if(at>=0)added.splice(at,1);return at>=0;},get length(){return added.length;}},
  postRender:{addEventListener(fn){listeners.push(fn);return ()=>{const at=listeners.indexOf(fn);if(at>=0)listeners.splice(at,1);};}},
  pick(position,w,h){picks.push({position,w,h});return null;},
  camera:{positionWC:{x:0,y:0,z:1000},directionWC:{x:0,y:0,z:-1}},
  canvas:{clientWidth:800,clientHeight:600},
  requestRender(){scene.requested=(scene.requested??0)+1;},
 };
 return {scene,render:()=>{for(const fn of [...listeners])fn();},picks,added,listeners};
}
const canvas=()=>({width:2,height:2,getContext:()=>({fillStyle:'',fillRect(){}})});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const xyz=v=>({x:v.x,y:v.y,z:v.z});

test('the warm-up draws each appearance as its layer draws it, picks once, then takes everything away',async()=>{
 const C=engine(),{scene,render,picks,added,listeners}=sceneStub();
 const attributes=()=>({show:'shown',distanceDisplayCondition:'far'});
 const done=warmUpShaders({C,scene,createCanvas:canvas,appearances:[
  {name:'footprint',allowPicking:false,appearance:()=>new C.PerInstanceColorAppearance({translucent:false,closed:true,fragmentShaderSource:'x'})},
  {name:'corridor',appearance:()=>new C.PerInstanceColorAppearance({flat:true,translucent:true,closed:false})},
  {name:'wall',textured:true,attributes,appearance:()=>new C.MaterialAppearance({material:C.Material.fromType('Image',{image:canvas()})})},
  {name:'outline',outline:true,appearance:()=>new C.PerInstanceColorAppearance({flat:true})},
  {name:'line',geometry:({position,edge})=>({line:true,from:position,edge}),appearance:()=>new C.PerInstanceColorAppearance({})},
 ]});
 assert.equal(added.length,5,'one primitive per appearance');
 assert.ok(added.every(p=>p.asynchronous===false),'built now, not on a worker later: the point is to compile now');
 assert.ok(added.every(p=>p.geometryInstances instanceof C.GeometryInstance));
 assert.equal(added[0].allowPicking,false,'the city is never picked, and a pick colour would be a different program');
 assert.equal(added[1].allowPicking,true);
 assert.deepEqual(added[1].geometryInstances.attributes,{color:{color:C.Color.WHITE}},'a colour per instance, as the corridor has');
 assert.equal(added[1].geometryInstances.geometry.vertexFormat,'position','a flat colour wants positions only, as the corridor is built');
 assert.equal(added[0].geometryInstances.geometry.vertexFormat,'position+normal','a lit colour wants normals');
 assert.equal(added[2].geometryInstances.geometry.vertexFormat,'position+normal+st','a textured material wants texture coordinates');
 assert.deepEqual(added[2].geometryInstances.attributes,{show:'shown',distanceDisplayCondition:'far'},'the batch attributes the Entity API gives a material');
 assert.equal(added[3].geometryInstances.geometry.outline,true,'an outline is lines, not faces');
 assert.equal(added[4].geometryInstances.geometry.line,true,'a layer can hand over its own geometry');
 assert.deepEqual(xyz(added[4].geometryInstances.geometry.from),{x:0,y:0,z:0},'a layer geometry is built around the origin...');
 assert.deepEqual(xyz(added[4].modelMatrix.t),{x:0,y:0,z:800},'...and placed ahead of the camera like the boxes, so the views carry it along');
 assert.deepEqual(xyz(added[0].modelMatrix.t),{x:0,y:0,z:800},'the boxes stand 200 m ahead of the camera');
 assert.ok(added.every(p=>p.geometryInstances.modelMatrix===undefined),'the matrix belongs to the primitive: an instance matrix would be baked into world positions and the views could not carry the box along');
 assert.equal(picks.length,0);
 for(let frame=0;frame<WARM_UP_FRAMES;frame++)render();
 assert.equal(picks.length,0,'the boxes are drawn first');
 for(let frame=0;frame<WARM_UP_FRAMES;frame++)render();
 assert.equal(picks.length,1,'the pick pass compiles its own variants of every program');
 assert.deepEqual([picks[0].position.x,picks[0].position.y],[400,300]);
 assert.deepEqual([picks[0].w,picks[0].h],[800,600],'the whole screen, so every pick variant in view is compiled');
 const result=await done;
 assert.equal(added.length,0,'nothing is left on the map');
 assert.equal(listeners.length,0,'the render hook is gone');
 assert.equal(result.primitives,5);assert.equal(result.picked,true);assert.equal(result.picks,1);assert.ok(result.frames>=2*WARM_UP_FRAMES);
});

test('the city views are visited with the boxes carried along, each is picked, and the camera is put back',async()=>{
 const C=engine(),{scene,render,picks,added}=sceneStub();
 C.Cartesian3.fromDegrees=(longitude,latitude,height)=>({longitude,latitude,height});
 const views=[];
 Object.assign(scene.camera,{upWC:{x:0,y:1,z:0},setView(view){views.push(view);scene.camera.positionWC={x:views.length*1000,y:0,z:1000};}});
 const done=warmUpShaders({C,scene,createCanvas:canvas,views:[{longitude:126.98,latitude:37.57,height:60000,pitch:-35},{longitude:126.98,latitude:37.57,height:12000,pitch:-50}],
  appearances:[{name:'corridor',appearance:()=>new C.PerInstanceColorAppearance({flat:true})}]});
 const box=added[0];
 assert.equal(views.length,0,'the boxes are drawn where the camera is first');
 render();render();
 assert.equal(views.length,1,'then the first view is set');
 assert.equal(views[0].destination.height,60000);assert.ok(Math.abs(views[0].orientation.pitch+35*Math.PI/180)<1e-9);
 assert.deepEqual(xyz(box.modelMatrix.t),{x:1000,y:0,z:800},'and the box is moved to sit ahead of the camera there');
 render();render();
 assert.equal(picks.length,1,'what stands on the map at that view is picked, so its pick variants compile');
 assert.equal(views.length,2,'the second view follows');
 assert.equal(views[1].destination.height,12000);
 assert.deepEqual(xyz(box.modelMatrix.t),{x:2000,y:0,z:800});
 render();render();
 assert.equal(picks.length,2);
 assert.equal(views.length,3,'then the camera is put back where it was');
 assert.deepEqual(views[2].orientation.direction,{x:0,y:0,z:-1});assert.deepEqual(views[2].destination,{x:0,y:0,z:1000});
 render();render();
 assert.equal(picks.length,3,'and the boxes are picked last');
 const result=await done;
 assert.equal(result.views,2);assert.equal(result.picks,3);assert.equal(added.length,0);
});

test('models are loaded first, carried through the views once they are ready, and released with the boxes',async()=>{
 const C=engine(),{scene,render,picks,added}=sceneStub();
 C.Cartesian3.fromDegrees=(longitude,latitude,height)=>({longitude,latitude,height});
 const views=[];
 Object.assign(scene.camera,{upWC:{x:0,y:1,z:0},setView(view){views.push(view);}});
 const loads=[],ready=[];
 C.Model={fromGltfAsync:async options=>{loads.push(options);const model={options,show:true,ready:false,readyEvent:{addEventListener(fn){ready.push(()=>{model.ready=true;fn();});}},destroy(){model.destroyed=true;}};return model;}};
 const done=warmUpShaders({C,scene,createCanvas:canvas,views:[{longitude:126.98,latitude:37.57,height:12000,pitch:-50}],
  appearances:[{name:'corridor',appearance:()=>new C.PerInstanceColorAppearance({flat:true})}],
  models:[{name:'charger',url:'/visual-assets/charger.glb',color:'faded'},{name:'shelter',url:'/visual-assets/shelter.glb'}]});
 await settle();await settle();
 assert.equal(loads.length,2);assert.equal(loads[0].color,'faded');assert.equal(loads[0].show,true);
 assert.deepEqual(loads[0].environmentMapOptions,{enabled:false},'the same lighting variant as the facility models: no rendered environment map');
 assert.equal(added.length,3,'the models stand beside the box');
 render();render();render();render();
 assert.equal(views.length,0,'no view is visited until the models have something to draw');
 for(const fire of ready)fire();
 render();
 assert.equal(views.length,1,'ready models: the city view is visited with them');
 assert.ok(added[1].modelMatrix,'the models are carried along');
 render();render();
 assert.equal(picks.length,1);
 assert.equal(views.length,2,'the camera is put back');
 for(let frame=0;frame<MODEL_FRAMES-1;frame++)render();
 assert.equal(picks.length,1,'models are given the frames their environment maps take');
 render();
 assert.equal(picks.length,2);
 const result=await done;
 assert.equal(result.models,2);assert.equal(result.picks,2);assert.equal(added.length,0);
});

test('point and billboard collections are built as the layers keep them, placed like the boxes, and taken away',async()=>{
 const C=engine(),{scene,render,picks,added}=sceneStub();
 C.Cartesian3.fromDegrees=(longitude,latitude,height)=>({longitude,latitude,height});
 Object.assign(scene.camera,{upWC:{x:0,y:1,z:0},setView(){scene.camera.positionWC={x:1000,y:0,z:1000};}});
 const built=[];
 const done=warmUpShaders({C,scene,createCanvas:canvas,views:[{longitude:126.98,latitude:37.57,height:12000,pitch:-50}],
  appearances:[{name:'corridor',appearance:()=>new C.PerInstanceColorAppearance({flat:true})}],
  collections:[{name:'points',collection:({edge})=>{const points={points:true,edge};built.push(points);return points;}},
   {name:'broken',collection:()=>{throw new Error('no such collection');}},
   {name:'empty',collection:()=>null}]});
 assert.equal(added.length,2,'the box and the one collection that could be built');
 assert.equal(built[0].edge,10,'sized like the boxes');
 assert.deepEqual(xyz(built[0].modelMatrix.t),{x:0,y:0,z:800},'placed ahead of the camera like the boxes');
 render();render();
 assert.deepEqual(xyz(built[0].modelMatrix.t),{x:1000,y:0,z:800},'and carried to the city view');
 render();render();render();render();
 const result=await done;
 assert.equal(result.primitives,1);assert.equal(result.collections,1);assert.deepEqual(result.failed,['broken','empty']);
 assert.ok(picks.length>=1);assert.equal(added.length,0,'nothing is left on the map');
});

test('one appearance that cannot be built does not stop the others, and a scene that never renders still settles',async()=>{
 const C=engine(),{scene,added}=sceneStub();
 let timers=[];
 const done=warmUpShaders({C,scene,createCanvas:canvas,timeoutMs:5,setTimer:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimer(){},
  appearances:[{name:'broken',appearance:()=>{throw new Error('no such appearance');}},
   {name:'corridor',appearance:()=>new C.PerInstanceColorAppearance({flat:true})}]});
 assert.equal(added.length,1);
 assert.equal(timers.length,1);assert.equal(timers[0].ms,5);
 timers[0].fn();
 const result=await done;
 assert.equal(result.primitives,1);assert.equal(result.picked,false);assert.deepEqual(result.failed,['broken']);
 assert.equal(added.length,0);
});

test('an engine without the classes, or a scene already destroyed, answers quietly',async()=>{
 const result=await warmUpShaders({C:{},scene:{isDestroyed:()=>true},appearances:[]});
 assert.equal(result.primitives,0);assert.equal(result.picked,false);
});

test('the page warms the map up before it grades the display and before the opening flight',()=>{
 const app=readFileSync(new URL('../../../../user_application/web/app.js',import.meta.url),'utf8');
 const warm=app.indexOf('globe.warmUpShaders('),grade=app.indexOf('displayQuality.calibrate('),entry=app.indexOf('loadingScreen.finish(');
 assert.ok(warm>0,'the app asks the globe to warm up');
 assert.ok(warm<grade&&grade<entry,'compiles land inside the loading screen, not in the cadence sample or the flight');
 const globe=readFileSync(new URL('../../../../digital_twin/visualization/web/globe.js',import.meta.url),'utf8');
 assert.match(globe,/warmUpShaders\(\)\s*\{/);
 assert.match(globe,/footprintAppearance\(/,'the same footprint shader the city is drawn with');
 assert.match(globe,/allowPicking:false,appearance:\(\)=>footprintAppearance/,'unpicked, as the city is');
 assert.match(globe,/name:'wall-faded'/,'the faded variants an edit needs');
 assert.match(globe,/name:'cable',allowPicking:false,attributes:\(\)=>\(\{color:white\(\)\}\)/,'the stand cable: unpicked, a colour per instance and nothing else');
 assert.match(globe,/vertiport_facilities\/\$\{kind\}\.glb/,'the cabinet and shelter models');
 assert.match(globe,/line\(C\.PolylineMaterialAppearance\?\.VERTEX_FORMAT\)/,'a dashed line carries the material vertex format');
});

test('flight shader warm-up uses only observed UAM rigs, deduplicated with their real scale',async()=>{
 const {flightShaderModels}=await import('../../../../digital_twin/visualization/web/visual_asset_loader.js');
 const assets=new Map([['rig',{uri:'/original.glb',flight_visual:{uri:'/flight.glb'}}],['idle',{uri:'/idle.glb'}]]);
 const item=(source,kind='uam',asset='rig')=>({entity:{source,kind,visual_asset_id:asset}});
 const models=flightShaderModels(assets,[item('scenario'),item('scenario'),item('physical_uam'),item('live','aircraft'),item('scenario','uam','missing')],()=>2);
 assert.deepEqual(models,[{name:'flight:rig',url:'/flight.glb',scale:2,flight:true}]);
 assert.deepEqual(flightShaderModels(assets,[]),[],'an idle map does not load the whole aircraft library');
});
