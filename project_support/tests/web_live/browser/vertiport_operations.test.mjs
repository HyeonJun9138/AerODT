import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeElement,fakeDocument} from './fake_dom.mjs';
import {VertiportPanel} from '../../../../user_application/web/domains/uam/operations/vertiport_panel.js';
import {StakeholderPanel} from '../../../../user_application/web/domains/uam/operations/stakeholder_panel.js';
import {LiveGlobe} from '../../../../digital_twin/visualization/web/globe.js';
import {uprightLayout,chargerLabels} from '../../../../user_application/web/vertiport_layout_view.js';
import {MINUTE,resourcesOf,rehearsalSchedule,resourceState,nearestWeather,weatherSymbol,reportDraft} from '../../../../user_application/web/vertiport_operations.js';
const now=Date.parse('2026-09-10T08:30:00Z');
const record={id:'VP1',name:'여의도',layout:{frame:{latitude:37.5,longitude:127},bounds_m:{min:[-30,-30],max:[30,30]},platform:{corners_m:[[-30,-30],[30,-30],[30,30],[-30,30]]},
  fatos:[{id:'F1',role:'both',center_m:[0,20],radius_m:9}],gates:[{id:'G1',center_m:[0,-10],radius_m:5}],chargers:[{id:'C1',gate:'G1',center_m:[10,-10],radius_m:2}],
  edges:[{id:'E1',from:'F1',to:'G1',points_m:[[0,20],[0,-10]],width_m:3}]}};
test('panel unrotates the design at any heading without moving saved geometry',()=>{
  const expected=uprightLayout(record.layout,resourcesOf(record));
  for(const heading of [35,90,180,275]){
    const copy=structuredClone(record),angle=heading*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
    const rotate=([x,y])=>[x*c+y*s,-x*s+y*c];copy.layout.frame.heading_deg=heading;
    copy.layout.platform.corners_m=copy.layout.platform.corners_m.map(rotate);
    for(const key of ['gates','fatos','chargers'])copy.layout[key].forEach(r=>r.center_m=rotate(r.center_m));
    copy.layout.edges.forEach(r=>r.points_m=r.points_m.map(rotate));const before=structuredClone(copy);
    const actual=uprightLayout(copy.layout,resourcesOf(copy));assert.deepEqual(copy,before);
    actual.corners.flat().forEach((v,i)=>assert.ok(Math.abs(v-expected.corners.flat()[i])<1e-9));
    actual.resources.forEach((r,i)=>{if(r.center_m)r.center_m.forEach((v,j)=>assert.ok(Math.abs(v-expected.resources[i].center_m[j])<1e-9));});
  }
});
test('charger badges are outside the gate footprint and separated even in a crowded row',()=>{
  const chargers=Array.from({length:12},(_,i)=>({kind:'charger',key:`charger:C${i}`,id:`C${i}`,center_m:[i<6?-10:10,0]}));
  const labels=[...chargerLabels(chargers,[-30,-30],[30,30],5).values()];
  for(const b of labels)assert.ok(b.x+b.width/2 < -30 || b.x-b.width/2 > 30);
  for(let i=0;i<labels.length;i++)for(let j=i+1;j<labels.length;j++)if(labels[i].x===labels[j].x)
    assert.ok(Math.abs(labels[i].y-labels[j].y)>(labels[i].height+labels[j].height)/2);
  const perturbed=chargers.map((r,i)=>({...r,center_m:[r.center_m[0],(i%3)*1e-12]}));
  assert.deepEqual([...chargerLabels(perturbed,[-30,-30],[30,30],5).keys()],chargers.map(r=>r.key),'inverse-rotation roundoff must not shuffle labels');
});
test('rehearsal uses real resource ids and topology without mutating saved definitions',()=>{
  const copy=structuredClone(record),flights=rehearsalSchedule(record,[record],now),keys=resourcesOf(record).map(r=>r.key);
  assert.equal(flights.length,18);assert.deepEqual(record,copy);
  assert.ok(flights.every(f=>f.id.startsWith('DEMO-')&&f.bookings.every(b=>keys.includes(b.key)&&b.start<b.end)));
  assert.ok(flights.some(f=>f.bookings.some(b=>b.key==='taxiway:E1')));
  assert.deepEqual(rehearsalSchedule({layout:{}},[],now),[]);
  const takeoffOnly=structuredClone(record);takeoffOnly.layout.fatos[0].role='takeoff';
  assert.ok(rehearsalSchedule(takeoffOnly,[],now).every(f=>f.direction==='departure'));
});
test('unknown is not free, closures preserve occupancy and show conflicts',()=>{
  const resource=resourcesOf(record)[0],flights=[{callsign:'TEST',bookings:[{key:resource.key,start:now-MINUTE,end:now+MINUTE}]}];
  assert.equal(resourceState(resource,[],{},now,false).state,'unknown');
  assert.equal(resourceState(resource,flights,{},now).state,'occupied');
  const closed={[resource.key]:{reason:'시설 점검'}};
  assert.deepEqual(resourceState(resource,flights,closed,now),{state:'conflict',occupants:['TEST'],reason:'시설 점검'});
  assert.equal(resourceState(resource,flights,{},now+MINUTE).state,'free','end boundary is not occupied');
});
test('nearest weather reports distance, unknown/stale data and UTC observation correctly',()=>{
  const payload={received_time:now/1000,points:[{latitude:35,longitude:128,observed_time:'2026-09-10T08:30'},{latitude:37.5,longitude:127,observed_time:'2026-09-10T08:30',weather_code:61}]};
  const weather=nearestWeather(record,payload,now);assert.equal(weather.distance_km,0);assert.equal(weather.stale,false);assert.equal(weather.observed_ms,now);
  assert.equal(nearestWeather(record,payload,now+61*MINUTE).stale,true);assert.equal(nearestWeather(record,{},now),null);
  for(const [code,symbol] of [[0,'sun'],[2,'partly'],[3,'cloud'],[45,'fog'],[61,'rain'],[71,'snow'],[95,'storm']])assert.equal(weatherSymbol({weather_code:code})[0],symbol);
  assert.equal(weatherSymbol(null)[0],'unknown');assert.match(weatherSymbol({cloud_cover_percent:50})[1],/추정/);
});
test('PSU report is a bounded untransmitted draft, not a clearance or acknowledgement',()=>{
  const draft=reportDraft(record,'availability',resourcesOf(record)[0],'<script>'+ 'a'.repeat(300),now);
  assert.equal(draft.status,'local_draft');assert.equal(draft.scope,'rehearsal');assert.equal(draft.reason.length,240);
  assert.throws(()=>reportDraft(record,'takeoff_clearance',null,'',now));
});
async function harness(api={}){
  const document={...fakeDocument,body:new FakeElement('body')};
  const panel=new VertiportPanel({document,now:()=>now,api:{list:async()=>({vertiports:[record,{...record,id:'VP2',name:'잠실'}]}),weather:async()=>({points:[]}),...api}});
  const body=new FakeElement('div');panel.render(body);await panel.ready;return {panel,body,document};
}
test('selection, rehearsal controls, per-port isolation, reports and collapse lifecycle work',async()=>{
  const {panel,body,document}=await harness();
  assert.equal(body.querySelector('#vp-select').children.length,2);assert.equal(panel.record.id,'VP1');
  const schedule=panel.flights;assert.equal(panel.flights,schedule,'projection is cached, not rebuilt for each row');
  panel.open();const key=panel.draft.selected;panel.restrictionButton.click();assert.ok(panel.draft.closures[key]);
  panel.memo.value='자원 점검 중';panel.psu.querySelectorAll('button')[0].click();assert.equal(panel.draft.messages[0].status,'local_draft');
  panel.choose('VP2');assert.deepEqual(panel.draft.closures,{});assert.equal(panel.draft.messages.length,0);
  panel.choose('VP1');assert.ok(panel.draft.closures[key]);assert.equal(panel.draft.messages.length,1);
  panel.fold();assert.equal(panel.consoleBody.inert,true);panel.fold();assert.equal(panel.consoleBody.inert,false);
  panel.close();assert.equal(document.body.getAttribute('data-vp-console'),null);panel.destroy();assert.equal(panel.timer,null);
});
test('no in-view facility retains selection and explains rather than choosing off screen',async()=>{
  const {panel}=await harness();panel.chooseView();assert.equal(panel.selectedId,'VP1');assert.match(panel.notice,/시야 안/);panel.destroy();
});
test('ARR / DEP renders one line per flight with five independent columns',async()=>{
  const {panel}=await harness();panel.open();const table=panel.console.querySelector('.vp-board');
  assert.deepEqual(table.querySelectorAll('th').map(e=>e.textContent),['시각','편명','출/도착','배정','상태']);
  for(const row of table.querySelector('tbody').children){assert.equal(row.children.length,5);assert.equal(row.querySelectorAll('small').length,0);assert.match(row.children[3].textContent,/G1\/F1/);}
  panel.destroy();
});
test('deleted facilities close the panel instead of acting on a stale selection',async()=>{
  const {panel}=await harness();panel.open();panel.api.list=async()=>({vertiports:[]});await panel.refresh();
  assert.equal(panel.record,undefined);assert.equal(panel.console,null);panel.destroy();
});
test('destroy ignores late list and weather responses',async()=>{
  let resolve;const document={...fakeDocument,body:new FakeElement('body')};
  const panel=new VertiportPanel({document,api:{list:()=>new Promise(r=>resolve=r)}});panel.render(new FakeElement('div'));
  panel.destroy();resolve({vertiports:[record]});await panel.ready;assert.deepEqual(panel.records,[]);assert.equal(panel.console,null);
});
test('stakeholder vertiport role mounts the implemented view, other roles remain separate',()=>{
  let calls=0;const panel=new StakeholderPanel({document:fakeDocument,vertiportPanel:{render:()=>calls++,deactivate:()=>{}}}),body=new FakeElement('div');
  panel.render(body);body.querySelector('#stakeholder-tab-vertiport').click();assert.equal(calls,1);assert.equal(body.querySelector('#stakeholder-state'),null);
  body.querySelector('#stakeholder-tab-psu').click();assert.match(body.querySelector('#stakeholder-state').textContent,/준비 중/);
});
test('in-view selection excludes occluded/off-screen facilities and chooses the nearest screen centre',()=>{
  const C={SceneMode:{SCENE3D:3},Ellipsoid:{WGS84:{}},EllipsoidalOccluder:class{isPointVisible(p){return p[0]!==9;}},Cartesian3:{fromDegrees:(...v)=>v},SceneTransforms:{worldToWindowCoordinates:(_s,p)=>({x:p[0],y:p[1]})}};
  const host={C,viewer:{canvas:{clientWidth:100,clientHeight:100},scene:{mode:3},camera:{positionWC:{}}}};
  const records=[[1,10,10],[2,48,48],[3,9,50],[4,200,40]].map(([id,longitude,latitude])=>({id,layout:{frame:{longitude,latitude}}}));
  assert.equal(LiveGlobe.prototype.vertiportInView.call(host,records),2);
  assert.equal(LiveGlobe.prototype.vertiportInView.call(host,[records[2],records[3]]),null);
  host.viewer.scene.mode=2;assert.equal(LiveGlobe.prototype.vertiportInView.call(host,[records[2]]),3);
});

test('vertiport ground card and flight board expose stop cause and actual gate reassignment',async()=>{
  const {panel}=await harness(),row={aircraft_id:'UAM0070',flight_id:'FPL70',phase:'gate_in',airborne:false,
    from:'F1',to:'G2',stand:'G2',ground_waiting:true,holding:false,on_ground:true,
    instruction:{action:'ground_wait',reason:'교차 유도로 통과 대기',blocked_by:['UAM0080'],wait_seconds:9},
    gate_assignment:{planned_stand:'G1',assigned_stand:'G2',revision:1,reason:'G1 실제 점유'}};
  panel.live={vertiport_id:'VP1',clock:'06:36:08',stands:{},stand_reservations:{G2:'FPL70'},
    standing:[],holding:[],outbound:[],inbound:[row],movements:[row],pads:{}};
  panel.open();
  assert.match(panel.console.querySelector('.vp-ground').textContent,/지상 대기/);
  assert.match(panel.console.querySelector('.vp-ground').textContent,/교차 유도로 통과 대기/);
  assert.match(panel.console.querySelector('.vp-ground').textContent,/UAM0080/);
  const cells=panel.console.querySelector('.vp-board').querySelector('tbody').querySelector('tr').children;
  assert.match(cells[3].textContent,/G1.*G2/);assert.match(cells[3].getAttribute('title'),/계획 Gate.*배정 Gate/);
  assert.match(cells[4].getAttribute('title'),/교차 유도로 통과 대기/);
  panel.destroy();
});

test('map information uses the real deck and stops its polling when closed',async()=>{
 const panel=new VertiportPanel({document:fakeDocument,api:{list:async()=>({vertiports:[record]}),weather:async()=>({})},now:()=>now});
 await panel.showInfo('VP1');
 assert.equal(panel.selectedId,'VP1');assert.equal(panel.demo,false);
 assert.match(panel.info.textContent,/버티포트 Control Panel/);
 assert.match(panel.info.textContent,/여의도/);
 panel.closeInfo();assert.equal(panel.info,null);assert.equal(panel.timer,null);assert.equal(panel.liveTimer,null);
 panel.destroy();
});

test('opening Control Panel replaces map info without losing deck selection or live polling',async()=>{
 const panel=new VertiportPanel({document:fakeDocument,api:{list:async()=>({vertiports:[record]}),weather:async()=>({})},now:()=>now});
 await panel.showInfo('VP1');panel.open();
 assert.equal(panel.info,null);assert.ok(panel.console);assert.equal(panel.selectedId,'VP1');assert.equal(panel.demo,false);assert.ok(panel.liveTimer);
 panel.destroy();
});

test('map info focuses the clicked deck once, not on live updates',async()=>{
 const focused=[];
 const panel=new VertiportPanel({document:fakeDocument,api:{list:async()=>({vertiports:[record]}),weather:async()=>({})},onFocus:r=>focused.push(r.id),now:()=>now});
 await panel.showInfo('VP1');assert.deepEqual(focused,['VP1']);
 panel.updateLive();assert.deepEqual(focused,['VP1']);panel.destroy();
});
test('closing map info before its data arrives does not move the camera',async()=>{
 let resolve;const focused=[];
 const panel=new VertiportPanel({document:fakeDocument,api:{list:()=>new Promise(r=>resolve=r),weather:async()=>({})},onFocus:r=>focused.push(r.id),now:()=>now});
 const pending=panel.showInfo('VP1');panel.closeInfo();resolve({vertiports:[record]});await pending;
 assert.deepEqual(focused,[]);panel.destroy();
});

test('a list that did not arrive is asked for again on its own, and the error clears when it does',async()=>{
  // A server on its way back up answers nothing for a few seconds; the panel
  // used to show the failure until the operator pressed the refresh button.
  let calls=0;const document={...fakeDocument,body:new FakeElement('body')};
  const panel=new VertiportPanel({document,listRetryMs:5,api:{list:async()=>{calls++;if(calls<3)throw new Error('offline');return {vertiports:[record]};},weather:async()=>({})}});
  panel.render(new FakeElement('div'));await panel.ready;
  assert.equal(calls,1);assert.match(panel.error,/잠시 후 다시 시도/);
  await new Promise(r=>setTimeout(r,80));
  assert.equal(calls,3);assert.equal(panel.error,'');assert.equal(panel.records.length,1);
  panel.destroy();
});
test('a panel destroyed while a retry is pending does not ask again',async()=>{
  let calls=0;const document={...fakeDocument,body:new FakeElement('body')};
  const panel=new VertiportPanel({document,listRetryMs:5,api:{list:async()=>{calls++;throw new Error('offline');},weather:async()=>({})}});
  panel.render(new FakeElement('div'));await panel.ready;panel.destroy();
  await new Promise(r=>setTimeout(r,40));assert.equal(calls,1);
});
