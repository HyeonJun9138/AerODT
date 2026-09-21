import test from 'node:test';
import assert from 'node:assert/strict';
import {screenTransform,screenCorners} from '../../../../digital_twin/visualization/web/cockpit_projection.js';
test('projected panel rejects crossed and concave quads whose homography crosses infinity',()=>{
 for(const p of [[[0,0],[100,100],[100,0],[0,100]],[[0,0],[100,0],[30,30],[0,100]]])
  assert.equal(screenTransform(p,100,100),null);
});
test('projected panel rejects edge-on subpixel area rather than leaving a click surface',()=>{
 assert.equal(screenTransform([[0,0],[100,0],[100,1e-6],[0,1e-6]],100,100),null);
});
test('projective matrix cannot contain NaN when source size is nonfinite',()=>{
 const p=[[0,0],[100,0],[100,100],[0,100]];
 assert.equal(screenTransform(p,Infinity,100),null);
 assert.equal(screenTransform(p,100,NaN),null);
});
test('screen metadata requires finite 3D center, positive dimensions and orthonormal axes',()=>{
 const s={center:[2,1,0],width:2,height:1};
 for(const invalid of [null,{}, {...s,center:[0,0]}, {...s,center:[0,Infinity,0]},
  {...s,width:0},{...s,height:NaN},{...s,right:[0,0,2]},
  {...s,up:[0,0,1]}, {...s,right:[NaN,0,0]}])assert.equal(screenCorners(invalid),null);
 assert.deepEqual(screenCorners(s),[[2,1.5,-1],[2,1.5,1],[2,.5,1],[2,.5,-1]]);
});
test('malformed pixel coordinates are rejected without throwing',()=>{
 for(const p of [null,[],[[0,0],[100,0],[100,100],null],[[0,0,0],[100,0],[100,100],[0,100]]])
  assert.equal(screenTransform(p,100,100),null);
});
test('valid skew and reversed winding keep finite projective interior and exact corners',()=>{
 const quads=[[[10,20],[220,30],[190,180],[30,170]],[[10,20],[30,170],[190,180],[220,30]]];
 for(const p of quads){
  const m=screenTransform(p,320,180);assert.ok(m?.every(Number.isFinite));
  for(const [i,[x,y]] of [[0,0],[320,0],[320,180],[0,180]].entries()){
   const w=m[3]*x+m[7]*y+1;assert.ok(w>0);
   assert.ok(Math.abs((m[0]*x+m[4]*y+m[12])/w-p[i][0])<1e-6);
   assert.ok(Math.abs((m[1]*x+m[5]*y+m[13])/w-p[i][1])<1e-6);
  }
 }
});
