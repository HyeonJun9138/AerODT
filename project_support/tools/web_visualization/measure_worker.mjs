// Local snapshot CPU/transfer audit. No provider APIs or browser state changes.
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {SnapshotEncoder,SnapshotDecoder,snapshotTransferables} from '../../../communication/browser/snapshot_codec.js';

if(!isMainThread) {
  const encoder=new SnapshotEncoder();let index=0;
  function send() {
    const start=performance.now(),snapshot=JSON.parse(workerData.json),parsed=performance.now();
    const frame=encoder.encode(snapshot),encoded=performance.now();
    parentPort.postMessage({frame,index:index++,parse_ms:parsed-start,encode_ms:encoded-parsed,
      sent_at:performance.timeOrigin+performance.now()},snapshotTransferables(frame));
  }
  parentPort.on('message',message=>{if(message==='ack')send();});send();
} else {
  const response=await fetch('http://127.0.0.1:8766/api/live/snapshot',{signal:AbortSignal.timeout(15000)});
  const json=await response.text(),decoder=new SnapshotDecoder(),samples=[];
  const worker=new Worker(new URL(import.meta.url),{workerData:{json}});
  const intervals=[];let last=performance.now();const pulse=setInterval(()=>{const now=performance.now();intervals.push(now-last);last=now;},5);
  const summarize=values=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:sorted.length,median_ms:sorted[Math.floor(sorted.length/2)],p95_ms:sorted[Math.ceil(sorted.length*.95)-1],max_ms:sorted.at(-1)};};
  let decoded;
  await new Promise((resolve,reject)=>{
    worker.on('error',reject);
    worker.on('message',message=>{
      const arrived=performance.timeOrigin+performance.now(),start=performance.now();decoded=decoder.decode(message.frame);
      samples.push({decode_ms:performance.now()-start,parse_ms:message.parse_ms,encode_ms:message.encode_ms,
        transfer_receive_ms:arrived-message.sent_at,metadata_count:message.frame.metadata.length,
        transferred_bytes:message.frame.values.byteLength+message.frame.handles.byteLength+message.frame.removed.byteLength});
      if(samples.length>=21)resolve();else worker.postMessage('ack');
    });
  });
  clearInterval(pulse);await worker.terminate();
  assert.deepEqual(decoded,JSON.parse(json));
  const regular=samples.slice(1),baseline=[];
  for(let i=0;i<20;i++){const start=performance.now();JSON.parse(json);baseline.push(performance.now()-start);}
  const report={measured_at:new Date().toISOString(),runtime:process.version,
    environment:'Node main thread plus a real worker_threads worker; CPU and transfer timing, not browser/GPU FPS',
    entity_count:decoded.entities.length,json_utf8_bytes:Buffer.byteLength(json),roundtrip_exact:true,
    first_frame:samples[0],regular_frames:Object.fromEntries(['decode_ms','parse_ms','encode_ms','transfer_receive_ms'].map(key=>[key,summarize(regular.map(sample=>sample[key]))])),
    stable_metadata_changes:regular.map(sample=>sample.metadata_count),transfer_bytes:regular[0].transferred_bytes,
    direct_main_thread_json_parse:summarize(baseline),main_thread_5ms_pulse:summarize(intervals)};
  const path='data/workspace/performance/worker_transport'+(process.argv[2]?'_'+process.argv[2]:'')+'.json';
  await fs.mkdir('data/workspace/performance',{recursive:true});
  await fs.writeFile(path,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
