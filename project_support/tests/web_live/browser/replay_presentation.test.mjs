import test from 'node:test';import assert from 'node:assert/strict';
import {ReplayPresentation,replayDisplayEntity} from '../../../../user_application/web/replay_presentation.js';
const state=t=>({plan:{vehicle:{id:'A'},aircraft:{asset_id:'kp2a'}},run:{run_id:'one'},sample:{time_s:t,stage:'cruise',speed_mps:20,heading_deg:0,position:{latitude:37,longitude:127,altitude_m:100}}});
test('single replay opens full details and derives identity from run',()=>{
 const shown=[];const p=new ReplayPresentation({getJSON:async()=>null,onDetails:(e)=>shown.push(e),onSnapshot:()=>{},onPrediction:()=>{}});
 const s=state(10);p.update(s);p.pick();assert.equal(shown[0].entity_id,'replay:one');
 assert.equal(shown[0].altitude_m,100);assert.equal(replayDisplayEntity(s).visual_asset_id,'kp2a');
});
test('rewind invalidates an outstanding response and leaves live state untouched',async()=>{
 let resolve;const snapshots=[];
 const p=new ReplayPresentation({getJSON:()=>new Promise(r=>resolve=r),onDetails:()=>{},onSnapshot:s=>snapshots.push(s),onPrediction:()=>{}});
 const s=state(30);p.update(s);const promise=p.refresh(true);p.update({...s,sample:{...s.sample,time_s:2}});
 resolve({snapshot:{epoch:1,state_time:30,entities:[]},prediction:{}});await promise;
 assert.ok(!snapshots.some(s=>s?.state_time===30));
});
import {describeFlightReadouts} from '../../../../user_application/web/entity_details.js';
test('recorded scalar speed is labelled as recorded, not a measured ECEF vector',()=>{
 const e=replayDisplayEntity(state(10));const view=describeFlightReadouts(e);
 assert.equal(e.velocity_ecef_mps,null);
 assert.equal(view.cards.find(c=>c.key==='speed').label,'기록 속력');
});

test('manual samples request predictions and accept the same run/epoch response',async()=>{
 let request;const paths=[];
 const p=new ReplayPresentation({postJSON:async(url,body)=>{request={url,body};return {run_id:'one',snapshot:{epoch:body.epoch,state_time:body.seconds,entities:[]},prediction:{kind:'uam_prediction_comparison',predictions:[]}};},onPrediction:path=>paths.push(path)});
 const s=state(35);s.sample.manual=true;p.update(s);await p.refresh(true,{model:'uam_route_mlp_comparison'});
 assert.equal(request.body.seconds,35);assert.equal(request.url,'/api/simulation/runs/one/prediction');
 assert.equal(paths.at(-1).kind,'uam_prediction_comparison');
});
test('manual stop or disabled prediction invalidates an in-flight forecast',async()=>{
 let resolve;const paths=[];
 const p=new ReplayPresentation({postJSON:()=>new Promise(r=>resolve=r),onPrediction:x=>paths.push(x)});
 const s=state(35);s.sample.manual=true;p.update(s);const pending=p.refresh(true);
 const epoch=p.epoch;p.update({plan:null,run:null,sample:null});
 resolve({run_id:'one',snapshot:{epoch,state_time:35,entities:[]},prediction:{unexpected:true}});await pending;
 assert.ok(!paths.some(path=>path?.unexpected));
});
