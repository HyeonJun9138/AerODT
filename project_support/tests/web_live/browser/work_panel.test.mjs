import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {WorkPanel} from '../../../../user_application/web/work_panel.js';

const web = new URL('../../../../user_application/web/', import.meta.url);
const html = readFileSync(new URL('index.html', web), 'utf8');
const css = readFileSync(new URL('styles.css', web), 'utf8');
const app = readFileSync(new URL('app.js', web), 'utf8');
const rule = selector => css.match(new RegExp(`(?:^|})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]+)\\}`))?.[1] ?? '';

function element() {
  return {attributes: {}, dataset: {}, textContent: '', inert: false,
    setAttribute(key, value) {this.attributes[key] = String(value);},
    getAttribute(key) {return this.attributes[key] ?? null;}};
}

function setup() {
  const root = element(), title = element(), body = element(), owner = element();
  const buttons = {live: element(), simulation: element()};
  const panel = new WorkPanel({root, title, body, owner, buttons});
  return {panel, root, title, body, owner, buttons};
}

test('the panel starts closed, out of the tab order and with the layout unshifted', () => {
  const {panel, root, owner, buttons} = setup();
  assert.equal(panel.openId, null);
  assert.equal(root.inert, true);
  assert.equal(root.getAttribute('aria-hidden'), 'true');
  assert.equal(owner.dataset.drawer, 'closed');
  assert.equal(buttons.live.getAttribute('aria-expanded'), 'false');
});

test('opening a section widens the layout and names the section', () => {
  const {panel, root, title, body, owner, buttons} = setup();
  panel.open('live', {label: 'Live Twinning'});
  assert.equal(root.inert, false);
  assert.equal(root.getAttribute('aria-hidden'), 'false');
  assert.equal(owner.dataset.drawer, 'open');
  assert.equal(title.textContent, 'Live Twinning');
  assert.ok(body.textContent.length > 0, 'an empty section still says what it is');
  assert.equal(buttons.live.getAttribute('aria-expanded'), 'true');
  assert.equal(buttons.simulation.getAttribute('aria-expanded'), 'false');
});

test('only one section is expanded at a time and its own text is shown', () => {
  const {panel, title, body, buttons} = setup();
  panel.open('live', {label: 'Live Twinning'});
  panel.open('simulation', {label: 'Simulation', empty: 'Simulation 화면은 준비 중입니다.'});
  assert.equal(title.textContent, 'Simulation');
  assert.match(body.textContent, /준비 중/);
  assert.equal(buttons.live.getAttribute('aria-expanded'), 'false');
  assert.equal(buttons.simulation.getAttribute('aria-expanded'), 'true');
});

test('the same button closes what it opened and the layout returns', () => {
  const {panel, root, owner, buttons} = setup();
  panel.toggle('live', {label: 'Live Twinning'});
  assert.equal(panel.openId, 'live');
  panel.toggle('live', {label: 'Live Twinning'});
  assert.equal(panel.openId, null);
  assert.equal(root.inert, true);
  assert.equal(owner.dataset.drawer, 'closed');
  assert.equal(buttons.live.getAttribute('aria-expanded'), 'false');
  panel.toggle('live', {label: 'Live Twinning'});
  panel.toggle('simulation', {label: 'Simulation'});
  assert.equal(panel.openId, 'simulation', 'a different button switches rather than closes');
});

test('closing an already closed panel is harmless', () => {
  const {panel, owner} = setup();
  panel.close();
  assert.equal(panel.openId, null);
  assert.equal(owner.dataset.drawer, 'closed');
});

test('the drawer is markup that starts closed next to the rail', () => {
  const drawer = html.match(/<aside[^>]*id="drawer"[\s\S]*?<\/aside>/)?.[0] ?? '';
  assert.ok(drawer, 'the drawer exists');
  assert.match(drawer, /inert/);
  assert.match(drawer, /aria-hidden="true"/);
  assert.match(drawer, /id="drawer-title"/);
  assert.match(drawer, /id="drawer-body"/);
  assert.match(drawer, /id="drawer-close"/);
  assert.match(drawer, /class="[^"]*glass/, 'the drawer uses the shared surface');
  const style = rule('#drawer');
  assert.match(style, /position:fixed/);
  assert.match(style, /left:var\(--rail-width\)/);
  assert.match(style, /width:var\(--drawer-width\)/);
  assert.match(style, /transform:translateX\(/, 'closed it sits off screen so it can slide in');
  assert.match(css, /--drawer-width:calc\(330px \* var\(--display-text-scale,1\)\)/,
    'drawer width grows with per-client text size without CSS zoom');
  assert.match(css, /\[data-drawer=open\][^{]*#drawer\{[^}]*transform:none/);
});

test('opening the drawer pushes the left-anchored panels instead of covering them', () => {
  assert.match(css, /--left-offset:var\(--rail-width\)/);
  assert.match(css, /\[data-drawer=open\]\{[^}]*--left-offset:calc\(var\(--rail-width\) \+ var\(--drawer-width\)\)/);
  for (const selector of ['#layers', '#selection', '#settings-panel']) {
    assert.match(css, new RegExp(`${selector}\\{[^}]*left:calc\\(var\\(--left-offset\\)`), `${selector} follows the offset`);
  }
  assert.match(rule('#clock'), /left:calc\(var\(--left-offset\) \+ \(100vw - var\(--left-offset\)\)\/2\)/,
    'the clock centres over the visible map, not the window');
});

test('both rail sections open the panel and it can be closed again', () => {
  assert.match(app, /new WorkPanel\(/);
  assert.match(app, /mode-live/);
  assert.match(app, /mode-simulation/);
  assert.match(app, /drawer-close/);
  assert.match(app, /Escape/);
  assert.match(app, /준비 중/, 'the section with no view says so inside the panel');
});
