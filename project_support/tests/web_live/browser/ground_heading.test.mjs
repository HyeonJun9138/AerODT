import test from 'node:test';
import assert from 'node:assert/strict';
import {groundHeadingAt,groundMotionAt} from '../../../../user_application/web/flight_plan.js';
test('heading is sampled at the same arc distance without a temporal lag and wraps north',()=>{
  const p={headings_deg:[350,0,10],distances_m:[0,1,2]};
  assert.equal(groundHeadingAt(p,.25,9),355);assert.equal(groundHeadingAt(p,.75,1),5);
  assert.equal(groundHeadingAt(p,1,0),10);assert.equal(groundHeadingAt({},0,0),null);
});
test('initial heading alignment happens inside the stopped interval',()=>{
  const p={headings_deg:[0,0],distances_m:[0,10],times_s:[28,38],speeds_mps:[0,2],heading_alignment:{from_deg:180,duration_s:27}};
  assert.deepEqual(groundMotionAt(p,13.5),{fraction:0,speed:0});
  assert.equal(groundHeadingAt(p,0,13.5),90);assert.equal(groundHeadingAt(p,0,27),0);
});
