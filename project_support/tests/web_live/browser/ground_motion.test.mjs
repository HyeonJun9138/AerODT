import test from 'node:test';
import assert from 'node:assert/strict';
import {groundMotionAt} from '../../../../user_application/web/flight_plan.js';
test('ground timeline uses integrated speed and holds exact endpoints',()=>{
 const p={times_s:[2,4,6],distances_m:[0,2,4],speeds_mps:[0,2,0]};
 assert.deepEqual(groundMotionAt(p,0),{fraction:0,speed:0});
 assert.deepEqual(groundMotionAt(p,3),{fraction:.125,speed:1});
 assert.deepEqual(groundMotionAt(p,5),{fraction:.875,speed:1});
 assert.deepEqual(groundMotionAt(p,8),{fraction:1,speed:0});
});
