import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeDocument} from './fake_dom.mjs';
import {JoystickSetupPanel} from '../../../../user_application/web/joystick_setup_panel.js';

// The window is built once and kept for the life of the page. Opening it holds
// the aircraft on purpose, and the hold is released by the window's own close --
// so a window that cannot open takes the controls with it and gives nothing
// back. A pilot met exactly that: nothing appeared, nothing could be pressed,
// and only Escape gave the aircraft back.
//
// The fake DOM here is not a browser and does not implement <dialog>; these
// give the one element the three properties the code actually reads, so what is
// being tested is the panel's own decisions rather than the stub's completeness.

function panelOf() {
  const window = {requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}};
  const panel = new JoystickSetupPanel({document: fakeDocument, window,
    storage: {getItem: () => null, setItem() {}}, getGamepads: () => [],
    onApply: () => {}, onSelectPad: () => {}, onClose: () => {}});
  const root = panel.root;
  let open = false, connected = true;
  Object.defineProperty(root, 'isConnected', {get: () => connected, configurable: true});
  Object.defineProperty(root, 'open', {get: () => open, configurable: true});
  root.showModal = () => {open = true;};
  root.close = () => {open = false;};
  const appended = [];
  const body = fakeDocument.body, append = body.append.bind(body);
  body.append = (...nodes) => {appended.push(...nodes); connected = true; return append(...nodes);};
  return {panel, root, appended, detach: () => {connected = false;}, restore: () => {body.append = append;}};
}

test('a window detached by a page rebuild puts itself back rather than failing', () => {
  const {panel, root, appended, detach, restore} = panelOf();
  try {
    detach();
    appended.length = 0;
    panel.open();
    assert.ok(appended.includes(root), '열 때 다시 붙인다');
    assert.equal(root.open, true);
  } finally {restore();}
});

test('a window still attached is not appended a second time', () => {
  const {panel, root, appended, restore} = panelOf();
  try {
    appended.length = 0;
    panel.open();
    assert.equal(appended.includes(root), false, '이미 붙어 있으면 그대로 둔다');
    assert.equal(root.open, true);
  } finally {restore();}
});

test('a modal that refuses to open is reported, not left over the page', () => {
  const {panel, root, restore} = panelOf();
  try {
    // A dialog that accepts showModal but never becomes open: the page's clicks
    // are gone and there is nothing on screen to give them back.
    root.showModal = () => {};
    assert.throws(() => panel.open(), /조이스틱 설정 창을 열지 못했습니다/);
  } finally {restore();}
});

test('somewhere without dialog support is not treated as a failure', () => {
  const {panel, root, restore} = panelOf();
  try {
    root.showModal = undefined;
    panel.open();                        // nothing to assert open, so nothing to refuse
    assert.equal(root.hidden, false, '적어도 감춰두지는 않는다');
  } finally {restore();}
});

test('closing it gives the aircraft back', () => {
  const {panel, root, restore} = panelOf();
  try {
    let closed = 0;
    panel.onClose = () => {closed += 1;};
    panel.open();
    panel.close();
    assert.equal(closed, 1);
    assert.equal(root.open, false);
  } finally {restore();}
});
