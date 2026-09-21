import test from 'node:test';
import assert from 'node:assert/strict';
import {readOperating} from '../../../../user_application/web/domains/uam/operations/operating_client.js';
test('updated server reads authoritative context directly',async()=>{
 const calls=[];const value=await readOperating(async u=>{calls.push(u);return {source:'physical'};},'/api/operations/context/status');
 assert.equal(value.source,'physical');assert.equal(calls.length,1);
});
test('an older running server retains Simulation views during deployment',async()=>{
 const calls=[];const value=await readOperating(async u=>{calls.push(u);if(u.includes('/context/'))throw Error('HTTP 404');return {loaded:true};},'/api/operations/context/status');
 assert.equal(value.loaded,true);assert.equal(calls[1],'/api/simulation/scenario/status');
});
test('a failed Physical context cannot be disguised as local Simulation',async()=>{
 let calls=0;await assert.rejects(()=>readOperating(async()=>{calls++;throw Error('HTTP 500');},'/api/operations/context/status'));
 assert.equal(calls,1);
});
test('older environment endpoints are composed into one renderer input',async()=>{
 const answers={'/api/simulation/vertiports':{vertiports:[{id:'A'}]},'/api/simulation/routes':{nodes:[{id:'N'}],links:[]},
   '/api/simulation/routes/options':{segments:['departure']},'/api/simulation/revision':{revision:'old'}};
 const value=await readOperating(async u=>{if(u.includes('/context/'))throw Error('HTTP 404');return answers[u];},'/api/operations/context/environment');
 assert.deepEqual(value.network,answers['/api/simulation/routes']);assert.deepEqual(value.segments,['departure']);assert.equal(value.vertiports[0].id,'A');
});
