import test from 'node:test';import assert from 'node:assert/strict';
import {createAnalysisReader} from '../../../../user_application/web/domains/uam/analysis/operations_requests.js';
test('two windows share an identical in-flight request',async()=>{
 let resolve,calls=0,options;const read=createAnalysisReader((url,o)=>{calls++;options=o;return new Promise(r=>resolve=r);});
 const a=read('/analysis?recording=simulation'),b=read('/analysis?recording=simulation');
 assert.equal(calls,1);assert.equal(options.timeoutMs,30000);resolve({available:true});assert.deepEqual(await a,await b);
});
test('failed and completed requests are removed, and filters are independent',async()=>{
 let calls=0;const read=createAnalysisReader(async()=>{if(++calls===1)throw new Error('offline');return calls;});
 await assert.rejects(read('/a'));assert.equal(await read('/a'),2);assert.equal(await read('/a'),3);
 assert.deepEqual(await Promise.all([read('/b?page=1'),read('/b?page=2')]),[4,5]);
});
