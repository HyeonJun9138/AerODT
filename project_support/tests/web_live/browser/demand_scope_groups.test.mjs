import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fakeDocument} from './fake_dom.mjs';
import {DemandPanel} from '../../../../user_application/web/domains/uam/planning/demand_panel.js';
import {defaultState} from '../../../../user_application/web/demand_setup.js';

// Picking the decks a study covers used to be nineteen separate choices. With an
// 울산 site beside the capital-area network, "all of 수도권" is the usual
// request, and eighteen ticks is the wrong way to make it.

const deck = (id, name, group) => ({id, name, group, gates: 4, fatos: [{role: 'both'}],
  latitude: 37.5, longitude: 127});
const DECKS = [deck('vp-1', '여의도', '수도권'), deck('vp-2', '인천', '수도권'),
  deck('vp-3', '울산 테스트', '울산'), deck('vp-4', '어딘가', '')];

const panelOf = (records, scope = []) => Object.assign(Object.create(DemandPanel.prototype),
  {document: fakeDocument, records, state: {...defaultState(), scope},
   repaint(){this.repainted = (this.repainted ?? 0) + 1;}});

test('decks are gathered by the network they belong to', () => {
  const groups = panelOf(DECKS).scopeGroups();
  assert.deepEqual(groups.map(([name]) => name), ['수도권', '울산', '미분류']);
  assert.deepEqual(groups[0][1].map(d => d.name), ['여의도', '인천']);
  // Anything not filed yet sinks to the bottom: it is a to-do, not a place.
  assert.deepEqual(groups.at(-1)[1].map(d => d.name), ['어딘가']);
});

test('a deck placed before there were groups is unfiled, not lost', () => {
  const groups = panelOf([{id: 'x', name: '오래된 곳', gates: 2, fatos: []}]).scopeGroups();
  assert.deepEqual(groups.map(([name]) => name), ['미분류']);
  assert.equal(groups[0][1][0].id, 'x');
});

test('taking a whole network in leaves the other networks as they were', () => {
  const panel = panelOf(DECKS, ['vp-3']);
  const [, capital] = panel.scopeGroups()[0];
  panel.setGroupScope(capital, true);
  assert.deepEqual([...panel.state.scope].sort(), ['vp-1', 'vp-2', 'vp-3'], '울산 stays chosen');
  panel.setGroupScope(capital, false);
  assert.deepEqual(panel.state.scope, ['vp-3'], 'and only the capital area is dropped');
});

test('a network already wholly in is not added twice', () => {
  const panel = panelOf(DECKS, ['vp-1', 'vp-2']);
  panel.setGroupScope(panel.scopeGroups()[0][1], true);
  assert.deepEqual([...panel.state.scope].sort(), ['vp-1', 'vp-2']);
});

test('each network gets a heading that says how much of it is in, and turns it', () => {
  const panel = panelOf(DECKS, ['vp-1']);
  const nodes = [];
  panel.scopeStep.call({...panel, table: (id, rows) => {nodes.push(...rows); return null;},
    tools: () => null, button: () => null, el: DemandPanel.prototype.el.bind(panel),
    scopeGroups: () => panel.scopeGroups(), setGroupScope: (...a) => panel.setGroupScope(...a),
    toggleScope: () => {}, onFocus: () => {}, scrapping: false});
  const heads = nodes.filter(node => String(node.className ?? '').includes('dm-row-group'));
  assert.equal(heads.length, 3, 'one heading per network');
  assert.equal(heads[0].getAttribute('data-state'), 'some', '수도권 is half chosen');
  assert.equal(heads[1].getAttribute('data-state'), 'none');
  const counts = heads.map(head => head.querySelector('small')?.textContent);
  assert.deepEqual(counts, ['1 / 2곳', '0 / 1곳', '0 / 1곳']);
});

test('one network on its own needs no heading to find its decks', () => {
  const panel = panelOf([deck('a', '여의도', '수도권'), deck('b', '강남', '수도권')]);
  const nodes = [];
  panel.scopeStep.call({...panel, table: (id, rows) => {nodes.push(...rows); return null;},
    tools: () => null, button: () => null, el: DemandPanel.prototype.el.bind(panel),
    scopeGroups: () => panel.scopeGroups(), setGroupScope: () => {},
    toggleScope: () => {}, onFocus: () => {}, scrapping: false});
  assert.equal(nodes.filter(n => String(n.className ?? '').includes('dm-row-group')).length, 0);
  assert.equal(nodes.length, 2, 'just the two decks');
});

test('the heading is styled to sit above the rows it names', () => {
  const css = readFileSync(new URL('../../../../user_application/web/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.dm-row-group\{[^}]*position:sticky/, 'it stays visible while the list scrolls');
  assert.match(css, /\.dm-row-group\[data-state=all\]/);
});
