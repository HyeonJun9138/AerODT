import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement, fakeDocument} from './fake_dom.mjs';
import {ModelLibrary, describeModel, groupModels, modelFacts} from '../../../../user_application/web/model_library.js';

const web = new URL('../../../../user_application/web/', import.meta.url);
const styles = readFileSync(new URL('styles.css', web), 'utf8');
const app = readFileSync(new URL('app.js', web), 'utf8');

const catalog = {
  schema_version: 1,
  assets: [
    {asset_id: 'kp2a', kind: 'aircraft', title: 'KP-2A UAM airframe', size_m: 10.177,
     uri: '/visual-assets/aircraft/civilian/kp2a/model.glb',
     thumbnail: '/visual-assets/aircraft/civilian/kp2a/thumbnail.jpg',
     attribution: 'AeroDT operator; operator-owned; '},
    {asset_id: 'projectairsim_airtaxi', kind: 'aircraft', title: 'ProjectAirSim AirTaxi', size_m: 8.12,
     uri: '/visual-assets/aircraft/civilian/projectairsim_airtaxi/model.glb',
     thumbnail: '/visual-assets/aircraft/civilian/projectairsim_airtaxi/thumbnail.jpg',
     attribution: 'Microsoft Corporation; MIT; https://example.test/licence'},
    {asset_id: 'aqua', kind: 'satellite', title: 'Aqua', size_m: 16.7,
     uri: '/visual-assets/spacecraft/satellites/aqua/model.glb',
     thumbnail: '/visual-assets/spacecraft/satellites/aqua/thumbnail.jpg',
     attribution: 'NASA'},
    // No picture: browsing it would open an empty frame.
    {asset_id: 'generic_aircraft', kind: 'aircraft', title: '대체 형상', size_m: 32,
     uri: '/visual-assets/procedural/generic.glb', attribution: ''},
  ],
};

function el(tag, props = {}, ...children) {
  const node = fakeDocument.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name.startsWith('on')) node[name] = value;
    else if (value !== undefined && value !== null) node.setAttribute(name, value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

const build = () => {
  const shelf = new ModelLibrary({el, document: fakeDocument});
  shelf.setCatalog(catalog);
  const root = new FakeElement('section');
  shelf.render(root);
  return {shelf, root};
};

test('only models that actually have a picture are shelved, sorted by name', () => {
  const groups = groupModels(catalog);
  assert.deepEqual(groups.get('aircraft').map(a => a.asset_id), ['kp2a', 'projectairsim_airtaxi']);
  assert.deepEqual(groups.get('satellite').map(a => a.asset_id), ['aqua']);
});

test('all eleven acquired people appear in their own shelf with thumbnails', () => {
  const library = new URL('../../../../digital_twin/model_library/visual_assets/', import.meta.url);
  const acquired = JSON.parse(readFileSync(new URL('web_catalog.json', library), 'utf8'));
  const people = acquired.assets.filter(a => a.category === 'people/civilian').map(a => ({
    ...a, kind: 'person', thumbnail: '/visual-assets/' + a.thumbnail, size_m: 2.7,
  }));
  assert.equal(people.length, 11);
  const shelf = new ModelLibrary({el, document: fakeDocument});
  shelf.setCatalog({assets: people});
  const root = new FakeElement('section');
  shelf.render(root);
  const head = root.querySelector('#model-group-person-head');
  assert.match(head.textContent, /사람 \/ 승객/);
  assert.match(head.textContent, /11개/);
  head.click();
  assert.equal(root.querySelectorAll('.model-item').length, 11);
  root.querySelector(`#model-item-${people[0].asset_id}`).click();
  assert.ok(root.querySelector(`#model-photo-${people[0].asset_id}`).querySelector('img'));
  assert.match(describeModel(people[0]), /인체 크기 미보정/);
  assert.doesNotMatch(describeModel(people[0]), /2\.7 m/);
});

test('the shelf opens closed so the sources above stay visible', () => {
  const {root} = build();
  for (const id of ['aircraft', 'satellite']) {
    assert.equal(root.querySelector(`#model-group-${id}-head`).getAttribute('aria-expanded'), 'false');
    assert.equal(root.querySelector(`#model-group-${id}-body`).hidden, true);
  }
  // Nothing is listed until a group is opened, so the panel keeps its height.
  assert.equal(root.querySelectorAll('.model-item').length, 0);
});

test('opening a group lists its models and reports how many there are', () => {
  const {root} = build();
  assert.equal(root.querySelector('#model-group-aircraft-head').textContent.includes('2개'), true);
  root.querySelector('#model-group-aircraft-head').click();
  assert.equal(root.querySelector('#model-group-aircraft-body').hidden, false);
  assert.deepEqual(root.querySelectorAll('.model-item').map(node => node.textContent),
    ['KP-2A UAM airframe', 'ProjectAirSim AirTaxi']);
  // The other kind stays closed.
  assert.equal(root.querySelector('#model-group-satellite-body').hidden, true);
});

test('picking a model shows its picture, and only one at a time', () => {
  const {root, shelf} = build();
  root.querySelector('#model-group-aircraft-head').click();
  root.querySelector('#model-item-kp2a').click();
  const picture = root.querySelector('#model-photo-kp2a');
  const image = picture.querySelector('img');
  assert.equal(image.getAttribute('src'), '/visual-assets/aircraft/civilian/kp2a/thumbnail.jpg');
  // Never lazy: the image is only built when its row is open, and a lazy image
  // inside the panel's own scroller stayed blank.
  assert.equal(image.getAttribute('loading'), null);
  assert.match(image.getAttribute('alt'), /KP-2A/);
  // A closed row carries no picture at all, so nothing is fetched for it.
  assert.equal(root.querySelector('#model-photo-projectairsim_airtaxi'), null);

  root.querySelector('#model-item-projectairsim_airtaxi').click();
  assert.equal(root.querySelector('#model-photo-kp2a'), null);
  assert.ok(root.querySelector('#model-photo-projectairsim_airtaxi'));
});

test('picking the open model again puts the picture away', () => {
  const {root} = build();
  root.querySelector('#model-group-aircraft-head').click();
  root.querySelector('#model-item-kp2a').click();
  assert.ok(root.querySelector('#model-photo-kp2a'));
  root.querySelector('#model-item-kp2a').click();
  assert.equal(root.querySelector('#model-photo-kp2a'), null);
  assert.equal(root.querySelector('#model-item-kp2a').getAttribute('aria-expanded'), 'false');
});

test('opening a model brings the view to its picture', () => {
  const {root, shelf} = build();
  root.querySelector('#model-group-aircraft-head').click();
  const revealed = [];
  shelf.reveal = id => revealed.push(id);
  root.querySelector('#model-item-kp2a').click();
  assert.deepEqual(revealed, ['kp2a']);
  // Closing scrolls nowhere; there is nothing to look at.
  root.querySelector('#model-item-kp2a').click();
  assert.deepEqual(revealed, ['kp2a']);
});

test('the caption is the size and the credit, and the credit is the licence link', () => {
  // The picture is the point of the shelf, so the caption carries only what is
  // scanned off one line: how big it is, and on whose terms it may be used.
  const facts = modelFacts(catalog.assets[1]);
  assert.equal(facts.text, '8.1 m');
  assert.equal(facts.rights, 'Microsoft Corporation · MIT');
  assert.equal(facts.url, 'https://example.test/licence');
  // A trailing empty field from the projection must not leave a dangling mark.
  assert.equal(describeModel(catalog.assets[0]), '10.2 m · AeroDT operator · operator-owned');

  const {root} = build();
  root.querySelector('#model-group-aircraft-head').click();
  root.querySelector('#model-item-projectairsim_airtaxi').click();
  const link = root.querySelector('.model-licence');
  assert.equal(link.getAttribute('href'), 'https://example.test/licence');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  // Credit is owed whether or not there is a page to point at, so it is still
  // shown when the projection carries no URL -- as text rather than a link.
  assert.match(link.textContent, /Microsoft Corporation/);
});

test('a thumbnail that will not load says so instead of leaving a gap', () => {
  const {root} = build();
  root.querySelector('#model-group-aircraft-head').click();
  root.querySelector('#model-item-kp2a').click();
  const figure = root.querySelector('#model-photo-kp2a');
  const image = figure.querySelector('img');
  image.onerror();
  assert.equal(image.hidden, true);
  assert.match(figure.textContent, /불러오지 못했습니다/);
});

test('before the catalogue arrives the shelf says so instead of looking empty', () => {
  const shelf = new ModelLibrary({el, document: fakeDocument});
  const root = new FakeElement('section');
  shelf.render(root);
  assert.match(root.textContent, /불러오는 중/);
  shelf.setCatalog(catalog);
  assert.equal(root.querySelectorAll('.model-group').length, 3);
});

test('the shelf fetches the inventory itself and offers a way back when it cannot', async () => {
  // The inventory does not depend on the globe, but it used to arrive only on
  // the map's boot path: a map that failed to start left the Library saying
  // "loading" for the rest of the session, with nothing to press.
  let calls = 0;
  const shelf = new ModelLibrary({el, document: fakeDocument, load: async () => {calls++; return catalog;}});
  const root = new FakeElement('section');
  shelf.render(root);
  assert.match(root.textContent, /불러오는 중/);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 1, 'asked for it once, unprompted');
  assert.equal(root.querySelectorAll('.model-group').length, 3);
  shelf.render(root);
  assert.equal(calls, 1, 'and not again on every redraw');

  let failing = true;
  const broken = new ModelLibrary({el, document: fakeDocument,
    load: async () => {calls++; if (failing) throw new Error('offline'); return catalog;}});
  const other = new FakeElement('section');
  broken.render(other);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.match(other.textContent, /불러오지 못했습니다/);
  assert.doesNotMatch(other.textContent, /불러오는 중/, 'a failure is not still "loading"');
  failing = false;
  other.querySelector('#model-retry').click();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(other.querySelectorAll('.model-group').length, 3, 'retry brings the shelf back');
});

test('being told the catalogue failed is not the same as not having been told', () => {
  const shelf = new ModelLibrary({el, document: fakeDocument});
  const root = new FakeElement('section');
  shelf.setCatalog(null);
  shelf.render(root);
  assert.match(root.textContent, /불러오지 못했습니다/);
  assert.match(readFileSync(new URL('app.js', web), 'utf8'), /libraryPanel\.setModels\(null\)/);
});

test('the app hands the catalogue to the panel and the shelf is styled', () => {
  assert.match(app, /libraryPanel\.setModels\(\{\.\.\.results\[0\]\.value,assets:results\[0\]\.value\.assets\.filter\(a=>a\.kind!=='satellite'\)\}\)/);
  assert.match(app, /new ModelLibrary\(/);
  // An opened list scrolls inside itself rather than pushing the panel down.
  assert.match(styles, /\.model-list\{[^}]*overflow-y:auto/);
  // The picture takes the panel's whole width in a wide frame: it is the thing
  // the shelf exists to show, not a stamp beside a paragraph.
  assert.match(styles, /\.model-photo img\{[^}]*width:100%/);
  assert.doesNotMatch(styles, /\.model-photo img\{[^}]*max-width:\d/);
  const aspect = styles.match(/\.model-photo img\{[^}]*aspect-ratio:([\d.]+)/);
  assert.ok(aspect && Number(aspect[1]) >= 1.5, 'a wide frame, not a postcard');
  // And one quiet line under it, on a single row that truncates.
  assert.match(styles, /\.model-licence,\.model-rights\{[^}]*text-overflow:ellipsis/);
});
