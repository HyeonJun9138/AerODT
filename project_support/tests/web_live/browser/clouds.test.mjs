import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CLOUD_SOURCES, CloudLayer, gibsTileUrl, tilingFor, versionFor} from '../../../../digital_twin/visualization/web/cloud_layer.js';

const web = new URL('../../../../user_application/web/', import.meta.url);
const html = readFileSync(new URL('index.html', web), 'utf8');
const app = readFileSync(new URL('app.js', web), 'utf8');

// GIBS EPSG:4326 is not a clean quad tree: its levels run 2x1, 3x2, 5x3, 10x5,
// 20x10, 40x20. Only from 10x5 does it double, so that is where a Cesium
// tiling scheme can start.
test('the tiling starts where GIBS starts doubling, and levels are offset to match', () => {
  const tiling = tilingFor(CLOUD_SOURCES.himawari_visible);
  assert.deepEqual([tiling.numberOfLevelZeroTilesX, tiling.numberOfLevelZeroTilesY], [10, 5]);
  assert.equal(tiling.levelOffset, 3, 'Cesium level 0 is GIBS level 3');
  assert.equal(tiling.maximumLevel, 3, 'the 1 km set ends at GIBS level 6');
  assert.equal(tilingFor(CLOUD_SOURCES.modis).maximumLevel, 2);
});

test('a tile address becomes the GIBS path for the chosen layer and time', () => {
  const url = gibsTileUrl(CLOUD_SOURCES.himawari_visible, {level: 0, x: 8, y: 1, time: '2026-09-09T07:30:00Z'});
  assert.equal(url, 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/Himawari_AHI_Band3_Red_Visible_1km/default/2026-09-09T07:30:00Z/1km/3/1/8.png',
    'row before column, and the level is offset');
  assert.match(gibsTileUrl(CLOUD_SOURCES.modis, {level: 2, x: 3, y: 2}), /MODIS_Terra_Cloud_Fraction_Day\/default\/default\/2km\/5\/2\/3\.png$/,
    'without a time the layer default is used');
  assert.equal(CLOUD_SOURCES.himawari_visible.cadence_seconds, 600, 'the geostationary layer is a ten minute product');
  assert.equal(CLOUD_SOURCES.himawari_visible.keyDark, true, 'visible light is keyed so only cloud is left');
  assert.equal(CLOUD_SOURCES.himawari_infrared.keyDark, true, 'infrared is greyed and keyed the same way');
  assert.ok(CLOUD_SOURCES.modis.cadence_seconds >= 3600, 'the global composite is daily, so it is not fetched often');
});

// GIBS publishes a slot minutes after it exists, so a computed timestamp can be
// a 404. Asking for the layer default always resolves to the newest published
// image; a version that only changes on the cadence keeps tiles cacheable.
test('the newest published image is asked for, and only the cadence busts the cache', () => {
  const early = versionFor(CLOUD_SOURCES.himawari_visible, Date.parse('2026-09-09T08:12:00Z'));
  const later = versionFor(CLOUD_SOURCES.himawari_visible, Date.parse('2026-09-09T08:19:00Z'));
  const next = versionFor(CLOUD_SOURCES.himawari_visible, Date.parse('2026-09-09T08:21:00Z'));
  assert.equal(early, later, 'inside one ten minute window the address does not move');
  assert.notEqual(later, next, 'the next window is a new address');
  assert.match(gibsTileUrl(CLOUD_SOURCES.himawari_visible, {level: 0, x: 8, y: 1}), /\/default\/default\//,
    'no computed timestamp: GIBS resolves the newest itself');
});

class Layers {
  values = [];
  add(layer) {this.values.push(layer); return layer;}
  remove(layer) {this.values = this.values.filter(item => item !== layer); return true;}
  raiseToTop(layer) {this.values = [...this.values.filter(item => item !== layer), layer];}
}
function harness() {
  const created = [];
  const C = {
    UrlTemplateImageryProvider: class {constructor(options) {Object.assign(this, options); created.push(this);}},
    GeographicTilingScheme: class {constructor(options) {Object.assign(this, options);}},
    ImageryLayer: class {constructor(provider, options) {Object.assign(this, {provider, ...options});}},
    Color: {BLACK: 'black'},
    Rectangle: {fromDegrees: (west, south, east, north) => ({west, south, east, north})},
    Credit: class {constructor(text) {this.text = text;}},
  };
  const layers = new Layers();
  const viewer = {imageryLayers: layers, scene: {requestRender() {}}};
  return {C, viewer, layers, created};
}

test('each product carries how it should be blended, and a geostationary one is not asked for outside its disk', () => {
  for (const source of Object.values(CLOUD_SOURCES)) {
    assert.ok(source.display.alpha > 0 && source.display.alpha <= 1, `${source.id} has an opacity`);
    assert.equal(source.display.saturation, 0, `${source.id} is drawn as grey cloud, not a colour wash`);
    assert.ok(source.display.contrast >= 1, `${source.id} lifts cloud away from the background`);
  }
  const disk = CLOUD_SOURCES.himawari_infrared.coverage;
  assert.ok(disk, 'a geostationary product states what it can see');
  assert.ok(disk.west > 40 && disk.east <= 180, 'so no tile is requested for the far side of the world');
  assert.equal(CLOUD_SOURCES.modis.coverage, undefined, 'the global composite has no such limit');
});

test('the layer only exists while it is shown, and shows the source that was chosen', () => {
  const {C, viewer, layers, created} = harness();
  const clouds = new CloudLayer(C, viewer);
  assert.equal(layers.values.length, 0, 'nothing is requested until it is turned on');
  clouds.apply({enabled: true, source: 'himawari_visible', opacity: 0.6});
  assert.equal(layers.values.length, 1);
  assert.equal(created.length, 1);
  assert.match(created[0].url, /Himawari_AHI_Band3_Red_Visible_1km/);
  assert.equal(layers.values[0].alpha, 0.6);
  assert.equal(layers.values[0].colorToAlpha, 'black', 'the dark background is dropped so only cloud remains');
  assert.equal(layers.values[0].saturation, 0, 'and what is left is grey cloud');
  assert.equal(layers.values[0].contrast, CLOUD_SOURCES.himawari_visible.display.contrast);
  assert.ok(created[0].rectangle, 'the request is limited to what the satellite sees');
  clouds.apply({enabled: true, source: 'himawari_visible', opacity: 0.3});
  assert.equal(created.length, 1, 'a different opacity does not refetch the imagery');
  assert.equal(layers.values[0].alpha, 0.3);
  clouds.apply({enabled: true, source: 'modis', opacity: 0.3});
  assert.equal(created.length, 2, 'a different source is a different provider');
  assert.equal(layers.values.length, 1, 'and replaces the old one rather than stacking');
  assert.match(created[1].url, /MODIS_Terra_Cloud_Fraction_Day/);
  clouds.apply({enabled: false, source: 'modis', opacity: 0.3});
  assert.equal(layers.values.length, 0, 'turning it off removes it, so no tiles are requested');
  clouds.destroy();
  assert.equal(layers.values.length, 0);
});

test('a refresh re-reads the layer time only while it is shown', () => {
  const {C, viewer, layers, created} = harness();
  const clouds = new CloudLayer(C, viewer);
  clouds.refresh();
  assert.equal(created.length, 0, 'nothing to refresh while it is off');
  clouds.apply({enabled: true, source: 'himawari_visible', opacity: .6});
  clouds.refresh();
  assert.equal(created.length, 2, 'the ten minute product is re-requested');
  assert.equal(layers.values.length, 1);
});

test('the map settings offer clouds beside the other display toggles', () => {
  const settings = html.match(/<section\b[^>]*\bid="settings-panel"[\s\S]*?<\/section>/)?.[0] ?? html;
  assert.match(settings + html, /id="clouds"/, 'a clouds button exists');
  const button = html.match(/<button\b[^>]*\bid="clouds"[\s\S]*?<\/button>/)?.[0] ?? '';
  assert.match(button, /aria-pressed/);
  assert.match(button, /aria-label="[^"]*구름[^"]*"/);
  assert.match(app, /'sunlight','buildings','terrain','place-names','airspace','clouds'/, 'it is placed with the other display toggles');
  assert.match(app, /setCloudSettings/, 'and drives the map');
  assert.match(app, /livePanel\.setField\('clouds','enabled',enabled\)/, 'the owning panel applies the local display settings');
});
