
import test from 'node:test';import assert from 'node:assert/strict';
import {ManualFlightDisplay} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_display.js';
import {ManualFlightInput} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_input.js';
import {surfaceCommands} from '../../../../digital_twin/visualization/web/control_surface_pose.js';
const raw=t=>({manual:true,time_s:t,position:{longitude:127,latitude:37,altitude_m:100},heading_deg:0,pitch_deg:0,roll_deg:0,airborne:true,tilt_deg:0,speed_mps:0,control_surface_deg:[0,0,0,0]});
function run(d,start,end,command,fresh=true){let s;for(let now=start;now<=end;now+=16){if(fresh&&now%64===0)d.push(raw(now/1000),now);s=d.sample(now,true,command);}return s;}
test('full keyboard demand moves representative surfaces in hover while measured angles stay zero',()=>{
 const input=new ManualFlightInput({target:null});input.start();input.key({code:'ArrowRight',preventDefault(){}},true);
 const d=new ManualFlightDisplay();d.reset(raw(0),0);const s=run(d,16,480,input.update(.05));
 assert.ok(surfaceCommands(s).roll>19);assert.deepEqual(s.control_surface_deg,[0,0,0,0]);assert.equal(s.control_surface_display_source,'manual_input_visualization');
 assert.equal(surfaceCommands(s,false).roll,0,'NASA/unopted rig keeps native/proxy behavior');
 input.destroy();
});
test('screen stick, pitch/yaw, neutral return and finite clamping',()=>{
 const d=new ManualFlightDisplay();d.reset(raw(0),0);
 let s=run(d,16,480,{roll:-1,pitch:1,yaw:-1});let c=surfaceCommands(s);
 assert.ok(c.roll< -19&&c.pitch>19&&c.yaw< -19);
 s=run(d,496,976,{roll:0,pitch:0,yaw:0});assert.ok(Math.abs(surfaceCommands(s).roll)<.2);
 s=run(d,992,1472,{roll:Infinity,pitch:NaN,yaw:1e6});c=surfaceCommands(s);assert.ok(Number.isFinite(c.roll)&&c.yaw<=20);
});
test('pause holds pose; stale telemetry and ground lock withdraw demand',()=>{
 const d=new ManualFlightDisplay();d.reset(raw(0),0);
 const s=run(d,16,480,{roll:1,pitch:0,yaw:0});const frozen=d.sample(496,false,{roll:-1});
 assert.deepEqual(frozen.manual_surface_display_deg,s.manual_surface_display_deg);
 const stale=run(d,512,2000,{roll:1},false);assert.ok(Math.abs(surfaceCommands(stale).roll)<.1);
 const locked={...raw(2.016),ground_handling:{locked:true}};d.push(locked,2016);
 assert.ok(Math.abs(surfaceCommands(d.sample(2032,true,{roll:1})).roll)<.1);
});
test('visual control demand never contaminates source samples or automatic telemetry',()=>{
 const s=raw(0),snapshot=JSON.stringify(s),d=new ManualFlightDisplay();d.reset(s,0);d.sample(100,true,{roll:1});
 assert.equal(JSON.stringify(s),snapshot);assert.equal(s.manual_surface_display_deg,undefined);
 const auto={...raw(0),manual:false,control_surface_deg:[-3,3,4,2]};d.reset(auto,0);
 const display=d.sample(100,true,{roll:1});assert.equal(display.manual_surface_display_deg,undefined);assert.deepEqual(surfaceCommands(display),{roll:3,pitch:4,yaw:2});
});
