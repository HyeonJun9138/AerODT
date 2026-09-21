import test from 'node:test';
import assert from 'node:assert/strict';
import {screenTransform,screenCorners} from '../../../../digital_twin/visualization/web/cockpit_projection.js';
test('screen corners follow authored Y-up coordinates without changing external scale',()=>{
 assert.deepEqual(screenCorners({center:[2,1,0],width:2,height:1,right:[0,0,1],up:[0,1,0]}),[[2,1.5,-1],[2,1.5,1],[2,.5,1],[2,.5,-1]]);
});
test('perspective transform exactly maps all four corners and rejects degenerate quads',()=>{
 const points=[[10,20],[220,30],[190,180],[30,170]],m=screenTransform(points,100,100);
 assert.equal(m.length,16);
 for(const [i,[x,y]] of [[0,0],[100,0],[100,100],[0,100]].entries()){
 const w=m[3]*x+m[7]*y+m[15]; assert.ok(Math.abs((m[0]*x+m[4]*y+m[12])/w-points[i][0])<1e-6);assert.ok(Math.abs((m[1]*x+m[5]*y+m[13])/w-points[i][1])<1e-6);
 }
 assert.equal(screenTransform([[0,0],[0,0],[0,0],[0,0]],100,100),null);
});
