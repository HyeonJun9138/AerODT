import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeDocument,FakeElement} from './fake_dom.mjs';
import {paintCalibration,CalibrationMonitor,calibrationState} from '../../../../user_application/web/sensor_calibration_panel.js';

test('actual calibrated measurements disclose time basis and do not invent a true error',()=>{
  globalThis.document=fakeDocument;
  const box=paintCalibration({status:'applied',raw:{altitude_ellipsoid_m:204},corrected:{altitude_ellipsoid_m:200},removed_position_bias_m:Math.sqrt(29)});
  assert.match(box.textContent,/204.00 → 200.00/);assert.match(box.textContent,/같은 관측 시점/);
  assert.match(box.textContent,/보증하지 않습니다/);assert.doesNotMatch(box.textContent,/오차 0|100%/);
});
test('legacy, missing and unknown observations never claim successful calibration',()=>{
  assert.match(calibrationState({status:'stochastic'}),/일반 잡음/);
  assert.match(calibrationState({status:'unsupported'}),/확인할 수 없습니다/);
  assert.match(calibrationState(null),/대기/);
});
test('monitor counts only sender-tagged profiles and removes its dialog on close',()=>{
  globalThis.document=fakeDocument;const parent=new FakeElement('div'),monitor=new CalibrationMonitor();monitor.mount(parent);
  monitor.update({aircraft:[{calibration_profile:'known_bias_v1'},{calibration_profile:'stochastic'},{}]});
  assert.match(parent.textContent,/실제 수신 1대/);
  let removed=false;monitor.dialog={remove(){removed=true;}};monitor.close();assert.ok(removed);assert.equal(monitor.box,null);
});
