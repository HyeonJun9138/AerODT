import test from 'node:test';import assert from 'node:assert/strict';
import {RiskRadarSelection} from '../../../../user_application/web/domains/uam/prediction/risk_selection.js';
test('map selection never opens radar; only its explicit button selects and opens',()=>{
 const calls=[];const radar={select:e=>calls.push(e?.entity_id??null),open:()=>calls.push('open')};
 const s=new RiskRadarSelection(radar),a={entity_id:'a'},b={entity_id:'b'};
 s.map(a,{selected:true});s.map(a,{reopen:true});assert.deepEqual(calls,[]);
 s.open(b);s.map(a);s.map(a,{selected:true});assert.deepEqual(calls,['b','open']);
 s.map(null,{selected:true});assert.equal(calls.at(-1),null);
});
