import test from 'node:test';
import assert from 'node:assert/strict';
import {CameraDetectionSession} from '../../../../user_application/web/camera_detection_session.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const frame={width:576,height:288,image_base64:'jpeg'};
function fixture(){let time=1000,calls=[];const q=deferred();const s=new CameraDetectionSession({now:()=>time,makeId:()=>String(time),request:async body=>{calls.push(body);return q.promise;},release:()=>{},onResult:(r,f)=>{s.result={r,f};}});return {s,calls,q,setTime:v=>time=v};}
test('camera starts with AI off and never submits frames until enabled',async()=>{const {s,calls}=fixture();s.select('u1','front');await s.submit(frame);assert.equal(calls.length,0);});
test('only one frame in flight and result must match the captured image identity',async()=>{const {s,calls,q}=fixture();s.select('u1','front');s.setEnabled(true);const p=s.submit(frame);await s.submit(frame);assert.equal(calls.length,1);q.resolve({...calls[0],detections:[]});await p;assert.equal(s.result.f,frame);});
test('direction change discards old result even when transport ignores abort',async()=>{const {s,calls,q}=fixture();s.select('u1','front');s.setEnabled(true);const p=s.submit(frame);s.select('u1','rear');q.resolve({...calls[0],detections:[]});await p;assert.equal(s.result,undefined);});
test('AI off discards pending result',async()=>{const {s,calls,q}=fixture();s.select('u1','front');s.setEnabled(true);const p=s.submit(frame);s.setEnabled(false);q.resolve({...calls[0],detections:[]});await p;assert.equal(s.result,undefined);});
test('result older than one second or from wrong camera is never drawn',async()=>{for(const wrong of [false,true]){const {s,calls,q,setTime}=fixture();s.select('u1','front');s.setEnabled(true);const p=s.submit(frame);if(!wrong)setTime(2001);q.resolve({...calls[0],camera:wrong?'rear':'front',detections:[]});await p;assert.equal(s.result,undefined);}});

test('pending inference reports lag before its response returns',async()=>{const {s,calls,q,setTime}=fixture();let status='';s.onStatus=v=>status=v;s.select('u1','front');s.setEnabled(true);const p=s.submit(frame);setTime(2001);s.checkAge();assert.match(status,/지연/);q.resolve({...calls[0],detections:[]});await p;});
