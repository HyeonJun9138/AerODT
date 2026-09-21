import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement, fakeDocument} from './fake_dom.mjs';
import {SCALE_RANGE, STORAGE_KEY, labelSizeSetting, normalizeScale, readScale, writeScale}
  from '../../../../user_application/web/label_size.js';

const web = new URL('../../../../user_application/web/', import.meta.url);
const app = readFileSync(new URL('app.js', web), 'utf8');
const css = readFileSync(new URL('styles.css', web), 'utf8');

const fakeStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {values, getItem: key => (values.has(key) ? values.get(key) : null), setItem: (key, value) => values.set(key, value)};
};
// A browser with site data blocked: reading and writing both throw.
const blockedStorage = {getItem() {throw new Error('blocked');}, setItem() {throw new Error('blocked');}};

test('a stored size is read back within range, and anything unusable falls back to the design size', () => {
  assert.equal(normalizeScale(120), 120);
  assert.equal(normalizeScale('90'), 90);
  assert.equal(normalizeScale(123), 120, 'a value between steps snaps to one');
  assert.equal(normalizeScale(9999), SCALE_RANGE.max, 'out of range is pulled back, not refused');
  assert.equal(normalizeScale(-40), SCALE_RANGE.min);
  assert.equal(normalizeScale('크게'), SCALE_RANGE.default);
  assert.equal(readScale(fakeStorage()), SCALE_RANGE.default, 'nothing stored: the size the layers were drawn at');
  assert.equal(readScale(fakeStorage({[STORAGE_KEY]: '150'})), 150);
  assert.equal(readScale(fakeStorage({[STORAGE_KEY]: 'x'})), SCALE_RANGE.default);
  assert.equal(readScale(blockedStorage), SCALE_RANGE.default, 'storage that throws still leaves a readable map');
  assert.equal(writeScale(blockedStorage, 120), false, 'and a write that cannot be kept is not an error');
});

test('the setting reports the size as a multiplier, shows it as a percent and keeps it in this browser', () => {
  const applied = [];
  const storage = fakeStorage();
  const setting = labelSizeSetting({document: fakeDocument, storage, apply: scale => applied.push(scale)});
  assert.deepEqual(applied, [1], 'the layers hear the current size as soon as the row is built');
  assert.equal(setting.row.querySelector('span').textContent, '글자 크기');
  assert.match(setting.row.getAttribute('title'), /버티포트와 항로/, 'what it is for, on hover');
  assert.equal(setting.input.getAttribute('type'), 'range');
  assert.deepEqual([setting.input.getAttribute('min'), setting.input.getAttribute('max'), setting.input.getAttribute('step')],
    ['80', '200', '10']);
  assert.equal(setting.row.querySelector('.setting-value').textContent, '100%');
  // Dragging shows the size at once; only letting go writes it down.
  setting.input.value = '140';
  setting.input.oninput();
  assert.deepEqual(applied.at(-1), 1.4);
  assert.equal(setting.row.querySelector('.setting-value').textContent, '140%');
  assert.equal(storage.values.has(STORAGE_KEY), false, 'a drag in progress is not stored');
  setting.input.onchange();
  assert.equal(storage.values.get(STORAGE_KEY), '140');
  // The next visit opens at the size that was left.
  const again = labelSizeSetting({document: fakeDocument, storage, apply: () => {}});
  assert.equal(again.percent, 140);
  assert.equal(again.input.value, '140');
});

test('the page puts the size in the settings panel and hands it to the map, however late the map arrives', () => {
  assert.match(app, /import \{labelSizeSetting\} from '\.\/label_size\.js'/);
  assert.match(app, /const mapLabelSetting=labelSizeSetting\(/);
  assert.match(app, /displaySettings\.append\(mapLabelSetting.row\)/, 'it sits with the other display settings');
  assert.ok(/apply:scale=>\{labelScale=scale;liveGlobe\?\.setLabelScale\(scale\);?\}/.test(app),
    'a change reaches the map that is already there');
  assert.match(app, /globe\.setLabelScale\(labelScale\)/, 'a map created after the setting was read still takes it');
  assert.match(css, /\.setting-row-range input\[type=range\]\{[^}]*flex:1 1 auto/);
});

test('the row is a real element the settings panel can hold', () => {
  const panel = new FakeElement('div');
  const {row} = labelSizeSetting({document: fakeDocument, storage: fakeStorage(), apply: () => {}});
  panel.append(row);
  assert.equal(panel.querySelector('.setting-row-range'), row);
  assert.equal(panel.querySelector('#label-scale').getAttribute('aria-label'), '버티포트와 항로 지점 이름의 글자 크기');
});

test('automatic screen sizing never overwrites a saved size or an active manual drag',()=>{
  const storage=fakeStorage(),applied=[];
  const setting=labelSizeSetting({document:fakeDocument,storage,apply:s=>applied.push(s)});
  setting.recommend(120);assert.equal(setting.percent,120);assert.equal(storage.values.size,0);
  setting.recommend(120);assert.deepEqual(applied,[1,1.2],'unchanged resize does not restyle every label');
  setting.input.value='150';setting.input.oninput();setting.recommend(100);assert.equal(setting.percent,150);
  const saved=labelSizeSetting({document:fakeDocument,storage:fakeStorage({[STORAGE_KEY]:'90'})});
  saved.recommend(120);assert.equal(saved.percent,90);
});
