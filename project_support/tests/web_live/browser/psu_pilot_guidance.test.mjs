import test from 'node:test';
import assert from 'node:assert/strict';
import {pilotGuidance,operationClock} from '../../../../user_application/web/domains/uam/operations/psu_pilot_guidance.js';
import {CockpitConsole} from '../../../../user_application/web/domains/uam/cockpit/cockpit_console.js';
import {fakeDocument} from './fake_dom.mjs';
import {ManualFlightSession} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_session.js';
const message=()=>({flight_id:'F1',departed:true,airborne:false,clock:{state:'playing'},
 procedure:{stage:'지상 이동 허가',text:'F1로 지상 이동 · 이륙은 별도 허가',tone:'info',reason:'',
 timeline:{now_s:23400,off_block_s:23400,ready_s:23400,takeoff_s:23460,landing_s:null},
 next:{kind:'takeoff',label:'FATO 도착 · 이륙 요청',enabled:true},origin:'VP1',destination:'VP2',departure_fato:'F1',departure_gate:'G4',arrival_fato:'F2',arrival_gate:'G3',reports:{},communications:[]}});
test('PSU reservation is explicitly movement permission with plan and slot clocks',()=>{
 const x=message(),v=pilotGuidance(x);
 assert.equal(v.stage,'지상 이동 허가');assert.match(v.text,/별도 허가/);
 assert.equal(v.now,'06:30:00 KST');assert.equal(v.takeoff,'06:31:00');assert.equal(v.landing,'미정');
 assert.equal(operationClock(0),'00:00:00');assert.equal(operationClock(86401),'+1일 00:00:01');
 assert.equal(operationClock(null),'미정');
});
test('stale, stopped and missing procedure cannot present an actionable clearance',()=>{
 for(const patch of [{stale:true},{error:'수신 실패'},{clock:{state:'paused'}},{procedure:null}]){
  const v=pilotGuidance({...message(),...patch});assert.equal(v.next.enabled,false);
 }
 assert.match(pilotGuidance({...message(),stale:true}).text,/재확인/);
});
test('MFD next report dispatches actual action and separates slot details from current instruction',()=>{
 const calls=[],c=new CockpitConsole({document:fakeDocument,onPsu:k=>calls.push(k)});
 const x=message();c.update({psu:x});
 assert.equal(c.psuState.textContent,'지상 이동 허가');assert.equal(c.psuDepartState,undefined);
 assert.match(c.psuArriveNote.textContent,/G4/);assert.equal(c.psuCommsBody.hidden,true);
 c.departButton.click();assert.deepEqual(calls,['takeoff']);
 x.procedure.next={kind:'report_airborne',label:'이륙 완료 보고',enabled:false};c.update({psu:x});
 c.departButton.click();assert.deepEqual(calls,['takeoff']);
 x.clock.state='paused';c.update({psu:x});assert.equal(c.clockButton,undefined);
 assert.match(c.psuNotice.textContent,/상단 SIM/);assert.deepEqual(calls,['takeoff']);
});
test('a new blocked response replaces previous permission and shows its reason and history',()=>{
 const c=new CockpitConsole({document:fakeDocument});let x=message();c.update({psu:x});
 x.procedure={...x.procedure,stage:'FATO 대기',text:'이륙 보류',tone:'hold',reason:'다른 기체 패드 점유',
 next:{kind:'takeoff',label:'이륙 허가 재요청',enabled:true},
 communications:[{time_s:23450,kind:'takeoff',state:'hold',reason:'다른 기체 패드 점유'}]};
 c.update({psu:x});assert.equal(c.psuState.textContent,'FATO 대기');
 assert.match(c.psuNotice.textContent,/패드 점유/);assert.match(c.psuHistory.textContent,/06:30:50/);
});

test('queued departure displays review time, blocker and cancellation without a second request',()=>{
 const x=message();x.departed=false;
 x.procedure={...x.procedure,stage:'출발 배정 대기',text:'자동 재검토 중',tone:'hold',
  reason:'VP1 F1 출발 경로 확보 대기 · 선행 기체 UAM0005',
  next:{kind:'departure',label:'요청 접수됨 · 자동 배정 대기',enabled:false}};
 const calls=[],c=new CockpitConsole({document:fakeDocument,onPsu:k=>calls.push(k)});
 c.update({psu:x});
 assert.match(c.psuNotice.textContent,/UAM0005/);
 assert.equal(c.departButton.disabled,true);assert.equal(c.holdButton.disabled,false);
 assert.equal(c.holdButton.textContent,'출발 요청 취소');c.holdButton.click();
 assert.deepEqual(calls,['hold']);assert.match(pilotGuidance(x).due,/이동 불가/);
 x.procedure.timeline.ready_s+=90;
 assert.match(pilotGuidance(x).due,/배정 검토.*출발 허가 아님/);
});

test('failed POST remains visible after successful automatic poll until explicit refresh',async()=>{
 const prior=globalThis.fetch;
 const s=Object.assign(Object.create(ManualFlightSession.prototype),{twin:'A1',generation:1,notify:()=>{}});
 globalThis.fetch=async(_url,options)=>options.method==='POST'
  ? {ok:false,json:async()=>({message:'요청 처리 실패'})}
  : {ok:true,json:async()=>message()};
 try{
  await s.requestPsu('departure');
  assert.match(s.readPsu().error,/요청 처리 실패/);
  await s.pollPsu();assert.match(s.readPsu().error,/접수 여부/);
  await s.requestPsu('refresh');assert.equal(s.readPsu().error,null);
 }finally{globalThis.fetch=prior;}
});
