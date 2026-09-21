import test from 'node:test';
import assert from 'node:assert/strict';
import {pilotGuidance,manualArrivalHolding} from '../../../../user_application/web/domains/uam/operations/psu_pilot_guidance.js';
import {CockpitConsole} from '../../../../user_application/web/domains/uam/cockpit/cockpit_console.js';
import {fakeDocument} from './fake_dom.mjs';
import {ManualFlightSession} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_session.js';

const message=()=>({departed:true,airborne:true,clock:{state:'playing'},arrival:{eat_s:1,cleared_s:9999},
 instruction:{reason:'오래된 착륙 슬롯 대기'},procedure:{version:2,stage:'접근 요청 가능',text:'허가 전 접근 금지',reason:'지금 접근 허가를 요청하세요',tone:'hold',
 timeline:{now_s:100,landing_s:9999},next:{kind:'approach',label:'접근 허가 요청',enabled:true},reports:{report_airborne:1}}});

test('server procedure overrides stale scheduling prose; forecast never tells the pilot to start',()=>{
 const x=message(),v=pilotGuidance(x);
 assert.equal(v.reason,x.procedure.reason);assert.match(v.due,/아직 접근 허가 아님/);
 assert.doesNotMatch(v.due,/접근 시작|슬롯까지|지금 ·/);
 assert.match(v.landingLabel,/대기시간 아님/);
 x.procedure.next.enabled=false;
 assert.match(pilotGuidance(x).due,/접근 대기/);
 for(const patch of [{stale:true},{clock:{state:'paused'}},{pending:'approach'}]){
  const view=pilotGuidance({...message(),...patch});assert.equal(view.due,'');assert.equal(view.next.enabled,false);
 }
});

test('MFD dispatches approach separately and names the hold action honestly',()=>{
 const calls=[],c=new CockpitConsole({document:fakeDocument,onPsu:k=>calls.push(k)}),x=message();
 c.update({psu:x});c.departButton.click();assert.deepEqual(calls,['approach']);
 assert.match(c.holdButton.textContent,/중단/);assert.match(c.holdButton.title,/취소/);
 x.procedure.stage='접근 허가';x.procedure.next={kind:'landing',label:'최종 착륙 허가 요청',enabled:false};
 c.update({psu:x});c.departButton.click();assert.deepEqual(calls,['approach']);
});

test('audible advisory never announces approach start from the forecast clock',()=>{
 const said=[],s=Object.assign(Object.create(ManualFlightSession.prototype),{notify:t=>said.push(t)}),x=message();
 s.announceApproach(x);s.announceApproach(x);
 assert.equal(said.length,1);assert.match(said[0],/허가 전 접근 금지/);
 x.procedure.stage='접근 허가';x.procedure.text='도착 경로로 접근 · 최종 하강 금지';x.procedure.next.kind='landing';
 s.announceApproach(x);assert.match(said[1],/최종 하강 금지/);
});

test('retained holding-bay booking cannot hide the NAV route after approach clearance',()=>{
 const x=message();x.hold={slot:'R2-H1'};
 assert.equal(manualArrivalHolding(x),true);
 for(const stage of ['접근 허가','착륙 요청 가능','착륙 허가']){
  x.procedure.stage=stage;assert.equal(manualArrivalHolding(x),false);
 }
 x.procedure.stage='접근 보류';assert.equal(manualArrivalHolding(x),true);
});
