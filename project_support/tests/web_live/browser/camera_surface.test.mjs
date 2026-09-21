import test from 'node:test';
import assert from 'node:assert/strict';
import {pickGround,clearanceHeight,SurfaceReadiness} from '../../../../digital_twin/visualization/web/camera_surface.js';
test('camera range uses rendered terrain before ellipsoid fallback',()=>{
 const terrain={x:1},ellipsoid={x:2};let fallbacks=0;
 const camera={getPickRay:()=>({ray:true}),pickEllipsoid:()=>{fallbacks++;return ellipsoid;}};
 const scene={globe:{pick:()=>terrain}};
 assert.equal(pickGround(camera,scene,{},{}),terrain);assert.equal(fallbacks,0);
 scene.globe.pick=()=>undefined;assert.equal(pickGround(camera,scene,{},{}),ellipsoid);
});
test('camera ground clearance never confuses DEM height with sea level',()=>{
 assert.equal(clearanceHeight(105,100),120);assert.equal(clearanceHeight(200,100),200);
 assert.equal(clearanceHeight(-450,-430),-410);assert.equal(clearanceHeight(10,undefined),20);
});
test('buildings wait for initial terrain; nearby tile refinement does not flash; relocation gates again',()=>{
 const gate=new SurfaceReadiness();
 assert.equal(gate.update(false,true,{x:0,y:0,z:0},3000),false);
 assert.equal(gate.update(true,false,{x:0,y:0,z:0},3000),false);
 assert.equal(gate.update(true,true,{x:0,y:0,z:0},3000),true);
 assert.equal(gate.update(true,false,{x:10,y:0,z:0},300),true);
 assert.equal(gate.update(true,false,{x:100000,y:0,z:0},300),false);
 assert.equal(gate.update(true,true,{x:100000,y:0,z:0},300),true);
});

test('a pursuit across a city keeps the local surface; a distant jump waits again',()=>{
 const gate=new SurfaceReadiness();
 assert.equal(gate.update(true,true,{x:0,y:0,z:0},600),true);
 // 250 m/s for a minute, tiles never all finished while the camera moved.
 assert.equal(gate.update(true,false,{x:15000,y:0,z:0},600),true);
 assert.equal(gate.update(true,false,{x:25000,y:0,z:0},600),false,'beyond the region the terrain is unknown');
 assert.equal(gate.update(true,false,{x:0,y:0,z:0},30000),false,'altitude releases buildings regardless');
});
