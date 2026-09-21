import test from 'node:test';
import assert from 'node:assert/strict';
import {WholeLabelOcclusion} from '../../../../digital_twin/visualization/web/whole_label_occlusion.js';
function fixture(n=1){
 const C={Cartesian2:class{constructor(x,y){Object.assign(this,{x,y});}},SceneMode:{SCENE2D:2},SceneTransforms:{worldToWindowCoordinates:()=>({x:100,y:100})}};
 const scene={mode:3,pickPositionSupported:true,pickPosition:()=>({x:0,y:0,z:50})};
 const viewer={scene,camera:{positionWC:{x:0,y:0,z:0},directionWC:{x:0,y:0,z:1}},canvas:{clientWidth:500,clientHeight:500}};
 const items=new Map(Array.from({length:n},(_,i)=>[i,{entity:{kind:'uam'},lod:'model',position:{x:0,y:0,z:100},labelRect:{width:50,height:24},label:{show:true,text:'UAM',pixelOffset:{x:10,y:-10}}}]));
 return {C,scene,viewer,items,item:items.get(0),check:new WholeLabelOcclusion(C,viewer,items)};
}
test('building hides entire name and two clear observations restore it',()=>{
 const {scene,item,check}=fixture();check.update(0);assert.equal(item.label.show,false);
 scene.pickPosition=()=>undefined;check.update(160);assert.equal(item.label.show,false);check.update(320);assert.equal(item.label.show,true);
});
test('corner obstruction hides label even when its center is clear',()=>{
 const {scene,item,check}=fixture();let reads=0;scene.pickPosition=()=>++reads===2?{x:0,y:0,z:40}:undefined;check.update(0);assert.equal(item.label.show,false);
});
test('model skin and geometry behind aircraft do not hide name',()=>{
 const {scene,item,check}=fixture();for(const z of [99.5,120]){scene.pickPosition=()=>({x:0,y:0,z});check.update(z*200);assert.equal(item.label.show,true);}
});
test('2D and unavailable depth restore prior occlusion',()=>{
 for(const fallback of ['2d','depth']){const {scene,item,check}=fixture();check.update(0);assert.equal(item.label.show,false);if(fallback==='2d')scene.mode=2;else scene.pickPositionSupported=false;check.update(160);assert.equal(item.label.show,true);}
});
test('sampling is limited and rotates over aircraft',()=>{
 const {items,check}=fixture(5);check.update(0);assert.ok([...items.values()].filter(x=>x.labelOccluded).length<=2);
 for(let i=1;i<10;i++)check.update(i*160);assert.ok([...items.values()].every(x=>x.labelOccluded));
});
test('actual Cesium label bounds replace character estimates',()=>{
 const {C,scene,item,check}=fixture();C.Label={getScreenSpaceBoundingBox:()=>({x:200,y:200,width:40,height:20})};item.label.computeScreenSpacePosition=()=>({x:200,y:200});scene.pickPosition=p=>p.x===220&&p.y===210?{x:0,y:0,z:50}:undefined;check.update(0);assert.equal(item.label.show,false);
});
test('a hidden nameplate collection is not probed and keeps no name hidden',()=>{
 const collection={show:true};
 const {C,viewer,items,item}=fixture();
 const check=new WholeLabelOcclusion(C,viewer,items,()=>collection);
 check.update(0);assert.equal(item.label.show,false);
 // The cockpit puts the whole collection away. Nothing may be read from the
 // depth buffer for names nobody is drawing.
 collection.show=false;
 let reads=0;viewer.scene.pickPosition=()=>{reads++;return {x:0,y:0,z:50};};
 for(let i=1;i<6;i++)check.update(i*160);
 assert.equal(reads,0);
 // And what was hidden is given back, so leaving the cockpit shows every name.
 assert.equal(item.label.show,true);assert.equal(item.labelOccluded,false);
 collection.show=true;check.update(1000);assert.ok(reads>0);
});
