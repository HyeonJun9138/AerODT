import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultTrajectory} from '../../../../digital_twin/visualization/web/globe.js';

test('the production map loader passes both single and comparison forecasts to the renderer',async t=>{
  const id='physical:UAM0001',calls=[];
  let result={schema_version:2,kind:'uam_prediction_comparison',entity_id:id,predictions:[]};
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push([url,options]);return {ok:true,json:async()=>result};
  });
  assert.equal(await defaultTrajectory(id),result);
  assert.equal(calls[0][0],'/api/live/trajectory/physical%3AUAM0001');
  assert.equal(calls[0][1].cache,'no-store');
  result={schema_version:1,kind:'aircraft',entity_id:id,points:[]};
  assert.equal(await defaultTrajectory(id),result);
  result={schema_version:3,kind:'uam_prediction_comparison'};
  assert.equal(await defaultTrajectory(id),null);
});
