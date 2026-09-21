import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeElement,fakeDocument} from './fake_dom.mjs';
import {PsuPanel} from '../../../../user_application/web/domains/uam/operations/psu_panel.js';
import {PsuOperations,clearanceState,operationTotals,until,blockingArrival} from '../../../../user_application/web/domains/uam/operations/psu_operations.js';
import {DeckDetail} from '../../../../user_application/web/domains/uam/operations/deck_detail.js';

const snapshot=()=>({time_s:1000,clock:'00:16:40',vertiports:Array.from({length:7},(_,i)=>({vertiport_id:`VP${i}`,holding:i,inbound:2,standing:1,pads_busy:i===0?['F1']:[]})),
  arrivals:Array.from({length:45},(_,i)=>({flight_id:`FL${i}`,aircraft_id:`UAM${i}`,vertiport:`VP${i%2}`,fato:'F1',stand:'G1',sequence:i+1,state:'cleared',phase:i%2?'cruise':'hold',
    requested_s:900,cleared_s:1000+i*10,eta_s:1020+i*10,approach_s:950+i*10,instruction:{clearance:i%2?'approach':'hold',clearance_reason:'선행기 분리'}}))});
const make=()=>{const document={...fakeDocument,body:new FakeElement('body')},nav=[];
 const view=new PsuOperations({document,onDeck:id=>nav.push(id),onFlight:r=>nav.push(r.aircraft_id)});view.render(document.body);view.update(snapshot(),{VP0:'여의도',VP1:'천호'});return {view,document,nav};};
test('hold diagnosis identifies a blocked predecessor on the same pad only',()=>{
 const row={flight_id:'B',vertiport:'V',fato:'F',cleared_s:100,phase:'hold'};
 const leader={flight_id:'A',aircraft_id:'UAM1',vertiport:'V',fato:'F',cleared_s:50,approach_started_s:0,instruction:{action:'wait_clear'}};
 assert.equal(blockingArrival(row,[leader]),leader);
 assert.equal(blockingArrival(row,[{...leader,fato:'G'}]),null);
 assert.equal(blockingArrival(row,[{...leader,released_s:90}]),null);
 assert.equal(clearanceState({...row,instruction:{action:'wait_clear'}}).label,'분리 확인 대기');
});
test('future slot never implies landing clearance; phase and pilot instruction determine state',()=>{
 assert.equal(clearanceState({state:'cleared',phase:'hold',instruction:{clearance:'approach'}}).id,'hold');
 assert.equal(clearanceState({state:'cleared',cleared_s:0}).id,'queued');
 assert.equal(clearanceState({instruction:{clearance:'land'}}).id,'land');
 assert.equal(operationTotals(snapshot()).holding,21);assert.equal(operationTotals(snapshot()).approach,22);
 assert.equal(until(1119.9,1000),'2분 0초 후');
});
test('pagination, search and actual-state filters bound long queues without losing arrivals',()=>{
 const {view}=make();assert.equal(view.flightRows.children.length,20);view.next.click();assert.match(view.count.textContent,/21–40/);
 view.next.click();assert.equal(view.flightRows.children.length,5);assert.equal(view.next.disabled,true);
 view.searchBox.oninput({target:{value:'UAM44'}});assert.equal(view.flightRows.children.length,1);
 view.searchBox.oninput({target:{value:''}});view.filters.querySelector('[data-filter=hold]').click();assert.match(view.count.textContent,/23편/);
 view.update(snapshot(),{}, {deckId:'VP1'});assert.equal(view.flightRows.children.length,0);
});
test('selection shows traffic reason and keeps map navigation an explicit action',()=>{
 const {view,nav}=make(),data=snapshot();data.arrivals[0].instruction={clearance:'hold',action:'yield',reason:'접근 전방교통',clearance_reason:'슬롯 대기',traffic_id:'UAM99',cpa_s:20,miss_m:30};
 view.update(data,{});view.flightRows.querySelector('button').click();assert.deepEqual(nav,[]);
 assert.match(view.inspector.textContent,/접근 전방교통/);assert.match(view.inspector.textContent,/UAM99/);
 view.inspector.querySelector('.psu-track-button').click();assert.deepEqual(nav,['UAM0']);
 view.update(data,{}, {error:'offline'});assert.match(view.health.textContent,/수신 지연/);assert.match(view.inspector.textContent,/최근 확인/);
});
test('sidebar stays a short summary; full operational data opens in Control Panel',()=>{
 const document={...fakeDocument,body:new FakeElement('body')},side=new FakeElement('aside');
 const session={data:{facilities:{},requests:[],history:[],server_time:0},subscribe:()=>()=>{},online:true};
 const panel=new PsuPanel({document,session});panel.decks=snapshot();panel.render(side);
 assert.equal(side.querySelectorAll('.psu-side-port').length,3);assert.equal(side.querySelector('input'),null);assert.equal(side.querySelector('table'),null);
 side.querySelector('.stakeholder-launch').click();assert.equal(panel.workspace,'live');assert.equal(panel.operations.flightRows.children.length,20);
 panel.practiceTab.click();assert.equal(panel.liveHost.inert,true);assert.equal(panel.practice.hidden,false);panel.destroy();
});
test('failed polling retains the last real snapshot and late reads cannot revive destroyed views',async()=>{
 let fail=false,resolve;const session={data:{facilities:{},requests:[]},subscribe:()=>()=>{}};
 const panel=new PsuPanel({document:fakeDocument,session,api:{scenarioVertiports:async()=>{if(fail)throw Error('offline');return snapshot();}}});
 await panel.readDecks();const before=panel.decks;fail=true;await panel.readDecks();assert.equal(panel.decks,before);assert.equal(panel.decksError,'수신 지연');
 panel.api.scenarioVertiports=()=>new Promise(r=>resolve=r);const pending=panel.readDecks();panel.destroy();resolve({arrivals:[]});await pending;assert.equal(panel.decks,before);
});
test('closing resources and returning to all decks clears the old deck and polling',async()=>{
 const detail=new DeckDetail({document:fakeDocument,api:{vertiport:async id=>({id}),occupancy:async()=>null}});
 const host=new FakeElement('div'),view=new PsuOperations({document:fakeDocument,deckView:detail});view.render(host);view.update(snapshot(),{}, {deckId:'VP0'});view.setMode('deck');
 await Promise.resolve();await Promise.resolve();assert.equal(detail.id,'VP0');detail.close();assert.equal(view.mode,'flow');
 view.setMode('deck');await Promise.resolve();await Promise.resolve();assert.equal(detail.id,'VP0');
 view.update(snapshot(),{});assert.equal(detail.id,null);assert.equal(detail.timer,null);view.destroy();
});
test('late layout and occupancy responses cannot overwrite a newer deck or restart closed polling',async()=>{
 const layouts={},reads={};const detail=new DeckDetail({document:fakeDocument,api:{vertiport:id=>new Promise(r=>layouts[id]=r),occupancy:id=>new Promise(r=>reads[id]=r)}});
 detail.render(new FakeElement('div'));const a=detail.open('A'),b=detail.open('B');
 layouts.B({id:'B'});await Promise.resolve();reads.B({vertiport_id:'B'});await b;layouts.A({id:'A'});await a;
 assert.equal(detail.record.id,'B');assert.equal(detail.deck.vertiport_id,'B');
 const old=detail.refresh();const c=detail.open('C');layouts.C({id:'C'});await Promise.resolve();reads.C({vertiport_id:'C'});await c;
 reads.B({vertiport_id:'B'});await old;assert.equal(detail.deck.vertiport_id,'C');
 const d=detail.open('D');detail.destroy();layouts.D({id:'D'});await d;assert.equal(detail.id,null);assert.equal(detail.timer,null);
});

test('PSU ground status ignores stale landing or holding permission and separates braking',()=>{
 const row={state:'cleared',phase:'gate_in',ground_waiting:true,
   instruction:{action:'ground_wait',reason:'도착 기체 통과 대기',clearance:'hold'}};
 assert.deepEqual(clearanceState(row),{id:'ground_wait',label:'지상 대기'});
 assert.deepEqual(clearanceState({...row,ground_waiting:false}),{id:'taxi',label:'지상 이동 · 감속'});
 assert.equal(clearanceState({phase:'gate_out',instruction:{clearance:'land'}}).id,'taxi');
 assert.equal(clearanceState({...row,state:'refused'}).id,'refused');
});

test('PSU inspector exposes ground reason, blocker and planned versus assigned gate without commands',()=>{
 const {view,nav}=make(),data=snapshot();
 data.arrivals[0]={...data.arrivals[0],phase:'gate_in',ground_waiting:true,stand:'G4',
   planned_stand:'G1',gate_revision:2,gate_reason:'계획 Gate 실제 점유',
   instruction:{action:'ground_wait',reason:'도착 기체 통과 대기',blocked_by:['UAM0070'],
     wait_seconds:8,stop_distance_m:27.5,distance_m:25,updated_s:999}};
 view.update(data,{});view.selectFlight('FL0');
 assert.match(view.inspector.textContent,/지상 대기/);assert.match(view.inspector.textContent,/도착 기체 통과 대기/);
 assert.match(view.inspector.textContent,/UAM0070/);assert.match(view.inspector.textContent,/계획 Gate/);
 assert.match(view.inspector.textContent,/G1/);assert.match(view.inspector.textContent,/배정 Gate/);
 assert.match(view.inspector.textContent,/G4/);assert.match(view.inspector.textContent,/계획 Gate 실제 점유/);
 assert.deepEqual(nav,[]);assert.doesNotMatch(view.inspector.textContent,/대기 유지/);
 view.update(data,{}, {error:'offline'});
 assert.match(view.inspector.textContent,/최근 확인/);assert.match(view.inspector.textContent,/도착 기체 통과 대기/);
 view.destroy();
});

test('PSU inspector shows only reported native guidance, never a low-speed diagnosis',()=>{
 const {view}=make(),data=snapshot();
 data.arrivals[1].guidance={available:true,reason:'approach_altitude_adjustment'};
 view.update(data,{});view.selectFlight('FL1');assert.match(view.inspector.textContent,/접근 고도 조절/);
 data.arrivals[1].guidance={available:false,reason:'approach_altitude_adjustment'};
 data.arrivals[1].speed_mps=0;view.update(data,{});
 assert.doesNotMatch(view.inspector.textContent,/접근 고도 조절|기수 정렬|역천이 안정화/);
 view.destroy();
});

test('PSU refusal preserves the actual reason when no pilot clearance instruction was issued',()=>{
 const {view}=make(),data=snapshot();
 data.arrivals[1]={...data.arrivals[1],state:'refused',phase:'descent',instruction:{},reason:'착륙 시설 사용 불가'};
 view.update(data,{});view.selectFlight('FL1');
 assert.match(view.inspector.textContent,/허가 보류/);assert.match(view.inspector.textContent,/착륙 시설 사용 불가/);
 view.destroy();
});

test('a received traffic wait outranks a generic refusal reason in the PSU inspector',()=>{
 const {view}=make(),data=snapshot();
 data.arrivals[1]={...data.arrivals[1],state:'refused',phase:'descent',reason:'일반 허가 보류',
   instruction:{action:'wait_clear',reason:'선행기 실제 분리 확인'}};
 view.update(data,{});view.selectFlight('FL1');
 assert.equal(view.inspector.querySelector('.psu-instruction').textContent,'선행기 실제 분리 확인');
 view.destroy();
});
test('PSU inspector distinguishes occupied-gate forecasts and initial approach from final clearance',()=>{
 const {view}=make(),data=snapshot();
 Object.assign(data.arrivals[0],{gate_release_aircraft_id:'UAM-DEPARTING',gate_available_s:data.time_s+25,stand:'G2',landing_staging:true,approach_mode:'initial'});
 view.update(data,{});view.flightRows.querySelector('button').click();
 assert.match(view.inspector.textContent,/UAM-DEPARTING/);assert.match(view.inspector.textContent,/선착륙/);
 assert.match(view.inspector.textContent,/초기 접근만 허가/);
 data.arrivals[0].gate_release_aircraft_id=null;data.arrivals[0].approach_mode='full';view.update(data,{});
 assert.doesNotMatch(view.inspector.textContent,/UAM-DEPARTING|초기 접근만 허가/);view.destroy();
});
