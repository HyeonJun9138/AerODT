import test from 'node:test';
import assert from 'node:assert/strict';
import {surfaceCommands} from '../../../../digital_twin/visualization/web/control_surface_pose.js';
import {readRun,sampleRun} from '../../../../user_application/web/flight_plan.js';
import {readFileSync} from 'node:fs';
const active={airborne:true,tilt_deg:90,speed_mps:40,roll_rate_deg_s:10,pitch_rate_deg_s:5,yaw_rate_deg_s:4};
test('surface indication is neutral on ground and during VTOL, bounded at cruise',()=>{
 assert.deepEqual(surfaceCommands({...active,airborne:false}),{roll:0,pitch:0,yaw:0});
 assert.deepEqual(surfaceCommands({...active,tilt_deg:0}),{roll:0,pitch:0,yaw:0});
 assert.deepEqual(surfaceCommands(active),{roll:8,pitch:4,yaw:2});
 assert.equal(surfaceCommands({...active,roll_rate_deg_s:1e6}).roll,18);
 assert.equal(surfaceCommands({...active,speed_mps:0}).pitch,0);
 assert.deepEqual(surfaceCommands(active),surfaceCommands({...active,time_s:-200}),'seeking is deterministic');
});
test('native roll and wrapped angular rates survive replay interpolation',()=>{
 const states=[0,1,2].map((t)=>({t,kind:'air',stage:'cruise',latitude:37,longitude:127,altitude_m:300,heading_deg:(359+t)%360,roll_deg:2*t,pitch_deg:t,tilt_deg:90,speed_mps:40}));
 const r=readRun({legs:[]},states);assert.equal(r[1].yaw_rate_deg_s,1);assert.equal(r[1].roll_rate_deg_s,2);
 const a=sampleRun(r,.5);assert.equal(a.roll_deg,1);assert.equal(a.yaw_rate_deg_s,1);
 assert.equal(readRun({legs:[]},[{...states[0],roll_deg:undefined}])[0].roll_deg,0);
});
test('all supported UAM surface nodes exist and are distinct from rotor nodes',()=>{
 const expected={joby_s4:8,kp2a:4,amvlab_evtol:4};
 for(const [id,count] of Object.entries(expected)){
  const base=new URL(`../../../../digital_twin/model_library/visual_assets/aircraft/civilian/${id}/`,import.meta.url);
  const meta=JSON.parse(readFileSync(new URL('asset.json',base))),rig=meta.flight_visual.rotors;
  const bytes=readFileSync(new URL(meta.flight_visual.path,base));const doc=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)));
  assert.equal(rig.control_surfaces.nodes.length,count);
  for(const s of rig.control_surfaces.nodes){
   assert.ok(doc.nodes.some(n=>n.name===s.name));assert.ok(!rig.nodes.some(n=>n.name===s.name));
   assert.equal(s.limit_deg,20);assert.ok(Math.hypot(...s.axis)>0);
  }
 }
});

test('native actuator angles bypass VTOL suppression and invalid telemetry falls back',()=>{
 assert.deepEqual(surfaceCommands({airborne:false,tilt_deg:0,speed_mps:0,control_surface_deg:[-9,9,3,-2]}),{roll:9,pitch:3,yaw:-2});
 assert.deepEqual(surfaceCommands({...active,control_surface_deg:[NaN,0,0,0]}),surfaceCommands(active));
 assert.deepEqual(surfaceCommands({...active,control_surface_deg:[-9,9,3,-2]},false),surfaceCommands(active));
});
test('surface telemetry interpolates during replay without stale channels',()=>{
 const states=[0,1].map(t=>({t,kind:'air',stage:'cruise',latitude:37,longitude:127,altitude_m:300,heading_deg:0,control_surface_deg:t?[10,-10,4,2]:[-10,10,0,0]}));
 assert.deepEqual(sampleRun(readRun({legs:[]},states),.5).control_surface_deg,[0,0,2,1]);
 delete states[1].control_surface_deg;
 assert.equal(sampleRun(readRun({legs:[]},states),.5).control_surface_deg,null);
});

test('fleet buffer interpolates actual channels and reset drops old actuator state',async()=>{
 const {DisplaySamples}=await import('../../../../digital_twin/visualization/web/display_samples.js');
 const d=new DisplaySamples();
 const send=(t,angles,epoch=0)=>d.replace({sequence:t+1,state_time:t,clock_rate:1,epoch,entities:[{entity_id:'u',kind:'uam',source:'scenario',position_ecef_m:[t,0,0],control_surface_deg:angles}]},t*1000);
 send(0,[-10,10,2,0]);send(1,[10,-10,4,2]);
 assert.deepEqual(d.controlSurfaceAt('u',.5).control_surface_deg,[0,0,3,1]);
 send(2,null);assert.equal(d.controlSurfaceAt('u',2).control_surface_deg,null);
 send(0,null,1);assert.equal(d.controlSurfaceAt('u',0).control_surface_deg,null);
});
test('manual display smooths actuator packets without extrapolating or mutating observations',async()=>{
 const {ManualFlightDisplay}=await import('../../../../user_application/web/domains/uam/cockpit/manual_flight_display.js');
 const d=new ManualFlightDisplay(),s=t=>({time_s:t,heading_deg:0,airborne:true,position:{longitude:127,latitude:37,altitude_m:100},control_surface_deg:[t*100,-t*100,0,0]});
 d.reset(s(0),0);const latest=s(.1);d.push(latest,100);const a=d.sample(116);
 assert.ok(a.control_surface_deg[0]>0&&a.control_surface_deg[0]<=10);
 assert.deepEqual(latest.control_surface_deg,[10,-10,0,0]);
 assert.deepEqual(d.sample(120,false).control_surface_deg,[10,-10,0,0]);
});
