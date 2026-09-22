import test from 'node:test';
import assert from 'node:assert/strict';
import {budgetTileProcessing, DEFAULT_TILE_PROCESS_BUDGET_MS} from '../../../../digital_twin/visualization/web/tile_processing_budget.js';

// A stand-in for Cesium3DTile: `process` costs whatever the tile says it
// costs, on a clock the test advances, and records the frame it ran in. A tile
// whose bytes have arrived is finished by one call and leaves the queue, as
// Cesium's own loop drops a tile once its content is ready; a tile that is
// still waiting costs next to nothing and stays.
function cesium() {
  const clock = {now: 0};
  class Cesium3DTile {
    constructor(cost = 0, {waiting = false, broken = false} = {}) {Object.assign(this, {cost, waiting, broken, runs: []});}
    process(tileset, frameState) {
      clock.now += this.cost;
      this.runs.push(frameState.frameNumber);
      if (this.broken) throw new Error('bad content');
      return 'done';
    }
  }
  return {C: {Cesium3DTile}, clock};
}
// One pass of Cesium's processing loop: every queued tile is asked, in order,
// and the ones that finished are dropped afterwards.
function walk(queue, frameNumber) {
  for (const tile of queue) {try {tile.process({}, {frameNumber});} catch {}}
  return queue.filter(tile => tile.waiting || !tile.runs.includes(frameNumber));
}

test('a batch of arrived tiles is finished one per frame, not all in the frame they landed', () => {
  const {C, clock} = cesium();
  const budget = budgetTileProcessing(C, {budgetMs: 3, clock: () => clock.now});
  assert.ok(budget);
  const tiles = [new C.Cesium3DTile(20), new C.Cesium3DTile(25), new C.Cesium3DTile(30)];
  let queue = walk(tiles, 1);
  assert.deepEqual(tiles.map(t => t.runs), [[1], [], []], 'the first arrival spends the frame');
  queue = walk(queue, 2);
  assert.deepEqual(tiles.map(t => t.runs), [[1], [2], []]);
  queue = walk(queue, 3);
  assert.deepEqual(tiles.map(t => t.runs), [[1], [2], [3]]);
  assert.equal(queue.length, 0);
  assert.deepEqual(budget.stats(), {processed: 3, deferred: 3, frames: 3});
  budget.release();
});

test('tiles still waiting for their bytes are all walked; the first heavy one ends the frame', () => {
  const {C, clock} = cesium();
  const budget = budgetTileProcessing(C, {budgetMs: 3, clock: () => clock.now});
  const waiting = Array.from({length: 12}, () => new C.Cesium3DTile(.05, {waiting: true}));
  const heavy = new C.Cesium3DTile(40), later = new C.Cesium3DTile(40);
  const queue = walk([...waiting, heavy, later], 7);
  assert.ok(waiting.every(t => t.runs.length === 1), 'cheap calls never exhaust the allowance');
  assert.deepEqual(heavy.runs, [7]);
  assert.deepEqual(later.runs, [], 'the tile after the heavy one waits a frame');
  assert.equal(queue.length, 13);
  walk(queue, 8);
  assert.deepEqual(later.runs, [8]);
  budget.release();
});

test('one tile dearer than the whole allowance is still finished, every frame it asks', () => {
  const {C, clock} = cesium();
  const budget = budgetTileProcessing(C, {budgetMs: 3, clock: () => clock.now});
  const tile = new C.Cesium3DTile(120, {waiting: true});
  for (let frame = 1; frame <= 3; frame++) assert.equal(tile.process({}, {frameNumber: frame}), 'done');
  assert.deepEqual(tile.runs, [1, 2, 3]);
  budget.release();
});

test('two scenes with their own frame counters each get an allowance, and release restores Cesium', () => {
  const {C, clock} = cesium();
  const original = C.Cesium3DTile.prototype.process;
  const budget = budgetTileProcessing(C, {budgetMs: 3, clock: () => clock.now});
  assert.equal(budgetTileProcessing(C), budget, 'patching twice answers the same handle');
  const map = [new C.Cesium3DTile(10), new C.Cesium3DTile(10)], camera = [new C.Cesium3DTile(10), new C.Cesium3DTile(10)];
  walk(map, 500); walk(camera, 12);
  assert.deepEqual([map[0].runs, map[1].runs, camera[0].runs, camera[1].runs], [[500], [], [12], []]);
  budget.release();
  assert.equal(C.Cesium3DTile.prototype.process, original);
  walk(map, 501);
  assert.deepEqual(map.map(t => t.runs), [[500, 501], [501]], 'unpatched, the whole queue is finished at once');
  assert.equal(budgetTileProcessing({}), null, 'a stub without tiles is left alone');
  assert.equal(DEFAULT_TILE_PROCESS_BUDGET_MS, 3);
});

test('a tile that throws while being finished still charges the frame and rethrows', () => {
  const {C, clock} = cesium();
  const budget = budgetTileProcessing(C, {budgetMs: 3, clock: () => clock.now});
  const broken = new C.Cesium3DTile(5, {broken: true}), next = new C.Cesium3DTile(5);
  assert.throws(() => broken.process({}, {frameNumber: 1}), /bad content/);
  next.process({}, {frameNumber: 1});
  assert.deepEqual(next.runs, [], 'the failed tile spent the frame');
  next.process({}, {frameNumber: 2});
  assert.deepEqual(next.runs, [2]);
  budget.release();
});
