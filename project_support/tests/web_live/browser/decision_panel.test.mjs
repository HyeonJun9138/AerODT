import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeElement, fakeDocument} from './fake_dom.mjs';
import {DecisionPanel, wrap} from '../../../../user_application/web/domains/uam/operations/decision_panel.js';

const CHARTS = [
  {id: 'psu', name: 'PSU · 착륙 순서', role: 'psu', summary: '먼저 물은 편이 먼저 내린다.', entry: 'ask',
   nodes: [{id: 'ask', kind: 'start', text: '요청', next: 'pad'},
           {id: 'pad', kind: 'decision', text: '패드가 비었나?', yes: 'clear', no: 'hold'},
           {id: 'clear', kind: 'end', text: '진입'},
           {id: 'hold', kind: 'end', text: '대기'}],
   parameters: [
     {id: 'gap_s', label: '착륙 간격', unit: '초', node: 'pad', min: 20, max: 600, step: 5,
      default: 90, scope: 'live', note: '연속 착륙 사이의 시간'},
     {id: 'release', label: '접지에서 패드를 놓는다', kind: 'toggle', node: 'pad',
      default: true, scope: 'live'}]},
  {id: 'pilot', name: '조종사', role: 'pilot', summary: '경유점을 따라간다.', entry: 'tick',
   nodes: [{id: 'tick', kind: 'start', text: '상태를 읽는다', next: 'go'},
           {id: 'go', kind: 'end', text: '따라간다'}],
   parameters: [{id: 'brake', label: '감속도', unit: 'm/s²', node: 'go', min: .2, max: 3,
                 step: .1, default: .7, scope: 'native'}]},
  {id: 'vertiport', name: '버티포트', role: 'vertiport', summary: '데크의 몫.', entry: 'land',
   nodes: [{id: 'land', kind: 'start', text: '접지', next: 'done'},
           {id: 'done', kind: 'end', text: '주기'}],
   parameters: [{id: 'release', label: '접지에서 패드를 놓는다', kind: 'toggle', node: 'land',
                 default: true, scope: 'live', source: 'psu'}]},
];

function answer(values = {}) {
  const full = {psu: {gap_s: 90, release: true}, pilot: {brake: .7}, vertiport: {release: true}};
  for (const [chart, moved] of Object.entries(values)) Object.assign(full[chart], moved);
  full.vertiport.release = full.psu.release;   // the server resolves the mirror
  return {charts: CHARTS, values: full, defaults: {psu: {gap_s: 90, release: true},
    pilot: {brake: .7}, vertiport: {release: true}}, applies_to: '다음 재생'};
}

test('reported Physical policy cannot write to local Simulation settings',async()=>{
  const calls=[];const document={...fakeDocument,body:new FakeElement('body')};
  const panel=new DecisionPanel({document,api:{read:async()=>({...answer(),read_only:true}),
    write:async()=>calls.push('write'),reset:async()=>calls.push('reset')}});
  await panel.open();panel.pending={psu:{gap_s:120}};await panel.save();await panel.reset();
  assert.equal(panel.saveButton.disabled,true);assert.deepEqual(calls,[]);panel.close();
});

function panelWith({saved = {}, onWrite = null} = {}) {
  const document = {...fakeDocument, body: new FakeElement('body')};
  const written = [];
  let state = answer(saved);
  const panel = new DecisionPanel({document, api: {
    read: async () => state,
    write: async values => {written.push(values); state = onWrite ? onWrite(values) : answer(values); return state;},
    reset: async () => {written.push('reset'); state = answer(); return state;}}});
  return {panel, document, written};
}

const rowFor = (panel, id) => panel.detail.querySelectorAll('.dc-row')
  .find(row => row.querySelector(`#dc-${panel.chartId}-${id}`));

test('the window draws every decision as a shape, with the questions as diamonds', async () => {
  const {panel} = panelWith();
  await panel.open();
  const nodes = panel.flow.querySelectorAll('.dc-node');
  assert.equal(nodes.length, 4, 'one shape per node of the chart that is showing');
  const decision = nodes.find(n => n.getAttribute('data-kind') === 'decision');
  assert.equal(decision.querySelector('path').tagName, 'PATH', 'a question is a diamond, not a box');
  const start = nodes.find(n => n.getAttribute('data-kind') === 'start');
  assert.equal(start.querySelector('rect').tagName, 'RECT');
  // A branch has to be labelled or the drawing does not say which way is which.
  const labels = panel.flow.querySelectorAll('.dc-edge-label').map(n => n.textContent);
  assert.ok(labels.includes('예') && labels.includes('아니오'));
});

test('clicking a decision shows the numbers that decision turns on, and nothing else', async () => {
  const {panel} = panelWith();
  await panel.open();
  // Nothing selected: the whole chart's values, so the window is useful before
  // the operator knows which box they want.
  assert.equal(panel.detail.querySelectorAll('.dc-row').length, 2);
  panel.flow.querySelectorAll('.dc-node').find(n => n.getAttribute('data-kind') === 'decision').click();
  assert.equal(panel.detail.querySelectorAll('.dc-row').length, 2, 'both belong to that branch');
  panel.selected = 'clear';
  panel.draw();
  assert.match(panel.detail.textContent, /조정할 값이 없습니다/,
    'a step with no numbers says so rather than showing an empty list');
});

test('a moved value is held until it is saved, and the window says which', async () => {
  const {panel, written} = panelWith();
  await panel.open();
  assert.match(panel.status.textContent, /모두 기본값/);
  assert.equal(panel.saveButton.disabled, true);

  const gap = rowFor(panel, 'gap_s').querySelector('.dc-slider');
  gap.value = '150';
  gap.onchange({target: gap});
  assert.match(panel.status.textContent, /저장하지 않은/);
  assert.equal(panel.saveButton.disabled, false);
  assert.equal(rowFor(panel, 'gap_s').getAttribute('data-moved'), 'true');
  assert.match(rowFor(panel, 'gap_s').textContent, /기본 90 초/, 'and what it was before');
  assert.equal(written.length, 0, 'nothing is written until save is pressed');

  await panel.save();
  assert.equal(written.length, 1);
  assert.equal(written[0].psu.gap_s, 150);
  assert.equal(written[0].pilot.brake, .7, 'the charts nobody touched are sent unchanged');
  assert.equal(panel.dirty, false);
  assert.match(panel.status.textContent, /1개 항목이 바뀐/);
});

test('dragging a slider moves its own readout without redrawing the chart under the finger', async () => {
  const {panel} = panelWith();
  await panel.open();
  const row = rowFor(panel, 'gap_s');
  const slider = row.querySelector('.dc-slider');
  slider.value = '300';
  slider.oninput({target: slider});
  assert.match(row.querySelector('.dc-value').textContent, /300 초/);
  assert.equal(row.querySelector('.dc-number').value, '300');
  assert.equal(rowFor(panel, 'gap_s'), row, 'the same row, not a rebuilt one');
});

test('a value two charts share is stored once and shown on both', async () => {
  const {panel, written} = panelWith();
  await panel.open();
  panel.chartId = 'vertiport';
  panel.draw();
  const toggle = rowFor(panel, 'release').querySelector('.dc-toggle');
  assert.match(rowFor(panel, 'release').textContent, /PSU 차트와 공유/);
  toggle.checked = false;
  toggle.onchange({target: toggle});
  await panel.save();
  assert.equal(written[0].psu.release, false, 'it is kept where the PSU keeps it');
  panel.chartId = 'psu';
  panel.draw();
  assert.match(rowFor(panel, 'release').textContent, /끔/, 'and the other chart shows the same');
});

test('a tab counts what has been moved on the chart behind it', async () => {
  const {panel} = panelWith({saved: {pilot: {brake: 1.4}}});
  await panel.open();
  const pilotTab = panel.tabs.children.find(tab => tab.textContent.includes('조종사'));
  assert.match(pilotTab.textContent, /1/, 'so a changed rule is visible without opening its tab');
  const psuTab = panel.tabs.children.find(tab => tab.textContent.includes('PSU'));
  assert.ok(!psuTab.querySelector('.dc-moved'));
});

test('reset puts everything back and says so', async () => {
  const {panel, written} = panelWith({saved: {psu: {gap_s: 240}}});
  await panel.open();
  assert.match(panel.status.textContent, /1개 항목이 바뀐/);
  await panel.reset();
  assert.equal(written[0], 'reset');
  assert.match(panel.status.textContent, /모두 기본값/);
  assert.match(rowFor(panel, 'gap_s').textContent, /90 초/);
});

test('a value the operator cannot change mid-flight says when it takes effect', async () => {
  const {panel} = panelWith();
  await panel.open();
  panel.chartId = 'pilot';
  panel.draw();
  const row = rowFor(panel, 'brake');
  assert.equal(row.getAttribute('data-scope'), 'native');
  assert.match(row.textContent, /이미 떠 있는 기체는/);
  assert.match(panel.appliesTo.textContent, /다음 재생/);
});

test('a failure to read says so instead of drawing an empty chart', async () => {
  const document = {...fakeDocument, body: new FakeElement('body')};
  const panel = new DecisionPanel({document, api: {read: async () => {throw new Error('HTTP 503');}}});
  await panel.open();
  assert.match(panel.flow.textContent, /HTTP 503/);
  assert.match(panel.status.textContent, /HTTP 503/);
});

test('long text wraps inside its shape rather than running out of it', () => {
  assert.deepEqual(wrap('짧다', 15), ['짧다']);
  const lines = wrap('주기장이 비어 있지 않으면 다른 자리를 찾는다', 15);
  assert.ok(lines.length > 1 && lines.length <= 3);
  assert.ok(lines.every(line => line.length <= 20));
});


test('a party opens the window at its own chart, and the rest stay reachable', async () => {
  const {panel} = panelWith();
  await panel.open('vertiport');
  assert.equal(panel.chartId, 'vertiport', 'the deck operator lands on the deck chart');
  assert.equal(panel.tabs.children.length, 3, 'and can still read the other two');
  // Opened again from another screen while it is still up: it follows.
  await panel.open('pilot');
  assert.equal(panel.chartId, 'pilot');
  // A party with no chart of its own is not sent to a blank window: it keeps
  // whatever was last showing, which is less startling than jumping.
  panel.close();
  await panel.open('operator');
  assert.equal(panel.chartId, 'pilot');
  assert.equal(panel.detail.querySelectorAll('.dc-row').length, 1, 'and it is drawn, not empty');
});

test('a tab chosen by hand is not overridden the next time the window is raised', async () => {
  const {panel} = panelWith();
  await panel.open('psu');
  panel.tabs.children.find(tab => tab.textContent.includes('버티포트')).click();
  assert.equal(panel.chartId, 'vertiport');
  await panel.open();          // raised again with no party named
  assert.equal(panel.chartId, 'vertiport', 'the operator chose; nothing has changed their mind');
});
