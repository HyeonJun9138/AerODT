import test from 'node:test';
import assert from 'node:assert/strict';
import {ManualFlightSession} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_session.js';
const fixture=()=>{const s=Object.create(ManualFlightSession.prototype),sounds=[];Object.assign(s,{twin:'UAM1',generation:1,onSound:k=>sounds.push(k),notify:()=>{}});return {s,sounds};};
test('PSU background clock updates stay quiet; changed instruction and explicit refresh announce',async()=>{
 const old=globalThis.fetch,{s,sounds}=fixture();let body={flight_id:'f1',instruction:{action:'hold'},clock:1};globalThis.fetch=async()=>({ok:true,json:async()=>body});
 try{await s.pollPsu();body={...body,clock:2};await s.pollPsu();assert.deepEqual(sounds,[]);body={...body,instruction:{action:'taxi'}};await s.pollPsu();assert.deepEqual(sounds,['received']);sounds.length=0;await s.requestPsu('refresh');assert.deepEqual(sounds,['request','received']);}finally{globalThis.fetch=old;}
});
test('PSU request acknowledges response, reports failures, ignores replies from ended sessions',async()=>{
 const old=globalThis.fetch,{s,sounds}=fixture();globalThis.fetch=async()=>({ok:true,json:async()=>({state:'accepted'})});
 try{await s.requestPsu('departure');assert.deepEqual(sounds,['request','received']);sounds.length=0;globalThis.fetch=async()=>{throw Error('offline');};await s.requestPsu('departure');assert.deepEqual(sounds,['request','error']);sounds.length=0;globalThis.fetch=async()=>{s.generation++;return {ok:true,json:async()=>({state:'accepted'})};};await s.requestPsu('departure');assert.deepEqual(sounds,['request']);}finally{globalThis.fetch=old;}
});
