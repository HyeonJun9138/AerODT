import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {providerSetting} from '../../../../user_application/web/provider_settings.js';
import {fakeDocument} from './fake_dom.mjs';

const web = new URL('../../../../user_application/web/', import.meta.url);
const flush = () => new Promise(resolve => setImmediate(resolve));

const choices = [
  {id: 'world_imagery', label: 'Esri World Imagery (전 세계)', note: '지금까지의 영상'},
  {id: 'vworld_satellite', label: '브이월드 위성영상 (국내)', note: '국내만'},
];

test('the row offers what the server describes, at the stored value, and is idle until then', async () => {
  const applied = [];
  const row = providerSetting({document: fakeDocument, id: 'imagery-provider', label: '지도 영상', apply: value => {applied.push(value); return true;}});
  assert.equal(row.select.disabled, true, 'nothing to choose before the server has spoken');
  assert.equal(row.row.querySelector('span').textContent, '지도 영상');
  row.setChoices(choices, 'vworld_satellite');
  assert.equal(row.select.disabled, false);
  assert.equal(row.select.children.length, 2);
  assert.equal(row.select.children[1].attributes.title, '국내만', 'the provider note is on the option');
  assert.equal(row.value, 'vworld_satellite');
  row.select.value = 'world_imagery';
  row.select.onchange();
  await flush();
  assert.deepEqual(applied, ['world_imagery']);
  assert.equal(row.value, 'world_imagery');
  row.select.onchange();
  assert.equal(applied.length, 1, 'the same value again is not sent');
});

test('a refused change goes back to what the server holds', async () => {
  const row = providerSetting({document: fakeDocument, id: 'building-provider', label: '건물 자료', apply: async () => false});
  row.setChoices([{id: 'osm', label: 'OSM'}, {id: 'vworld', label: '브이월드'}], 'osm');
  row.select.value = 'vworld';
  row.select.onchange();
  await flush();
  assert.equal(row.value, 'osm'); assert.equal(row.select.value, 'osm');
  row.setChoices([{id: 'osm', label: 'OSM'}], 'nonsense');
  assert.equal(row.value, 'osm', 'an unknown stored value falls back to the first choice');
});

test('the settings panel holds terrain, imagery and building providers under the map display switches', () => {
  const app = readFileSync(new URL('app.js', web), 'utf8');
  assert.match(app, /providerSetting\(\{document,id:'imagery-provider'/);
  assert.match(app, /providerSetting\(\{document,id:'building-provider'/);
  assert.match(app, /displaySettings\.append\(providerRows\.terrain\.row,providerRows\.imagery\.row,providerRows\.buildings\.row\)/);
  assert.match(app, /libraryPanel\.setField\('imagery','provider',value\)/);
  assert.match(app, /setBuildingsProvider\(values\?\.provider\)/);
  assert.match(app, /setImagerySource\(values\?\.provider\)/);
  assert.match(app, /await libraryPanel\.sync\(\)/, 'stored common settings reach the map after domain choice');
  const css = readFileSync(new URL('styles.css', web), 'utf8');
  assert.match(css, /\.setting-row-select select\{/);
});
