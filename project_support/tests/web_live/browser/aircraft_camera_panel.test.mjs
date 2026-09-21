import test from 'node:test';
import {createRequire} from "node:module";const require=createRequire(import.meta.url);
import assert from 'node:assert/strict';
import {AircraftCameraPanel,cameraFrame} from '../../../../user_application/web/aircraft_camera_panel.js';
import {EntityScene} from '../../../../digital_twin/visualization/web/entity_scene.js';
import {visualModelChoice} from '../../../../digital_twin/visualization/web/visual_asset_loader.js';
import {FakeElement,fakeDocument} from './fake_dom.mjs';
function fixture(){const document={...fakeDocument,body:new FakeElement('body'),hidden:false};let created=0,revealed=0;const workspace={manage(){created++;return {minimized:false,shell:{hidden:false}};},release(){},reveal(){revealed++;}};const camera={stop(){},set(){},clear(){},destroy(){}};const panel=new AircraftCameraPanel({document,workspace,globe:{},Camera:class{constructor(){return camera;}},requestFrame:()=>1,cancelFrame:()=>{}});return {panel,created:()=>created,revealed:()=>revealed};}
test('removed capture feature leaves only the original camera controls',()=>{
 const {panel}=fixture();panel.select({entity_id:'u1',kind:'uam'},{selected:true});
 assert.equal(panel.capture,undefined);
 assert.equal(panel.root.querySelector('.ac-capture'),null);
 assert.ok(panel.aiButton);assert.ok(panel.buttons.front);panel.destroy();
});
test('explicit aircraft selection opens singleton camera with AI off; passive update and satellite do not',()=>{const f=fixture();f.panel.select({entity_id:'u1',kind:'uam'});assert.equal(f.created(),0);f.panel.select({entity_id:'s1',kind:'satellite'},{selected:true});assert.equal(f.created(),0);f.panel.select({entity_id:'u1',kind:'uam'},{selected:true});assert.equal(f.created(),1);assert.equal(f.panel.session.enabled,false);assert.equal(f.panel.mode,'front');f.panel.select({entity_id:'u1',kind:'uam'},{selected:true});assert.equal(f.created(),1);assert.equal(f.revealed(),1);f.panel.destroy();});
test('all five labeled directions and AI control exist; switching clears previous detection',()=>{const {panel}=fixture();panel.select({entity_id:'u1',kind:'uam'},{selected:true});for(const mode of ['front','rear','left','right','down']){assert.ok(panel.buttons[mode]);panel.setDirection(mode);assert.equal(panel.mode,mode);}panel.setAi(true);assert.equal(panel.session.enabled,true);panel.setDirection('rear');assert.equal(panel.result,null);panel.close();assert.equal(panel.session.enabled,false);});
test('single-flight camera uses actual display matrix while absent target returns no fabricated pose',()=>{const matrix=Array(16).fill(0),g={items:new Map(),flightLayer:{model:{ready:true,modelMatrix:matrix},plan:{aircraft:{asset_id:'a'}},sample:{position:{}},asset:()=>({cockpit:{forward:[1,0,0],up:[0,1,0]}})}};assert.equal(cameraFrame(g,{entity_id:'replay:r1',source:'replay'}).matrix,matrix);assert.equal(cameraFrame(g,{entity_id:'missing',kind:'uam'}),null);});


test('unready visual model bounds are not read during initial camera selection',()=>{
 const model={ready:false,get boundingSphere(){throw Error('not ready');}};
 const entity={entity_id:'u1',kind:'uam',quality:'nominal'},g={items:new Map([['u1',{entity,assetId:'a',model,position:{}}]]),entityScene:{assets:new Map([['a',{size_m:12}]]),matrix:()=>Array(16).fill(0),scaleOf:()=>1}};
 assert.equal(cameraFrame(g,entity).radius,6);
});

test('switching single-flight runs closes the old camera and mismatched plan never yields an image',()=>{
 const {panel}=fixture();panel.select({entity_id:'replay:A',source:'replay',kind:'uam'},{reopen:true});panel.observeReplay({entity_id:'replay:B',source:'replay'});assert.equal(panel.root,null);
 const a={},b={},g={flightLayer:{plan:b,sample:{position:{}},model:{ready:true,modelMatrix:[]},asset:()=>({})}};
 assert.equal(cameraFrame(g,{source:'replay'},a),null);
});

test('the picture is always the live frame; a detection answer only adds boxes over it',()=>{
 // The detector answers for a frame submitted earlier. Drawing that frame while
 // the answer was fresh, and the live one once it aged out, made the picture
 // step back in time on every answer - seen as "5 then back to 3".
 const {panel}=fixture();panel.select({entity_id:'u1',kind:'uam'},{selected:true});
 const drawn=[];const ctx={drawImage:(image)=>drawn.push(image),strokeRect(){},fillRect(){},fillText(){},measureText:()=>({width:10})};
 panel.canvas={getContext:()=>ctx};panel.raw={id:'live'};
 panel.setAi(true);drawn.length=0;
 panel.now=()=>5000;
 panel.result={result:{captured_at:4700,detections:[{box:[10,10,40,40],confidence:.9,class_name:'bird'}]},image:{id:'old'}};
 panel.paint();
 assert.deepEqual(drawn,[panel.raw],'the fresh answer is drawn over the live frame, never instead of it');
 panel.now=()=>7000;panel.paint();
 assert.deepEqual(drawn,[panel.raw,panel.raw],'an aged-out answer changes nothing about the picture');
 assert.equal(panel.result,null);
 panel.destroy();
});

test('the camera opens from its own button, not from picking an aircraft, and follows the selection once open',()=>{
 const {readFileSync}=require('node:fs');
 const html=readFileSync(new URL('../../../../user_application/web/index.html',import.meta.url),'utf8');
 const app=readFileSync(new URL('../../../../user_application/web/app.js',import.meta.url),'utf8');
 assert.match(html,/<button id="camera-live"[^>]*hidden[^>]*>기체 영상<\/button>/,'the button exists and starts hidden');
 assert.match(app,/\$\('camera-live'\)\.hidden=!AircraftCameraPanel\.supports\(entity\)/,'shown only for something that carries a camera');
 assert.match(app,/aircraftCamera\?\.select\(entity,\{selected:\(reopen\|\|selected\)&&Boolean\(aircraftCamera\.isOpen\)\}\)/,'a pick alone does not open it; an open camera follows the pick');
 assert.match(app,/\$\('camera-live'\)\.onclick=\(\)=>\{if\(AircraftCameraPanel\.supports\(cameraTarget\)\)aircraftCamera\?\.select\(cameraTarget,\{selected:true\}\);\}/,'the button opens it for the selected aircraft');
 // What carries a camera: the flying kinds, and nothing else.
 for(const kind of ['uam','aircraft','helicopter','drone'])assert.equal(AircraftCameraPanel.supports({kind}),true,kind);
 for(const kind of ['satellite','bird','vertiport',undefined])assert.equal(AircraftCameraPanel.supports({kind}),false,String(kind));
 assert.equal(AircraftCameraPanel.supports(null),false);
 const {panel}=fixture();
 assert.equal(panel.isOpen,false,'closed until asked');
 panel.select({entity_id:'u1',kind:'uam'},{selected:true});
 assert.equal(panel.isOpen,true);
 panel.close();assert.equal(panel.isOpen,false);
 panel.destroy();
});

// A flight rig and the base model are different files with different extents.
// The uri was taken unconditionally from the rig while the scale was chosen by
// a different predicate, so an injected intruder - which the map draws as the
// base model - was drawn in the camera as the rig at the base model's scale:
// 1.469x too small. camera_perception turns apparent size into range, so that
// aircraft was reported ~47% further away than it was, in the risk panel.
// The rule this pins: whatever file the frame will be drawn as, the frame's
// scale is that same file's number. The two are never chosen separately.
class Collection {
 values=[]; add(item){this.values.push(item);return item;} remove(item){this.values=this.values.filter(value=>value!==item);}
}
function scaleScene(){
 const colour={withAlpha:()=>colour};
 const C={PointPrimitiveCollection:Collection,LabelCollection:Collection,PrimitiveCollection:Collection,BillboardCollection:Collection,
  Cartesian2:class {constructor(x=0,y=0){Object.assign(this,{x,y});}},
  Cartesian3:{fromArray:(value,_offset,result={})=>Object.assign(result,{x:value[0],y:value[1],z:value[2]})},
  Color:{CYAN:colour,BLACK:colour,WHITE:colour,GRAY:{gray:true},fromCssColorString:value=>value}};
 const scene=new EntityScene(C,{scene:{primitives:new Collection()}});
 scene.matrix=()=>Array(16).fill(0);
 return scene;
}
const BASE_URI='/visual-assets/base.glb',RIG_URI='/visual-assets/flight_rig.glb';
// 11.752/8 = 1.469: the rig drawn at the base model's 1 is 1.469x too small.
const SCALED_ASSET={asset_id:'plane',uri:BASE_URI,size_m:12,
 flight_visual:{uri:RIG_URI,measured_m:8,size_m:11.752,rotors:{nodes:[]}}};
const uam=(entity_id,source)=>({entity_id,name:entity_id,kind:'uam',source,quality:'valid',position_ecef_m:[1,2,3],visual_asset_id:'plane'});
// What airframe_camera.js resolves the frame to, its own fallback included: a
// frame that names no file of its own is drawn from the flight rig.
const drawnUri=frame=>frame.uri??SCALED_ASSET.flight_visual.uri??SCALED_ASSET.uri;

test('the camera frame draws one model: its scale always belongs to the file it names',()=>{
 for(const span of [null,15]){
  const scene=scaleScene();scene.setAssets({assets:[SCALED_ASSET]});
  if(span)scene.setModelSpans({plane:span});
  const entities=[uam('u-scn','scenario'),uam('u-phy','physical_uam'),uam('u-int','intruder')];
  scene.replace({sequence:1,state_time:1,entities});
  const globe={items:scene.items,entityScene:scene};
  for(const entity of entities){
   const frame=cameraFrame(globe,entity),uri=drawnUri(frame),at=`${entity.source} @span=${span}`;
   // The loader's own pair for whichever file the frame named.
   const pair=visualModelChoice(SCALED_ASSET,{flight:uri===RIG_URI,span:span??undefined});
   assert.equal(uri,pair.uri,at);
   assert.equal(frame.scale,pair.scale,`${at}: ${uri} is drawn at ${frame.scale}, but that file measures ${pair.scale}`);
   // And it is the file the map draws, so the camera and the map agree.
   assert.equal(uri,scene.visualOf(scene.items.get(entity.entity_id)).uri,`${at}: camera and map draw different files`);
  }
  // The rig for the two the map articulates, the base model for the intruder.
  assert.deepEqual(entities.map(e=>drawnUri(cameraFrame(globe,e))),[RIG_URI,RIG_URI,BASE_URI],`@span=${span}`);
  scene.destroy();
 }
});

test('the scale follows the entity, not the model the map happens to be holding',()=>{
 // The map only rebuilds a model when the asset id changes, so an entity whose
 // source changes under it keeps a model built at the other file's scale. That
 // older answer must not reach the camera, which builds its own model from the
 // uri on the frame.
 const scene=scaleScene();scene.setAssets({assets:[SCALED_ASSET]});
 scene.replace({sequence:1,state_time:1,entities:[uam('u1','intruder')]});
 const item=scene.items.get('u1'),globe={items:scene.items,entityScene:scene};
 assert.equal(cameraFrame(globe,item.entity).scale,1,'the base model as authored');
 item.model={scale:1,ready:false,destroy(){}};item.modelAttached=true;
 scene.replace({sequence:2,state_time:2,entities:[uam('u1','physical_uam')]});
 assert.equal(scene.items.get('u1'),item,'same item');
 assert.equal(item.model?.scale,1,'the map is still holding the base model');
 const frame=cameraFrame(globe,item.entity),uri=drawnUri(frame),rig=visualModelChoice(SCALED_ASSET,{flight:true});
 assert.equal(uri,RIG_URI,'the camera now draws the rig');
 assert.equal(frame.scale,rig.scale,`the rig is drawn at ${frame.scale}, but the rig measures ${rig.scale}`);
 assert.equal(Number(frame.scale.toFixed(3)),1.469,'the size the intruder was missing');
 assert.equal(frame.uri,RIG_URI,'and the frame names the file it was measured as');
 scene.destroy();
});
