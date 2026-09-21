// The AeroDT mark on a captured still or a recording, and how much bitrate a
// recording of this canvas is worth.
//
// The mark the operator sees on screen is a DOM image sitting over the map, so
// it is not in the WebGL canvas and nothing taken off that canvas carries it. A
// still or a clip that leaves the app is exactly what somebody else sees, and
// it should say where it came from. So both are composited: the map is drawn
// into a plain 2D canvas, the mark goes on top, and that canvas is what gets
// saved or streamed.
//
// It goes top left because that corner is the app's own — the rail, the layer
// bar — while the bottom right already carries the imagery credits, which are a
// licence obligation and must not be crowded.

export const MARK_URL = '/static/branding/aerodt.png';
// The mark's width as a share of the picture, held between these so it neither
// disappears on a wide capture nor takes over a small one. On screen it is
// about a twentieth of the window, which is where this sits.
export const MARK_WIDTH_SHARE = 0.055;
export const MARK_MIN_PX = 84;
export const MARK_MAX_PX = 260;
// Its inset from the corner, as a share of the shorter side.
export const MARGIN_SHARE = 0.022;
export const MARGIN_MIN_PX = 14;
// Bright terrain under a white mark needs something behind it, and a soft
// shadow does that without a box around the corner of the picture.
export const MARK_OPACITY = 0.92;

// Where the mark goes on a picture this size, and how big it is drawn. The
// aspect comes from the image itself, so replacing the file changes nothing
// here.
export function markLayout(width, height, mark) {
  const short = Math.min(width, height);
  // The natural size, not the size it happens to be shown at: the mark on
  // screen is 74 pixels wide and its aspect must come from the file.
  const natural = mark && {width: mark.naturalWidth || mark.width, height: mark.naturalHeight || mark.height};
  if (!(width > 0) || !(height > 0) || !(natural?.width > 0) || !(natural?.height > 0)) return null;
  const drawn = Math.round(Math.min(MARK_MAX_PX, Math.max(MARK_MIN_PX, width * MARK_WIDTH_SHARE)));
  const margin = Math.round(Math.max(MARGIN_MIN_PX, short * MARGIN_SHARE));
  return {width: drawn, height: Math.round(drawn * natural.height / natural.width), x: margin, y: margin};
}

// What a recording of a canvas this size deserves, in bits a second.
//
// Left alone a browser picks something around 2.5 Mbit for any size at all,
// which on a map full of buildings and terrain turns every camera move into a
// smear. This scales with the pixels actually being encoded — about a tenth of
// a bit per pixel per frame, which is a good working figure for VP9 — and stops
// at a ceiling, because a two-minute clip should not be a hundred-megabyte one.
export const BITS_PER_PIXEL_PER_FRAME = 0.1;
export const MIN_BITRATE = 4e6;
export const MAX_BITRATE = 24e6;

export function recordingBitrate(width, height, fps = 30) {
  const pixels = Math.max(0, width) * Math.max(0, height) * Math.max(1, fps);
  if (!Number.isFinite(pixels) || pixels <= 0) return MIN_BITRATE;
  return Math.round(Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, pixels * BITS_PER_PIXEL_PER_FRAME)));
}

// The mark the page is already showing, if it has finished loading. Using that
// one means a capture carries exactly the mark on screen and waits for nothing.
export function shownMark(documentRef = globalThis.document, selector = '.brand-mark') {
  const image = documentRef?.querySelector?.(selector);
  return image?.complete && image.naturalWidth > 0 ? image : null;
}

// The mark, loaded once. Answers null rather than throwing when it cannot be
// had: a capture without the mark is still a capture, and refusing to save one
// because a logo failed to load would be the wrong trade.
export function loadMark(documentRef = globalThis.document, url = MARK_URL) {
  if (!documentRef?.createElement) return Promise.resolve(null);
  return new Promise(resolve => {
    const image = documentRef.createElement('img');
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.decoding = 'sync';
    image.src = url;
  });
}

// The map, then the mark on top of it. `source` is the scene's own canvas; it
// is drawn to fill the target, so a window resized mid-recording keeps
// producing frames the encoder can use rather than stopping the stream.
export function drawBranded(context, source, mark) {
  if (!context || !source) return false;
  const {width, height} = context.canvas;
  context.clearRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);
  const at = mark && markLayout(width, height, mark);
  if (!at) return true;
  context.save();
  context.globalAlpha = MARK_OPACITY;
  context.shadowColor = 'rgba(4, 12, 18, .55)';
  context.shadowBlur = Math.max(6, Math.round(at.width * 0.08));
  context.drawImage(mark, at.x, at.y, at.width, at.height);
  context.restore();
  return true;
}
