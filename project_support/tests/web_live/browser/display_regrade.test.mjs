import test from 'node:test';
import assert from 'node:assert/strict';
import {DisplayResolution, displayProfile} from '../../../../digital_twin/visualization/web/display_resolution.js';
import {FrameTiming} from '../../../../digital_twin/visualization/web/frame_timing.js';

// The startup sample grades an almost empty globe. A display that looked quick
// there kept its budget for the whole session however heavy the scene became,
// which is how an ultrawide ends up drawing all 4.95 million of its pixels at
// ten frames a second: the grade is measured once and the work grows after it.

const ULTRAWIDE = {clientWidth: 3440, clientHeight: 1440};

function resolution({tier = 'fast', mode = 'auto'} = {}) {
  const canvas = {style: {}, getContext: () => null};
  const viewer = {canvas, container: ULTRAWIDE, resolutionScale: 1,
    useBrowserRecommendedResolution: true, scene: {requestRender() {}}};
  const environment = {devicePixelRatio: 1, innerWidth: 3440, innerHeight: 1440,
    addEventListener() {}, removeEventListener() {}, setTimeout() {}, clearTimeout() {},
    matchMedia: () => ({addEventListener() {}, removeEventListener() {}}), document: null};
  const display = new DisplayResolution(viewer, {environment, mode, sample: async () => ({status: 'measured', samples: 30, p50Ms: 10, p75Ms: 12})});
  display.tier = tier;
  display.result = {status: 'measured', samples: 30};
  display.refresh({notify: false});
  return {display, viewer};
}

const SLOW = {samples: 40, p50Ms: 95, p75Ms: 110};
const QUICK = {samples: 40, p50Ms: 9, p75Ms: 12};

test('an ultrawide graded fast draws every native pixel, which is the thing to catch', () => {
  const fast = displayProfile({width: 3440, height: 1440, dpr: 1}, {mode: 'auto', tier: 'fast'});
  assert.equal(fast.pixelRatio, 1, '예산이 화면보다 커서 줄이지 않는다');
  assert.equal(fast.renderWidth * fast.renderHeight, 3440 * 1440);
  const cheap = displayProfile({width: 3440, height: 1440, dpr: 1}, {mode: 'auto', tier: 'constrained'});
  assert.ok(cheap.renderWidth * cheap.renderHeight < fast.renderWidth * fast.renderHeight / 2,
    '한 단계 내리면 픽셀이 절반 아래로');
});

test('frames that stay slow lower the grade, and only after they stay slow', () => {
  const {display, viewer} = resolution();
  assert.equal(viewer.resolutionScale, 1);
  // A hitch is not a grade. Six seconds of it is.
  display.observe({...SLOW, now: 0});
  display.observe({...SLOW, now: 3000});
  assert.equal(display.tier, 'fast', '몇 초로는 등급을 바꾸지 않는다');
  display.observe({...SLOW, now: 6500});
  assert.equal(display.tier, 'constrained');
  assert.ok(viewer.resolutionScale < .7, `배율 ${viewer.resolutionScale}`);
});

test('a moment of recovery resets the case against the grade', () => {
  const {display} = resolution();
  display.observe({...SLOW, now: 0});
  display.observe({...QUICK, now: 3000});      // 회복
  display.observe({...SLOW, now: 5000});
  display.observe({...SLOW, now: 8000});       // 회복 뒤 3초뿐
  assert.equal(display.tier, 'fast', '느린 시간이 이어져야 한다');
});

test('the grade is never raised from a quiet moment', () => {
  const {display} = resolution({tier: 'constrained'});
  for (let now = 0; now <= 30000; now += 1000) display.observe({...QUICK, now});
  assert.equal(display.tier, 'constrained', '다시 맞추기로만 올라간다');
});

test('a display the operator graded themselves is not second-guessed', () => {
  for (const mode of ['sharp', 'efficient']) {
    const {display} = resolution({mode});
    for (let now = 0; now <= 20000; now += 1000) display.observe({...SLOW, now});
    assert.equal(display.tier, 'fast', mode);
  }
});

test('a grade is not lowered on a handful of frames, or while one is being taken', () => {
  const {display} = resolution();
  for (let now = 0; now <= 20000; now += 1000) display.observe({samples: 8, p50Ms: 95, p75Ms: 110, now});
  assert.equal(display.tier, 'fast', '표본이 모자라면 판단하지 않는다');

  const sampling = resolution().display;
  sampling.result = {status: 'sampling', samples: 0};
  for (let now = 0; now <= 20000; now += 1000) sampling.observe({...SLOW, now});
  assert.equal(sampling.tier, 'fast', '측정 중에는 끼어들지 않는다');
});

test('the timing the grader reads is the same ring the readout does', () => {
  const timing = new FrameTiming();
  let now = 0;
  for (let i = 0; i < 60; i++) {timing.record(now); now += 100;}
  const summary = timing.summary();
  assert.ok(Number.isFinite(summary.p75Ms), 'p75가 나온다');
  assert.ok(summary.p50Ms <= summary.p75Ms && summary.p75Ms <= summary.p95Ms, '같은 표본에서 정렬된 값');
  assert.equal(summary.samples, 59);
});
