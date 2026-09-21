import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const web = new URL('../../../../user_application/web/', import.meta.url);
const html = readFileSync(new URL('index.html', web), 'utf8');
const css = readFileSync(new URL('styles.css', web), 'utf8');
const app = readFileSync(new URL('app.js', web), 'utf8');
const rule = selector => css.match(new RegExp(`(?:^|})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]+)\\}`))?.[1] ?? '';
function element(id) {
  const start = html.search(new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"`));
  if (start < 0) return '';
  const tag = html.slice(start).match(/^<([a-z]+)/)[1];
  const token = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
  token.lastIndex = start;
  let depth = 0, found;
  while ((found = token.exec(html))) {
    depth += found[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(start, found.index + found[0].length);
  }
  return html.slice(start);
}

test('a vertical work-area rail sits at the far left with labelled icon buttons', () => {
  const rail = element('rail');
  assert.ok(rail, 'the rail exists');
  assert.match(rail, /aria-label="[^"]+"/);
  for (const [id, label] of [['mode-live', 'Live Twinning'], ['mode-simulation', 'Simulation']]) {
    const button = rail.match(new RegExp(`<button\\b[^>]*\\bid="${id}"[\\s\\S]*?</button>`))?.[0];
    assert.ok(button, `${id} button exists`);
    assert.match(button, /<svg[\s\S]*<\/svg>/, `${id} carries an inline icon`);
    assert.ok(button.includes(label), `${id} carries its readable label`);
  }
  assert.match(element('mode-live'), /aria-current="page"/, 'Live Twinning is the current view');
  const simulation = element('mode-simulation');
  assert.doesNotMatch(simulation, /aria-disabled/, 'the button does act: it opens its panel');
  assert.match(simulation, /data-state="preparing"/, 'a view that does not exist yet is marked, not disabled');
  assert.match(rule('.rail-button[aria-expanded=true]'), /opacity:1/, 'the open section is never dimmed');
  assert.match(rule('.rail-button[aria-expanded=true]'), /background:/);
  assert.doesNotMatch(rule('.rail-button[data-state=preparing]'), /opacity/, 'preparing dims its icon, not the whole button');
  assert.equal(rule('.rail-button[aria-current=page]'), '', 'no extra marker competes with the open section');
  assert.doesNotMatch(css, /\.rail-button[^{]*\{[^}]*box-shadow:inset/, 'the rail carries no edge accent');
  const settings = element('settings');
  assert.match(settings, /<svg[\s\S]*<\/svg>/);
  assert.match(settings, /aria-expanded="false"/);
  assert.ok(rail.indexOf('id="settings"') > rail.indexOf('id="mode-simulation"'), 'settings sits at the end of the rail');
  assert.doesNotMatch(html, /앱 설치/);
  assert.match(rule('#rail'), /position:fixed/);
  assert.match(rule('#rail'), /left:0/);
  assert.match(rule('#rail'), /width:var\(--rail-width\)/);
  assert.match(rule('#rail'), /border-radius:0(?:;|$)/, 'the rail meets the window edges square');
  assert.match(css, /--rail-width:\d+px/);
});

test('the target chips are a rounded bar at the top left, not a bottom corner block', () => {
  const layers = element('layers');
  assert.ok(layers);
  for (const [id, label] of [['layer-aircraft', '항공기'], ['layer-satellite', '위성'], ['layer-uam', 'UAM']]) {
    const chip = layers.match(new RegExp(`<button\\b[^>]*\\bid="${id}"[\\s\\S]*?</button>`))?.[0];
    assert.ok(chip, `${id} chip exists`);
    assert.match(chip, /<svg[\s\S]*<\/svg>/);
    assert.ok(chip.includes(label));
  }
  assert.equal(element('summary'), '', 'the old bottom-right counter block is gone');
  assert.doesNotMatch(layers, /<b\b|id="(?:satellites|aircraft|uam)"/, 'chips show icons and names, without counts');
  assert.doesNotMatch(app, /\$\('(?:satellites|aircraft|uam)'\)/, 'removed count elements are not accessed');
  assert.match(rule('#layers'), /top:var\(--edge\)/);
  assert.match(rule('#layers'), /left:calc\(var\(--left-offset\)/, 'the offset is the rail width until a panel widens it');
  assert.match(rule('.chip'), /border-radius:\d+px/);
});

test('the two bars along the top are the same shape and sit on the same line', () => {
  const layers = rule('#layers'), clock = rule('#clock');
  const radius = text => text.match(/border-radius:([^;]+)/)?.[1];
  assert.ok(radius(layers), 'the chip bar states its curve');
  assert.equal(radius(clock), radius(layers), 'and the clock carries the same one, not the panel curve');
  const height = text => text.match(/min-height:([^;]+)/)?.[1];
  assert.ok(height(clock), 'the clock states a height');
  assert.equal(height(clock), height(layers), 'the same one the chips have, so the two read as one line');
  assert.match(clock, /top:var\(--edge\)/, 'and the same distance from the top');
  assert.match(layers, /top:var\(--edge\)/);
  // A block with padding leaves its text a pixel low; centring puts it on the line.
  assert.match(clock, /display:flex/);
  assert.match(clock, /align-items:center/);
});

test('camera hints sit left of the pointer and do not duplicate native tooltips',()=>{
  for(const id of ['north','top','scene-mode','zoom-in','zoom-out','reset']){
    assert.match(element(id),/aria-label="[^"]+"/);
    assert.doesNotMatch(element(id),/\btitle=/);
  }
  const hint=rule('#camera button[aria-label]::after');
  assert.match(hint,/content:attr\(aria-label\)/);
  assert.match(hint,/right:calc\(100% \+ 14px\)/);
  assert.match(hint,/pointer-events:none/);
  assert.match(css,/:is\(:hover,:focus-visible\)::after/);
  assert.doesNotMatch(app,/\$\('scene-mode'\)\.title=/);
});

test('a display toggle in the settings panel shows whether it is on', () => {
  // The buttons are moved out of the camera rail into the settings panel, so
  // the rail's pressed styling no longer reaches them.
  const on = rule('.setting-row button[aria-pressed=true]');
  const off = rule('.setting-row button[aria-pressed=false]');
  assert.ok(on, 'an on state is styled');
  assert.ok(off, 'and an off state is styled');
  assert.notEqual(on, off, 'the two states do not look the same');
  assert.match(on + off, /background|color|opacity/);
});

test('the UAM chip opens individual display settings without showing a count', () => {
  const chip = element('layer-uam');
  assert.doesNotMatch(chip, /aria-disabled/);
  assert.match(chip, /aria-expanded="false"/);
  assert.doesNotMatch(chip, /id="uam"/);
  assert.match(app, /setUamDisplay/, 'the menu drives separate UAM layers');
  assert.match(app, /savedVertiportCount=records.length/, 'library summary keeps its count independently of the chip');
  assert.doesNotMatch(app, /globe\.setLayerVisible\('uam'/, 'no live feed layer is toggled for UAM');
});

test('credits and the maker mark are a small bottom-right overlay on the shared glass', () => {
  assert.equal(element('program-footer'), '', 'the full-width footer bar is gone');
  assert.doesNotMatch(css, /#program-footer/);
  const attribution = element('attribution');
  assert.ok(attribution);
  assert.match(attribution, /id="map-credits"/);
  assert.match(attribution, /id="preview-credits"[^>]*hidden/);
  assert.match(attribution, /branding\/aerodt\.png/);
  assert.match(attribution, /KADA/);
  // The credits sit on a plate so they read over bright imagery, and it is the
  // same grey glass as every other overlay rather than a colour of their own.
  assert.match(attribution, /class="glass"/, 'the credits wear the shared surface');
  const style = rule('#attribution');
  assert.match(style, /position:fixed/);
  assert.match(style, /right:var\(--edge\)/);
  assert.match(style, /bottom:/);
  assert.doesNotMatch(style, /background:/, 'no surface of its own');
  // The provider link wrapped onto a second line, which made the plate two rows tall.
  assert.match(rule('#map-credits .cesium-credit-expand-link'), /white-space:nowrap/, 'the attribution link keeps to one line');
});

test('the map fills the window and nothing reserves a footer strip', () => {
  assert.match(rule('#globe'), /inset:0(?:;|$)/);
  assert.doesNotMatch(css, /--footer-height/);
  assert.doesNotMatch(css, /var\(--footer-height\)/);
  assert.doesNotMatch(html, /footer/i);
});

test('map credits stay attributed but compact', () => {
  assert.match(rule('#map-credits'), /font-size:9px/);
  assert.match(css, /#map-credits \.cesium-credit-logoContainer img\{[^}]*width:\d\dpx/);
  const text = css.match(/#map-credits \.cesium-credit-textContainer\{([^}]+)\}/)?.[1] ?? '';
  assert.doesNotMatch(text, /display:none/, 'provider attribution stays on screen, only smaller');
  assert.match(text, /text-overflow:ellipsis/);
  assert.match(css, /#map-credits \.cesium-credit-expand-link/, 'the full attribution stays one click away');
});

test('panels anchored to the left clear the rail', () => {
  assert.match(css, /--left-offset:var\(--rail-width\)/, 'the shell offset starts at the rail width');
  assert.match(css, /#selection\{[^}]*left:calc\(var\(--left-offset\)/);
  const inspection=readFileSync(new URL('selection_panel.css',web),'utf8');
  assert.match(css, /@import url\("\.\/selection_panel\.css"\)/);
  assert.match(inspection, /#selection\[aria-label\]\{[^}]*translateX\(calc\(-100% - var\(--left-offset\)/);
});

test('the rail, chips and settings share the one translucent surface', () => {
  for (const selector of ['#rail', '#layers', '#settings-panel']) {
    assert.match(html, new RegExp(`id="${selector.slice(1)}"[^>]*class="[^"]*glass`), `${selector} uses the shared glass class`);
  }
  assert.match(rule('.glass'), /background:var\(--panel-glass\)/);
  assert.doesNotMatch(rule('#rail'), /background:#|background:rgb/, 'no separate surface colour for the rail');
});

test('settings opens a panel that holds the display toggles instead of a second copy', () => {
  const panel = element('settings-panel');
  assert.ok(panel);
  assert.match(panel, /hidden/);
  assert.match(app, /\$\('settings'\)\.onclick/);
  assert.match(app, /settings-panel/);
  // The existing toggle elements are moved, so their wiring and state stay single-sourced.
  assert.match(app, /display-settings/);
  for (const id of ['sunlight', 'buildings', 'terrain', 'place-names']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} still exists once in the markup`);
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `${id} is not duplicated`);
  }
});

test('choosing a view that is not built yet says so instead of switching silently', () => {
  assert.match(app, /mode-simulation/);
  assert.match(app, /준비/, 'the unavailable view reports itself');
});
