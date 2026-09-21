import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement, fakeDocument} from './fake_dom.mjs';
import {FLOOR_PCT, SchedulingProgress, WORD, fillPercent, readPercent, stageMeta}
  from '../../../../user_application/web/domains/uam/planning/scheduling_progress.js';

const web = new URL('../../../../user_application/web/', import.meta.url);
const sheet = readFileSync(new URL('styles.css', web), 'utf8');
const css = readFileSync(new URL('scheduling_progress.css', web), 'utf8');
const app = readFileSync(new URL('app.js', web), 'utf8');

function rule(selector) {
  const found = css.match(new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm'));
  return found ? found[2] : '';
}
// One page per test: the shared fake document keeps whatever the last test put
// in it, and an overlay that is meant to be the only one on the page cannot be
// counted in a body somebody else has already used.
const page = () => ({createElement: tag => new FakeElement(tag),
  createElementNS: (_namespace, tag) => new FakeElement(tag), body: new FakeElement('body')});

function open(message) {
  const document = page();
  const progress = new SchedulingProgress({document, mount: document.body});
  progress.open(message);
  return {document, progress};
}
const find = (root, selector) => [...root.walk()].find(node => node.matches(selector));

test('the fill has a floor so a run that just started still shows, and the readout does not', () => {
  assert.equal(fillPercent(0), FLOOR_PCT, 'an empty word looks like a word that will not fill');
  assert.equal(readPercent(0), 0, 'but 0% is what it says');
  assert.equal(fillPercent(42), 42);
  assert.equal(fillPercent(140), 100);
  assert.equal(fillPercent('nonsense'), FLOOR_PCT);
  assert.equal(readPercent(41.6), 42);
});

test('the word is drawn twice: a ghost and a fill clipped to how far along it is', () => {
  const {progress} = open();
  const ghost = find(progress.root, '.sch-ghost');
  const fill = find(progress.root, '.sch-fill');
  assert.equal(ghost.textContent, WORD);
  assert.equal(find(fill, '.sch-fill-text').textContent, WORD, 'the same word, so the glyphs line up');
  assert.equal(ghost.getAttribute('aria-hidden'), 'true');
  assert.equal(fill.getAttribute('aria-hidden'), 'true', 'the picture is not read out twice');
  progress.set({percent: 42, message: '항로를 계산하는 중입니다 · 128/306'});
  assert.equal(fill.style.getPropertyValue('--fill'), '42%');
  assert.equal(find(progress.root, '.sch-figure').textContent, '42');
  assert.equal(find(progress.root, '.sch-message').textContent, '항로를 계산하는 중입니다 · 128/306');
});

test('the percentage and the sentence are announced, the word is not', () => {
  const {progress} = open('비행계획을 준비하는 중입니다');
  assert.equal(progress.root.getAttribute('role'), 'status');
  assert.equal(progress.root.getAttribute('aria-live'), 'polite');
  assert.equal(find(progress.root, '.sch-message').textContent, '비행계획을 준비하는 중입니다');
});

test('a status that arrives out of order does not pull the bar backwards', () => {
  const {progress} = open();
  progress.set({percent: 70});
  progress.set({percent: 12});
  assert.equal(find(progress.root, '.sch-figure').textContent, '70');
  assert.equal(progress.shown, 70);
});

test('finishing fills the word, and a failure stays on screen with the reason', () => {
  const {progress} = open();
  progress.set({percent: 30});
  progress.done('비행계획을 적용했습니다');
  assert.equal(progress.root.getAttribute('data-state'), 'done');
  assert.equal(find(progress.root, '.sch-figure').textContent, '100');
  progress.close();
  const failed = open().progress;
  failed.fail('비행계획을 만들지 못했습니다', '연결된 버티포트 쌍이 없습니다');
  assert.equal(failed.root.getAttribute('data-state'), 'error');
  assert.equal(find(failed.root, '.sch-note').textContent, '연결된 버티포트 쌍이 없습니다');
  const button = find(failed.root, 'button#scheduling-close');
  assert.equal(button.hidden, false, 'a failure can be dismissed; a run in progress cannot');
  button.onclick();
  assert.equal(failed.isOpen, false);
});

test('opening twice leaves one of it, and closing takes it off the page', () => {
  const document = page();
  const progress = new SchedulingProgress({document, mount: document.body});
  progress.open(); progress.open();
  assert.equal([...document.body.walk()].filter(node => node.matches('section#scheduling')).length, 1);
  progress.close();
  assert.equal([...document.body.walk()].filter(node => node.matches('section#scheduling')).length, 0);
  assert.equal(progress.isOpen, false);
});

test('the sheet the page loads pulls the overlay style in with it', () => {
  assert.match(sheet, /@import url\("\.\/scheduling_progress\.css"\);/);
});

test('the word fills from the bottom and the two copies sit on the same line', () => {
  assert.match(rule('.sch-word'), /position:\s*relative/);
  const fill = rule('.sch-fill');
  assert.match(fill, /position:\s*absolute/);
  assert.match(fill, /bottom:\s*0/, 'it fills upward from the foot of the word');
  assert.match(fill, /height:\s*var\(--fill/);
  assert.match(fill, /overflow:\s*hidden/, 'what is above the fill line is clipped away');
  const text = rule('.sch-fill-text');
  assert.match(text, /position:\s*absolute/);
  assert.match(rule('.scheduling'), /position:\s*fixed/);
});

test('the tail of the g is inside the word, so the fill reaches it', () => {
  // A line box of exactly 1em ends at the baseline, and the g hangs 0.24em
  // below it (measured in the app's own font). That tail therefore fell outside
  // the word's box, below where the fill starts, and no amount of progress ever
  // coloured it: the fill clips anything outside itself.
  const word = rule('.sch-word');
  assert.match(word, /line-height:\s*1;/, 'the copies still register on a 1em line box');
  assert.match(word, /--sch-descent:\s*\.25em/, 'and the box reserves the font descent below it');
  assert.match(word, /padding:[^;}]*var\(--sch-descent\)/, 'as padding under the baseline');
  // The filled copy is a gradient clipped to the glyphs, and a background only
  // covers the box it is painted on — so the tail, which hangs below that box,
  // had no gradient to be clipped from and came out transparent however full
  // the word was. The padding carries the background down over it.
  const text = rule('.sch-fill-text');
  assert.match(text, /background-clip:\s*text/);
  assert.match(text, /padding-bottom:\s*var\(--sch-descent\)/, 'the gradient reaches the tail');
  assert.match(text, /bottom:\s*0/, 'and the box sits on the bottom of the word, tail included');
  // The fill itself still starts at the very bottom of that taller box, which
  // is now below the tail rather than at the baseline.
  assert.match(rule('.sch-fill'), /bottom:\s*0/);
});

test('the page drives it from the generator and applies what it made', () => {
  assert.match(app, /SchedulingProgress/, 'the page owns the overlay');
  assert.match(app, /plans\/multi/, 'and asks the generator how the run is going');
  assert.match(app, /adoptPlan/, 'the finished day is handed to the panel like the example one');
});


test('a running overlay reserves 100 percent for confirmed completion', () => {
  const {progress} = open();
  progress.set({percent: 100, message: '예측 준비'});
  assert.equal(progress.shown, 99);
  progress.done();
  assert.equal(progress.shown, 100);
});

test('the stages are drawn along the bottom: done ticked with its time, the running one with its count, the rest waiting', () => {
  const document = {...fakeDocument, body: new FakeElement('body')};
  const progress = new SchedulingProgress({document, mount: document.body});
  progress.open('비행계획을 준비하는 중입니다');
  const stages = [
    {id: 'demand', label: '수요 생성', state: 'done', seconds: 0.4},
    {id: 'routes', label: '항로 계산', state: 'running', seconds: 3, count: {done: 24, total: 306}},
    {id: 'dispatch', label: '기체 배정', state: 'pending', seconds: null},
    {id: 'forecast', label: '기체 예측 준비', state: 'pending', seconds: null},
  ];
  progress.setStages(stages);
  const chips = progress.root.querySelectorAll('.sch-stage');
  assert.equal(chips.length, 4);
  assert.deepEqual(chips.map(chip => chip.getAttribute('data-state')), ['done', 'running', 'pending', 'pending']);
  assert.equal(chips[0].querySelector('.sch-stage-meta').textContent, '0.4초');
  assert.equal(chips[1].querySelector('.sch-stage-meta').textContent, '24/306 · 3.0초');
  assert.equal(chips[2].querySelector('.sch-stage-meta').textContent, '');
  // The next poll updates the same chips rather than adding new ones.
  progress.setStages([{id: 'demand', label: '수요 생성', state: 'done', seconds: 0.4},
    {id: 'routes', label: '항로 계산', state: 'done', seconds: 12},
    {id: 'dispatch', label: '기체 배정', state: 'running', seconds: 1.2},
    {id: 'forecast', label: '기체 예측 준비', state: 'pending', seconds: null}]);
  const again = progress.root.querySelectorAll('.sch-stage');
  assert.equal(again.length, 4, 'chips keep their identity');
  assert.equal(again[1].getAttribute('data-state'), 'done');
  assert.equal(again[1].querySelector('.sch-stage-meta').textContent, '12초');
  assert.equal(again[2].querySelector('.sch-stage-meta').textContent, '1.2초');
  // A failure is named on the stage it happened in.
  assert.equal(stageMeta({state: 'error'}), '중단');
  assert.equal(stageMeta({state: 'pending', seconds: 5}), '', 'nothing while waiting');
  // Nothing to draw before open, and nothing after close.
  progress.close();
  assert.equal(progress.setStages(stages), undefined);
});
