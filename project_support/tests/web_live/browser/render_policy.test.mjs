import test from 'node:test';
import assert from 'node:assert/strict';
import {projectView,projectMap,categoryRange,groundMarkerPixels,screenCell,nearLabelPolicy} from '../../../../digital_twin/visualization/web/render_policy.js';
const view={x:0,y:0,z:0,dx:0,dy:0,dz:1,rx:1,ry:0,rz:0,ux:0,uy:1,uz:0,width:1280,height:720,tanHalf:1,aspect:1280/720};
test('projection rejects the rear and screen exterior without allocating vectors',()=>{
 const out={};assert.equal(projectView({x:0,y:0,z:-10},view,out),false);
 assert.equal(projectView({x:100,y:0,z:1},view,out),false);
 assert.equal(projectView({x:0,y:0,z:10},view,out),true);assert.equal(out.x,640);assert.equal(out.y,360);
});
test('category ranges expand with camera altitude and selected object bypasses range limit',()=>{
 assert.ok(categoryRange('aircraft',1000)<categoryRange('aircraft',500000));
 assert.ok(categoryRange('satellite',1000)>categoryRange('aircraft',1000));
 assert.equal(categoryRange('aircraft',23000000),Infinity);
 assert.equal(screenCell(10,10,1280),screenCell(11,11,1280));
});

test('overscan bins do not alias the opposite edge of the next row',()=>{
 assert.notEqual(screenCell(1280,0,1280),screenCell(-20,5,1280));
});

test('automatic labels switch category by altitude and disappear beyond the orbital band',()=>{
 assert.equal(nearLabelPolicy(600000).kind,'satellite');
 assert.equal(nearLabelPolicy(337501).kind,'satellite');
 assert.equal(nearLabelPolicy(10000001),null);
 assert.equal(nearLabelPolicy(NaN),null);
 assert.equal(nearLabelPolicy(Infinity),null);
 assert.equal(nearLabelPolicy(337500).kind,'aircraft');
 const low=nearLabelPolicy(20000),high=nearLabelPolicy(120000);
 assert.ok(low.range<high.range,'a higher camera labels a wider area');
 assert.equal(nearLabelPolicy(1000).range,25000,'a floor keeps ground-level views usable');
 assert.ok(low.max>0 && Number.isFinite(low.max));
});

test('label bands retain the previous category inside a five percent transition margin',()=>{
 assert.equal(nearLabelPolicy(350000,'aircraft').kind,'aircraft');
 assert.equal(nearLabelPolicy(355000,'aircraft').kind,'satellite');
 assert.equal(nearLabelPolicy(325000,'satellite').kind,'satellite');
 assert.equal(nearLabelPolicy(320000,'satellite').kind,'aircraft');
 assert.equal(nearLabelPolicy(10200000,'satellite').kind,'satellite');
 assert.equal(nearLabelPolicy(10600000,'satellite'),null);
 assert.equal(nearLabelPolicy(9800000,'off'),null);
 assert.equal(nearLabelPolicy(9400000,'off').kind,'satellite');
});

test('aircraft labels extend two 1.5x zoom-out steps and both bands allow 50 names',()=>{
 const extended=150000*1.5**2;
 assert.equal(nearLabelPolicy(extended).kind,'aircraft');
 assert.equal(nearLabelPolicy(extended).max,50);
 assert.equal(nearLabelPolicy(extended+1).kind,'satellite');
 assert.equal(nearLabelPolicy(extended+1).max,50);
});
test('the map projection places the view centre mid-screen, scales by the frustum and rejects the exterior',()=>{
 const v={cx:1000,cy:2000,mapWidth:400,mapHeight:200,width:800,height:400};
 const out={};
 assert.equal(projectMap({x:1000,y:2000},v,out),true);assert.equal(out.x,400);assert.equal(out.y,200);assert.equal(out.depth,400);
 assert.equal(projectMap({x:1100,y:2050},v,out),true);assert.equal(out.x,600);assert.equal(out.y,100,'north is up');
 assert.equal(projectMap({x:1300,y:2000},v,out),false,'beyond the overscan');
 assert.equal(projectMap({x:NaN,y:2000},v,out),false);
});

// A marker for something that is really there on the ground has a size on the
// ground, not a size on the screen: pull the camera back and it goes away with
// the map under it, like the thing it stands for would.
test('a marker with a size on the ground shrinks as the camera pulls back, and stops at both ends',()=>{
 const clamp={min:3,max:9};
 assert.equal(groundMarkerPixels(120,5,clamp),9,'close in it is capped at the symbol it is');
 assert.equal(groundMarkerPixels(120,20,clamp),6,'further out it is the ground it covers');
 assert.equal(groundMarkerPixels(120,40,clamp),3,'twice as far again is half as wide');
 assert.equal(groundMarkerPixels(120,400,clamp),3,'and it stops where it can still be seen and pointed at');
 assert.equal(groundMarkerPixels(120,0,clamp),9,'a scale that is not known yet draws the symbol');
 assert.equal(groundMarkerPixels(120,NaN,clamp),9);
 assert.equal(groundMarkerPixels(NaN,20,clamp),9);
});
