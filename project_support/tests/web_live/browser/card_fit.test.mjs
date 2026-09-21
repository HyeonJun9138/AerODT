// The two cards that open beside the pointer stay inside the window by their
// real height, not by a guess. A tools card with a look and a delete in it, or
// a link card with a long form, ran off the bottom of the screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PlaceMenu} from '../../../../user_application/web/place_menu.js';
import {RouteCard} from '../../../../user_application/web/domains/uam/planning/route_card.js';
import {FakeElement, fakeDocument} from './fake_dom.mjs';

// A mount that gives whatever is appended to it a measured size, the way the
// page does once a card is in it.
function mountMeasuring(height, width = 232) {
  const mount = new FakeElement('body');
  const original = mount.append.bind(mount);
  mount.append = (...nodes) => {for (const node of nodes) node.getBoundingClientRect = () => ({height, width, top: 0, left: 0});
    return original(...nodes);};
  return mount;
}

test('the tools card is pushed up to stay inside a short window once its real height is known', () => {
  const mount = mountMeasuring(520);
  const menu = new PlaceMenu({document: fakeDocument, mount, viewport: () => ({width: 1200, height: 700})});
  const card = menu.open({screen: {x: 300, y: 600}, values: {platform_height_m: 12, heading_deg: 0, fato_count: 2}, options: {}, limits: {},
    actions: [new FakeElement('button')]});
  // Anchored at y 600 with a 520 px card in a 700 px window: top = 700 - 520 - 10.
  assert.equal(card.style.top, '170px');
  assert.equal(card.style.left, '310px');
  assert.ok(card.querySelector('.place-extra'), 'the extra actions are in the card');
  menu.close();
});

test('with no measurement yet the guess still keeps the card on screen', () => {
  const menu = new PlaceMenu({document: fakeDocument, mount: new FakeElement('body'), viewport: () => ({width: 1200, height: 400})});
  const card = menu.open({screen: {x: 0, y: 380}, values: {}, options: {}, limits: {}});
  assert.equal(card.style.top, '50px', '400 - 340 - 10');
  menu.close();
});

test('the link card is fitted the same way, and re-fitted when the window changes size', () => {
  const mount = mountMeasuring(600, 248);
  let resize = null;
  const view = {innerWidth: 1000, innerHeight: 800, addEventListener: (name, fn) => {if (name === 'resize') resize = fn;}, removeEventListener: () => {resize = null;}};
  const document = {...fakeDocument, defaultView: view};
  const card = new RouteCard({document, mount, viewport: () => ({width: view.innerWidth, height: view.innerHeight})});
  const root = card.open({screen: {x: 900, y: 700}, title: 't'}, new FakeElement('p'));
  assert.equal(root.style.top, '190px', '800 - 600 - 10');
  assert.equal(root.style.left, '742px', '1000 - 248 - 10');
  assert.equal(typeof resize, 'function', 'listening for the window to change');
  view.innerHeight = 650; resize();
  assert.equal(root.style.top, '40px', 'pushed up again for the shorter window');
  card.close();
  assert.equal(resize, null, 'and let go on close');
});
