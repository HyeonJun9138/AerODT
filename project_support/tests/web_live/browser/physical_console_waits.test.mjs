import test from 'node:test';
import assert from 'node:assert/strict';
import {fleetStateText,waitingReport} from '../../../../user_application/apps/physical_uam/console_stream.js';
test('holding is a subset of airborne, with separate ground count',()=>{
  assert.equal(fleetStateText({airborne:88,holding:83}),'공중 88대 · 그중 대기 83대');
  const rows=Array.from({length:100},(_,i)=>({aircraft_id:String(i),airborne:i<88,holding:i<83,destination:'V',hold_seconds:i,instruction:{clearance_reason:'착륙 출구 확보 대기: A'}}));
  const report=waitingReport(rows,[{id:'V',name:'봉천'}]);
  assert.equal(report.holding,83);assert.equal(report.ground,12);assert.equal(report.longest_s,82);
  assert.deepEqual(report.reasons,[['착륙 출구 확보',83]]);assert.deepEqual(report.destinations,[['봉천',83]]);
});
test('mutual traffic wait is reported once and not confused with normal sequencing',()=>{
  const row=(id,target,action)=>({aircraft_id:id,airborne:true,holding:true,instruction:{traffic_id:target,action}});
  const rows=[row('A','B','wait_clear'),row('B','A','yield'),row('C','B','yield')];
  assert.deepEqual(waitingReport(rows).cycles,['A ↔ B']);
  rows[1].instruction.action='recover';assert.deepEqual(waitingReport(rows).cycles,[]);
  assert.equal(waitingReport([]).longest_s,0);
});
