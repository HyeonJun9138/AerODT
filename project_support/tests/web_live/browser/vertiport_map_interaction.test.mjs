import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement, fakeDocument} from './fake_dom.mjs';
import {PlaceMenu} from '../../../../user_application/web/place_menu.js';
import {RouteCard, TAGS} from '../../../../user_application/web/domains/uam/planning/route_card.js';
import {SimulationPanel, HEIGHT_CHECK_DELAY_MS} from '../../../../user_application/web/domains/uam/planning/simulation_panel.js';
import {VertiportLayer} from '../../../../digital_twin/visualization/web/vertiport_layer.js';
import {rotateLayout} from '../../../../digital_twin/visualization/web/vertiport_paint.js';

const web = new URL('../../../../user_application/web/', import.meta.url);
const app = readFileSync(new URL('app.js', web), 'utf8');
const globe = readFileSync(new URL('../../../../digital_twin/visualization/web/globe.js', import.meta.url), 'utf8');

// Only the pieces the layer's pick and highlight touch.
const C = {Color: {fromCssColorString: css => ({css, withAlpha(alpha) {return {css, alpha};}})}};

function layerWith(entities) {
  const layer = new VertiportLayer(C, {entities: {add: () => {}, remove: () => {}}, scene: {}});
  layer.owned.set('vp-1', entities);
  return layer;
}

function parts() {
  return [
    {id: 'vertiport:vp-1:platform', polygon: {outlineColor: {css: '#3b464f'}, outlineWidth: 1}},
    {id: 'vertiport:vp-1:deck', polygon: {}},
    {id: 'vertiport:vp-1:name', label: {fillColor: {css: '#c9f2fa'}}},
    {id: 'vertiport:vp-1:marker', point: {pixelSize: 9, color: {css: '#7fe9f5'}}},
  ];
}

test('a scene pick over any part of a vertiport answers with that vertiport', () => {
  const layer = layerWith(parts());
  for (const part of ['platform', 'deck', 'facade', 'name', 'marker', 'charger:C1']) {
    assert.deepEqual(layer.pick({id: {id: `vertiport:vp-1:${part}`}}), {kind: 'vertiport', id: 'vp-1'},
      `${part} belongs to its vertiport`);
  }
  assert.deepEqual(layer.pick({id: 'vertiport:vp-1:platform'}), {kind: 'vertiport', id: 'vp-1'}, 'a raw string id too');
  assert.equal(layer.pick({id: {id: 'vertiport:__preview__:deck'}}), null, 'the preview is not a saved vertiport');
  assert.equal(layer.pick({id: {id: 'link:rl-1'}}), null, 'a route link is not a vertiport');
  assert.equal(layer.pick({id: {name: 'an aircraft entity'}}), null);
  assert.equal(layer.pick(undefined), null);
});

test('hovering brightens the vertiport in place and moving off restores it', () => {
  const entities = parts();
  const layer = layerWith(entities);
  const [platform, , name, marker] = entities;
  assert.equal(layer.setHovered('vp-1'), true);
  assert.equal(layer.setHovered('vp-1'), false, 'no change is not reported twice');
  assert.equal(platform.polygon.outlineColor.css, '#ffffff');
  assert.equal(platform.polygon.outlineWidth, 3);
  assert.equal(marker.point.pixelSize, 12);
  assert.equal(name.label.fillColor.css, '#ffffff');
  assert.equal(layer.setHovered(null), true);
  assert.equal(platform.polygon.outlineColor.css, '#3b464f');
  assert.equal(platform.polygon.outlineWidth, 1);
  assert.equal(marker.point.pixelSize, 9);
  assert.equal(marker.point.color.css, '#7fe9f5');
  assert.equal(name.label.fillColor.css, '#c9f2fa');
});

test('a vertiport being edited keeps its faint weight while hovered', () => {
  const entities = parts();
  const layer = layerWith(entities);
  layer.dimmed = new Set(['vp-1']);
  layer.setHovered('vp-1');
  assert.equal(entities[0].polygon.outlineColor.alpha, 0.3, 'the ghost is lit but stays a ghost');
  assert.equal(entities[3].point.color.alpha, 0.3);
});

const record = {id: 'vp-1', name: '여의도 버티허브', latitude: 37.53, longitude: 126.93, heading_deg: 0,
  gates: 4, pattern: 'row', vehicle_class: 'medium', vehicle_d_m: 12, platform_height_m: 1,
  ground_reference: 'highest', fatos: [{id: 'F1', role: 'both'}], layout: {frame: {latitude: 37.53, longitude: 126.93, heading_deg: 0}}};

function panelHarness({picked = {latitude: 37.6, longitude: 127.1}} = {}) {
  const editors = [], focused = [], removed = [], saved = [], previews = [], picks = [];
  const mount = new FakeElement('body');
  const card = new RouteCard({document: fakeDocument, mount, viewport: () => ({width: 1200, height: 800})});
  const placeMenu = new PlaceMenu({document: fakeDocument, mount, viewport: () => ({width: 1200, height: 800})});
  const panel = new SimulationPanel({
    api: {list: async () => ({vertiports: [record]}), remove: async id => {removed.push(id);},
      preview: async definition => {previews.push(definition); return {layout: record.layout};},
      update: async (id, definition) => {saved.push([id, definition]); return {vertiport: {...record, ...definition}};}},
    document: fakeDocument, card, placeMenu, onVertiportEditor: editor => editors.push(editor),
    onFocus: item => focused.push(item.id), screenOf: () => ({x: 700, y: 500}),
    pickLocation: options => {picks.push(options); return Promise.resolve(picked);},
    setTimer: () => 1, clearTimer: () => {}});
  // The page wires the tools to the panel the same way.
  Object.assign(placeMenu, {onChange: (name, value) => panel.toolChanged(name, value)});
  panel.records = [record];
  const body = new FakeElement('div');
  const settle = async () => {for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));};
  return {panel, body, card, placeMenu, editors, focused, removed, saved, previews, picks, settle,
    editor: () => editors[editors.length - 1]};
}

test('the vertiport tab takes the map: a click on a saved vertiport opens its tools, look and delete included', async () => {
  // There used to be a card in between whose only real button was 편집: placing
  // a vertiport and adjusting one read as two features. One click, one card.
  const {panel, body, card, placeMenu, editor, focused} = panelHarness();
  panel.render(body);
  await panel.ready;
  assert.equal(typeof editor().onSelect, 'function');
  assert.equal(typeof editor().onContextMenu, 'function');
  editor().onSelect({id: 'vp-1', screen: {x: 400, y: 300}});
  assert.equal(card.isOpen, false, 'no intermediate card');
  assert.equal(placeMenu.isOpen, true, 'the tools open on the vertiport itself');
  assert.equal(panel.toolsMode, 'edit');
  assert.equal(panel.editingId, 'vp-1');
  assert.match(placeMenu.root.querySelector('header').textContent, /수정 · 여의도 버티허브/);
  assert.match(placeMenu.root.querySelector('.place-note').textContent, /게이트 4/, 'what it is stays readable');
  assert.equal(placeMenu.root.style.left, '410px');
  const look = placeMenu.root.querySelectorAll('button').find(item => item.textContent === '보기');
  assert.ok(look, 'a look at it is in the same card');
  look.click();
  assert.deepEqual(focused, ['vp-1']);
  editor().onSelect({id: 'vp-missing', screen: {x: 0, y: 0}});
  assert.equal(placeMenu.isOpen, true, 'an unknown id leaves the open tools alone');
});

test('the right button opens the height and layout tools beside the pointer', async () => {
  const {panel, body, placeMenu, editor, saved, settle} = panelHarness();
  panel.render(body);
  await panel.ready;
  editor().onContextMenu({id: 'vp-1', screen: {x: 100, y: 100}});
  assert.equal(placeMenu.isOpen, true, 'the tools open where the pointer is');
  assert.equal(panel.picking, false, 'no placement was armed to get here');
  assert.equal(panel.toolsMode, 'edit');
  assert.equal(panel.editingId, 'vp-1', 'the record is in the form behind the tools');
  assert.match(placeMenu.root.querySelector('header').textContent, /수정 · 여의도 버티허브/);
  assert.equal(placeMenu.root.querySelector('.place-confirm').textContent, '저장');
  assert.equal(placeMenu.root.style.left, '110px');
  // A tool change is an edit of that vertiport, not of a new one.
  placeMenu.root.querySelector('[name=heading_deg]').value = '45';
  placeMenu.root.querySelector('[name=heading_deg]').oninput();
  assert.equal(body.querySelector('[name=heading_deg]').value, '45');
  placeMenu.root.querySelector('.place-confirm').click();
  await settle();
  assert.equal(placeMenu.isOpen, false);
  assert.equal(saved.length, 1);
  assert.equal(saved[0][0], 'vp-1');
  assert.equal(saved[0][1].heading_deg, 45);
});

test('the tools can pick the vertiport up and put it somewhere else', async () => {
  const {panel, body, placeMenu, editor, picks, saved, settle} = panelHarness();
  panel.render(body);
  await panel.ready;
  editor().onContextMenu({id: 'vp-1', screen: {x: 100, y: 100}});
  const relocate = placeMenu.root.querySelector('.place-relocate');
  assert.equal(relocate.textContent, '지도에서 위치 조정');
  relocate.click();
  await settle();
  assert.equal(picks.length, 1, 'the map follows the cursor again');
  assert.equal(body.querySelector('[name=latitude]').value, '37.600000', 'the click moved it');
  assert.equal(body.querySelector('[name=longitude]').value, '127.100000');
  assert.equal(placeMenu.isOpen, true, 'the tools come back where it landed');
  assert.equal(placeMenu.root.style.left, '710px', 'beside the new position');
  assert.equal(panel.editingId, 'vp-1', 'still the same vertiport');
  placeMenu.root.querySelector('.place-confirm').click();
  await settle();
  assert.equal(saved[0][1].latitude, 37.6, 'saving keeps the new place');
  assert.equal(saved[0][1].longitude, 127.1);
});

test('escape closes the tools and cancelling them leaves the edit behind', async () => {
  const {panel, body, placeMenu, editor} = panelHarness();
  panel.render(body);
  await panel.ready;
  editor().onContextMenu({id: 'vp-1', screen: {x: 0, y: 0}});
  assert.equal(panel.escape(), true);
  assert.equal(placeMenu.isOpen, false);
  assert.equal(panel.editingId, 'vp-1', 'the form still holds the edit');
  editor().onContextMenu({id: 'vp-1', screen: {x: 0, y: 0}});
  placeMenu.root.querySelectorAll('button').find(item => item.textContent === '취소').click();
  assert.equal(placeMenu.isOpen, false);
  assert.equal(panel.editingId, null, 'cancelling puts the vertiport back');
  assert.equal(panel.toolsMode, null);
});

test('the tools delete the vertiport they are on, with two presses', async () => {
  const {panel, body, card, placeMenu, editor, removed, settle} = panelHarness();
  panel.render(body);
  await panel.ready;
  editor().onSelect({id: 'vp-1', screen: {x: 0, y: 0}});
  assert.equal(placeMenu.isOpen, true);
  assert.equal(card.isOpen, false);
  const remove = placeMenu.root.querySelector('.sim-danger');
  assert.ok(remove, 'removal is in the tools card');
  remove.click();
  assert.equal(remove.textContent, '삭제 확인', 'two presses to delete');
  assert.deepEqual(removed, []);
  remove.click();
  await settle();
  assert.deepEqual(removed, ['vp-1']);
  assert.equal(placeMenu.isOpen, false, 'the tools close with the vertiport');
  assert.equal(panel.editingId, null);
});

test('other tabs and leaving the section hand the map back', async () => {
  const {panel, body, card, editors, editor} = panelHarness();
  panel.render(body);
  assert.ok(editor(), 'armed on the vertiport tab');
  body.querySelector('#sim-tab-routes').click();
  assert.equal(editor(), null, 'the route tab owns the map instead');
  body.querySelector('#sim-tab-vertiports').click();
  assert.ok(editor());
  editor().onSelect({id: 'vp-1', screen: {x: 0, y: 0}});
  assert.equal(panel.escape(), true, 'escape closes the card first');
  assert.equal(card.isOpen, false);
  panel.leave();
  assert.equal(editors[editors.length - 1], null);
  body.querySelector('#sim-category-aircraft').click();
  assert.equal(editor(), null, 'another category is not the vertiport map either');
});

test('the form comes first and the saved list opens when it is asked for', async () => {
  const {panel, body} = panelHarness();
  panel.render(body);
  await panel.ready;
  const order = body.children.map(child => child.attributes.id ?? child.className);
  assert.ok(order.indexOf('vertiport-form-title') < order.indexOf('vertiport-list-toggle'),
    'the form is above the saved list');
  const toggle = body.querySelector('#vertiport-list-toggle');
  const list = body.querySelector('#vertiport-list');
  assert.equal(toggle.textContent, '생성된 버티포트 1', 'the count reads without opening it');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(list.hidden, true);
  assert.equal(list.querySelectorAll('.sim-item').length, 0, 'nothing is built until it is opened');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(list.hidden, false);
  assert.equal(list.querySelectorAll('[data-id=vp-1]').length, 1);
  toggle.click();
  assert.equal(list.hidden, true);
});

test('opening a section does not narrow what is already on screen', () => {
  // A scrollbar that appears when the saved list opens would re-flow the form
  // beside it, so every panel that can start scrolling reserves the gutter.
  const css = readFileSync(new URL('styles.css', web), 'utf8');
  for (const selector of ['#drawer-body', '.place-menu', '.route-card']) {
    const rule = css.match(new RegExp(`${selector.replace('.', '\.')}\{([^}]+)\}`))?.[1] ?? '';
    assert.match(rule, /scrollbar-gutter:stable/, `${selector} keeps its width`);
    assert.doesNotMatch(rule, /overflow:auto/, `${selector} scrolls in one direction only`);
  }
});

test('the map wiring is in the page and the globe', () => {
  assert.match(globe, /setVertiportEditor\(/);
  assert.match(globe, /vertiportEditor\.onSelect\(/);
  assert.match(globe, /vertiportEditor\?\.onContextMenu/);
  const handler=globe.match(/this\.onContextMenu=(event=>[^;]+);/)[1];
  let prevented=false;
  new Function('return '+handler)()({preventDefault(){prevented=true;}});
  assert.equal(prevented,true,'entity and vertiport cards are not covered by the browser menu');
  assert.match(app, /onVertiportEditor:/);
  assert.match(app, /new RouteCard\(/);
  assert.match(app, /simulationPanel\.escape\(\)/);
});

// The placement tools are dragged, and every tick used to cost a server round
// trip plus a full preview rebuild (measured: 50-75 ms of painting and shell
// building per tick, plus a shader compile). A heading is a rigid turn of the
// last answer, so it needs no server; a height or count change is coalesced.
function timedHarness() {
  const timers = [], previews = [], follows = [], shown = [];
  const mount = new FakeElement('body');
  const placeMenu = new PlaceMenu({document: fakeDocument, mount, viewport: () => ({width: 1200, height: 800})});
  const layout = {frame: {latitude: 37.53, longitude: 126.93, heading_deg: 0}, platform: {corners_m: [[-40, -30], [40, -30], [40, 30], [-40, 30]], height_m: 1},
    fatos: [{id: 'F1', role: 'both', center_m: [0, 0], radius_m: 9}], gates: [], edges: [], chargers: [], nodes: []};
  const panel = new SimulationPanel({
    api: {list: async () => ({vertiports: []}), preview: async definition => {previews.push(definition); return {layout: {...layout, frame: {...layout.frame, heading_deg: definition.heading_deg}}};},
      heightConflicts: () => {}},
    document: fakeDocument, card: new RouteCard({document: fakeDocument, mount, viewport: () => ({width: 1200, height: 800})}), placeMenu,
    rotateLayout, drawThumbnail: () => true, onPreview: (item, name) => shown.push([item, name]), onFollow: (item, name, pose) => follows.push([item, name, pose]),
    onFollowMove: () => {}, onVertiportEditor: () => {}, screenOf: () => ({x: 700, y: 500}),
    setTimer: (fn, delay) => {timers.push({fn, delay}); return timers.length;}, clearTimer: id => {if (timers[id - 1]) timers[id - 1].cleared = true;}});
  Object.assign(placeMenu, {onChange: (name, value) => panel.toolChanged(name, value)});
  const pending = () => timers.filter(t => !t.cleared && !t.fired);
  const fire = predicate => {for (const t of pending()) if (predicate(t)) {t.fired = true; t.fn();}};
  return {panel, placeMenu, timers, previews, follows, shown, pending, fire};
}

test('turning a placement with the heading tool needs no server answer and no second rebuild', async () => {
  const {panel, timers, previews, follows, pending, fire} = timedHarness();
  const body = new FakeElement('div');
  panel.render(body); await panel.ready;
  panel.form_.querySelector('[name=latitude]').value = '37.53'; panel.form_.querySelector('[name=longitude]').value = '126.93';
  await panel.preview();
  assert.equal(previews.length, 1, 'the design was asked for once');
  const before = timers.length;
  panel.toolChanged('heading_deg', 45);
  const scheduled = timers.slice(before).filter(t => !t.cleared);
  const previewDelays = [0, panel.previewDelayMs, panel.toolPreviewDelayMs];
  assert.ok(!scheduled.some(t => previewDelays.includes(t.delay)), 'no preview request is scheduled for a turn');
  assert.ok(scheduled.some(t => t.delay === HEIGHT_CHECK_DELAY_MS), 'the building check still runs for the turned deck');
  assert.equal(panel.lastPreview.layout.frame.heading_deg, 45, 'the last answer was turned in place');
  fire(t => timers.indexOf(t) >= before && previewDelays.includes(t.delay));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(previews.length, 1, 'still one request');
});

test('height and layout tool ticks are coalesced into one trailing preview instead of one per pointer event', async () => {
  const {panel, previews, pending, fire} = timedHarness();
  const body = new FakeElement('div');
  panel.render(body); await panel.ready;
  panel.form_.querySelector('[name=latitude]').value = '37.53'; panel.form_.querySelector('[name=longitude]').value = '126.93';
  await panel.preview();
  for (const metres of [6, 12, 18, 24]) panel.toolChanged('platform_height_m', metres);
  const live = pending().filter(t => t.delay !== HEIGHT_CHECK_DELAY_MS && t.delay !== 1000);
  assert.equal(live.length, 1, 'one timer survives the drag');
  assert.ok(live[0].delay >= 100 && live[0].delay <= 250, `a trailing pause, not 0 ms: ${live[0].delay}`);
  assert.equal(panel.toolPreviewDelayMs, live[0].delay);
  fire(t => t === live[0]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(previews.length, 2, 'then exactly one request for the final value');
  assert.equal(previews[1].platform_height_m, 24);
});
