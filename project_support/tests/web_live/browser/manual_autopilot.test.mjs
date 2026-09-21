import test from 'node:test';
import assert from 'node:assert/strict';
import {CockpitConsole} from '../../../../user_application/web/domains/uam/cockpit/cockpit_console.js';
import {ManualFlightSession} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_session.js';
import {fakeDocument} from './fake_dom.mjs';

test('MFD AP uses acknowledged state and permits disengagement while paused',()=>{
 const actions=[],p=new CockpitConsole({document:fakeDocument,onControl:(...v)=>actions.push(v)});
 const controls={active:true,enabled:true,autopilotSupported:true};
 p.update({controls,telemetry:{airborne:false}});assert.equal(p.autopilotButton.disabled,true);
 p.update({controls,telemetry:{airborne:true}});p.autopilotButton.click();assert.deepEqual(actions.pop(),['autopilot',true]);
 assert.equal(p.autopilotButton.textContent,'AP OFF');
 p.update({controls:{...controls,active:false},telemetry:{airborne:true,autopilot:{enabled:true,target_speed_mps:55}}});
 assert.equal(p.autopilotButton.textContent,'AP ON');assert.equal(p.autopilotButton.disabled,false);
 p.autopilotButton.click();assert.deepEqual(actions.pop(),['autopilot',false]);
 p.update({controls:null});assert.equal(p.autopilotButton.hidden,true);p.destroy();
});

test('AP RPC accepts only matching acknowledgement, releases pending state and can switch off',()=>{
 const s=Object.create(ManualFlightSession.prototype),sent=[],samples=[];
 Object.assign(s,{groundSequence:0,readControls:()=>({autopilotSupported:true}),socket:{readyState:1,send:x=>sent.push(JSON.parse(x))},display:{push:x=>samples.push(x)},notify:()=>{}});
 try{
 s.setAutopilot(true);s.setAutopilot(true);assert.equal(sent.length,1);
 s.handleAutopilotAck({request_id:'stale',sample:{}});assert.equal(samples.length,0);assert.ok(s.autopilotPending);
 const sample={autopilot:{enabled:true}};
 s.handleAutopilotAck({request_id:sent[0].request_id,accepted:true,sample});
 assert.equal(s.autopilotPending,null);assert.equal(samples[0],sample);
 s.setAutopilot(false);assert.equal(sent[1].enabled,false);
 s.handleAutopilotAck({request_id:sent[1].request_id,accepted:false,message:'rejected'});
 assert.equal(s.autopilotPending,null);
 }finally{clearTimeout(s.autopilotTimer);}
});
