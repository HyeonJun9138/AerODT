import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeDocument} from './fake_dom.mjs';
import {CockpitPanel} from '../../../../user_application/web/domains/uam/cockpit/cockpit_panel.js';
const make=()=>new CockpitPanel({document:fakeDocument});
const state=()=>({entity:{entity_id:'U1',orientation_source:'attitude',heading_deg:370,pitch_deg:12,roll_deg:-8,latitude_deg:0,longitude_deg:0,altitude_m:120,velocity_ecef_mps:[3,4,0]},telemetry:{battery_soc_pct:72,rotor_radps:Math.PI*2,tilt_deg:35,flight_phase:'cruise'},mission:{destination:'VP2',route_points:[{latitude_deg:0,longitude_deg:.001}]},nearby:[]});
const val=(p,k)=>p.root.querySelector(`[data-readout=${k}]`).textContent;

test('PFD phase shows the concise status while preserving the full ground instruction',()=>{
 const p=make();p.open();const s=state();s.telemetry.flight_phase='충전 중 · 출발하려면 해제';p.update(s,0);
 assert.equal(val(p,'phase'),'충전 중');assert.equal(p.readouts.phase.getAttribute('title'),s.telemetry.flight_phase);
 assert.equal(p.readouts.phase.style.fontSize,'16px');
 s.telemetry.flight_phase='지상 직원 · 케이블 운반 / 연결';p.update(s,200);assert.equal(val(p,'phase'),'지상 직원');
 s.telemetry.flight_phase='순항';p.update(s,400);assert.equal(val(p,'phase'),'순항');assert.equal(p.readouts.phase.getAttribute('title'),'순항');p.destroy();
});
test('three reusable screen surfaces are separate from camera toolbar',()=>{const p=make();assert.equal(p.root.hidden,true);p.open();assert.equal(p.root.hidden,false);assert.equal(Object.keys(p.screens).length,3);assert.notEqual(p.root,p.toolbar);p.destroy();assert.equal(p.root.hidden,true);});
test('reads snapshot without mutation, correctly labels non-airspeed and unknown datum',()=>{const p=make();p.open();const s=state(),before=structuredClone(s);p.update(s,0);assert.equal(val(p,'heading'),'010°');assert.equal(val(p,'speed'),'5.0');assert.equal(val(p,'altitude'),'120');assert.match(p.root.textContent,/ECEF/);assert.match(p.root.textContent,/ALT REF \?/);assert.match(p.speedLabel.getAttribute('title'),/Not airspeed/);assert.doesNotMatch(p.root.textContent,/IAS/);assert.equal(val(p,'rpm'),'60');assert.equal(val(p,'battery'),'72');assert.deepEqual(s,before);});
test('missing or ground-track attitude never becomes an invented level horizon',()=>{const p=make();p.open();p.update({entity:{orientation_source:'ground_track',heading_deg:90}},0);assert.equal(val(p,'pitch'),'—');assert.equal(val(p,'roll'),'—');assert.equal(val(p,'speed'),'—');assert.equal(p.root.querySelector('.cockpit-attitude').hidden,true);assert.equal(p.horizonMissing.textContent,'ATT DATA');assert.equal(val(p,'battery'),'—');});
test('DOM data updates limited to 10Hz, close clears values, entity changes bypass stale readouts',()=>{const p=make();p.open();const s=state();p.update(s,0);s.entity.altitude_m=220;p.update(s,99);assert.equal(val(p,'altitude'),'120');p.update(s,100);assert.equal(val(p,'altitude'),'220');p.update({entity:{entity_id:'U2'}},101);assert.equal(val(p,'altitude'),'—');p.close();assert.equal(val(p,'heading'),'—');p.open();assert.equal(val(p,'rpm'),'—');});
test('stale flag and state time are explicit without fabricating valid status',()=>{const p=make();p.open();p.update({...state(),stale:true,stateTime:123.4},0);assert.match(p.root.textContent,/오래된 상태/);assert.equal(val(p,'time'),'00:02:03');assert.match(p.readouts.time.getAttribute('title'),/123.4/);p.update({},100);assert.match(p.root.textContent,/미수신/);});
test('display-only controls stop propagation, range is bounded and brightness does not affect toolbar',()=>{const p=make();p.open();const range=p.root.querySelector('[data-action=range]');range.click();assert.match(range.textContent,/2 km/);p.screens.pfd.querySelector('[data-action=brightness-pfd]').click();assert.equal(p.screens.pfd.style.getPropertyValue('--cockpit-brightness'),'0.75');assert.equal(p.screens.nav.style.getPropertyValue('--cockpit-brightness'),'');let stop=0,prevent=0;p.root.onwheel({stopPropagation(){stop++;},preventDefault(){prevent++;}});assert.equal(stop,1);assert.equal(prevent,1);});
test('heading-up navigation projects points and hides absent traffic instead of showing synthetic contacts',()=>{const p=make();p.open();const s=state();s.entity.heading_deg=90;s.nearby=[{entity_id:'U2',latitude_deg:0,longitude_deg:.001}];p.update(s,0);assert.equal(p.root.querySelectorAll('.cockpit-contact').length,1);assert.match(p.root.querySelector('.cockpit-route').getAttribute('points'),/100,90/);p.update({entity:{}},100);assert.equal(p.root.querySelectorAll('.cockpit-contact').length,0);});

test('destroy detaches all button callbacks and a disposed panel cannot reopen',()=>{let exits=0;const p=new CockpitPanel({document:fakeDocument,onViewpoint:()=>exits++});p.setCabin({});const button=p.pilotButton;p.open();p.destroy();button.click();assert.equal(exits,0);p.open();assert.equal(p.active,false);});
test('new epoch clears previous flight readouts even inside throttle interval',()=>{const p=make();p.open();p.update({...state(),epoch:1},0);p.update({entity:{entity_id:'U1'},epoch:2},1);assert.equal(val(p,'rpm'),'—');assert.equal(val(p,'heading'),'—');});
test('north-up ownship orientation follows received heading without rotating range rings',()=>{const p=make();p.open();const s=state();s.entity.heading_deg=90;p.root.querySelector('[data-action=orientation]').click();p.update(s,0);assert.equal(p.root.querySelector('.cockpit-ownship').getAttribute('transform'),'rotate(90 100 100)');});
test('adapter clock disclosures remain visible and latest velocity is not reprojected using sampled latitude',()=>{const p=make();p.open();p.update({entity:{entity_id:'U1',velocity_reference:'latest_observation',velocity_ecef_mps:[3,4,0],latitude_deg:0,longitude_deg:0},speedNote:'최신 관측 200.0s',systemNote:'모드 / 임무: 최근 조회',nearbyNote:'주변 교통: 최신 관측'},0);assert.match(p.speedLabel.getAttribute('title'),/최신 관측 200.0s/);assert.match(p.screens.pfd.querySelector('.cockpit-system-grid').getAttribute('title'),/모드 \/ 임무: 최근 조회/);assert.equal(val(p,'vertical'),'—');});

test('cockpit dock starts folded, expands accessible groups and playback uses explicit actions only',()=>{
 const actions=[];const p=new CockpitPanel({document:fakeDocument,onPlayback:a=>actions.push(a)});p.open();
 assert.equal(p.dockBody.inert,true);assert.equal(p.dockToggle.getAttribute('aria-expanded'),'false');
 p.dockToggle.click();assert.equal(p.dockBody.inert,false);assert.equal(p.dockToggle.getAttribute('aria-expanded'),'true');
 p.setPlayback({enabled:true,time:'06:32:57',playing:true,speed:'×2',canToggle:true,canRate:true});
 p.toolbar.querySelector('[data-action=playback-toggle]').click();assert.deepEqual(actions,['toggle']);assert.match(p.toolbar.textContent,/06:32:57/);
 p.close();p.open();assert.equal(p.dockToggle.getAttribute('aria-expanded'),'false');p.destroy();
});


test('MFD focus toggles independently and resets on close without flight commands',()=>{
 const p=make();p.open();
 const button=p.screens.nav.querySelector('[data-action=focus-nav]');
 assert.ok(button);button.click();assert.equal(p.focusScreen,'nav');
 assert.equal(button.getAttribute('aria-pressed'),'true');
 p.screens.pfd.querySelector('[data-action=focus-pfd]').click();assert.equal(p.focusScreen,'pfd');
 p.close();assert.equal(p.focusScreen,null);p.destroy();
});

test('altitude tape retains its SVG nodes across repeated and changing samples',()=>{const p=make();p.open();p.update(state(),0);const nodes=[...p.altTicks.children];p.update(state(),200);assert.deepEqual(p.altTicks.children,nodes);const changed=state();changed.entity.altitude_m=141;p.update(changed,400);assert.equal(p.altTicks.children.length,nodes.length);for(let i=0;i<nodes.length;i++)assert.equal(p.altTicks.children[i],nodes[i]);});

test('speed and altitude readouts use the same SVG geometry as their pointer boxes',()=>{
 const p=make();p.open();const s=state();s.entity.altitude_m=12345;s.entity.recorded_speed_mps=144.5;p.update(s,0);
 const boxes=[...p.horizon.children].filter(node=>node.tagName.toLowerCase()==='foreignobject');assert.equal(boxes.length,2);
 assert.equal(boxes[0].getAttribute('y'),'119');assert.equal(boxes[1].getAttribute('y'),'119');assert.equal(boxes[0].getAttribute('height'),'38');
 assert.equal(p.readouts.altitude.style.fontSize,'14px');assert.equal(p.readouts.speed.style.fontSize,'18px');
});

test('NAV range cycles through every scale repeatedly and recovers invalid values',()=>{
 const p=make();p.open();
 for(let cycle=0;cycle<3;cycle++)for(const km of [2,5,10,.5,1]){p.rangeButton.click();assert.equal(p.rangeKm,km);assert.equal(p.rangeButton.textContent,`${km} km`);}
 for(const invalid of [undefined,NaN,0,'0.5']){p.rangeKm=invalid;p.rangeButton.click();assert.equal(p.rangeKm,1);assert.equal(p.rangeButton.textContent,'1 km');}
});

test('simulation settings survive external view; cabin controls are only in the view/display menus',()=>{
 const views=[],p=new CockpitPanel({document:fakeDocument,onViewpoint:id=>views.push(id)});p.setCabin({});p.open();
 assert.doesNotMatch(p.dockBody.textContent,/시점|계기 표시|객실|밝기|확대|캡처/);
 p.pilotButton.click();assert.deepEqual(views,['pilot']);
 p.setManualMode(true);p.close();assert.equal(p.toolbar.hidden,false);assert.equal(p.viewControls.hidden,true);assert.equal(p.root.hidden,true);
 p.setPlayback({enabled:true});assert.equal(p.playbackGroup.hidden,true,'manual pause is not duplicated by recorded playback');
 p.setManualMode(false);assert.equal(p.toolbar.hidden,true);p.destroy();
});

test('final destination remains distinct from next WP and departure ground chart',()=>{
 const p=make();p.open();const s=state();
 s.mission.destination_name='Cheonho';s.mission.destination_id='VP011';
 s.mission.next_waypoint='WP 2';
 p.update(s,0);assert.equal(p.finalDestination.textContent,'Cheonho');assert.equal(p.finalDestinationId.textContent,'VP011');
 p.groundButton.click();s.mission.surface={name:'Yeouido',gate:'G4',fato:'F1'};
 p.update(s,200);assert.equal(p.finalDestination.textContent,'Cheonho');assert.equal(val(p,'destination'),'G4');
 s.entity.entity_id='U2';s.mission={};p.update(s,201);
 assert.notEqual(p.finalDestination.textContent,'Cheonho');assert.equal(p.finalDestinationId.textContent,'');p.destroy();
});

import {CockpitView} from '../../../../user_application/web/domains/uam/cockpit/cockpit_view.js';
test('PFD monitors bounded command percentages without modifying controls',()=>{
 const p=make();p.open();const c={source:'joystick',enabled:true,throttle:.735,roll:-.25,pitch:.5,yaw:0},before=structuredClone(c);
 p.setControlInputs(c);assert.equal(val(p,'input_throttle'),'74');assert.equal(val(p,'input_roll'),'-25');assert.equal(val(p,'input_pitch'),'+50');assert.equal(val(p,'input_yaw'),'0');
 assert.equal(p.inputBars.roll.style.left,'37.5%');assert.equal(p.inputBars.roll.style.width,'12.5%');assert.deepEqual(c,before);
 p.setControlInputs({...c,throttle:2,pitch:-3,yaw:NaN});assert.equal(val(p,'input_throttle'),'100');assert.equal(val(p,'input_pitch'),'-100');assert.equal(val(p,'input_yaw'),'—');assert.equal(p.inputBars.yaw.hidden,true);
 p.close();assert.equal(p.inputSource.textContent,'NO INPUT');assert.equal(p.inputBars.throttle.hidden,true);
});
test('observed attitude cannot fabricate inputs; AP throttle is explicitly distinguished',()=>{
 const p=make();p.open();p.setControlInputs({source:'observation',throttle:.8,roll:.3});assert.equal(val(p,'input_throttle'),'—');
 p.setControlInputs({source:'keyboard',throttle:.61,roll:.8,autopilot:{enabled:true}});assert.equal(p.inputSource.textContent,'AP THR');assert.equal(val(p,'input_throttle'),'61');assert.equal(val(p,'input_roll'),'—');
 p.setControlInputs(null);assert.equal(val(p,'input_throttle'),'—');p.destroy();
});
test('heading labels reserve the central heading readout at north wrap and other bearings',()=>{
 const p=make();p.open();for(const heading of [0,1,10,180,323,359]){const s=state();s.entity.heading_deg=heading;p.update(s,heading*200+1000);
 for(const node of p.compassTicks.children)if(node.tagName.toLowerCase()==='text')assert.ok(Math.abs(Number(node.getAttribute('x'))-294)>64);
 }p.destroy();
});
test('PFD input monitor is fed owner-checked commands, not observed hardware estimates',()=>{
 let received;const v={manualControls:()=>null,panel:{setControlInputs:c=>received=c}};
 CockpitView.prototype.updateHardware.call(v,{source:'observation',throttle:1});assert.equal(received,null);
 const c={source:'screen',throttle:.4};v.manualControls=()=>c;CockpitView.prototype.updateHardware.call(v);assert.equal(received,c);
});

test('tape labels keep a margin around readout boxes and missing attitude hides bank pointer',()=>{
 const p=make();p.open();const s=state();s.entity.recorded_speed_mps=144.5;s.entity.altitude_m=12345;p.update(s,0);
 for(const group of [p.speedTicks,p.altTicks])for(const {text} of group._tickRows)if(text.getAttribute('visibility')==='visible'){const y=Number(text.getAttribute('y'))-4;assert.ok(y<110||y>169);}
 p.update({entity:{entity_id:'other'}},1);assert.equal(p.bankPointer.getAttribute('visibility'),'hidden');p.destroy();
});

test('PFD upper bank lane uses the same blue as the sky without changing its layout',()=>{
 const p=make();const band=[...p.horizon.walk()].find(n=>n.tagName==='RECT'&&n.getAttribute('x')==='77'&&n.getAttribute('y')==='0'&&n.getAttribute('height')==='68'&&n.getAttribute('fill'));
 assert.ok(band);assert.equal(band.getAttribute('fill'),p.attitude.children[0].getAttribute('fill'));assert.equal(band.getAttribute('width'),'430');p.destroy();
});
