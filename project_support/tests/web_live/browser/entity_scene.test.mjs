import test from 'node:test';
import assert from 'node:assert/strict';
import {EntityScene, MODEL_LABEL_DEPTH_M, UAM_LABEL_DEPTH_M, UAM_LABEL_FAR_M, uamLabelRange} from '../../../../digital_twin/visualization/web/entity_scene.js';
import {loadImageryProvider,loadVisualModel,retryTile} from '../../../../digital_twin/visualization/web/visual_asset_loader.js';
class Collection {
 values=[]; add(item){this.values.push(item);return item;} remove(item){this.values=this.values.filter(value=>value!==item);}
}
const color={withAlpha:()=>color};
const C={PointPrimitiveCollection:Collection,LabelCollection:Collection,PrimitiveCollection:Collection,BillboardCollection:Collection,Cartesian2:class {constructor(x=0,y=0){Object.assign(this,{x,y});}},
 Cartesian3:{fromArray:(value,_offset,result={})=>Object.assign(result,{x:value[0],y:value[1],z:value[2]})},
 Color:{CYAN:color,BLACK:color,WHITE:color,GRAY:{gray:true},fromCssColorString:value=>value}};
const entity={entity_id:'a',name:'A',kind:'aircraft',quality:'valid',position_ecef_m:[1,2,3],visual_asset_id:'plane'};

test('scenario aircraft use the single-flight rig at authored scale, not seat spans',async()=>{
 let options;
 const engine={...C,Axis:{X:0,Y:1},Model:{fromGltfAsync:async value=>{options=value;return {destroy(){},errorEvent:{addEventListener(){}}};}}};
 const scene=new EntityScene(engine,{scene:{primitives:new Collection()}});scene.matrix=()=>({});
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/original.glb',size_m:1.4,
   flight_visual:{uri:'/visual-assets/flight_model.glb',size_m:8.123,rotors:{nodes:[]}}}]});
 scene.replace({sequence:1,state_time:1,entities:[{...entity,kind:'uam',source:'scenario'}]});
 const item=scene.items.get('a');item.lod='model';await scene.loadModel(item);
 assert.equal(options.url,'/visual-assets/flight_model.glb');assert.equal(options.scale,1);
 assert.equal(scene.sizeOf('plane',true),8.123);assert.equal(scene.sizeOf('plane'),1.4);
 scene.setModelSpans({plane:15});scene.setModelSpans({});assert.equal(item.model,null);
 scene.destroy();
});

test('Physical UAM uses the articulated flight model and rotor rig; unrelated live aircraft stays static',async()=>{
 for(const [kind,source,animated] of [['uam','physical_uam',true],['aircraft','opensky',false]]){
  let options;const engine={...C,Axis:{X:0,Y:1},Model:{fromGltfAsync:async value=>{options=value;return {destroy(){},errorEvent:{addEventListener(){}}};}}};
  const scene=new EntityScene(engine,{scene:{primitives:new Collection()}});scene.matrix=()=>({});
  scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/original.glb',size_m:1.4,flight_visual:{uri:'/visual-assets/flight_model.glb',size_m:8,rotors:{nodes:[]}}}]});
  scene.replace({sequence:1,state_time:1,entities:[{...entity,kind,source}]});const item=scene.items.get('a');item.lod='model';await scene.loadModel(item);
  assert.equal(options.url,animated?'/visual-assets/flight_model.glb':'/visual-assets/original.glb');assert.equal(Boolean(item.rotorSpec),animated);scene.destroy();
 }
});

test('Physical rotors keep measured spin through stale navigation but do not invent missing telemetry',()=>{
 const scene=new EntityScene(C,{scene:{primitives:new Collection()}}),calls=[];
 const item={entity:{entity_id:'physical:a',source:'physical_uam',kind:'uam',quality:'valid',flight_phase:'cruise',rotor_radps:240,tilt_deg:90},rotorSpec:{},model:{ready:true},rotorsChecked:true,
   rotors:{tilt:1,advance(...args){calls.push(args);}},selected:true,spunAt:1000,spinStateTime:1};
 let time=2;scene.samples.renderTime=()=>time++;scene.samples.telemetryAt=()=>({rotor_radps:220,tilt_deg:80});
 scene.spinRotors(item,1016);assert.equal(calls[0][1],220);assert.equal(calls[0][2],80*Math.PI/180);assert.ok(calls[0][0]>0);
 item.entity.quality='stale';scene.samples.renderTime=()=>2;scene.spinRotors(item,1032);
 assert.equal(calls.length,2);assert.equal(calls[1][0],.016);assert.equal(calls[1][1],220);assert.equal(calls[1][2],80*Math.PI/180);
 item.entity.quality='valid';item.entity.rotor_radps=null;item.entity.tilt_deg=null;scene.spinRotors(item,1048);
 assert.equal(calls.at(-1)[1],0);assert.equal(calls.at(-1)[2],1);scene.destroy();
});

for(const quality of ['valid','stale'])test(`a silent ${quality} Physical stream holds navigation while blades keep turning; a received zero RPM stops them`,()=>{
 const scene=new EntityScene(C,{scene:{primitives:new Collection()}}),calls=[];
 const sample={...entity,source:'physical_uam',kind:'uam',quality,flight_phase:'cruise',rotor_radps:240,tilt_deg:75};
 const received=performance.now();scene.replace({sequence:1,state_time:10,entities:[sample]});
 const item=scene.items.get('a');Object.assign(item,{rotorSpec:{},model:{ready:true},rotorsChecked:true,selected:true,
   rotors:{tilt:75*Math.PI/180,advance(...args){calls.push(args);}}});
 const position=[];
 for(let frame=0;frame<300;frame++){
   const now=received+1000+frame*16;scene.samples.position('a',now,position);scene.spinRotors(item,now);
   assert.deepEqual(position,sample.position_ecef_m);assert.equal(scene.samples.renderTime('a'),10);
   assert.equal(calls.at(-1)[1],240);assert.equal(calls.at(-1)[2],75*Math.PI/180);
   if(frame)assert.ok(Math.abs(calls.at(-1)[0]-.016)<1e-9);
 }
 assert.equal(item.entity.quality,quality);assert.equal(scene.samples.entries.get('a').count,1);
 scene.replace({sequence:2,state_time:15,entities:[{...sample,flight_phase:'parked',rotor_radps:0}]});
 scene.samples.position('a',received+10000,position);scene.spinRotors(item,received+10000);
 assert.equal(calls.at(-1)[1],0);assert.equal(calls.at(-1)[3],false);
 item.model=null;scene.destroy();
});

test('Physical missing tilt remains unknown inside the real sample buffer on recovery',()=>{
 const scene=new EntityScene(C,{scene:{primitives:new Collection()}}),calls=[];
 for(const [time,tilt] of [[1,90],[2,null],[3,90]])scene.replace({sequence:time,state_time:time,entities:[{...entity,kind:'uam',source:'physical_uam',tilt_deg:tilt,rotor_radps:tilt===null?null:240}]});
 const item=scene.items.get('a');Object.assign(item,{rotorSpec:{},model:{ready:true,destroy(){}},rotorsChecked:true,rotors:{tilt:Math.PI/2,advance(...args){calls.push(args);}},selected:true});
 for(const time of [2,2.5]){scene.samples.renderTime=()=>time;scene.spinRotors(item,1000+time*16);assert.equal(calls.at(-1)[2],Math.PI/2);assert.equal(calls.at(-1)[1],0);}
 scene.samples.renderTime=()=>3;scene.spinRotors(item,1100);assert.equal(calls.at(-1)[2],Math.PI/2);assert.equal(calls.at(-1)[1],240);item.model=null;scene.destroy();
});

test('hover outlines only its visible point and clearing hover preserves selected emphasis',()=>{
 const scene=new EntityScene(C,{scene:{primitives:new Collection()}},()=>{});
 scene.replace({sequence:1,state_time:1,entities:[entity,{...entity,entity_id:'b'}]});
 const a=scene.items.get('a'),b=scene.items.get('b');a.lod=b.lod='point';
 assert.equal(typeof scene.setHovered,'function');
 scene.setHovered('a');assert.ok(a.point.outlineWidth>0);assert.equal(b.point.outlineWidth,0);
 a.selected=true;scene.setHovered('b');assert.equal(a.point.pixelSize,6);assert.ok(a.point.outlineWidth>0);assert.ok(b.point.outlineWidth>0);
 scene.setHovered(null);assert.equal(b.point.pixelSize,3);assert.equal(b.point.outlineWidth,0);
 scene.setLayerVisible('aircraft',false);scene.setHovered('a');assert.equal(a.point.show,false);
});
test('snapshot replacement keeps primitives, frame positions do not recreate entities, removal clears them',()=>{
 const primitives=new Collection();const scene=new EntityScene(C,{scene:{primitives}},()=>{});
 scene.replace({sequence:1,state_time:10,entities:[entity]});
 const first=scene.items.get('a');const point=first.point;
 assert.equal(scene.layers.aircraft.labels.values.length,0,'far entities do not allocate labels before LOD requests them');
 scene.replace({sequence:2,state_time:11,entities:[{...entity,position_ecef_m:[2,3,4]}]});
 for(let i=0;i<120;i++)scene.updatePositions(performance.now()+i*16);
 assert.equal(scene.items.get('a'),first);assert.equal(first.point,point);assert.equal(scene.layers.aircraft.points.values.length,1);
 scene.replace({sequence:3,state_time:12,entities:[]});assert.equal(scene.items.size,0);assert.equal(scene.layers.aircraft.points.values.length,0);assert.equal(scene.layers.aircraft.labels.values.length,0);
});

test('stable category colors and equal point sizes survive stale updates',()=>{
 const scene=new EntityScene(C,{scene:{primitives:new Collection()}},()=>{});
 scene.replace({sequence:1,state_time:1,entities:[entity,{...entity,entity_id:'s',kind:'satellite'}]});
 const aircraft=scene.items.get('a'),satellite=scene.items.get('s');
 assert.equal(aircraft.point.pixelSize,3);assert.equal(satellite.point.pixelSize,3);
 const before=aircraft.point.color;
 scene.replace({sequence:2,state_time:2,entities:[{...entity,quality:'stale'},{...entity,entity_id:'s',kind:'satellite'}]});
 assert.equal(aircraft.point.color,before);assert.notEqual(aircraft.point.color,satellite.point.color);
 assert.equal(aircraft.point.outlineWidth,0);
});

test('category visibility is independent and does not erase received states',()=>{
 const scene=new EntityScene(C,{scene:{primitives:new Collection()}},()=>{});
 scene.replace({sequence:1,state_time:1,entities:[entity,{...entity,entity_id:'s',kind:'satellite'}]});
 scene.setLayerVisible('aircraft',false);
 assert.equal(scene.layers.aircraft.points.show,false);
 assert.equal(scene.layers.satellite.points.show,true);
 assert.equal(scene.items.size,2);assert.equal(scene.samples.entries.size,2);
 scene.setLayerVisible('aircraft',true);assert.equal(scene.layers.aircraft.points.show,true);
 assert.throws(()=>scene.setLayerVisible('unknown',false));
});

test('model replaces its point; failures restore point; selection alone enlarges it',()=>{
 const scene=new EntityScene(C,{scene:{primitives:new Collection()}},()=>{});
 scene.replace({sequence:1,state_time:1,entities:[entity]});const item=scene.items.get('a');
 item.lod='model';item.model={show:false};scene.applyVisibility(item,true);
 assert.equal(item.model.show,true);assert.equal(item.point.show,false);assert.equal(item.point.pixelSize,6);
 item.failed=true;scene.applyVisibility(item,false);
 assert.equal(item.model.show,false);assert.equal(item.point.show,true);assert.equal(item.point.pixelSize,3);
});
test('failed photographic imagery uses declared fallback, both failures reject',async()=>{
 const failure=()=>Promise.reject(new Error('offline'));
 const result=await loadImageryProvider(failure,()=>Promise.resolve('natural-earth'));
 assert.deepEqual(result,{provider:'natural-earth',fallback:true});
 await assert.rejects(loadImageryProvider(failure,failure),/offline/);
});
test('GLB loader explicitly honors AeroDT forward X, up Y metre convention',async()=>{
 const C={Axis:{X:0,Y:1},Model:{fromGltfAsync:options=>options}};
 const options=await loadVisualModel(C,{uri:'/visual-assets/plane.glb'},'a',{});
 assert.deepEqual(options.environmentMapOptions,{enabled:false},'no dynamic environment map per aircraft: its convolution program and per-model cube renders are not worth a reflection this size');
 assert.equal(options.forwardAxis,C.Axis.X);assert.equal(options.upAxis,C.Axis.Y);assert.equal(options.scale,1);
});
test('late model completion cannot attach to a removed and recreated entity',async()=>{
 let resolveModel;let destroyed=false;
 const engine={...C,Axis:{X:0,Y:1},Model:{fromGltfAsync:()=>new Promise(resolve=>{resolveModel=resolve;})}};
 const scene=new EntityScene(engine,{scene:{primitives:new Collection()}},()=>{});scene.matrix=()=>({});
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb'}]});
 scene.replace({sequence:1,state_time:1,entities:[entity]});const old=scene.items.get('a');const pending=scene.loadModel(old);
 scene.replace({sequence:2,state_time:2,entities:[]});scene.replace({sequence:3,state_time:3,entities:[entity]});
 resolveModel({destroy(){destroyed=true;},errorEvent:{addEventListener(){}}});await pending;
 assert.equal(destroyed,true);assert.equal(scene.items.get('a').model,null);
});

test('late GLB completion after viewer destruction releases the resource without touching the dead scene',async()=>{
 let finish,disposed=false,destroyed=0;
 const engine={...C,Axis:{X:0,Y:1},Model:{fromGltfAsync:()=>new Promise(resolve=>finish=resolve)}};
 const visualScene={primitives:new Collection()},viewer={get scene(){assert.equal(disposed,false,'destroyed viewer must not be accessed');return visualScene;}};
 const scene=new EntityScene(engine,viewer);scene.matrix=()=>({});
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb'}]});scene.replace({sequence:1,state_time:1,entities:[entity]});
 const pending=scene.loadModel(scene.items.get('a'));scene.destroy();disposed=true;
 finish({destroy(){destroyed++;}});await pending;assert.equal(destroyed,1);assert.equal(scene.pendingModels,0);
});

test('disabling selected 3D releases the model and stale ready/error callbacks cannot restore it',async()=>{
 let onReady,onError,unsubscribed=0,destroyed=0,warnings=0;
 class OwnedCollection extends Collection {destroyPrimitives=true;remove(item){super.remove(item);if(this.destroyPrimitives)item.destroy();}}
 const model={ready:false,destroy(){destroyed++;},
   readyEvent:{addEventListener(fn){onReady=fn;return ()=>unsubscribed++;}},
   errorEvent:{addEventListener(fn){onError=fn;return ()=>unsubscribed++;}}};
 const engine={...C,PrimitiveCollection:OwnedCollection,Axis:{X:0,Y:1},Model:{fromGltfAsync:async()=>model}};
 const scene=new EntityScene(engine,{scene:{primitives:new Collection()}},()=>warnings++);scene.matrix=()=>({});
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb'}]});scene.replace({sequence:1,state_time:1,entities:[entity]});
 const item=scene.items.get('a');item.selected=true;item.lod='model';await scene.loadModel(item,true);
 scene.setDisplayOptions('aircraft',{models:false});assert.equal(item.model,null);assert.equal(destroyed,1);assert.equal(unsubscribed,2);
 onReady();onError();assert.equal(item.model,null);assert.equal(warnings,0);assert.equal(item.point.show,true);
 scene.destroy();assert.equal(destroyed,1);
});

test('hidden entities never enter per-frame point updates',()=>{
 const scene=new EntityScene(C,{scene:{primitives:new Collection()}},()=>{});
 scene.replace({sequence:1,state_time:1,entities:[entity]});const item=scene.items.get('a');
 let writes=0;Object.defineProperty(item.point,'position',{set(){writes++;}});
 item.lod='hidden';scene.frameItems=[];scene.updatePositions(5000);assert.equal(writes,0);
});
test('concurrent model loads are bounded even when many nearby objects request them',async()=>{
 const resolves=[];let calls=0;
 const engine={...C,Axis:{X:0,Y:1},Model:{fromGltfAsync:()=>{calls++;return new Promise(resolve=>resolves.push(resolve));}}};
 const scene=new EntityScene(engine,{scene:{primitives:new Collection()}},()=>{});scene.matrix=()=>({});
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb'}]});
 scene.replace({sequence:1,state_time:1,entities:Array.from({length:30},(_,i)=>({...entity,entity_id:String(i)}))});
 for(const item of scene.items.values()){item.lod='model';scene.loadModel(item);}
 assert.ok(calls<=2,'no unbounded burst of model creation');
 scene.destroy();for(const resolve of resolves)resolve({destroy(){},errorEvent:{addEventListener(){}}});
 await new Promise(r=>setImmediate(r));assert.equal(scene.pendingModels,0);
});
test('focus reserves one model slot beyond background loads and respects model visibility',async()=>{
 const resolves=[];
 const engine={...C,Axis:{X:0,Y:1},Model:{fromGltfAsync:()=>new Promise(resolve=>resolves.push(resolve))}};
 const scene=new EntityScene(engine,{scene:{primitives:new Collection()}});scene.matrix=()=>({});
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb'}]});
 scene.replace({sequence:1,state_time:1,entities:Array.from({length:5},(_,i)=>({...entity,entity_id:String(i)}))});
 const items=[...scene.items.values()];scene.loadModel(items[0]);scene.loadModel(items[1]);
 assert.equal(scene.prepareFocus(items[2],10),true);assert.equal(resolves.length,3);
 assert.equal(scene.prepareFocus(items[3],20),false);assert.equal(resolves.length,3,'never exceeds the reserved third slot');
 scene.layers.aircraft.showModels=false;assert.equal(scene.prepareFocus(items[4],30),false);
 scene.destroy();for(const resolve of resolves)resolve({destroy(){},errorEvent:{addEventListener(){}}});
 await new Promise(r=>setImmediate(r));assert.equal(scene.pendingModels,0);
});
test('a selected model prepared before the close-up LOD is retained, not downloaded twice',async()=>{
 let resolve;
 const engine={...C,Axis:{X:0,Y:1},Model:{fromGltfAsync:()=>new Promise(r=>resolve=r)}};
 const scene=new EntityScene(engine,{scene:{primitives:new Collection()}});scene.matrix=()=>({});
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb'}]});scene.replace({sequence:1,state_time:1,entities:[entity]});
 const item=scene.items.get('a');item.selected=true;item.lod='point';scene.prepareFocus(item,0);
 const model={destroy(){this.destroyed=true;},errorEvent:{addEventListener(){}}};resolve(model);
 await new Promise(r=>setImmediate(r));assert.equal(item.model,model);assert.equal(model.destroyed,undefined);
 assert.equal(model.show,false,'prepared offscreen without forcing the wrong LOD');scene.destroy();
});

test('model load timeout releases the slot and destroys a late resource',{timeout:100},async()=>{
 let finish,destroyed=false;
 const engine={Axis:{X:0,Y:1},Model:{fromGltfAsync:()=>new Promise(resolve=>finish=resolve)}};
 await assert.rejects(loadVisualModel(engine,{uri:'/visual-assets/plane.glb'},'a',{},5),/timeout/);
 finish({destroy(){destroyed=true;}});await new Promise(r=>setImmediate(r));assert.equal(destroyed,true);
});

function lodHarness(entities,height=500000){
 const engine={...C,Ellipsoid:{WGS84:{}},EllipsoidalOccluder:class {isPointVisible(){return true;}}};
 const camera={positionWC:{x:0,y:0,z:0},directionWC:{x:0,y:0,z:1},rightWC:{x:1,y:0,z:0},upWC:{x:0,y:1,z:0},positionCartographic:{height},frustum:{fovy:Math.PI/2}};
 const scene=new EntityScene(engine,{scene:{primitives:new Collection()},camera,canvas:{clientWidth:1000,clientHeight:1000}});
 scene.replace({sequence:1,state_time:1,entities});scene.loadModel=()=>{};
 return {scene,camera};
}
test('zoomed view culls rear and offscreen objects, then re-enters with fresh positions',()=>{
 const {scene}=lodHarness([{...entity,position_ecef_m:[0,0,1000]},{...entity,entity_id:'b',position_ecef_m:[0,0,-1000]}]);
 scene.updateLod(null);assert.deepEqual(scene.frameItems.map(x=>x.entity.entity_id),['a']);
 scene.replace({sequence:2,state_time:2,entities:[{...entity,entity_id:'b',position_ecef_m:[100,0,1000],discontinuity:true}]});
 scene.updateLod(null);assert.deepEqual(scene.frameItems.map(x=>x.entity.entity_id),['b']);
});
test('dense point budgets preserve independent categories and selected priority',()=>{
 const entities=Array.from({length:200},(_,i)=>({...entity,entity_id:String(i),kind:i%2?'aircraft':'satellite',position_ecef_m:[0,0,100000]}));
 const {scene}=lodHarness(entities);scene.updateLod('199');
 assert.ok(scene.frameItems.length<=3);assert.ok(scene.frameItems.some(x=>x.entity.entity_id==='199'));
 assert.ok(scene.frameItems.some(x=>x.entity.kind==='satellite'));assert.equal(scene.items.size,200);
 scene.setLayerVisible('aircraft',false);scene.updateLod(null);
 assert.ok(scene.frameItems.every(x=>x.entity.kind==='satellite'));assert.equal(scene.samples.entries.size,200);
});


test('incremental LOD scans are bounded per frame and do not resurrect removed entities',()=>{
 const entities=Array.from({length:12000},(_,i)=>({...entity,entity_id:String(i),position_ecef_m:[0,0,100000]}));
 const {scene}=lodHarness(entities);let scanned=0;const refresh=scene.refreshPosition.bind(scene);scene.refreshPosition=(...args)=>{scanned++;refresh(...args);};
 scene.updateLod(null,performance.now(),{incremental:true});assert.ok(scanned<=4000);assert.ok(scene.lodScan);
 scene.replace({sequence:2,state_time:2,entities:[]});
 for(let i=0;i<5 && scene.lodScan;i++)scene.updateLod(null,performance.now(),{incremental:true});
 assert.equal(scene.lodScan,null);assert.equal(scene.frameItems.length,0);assert.equal(scene.items.size,0);
});

test('selected subpixel model keeps a readable selection point without inflating geometry',()=>{
 const {scene}=lodHarness([entity]);const item=scene.items.get('a');item.model={};item.lod='model';item.pixels=.5;
 scene.applyVisibility(item,true);assert.equal(item.model.show,true);assert.equal(item.point.show,true);assert.equal(item.point.pixelSize,6);
 item.pixels=20;scene.applyVisibility(item,true);assert.equal(item.point.show,false);
});

test('near, selected and model items refresh every frame while far points keep the slower cadence',()=>{
 const scene=new EntityScene(C,{scene:{primitives:new Collection()}},()=>{});
 scene.replace({sequence:1,state_time:1,entities:[entity,{...entity,entity_id:'far'},{...entity,entity_id:'sel'}]});
 const near=scene.items.get('a'),far=scene.items.get('far'),sel=scene.items.get('sel');
 for(const item of [near,far,sel]){item.lod='point';item.point.show=true;}
 near.pixels=2;far.pixels=0;sel.pixels=0;sel.selected=true;scene.frameItems=[near,far,sel];
 const writes={a:0,far:0,sel:0};
 for(const item of [near,far,sel])Object.defineProperty(item.point,'position',{set(){writes[item.entity.entity_id]++;}});
 scene.updatePositions(1000);for(let i=1;i<=10;i++)scene.updatePositions(1000+i*16);
 assert.equal(writes.a,11);assert.equal(writes.sel,11);assert.ok(writes.far>=2 && writes.far<=4);
});
test('model orientation uses the interpolated ground track, not the newest sample alone',()=>{
 const engine={...C,HeadingPitchRoll:class {},Ellipsoid:{WGS84:{}},Transforms:{headingPitchRollToFixedFrame:(_p,hpr)=>({heading:hpr.heading})}};
 const scene=new EntityScene(engine,{scene:{primitives:new Collection()}},()=>{});
 const track=(t,heading)=>({...entity,position_ecef_m:[100*t,0,0],heading_deg:heading,orientation_source:'ground_track'});
 scene.replace({sequence:1,state_time:0,entities:[track(0,350)]});scene.replace({sequence:2,state_time:2.5,entities:[track(2.5,10)]});
 const item=scene.items.get('a');
 assert.ok(Math.abs(scene.matrix(item,1.25).heading-(-Math.PI/2))<1e-9,'midway heading is north (0 deg) in display convention');
 assert.ok(Math.abs(scene.matrix(item,2.5).heading-((10-90)*Math.PI/180))<1e-9);
});

// Points render at 3 px. Zoomed in, a name is the only way to tell one from
// another, so nearby points get a small label; distant views keep the map clean.
const spread=()=>Array.from({length:7},(_,i)=>({...entity,entity_id:String(i),name:`F${i}`,position_ecef_m:[i*8000-24000,0,36000]}));

test('UAM status survives name-only toggle and updates the same label on new snapshots',()=>{
 const e={...entity,entity_id:'scenario:UAM45',source:'scenario',kind:'uam',flight_phase:'hold',position_ecef_m:[0,0,36000]};
 const {scene}=lodHarness([e],20000);scene.updateLod(e.entity_id);
 const item=scene.items.get(e.entity_id),label=item.label;
 assert.equal(label.text,'UAM45\n체공');
 scene.setDisplayOptions('uam',{labels:false,status:true});scene.updateLod(e.entity_id);
 assert.equal(item.label,label);assert.equal(label.text,'체공');assert.equal(scene.layers.uam.labels.show,true);
 scene.replace({sequence:2,state_time:11,entities:[{...e,flight_phase:'cruise'}]});scene.updateLod(e.entity_id);
 assert.equal(item.label,label);assert.equal(label.text,'순항');
 scene.setDisplayOptions('uam',{labels:true,status:false});scene.updateLod(e.entity_id);
 assert.equal(label.text,'UAM45');
 scene.setDisplayOptions('uam',{labels:false,status:false});scene.updateLod(e.entity_id);assert.equal(item.label,null);
 scene.setLayerVisible('uam',false);scene.setLayerVisible('uam',true);scene.updateLod(e.entity_id);assert.equal(item.label,null);
 scene.setDisplayOptions('uam',{labels:false,status:true});scene.updateLod(e.entity_id);assert.equal(item.label.text,'순항');
});

test('two-line UAM labels reserve their full height when neighboring aircraft stack on screen',()=>{
 const objects=[0,1].map(i=>({...entity,kind:'uam',source:'scenario',entity_id:`scenario:U${i}`,
  flight_phase:'cruise',position_ecef_m:[0,i*1450,36000]}));
 const {scene}=lodHarness(objects,20000);scene.updateLod(null);
 assert.equal(scene.stats.labels,2,'two-line labels move into separate slots');
 const [a,b]=scene.labelBounds;
 assert.ok(a.right<=b.left || b.right<=a.left || a.bottom<=b.top || b.bottom<=a.top,'full two-line bounds remain separate');
 scene.setDisplayOptions('uam',{status:false});scene.updateLod(null);
 assert.equal(scene.stats.labels,2,'single-line names can both fit in the same gap');
});
test('a zoomed-in view names nearby points in the small font',()=>{
 const {scene}=lodHarness(spread(),20000);
 scene.updateLod(null);
 const labels=scene.layers.aircraft.labels.values;
 assert.equal(labels.length,7,'every nearby point on screen is named');
 assert.ok(labels.every(label=>label.font==='10px sans-serif'));
 assert.deepEqual(labels.map(label=>label.text).sort(),['F0','F1','F2','F3','F4','F5','F6']);
 assert.equal(scene.stats.nearLabels,7);
});
test('motion retains existing names, defers new neighbors and always names the selection',()=>{
 const {scene}=lodHarness(spread(),20000);
 scene.updateLod('3',0,{moving:true});assert.equal(scene.stats.labels,1);assert.equal(scene.frameItems.length,7);
 scene.updateLod('3',250);assert.equal(scene.stats.labels,7);
 const labels=[...scene.layers.aircraft.labels.values];
 scene.updateLod('3',300,{moving:true});assert.deepEqual(scene.layers.aircraft.labels.values,labels);
});
test('motion keeps cold models eligible while prioritizing the selection and preserving warm models',()=>{
 const items=Array.from({length:3},(_,i)=>({...entity,entity_id:String(i),position_ecef_m:[i*100,0,1000]}));
 const {scene}=lodHarness(items,1000);scene.setAssets({assets:[{asset_id:'plane',size_m:100}]});
 scene.items.get('0').model={show:false};const loads=[];scene.loadModel=item=>loads.push(item.entity.entity_id);
 scene.updateLod('1',0,{moving:true});assert.equal(scene.items.get('0').lod,'model');
 assert.equal(scene.items.get('1').lod,'model');assert.equal(scene.items.get('2').lod,'model');assert.deepEqual(loads,['1','2']);
});

test('the configured model budget preserves full-detail selection and steps neighbors down to glyphs',()=>{
 const items=Array.from({length:80},(_,i)=>({...entity,entity_id:String(i),position_ecef_m:[i*4-160,0,1000]}));
 const {scene}=lodHarness(items,1000);scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb',size_m:100}]});
 scene.setPerformanceOptions({maxModels:8,maxResidentModels:12});scene.updateLod('79',0);
 assert.equal(scene.stats.models,8);assert.equal(scene.items.get('79').lod,'model');
 assert.ok([...scene.items.values()].some(item=>item.lod==='billboard'));
 assert.equal(scene.samples.entries.size,80,'the display budget does not remove simulated aircraft');
 scene.setPerformanceOptions({maxModels:32});scene.updateLod('79',250);assert.equal(scene.stats.models,32);
 assert.ok(scene.performance.maxResidentModels>scene.performance.maxModels);
});

test('a nearby glyph starts preparing its model before the model LOD threshold',()=>{
 const {scene}=lodHarness([{...entity,position_ecef_m:[0,0,1000]}],1000);
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb',size_m:8}]});
 const loads=[];scene.loadModel=item=>loads.push(item.entity.entity_id);scene.updateLod(null,0);
 assert.equal(scene.items.get('a').lod,'billboard');assert.deepEqual(loads,['a']);
 scene.setDisplayOptions('aircraft',{models:false});loads.length=0;scene.updateLod(null,250);
 assert.deepEqual(loads,[],'explicitly disabling 3D disables prefetch too');
});

test('transient model failure retries after cooldown without repeated retries every frame',async()=>{
 let calls=0;
 const engine={...C,Axis:{X:0,Y:1},Model:{fromGltfAsync:async()=>{calls++;throw new Error('network timeout');}}};
 const scene=new EntityScene(engine,{scene:{primitives:new Collection()}});scene.matrix=()=>({});
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb'}]});scene.replace({sequence:1,state_time:1,entities:[entity]});
 const item=scene.items.get('a');item.lod='model';
 await scene.loadModel(item,true);assert.equal(item.failed,true);
 for(let i=0;i<100;i++)await scene.loadModel(item,true);
 assert.equal(calls,1);
 item.modelRetryAt=0;await scene.loadModel(item,true);assert.equal(calls,2);
 item.modelRetryAt=0;await scene.loadModel(item,true);assert.equal(calls,3);
 item.modelRetryAt=0;await scene.loadModel(item,true);assert.equal(calls,3,'broken assets remain bounded');
 scene.destroy();
});

test('close glyph prefetch is ordered by screen size rather than snapshot insertion order',()=>{
 const {scene}=lodHarness([{...entity,entity_id:'far',position_ecef_m:[0,0,1300]},
   {...entity,entity_id:'near',position_ecef_m:[120,0,850]}],1000);
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb',size_m:8}]});
 const loads=[];scene.loadModel=item=>loads.push(item.entity.entity_id);scene.updateLod(null,0);
 assert.equal(scene.items.get('near').lod,'billboard');assert.deepEqual(loads,['near','far']);
});

test('GPU preparation retains the glyph, consumes the load budget, and switches immediately on readiness',async()=>{
 const resolvers=[],models=[];let renders=0;
 const engine={...C,Axis:{X:0,Y:1},Model:{fromGltfAsync:()=>new Promise(resolve=>resolvers.push(resolve))}};
 const scene=new EntityScene(engine,{scene:{primitives:new Collection(),requestRender(){renders++;}}});scene.matrix=()=>({});scene.icon=()=>({});
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb'}]});
 scene.replace({sequence:1,state_time:1,entities:Array.from({length:5},(_,i)=>({...entity,entity_id:String(i)}))});
 const items=[...scene.items.values()];for(const item of items)item.lod='model';
 const load=scene.loadModel(items[0]);let onReady;
 const model={ready:false,destroy(){},readyEvent:{addEventListener(fn){onReady=fn;return ()=>{onReady=null;};}},errorEvent:{addEventListener(){}}};
 resolvers.shift()(model);await load;models.push(model);
 assert.equal(items[0].billboard.show,true,'CPU parse must not erase the visible fallback');
 assert.equal(model.show,true,'GPU preparation can progress');assert.equal(scene.pendingModels,0);assert.equal(scene.preparingModels(),1);
 scene.modelsMoving=true;await scene.loadModel(items[1]);assert.equal(resolvers.length,0,'one unready model fills the moving budget');
 model.ready=true;const prior=renders;onReady();assert.equal(items[0].billboard.show,false);assert.ok(renders>prior);
 assert.equal(scene.preparingModels(),0);scene.destroy();assert.equal(onReady,null,'readiness listener removed with model');
});

test('moving loads stay bounded and a camera turn retains the late model for the next approach',async()=>{
 const resolves=[];
 const engine={...C,Axis:{X:0,Y:1},Model:{fromGltfAsync:()=>new Promise(resolve=>resolves.push(resolve))}};
 const scene=new EntityScene(engine,{scene:{primitives:new Collection()}});scene.matrix=()=>({});
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb'}]});
 scene.replace({sequence:1,state_time:1,entities:Array.from({length:20},(_,i)=>({...entity,entity_id:String(i)}))});
 scene.modelsMoving=true;for(const item of scene.items.values()){item.lod='model';scene.loadModel(item);}
 assert.equal(resolves.length,1);const item=scene.items.get('0');item.lod='hidden';
 const model={ready:true,destroy(){this.destroyed=true;},errorEvent:{addEventListener(){}}};resolves[0](model);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(item.model,model);assert.equal(model.show,false);assert.equal(model.destroyed,undefined);
 item.lod='model';scene.applyVisibility(item);assert.equal(model.show,true);assert.equal(resolves.length,1,'no second GLB load');scene.destroy();
});

test('warm residency evicts oldest unused models before selected or visible models',()=>{
 const {scene}=lodHarness(Array.from({length:4},(_,i)=>({...entity,entity_id:String(i)})));
 scene.setPerformanceOptions({maxModels:1,maxResidentModels:3,modelCacheSeconds:20});
 const items=[...scene.items.values()];items.forEach((item,i)=>{item.model={ready:true,destroy(){}};item.lastModelUse=i*1000;item.lod='hidden';scene.residentModels.add(item);});
 items[0].selected=true;scene.trimModels(6000);
 assert.ok(items[0].model);assert.equal(items[1].model,null,'oldest unselected entry evicted first');
 assert.ok(items[2].model);assert.ok(items[3].model);
 scene.trimModels(25000);assert.ok(items[0].model);assert.equal(scene.residentModels.size,1,'unused entries expire without evicting selection');scene.destroy();
});

test('warm ready models leave the render collection without destruction and return without a new load',async()=>{
 class OwnedCollection extends Collection {destroyPrimitives=true;remove(item){super.remove(item);if(this.destroyPrimitives)item.destroy();}}
 let loads=0,destroys=0;
 const model={ready:true,destroy(){destroys++;},errorEvent:{addEventListener(){}}};
 const engine={...C,PrimitiveCollection:OwnedCollection,Axis:{X:0,Y:1},Model:{fromGltfAsync:async()=>{loads++;return model;}}};
 const scene=new EntityScene(engine,{scene:{primitives:new Collection()}});scene.matrix=()=>({});
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb'}]});scene.replace({sequence:1,state_time:1,entities:[entity]});
 const item=scene.items.get('a');item.lod='model';await scene.loadModel(item);
 const collection=scene.layers.aircraft.models;assert.equal(collection.values.length,1);
 assert.deepEqual(scene.modelStats(),{residentModels:1,pendingModels:0,preparingModels:0,attachedModels:1,readyModels:1,warmModels:0});
 for(let i=0;i<20;i++){
   item.lod='hidden';scene.applyVisibility(item);assert.equal(collection.values.length,0,'offscreen warm cache performs no Cesium model updates');
   assert.deepEqual(scene.modelStats(),{residentModels:1,pendingModels:0,preparingModels:0,attachedModels:0,readyModels:0,warmModels:1});
   item.lod='model';scene.applyVisibility(item);assert.equal(collection.values.length,1);assert.equal(collection.values[0],model);
 }
 assert.equal(loads,1);assert.equal(destroys,0);assert.equal(collection.destroyPrimitives,true);
 item.lod='hidden';scene.applyVisibility(item);scene.destroy();assert.equal(destroys,1,'detached resources are still destroyed exactly once');
});

test('warm prefetch completes texture streaming before detaching and never mutates traversal from its event',async()=>{
 let ready,textures;
 const model={ready:false,destroy(){},errorEvent:{addEventListener(){}},
   readyEvent:{addEventListener(fn){ready=fn;}},texturesReadyEvent:{addEventListener(fn){textures=fn;}}};
 const engine={...C,Axis:{X:0,Y:1},Model:{fromGltfAsync:async()=>model}};
 const scene=new EntityScene(engine,{scene:{primitives:new Collection()}});scene.matrix=()=>({});
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb'}]});scene.replace({sequence:1,state_time:1,entities:[entity]});
 const item=scene.items.get('a');item.lod='billboard';await scene.loadModel(item);
 const collection=scene.layers.aircraft.models;model.ready=true;ready();
 assert.equal(model.show,false);assert.equal(collection.values.length,1,'warm geometry keeps processing its unfinished textures');
 textures();assert.equal(collection.values.length,1,'texture callback cannot splice Cesium traversal');
 scene.applyVisibility(item);assert.equal(collection.values.length,0);assert.equal(scene.modelStats().warmModels,1);
 scene.destroy();
});

test('a render-time model error exposes the fallback without removing a primitive during traversal',async()=>{
 let fail;
 const model={ready:false,destroy(){},errorEvent:{addEventListener(fn){fail=fn;}}};
 const engine={...C,Axis:{X:0,Y:1},Model:{fromGltfAsync:async()=>model}};
 const scene=new EntityScene(engine,{scene:{primitives:new Collection()}});scene.matrix=()=>({});
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb'}]});scene.replace({sequence:1,state_time:1,entities:[entity]});
 const item=scene.items.get('a');item.lod='model';await scene.loadModel(item);fail();
 assert.equal(item.point.show,true);assert.equal(model.show,false);assert.equal(scene.layers.aircraft.models.values.length,1);
 scene.applyVisibility(item);assert.equal(scene.layers.aircraft.models.values.length,0);scene.destroy();
});

test('a scale change invalidates an in-flight resource and cannot attach the old scale',async()=>{
 let finish;
 const engine={...C,Axis:{X:0,Y:1},Model:{fromGltfAsync:()=>new Promise(resolve=>finish=resolve)}};
 const scene=new EntityScene(engine,{scene:{primitives:new Collection()}});scene.matrix=()=>({});
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb',size_m:10}]});scene.replace({sequence:1,state_time:1,entities:[entity]});
 const item=scene.items.get('a');item.lod='model';const pending=scene.loadModel(item);scene.setModelSpans({plane:20});
 const model={destroy(){this.destroyed=true;}};finish(model);await pending;
 assert.equal(model.destroyed,true);assert.equal(item.model,null);assert.equal(item.failed,false);assert.equal(scene.pendingModels,0);scene.destroy();
});

test('subpixel rotor animation stops node work while measured tilt and selected detail remain live',()=>{
 const scene=new EntityScene(C,{scene:{primitives:new Collection()}});const calls=[];
 const item={entity:{entity_id:'a',flight_phase:'cruise'},rotorSpec:{},model:{ready:true},rotorsChecked:true,
   rotors:{advance(...args){calls.push(args);}},pixels:8,spunAt:1000,spinStateTime:1};
 let time=2;scene.samples.renderTime=()=>time;scene.samples.telemetryAt=()=>({rotor_radps:300,tilt_deg:45});
 scene.spinRotors(item,1016);assert.equal(calls[0][0],0);assert.equal(calls[0][2],Math.PI/4);
 item.selected=true;time=3;scene.spinRotors(item,1032);assert.equal(calls[1][0],.016);
 item.selected=false;item.pixels=40;time=4;scene.spinRotors(item,1048);assert.equal(calls[2][0],.016);
 time=4;scene.spinRotors(item,1064);assert.equal(calls[3][0],0,'paused simulation does not animate rotors');
 Object.assign(item.entity,{source:'physical_uam',quality:'stale',rotor_radps:300,tilt_deg:45});
 item.pixels=8;scene.spinRotors(item,1080);assert.equal(calls[4][0],0,'stale distant Physical blades still avoid node work');
 item.selected=true;scene.spinRotors(item,1096);assert.equal(calls[5][0],.016,'selected Physical blades use frame time');scene.destroy();
});
test('incremental scanning yields to the render-time budget before the item cap',()=>{
 const items=Array.from({length:5000},(_,i)=>({...entity,entity_id:String(i),position_ecef_m:[0,0,36000]}));
 const {scene}=lodHarness(items,20000);let refreshed=0;
 scene.refreshPosition=()=>{refreshed++;};
 scene.updateLod(null,0,{incremental:true,budgetMs:0});
 assert.ok(scene.lodScan);assert.ok(refreshed>0&&refreshed<=128,`bounded chunk, got ${refreshed}`);
 scene.updateLod(null,0,{incremental:false});assert.equal(scene.lodScan,null);
});
test('the same objects stay unlabelled from altitude and lose their labels on zoom out',()=>{
 const {scene,camera}=lodHarness(spread(),20000);
 scene.updateLod(null);assert.ok(scene.layers.aircraft.labels.values.length>0);
 camera.positionCartographic.height=500000;scene.updateLod(null);
 assert.equal(scene.layers.aircraft.labels.values.length,0,'names must not cover the map from far away');
 assert.equal(scene.stats.nearLabels,0);
});
test('objects beyond the near range are not labelled even when the camera is low',()=>{
 const far=[{...entity,entity_id:'far',name:'FAR',position_ecef_m:[0,0,120000]}];
 const {scene}=lodHarness(far,20000);scene.updateLod(null);
 assert.equal(scene.layers.aircraft.labels.values.length,0);
});
test('promoting a near label to the selection restyles the same object',()=>{
 const {scene}=lodHarness(spread(),20000);
 scene.updateLod(null);
 const before=scene.layers.aircraft.labels.values.find(value=>value.text==='F3');
 assert.equal(before.font,'10px sans-serif');
 scene.updateLod('3');
 const after=scene.layers.aircraft.labels.values.find(value=>value.text==='F3');
 assert.equal(after,before,'the label object is restyled, not leaked and recreated');
 assert.equal(after.font,'12px sans-serif');
 assert.equal(scene.layers.aircraft.labels.values.length,7);
 assert.equal(scene.stats.nearLabels,6);
});
test('the near-label budget bounds a dense field and never starves model labels',()=>{
 const dense=Array.from({length:400},(_,i)=>({...entity,entity_id:String(i),name:`D${i}`,
  position_ecef_m:[(i%20)*2000-20000,Math.floor(i/20)*2000-20000,36000]}));
 const {scene}=lodHarness(dense,20000);scene.updateLod(null);
 assert.ok(scene.stats.nearLabels<=50,`near labels capped, got ${scene.stats.nearLabels}`);
 assert.ok(scene.stats.nearLabels>0);
});

test('only the current band receives automatic labels and a visible selection survives the far view',()=>{
 const {scene,camera}=lodHarness([
  {...entity,position_ecef_m:[-8000,0,36000]},
  {...entity,entity_id:'s',kind:'satellite',name:'SAT',position_ecef_m:[8000,0,36000]}
 ],20000);
 scene.updateLod(null);
 assert.equal(scene.layers.aircraft.labels.values.length,1);
 assert.equal(scene.layers.satellite.labels.values.length,0);
 camera.positionCartographic.height=600000;scene.updateLod(null);
 assert.equal(scene.layers.aircraft.labels.values.length,0);
 assert.equal(scene.layers.satellite.labels.values.length,1);
 camera.positionCartographic.height=12000000;scene.updateLod('s');
 assert.equal(scene.layers.satellite.labels.values.length,1);
 scene.updateLod(null);assert.equal(scene.stats.labels,0);
});

test('labels reject overscan and globe-occluded targets even when selected',()=>{
 const {scene}=lodHarness([
  {...entity,entity_id:'edge',position_ecef_m:[37000,0,36000]},
  {...entity,entity_id:'hidden',position_ecef_m:[0,0,36000]},
  {...entity,entity_id:'visible',position_ecef_m:[-8000,0,36000]}
 ],20000);
 scene.updateLod(null);
 scene.occluder.isPointVisible=p=>p.x!==0;
 scene.updateLod('edge');
 assert.deepEqual(scene.layers.aircraft.labels.values.map(x=>x.id),['visible']);
});

test('long adjacent names do not overlap and satellite automatic labels share the 50-label cap',()=>{
 const entities=Array.from({length:100},(_,i)=>({...entity,entity_id:String(i),kind:'satellite',
  name:'STARLINK-LONG-NAME-'+i,position_ecef_m:[(i%10)*6000-27000,Math.floor(i/10)*6000-27000,36000]}));
 const {scene}=lodHarness(entities,600000);scene.updateLod(null);
 const labelled=[...scene.items.values()].filter(x=>x.label);
 assert.ok(labelled.length>0 && labelled.length<=50);
 const boxes=labelled.map(x=>({x:x.projection.x+8,y:x.projection.y-8-18,width:x.entity.name.length*10+16,height:18}));
 for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){
  const a=boxes[i],b=boxes[j];
  assert.ok(a.x+a.width<=b.x || b.x+b.width<=a.x || a.y+a.height<=b.y || b.y+b.height<=a.y,'label rectangles overlap');
 }
 scene.setLayerVisible('satellite',false);scene.updateLod(null);assert.equal(scene.layers.satellite.labels.values.length,0);
 assert.equal(scene.items.size,100);
});

test('scene retains label bands across small zoom changes and selected labels do not bypass globe occlusion',()=>{
 const {scene,camera}=lodHarness([{...entity,entity_id:'s',kind:'satellite',position_ecef_m:[0,0,36000]}],600000);
 scene.updateLod(null);assert.equal(scene.stats.labelBand,'satellite');
 camera.positionCartographic.height=325000;scene.updateLod(null);assert.equal(scene.stats.labelBand,'satellite');
 camera.positionCartographic.height=320000;scene.updateLod(null);assert.equal(scene.stats.labelBand,'aircraft');
 assert.equal(scene.stats.labels,0);
 camera.positionCartographic.height=350000;scene.updateLod(null);assert.equal(scene.stats.labelBand,'aircraft');
 camera.positionCartographic.height=355000;scene.updateLod(null);assert.equal(scene.stats.labelBand,'satellite');
 scene.updateLod('s');assert.equal(scene.stats.labels,1);
 scene.occluder.isPointVisible=()=>false;scene.updateLod('s');assert.equal(scene.stats.labels,0);
});

test('automatic model labels cannot bypass the category band or the far-view cutoff',()=>{
 const {scene,camera}=lodHarness([{...entity,position_ecef_m:[0,0,1000]}],600000);
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb',size_m:100}]});
 scene.updateLod(null);assert.equal(scene.items.get('a').lod,'model');assert.equal(scene.stats.labels,0);
 camera.positionCartographic.height=20000000;scene.updateLod(null);assert.equal(scene.stats.labels,0);
 scene.updateLod('a');assert.equal(scene.stats.labels,1);
});

test('the 50-label screen budget includes the selected label and gives it first priority',()=>{
 const entities=Array.from({length:64},(_,i)=>({...entity,entity_id:String(i),kind:'satellite',name:'S'+i,
  position_ecef_m:[(i%8)*8000-28000,Math.floor(i/8)*8000-28000,36000]}));
 const {scene}=lodHarness(entities,600000);scene.updateLod('63');
 assert.equal(scene.stats.labels,50);
 assert.equal(scene.stats.automaticLabels,49);
 assert.ok(scene.items.get('63').label);
});

test('aircraft names remain visible through two extra zoom-out steps',()=>{
 const {scene,camera}=lodHarness(spread(),150000);
 for(const height of [150000,225000,337500]){
  camera.positionCartographic.height=height;scene.updateLod(null);
  assert.equal(scene.layers.aircraft.labels.values.length,7);
 }
 camera.positionCartographic.height=360000;scene.updateLod(null);
 assert.equal(scene.layers.aircraft.labels.values.length,0);
});
test('tracking hides only surrounding names and releasing tracking restores the current band',()=>{
 const {scene}=lodHarness(spread(),20000);scene.updateLod('3');
 assert.equal(scene.stats.labels,7);const stateCount=scene.items.size;
 scene.updateLod('3',performance.now(),{tracking:true});
 assert.deepEqual(scene.layers.aircraft.labels.values.map(x=>x.id),['3']);
 assert.equal(scene.stats.automaticLabels,0);assert.equal(scene.frameItems.length,7);assert.equal(scene.items.size,stateCount);
 scene.updateLod('3',performance.now(),{tracking:false});assert.equal(scene.stats.labels,7);
});

test('changing tracking mode invalidates an in-progress LOD scan',()=>{
 const many=Array.from({length:5000},(_,i)=>({...entity,entity_id:String(i),position_ecef_m:[0,0,36000]}));
 const {scene}=lodHarness(many,20000);scene.updateLod('0',performance.now(),{incremental:true,tracking:false});
 assert.ok(scene.lodScan);const old=scene.lodScan;
 scene.updateLod('0',performance.now(),{incremental:true,tracking:true});assert.ok(scene.lodScan);assert.notEqual(scene.lodScan,old);assert.equal(scene.lodScan.tracking,true);
 while(scene.lodScan)scene.updateLod('0',performance.now(),{incremental:true,tracking:true});
 assert.equal(scene.stats.labels,1);assert.equal(scene.stats.automaticLabels,0);
});

test('satellite tracking suppresses neighboring labels without hiding points and restores them on release',()=>{
 const objects=spread().map(x=>({...x,kind:'satellite'}));
 const {scene,camera}=lodHarness(objects,600000);scene.updateLod('3');assert.equal(scene.stats.labels,7);
 scene.updateLod('3',performance.now(),{tracking:true});assert.equal(scene.stats.labels,1);assert.equal(scene.frameItems.length,7);
 scene.updateLod('3',performance.now(),{tracking:false});assert.equal(scene.stats.labels,7);
 camera.positionCartographic.height=12000000;scene.updateLod('3',performance.now(),{tracking:false});
 assert.equal(scene.stats.labels,1,'release respects the far-view cutoff rather than showing all names');
});

// A pursuit moves the camera every frame while a scan takes several frames.
test('the selection is never culled by a scan, even when its view no longer contains it',()=>{
 const {scene}=lodHarness([{...entity,position_ecef_m:[0,0,-1000]},{...entity,entity_id:'b',position_ecef_m:[0,0,-1000]}]);
 scene.updateLod('a');
 const a=scene.items.get('a'),b=scene.items.get('b');
 assert.notEqual(a.lod,'hidden','the pursued object must not blink out behind a stale view');
 assert.equal(b.lod,'hidden','an unselected object behind the camera is still culled');
 assert.ok(Number.isFinite(a.projection.x) && Number.isFinite(a.projection.y),'an unprojectable selection still has a screen anchor');
 scene.updateLod(null);
 assert.equal(a.lod,'hidden','once released it is culled like any other');
});
test('each incremental scan chunk re-reads the camera pose',()=>{
 const entities=Array.from({length:9000},(_,i)=>({...entity,entity_id:String(i),position_ecef_m:[0,0,100000]}));
 const {scene,camera}=lodHarness(entities);
 scene.updateLod(null,performance.now(),{incremental:true});assert.ok(scene.lodScan);
 camera.positionWC={x:0,y:0,z:5};
 scene.updateLod(null,performance.now(),{incremental:true});
 assert.equal(scene.view.z,5,'later chunks judge objects against where the camera is now');
});

// Near labels must remain readable when the selected model fills the screen.
test('selected model labels stay close, update on zoom and reset after model failure',()=>{
 const {scene,camera}=lodHarness([{...entity,position_ecef_m:[0,0,1000]}],20000);
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb',size_m:100}]});
 const item=scene.items.get('a');item.model={ready:true,boundingSphere:{radius:70,center:{x:0,y:0,z:1000}}};
 scene.updateLod('a');const label=item.label;
 assert.equal(label.disableDepthTestDistance,Infinity);
 assert.ok(label.pixelOffset.y<=-24 && label.pixelOffset.y>=-48,'model labels stay 24 to 48 pixels from the anchor');
 const previous=label.pixelOffset.y;camera.positionWC.z=700;scene.updateLod('a');
 assert.equal(item.label,label,'zoom repositions the same label');assert.ok(label.pixelOffset.y<previous);
 item.failed=true;scene.updateLod('a');assert.equal(item.label.disableDepthTestDistance,0);
 assert.equal(item.label.pixelOffset.y,-10);
});

test('a close selected model label remains inside the viewport but never reveals a globe-hidden target',()=>{
 const {scene}=lodHarness([{...entity,position_ecef_m:[0,0,1000]}],20000);
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb',size_m:3000}]});
 const item=scene.items.get('a');item.model={ready:true,boundingSphere:{radius:1500,center:{x:0,y:0,z:1000}}};
 scene.updateLod('a');
 assert.ok(Number.isFinite(item.label.pixelOffset.y));assert.ok(item.label.pixelOffset.y>=-48,'large wings must not push the name far away');
 assert.ok(item.projection.y+item.label.pixelOffset.y-16>=0,'label cannot disappear above screen');
 scene.occluder.isPointVisible=()=>false;scene.updateLod('a');
 assert.equal(item.label,null,'overlay labels still respect globe occlusion');
 assert.notEqual(item.lod,'hidden','the existing selected-model retention is unchanged');
});

test('an unready model uses catalog size without reading its unavailable bounding sphere',()=>{
 const {scene}=lodHarness([{...entity,position_ecef_m:[0,0,1000]}],20000);
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb',size_m:100}]});
 const item=scene.items.get('a');item.model={ready:false,get boundingSphere(){throw new Error('not ready');}};
 scene.updateLod('a');assert.ok(item.label.pixelOffset.y < -10);
 assert.equal(item.label.disableDepthTestDistance,Infinity);
});

// The name of a parked aircraft was being drawn inside the aircraft: only the
// selected one ignored depth, so every other name sank into its own model.
test('a model never buries its own name, and a distant name still obeys what is in front of it',()=>{
 const {scene}=lodHarness([{...entity,position_ecef_m:[0,0,1000]}],20000);
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb',size_m:100}]});
 const item=scene.items.get('a');item.model={ready:true,boundingSphere:{radius:70,center:{x:0,y:0,z:1000}}};
 // Not selected: the name still sits on top of the body it names.
 scene.updateLod(null);
 assert.equal(item.lod,'model');
 assert.equal(item.label.disableDepthTestDistance,MODEL_LABEL_DEPTH_M);
 assert.ok(MODEL_LABEL_DEPTH_M>0 && Number.isFinite(MODEL_LABEL_DEPTH_M),
   'bounded, so a name never floats over a building for something behind it');
 // Selected: the override the operator asked for, at any range.
 scene.updateLod('a');
 assert.equal(item.label.disableDepthTestDistance,Infinity);
 // Anything that is not a model obeys scene depth, as every other name on this
 // map does. A model whose file failed is one of those: it is drawn as a dot.
 item.failed=true;scene.updateLod(null);
 assert.equal(item.label.disableDepthTestDistance,0);
});

// Cesium 2D: objects are placed by map coordinates around the view centre.
function mapHarness(entities){
 const engine={...C,SceneMode:{SCENE2D:2,SCENE3D:3},Ellipsoid:{WGS84:{cartesianToCartographic:(p,r)=>{r.longitude=p.x/1e6;r.latitude=p.y/1e6;r.height=p.z;return r;}}},
  EllipsoidalOccluder:class {isPointVisible(){throw new Error('the occluder has no meaning on a map');}}};
 const camera={positionWC:{x:0,y:0,z:0},directionWC:{x:0,y:0,z:1},rightWC:{x:1,y:0,z:0},upWC:{x:0,y:1,z:0},
  positionCartographic:{longitude:.5,latitude:.25,height:99},frustum:{left:-1000,right:1000,bottom:-500,top:500}};
 const scene={primitives:new Collection(),mode:2,mapProjection:{project:(c,r)=>{r.x=c.longitude*1e6;r.y=c.latitude*1e6;r.z=0;return r;}}};
 const sceneObject=new EntityScene(engine,{scene,camera,canvas:{clientWidth:1000,clientHeight:500}});
 sceneObject.replace({sequence:1,state_time:1,entities});sceneObject.loadModel=()=>{};
 return {scene:sceneObject,camera};
}
test('on the map objects are culled by map coordinates and every object shares the view scale',()=>{
 const centre={...entity,entity_id:'c',name:'C',position_ecef_m:[500000,250000,0]};
 const east={...entity,entity_id:'e',name:'E',position_ecef_m:[500500,250000,0]};
 const far={...entity,entity_id:'f',name:'F',position_ecef_m:[600000,250000,0]};
 const {scene}=mapHarness([centre,east,far]);
 scene.updateLod(null);
 const c=scene.items.get('c'),e=scene.items.get('e'),f=scene.items.get('f');
 assert.notEqual(c.lod,'hidden');assert.equal(c.projection.x,500);assert.equal(c.projection.y,250);
 assert.notEqual(e.lod,'hidden');assert.ok(Math.abs(e.projection.x-750)<1e-6,'500 m east on a 2 km wide map is a quarter screen right');
 assert.equal(f.lod,'hidden','100 km east is off the map');
 assert.equal(c.distance,2000);assert.equal(e.distance,2000,'the map has one scale');
 assert.equal(scene.lodScan,null);
});
test('on the map the apparent size comes from the map height and the selection is never culled',()=>{
 const shown={...entity,entity_id:'m',name:'M',position_ecef_m:[500000,250000,0],visual_asset_id:'plane'};
 const away={...entity,entity_id:'x',name:'X',position_ecef_m:[900000,250000,0],visual_asset_id:'plane'};
 const {scene}=mapHarness([shown,away]);
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb',size_m:50}]});
 scene.updateLod('x');
 const m=scene.items.get('m'),x=scene.items.get('x');
 assert.equal(m.pixels,25,'50 m over a 1 km tall map of 500 px is 25 px');
 assert.equal(m.lod,'model');
 assert.notEqual(x.lod,'hidden','the selection stays even off the map');
 assert.equal(x.projection.x,500);assert.equal(x.projection.y,250);
});

test('transient tile failures are retried a couple of times; missing tiles are not',()=>{
 const network={timesRetried:0,error:{}};
 assert.equal(retryTile(network),true);assert.equal(network.retry,true);
 assert.equal(retryTile({timesRetried:1,error:{statusCode:503}}),true);
 assert.equal(retryTile({timesRetried:0,error:{statusCode:429}}),true);
 const missing={timesRetried:0,error:{statusCode:404}};
 assert.equal(retryTile(missing),false);assert.equal(missing.retry,undefined,'a tile that does not exist stays failed and the ancestor is drawn');
 assert.equal(retryTile({timesRetried:2,error:{}}),false,'retries are bounded');
 assert.equal(retryTile({message:'not a Cesium tile error'}),false);
 assert.equal(retryTile(undefined),false);
});

// Reported altitude below the rendered ground is drawn on the surface.
test('a low aircraft reported under the terrain is drawn on the surface while the state keeps the report',()=>{
 let lookups=0;
 const scene=new EntityScene(C,{scene:{primitives:new Collection(),globe:{getHeight(carto){lookups++;return carto.longitude>0?30:undefined;}}}},()=>{});
 const parked={...entity,entity_id:'p',latitude_deg:37.5,longitude_deg:126.4,altitude_m:-42,position_ecef_m:[3000000,4000000,0]};
 const unknown={...entity,entity_id:'u',latitude_deg:37.5,longitude_deg:-100,altitude_m:-42,position_ecef_m:[3000000,4000000,0]};
 const flying={...entity,entity_id:'f',latitude_deg:37.5,longitude_deg:126.4,altitude_m:1500,position_ecef_m:[3000000,4000000,0]};
 const satellite={...entity,entity_id:'s',kind:'satellite',latitude_deg:37.5,longitude_deg:126.4,altitude_m:-42,position_ecef_m:[3000000,4000000,0]};
 scene.replace({sequence:1,state_time:1,entities:[parked,unknown,flying,satellite]});
 for(const id of ['p','u','f','s'])scene.items.get(id).lod='point';
 scene.refreshPosition(scene.items.get('p'),1000);
 const p=scene.items.get('p').position;
 assert.ok(Math.abs(Math.hypot(p.x,p.y,p.z)-5000075)<1e-6,'lifted by ground 30 m plus 3 m clearance minus the -42 m report');
 assert.equal(scene.items.get('p').entity.altitude_m,-42,'the reported altitude is untouched');
 scene.refreshPosition(scene.items.get('u'),1000);
 const u=scene.items.get('u').position;assert.equal(Math.hypot(u.x,u.y,u.z),5000000,'no terrain loaded there: no lift');
 scene.refreshPosition(scene.items.get('f'),1000);
 const f=scene.items.get('f').position;assert.equal(Math.hypot(f.x,f.y,f.z),5000000,'an airborne aircraft above the ground is not moved');
 scene.refreshPosition(scene.items.get('s'),1000);
 const s=scene.items.get('s').position;assert.equal(Math.hypot(s.x,s.y,s.z),5000000,'satellites are never lifted');
 const before=lookups;scene.refreshPosition(scene.items.get('p'),1200);scene.refreshPosition(scene.items.get('p'),1400);
 assert.equal(lookups,before,'the terrain is sampled at most twice a second per aircraft');
 scene.refreshPosition(scene.items.get('p'),1600);assert.equal(lookups,before+1);
 scene.items.get('p').lod='hidden';scene.items.get('p').selected=false;
 scene.refreshPosition(scene.items.get('p'),2200);assert.equal(lookups,before+1,'hidden aircraft are not sampled');
});

// ---- the glyph tier ------------------------------------------------------
// A glTF model is its own draw call and only a couple of dozen are affordable.
// A whole collection of glyphs is one draw call whatever the count, so what
// used to fall off the model cliff straight to a three-pixel dot now lands on
// a glyph that still says which way it is going.
test('the middle tier is a batched glyph, made only when something reaches it', () => {
  const primitives = new Collection();
  const scene = new EntityScene(C, {scene: {primitives}}, () => {});
  scene.createCanvas = (width, height) => ({width, height, getContext: () => ({
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {}})});
  scene.replace({sequence: 1, state_time: 1, entities: [{...entity, kind: 'uam', source: 'scenario'}]});
  const item = scene.items.get('a');
  const layer = scene.layers.uam;

  // Nothing has needed one yet.
  assert.equal(layer.billboards.values.length, 0);
  assert.equal(item.billboard, undefined);

  item.lod = 'billboard';
  scene.applyVisibility(item);
  assert.equal(layer.billboards.values.length, 1, 'one billboard, in the shared collection');
  assert.equal(item.billboard.show, true);
  assert.equal(item.point.show, false, 'the glyph replaces the dot rather than sitting on it');

  // Back to a dot: the glyph is hidden, not rebuilt on the way up again.
  item.lod = 'point';
  scene.applyVisibility(item);
  assert.equal(item.billboard.show, false);
  assert.equal(item.point.show, true);
  assert.equal(layer.billboards.values.length, 1, 'kept, because the tier is crossed constantly');

  // And it goes when the entity does.
  scene.dropSource('scenario');
  assert.equal(layer.billboards.values.length, 0);
});

test('a model still arriving shows its glyph; one that failed shows the dot it was promised', () => {
  const scene = new EntityScene(C, {scene: {primitives: new Collection()}}, () => {});
  scene.createCanvas = (width, height) => ({width, height, getContext: () => ({
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {}})});
  scene.replace({sequence: 1, state_time: 1, entities: [{...entity, kind: 'uam'}]});
  const item = scene.items.get('a');

  // Promoted to a model, file not here yet: a glyph, not a three-pixel dot.
  item.lod = 'model';
  scene.applyVisibility(item);
  assert.equal(item.billboard.show, true);
  assert.equal(item.point.show, false);

  // The model arrives and takes over.
  item.model = {show: false};
  scene.applyVisibility(item);
  assert.equal(item.model.show, true);
  assert.equal(item.billboard.show, false);
  assert.equal(item.point.show, false);

  // It failed. The warning tells the operator it will be shown as a point, so
  // it is shown as a point: a broken asset should look broken.
  item.failed = true;
  scene.applyVisibility(item);
  assert.equal(item.model.show, false);
  assert.equal(item.billboard.show, false);
  assert.equal(item.point.show, true);
});

test('hovering shows on whatever the object is drawn as, not only on its dot',()=>{
 const scene=new EntityScene(C,{scene:{primitives:new Collection()}},()=>{});
 // An object near enough to be a model, with a glyph and a dot behind it: the
 // three ways one is drawn. Only the dot used to change, and the dot is hidden
 // while a model is showing -- so hovering an aircraft you could actually see
 // told you nothing.
 const item=()=>({entity,lod:'model',hovered:false,pixels:9,
  model:{silhouetteColor:null,silhouetteSize:-1},
  billboard:{scale:1,color:null},
  point:{show:true,pixelSize:0,outlineWidth:0,outlineColor:null}});

 const idle=item();scene.emphasise(idle,false);
 assert.equal(idle.model.silhouetteSize,0,'nothing marked, nothing outlined');
 assert.equal(idle.billboard.scale,1);

 const hovered=item();hovered.hovered=true;scene.emphasise(hovered,false);
 assert.ok(hovered.model.silhouetteSize>0,'the model gets an outline');
 assert.equal(hovered.model.silhouetteColor,'#9bdde8','in the accent the rest of the app uses');
 assert.ok(hovered.billboard.scale>1,'and the glyph grows');
 assert.equal(hovered.billboard.color,'#9bdde8');

 // A selection is marked too, but less loudly: the open card already says which
 // one it is, while a hover is answering "this is the one I am about to click".
 const selected=item();scene.emphasise(selected,true);
 assert.ok(selected.model.silhouetteSize>0);
 assert.ok(selected.model.silhouetteSize<hovered.model.silhouetteSize);
 assert.ok(selected.billboard.scale<hovered.billboard.scale);
 assert.notEqual(selected.model.silhouetteColor,hovered.model.silhouetteColor);

 // An object with no model or glyph yet is left alone rather than throwing.
 const bare={entity,lod:'point',hovered:true,pixels:1,point:{show:true,pixelSize:0,outlineWidth:0,outlineColor:null}};
 assert.doesNotThrow(()=>scene.emphasise(bare,false));
});

test('applyVisibility marks the object it is showing',()=>{
 const scene=new EntityScene(C,{scene:{primitives:new Collection()}},()=>{});
 const item={entity,lod:'model',hovered:true,pixels:9,failed:false,
  model:{show:false,silhouetteColor:null,silhouetteSize:-1},
  billboard:null,point:{show:false,pixelSize:0,outlineWidth:0,outlineColor:null}};
 scene.applyVisibility(item,false);
 assert.ok(item.model.silhouetteSize>0,'the emphasis travels with the visibility pass');
 assert.equal(item.point.outlineColor,'#9bdde8','and the dot uses the same colour as the rest');
});

test('destination priority keeps the configured moving GPU budget and blocks unrelated loads',async()=>{
 let count=0;const engine={...C,Axis:{X:0,Y:1},Model:{fromGltfAsync:async()=>{count++;return {ready:false,destroy(){},errorEvent:{addEventListener(){}}};}}};
 const scene=new EntityScene(engine,{scene:{primitives:new Collection()}});scene.matrix=()=>({});scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/a.glb'}]});
 scene.replace({sequence:1,state_time:1,entities:[entity,{...entity,entity_id:'b'}]});
 const a=scene.items.get('a'),b=scene.items.get('b');scene.destinationItems=new Set([b]);scene.modelsMoving=true;
 await scene.loadModel(a);assert.equal(count,0,'off-destination must not consume the preparation slot');
 await scene.loadModel(b,'destination');assert.equal(count,1);await scene.loadModel(a,'destination');assert.equal(count,1,'GPU ready=false occupies moving budget');
 scene.destroy();
});

test('actual vertiport entry respects moving model budgets zero and one before the first render',async()=>{
 const {DestinationPreparation}=await import('../../../../digital_twin/visualization/web/destination_preparation.js');
 const {LiveGlobe}=await import('../../../../digital_twin/visualization/web/globe.js');
 for(const budget of [0,1]){
  let loads=0;const engine={...C,Cartesian3:{...C.Cartesian3,fromDegrees:(x,y,z)=>({x,y,z})},BoundingSphere:class{},HeadingPitchRange:class{},Math:{toRadians:v=>v},Axis:{X:0,Y:1},Model:{fromGltfAsync:async()=>{loads++;return {ready:false,destroy(){},errorEvent:{addEventListener(){}}};}}};
  const scene=new EntityScene(engine,{scene:{primitives:new Collection()}});scene.matrix=()=>({});scene.performance.movingModelLoads=budget;
  scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/a.glb'}]});scene.replace({sequence:1,state_time:1,entities:[entity,{...entity,entity_id:'b'}]});
  const prep=new DestinationPreparation(scene),host={C:engine,entityScene:scene,destinationPreparation:prep,motion:{cancel(){}},stopTracking(){},select(){},viewer:{camera:{flyToBoundingSphere(){}}}};
  LiveGlobe.prototype.flyToVertiport.call(host,{longitude:1,latitude:2,altitude_m:3});assert.equal(loads,budget);
  prep.cancel();await new Promise(resolve=>setImmediate(resolve));scene.destroy();
 }
});

test('UAM names and status remain legible while tracking and moving at city scale',()=>{
 const objects=spread().map(x=>({...x,kind:'uam',flight_phase:'cruise'}));
 const {scene,camera}=lodHarness(objects,20000);
 scene.updateLod('3',performance.now(),{tracking:true,moving:true});
 assert.equal(scene.stats.labels,7);
 for(const item of scene.items.values()){
  assert.equal(item.label.font,'12px sans-serif');
  assert.ok(item.label.text.includes('\n'));
 }
 camera.positionCartographic.height=380000;
 scene.updateLod('3',performance.now(),{tracking:true});
 assert.equal(scene.stats.labels,7);
 scene.setDisplayOptions('uam',{labels:false,status:false});
 scene.updateLod('3');
 assert.equal(scene.stats.labels,0);
});

test('nearby UAM labels use alternative slots instead of dropping the second name',()=>{
 const objects=[0,1].map(i=>({...entity,entity_id:String(i),kind:'uam',name:'UAM000'+i,flight_phase:'cruise',position_ecef_m:[i*1000,0,36000]}));
 const {scene}=lodHarness(objects,20000);
 scene.updateLod(null);
 assert.equal(scene.stats.labels,2);
 assert.ok(scene.items.get('1').labelSlot>0);
});

test('LOD automatically retries a retained GPU-failed model without a layer toggle',async()=>{
 const {scene}=lodHarness([{...entity,position_ecef_m:[0,0,1000]}],1000);
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb',size_m:100}]});
 let calls=0,fail;
 scene.C.Axis={X:0,Y:1};scene.C.Model={fromGltfAsync:async()=>{
  calls++;return {ready:true,destroy(){},errorEvent:{addEventListener(fn){fail=fn;return ()=>{};}}};
 }};
 scene.matrix=()=>({});scene.loadModel=EntityScene.prototype.loadModel.bind(scene);
 scene.updateLod(null,0);await new Promise(resolve=>setTimeout(resolve,0));
 const item=scene.items.get('a');assert.equal(calls,1);fail();assert.equal(item.failed,true);
 item.modelRetryAt=0;scene.updateLod(null,1000);await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(calls,2,'normal LOD must reach cooldown retry even when a failed model object exists');
 assert.equal(item.failed,false);assert.equal(item.model.show,true);scene.destroy();
});

test('a scenario airframe is prepared once when the day first shows it, drawn out of sight and then kept',async()=>{
 const loads=[],models=[];
 const engine={...C,Axis:{X:0,Y:1},Matrix4:{fromTranslation:t=>({t})},Cartographic:{fromCartesian:()=>({longitude:1,latitude:2,height:0}),toCartesian:c=>({...c})},
  Model:{fromGltfAsync:async value=>{loads.push(value);const model={destroy(){},show:true,ready:true,errorEvent:{addEventListener(){}}};models.push(model);return model;}}};
 const uam=new Collection();
 const scene=new EntityScene(engine,{scene:{primitives:new Collection(),camera:{positionWC:{x:0,y:0,z:7e6},directionWC:{x:0,y:0,z:-1},positionCartographic:{height:120000}},globe:{getHeight:()=>40}}});
 scene.layers.uam.models=uam;
 scene.setAssets({assets:[{asset_id:'joby_s4',uri:'/visual-assets/joby.glb',size_m:8,flight_visual:{uri:'/visual-assets/joby_flight.glb',size_m:8,rotors:{nodes:[]}}},
  {asset_id:'a320',uri:'/visual-assets/a320.glb',size_m:38}]});
 const fleet=Array.from({length:6},(_,i)=>({...entity,entity_id:`uam-${i}`,kind:'uam',source:'scenario',visual_asset_id:'joby_s4',flight_phase:'parked'}));
 scene.replace({sequence:1,state_time:1,entities:[...fleet,{...entity,entity_id:'live-1',kind:'aircraft',source:'opensky',visual_asset_id:'a320'}]});
 for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(loads.length,1,'one anchor for six parked aircraft of the same airframe, none for live traffic');
 assert.equal(loads[0].url,'/visual-assets/joby_flight.glb','the articulated flight model, the one they will fly as');
 assert.equal(loads[0].id,'warm:joby_s4');
 assert.equal(loads[0].modelMatrix.t.height,40-200,'drawn under the ground, where the terrain hides it');
 const anchor=models[0];
 assert.equal(uam.values.includes(anchor),true);assert.equal(anchor.show,true,'drawn for a moment so its programs compile');
 scene.updatePositions(performance.now()+1000);
 assert.equal(anchor.show,false,'then hidden, but kept: buffers, textures and programs stay resident');
 scene.replace({sequence:2,state_time:2,entities:fleet});
 scene.trimModels(performance.now()+60000);
 assert.equal(uam.values.includes(anchor),true,'a trim of unused aircraft models leaves the anchor alone');
 assert.equal(loads.length,1,'the next snapshot does not ask again');
 scene.destroy();assert.equal(uam.values.includes(anchor),false);
});


// A UAM name floated over the buildings in front of it and was drawn at any
// range; the operator asked for the city to hide it and for a distance limit.
test('a UAM name is hidden by what is in front of it and past a few kilometres, unless selected',()=>{
 const near={...entity,entity_id:'u1',kind:'uam',name:'UAM1',position_ecef_m:[0,0,1000]};
 const far={...entity,entity_id:'u2',kind:'uam',name:'UAM2',position_ecef_m:[0,300,UAM_LABEL_FAR_M+500]};
 const {scene}=lodHarness([near,far],300);
 assert.equal(uamLabelRange(300),UAM_LABEL_FAR_M,'a street-level view names a few kilometres');
 assert.equal(uamLabelRange(20000),60000,'a view from twenty kilometres up names the city');
 scene.updateLod(null);
 const one=scene.items.get('u1'),two=scene.items.get('u2');
 assert.equal(one.label.disableDepthTestDistance,Infinity,'whole-label occlusion replaces partial glyph clipping');
 assert.ok(UAM_LABEL_DEPTH_M>0 && UAM_LABEL_DEPTH_M<1000,'only close up does the name sit on top of everything');
 assert.equal(two.label,null,'no name past the label range');
 scene.updateLod('u2');
 assert.equal(two.label.disableDepthTestDistance,Infinity,'the selected one keeps its name at any range, over anything');
 assert.equal(one.label.disableDepthTestDistance,Infinity);
});

// The operator saw every cabin class drawn at the same size on a deck. The
// scheduled day draws one shared flight rig, and all four airframes declared
// the same 8.123 m extent for it, so an eight-seater was the size of a
// two-seater and narrower than a four-seater. The rig is now scaled to the
// size each airframe's metadata gives its class.
test('the shared flight rig is scaled to its cabin class; an acquired model is drawn as authored',async()=>{
 const loads=[];
 const engine={...C,Axis:{X:0,Y:1},Model:{fromGltfAsync:async value=>{loads.push(value);return {destroy(){},errorEvent:{addEventListener(){}}};}}};
 const scene=new EntityScene(engine,{scene:{primitives:new Collection()}});scene.matrix=()=>({});
 scene.setAssets({assets:[
   {asset_id:'small',uri:'/visual-assets/small.glb',size_m:10.7,
    flight_visual:{uri:'/visual-assets/small_rig.glb',size_m:7,measured_m:7.352,rotors:{nodes:[]}}},
   {asset_id:'large',uri:'/visual-assets/large.glb',size_m:1.42,
    flight_visual:{uri:'/visual-assets/large_rig.glb',size_m:11.2,measured_m:7.352,rotors:{nodes:[]}}},
   {asset_id:'unmeasured',uri:'/visual-assets/other.glb',size_m:9,
    flight_visual:{uri:'/visual-assets/other_rig.glb',size_m:9,rotors:{nodes:[]}}}]});
 // A two-seat rig is drawn a little under the file, an eight-seat rig half as
 // big again: what the operator judges an aircraft by is its size on the deck.
 assert.ok(Math.abs(scene.scaleOf('small',true)-7/7.352)<1e-9);
 assert.ok(Math.abs(scene.scaleOf('large',true)-11.2/7.352)<1e-9);
 assert.ok(scene.scaleOf('large',true)>scene.scaleOf('small',true)*1.5,'the bigger cabin is visibly the bigger aircraft');
 assert.equal(scene.scaleOf('unmeasured',true),1,'a rig that never said what it measures is not guessed at');
 assert.equal(scene.scaleOf('small'),1,'the acquired library model keeps its documented size');
 assert.equal(scene.scaleOf('large'),1);
 // And the size the scene reasons about matches what it draws.
 assert.equal(scene.sizeOf('large',true),11.2);assert.equal(scene.sizeOf('large'),1.42);
 scene.replace({sequence:1,state_time:1,entities:[{...entity,entity_id:'b',kind:'uam',source:'scenario',visual_asset_id:'large'}]});
 const item=scene.items.get('b');item.lod='model';await scene.loadModel(item);
 const drawn=loads.at(-1);
 assert.equal(drawn.url,'/visual-assets/large_rig.glb');
 assert.ok(Math.abs(drawn.scale-11.2/7.352)<1e-9,'the model is loaded at the class scale, not at 1');
 assert.equal(drawn.scale,drawn.maximumScale);
 scene.destroy();
});

test('an explicit span still overrides the authored class size, and clearing it restores the class',()=>{
 const scene=new EntityScene(C,{scene:{primitives:new Collection()}});
 scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/a.glb',size_m:1.42,
   flight_visual:{uri:'/visual-assets/rig.glb',size_m:11.2,measured_m:7.352,rotors:{nodes:[]}}}]});
 scene.setModelSpans({plane:14.704});
 assert.equal(scene.scaleOf('plane',true),2,'a pushed span is measured against the rig it is drawn from');
 assert.equal(scene.sizeOf('plane',true),14.704);
 scene.setModelSpans({});
 assert.ok(Math.abs(scene.scaleOf('plane',true)-11.2/7.352)<1e-9);
 scene.destroy();
});
