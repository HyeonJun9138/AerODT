import test from 'node:test';
import assert from 'node:assert/strict';
const details=await import('../../../../user_application/web/entity_details.js').catch(()=>({}));

test('battery estimate exposes low-SOC record-only policy and actual charging state',()=>{
 const view=details.describeMission({state:{aircraft_id:'A1',phase:'parked',energy:{soc_pct:0,
   remaining_kwh:0,capacity_kwh:110,power_kw:-80,charge_power_kw:80,charge_state:'charging',
   flight_used_kwh:120,deficit_kwh:10,warning:'depleted'}}});
 assert.match(view.fields.find(f=>f.key==='energy_power').value,/충전 80/);
 assert.match(view.fields.find(f=>f.key==='energy_warning').value,/추락 미적용/);
 assert.match(view.fields.find(f=>f.key==='energy_deficit').value,/10/);
});

test('corrected GRU shows the synthetic input warning, not a measured turn rate',()=>{
  const view=details.describeTrajectory({kind:'aircraft',note:'보정 입력 기반 GRU 예측 · 실측 아님',
    summary:{basis:'provider_corrected',model:'gru_direct_v1_1',seconds:15}});
  assert.match(view.note,/보정 입력/);
  assert.ok(!view.fields.some(f=>f.key==='turn'));
});

test('details preserve zero observations, label ECEF speed, and never invent missing telemetry',()=>{
  assert.equal(typeof details.describeEntity,'function');
  const view=details.describeEntity({entity_id:'a',name:'A',kind:'aircraft',latitude_deg:0,longitude_deg:0,altitude_m:0,heading_deg:0,velocity_ecef_mps:[3,4,0],orientation_source:'ground_track',state_time:0,observation_time:null,quality:'valid',provenance:'live'});
  assert.equal(view.fields.find(f=>f.key==='altitude').value,'0 m');
  assert.equal(view.fields.find(f=>f.key==='speed').value,'5.0 m/s');
  assert.match(view.fields.find(f=>f.key==='speed').label,/ECEF/);
  assert.equal(view.fields.find(f=>f.key==='heading').value,'0.0°');
  assert.equal(view.fields.find(f=>f.key==='observation').value,'정보 없음');
  assert.match(view.fields.find(f=>f.key==='state_time').value,/1970/);
  assert.equal(details.describeEntity({kind:'satellite',velocity_ecef_mps:[NaN,0,0]}).fields.find(f=>f.key==='speed').value,'정보 없음');
});

test('satellite propagation and representative visuals are not presented as live measured attitude or exact vehicle',()=>{
  const view=details.describeEntity({kind:'satellite',entity_id:'s',derivation:'sgp4',provenance:'cached',quality:'stale',orientation_source:'unavailable'}, {title:'Satellite',representative:true});
  assert.match(view.representation,/대표/);assert.match(view.quality,/오래/);
  assert.equal(view.fields.find(f=>f.key==='heading').value,'정보 없음');
  assert.match(view.fields.find(f=>f.key==='derivation').value,/궤도|sgp4/i);
});

test('the panel says how closely the shipped model matches the object',()=>{
  const of=(entity,asset)=>details.describeEntity({kind:'satellite',entity_id:'s',...entity},asset).representation;
  assert.match(of({visual_match:'exact'},{title:'ISS'}),/해당/);
  assert.match(of({visual_match:'series'},{title:'Landsat 8'}),/계열/);
  assert.match(of({visual_match:'representative'},{title:'EO-1'}),/대표/);
  assert.match(of({visual_match:'none'}),/없|점/);
  assert.match(of({visual_match:'exact'},{title:'Temp',temporary:true}),/임시/);
  for(const value of ['exact','series','representative'])
    assert.match(of({visual_match:value},{title:'X'}),/촬영|실제/,'never presented as a photograph of the object');
});

test('hover tooltip stays inside viewport including its footer exclusion',()=>{
  assert.equal(typeof details.tooltipPosition,'function');
  assert.deepEqual(details.tooltipPosition({x:380,y:750},{width:390,height:766},{width:190,height:80}),{left:178,top:658});
  assert.deepEqual(details.tooltipPosition({x:0,y:0},{width:390,height:766},{width:190,height:80}),{left:14,top:14});
});
