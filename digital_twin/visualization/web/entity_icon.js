// Visualization: the small painted glyph an entity is drawn as between "a dot"
// and "a model".
//
// A glTF model is its own primitive: its own draw call, its own shader, its own
// uniforms. Thirty of them are fine and three hundred are not, which is why the
// scene holds only a couple of dozen resident at a time. Below that the choice
// used to be a three-pixel dot, and a dot says nothing about which way an
// aircraft is pointing.
//
// A billboard sits between the two. A whole collection of them is one draw call
// whatever the count, so hundreds cost about what one costs, and a glyph turned
// to the heading reads as traffic rather than as confetti.
//
// It is a screen-space icon and not an attitude: it is turned by the heading
// alone, with no pitch or roll and no perspective. At the distance a billboard
// is chosen for, that is what every traffic display draws.

// Painted at this many device pixels across and drawn smaller; a glyph scaled
// down reads cleanly, one scaled up does not.
export const ICON_PIXELS = 64;
// How wide the glyph is drawn on screen, before the near/far scale.
export const ICON_SIZE_PX = 18;

// The shapes, in a -1..1 box with the nose at -1 on the vertical axis, so a
// rotation of zero points up the screen and north.
const SHAPES = {
  // A delta with a notched tail: an aircraft at a glance, and still legible at
  // eight pixels where a silhouette with wings is mush.
  aircraft: [[0, -1], [0.72, 0.62], [0, 0.28], [-0.72, 0.62]],
  // Squarer and stubbier: a rotorcraft is not an airliner, and the two are on
  // the same map.
  uam: [[0, -0.92], [0.62, 0.34], [0.34, 0.72], [-0.34, 0.72], [-0.62, 0.34]],
  // A satellite has no heading worth drawing, so it gets a mark rather than a
  // pointer: a diamond reads the same whichever way it is turned.
  satellite: [[0, -0.8], [0.8, 0], [0, 0.8], [-0.8, 0]],
};
export const ICON_KINDS = Object.freeze(Object.keys(SHAPES));
// Whether the glyph means anything when it is turned. A satellite's does not.
export function turns(kind) {return kind !== 'satellite';}

// One canvas per kind, painted once and shared by every billboard of that kind.
// `createCanvas` is injected so this can be drawn and checked without a browser.
export function paintIcon(kind, colorCss, createCanvas = (w, h) => Object.assign(document.createElement('canvas'), {width: w, height: h})) {
  const points = SHAPES[kind] ?? SHAPES.aircraft;
  const canvas = createCanvas(ICON_PIXELS, ICON_PIXELS);
  const context = canvas.getContext('2d');
  const half = ICON_PIXELS / 2, radius = half * 0.86;
  context.clearRect(0, 0, ICON_PIXELS, ICON_PIXELS);
  context.beginPath();
  points.forEach(([x, y], index) => {
    const at = [half + x * radius, half + y * radius];
    if (index === 0) context.moveTo(at[0], at[1]); else context.lineTo(at[0], at[1]);
  });
  context.closePath();
  context.fillStyle = colorCss;
  context.fill();
  // A dark edge, because the glyph is drawn over water, city and cloud alike and
  // a fill alone disappears into the pale ones.
  context.lineWidth = Math.max(1.5, ICON_PIXELS / 26);
  context.strokeStyle = 'rgba(8,18,26,.85)';
  context.stroke();
  return canvas;
}

// Cesium turns a billboard anticlockwise in screen space; a heading is degrees
// clockwise from north. The glyph is painted nose-up, so the rotation is the
// heading negated. An entity with no heading worth drawing is left square on.
export function iconRotation(kind, headingDeg) {
  if (!turns(kind) || !Number.isFinite(headingDeg) || headingDeg === 0) return 0;
  return -headingDeg * Math.PI / 180;
}
