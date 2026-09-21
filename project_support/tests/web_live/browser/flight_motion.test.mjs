import test from 'node:test';
import assert from 'node:assert/strict';
import {readRun, sampleRun} from '../../../../user_application/web/flight_plan.js';
import {rateOf} from '../../../../digital_twin/visualization/web/rotor_spin.js';

test('resolved deck height retains physical height error without breaking older runs', () => {
  const plan = {legs: [{path: [[127,37,130], [127,37,100]]}], totals: {duration_s: 10}};
  const state = {t: 5, leg: 0, f: 0.5, latitude: 37, longitude: 127, altitude_m: 18};
  assert.equal(readRun(plan, [state])[0].position.altitude_m, 115);
  assert.equal(readRun(plan, [{...state,height_error_m:3}])[0].position.altitude_m, 118);
});

test('ground visual idle survives playback and measured zero still wins', () => {
  const plan = {legs: [{path: [[127,37,100], [127,37,100]]}], totals: {duration_s: 10}};
  const states = [0, 10].map(t => ({t,leg:0,f:0,latitude:37,longitude:127,
    altitude_m:0,stage:'gate_in',speed_mps:0,rotor_visual_radps:190*(1-t/10)}));
  const samples = readRun(plan, states);
  assert.equal(rateOf(sampleRun(samples, 5)),95);
  assert.equal(rateOf({...samples[0],rotor_radps:0}),0);
  assert.equal(rateOf({...samples[0],rotor_radps:null}),190);
});
