import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveGlobe} from '../../../../digital_twin/visualization/web/globe.js';
import {selectedSoundSample} from '../../../../user_application/web/domains/uam/audio/entity_sound_controls.js';
test('external tracking exit also closes cockpit and resets the camera frame',()=>{
 let exited=0;
 const g={cockpit:{active:true,exit:()=>exited++},cameraSpring:{reset(){}},destinationPreparation:{cancel(){}},clearPreload(){},motion:{cancel(){}},viewer:{camera:{cancelFlight(){},lookAtTransform(){}}},C:{Matrix4:{IDENTITY:[]}}};
 LiveGlobe.prototype.stopTracking.call(g);assert.equal(exited,1);
});
test('cockpit sound follows pilot target, never a transient detail card',()=>{
 const a={entity_id:'a',kind:'uam'},b={entity_id:'b',kind:'uam'};
 const g={cockpit:{active:true,entityId:'a'},selected:'a',detailId:'b',items:new Map([['a',{entity:a,position:{x:0,y:0,z:0}}],['b',{entity:b,position:{x:0,y:0,z:0}}]]),entityScene:{layers:{uam:{}},samples:{renderTime:()=>NaN}},viewer:{camera:{positionWC:{x:1,y:0,z:0}}}};
 assert.equal(selectedSoundSample(g).entity.entity_id,'a');
});
