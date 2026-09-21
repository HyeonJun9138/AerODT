import test from 'node:test';
import assert from 'node:assert/strict';
import {receiveBatch,sensorRows} from '../../../../user_application/apps/physical_uam/console_stream.js';
test('a restarted idle publisher clears the former sequence even before its first packet',()=>{
  let cursor={process:'old',sequence:3000,packet:{sequence:3000}};
  cursor=receiveBatch(cursor,{process_id:'new',packets:[]});
  assert.deepEqual(cursor,{process:'new',sequence:0,packet:null});
  const packet={process_id:'new',sequence:1,sensors:{}};
  cursor=receiveBatch(cursor,{process_id:'new',packets:[packet]});
  assert.equal(cursor.packet,packet);assert.equal(cursor.sequence,1);
});
test('stale batches cannot roll the display cursor backwards within a process',()=>{
  const cursor={process:'same',sequence:20,packet:{sequence:20}};
  assert.equal(receiveBatch(cursor,{process_id:'same',packets:[{process_id:'same',sequence:19}]}),cursor);
});
test('observation ages keep increasing during a paused stream without relabeling old measurements fresh',()=>{
  const p={sensors:{gnss:{sample_time:100,sequence:3}}};
  assert.equal(sensorRows(p,100.5)[0].age,.5);
  assert.equal(sensorRows(p,110)[0].age,10);
  assert.equal(p.sensors.gnss.sample_time,100);
});
