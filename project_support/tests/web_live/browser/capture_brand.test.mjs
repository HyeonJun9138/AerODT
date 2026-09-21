// The mark on a saved picture, and what a recording of a canvas is worth.
import test from 'node:test';
import assert from 'node:assert/strict';
import {BITS_PER_PIXEL_PER_FRAME, MARK_MAX_PX, MARK_MIN_PX, MARK_OPACITY, MARK_URL, MARK_WIDTH_SHARE,
  MAX_BITRATE, MIN_BITRATE, drawBranded, loadMark, markLayout, recordingBitrate, shownMark}
  from '../../../../digital_twin/visualization/web/capture_brand.js';

// The real mark, at the size the file actually is.
const MARK = {naturalWidth: 1520, naturalHeight: 508};

test('the mark sits in the top-left corner, off the edge, and keeps its shape', () => {
  const at = markLayout(1920, 1080, MARK);
  assert.ok(at.x > 0 && at.y > 0, 'inset from the corner, not jammed into it');
  assert.equal(at.x, at.y, 'the same inset both ways');
  assert.ok(at.x < 1920 * .05 && at.y < 1080 * .05, 'and it really is the corner');
  // The aspect is the file's, whatever size it is drawn at.
  assert.equal(Math.round(at.width / at.height), Math.round(1520 / 508));
  assert.equal(at.width, Math.round(1920 * MARK_WIDTH_SHARE));
  // It never leaves the picture.
  assert.ok(at.x + at.width < 1920 && at.y + at.height < 1080);
});

test('it stays legible on a small picture and stays modest on a huge one', () => {
  assert.equal(markLayout(640, 360, MARK).width, MARK_MIN_PX, 'a small capture still shows it');
  assert.equal(markLayout(7680, 4320, MARK).width, MARK_MAX_PX, 'a huge one is not taken over by it');
  // In between it grows with the picture.
  const widths = [1280, 1920, 2560].map(w => markLayout(w, w * 9 / 16, MARK).width);
  assert.deepEqual(widths, [...widths].sort((a, b) => a - b));
  assert.ok(new Set(widths).size === widths.length, 'and every size differs');
});

test('a picture with no mark to draw is still a picture', () => {
  assert.equal(markLayout(1920, 1080, null), null);
  assert.equal(markLayout(1920, 1080, {naturalWidth: 0, naturalHeight: 0}), null);
  assert.equal(markLayout(0, 0, MARK), null);
  assert.equal(markLayout(1920, 0, MARK), null);
  // An image element already on the page reports its rendered size too; the
  // natural one is what the shape must come from.
  const shown = {naturalWidth: 1520, naturalHeight: 508, width: 74, height: 25};
  assert.deepEqual(markLayout(1920, 1080, shown), markLayout(1920, 1080, MARK));
});

test('the map is drawn first and the mark over it, and neither is stretched', () => {
  const calls = [];
  // save/restore really save and restore, the way a canvas context does, so the
  // last assertion is about the code rather than about this stub.
  const saved = [];
  const state = ['globalAlpha', 'shadowColor', 'shadowBlur'];
  const context = {
    canvas: {width: 1920, height: 1080}, globalAlpha: 1, shadowColor: '', shadowBlur: 0,
    clearRect: (...a) => calls.push(['clear', ...a]),
    drawImage: (...a) => calls.push(['draw', a[0], ...a.slice(1)]),
    save() {calls.push(['save']); saved.push(Object.fromEntries(state.map(key => [key, this[key]])));},
    restore() {calls.push(['restore']); Object.assign(this, saved.pop());},
  };
  const source = {width: 1920, height: 1080};
  assert.equal(drawBranded(context, source, MARK), true);
  const draws = calls.filter(call => call[0] === 'draw');
  assert.equal(draws.length, 2);
  assert.equal(draws[0][1], source, 'the map goes down first');
  assert.deepEqual(draws[0].slice(2), [0, 0, 1920, 1080], 'filling the frame');
  assert.equal(draws[1][1], MARK, 'and the mark on top of it');
  const at = markLayout(1920, 1080, MARK);
  assert.deepEqual(draws[1].slice(2), [at.x, at.y, at.width, at.height]);
  // The mark's own drawing state is put back, so nothing after it is faded.
  assert.equal(calls.filter(c => c[0] === 'save').length, 1);
  assert.equal(calls.filter(c => c[0] === 'restore').length, 1);
  assert.equal(context.globalAlpha, 1, 'the context is left as it was found');
  assert.ok(MARK_OPACITY > .8 && MARK_OPACITY <= 1);
});

test('a frame whose map is a different size is scaled rather than dropped', () => {
  // A window resized mid-recording must keep producing frames the encoder can
  // use; stopping the stream would end the recording.
  const draws = [];
  const context = {canvas: {width: 1920, height: 1080}, clearRect: () => {},
    drawImage: (...a) => draws.push(a), save: () => {}, restore: () => {}};
  assert.equal(drawBranded(context, {width: 1280, height: 720}, null), true);
  assert.deepEqual(draws[0].slice(1), [0, 0, 1920, 1080]);
  assert.equal(drawBranded(null, {width: 8, height: 8}, MARK), false, 'no context, no frame');
  assert.equal(drawBranded(context, null, MARK), false, 'and no map, no frame');
});

test('a recording is worth the pixels it is made of, between a floor and a ceiling', () => {
  // Left alone a browser picks about 2.5 Mbit whatever the size; every one of
  // these is above that.
  assert.ok(recordingBitrate(1920, 1080, 30) > 2.5e6);
  assert.equal(recordingBitrate(1920, 1080, 30), Math.round(1920 * 1080 * 30 * BITS_PER_PIXEL_PER_FRAME));
  assert.ok(recordingBitrate(2560, 1440, 30) > recordingBitrate(1920, 1080, 30), 'more pixels, more bits');
  // A tiny window still gets something usable, and a 4K one stops at the cap so
  // two minutes is not a hundred megabytes.
  assert.equal(recordingBitrate(320, 180, 30), MIN_BITRATE);
  assert.equal(recordingBitrate(3840, 2160, 30), MAX_BITRATE);
  assert.equal(recordingBitrate(0, 0, 30), MIN_BITRATE);
  assert.equal(recordingBitrate(NaN, 1080, 30), MIN_BITRATE);
  // Two minutes at the ceiling, in megabytes: large, but a file you can send.
  assert.ok(MAX_BITRATE * 120 / 8 / 1e6 < 400);
});

test('the mark on the page is the one used, and a page without one still gets it', async () => {
  const ready = {complete: true, naturalWidth: 1520, naturalHeight: 508};
  assert.equal(shownMark({querySelector: () => ready}), ready);
  assert.equal(shownMark({querySelector: () => ({complete: false, naturalWidth: 1520})}), null,
    'one still loading is not used');
  assert.equal(shownMark({querySelector: () => ({complete: true, naturalWidth: 0})}), null,
    'nor one that failed');
  assert.equal(shownMark({}), null);
  assert.equal(shownMark(null), null);
  // The fallback load answers null rather than throwing, so a capture is never
  // refused because a logo could not be had.
  assert.equal(await loadMark(null), null);
  const created = [];
  const image = {};
  const failed = loadMark({createElement: tag => {created.push(tag); return image;}});
  image.onerror();
  assert.equal(await failed, null);
  assert.deepEqual(created, ['img']);
  assert.equal(image.src, MARK_URL);
});
