import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement, fakeDocument} from './fake_dom.mjs';
import {AircraftDashboard, batteryLevel} from '../../../../user_application/web/aircraft_dashboard.js';
import {describeFlightReadouts} from '../../../../user_application/web/entity_details.js';

// The operator asked for the click on an aircraft to bring up a summary along
// the bottom rather than the whole inspection drawer, with the drawer and a
// window one press away.

const entity={entity_id:'scenario:UAM7',name:'UAM7 · FPL42',source:'scenario',kind:'uam',quality:'nominal',
  provenance:'simulation',derivation:'simulated',orientation_source:'attitude',latitude_deg:37.5,longitude_deg:126.9,
  altitude_m:304.8,velocity_ecef_mps:[30,40,0],heading_deg:55,pitch_deg:1,roll_deg:-2,tilt_deg:90,
  rotor_radps:200,flight_phase:'cruise',state_time:100,observation_time:100,battery_pct:63.4,charge_state:'disconnected'};
const mission={state:{aircraft_id:'UAM7',flight_id:'FPL42',phase:'cruise',flight_mode:'fixed_wing',airborne:true,
  passengers:3,on_board:2,seats:4,adherence:{progress:.42,plan_share:.5,remaining_s:300,delay_s:95}},
  flight:{origin_name:'여의도',destination_name:'목동'},remaining:12};

function harness(actions={}){
  const document={...fakeDocument,body:new FakeElement('body')};
  const dashboard=new AircraftDashboard({document,actions,supportsCamera:e=>e.kind==='uam',cockpitReady:()=>true,following:()=>false});
  return {dashboard,document};
}
const tile=(dashboard,key)=>dashboard.root.querySelector(`[data-key=${key}]`);

test('the battery rides on the readouts once the wire carries it, labelled as the estimate it is',()=>{
  const view=describeFlightReadouts(entity);
  assert.equal(view.battery.value,'63');assert.equal(view.battery.pct,63.4);assert.match(view.battery.sub,/미연결/);
  assert.equal(describeFlightReadouts({...entity,battery_pct:undefined}).battery,null,'nothing invented for an aircraft the twin does not fly');
  assert.equal(batteryLevel(63),'ok');assert.equal(batteryLevel(35),'caution');assert.equal(batteryLevel(12),'low');assert.equal(batteryLevel(NaN),'unknown');
});

test('a selection paints the identity, the instruments and the leg; a snapshot tick rewrites the same nodes',()=>{
  const {dashboard,document}=harness();
  dashboard.show(entity);
  const root=document.body.querySelector('#aircraft-dashboard');
  assert.ok(root && !root.hidden);
  assert.equal(root.querySelector('.adb-name').textContent,'UAM7');
  assert.equal(root.querySelector('.adb-kind').textContent,'UAM');
  assert.equal(root.querySelector('.adb-phase').textContent,'순항');
  assert.equal(tile(dashboard,'altitude').querySelector('.adb-value').textContent,'305');
  assert.equal(tile(dashboard,'speed').querySelector('.adb-value').textContent,'180');
  assert.equal(tile(dashboard,'heading').querySelector('.adb-value').textContent,'55');
  assert.match(tile(dashboard,'heading').querySelector('.adb-arrow-mark').style.transform,/rotate\(-35deg\)/);
  assert.equal(tile(dashboard,'battery').querySelector('.adb-value').textContent,'63');
  assert.equal(tile(dashboard,'battery').getAttribute('data-level'),'ok');
  assert.equal(tile(dashboard,'battery').querySelector('.adb-gauge-fill').style.width,'63%');
  assert.equal(tile(dashboard,'tilt').querySelector('.adb-value').textContent,'90');
  assert.equal(root.querySelector('.adb-route').hidden,true,'no leg until the mission poll answers');
  dashboard.setMission(mission);
  assert.equal(root.querySelector('.adb-from').textContent,'여의도');assert.equal(root.querySelector('.adb-to').textContent,'목동');
  assert.equal(root.querySelector('.adb-progress').getAttribute('aria-valuenow'),'42');
  assert.equal(root.querySelector('.adb-progress-done').style.width,'42%');
  assert.equal(root.querySelector('.adb-progress-planned').style.left,'50%');
  assert.match(root.querySelector('.adb-eta').textContent,/42% · 착륙까지 5분/);
  assert.equal(root.querySelector('.adb-timing').getAttribute('data-level'),'late');
  assert.equal(tile(dashboard,'passengers').querySelector('.adb-value').textContent,'2 / 4명');
  const before=tile(dashboard,'altitude');
  dashboard.show({...entity,altitude_m:310,battery_pct:18});
  assert.equal(tile(dashboard,'altitude'),before,'the same tile, rewritten');
  assert.equal(before.querySelector('.adb-value').textContent,'310');
  assert.equal(tile(dashboard,'battery').getAttribute('data-level'),'low');
  assert.equal(root.querySelector('.adb-from').textContent,'여의도','the leg survives a telemetry tick');
  assert.equal(tile(dashboard,'passengers').hidden,false,'and so does the seats tile: it blinked on every snapshot');
  assert.equal(tile(dashboard,'passengers').querySelector('.adb-value').textContent,'2 / 4명');
});

test('another aircraft clears the old leg, the buttons hand the entity to the app, and deselecting hides the strip',()=>{
  const calls=[];
  const actions=Object.fromEntries(['expand','window','focus','follow','cockpit','camera','radar','close'].map(k=>[k,e=>calls.push([k,e.entity_id])]));
  const {dashboard,document}=harness(actions);
  dashboard.show(entity);dashboard.setMission(mission);
  dashboard.show({...entity,entity_id:'scenario:UAM8',name:'UAM8'});
  const root=document.body.querySelector('#aircraft-dashboard');
  assert.equal(root.querySelector('.adb-route').hidden,true,'the other aircraft has not answered its mission yet');
  dashboard.setMission(mission);
  assert.equal(root.querySelector('.adb-route').hidden,true,'a late answer for the previous aircraft is not painted on this one');
  for(const key of ['expand','window','focus','follow','cockpit','camera','radar','close'])root.querySelector(`[data-action=${key}]`).click();
  assert.deepEqual(calls.map(c=>c[0]),['expand','window','focus','follow','cockpit','camera','radar','close']);
  assert.ok(calls.every(c=>c[1]==='scenario:UAM8'));
  dashboard.show({...entity,entity_id:'a1',kind:'aircraft',name:'KAL123',tilt_deg:undefined,rotor_radps:undefined,battery_pct:undefined});
  assert.equal(root.querySelector('[data-action=cockpit]').hidden,true,'no cockpit for a live airliner');
  assert.equal(root.querySelector('[data-action=camera]').hidden,true);
  assert.equal(tile(dashboard,'battery').hidden,true);
  dashboard.show(null);
  assert.equal(root.hidden,true);assert.equal(root.getAttribute('data-open'),'false');
  dashboard.setMinimised(true);assert.equal(root.getAttribute('data-minimised'),'true');
});

test('fold control stays next to close and keeps a centred CSS chevron through toggles',()=>{
  const {dashboard}=harness(); dashboard.show(entity);
  const group=dashboard.root.querySelector('.adb-window-controls');
  assert.deepEqual(group.children,[dashboard.minimise,dashboard.close]);
  const arrow=dashboard.minimise.querySelector('.adb-chevron');
  for(const folded of [true,false,true]){
    dashboard.setMinimised(folded);
    assert.equal(dashboard.minimise.getAttribute('aria-expanded'),String(!folded));
    assert.equal(dashboard.minimise.getAttribute('aria-label'),folded?'요약 펼치기':'요약 접기');
    assert.equal(dashboard.minimise.querySelector('.adb-chevron'),arrow);
  }
});

test('the same cockpit toolbar is docked, restored on hide, and reattached without losing its handler',()=>{
  const {dashboard,document}=harness(); dashboard.build();
  // Give this fixture real DOM reparenting semantics without changing the shared fake.
  for(const parent of [document.body,dashboard.controlsHost]){
    const append=parent.append.bind(parent);
    parent.append=(node)=>{node.remove(); append(node);};
  }
  const toolbar=new FakeElement('section');
  Object.defineProperty(toolbar,'parentNode',{get(){return this.parent;}});
  const button=new FakeElement('button'); let clicks=0;button.onclick=()=>clicks++;
  toolbar.append(button); document.body.append(toolbar);toolbar.hidden=true;
  dashboard.setControls(toolbar);assert.equal(toolbar.parentNode,document.body);
  dashboard.show(entity);assert.equal(toolbar.parentNode,dashboard.controlsHost);
  assert.equal(toolbar.hidden,true,'docking must not open a closed cockpit');
  toolbar.hidden=false;button.click();dashboard.hide();
  assert.equal(toolbar.parentNode,document.body);assert.equal(toolbar.hidden,false);
  dashboard.show(entity);button.click();
  assert.equal(toolbar.parentNode,dashboard.controlsHost);assert.equal(clicks,2);
  dashboard.destroy();assert.equal(toolbar.parentNode,document.body);
});

test('the strip opens the camera and the radar for the aircraft it is showing, and the drawer button it used to press is no longer dead', () => {
  const app = readFileSync(new URL('../../../../user_application/web/app.js', import.meta.url), 'utf8');
  // The strip used to press the drawer's buttons. The drawer's camera button
  // works from the drawer's own last selection — which a replayed flight never
  // becomes — and its radar button had no handler at all, so a strip showing a
  // replay opened neither.
  assert.match(app, /camera:entity=>\{if\(AircraftCameraPanel\.supports\(entity\)\)aircraftCamera\?\.select\(entity,\{selected:true\}\)/,
    'the strip opens the camera for its own aircraft');
  assert.match(app, /radar:entity=>openRiskRadar\(entity\?\.entity_id\)/, 'and the radar for its own aircraft');
  assert.doesNotMatch(app, /camera:\(\)=>\$\('camera-live'\)\.click\(\)/, 'not by pressing the drawer for it');
  assert.doesNotMatch(app, /radar:\(\)=>\$\('radar-live'\)\.click\(\)/);
  assert.match(app, /\$\('radar-live'\)\.onclick=\(\)=>openRiskRadar\(/, 'the drawer button answers too, instead of doing nothing');
  assert.match(app, /\$\('radar-live'\)\.hidden=!RADAR_KINDS\.includes/, 'and is shown for what can carry a radar, as the detail window shows it');
  assert.match(app, /const RADAR_KINDS=\['uam','aircraft','helicopter','drone'\]/);
  // A radar that cannot be opened says which of the two things is missing.
  assert.match(app, /이 비행은 실시간 교통 수신에 없어/, 'a replayed flight is not on the traffic wire, and says so');
  assert.match(app, /주변을 확인할 비행체를 먼저 선택하세요/, 'nothing chosen still says to choose something');
});

test('focus mode starts with only its handle and preserves ordinary fold state on exit',()=>{
 const {dashboard:d}=harness();d.show(entity);d.setMinimised(false);d.setFocusMode(true);
 assert.equal(d.root.getAttribute('data-focus-expanded'),'false');assert.equal(d.root.querySelector('.adb-surface').inert,true);
 d.focusHandle.click();assert.equal(d.focusHandle.getAttribute('aria-expanded'),'true');assert.equal(d.root.querySelector('.adb-surface').inert,false);
 d.focusHandle.click();assert.equal(d.focusHandle.getAttribute('aria-expanded'),'false');
 d.setFocusMode(false);assert.equal(d.minimised,false);assert.equal(d.root.querySelector('.adb-surface').inert,false);
 d.setFocusMode(true);assert.equal(d.focusHandle.getAttribute('aria-expanded'),'false');

 // The handle comes before the panel. In focus mode the strip is a column
 // docked to the bottom of the screen, so first in the column is the top
 // edge -- which is the edge this handle is drawn for: rounded at the top,
 // open at the bottom, shadow cast upward. Appended after the panel it came
 // out underneath, lifting the whole strip 26 px off the screen's bottom and
 // leaving a tab attached to nothing (measured in the browser, both ways).
 const order=[...d.root.children];
 assert.equal(order.indexOf(d.focusHandle),0,'핸들이 먼저');
 assert.ok(order.indexOf(d.root.querySelector('.adb-surface'))>0,'패널이 그 다음');
 // Reading order follows: collapsed, the handle is the only thing there.
 assert.equal(d.root.children[0].getAttribute('aria-label'),'조작부 펼치기');
});
