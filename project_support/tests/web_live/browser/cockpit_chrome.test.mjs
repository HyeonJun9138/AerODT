// The two ways the cockpit was crowding the map's own chrome: a second Cesium
// widget printing its credits into the plate that already carried them, and the
// projected instruments painting over the controls that move the map beneath.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const camera = readFileSync('digital_twin/visualization/web/airframe_camera.js', 'utf-8');
const styles = readFileSync('user_application/web/styles.css', 'utf-8');
const cockpit = readFileSync('user_application/web/cockpit_avionics.css', 'utf-8');
const page = readFileSync('user_application/web/index.html', 'utf-8');

// Comments are stripped first: a rule explaining itself above its selector is
// still that rule, and the reader of this test should not have to know that.
const bare = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const ruleFor = (css, selector) =>
  bare(css).split(/}\s*/).find(block => block.trimStart().startsWith(selector));
const layer = (css, selector) => {
  const found = /z-index:\s*(-?\d+)/.exec(ruleFor(css, selector) ?? '');
  return found ? Number(found[1]) : null;
};

test('the external view keeps its credits out of the map\'s credit plate', () => {
  // Both widgets draw the same imagery, so the map's plate already carries every
  // attribution owed; pointing the second one at it printed the Cesium mark and
  // the data link twice, side by side, which reads as a bug not as a credit.
  assert.match(camera, /this\.credits=doc\.createElement\('div'\)/);
  assert.match(camera, /this\.host\.append\(this\.credits\)/,
    'inside the offscreen host, so it is still rendered and still inspectable');
  assert.match(camera, /creditContainer:this\.credits/);
  assert.doesNotMatch(camera, /creditContainer:source\./,
    'the main viewer\'s container must not be handed out again');
});

test('the offscreen host goes away with the camera, and its credits with it', () => {
  const stop = camera.slice(camera.indexOf('stop(){'), camera.indexOf('destroy(){'));
  assert.match(stop, /this\.host\?\.remove\(\)/);
  assert.match(stop, /this\.credits=null/);
});

test('the map controls sit above the projected instruments and the credit plate', () => {
  // The instruments are a read-only overlay; these are the controls that move
  // the map under them. Chrome you operate goes over chrome you read.
  const controls = layer(styles, '#camera{');
  const plate = layer(styles, '#attribution{');
  const projected = layer(cockpit, '.cockpit-instruments.cockpit-projected{');
  assert.ok(Number.isInteger(controls), '#camera must declare a layer rather than inherit one');
  assert.ok(Number.isInteger(projected) && Number.isInteger(plate));
  assert.ok(controls > projected, `map controls ${controls} must beat instruments ${projected}`);
  assert.ok(controls > plate, `map controls ${controls} must beat the credit plate ${plate}`);
});

test('the projected instruments stay under the panels and never swallow a click', () => {
  const rule = ruleFor(cockpit, '.cockpit-instruments.cockpit-projected{');
  assert.match(rule, /pointer-events:\s*none/);
  // Every drawer and window in the app sits at 5 or above; the overlay must not
  // climb into that band or it covers the screens the operator is working in.
  assert.ok(layer(cockpit, '.cockpit-instruments.cockpit-projected{') < 5);
});

test('there is exactly one visible credit plate on the page', () => {
  assert.equal((page.match(/id="map-credits"/g) ?? []).length, 1);
  // The preview's own container is on the page but hidden, which is what keeps
  // the model preview from adding a second row of marks.
  const preview = /<div id="preview-credits"([^>]*)>/.exec(page);
  assert.ok(preview && preview[1].includes('hidden'));
});
