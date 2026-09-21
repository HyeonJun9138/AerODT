import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ChangeWatch, INTERVAL_MS} from '../../../../user_application/web/change_watch.js';

function harness({answers = [], intervalMs = 100} = {}) {
  const changes = [], timers = new Map();
  let asked = 0, id = 0;
  const watch = new ChangeWatch({
    read: async () => {
      const answer = answers[Math.min(asked, answers.length - 1)];
      asked++;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    onChange: answer => {changes.push(answer);},
    intervalMs,
    setTimer: fn => {timers.set(++id, fn); return id;},
    clearTimer: key => {timers.delete(key);},
  });
  const fire = () => {const pending = [...timers.values()]; timers.clear(); return Promise.all(pending.map(fn => fn()));};
  return {watch, changes, timers, fire, asked: () => asked};
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('the first answer is only remembered, so opening a page is not somebody else\'s edit', async () => {
  const {watch, changes, asked} = harness({answers: [{revision: 'a'}]});
  watch.start();
  await settle();
  assert.equal(asked(), 1);
  assert.deepEqual(changes, [], 'nothing has moved yet');
  assert.equal(watch.revision, 'a');
});

test('a revision that differs reloads once, and the same one again does not', async () => {
  const {watch, changes, fire} = harness({answers: [{revision: 'a'}, {revision: 'b', vertiports: 3}, {revision: 'b'}]});
  watch.start();
  await settle();
  await fire();
  await settle();
  assert.equal(changes.length, 1, 'the change is reported once');
  assert.equal(changes[0].vertiports, 3, 'with what the server answered');
  await fire();
  await settle();
  assert.equal(changes.length, 1, 'holding still says nothing');
});

test('a poll that fails is a missed beat: the watch keeps its place and carries on', async () => {
  const {watch, changes, fire} = harness({answers: [{revision: 'a'}, new Error('offline'), {revision: 'c'}]});
  watch.start();
  await settle();
  await fire();
  await settle();
  assert.deepEqual(changes, [], 'a failure is not a change');
  assert.equal(watch.revision, 'a', 'and does not lose where it was');
  await fire();
  await settle();
  assert.equal(changes.length, 1);
  assert.equal(watch.revision, 'c');
});

test('an answer with no revision is ignored rather than treated as one', async () => {
  const {watch, changes, fire} = harness({answers: [{revision: 'a'}, {}, {revision: 'a'}]});
  watch.start();
  await settle();
  await fire();
  await settle();
  await fire();
  await settle();
  assert.deepEqual(changes, []);
  assert.equal(watch.revision, 'a');
});

test('stopping ends the timer, and starting twice does not double the polling', async () => {
  const {watch, timers, asked, fire} = harness({answers: [{revision: 'a'}]});
  watch.start();
  await settle();
  assert.equal(timers.size, 1, 'one beat is pending');
  watch.start();
  await settle();
  assert.equal(asked(), 1, 'a second start is ignored while it runs');
  watch.stop();
  assert.equal(timers.size, 0, 'the pending beat is dropped');
  await fire();
  await settle();
  assert.equal(asked(), 1, 'nothing polls after stop');
  watch.start();
  await settle();
  assert.equal(asked(), 2, 'and it can be started again');
});

test('the page watches for other people, pauses when hidden and lets go on the way out', () => {
  const app = readFileSync(new URL('../../../../user_application/web/app.js', import.meta.url), 'utf8');
  assert.match(app, /new ChangeWatch\(\{read:\(\)=>getJSON\('\/api\/simulation\/revision'\)/, 'it asks for the revision, not the data');
  assert.match(app, /simulationPanel\.refresh\(\)/);
  assert.match(app, /routePanel\.refresh\(\)/);
  assert.match(app, /document\.hidden\)changeWatch\.stop\(\);else changeWatch\.start\(\)/, 'a hidden tab stops polling');
  assert.match(app, /pagehide'[\s\S]{0,160}changeWatch\.stop\(\)/, 'and the page lets go on the way out');
  // It watches stored data, not the map: a globe that never loads must not stop
  // the panels hearing about somebody else's work.
  const start = app.indexOf('watchWhileVisible();');
  assert.ok(start > 0 && start < app.indexOf('await loadCesium()'), 'the watch starts with the shell, before the map');
  assert.ok(INTERVAL_MS >= 1000 && INTERVAL_MS <= 30000, 'often enough to notice, rare enough to ignore');
});
