// A hidden tab keeps its revision timer but does not ask; shown again, it asks
// at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ChangeWatch} from '../../../../user_application/web/change_watch.js';

function harness() {
  const timers = new Map(), listeners = new Map();
  let asked = 0, id = 0, revision = 'a';
  const document = {hidden: false,
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name)};
  const changes = [];
  const watch = new ChangeWatch({
    read: async () => {asked++; return {revision};},
    onChange: answer => {changes.push(answer);},
    intervalMs: 100, document,
    setTimer: fn => {timers.set(++id, fn); return id;},
    clearTimer: key => {timers.delete(key);},
  });
  const fire = () => {const pending = [...timers.values()]; timers.clear(); return Promise.all(pending.map(fn => fn()));};
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {watch, document, timers, listeners, fire, settle, changes, asked: () => asked, move: value => {revision = value;}};
}

test('a hidden tab skips the read but keeps the beat, and asks the moment it is shown', async () => {
  const h = harness();
  h.watch.start();
  await h.settle();
  assert.equal(h.asked(), 1);
  assert.ok(h.listeners.has('visibilitychange'), 'listens for the tab being shown');
  h.document.hidden = true;
  await h.fire(); await h.settle();
  assert.equal(h.asked(), 1, 'hidden: nothing asked');
  assert.equal(h.timers.size, 1, 'the beat goes on');
  await h.fire(); await h.settle();
  assert.equal(h.asked(), 1);
  h.move('b');
  h.document.hidden = false;
  h.listeners.get('visibilitychange')();
  await h.settle();
  assert.equal(h.asked(), 2, 'shown: asked at once');
  assert.equal(h.changes.length, 1, 'and the edit made while hidden is noticed');
  assert.equal(h.watch.revision, 'b');
  h.watch.stop();
  assert.ok(!h.listeners.has('visibilitychange'));
  assert.equal(h.timers.size, 0);
});

test('without a document (tests, workers) the watch behaves as before', async () => {
  const timers = new Map(); let asked = 0, id = 0;
  const watch = new ChangeWatch({read: async () => {asked++; return {revision: 'x'};}, intervalMs: 50, document: null,
    setTimer: fn => {timers.set(++id, fn); return id;}, clearTimer: key => {timers.delete(key);}});
  watch.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(asked, 1);
  assert.equal(watch.hidden(), false);
  watch.stop();
});
