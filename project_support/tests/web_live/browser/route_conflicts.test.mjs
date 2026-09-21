import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement, fakeDocument} from './fake_dom.mjs';
import {RouteCard} from '../../../../user_application/web/domains/uam/planning/route_card.js';
import {RoutePanel, fixedSegment, problemText, conflictText, drawnColourNote, linkFromForm, CONFLICT_BATCH} from '../../../../user_application/web/domains/uam/planning/route_panel.js';
import {RouteLayer, CONFLICT_COLOR, TIGHT_COLOR, PROBLEM_COLOR, LINE_WIDTH} from '../../../../digital_twin/visualization/web/route_layer.js';
import {FALLBACK_OPTIONS} from '../../../../user_application/web/domains/uam/planning/route_panel.js';

const web = new URL('../../../../user_application/web/', import.meta.url);
const app = readFileSync(new URL('app.js', web), 'utf8');
const css = readFileSync(new URL('styles.css', web), 'utf8');

const seoul = {latitude: 37.53, longitude: 126.93};
const fatos = [
  {id: 'fato:vp-1:F1', kind: 'fato', name: '여의도 F1', vertiport: 'vp-1', vertiport_name: '여의도', fato: 'F1', role: 'takeoff', latitude: 37.5, longitude: 127, hover_m: 30},
  {id: 'fato:vp-1:F2', kind: 'fato', name: '여의도 F2', vertiport: 'vp-1', vertiport_name: '여의도', fato: 'F2', role: 'landing', latitude: 37.5, longitude: 127.001, hover_m: 30},
  {id: 'fato:vp-2:F1', kind: 'fato', name: '잠실 F1', vertiport: 'vp-2', vertiport_name: '잠실', fato: 'F1', role: 'both', latitude: 37.49, longitude: 127.03, hover_m: 30},
];
const nodes = [
  {id: 'rn-a', name: '진입', ...seoul, altitude_m: 304.8, altitude_reference: 'agl'},
  {id: 'rn-b', name: '순항점', latitude: 37.55, longitude: 126.99, altitude_m: 457.2, altitude_reference: 'agl'},
];
const report = (collisions, tight = 0) => ({collisions, tight, checked: 40, min_clearance_m: collisions ? -27 : tight ? 12 : null,
  buildings: collisions || tight ? [{id: 'b1', name: '타워', height_m: 87.2, top_m: 112, path_m: collisions ? 85 : 124, clearance_m: collisions ? -27 : 12,
    collision: collisions > 0, position: {longitude: 126.95, latitude: 37.54}}] : []});

function harness({links = [], conflicts = null, request = null} = {}) {
  const state = {nodes: [...nodes], links: [...links], fatos};
  const calls = {createdLinks: [], updatedLinks: [], conflicts: [], requests: []};
  let sequence = 100;
  const api = {
    network: async () => ({schema_version: 1, ...state}),
    options: async () => ({segments: undefined}),
    createLink: async definition => {calls.createdLinks.push(definition); const link = {...definition, id: `rl-${++sequence}`, name: `${definition.from} → ${definition.to}`}; state.links.push(link); return {link};},
    updateLink: async (id, definition) => {calls.updatedLinks.push([id, definition]); return {link: {...definition, id}};},
    updateNode: async (id, definition) => ({node: {...definition, id}}),
    removeLink: async id => {state.links = state.links.filter(l => l.id !== id);},
    ...(conflicts ? {conflicts: async body => {calls.conflicts.push(body); return conflicts(body);}} : {}),
  };
  const events = {networks: [], conflicts: [], notices: []};
  const mount = new FakeElement('body');
  const card = new RouteCard({document: fakeDocument, mount, viewport: () => ({width: 1200, height: 800})});
  const panel = new RoutePanel({api, document: fakeDocument, card, notify: (s, m) => events.notices.push([s, m]),
    onNetwork: network => events.networks.push(network), onConflicts: reports => events.conflicts.push(reports),
    conflictRequest: async ids => {calls.requests.push(ids); return request ? request(ids, state) : null;},
    positionOf: () => ({longitude: 127, latitude: 37.5, height: 330, ground: 25}), screenOf: () => ({x: 300, y: 200}),
    setTimer: () => 1, clearTimer: () => {}});
  const body = new FakeElement('div');
  const settle = async () => {for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));};
  return {panel, body, card, state, calls, events, settle};
}

test('a FATO fixes the run: climbing away from one, descending into one; the form refuses anything else', () => {
  assert.equal(fixedSegment('fato:vp-1:F1', 'rn-a'), 'C');
  assert.equal(fixedSegment('rn-a', 'fato:vp-1:F2'), 'G');
  assert.equal(fixedSegment('rn-a', 'rn-b'), null);
  assert.match(linkFromForm({from: 'fato:vp-1:F1', to: 'rn-a', segment: 'F', width_m: 300}).errors[0], /상승\(C\)만/);
  assert.match(linkFromForm({from: 'rn-a', to: 'fato:vp-1:F2', segment: 'C'}).errors[0], /강하\(G\)만/);
  assert.deepEqual(linkFromForm({from: 'fato:vp-1:F1', to: 'rn-a', segment: 'C'}).definition, {from: 'fato:vp-1:F1', to: 'rn-a', segment: 'C'});
  assert.match(problemText('from: this FATO does not take off'), /이륙용이 아닌 FATO/);
  assert.match(problemText('segment: a route leaves a FATO climbing (C)'), /상승/);
  assert.match(conflictText(report(1)), /⚠ 건물 충돌 1동 · 가장 가까운 타워 87 m \(지붕 112 m\) · 경로 85 m · 여유 -27 m/);
  assert.match(conflictText(report(0, 2)), /△ 건물 근접 2동/);
  assert.match(conflictText(report(0)), /여유 충분/);
});

test('linking from a take-off FATO offers only the climb; a both-role FATO switches the run with its use', async () => {
  const {panel, body, card, calls, settle} = harness();
  panel.render(body); panel.activate(); await panel.ready; await settle();
  panel.mapClick({hit: {kind: 'node', id: 'fato:vp-1:F1'}, screen: {x: 0, y: 0}});
  panel.mapClick({hit: {kind: 'node', id: 'rn-a'}, screen: {x: 0, y: 0}});
  const parts = () => card.root.querySelectorAll('.route-part');
  assert.deepEqual(parts().map(p => p.getAttribute('aria-disabled')), [null, 'true', 'true'], 'cruise and descent are locked');
  assert.deepEqual(parts().map(p => (p.attributes.class ?? '').includes('route-locked')), [false, true, true]);
  assert.match(card.root.textContent, /FATO에서 출발하는 구간은 상승\(C·D·E\)만/);
  parts().find(p => p.getAttribute('data-segment') === 'F').click(); await settle();
  assert.equal(calls.createdLinks.length, 0, 'a locked run does nothing when clicked');
  parts().find(p => p.getAttribute('data-segment') === 'C').click(); await settle();
  assert.deepEqual(calls.createdLinks[0], {from: 'fato:vp-1:F1', to: 'rn-a', segment: 'C'});
  // The both-role FATO: take-off first, so the climb is the only run; choosing the landing turns it into the descent.
  panel.select('rn-b');
  panel.mapClick({hit: {kind: 'node', id: 'fato:vp-2:F1'}, screen: {x: 0, y: 0}});
  assert.equal(card.root.querySelector('.route-picked').getAttribute('data-segment'), 'C');
  assert.deepEqual(parts().map(p => p.getAttribute('aria-disabled')), [null, 'true', 'true']);
  const uses = card.root.querySelectorAll('[name=use]');
  uses[1].checked = true; uses[1].onchange();
  assert.equal(card.root.querySelector('.route-picked').getAttribute('data-segment'), 'G', 'landing: the descent is the run');
  assert.deepEqual(parts().map(p => p.getAttribute('aria-disabled')), ['true', 'true', null]);
  assert.match(card.root.textContent, /FATO로 들어오는 구간은 강하\(G·H·I\)만/);
  parts().find(p => p.getAttribute('data-segment') === 'G').click(); await settle();
  assert.deepEqual(calls.createdLinks[1], {from: 'rn-b', to: 'fato:vp-2:F1', segment: 'G'});
});

test('editing a FATO link keeps its run locked and shows why a stored one no longer fits', async () => {
  const wrong = {id: 'rl-9', name: '잠실 F1 → 진입', from: 'fato:vp-2:F1', to: 'rn-a', segment: 'G', width_m: null, problem: 'segment: a route leaves a FATO climbing (C)'};
  const {panel, body, card, calls, settle} = harness({links: [wrong]});
  panel.render(body); panel.activate(); await panel.ready; await settle();
  assert.match(body.querySelector('#route-summary').textContent, /FATO 불일치 1/);
  panel.mapClick({hit: {kind: 'link', id: 'rl-9'}, screen: {x: 0, y: 0}});
  assert.match(card.root.querySelector('.route-problem').textContent, /상승\(C·D·E\)이어야 합니다/);
  assert.equal(card.root.querySelector('[name=segment]').value, 'C', 'the form already holds the run the FATO fixes');
  assert.deepEqual(card.root.querySelectorAll('.route-part').map(p => p.getAttribute('aria-disabled')), [null, 'true', 'true']);
  assert.match(card.root.textContent, /상승\(C·D·E\)으로 고정/);
  card.root.querySelector('form').submit(); await settle();
  assert.deepEqual(calls.updatedLinks[0], ['rl-9', {from: 'fato:vp-2:F1', to: 'rn-a', segment: 'C', name: '잠실 F1 → 진입'}], 'saving fixes it');
});

test('the check sends the links in batches, draws each answer as it lands, sums up, and a created link is checked on its own', async () => {
  const links = Array.from({length: CONFLICT_BATCH + 2}, (_, i) => ({id: `rl-${i}`, name: `L${i}`, from: 'rn-a', to: 'rn-b', segment: 'F', width_m: 300}));
  const {panel, body, calls, events, settle} = harness({links,
    request: (ids, state) => ({links: state.links.filter(l => !ids || ids.includes(l.id)).map(l => ({id: l.id, segment: 'F', width_m: 300, from: {longitude: 126.93, latitude: 37.53, height: 330, ground: 25}, to: {longitude: 126.99, latitude: 37.55, height: 480, ground: 22}, grounds: [25, 20, 22]}))}),
    conflicts: body => ({links: Object.fromEntries(body.links.map((l, i) => [l.id, report(l.id === 'rl-0' ? 1 : 0, l.id === 'rl-1' ? 1 : 0)])), cells: 5})});
  panel.render(body); panel.activate(); await panel.ready; await settle();
  body.querySelector('#route-check').click(); await settle();
  assert.deepEqual(calls.requests, [null], 'the whole network was asked for');
  assert.deepEqual(calls.conflicts.map(b => b.links.length), [CONFLICT_BATCH, 2], 'two batches');
  assert.equal(events.conflicts.length, 2, 'the map heard each batch');
  assert.equal(panel.conflicts.get('rl-0').collisions, 1);
  assert.match(body.querySelector('#route-summary').textContent, /건물 충돌 1구간 · 근접 1구간 \(검사 10\)/);
  assert.match(events.notices.at(-1)[1], /충돌 1구간, 근접 1구간 \(10구간 검사\)/);
  assert.equal(body.querySelector('#route-check').disabled, false);
  assert.equal(body.querySelector('#route-check').textContent, '건물 충돌 검사');
  // A new link is checked the moment it is drawn, alone.
  panel.mapClick({hit: {kind: 'node', id: 'rn-a'}, screen: {x: 0, y: 0}});
  panel.mapClick({hit: {kind: 'node', id: 'fato:vp-1:F2'}, screen: {x: 0, y: 0}});
  panel.card.root.querySelectorAll('.route-part').find(p => p.getAttribute('data-segment') === 'G').click(); await settle();
  assert.deepEqual(calls.requests.at(-1), ['rl-101'], 'only the new link');
  assert.equal(calls.conflicts.at(-1).links.length, 1);
});

test('without building data the check says what is missing, and a link that goes takes its report', async () => {
  const links = [{id: 'rl-1', name: 'L', from: 'rn-a', to: 'rn-b', segment: 'F', width_m: 300}];
  const {panel, body, events, settle, state} = harness({links, request: () => ({links: [{id: 'rl-1', from: {}, to: {}}]}),
    conflicts: () => {throw Object.assign(new Error('HTTP 404'), {status: 404, data: {error: 'buildings_not_configured'}});}});
  panel.render(body); panel.activate(); await panel.ready; await settle();
  body.querySelector('#route-check').click(); await settle();
  assert.match(events.notices.at(-1)[1], /브이월드 건물 자료가 필요합니다/);
  assert.equal(panel.checking, null);
  panel.conflicts.set('rl-1', report(1));
  state.links = [];
  await panel.refresh();
  assert.equal(panel.conflicts.size, 0, 'no link, no report');
});

// ---------------------------------------------------------------- the layer

class Cartesian3 {constructor(x = 0, y = 0, z = 0) {Object.assign(this, {x, y, z});} static fromDegrees(lon, lat, h = 0) {return new Cartesian3(lon, lat, h);}}
class Entities {constructor() {this.values = [];} add(d) {const e = {...d}; this.values.push(e); return e;} remove(e) {this.values = this.values.filter(v => v !== e);}}
class Primitives {constructor() {this.values = [];} add(p) {this.values.push(p); return p;} remove(p) {this.values = this.values.filter(v => v !== p);}}
class Primitive {
  constructor(o) {Object.assign(this, o); this.ready = true; this.colors = new Map();}
  getGeometryInstanceAttributes(id) {if (!this.geometryInstances.some(i => i.id === id)) return undefined; if (!this.colors.has(id)) this.colors.set(id, {color: null}); return this.colors.get(id);}
}
const C = {Cartesian3, Cartesian2: class {constructor(x, y) {this.x = x; this.y = y;}},
  Color: {fromCssColorString: css => ({css, withAlpha(alpha) {return {css, alpha};}})},
  LabelStyle: {FILL_AND_OUTLINE: 'fo'}, VerticalOrigin: {BOTTOM: 'b'}, NearFarScalar: class {constructor(...a) {this.a = a;}},
  DistanceDisplayCondition: class {constructor(near, far) {this.near = near; this.far = far;}},
  PolylineDashMaterialProperty: class {constructor(o) {Object.assign(this, o); this.dashed = true;}},
  ArcType: {NONE: 'none'},
  Geometry: class {constructor(o) {Object.assign(this, o);}}, GeometryAttribute: class {constructor(o) {Object.assign(this, o);}},
  ComponentDatatype: {DOUBLE: 'double'}, PrimitiveType: {TRIANGLES: 'triangles'},
  BoundingSphere: {fromVertices: values => ({vertices: values.length / 3})},
  GeometryInstance: class {constructor(o) {Object.assign(this, o);}},
  ColorGeometryInstanceAttribute: {fromColor: color => ({color}), toValue: (color, result) => Object.assign(result ?? {}, {value: color})},
  DistanceDisplayConditionGeometryInstanceAttribute: {fromDistanceDisplayCondition: condition => ({condition})},
  PerInstanceColorAppearance: class {constructor(o) {Object.assign(this, o);}},
  Primitive};
const layerLinks = [
  {id: 'rl-1', name: '여의도 F1 → 진입', from: 'fato:vp-1:F1', to: 'rn-a', segment: 'C', width_m: null},
  {id: 'rl-2', name: '진입 → 순항점', from: 'rn-a', to: 'rn-b', segment: 'F', width_m: 300},
  {id: 'rl-3', name: '잠실 F1 → 진입', from: 'fato:vp-2:F1', to: 'rn-a', segment: 'G', width_m: null, problem: 'segment: a route leaves a FATO climbing (C)'},
];

test('the layer paints what the check said: red through a building, amber close over one, the worst building named; a misfit link is dashed', async () => {
  const entities = new Entities(), scene = {primitives: new Primitives()};
  const layer = new RouteLayer(C, {entities, scene}, {groundHeights: async points => points.map(() => 50)});
  await layer.show({nodes, fatos, links: layerLinks});
  const line = id => entities.values.find(e => e.polyline && e.aerodtRoute?.id === id);
  const [primitive] = scene.primitives.values;
  assert.equal(line('rl-3').polyline.material.dashed, true, 'a link that no longer fits its FATO is dashed');
  assert.equal(line('rl-3').polyline.material.color.css, PROBLEM_COLOR);
  assert.equal(line('rl-1').polyline.material.css, '#ffb457', 'a sound link keeps its segment colour');
  const before = entities.values.length;
  layer.setConflicts({'rl-1': report(1), 'rl-2': report(0, 1)});
  assert.equal(line('rl-1').polyline.material.css, CONFLICT_COLOR);
  assert.equal(primitive.getGeometryInstanceAttributes('link:rl-2').color.value.css, TIGHT_COLOR, 'the corridor turns amber through its colour attribute');
  const marks = entities.values.filter(e => e.label && !e.aerodtRoute?.kind?.startsWith('node') && e.point && e.aerodtRoute?.kind === 'link');
  assert.equal(marks.length, 2, 'the worst building under each link is marked');
  const worst = marks.find(m => m.aerodtRoute.id === 'rl-1');
  assert.match(worst.label.text, /⚠ 건물 충돌 · 타워 87 m\n경로 85 m · 여유 -27 m/);
  assert.equal(worst.position.z, 112, 'on the building top');
  assert.match(marks.find(m => m.aerodtRoute.id === 'rl-2').label.text, /△ 건물 근접/);
  assert.equal(entities.values.length, before + 4, 'a marker and a drop line each');
  layer.hover({kind: 'link', id: 'rl-1'});
  assert.equal(line('rl-1').polyline.material.css, '#ffffff', 'hover still wins');
  layer.hover(null);
  layer.setConflicts({'rl-1': null});
  assert.equal(line('rl-1').polyline.material.css, '#ffb457', 'cleared: back to the segment colour');
  assert.equal(entities.values.filter(e => e.point && e.aerodtRoute?.kind === 'link').length, 1);
  await layer.show({nodes, fatos, links: layerLinks.filter(l => l.id !== 'rl-2')});
  assert.equal(layer.conflicts.size, 0, 'a link that went took its report');
  layer.setConflicts({'rl-1': report(1)});
  layer.clearConflicts();
  assert.equal(entities.values.filter(e => e.point && e.aerodtRoute?.kind === 'link').length, 0);
});

test('a corridor colour that arrives before the primitive has rendered is written after the next frame, not lost', async () => {
  const entities = new Entities(), rendered = {listeners: []};
  const scene = {primitives: new Primitives(), postRender: {addEventListener(fn) {rendered.listeners.push(fn);}, removeEventListener(fn) {rendered.listeners = rendered.listeners.filter(f => f !== fn);}}};
  const layer = new RouteLayer(C, {entities, scene}, {groundHeights: async points => points.map(() => 50)});
  await layer.show({nodes, fatos, links: layerLinks});
  const [primitive] = scene.primitives.values;
  primitive.ready = false;   // as a real Primitive is until its first update
  layer.setConflicts({'rl-2': report(1)});
  assert.equal(primitive.getGeometryInstanceAttributes('link:rl-2').color.value.css, '#7fe9f5', 'nothing could be written yet: still the cruise colour');
  assert.equal(layer.fillsPending, true);
  primitive.ready = true;
  for (const fn of rendered.listeners) fn();
  assert.equal(primitive.getGeometryInstanceAttributes('link:rl-2').color.value.css, CONFLICT_COLOR, 'finished after the frame');
  assert.equal(layer.fillsPending, false);
  layer.destroy();
  assert.equal(rendered.listeners.length, 0, 'the listener goes with the layer');
});

test('the page wires the check: a long request for the batches, the map supplies the ground, and the styles exist', () => {
  assert.match(app, /conflicts:async body=>/);
  assert.match(app, /'\/api\/simulation\/routes\/conflicts'/);
  assert.match(app, /AbortSignal\.timeout\(90000\)/);
  assert.match(app, /conflictRequest:ids=>liveGlobe\?\.routeConflictRequest\(ids\)/);
  assert.match(app, /onConflicts:reports=>liveGlobe\?\.showRouteConflicts\(reports\)/);
  assert.match(css, /\.route-part\.route-locked\{cursor:not-allowed\}/);
  // The card's warning text is written in the colour the map draws the link
  // in, so the two can never drift apart and mean different things.
  assert.ok(css.includes(`.route-conflict{color:${CONFLICT_COLOR}}`), 'conflict note matches the map');
  assert.ok(css.includes(`.route-tight{color:${TIGHT_COLOR}}`), 'proximity note matches the map');
});

test('the card says which colour the map is using, and why it is not the segment colour', () => {
  // Found live: a link set to descent was drawn amber, because two buildings
  // sat 29 m under it. The warning colour is right - a roof outranks a
  // category - but with nothing said, setting the segment looks like it failed.
  const near = {collisions: 0, tight: 2, buildings: [{name: '타워', height_m: 73, top_m: 73, path_m: 103, clearance_m: 29}]};
  const hit = {collisions: 1, tight: 0, buildings: [{name: '타워', height_m: 73, top_m: 73, path_m: 60, clearance_m: -4}]};
  assert.match(drawnColourNote(near, 'G'), /건물 근접 경고색\(연한 빨강\)/);
  assert.match(drawnColourNote(near, 'G'), /강하 색으로 돌아옵니다/, 'and which colour it will go back to');
  assert.match(drawnColourNote(hit, 'C'), /건물 충돌 경고색\(진한 빨강\).*상승 색으로 돌아옵니다/);
  // Folded letters read as the run that flies them.
  assert.match(drawnColourNote(near, 'H'), /강하 색/);
  // Nothing to explain when the segment's own colour is what is drawn.
  assert.equal(drawnColourNote({collisions: 0, tight: 0, buildings: []}, 'G'), '');
  assert.equal(drawnColourNote(null, 'G'), '');
});

test('a building warning does not look like any segment colour', () => {
  // The whole confusion: amber over a roof sat 4 degrees of hue from the climb
  // colour, so a descent close over a building read as a climb. Both warnings
  // are red now, and red is not a segment.
  const hue = css => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(css.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (!d) return 0;
    const raw = max === r ? (g - b) / d : max === g ? 2 + (b - r) / d : 4 + (r - g) / d;
    return ((raw * 60) % 360 + 360) % 360;
  };
  const apart = (a, b) => {const gap = Math.abs(hue(a) - hue(b)); return Math.min(gap, 360 - gap);};
  for (const segment of FALLBACK_OPTIONS.segments) {
    for (const [name, warning] of [['collision', CONFLICT_COLOR], ['tight', TIGHT_COLOR]])
      assert.ok(apart(warning, segment.color) > 25,
        `${name} ${warning} is ${apart(warning, segment.color).toFixed(0)} degrees from ${segment.korean} ${segment.color}`);
  }
  // And the two warnings stay apart from each other, by how strong they are.
  assert.equal(hue(CONFLICT_COLOR), hue(TIGHT_COLOR), 'both red');
  const saturation = css => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(css.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    return max ? (max - Math.min(r, g, b)) / max : 0;
  };
  assert.ok(saturation(CONFLICT_COLOR) - saturation(TIGHT_COLOR) > .2, 'a collision is the stronger red');
  // The misfit-FATO amber is still close to the climb colour; it is told apart
  // by its dashes instead, which the layer test covers.
  assert.ok(apart(PROBLEM_COLOR, '#ffb457') < 25, 'documented, not asserted as good');
});

test('the deck outlines travel with every batch, and a deck that moves drops the reports', () => {
  // Found live: a vertiport was moved onto a building, the map stopped drawing
  // that building, and the route over it still said 건물 근접. The check knew
  // nothing about vertiports, and nothing invalidated what it had already said.
  const globe = readFileSync('digital_twin/visualization/web/globe.js', 'utf-8');
  const panel = readFileSync('user_application/web/domains/uam/planning/route_panel.js', 'utf-8');
  const app = readFileSync('user_application/web/app.js', 'utf-8');
  // The same outlines the building layer is told to leave alone go to the server.
  assert.match(globe, /this\.vworldBuildings\?\.setCleared\?\.\(cleared, overlapsFootprint\)/);
  assert.match(globe, /return \{cleared:\(this\.clearedGround \?\? \[\]\)\.map\(ring=>ring\.map\(point=>\[point\.longitude,point\.latitude\]\)\)/);
  // Every batch, not only the first: the server keeps no state between them.
  assert.match(panel, /this\.api\.conflicts\(\{links: batch, cleared: request\.cleared \?\? \[\]\}\)/);
  // And a deck that moved takes the old answers with it.
  assert.match(globe, /if \(moved\) \{this\.routeLayer\?\.clearConflicts\?\.\(\); this\.onClearedGround\?\.\(\);\}/);
  assert.match(app, /globe\.onClearedGround=\(\)=>routePanel\.dropConflicts\(\)/);
});

test('dropping the reports empties the map, the summary and any open card', () => {
  const panel = new RoutePanel({document: fakeDocument, api: {}, notify: () => {}});
  panel.showSummary = () => {panel.summarised = (panel.summarised ?? 0) + 1;};
  assert.equal(panel.dropConflicts(), false, 'nothing to drop');
  panel.conflicts.set('rl-1', {collisions: 0, tight: 1, buildings: []});
  let rebuilt = 0;
  panel.editingLink = {id: 'rl-1'};
  panel.card = {isOpen: true};
  panel.openLinkEdit = () => {rebuilt++;};
  assert.equal(panel.dropConflicts(), true);
  assert.equal(panel.conflicts.size, 0);
  assert.equal(rebuilt, 1, 'the open card is built again without the warning');
  assert.ok(panel.summarised >= 1);
  // A closed card is not reopened by clearing.
  panel.conflicts.set('rl-2', {collisions: 1, tight: 0, buildings: []});
  panel.card = {isOpen: false};
  panel.dropConflicts();
  assert.equal(rebuilt, 1);
});
