import test from 'node:test';
import assert from 'node:assert/strict';
import {surfaceRates,surfaceCommands} from '../../../../digital_twin/visualization/web/control_surface_pose.js';
import {DisplaySamples} from '../../../../digital_twin/visualization/web/display_samples.js';
import {EntityScene} from '../../../../digital_twin/visualization/web/entity_scene.js';
import {ManualFlightDisplay} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_display.js';

const pose=(t)=>({time_s:t,heading_deg:(359+20*t)%360,roll_deg:10*t,pitch_deg:5*t,
 tilt_deg:90,speed_mps:40,airborne:true,position:{longitude:127+t*.0004,latitude:37,altitude_m:100}});
test('observation rates wrap heading, reject absent values and remain bounded',()=>{
 assert.deepEqual(surfaceRates(pose(0),pose(.1),.1),{roll_rate_deg_s:10,pitch_rate_deg_s:5,yaw_rate_deg_s:20});
 assert.deepEqual(surfaceRates(null,pose(1),1),{roll_rate_deg_s:0,pitch_rate_deg_s:0,yaw_rate_deg_s:0});
 assert.equal(surfaceRates(pose(0),pose(1),0).yaw_rate_deg_s,0);
 assert.equal(surfaceRates(pose(0),pose(1),.001).yaw_rate_deg_s,120);
});
test('manual yaw and differential wing indications use native time, not frame cadence or input',()=>{
 const d=new ManualFlightDisplay(),s=pose(.1),copy=JSON.stringify(s);
 d.reset(pose(0),0);d.push(s,100);
 const a=d.sample(116),b=d.sample(160);
 assert.equal(a.yaw_rate_deg_s,20);assert.equal(b.yaw_rate_deg_s,20);
 assert.equal(a.roll_rate_deg_s,10);assert.ok(surfaceCommands(a).yaw>0);
 assert.equal(JSON.stringify(s),copy);
 const paused=d.sample(170,false);assert.equal(paused.yaw_rate_deg_s,20);
 assert.equal(d.sample(200,false).yaw_rate_deg_s,20);
});
function buffered(){
 const samples=new DisplaySamples();
 for(const t of [0,1,2])samples.replace({sequence:t+1,state_time:t,clock_rate:1,entities:[{
  ...pose(t),entity_id:'uam',source:'scenario',kind:'uam',orientation_source:'attitude',quality:'valid',
  position_ecef_m:[40*t,0,0],flight_phase:'cruise'}]},t*1000);
 return samples;
}
test('fleet surfaces sample the buffered pose rather than the newest packet and can seek backwards',()=>{
 const samples=buffered(),a=samples.controlSurfaceAt('uam',.5);
 assert.equal(a.roll_deg,5);assert.equal(a.speed_mps,40);assert.equal(a.yaw_rate_deg_s,20);
 samples.controlSurfaceAt('uam',1.8);
 assert.deepEqual(samples.controlSurfaceAt('uam',.5),a);
 assert.equal(samples.controlSurfaceAt('missing',1),null);
});
test('fleet renderer updates surface-only rigs independently from rotor animation',()=>{
 const seen=[],item={entity:{entity_id:'uam'},model:{ready:true},controlSurfaceSpec:{nodes:[{name:'wing'}]},
  controlSurfaces:{update:s=>seen.push({...s})}};
 const scene={samples:buffered()};scene.samples.renderTime=()=>.5;
 EntityScene.prototype.updateControlSurfaces.call(scene,item);
 assert.equal(seen.length,1);assert.equal(seen[0].roll_rate_deg_s,10);assert.equal(seen[0].airborne,true);
 assert.ok(surfaceCommands(seen[0]).yaw>0);
 item.model.ready=false;EntityScene.prototype.updateControlSurfaces.call(scene,item);assert.equal(seen.length,1);
});
test('single observation and discontinuity do not invent angular rates or speed',()=>{
 const samples=buffered();samples.replace({sequence:4,state_time:3,entities:[{
  ...pose(3),entity_id:'uam',source:'scenario',kind:'uam',orientation_source:'attitude',quality:'valid',
  position_ecef_m:[1e6,0,0],discontinuity:true}]},3000);
 const s=samples.controlSurfaceAt('uam',3);assert.equal(s.speed_mps,0);assert.equal(s.yaw_rate_deg_s,0);
 assert.deepEqual(surfaceCommands({...s,airborne:true}),{roll:0,pitch:0,yaw:0});
});
