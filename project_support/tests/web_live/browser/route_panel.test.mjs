import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement, fakeDocument} from './fake_dom.mjs';
import {RouteCard, TAGS} from '../../../../user_application/web/domains/uam/planning/route_card.js';
import {MODES, RoutePanel, altitudeFromForm, describeLink, fatoDirections, feetToMetres, linkFromForm, metresToFeet, nodeFromForm,
  suggestSegment, foldSegment, openDirections, pairKey, PROFILE_SHAPE} from '../../../../user_application/web/domains/uam/planning/route_panel.js';
import {SimulationPanel, UAM_TABS} from '../../../../user_application/web/domains/uam/planning/simulation_panel.js';

const web = new URL('../../../../user_application/web/', import.meta.url);
const app = readFileSync(new URL('app.js', web), 'utf8');
const css = readFileSync(new URL('styles.css', web), 'utf8');

const seoul = {latitude: 37.53, longitude: 126.93};
const fatos = [
  {id: 'fato:vp-1:F1', kind: 'fato', name: '여의도 F1', vertiport: 'vp-1', vertiport_name: '여의도', fato: 'F1', role: 'takeoff', latitude: 37.5, longitude: 127, hover_m: 30},
  {id: 'fato:vp-1:F2', kind: 'fato', name: '여의도 F2', vertiport: 'vp-1', vertiport_name: '여의도', fato: 'F2', role: 'landing', latitude: 37.5, longitude: 127.001, hover_m: 30},
  {id: 'fato:vp-2:F1', kind: 'fato', name: '강남 F1', vertiport: 'vp-2', vertiport_name: '강남', fato: 'F1', role: 'both', latitude: 37.49, longitude: 127.03, hover_m: 30},
];

test('altitude is entered in feet or metres and kept in metres within the limits', () => {
  assert.equal(altitudeFromForm({altitude: '1000', unit: 'ft'}).metres, 304.8);
  assert.equal(altitudeFromForm({altitude: '500', unit: 'm'}).metres, 500);
  assert.match(altitudeFromForm({altitude: '', unit: 'ft'}).error, /숫자/);
  assert.match(altitudeFromForm({altitude: '40000', unit: 'ft'}).error, /사이/);
  assert.equal(Math.round(metresToFeet(feetToMetres(1000))), 1000);
});

test('a waypoint form becomes a definition, with the place name only when no name was typed', () => {
  const named = nodeFromForm({name: ' 진입 ', altitude: '1000', unit: 'ft', altitude_reference: 'agl', ...seoul, place_name: '여의도동'});
  assert.deepEqual(named.definition, {name: '진입', ...seoul, altitude_m: 304.8, altitude_reference: 'agl'});
  const unnamed = nodeFromForm({name: '', altitude: '400', unit: 'm', altitude_reference: 'msl', ...seoul, place_name: '여의도동'});
  assert.deepEqual(unnamed.definition, {name: '', ...seoul, altitude_m: 400, altitude_reference: 'msl', place_name: '여의도동'});
  const bad = nodeFromForm({name: 'x'.repeat(81), altitude: 'high', unit: 'ft', latitude: 'nowhere'});
  assert.equal(bad.errors.length, 3);
});

test('a link form needs two endpoints and a known segment; only a cruise link carries a width', () => {
  const cruise = linkFromForm({from: 'rn-a', to: 'rn-b', width_m: '300', segment: 'F', name: ''});
  assert.deepEqual(cruise.definition, {from: 'rn-a', to: 'rn-b', segment: 'F', width_m: 300});
  const climb = linkFromForm({from: 'rn-a', to: 'rn-b', width_m: '5', segment: 'C', name: ' 상승 '});
  assert.deepEqual(climb.definition, {from: 'rn-a', to: 'rn-b', segment: 'C', name: '상승'}, 'a climb ignores the width, even a bad one');
  assert.match(linkFromForm({from: 'rn-a', to: 'rn-b', width_m: '5', segment: 'F'}).errors[0], /폭/);
  const bad = linkFromForm({from: 'rn-a', to: '', width_m: '5', segment: 'Z'});
  assert.equal(bad.errors.length, 2);
  // A link saved when the terminal procedures were their own letters is the
  // same flight as the diagonal they were merged into.
  assert.deepEqual(linkFromForm({from: 'rn-a', to: 'rn-b', segment: 'H'}).definition,
    {from: 'rn-a', to: 'rn-b', segment: 'G'}, 'H is flown inside the descent');
  assert.deepEqual(['C', 'D', 'E', 'F', 'G', 'H', 'I'].map(foldSegment), ['C', 'C', 'C', 'F', 'G', 'G', 'G']);
});

test('the suggested segment follows the flight profile', () => {
  const links = [{from: 'fato:vp-1:F1', to: 'rn-a', segment: 'C'}, {from: 'rn-a', to: 'rn-b', segment: 'E'}];
  assert.equal(suggestSegment('fato:vp-1:F1', 'rn-a', []), 'C', 'a route leaves a FATO climbing');
  assert.equal(suggestSegment('rn-b', 'fato:vp-1:F2', links), 'G', 'and meets one descending');
  assert.equal(suggestSegment('rn-a', 'rn-c', links), 'F', 'the climb is over: cruise follows it');
  assert.equal(suggestSegment('rn-b', 'rn-c', links), 'F');
  assert.equal(suggestSegment('rn-z', 'rn-c', []), 'F');
});

test('the profile picker draws one continuous flight: deck, hover, and the three runs joined end to end', () => {
  const {C, F, G} = PROFILE_SHAPE;
  assert.deepEqual(C.line[1], F.line[0], 'the climb ends where the cruise begins');
  assert.deepEqual(F.line[1], G.line[0], 'and the cruise where the descent begins');
  assert.ok(C.line[0][1] > C.line[1][1] && G.line[1][1] > G.line[0][1], 'the diagonals rise and fall');
  assert.equal(F.line[0][1], F.line[1][1], 'the cruise is level');
  assert.deepEqual([C.letters, F.letters, G.letters], ['C·D·E', 'F', 'G·H·I'], 'each run names the letters it flies');
});

test('a pair of waypoints is joined once, whichever way it was drawn; a FATO keeps its two uses', () => {
  const links = [{id: 'rl-1', from: 'rn-a', to: 'rn-b', segment: 'F'},
    {id: 'rl-2', from: 'fato:vp-2:F1', to: 'rn-a', segment: 'C'}];
  assert.equal(pairKey('rn-a', 'rn-b'), pairKey('rn-b', 'rn-a'), 'between waypoints the direction is not a second pair');
  assert.notEqual(pairKey('fato:vp-2:F1', 'rn-a'), pairKey('rn-a', 'fato:vp-2:F1'), 'a FATO departs one way and arrives the other');
  assert.deepEqual(openDirections('rn-a', 'rn-b', fatos, links), [], 'already joined, either way round');
  assert.deepEqual(openDirections('rn-b', 'rn-a', fatos, links), []);
  assert.deepEqual(openDirections('rn-a', 'rn-c', fatos, links).map(d => [d.from, d.to]), [['rn-a', 'rn-c']]);
  // The both-role FATO has taken off towards 진입 already; landing is still open.
  assert.deepEqual(openDirections('fato:vp-2:F1', 'rn-a', fatos, links).map(d => d.use), ['landing']);
  assert.deepEqual(openDirections('fato:vp-1:F1', 'fato:vp-1:F2', fatos, []), [], 'two FATOs never join directly');
});

test('a FATO can only start a link when it takes off and only end one when it lands', () => {
  assert.deepEqual(fatoDirections('rn-a', 'rn-b', fatos), [{from: 'rn-a', to: 'rn-b', use: null}]);
  assert.deepEqual(fatoDirections('fato:vp-1:F1', 'rn-a', fatos), [{from: 'fato:vp-1:F1', to: 'rn-a', use: 'takeoff'}]);
  assert.deepEqual(fatoDirections('rn-a', 'fato:vp-1:F1', fatos), [{from: 'fato:vp-1:F1', to: 'rn-a', use: 'takeoff'}], 'the click order does not matter');
  assert.deepEqual(fatoDirections('rn-a', 'fato:vp-1:F2', fatos), [{from: 'rn-a', to: 'fato:vp-1:F2', use: 'landing'}]);
  assert.deepEqual(fatoDirections('fato:vp-2:F1', 'rn-a', fatos).map(d => d.use), ['takeoff', 'landing'], 'both: the operator chooses');
  assert.deepEqual(fatoDirections('fato:vp-1:F1', 'fato:vp-1:F2', fatos), []);
});

test('a link is described by its endpoints and segment, with the width only for a corridor', () => {
  assert.equal(describeLink({from: 'a', to: 'b', segment: 'F', width_m: 300}, {a: '여의도', b: '강남'}), '여의도 → 강남 · F Cruise · 폭 300 m');
  assert.equal(describeLink({from: 'a', to: 'b', segment: 'C', width_m: null}, {a: '여의도', b: '강남'}), '여의도 → 강남 · C Climb-out');
  assert.equal(describeLink({from: 'a', to: 'b', segment: 'I', width_m: null}, {a: '여의도', b: '강남'}), '여의도 → 강남 · G Descent',
    'an older link reads as the run it is part of');
});

function harness({nodes = [], links = [], withFatos = true, place = '여의도동', ground = 12.5} = {}) {
  const state = {nodes: [...nodes], links: [...links], fatos: withFatos ? fatos : []};
  const calls = {created: [], updated: [], removedNodes: [], createdLinks: [], updatedLinks: [], removedLinks: [], places: []};
  let sequence = 0;
  const api = {
    network: async () => ({schema_version: 1, ...state}),
    options: async () => ({segments: undefined}),
    place: async (latitude, longitude) => {calls.places.push([latitude, longitude]); return {name: place};},
    createNode: async definition => {calls.created.push(definition); const node = {...definition, id: `rn-${++sequence}`, name: definition.name || `${definition.place_name ?? '지점'}`}; state.nodes.push(node); return {node};},
    updateNode: async (id, definition) => {calls.updated.push([id, definition]); const index = state.nodes.findIndex(n => n.id === id); state.nodes[index] = {...definition, id}; return {node: state.nodes[index]};},
    removeNode: async id => {calls.removedNodes.push(id); state.nodes = state.nodes.filter(n => n.id !== id); state.links = state.links.filter(l => l.from !== id && l.to !== id);},
    createLink: async definition => {calls.createdLinks.push(definition); const link = {...definition, id: `rl-${++sequence}`, name: definition.name ?? `${definition.from} → ${definition.to}`}; state.links.push(link); return {link};},
    updateLink: async (id, definition) => {calls.updatedLinks.push([id, definition]); return {link: {...definition, id}};},
    removeLink: async id => {calls.removedLinks.push(id); state.links = state.links.filter(l => l.id !== id);},
  };
  const events = {networks: [], selected: [], blocked: [], previews: [], editing: [], focused: [], notices: []};
  const mount = new FakeElement('body');
  const card = new RouteCard({document: fakeDocument, mount, viewport: () => ({width: 1200, height: 800})});
  const panel = new RoutePanel({api, document: fakeDocument, card, notify: (s, m) => events.notices.push([s, m]),
    onNetwork: network => events.networks.push(network),
    onSelect: (id, blocked) => {events.selected.push(id); events.blocked.push(blocked ?? []);},
    onPreviewLink: (from, to) => events.previews.push([from, to]),
    onEditing: editor => events.editing.push(editor), onFocus: id => events.focused.push(id),
    groundAt: async () => ground, positionOf: id => ({longitude: 127, latitude: 37.5, height: 330, ground: 25, node: {id}}), screenOf: () => ({x: 300, y: 200}),
    setTimer: () => 1, clearTimer: () => {}});
  const body = new FakeElement('div');
  const settle = async () => {for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));};
  const mode = () => body.querySelector('#route-status').dataset.mode;
  return {panel, body, card, mount, state, calls, events, settle, mode};
}

test('the tab shows the mode and a count instead of lists, and arms the map when activated', async () => {
  const {panel, body, events, settle, mode} = harness({nodes: [{id: 'rn-a', name: '진입', ...seoul, altitude_m: 304.8, altitude_reference: 'agl'}],
    links: [{id: 'rl-1', name: '여의도 F1 → 진입', from: 'fato:vp-1:F1', to: 'rn-a', segment: 'C', width_m: null}]});
  panel.render(body); panel.activate();
  await panel.ready; await settle();
  assert.equal(body.querySelector('#route-summary').textContent, '지점 1 · FATO 3 · 구간 1 (순항 회랑 0)');
  assert.equal(body.querySelectorAll('.sim-item').length, 0, 'nothing is listed: the network is managed on the map');
  assert.equal(mode(), 'idle');
  assert.equal(body.querySelector('#route-mode').textContent, MODES.idle.label);
  assert.equal(events.networks.length, 1);
  assert.equal(events.editing[0].crosshair, false, 'clicks are ours but nothing is being added yet');
  assert.equal(typeof events.editing[0].onClick, 'function');
  panel.deactivate();
  assert.equal(events.editing[events.editing.length - 1], null, 'leaving the tab hands the clicks back');
});

test('adding: the mode strip says so, a ground click opens a tagged form, the place name and ground arrive, saving creates the waypoint', async () => {
  const {panel, body, card, calls, events, settle, mode} = harness();
  panel.render(body); panel.activate(); await panel.ready;
  body.querySelector('#route-add').click();
  assert.equal(panel.adding, true);
  assert.equal(mode(), 'adding');
  assert.equal(body.querySelector('#route-add').textContent, '지점 추가 끝내기');
  assert.equal(events.editing[events.editing.length - 1].crosshair, true, 'the cursor says the next click places a waypoint');
  panel.mapClick({ground: {latitude: 37.531, longitude: 126.931, height: 20}, screen: {x: 400, y: 300}});
  assert.equal(card.isOpen, true);
  assert.equal(card.root.getAttribute('data-mode'), 'node-new');
  assert.equal(card.root.querySelector('.route-tag').textContent, TAGS['node-new']);
  const form = card.root.querySelector('form');
  assert.equal(form.querySelector('[name=altitude]').value, '1000', 'a thousand feet by default');
  assert.equal(form.querySelector('[name=unit]').value, 'ft');
  assert.equal(form.querySelector('[name=altitude_reference]').value, 'agl');
  assert.match(card.root.querySelector('#route-altitude-note').textContent, /= 305 m · 지면 기준 \(AGL\) · 지면 20 m → 절대 325 m/);
  await settle();
  assert.deepEqual(calls.places, [[37.531, 126.931]]);
  assert.match(form.querySelector('[name=name]').placeholder, /여의도동 \(자동\)/, 'the nearby place is offered as the name');
  assert.match(card.root.querySelector('#route-altitude-note').textContent, /지면 13 m → 절대 317 m/, 'the measured ground replaces the click height');
  form.querySelector('[name=unit]').value = 'm'; form.querySelector('[name=unit]').onchange();
  assert.equal(form.querySelector('[name=altitude]').value, '305');
  form.querySelector('[name=altitude]').value = '500'; form.querySelector('[name=altitude]').oninput();
  assert.match(card.root.querySelector('#route-altitude-note').textContent, /= 1,640 ft/);
  form.submit(); await settle();
  assert.deepEqual(calls.created[0], {name: '', latitude: 37.531, longitude: 126.931, altitude_m: 500, altitude_reference: 'agl', place_name: '여의도동'});
  assert.equal(card.isOpen, false);
  assert.equal(panel.selected, 'rn-1', 'the new waypoint is selected so the next click links from it');
  assert.equal(panel.adding, true, 'adding continues until it is switched off');
  assert.equal(body.querySelector('#route-summary').textContent, '지점 1 · FATO 3 · 구간 0 (순항 회랑 0)');
});

test('clicking a waypoint selects it and shows its card; the same waypoint again lets go; another makes a link: segment first, then the width for cruise only', async () => {
  const {panel, body, card, calls, events, settle, mode} = harness({nodes: [
    {id: 'rn-a', name: '진입', ...seoul, altitude_m: 304.8, altitude_reference: 'agl'},
    {id: 'rn-b', name: '순항점', latitude: 37.55, longitude: 126.99, altitude_m: 457.2, altitude_reference: 'agl'},
    {id: 'rn-c', name: '강하점', latitude: 37.56, longitude: 127.02, altitude_m: 457.2, altitude_reference: 'agl'}]});
  panel.render(body); panel.activate(); await panel.ready; await settle();
  panel.mapClick({hit: {kind: 'node', id: 'rn-a'}, screen: {x: 100, y: 100}});
  assert.equal(panel.selected, 'rn-a');
  assert.equal(mode(), 'selected');
  assert.equal(body.querySelector('#route-clear').hidden, false);
  assert.match(body.querySelector('#route-mode-text').textContent, /진입 선택됨/);
  assert.equal(events.selected[events.selected.length - 1], 'rn-a', 'the map draws it selected');
  assert.equal(card.root.getAttribute('data-mode'), 'node-info');
  assert.match(card.root.textContent, /1,000 ft \(305 m\) · 지면 기준 · 절대 330 m/);
  panel.mapClick({hit: {kind: 'node', id: 'rn-a'}, screen: {x: 100, y: 100}});
  assert.equal(panel.selected, null, 'the same waypoint again cancels');
  assert.equal(card.isOpen, false);
  assert.equal(mode(), 'idle');
  panel.mapClick({hit: {kind: 'node', id: 'rn-a'}, screen: {x: 100, y: 100}});
  panel.mapClick({hit: {kind: 'node', id: 'rn-b'}, screen: {x: 200, y: 100}});
  assert.equal(card.root.getAttribute('data-mode'), 'link-new');
  assert.equal(card.root.querySelector('.route-tag').textContent, TAGS['link-new']);
  assert.equal(mode(), 'linking');
  assert.match(body.querySelector('#route-mode-text').textContent, /진입 → 순항점/);
  // The picker is the mission profile: three runs on one drawing, the suggested
  // one already marked, and the vertiport's own phases drawn but not offered.
  const segments = card.root.querySelectorAll('.route-part');
  assert.deepEqual(segments.map(b => b.getAttribute('data-segment')), ['C', 'F', 'G']);
  assert.equal(card.root.querySelector('.route-profile').getAttribute('role'), 'radiogroup');
  assert.equal(card.root.querySelectorAll('.route-profile-fixed').length, 1, 'the deck and the hover are drawn once');
  assert.equal(card.root.querySelector('.route-picked').getAttribute('data-segment'), 'F', 'nothing arrives at 진입: cruise is suggested');
  assert.deepEqual(segments.map(b => b.getAttribute('aria-checked')), ['false', 'true', 'false']);
  assert.match(card.root.textContent, /상승은 C·D·E, 강하는 G·H·I/);
  segments.find(b => b.getAttribute('data-segment') === 'F').click();
  const form = card.root.querySelector('form');
  assert.ok(form, 'cruise asks its width');
  assert.equal(form.querySelector('[name=width_m]').value, '300', 'the default corridor width');
  form.querySelector('[name=width_m]').value = '250';
  form.submit(); await settle();
  assert.deepEqual(calls.createdLinks, [{from: 'rn-a', to: 'rn-b', segment: 'F', width_m: 250}]);
  assert.equal(card.isOpen, false);
  assert.equal(panel.selected, 'rn-b', 'the route continues from where it arrived');
  assert.equal(mode(), 'selected');
  // A non-cruise segment is saved the moment it is chosen, without a width.
  panel.mapClick({hit: {kind: 'node', id: 'rn-c'}, screen: {x: 300, y: 100}});
  assert.equal(card.root.querySelector('.route-picked').getAttribute('data-segment'), 'F', 'cruise follows cruise');
  // The keyboard reaches the drawing too, since it is a radio group.
  card.root.querySelectorAll('.route-part').find(b => b.getAttribute('data-segment') === 'G').onkeydown({key: 'Enter'}); await settle();
  assert.deepEqual(calls.createdLinks[1], {from: 'rn-b', to: 'rn-c', segment: 'G'});
  assert.equal(body.querySelector('#route-summary').textContent, '지점 3 · FATO 3 · 구간 2 (순항 회랑 1)');
  // Clicking empty ground while not adding clears the selection.
  panel.mapClick({ground: {latitude: 37, longitude: 127}, screen: {x: 0, y: 0}});
  assert.equal(panel.selected, null);
  assert.equal(mode(), 'idle');
});

test('a link from a take-off FATO suggests the climb; a both-role FATO asks how it is used', async () => {
  const {panel, body, card, calls, events, settle} = harness({nodes: [{id: 'rn-a', name: '진입', ...seoul, altitude_m: 304.8, altitude_reference: 'agl'}]});
  panel.render(body); panel.activate(); await panel.ready; await settle();
  panel.mapClick({hit: {kind: 'node', id: 'fato:vp-1:F1'}, screen: {x: 0, y: 0}});
  assert.match(card.root.textContent, /이륙 B 구간의 끝/);
  panel.mapClick({hit: {kind: 'node', id: 'rn-a'}, screen: {x: 0, y: 0}});
  assert.equal(card.root.querySelectorAll('[name=use]').length, 0, 'a take-off FATO has one way to be used');
  assert.equal(card.root.querySelector('.route-picked').getAttribute('data-segment'), 'C');
  card.root.querySelector('.route-picked').click(); await settle();
  assert.deepEqual(calls.createdLinks[0], {from: 'fato:vp-1:F1', to: 'rn-a', segment: 'C'});
  // Now towards the both-role FATO: 진입 is already selected as the route's end, so one click asks how the FATO is used.
  assert.equal(panel.selected, 'rn-a');
  panel.mapClick({hit: {kind: 'node', id: 'fato:vp-2:F1'}, screen: {x: 0, y: 0}});
  const uses = card.root.querySelectorAll('[name=use]');
  assert.deepEqual(uses.map(u => u.value), ['takeoff', 'landing']);
  assert.deepEqual(events.previews.at(-1), ['fato:vp-2:F1', 'rn-a'], 'the take-off direction is drawn first');
  uses[1].checked = true; uses[1].onchange();
  assert.deepEqual(events.previews.at(-1), ['rn-a', 'fato:vp-2:F1'], 'choosing the landing turns the line round');
  assert.match(body.querySelector('#route-mode-text').textContent, /진입 → 강남 F1/);
  card.root.querySelectorAll('.route-part').find(b => b.getAttribute('data-segment') === 'G').click(); await settle();
  assert.deepEqual(calls.createdLinks[1], {from: 'rn-a', to: 'fato:vp-2:F1', segment: 'G'});
  // Two FATOs cannot be joined directly.
  panel.mapClick({hit: {kind: 'node', id: 'fato:vp-1:F1'}, screen: {x: 0, y: 0}});
  panel.mapClick({hit: {kind: 'node', id: 'fato:vp-1:F2'}, screen: {x: 0, y: 0}});
  assert.match(body.querySelector('#route-error').textContent, /FATO끼리/);
  assert.equal(calls.createdLinks.length, 2);
});

test('the pair being joined is drawn on the map until the card is answered, and a pair already joined is refused either way round', async () => {
  const {panel, body, card, calls, events, settle} = harness({nodes: [
    {id: 'rn-a', name: '진입', ...seoul, altitude_m: 304.8, altitude_reference: 'agl'},
    {id: 'rn-b', name: '순항점', latitude: 37.55, longitude: 126.99, altitude_m: 457.2, altitude_reference: 'agl'},
    {id: 'rn-c', name: '강하점', latitude: 37.56, longitude: 127.02, altitude_m: 457.2, altitude_reference: 'agl'}]});
  panel.render(body); panel.activate(); await panel.ready; await settle();
  panel.mapClick({hit: {kind: 'node', id: 'rn-a'}, screen: {x: 100, y: 100}});
  assert.deepEqual(events.blocked.at(-1), [], 'nothing is joined yet');
  panel.mapClick({hit: {kind: 'node', id: 'rn-b'}, screen: {x: 200, y: 100}});
  assert.deepEqual(events.previews.at(-1), ['rn-a', 'rn-b'], 'the map draws the pair the card is asking about');
  card.root.querySelectorAll('.route-part').find(b => b.getAttribute('data-segment') === 'C').click(); await settle();
  assert.deepEqual(events.previews.at(-1), [null, null], 'answered: the line goes');
  assert.equal(calls.createdLinks.length, 1);
  // 진입 and 순항점 are joined now, so neither order opens a card again.
  assert.deepEqual(events.blocked.at(-1), ['rn-a'], 'from 순항점, 진입 is no longer available');
  panel.mapClick({hit: {kind: 'node', id: 'rn-a'}, screen: {x: 100, y: 100}});
  assert.match(body.querySelector('#route-error').textContent, /이미 이어져 있습니다/);
  assert.equal(card.isOpen, false, 'no link card opened');
  assert.equal(panel.selected, 'rn-b', 'and the selection is kept, so another point can be tried');
  assert.deepEqual(events.previews.at(-1), [null, null], 'nothing was drawn for a refused pair');
  assert.equal(calls.createdLinks.length, 1);
  // The other way round is the same pair.
  panel.select(null);
  panel.mapClick({hit: {kind: 'node', id: 'rn-a'}, screen: {x: 100, y: 100}});
  assert.deepEqual(events.blocked.at(-1), ['rn-b']);
  panel.mapClick({hit: {kind: 'node', id: 'rn-b'}, screen: {x: 200, y: 100}});
  assert.match(body.querySelector('#route-error').textContent, /이미 이어져 있습니다/);
  assert.equal(calls.createdLinks.length, 1);
  // A pair that is still open draws its line, and closing the card takes it away.
  panel.mapClick({hit: {kind: 'node', id: 'rn-c'}, screen: {x: 300, y: 100}});
  assert.deepEqual(events.previews.at(-1), ['rn-a', 'rn-c']);
  card.close();
  assert.deepEqual(events.previews.at(-1), [null, null], 'given up: the line goes too');
});

test('a waypoint is edited from its card and deleted with two presses; a link is edited from the map and only cruise shows a width', async () => {
  const {panel, body, card, calls, settle} = harness({nodes: [{id: 'rn-a', name: '진입', ...seoul, altitude_m: 304.8, altitude_reference: 'agl'},
      {id: 'rn-b', name: '순항점', latitude: 37.55, longitude: 126.99, altitude_m: 457.2, altitude_reference: 'agl'}],
    links: [{id: 'rl-1', name: '여의도 F1 → 진입', from: 'fato:vp-1:F1', to: 'rn-a', segment: 'C', width_m: null},
      {id: 'rl-2', name: '진입 → 순항점', from: 'rn-a', to: 'rn-b', segment: 'C', width_m: null}]});
  panel.render(body); panel.activate(); await panel.ready; await settle();
  panel.mapClick({hit: {kind: 'node', id: 'rn-a'}, screen: {x: 0, y: 0}});
  card.root.querySelector('.place-confirm').click();
  assert.equal(card.root.getAttribute('data-mode'), 'node-edit');
  const form = card.root.querySelector('form');
  assert.equal(form.querySelector('[name=name]').value, '진입');
  form.querySelector('[name=name]').value = '여의도 진입';
  form.querySelector('[name=altitude]').value = '1500';
  form.submit(); await settle();
  assert.deepEqual(calls.updated, [['rn-a', {name: '여의도 진입', ...seoul, altitude_m: 457.2, altitude_reference: 'agl'}]]);
  panel.mapClick({hit: {kind: 'link', id: 'rl-1'}, screen: {x: 0, y: 0}});
  assert.equal(card.root.getAttribute('data-mode'), 'link-edit');
  assert.equal(card.root.querySelector('#route-width-field').hidden, true, 'a climb has no width');
  assert.equal(card.root.querySelector('.route-picked').getAttribute('data-segment'), 'C', 'the drawing shows what it is now');
  // A link leaving a FATO is the climb and nothing else: the other runs are locked.
  card.root.querySelectorAll('.route-part').find(b => b.getAttribute('data-segment') === 'F').click();
  assert.equal(card.root.querySelector('.route-picked').getAttribute('data-segment'), 'C', 'a FATO link keeps its run');
  // Between two waypoints the drawing follows the choice, and cruise asks its width.
  panel.mapClick({hit: {kind: 'link', id: 'rl-2'}, screen: {x: 0, y: 0}});
  assert.equal(card.root.querySelector('.route-picked').getAttribute('data-segment'), 'C');
  card.root.querySelectorAll('.route-part').find(b => b.getAttribute('data-segment') === 'F').click();
  assert.equal(card.root.querySelector('.route-picked').getAttribute('data-segment'), 'F', 'the drawing follows the choice');
  assert.equal(card.root.querySelector('#route-width-field').hidden, false, 'cruise does');
  card.root.querySelector('[name=width_m]').value = '400';
  card.root.querySelector('form').submit(); await settle();
  assert.deepEqual(calls.updatedLinks, [['rl-2', {from: 'rn-a', to: 'rn-b', segment: 'F', width_m: 400, name: '진입 → 순항점'}]]);
  panel.select(null);
  panel.mapClick({hit: {kind: 'node', id: 'rn-a'}, screen: {x: 0, y: 0}});
  const remove = card.root.querySelector('.sim-danger');
  remove.click();
  assert.equal(remove.textContent, '삭제 확인');
  assert.equal(calls.removedNodes.length, 0);
  remove.click(); await settle();
  assert.deepEqual(calls.removedNodes, ['rn-a']);
  assert.equal(panel.selected, null);
  assert.equal(card.isOpen, false);
});

test('escape closes the card, then the adding mode, then the selection; the clear button lets go too', async () => {
  const {panel, body, card, settle, mode} = harness({nodes: [{id: 'rn-a', name: '진입', ...seoul, altitude_m: 304.8, altitude_reference: 'agl'}]});
  panel.render(body); panel.activate(); await panel.ready; await settle();
  panel.setAdding(true);
  panel.mapClick({ground: {latitude: 37.531, longitude: 126.931, height: 20}, screen: {x: 400, y: 300}});
  assert.equal(panel.escape(), true); assert.equal(card.isOpen, false); assert.equal(panel.adding, true);
  assert.equal(panel.escape(), true); assert.equal(panel.adding, false);
  panel.mapClick({hit: {kind: 'node', id: 'rn-a'}, screen: {x: 0, y: 0}});
  card.close();
  assert.equal(panel.escape(), true); assert.equal(panel.selected, null);
  assert.equal(panel.escape(), false, 'nothing left to close');
  panel.mapClick({hit: {kind: 'node', id: 'rn-a'}, screen: {x: 0, y: 0}});
  body.querySelector('#route-clear').click();
  assert.equal(panel.selected, null); assert.equal(mode(), 'idle'); assert.equal(card.isOpen, false);
});

test('the card opens beside the click, inside the viewport, one at a time, tagged with its mode', () => {
  const mount = new FakeElement('body');
  const card = new RouteCard({document: fakeDocument, mount, viewport: () => ({width: 600, height: 400})});
  card.open({screen: {x: 590, y: 390}, title: '새 지점', mode: 'node-new'}, new FakeElement('p'));
  assert.equal(card.isOpen, true);
  assert.equal(card.root.style.left, '342px'); assert.equal(card.root.style.top, '70px');
  assert.equal(card.root.getAttribute('data-mode'), 'node-new');
  assert.equal(mount.children.length, 1);
  card.open({screen: {x: 10, y: 10}, title: '다른 카드', mode: 'link-new'});
  assert.equal(mount.children.length, 1, 'the previous card is gone');
  assert.equal(card.root.querySelector('.route-tag').textContent, '구간 연결');
  card.replace(new FakeElement('form'));
  assert.equal(card.root.querySelector('form') !== null, true);
  card.close();
  assert.equal(mount.children.length, 0);
});

test('the Simulation section offers vertiports, routes and flight plans, and delegates the route tab', async () => {
  assert.deepEqual(UAM_TABS.map(([id]) => id), ['vertiports', 'routes', 'plans']);
  assert.deepEqual(UAM_TABS.map(([, label]) => label), ['버티포트', '항로', '비행 계획']);
  const {panel: routePanel, events} = harness();
  const simulation = new SimulationPanel({api: {list: async () => ({vertiports: []})}, document: fakeDocument, routePanel});
  const body = new FakeElement('div');
  simulation.render(body);
  assert.equal(body.querySelectorAll('.sim-tab').length, 3);
  body.querySelector('#sim-tab-plans').click();
  assert.match(body.textContent, /비행 계획은 항로 위에/);
  body.querySelector('#sim-tab-routes').click();
  await simulation.ready;
  assert.ok(body.querySelector('#route-add'), 'the route editor is rendered into the tab');
  assert.equal(routePanel.active, true);
  assert.equal(simulation.routeEscape(), false, 'nothing open to escape yet');
  routePanel.setAdding(true);
  assert.equal(simulation.routeEscape(), true, 'Escape reaches the route editor while its tab is open');
  body.querySelector('#sim-tab-vertiports').click();
  assert.equal(routePanel.active, false, 'leaving the tab hands the map back');
  assert.equal(events.editing[events.editing.length - 1], null);
  simulation.leave();
});

test('the page wires the route editor, its card, the API and hover, and styles the modes', () => {
  assert.match(app, /createPanel\(RoutePanel,/);
  assert.match(app, /new RouteCard\(/);
  assert.match(app, /\/api\/simulation\/routes\/nodes/);
  assert.match(app, /\/api\/simulation\/routes\/links/);
  assert.match(app, /\/api\/simulation\/routes\/place/);
  assert.match(app, /showRoutes\(/);
  assert.match(app, /setRouteEditor\(/);
  assert.match(app, /simulationPanel\.escape\(\)/, 'the section decides what Escape closes');
  assert.match(readFileSync('user_application/web/window_launchers.js','utf-8'), /close:\(\)=>\{c\.leave\(\)/, 'closing the owning form lets go of its map editor');
  assert.match(css, /\.route-card\{position:fixed/);
  assert.match(css, /\.route-part-line\{[^}]*stroke:var\(--segment\)/);
  assert.match(css, /\.route-part\.route-picked \.route-part-line\{[^}]*opacity:1/);
  assert.match(css, /\.route-status\[data-mode=adding\]/);
  assert.match(css, /\.route-card\[data-mode=link-new\]/);
  // The delete button says more when it is armed; it must stay on one line.
  assert.match(css, /\.route-card \.sim-actions button\{[^}]*white-space:nowrap/);
  assert.match(css, /\.route-card \.sim-actions \.sim-danger\{flex:0 0 auto\}/);
});

test('while adding, the cursor asks for the locality ahead of the click, at most once a second per cell, and the click is answered from memory', async () => {
  const {panel, body, card, calls, events, settle} = harness();
  panel.render(body); panel.activate(); await panel.ready;
  assert.equal(events.editing[events.editing.length - 1].onMove, null, 'nothing to prefetch while not adding');
  panel.setAdding(true);
  const editor = events.editing[events.editing.length - 1];
  assert.equal(typeof editor.onMove, 'function');
  assert.equal(editor.onMove({latitude: 37.5311, longitude: 126.9312}), true);
  assert.equal(editor.onMove({latitude: 37.5312, longitude: 126.9313}), false, 'the same cell is not asked twice');
  assert.equal(editor.onMove({latitude: 37.60, longitude: 127.10}), false, 'too soon for another cell');
  panel.lastPlaceAsk = -Infinity;
  assert.equal(editor.onMove({latitude: 37.60, longitude: 127.10}), true);
  await settle();
  assert.equal(calls.places.length, 2);
  panel.mapClick({ground: {latitude: 37.5313, longitude: 126.9311, height: 20}, screen: {x: 400, y: 300}});
  await settle();
  assert.equal(calls.places.length, 2, 'the click found its name in memory');
  assert.match(card.root.querySelector('[name=name]').placeholder, /여의도동 \(자동\)/);
  panel.setAdding(false);
  assert.equal(events.editing[events.editing.length - 1].onMove, null);
});
