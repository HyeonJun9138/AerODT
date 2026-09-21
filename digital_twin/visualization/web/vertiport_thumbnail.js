// A small picture of a generated vertiport for the form that designs it. It is
// the same painted deck the map lays down, seen from a fixed corner with the
// building's sides under it, so a design shows its shape before a position has
// been chosen for it. It is a drawing and not a scene: the map still owns the
// real thing, and nothing about the shape is decided here.
import {PAINT, cachedApron} from './vertiport_paint.js';
import {FACADE, cornerRadius, facadeHeight, facadePlan, rotatePoint, rotationOf, roundedOutline} from './vertiport_shell.js';

// How far the view is tilted: 0 looks straight down the deck's edge, 1 looks
// straight down at it. This is the flattening of the north axis on screen.
const TILT = 0.52;
// A deck with no height still needs an edge to read as a solid thing.
const MIN_WALL_M = 0.8;
const MARGIN_PX = 8;
// The picture is small; painting the deck at map resolution would be waste.
const DECK_PIXELS = 640;

const defaultCanvas = (width, height) => {
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  return canvas;
};

// Draws `layout` into `canvas` and answers whether it drew. A canvas without a
// 2D context, or a layout with no platform, draws nothing and says so.
export function paintThumbnail(layout, name, canvas, {createCanvas = defaultCanvas, tilt = TILT, margin = MARGIN_PX} = {}) {
  const ctx = canvas?.getContext?.('2d');
  if (!ctx || !layout) return false;
  // The same design is asked for on every slider tick; the paint is cached by
  // what it shows, so only the turn and the sides below are drawn again.
  const painted = cachedApron(layout, name ?? '', createCanvas, {maxPixels: DECK_PIXELS});
  if (!painted) return false;
  const width = canvas.width, depth = canvas.height;
  const ppm = painted.pixelsPerMetre;
  const [minX, minY] = painted.origin_m;
  const maxX = minX + painted.width_m, maxY = minY + painted.depth_m;
  const radius = cornerRadius(painted.width_m, painted.depth_m, layout.platform?.corner_radius_m);
  const outline = roundedOutline([[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]], radius);
  const thickness = Math.max(MIN_WALL_M, Number(layout.platform?.height_m) || 0);
  const plan = facadePlan(facadeHeight(layout.platform?.height_m));

  // Design metres to the picture: turned to the layout's heading, then seen
  // from the corner. Height runs straight down the screen.
  const turn = rotationOf(Number(layout.frame?.heading_deg) || 0);
  const flat = ([x, y]) => {
    const [east, north] = rotatePoint([x, y], turn);
    return [east - north, (east + north) * tilt];
  };
  const flattened = outline.map(flat);
  const xs = flattened.map(point => point[0]), ys = flattened.map(point => point[1]);
  const spanX = Math.max(...xs) - Math.min(...xs) || 1;
  const spanY = (Math.max(...ys) - Math.min(...ys)) + thickness || 1;
  const scale = Math.min((width - 2 * margin) / spanX, (depth - 2 * margin) / spanY);
  const left = (width - spanX * scale) / 2 - Math.min(...xs) * scale;
  const top = (depth - spanY * scale) / 2 - Math.min(...ys) * scale;
  const screen = point => {const [x, y] = flat(point); return [left + x * scale, top + y * scale];};
  // Anything the layout already reports in the placed frame skips the turn.
  const placed = ([east, north]) => [left + (east - north) * scale, top + (east + north) * tilt * scale];
  const wall = thickness * scale;
  const path = points => {
    ctx.beginPath();
    points.forEach(([x, y], index) => (index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  };

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, depth);

  // The sides, hung from every edge of the outline. The ones facing away hang
  // into the deck and the deck is drawn over them, so no face has to be hidden.
  const band = (from, to, low, high, colour) => {
    ctx.fillStyle = colour;
    path([[from[0], from[1] + wall * low], [to[0], to[1] + wall * low],
      [to[0], to[1] + wall * high], [from[0], from[1] + wall * high]]);
    ctx.fill();
  };
  for (let index = 0; index < outline.length; index++) {
    const from = screen(outline[index]), to = screen(outline[(index + 1) % outline.length]);
    band(from, to, 0, 1, FACADE.wall);
    band(from, to, 0, 0.1, FACADE.coping);
    band(from, to, 0.9, 1, FACADE.plinth);
    for (let storey = 0; storey < plan.storeys; storey++) {
      const centre = 0.2 + (storey + 0.5) * 0.7 / plan.storeys;
      band(from, to, centre - 0.09, centre + 0.09, FACADE.glass);
    }
  }

  // The deck, clipped to the outline it is laid on. The whole picture is one
  // flat plane seen from a corner, so the painting maps onto it with a plain
  // affine transform.
  ctx.save();
  path(outline.map(screen));
  ctx.clip();
  const atPixel = (u, v) => screen([minX + u / ppm, maxY - v / ppm]);
  const origin = atPixel(0, 0), alongU = atPixel(1, 0), alongV = atPixel(0, 1);
  ctx.setTransform(alongU[0] - origin[0], alongU[1] - origin[1],
    alongV[0] - origin[0], alongV[1] - origin[1], origin[0], origin[1]);
  ctx.drawImage(painted.canvas, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.restore();

  // The charging cabinets standing on the deck. At this size they are small
  // solid marks, which is all a cabinet is from here.
  const side = Number(layout.dimensions?.charger_size_m) || 0;
  const stands = (side > 0 ? layout.chargers ?? [] : []);
  const rise = (Number(layout.dimensions?.charger_height_m) || 0) * scale;
  const square = [[-side / 2, -side / 2], [side / 2, -side / 2], [side / 2, side / 2], [-side / 2, side / 2]]
    .map(offset => rotatePoint(offset, turn));
  for (const charger of stands) {
    const feet = square.map(([east, north]) => placed([charger.center_m[0] + east, charger.center_m[1] + north]));
    const lid = feet.map(([x, y]) => [x, y - rise]);
    ctx.fillStyle = PAINT.charger;
    for (let index = 0; index < feet.length; index++) {
      const next = (index + 1) % feet.length;
      path([feet[index], feet[next], lid[next], lid[index]]);
      ctx.fill();
    }
    ctx.fillStyle = PAINT.chargerPanel; path(lid); ctx.fill();
    ctx.strokeStyle = PAINT.chargerEdge; ctx.lineWidth = 1; ctx.setLineDash([]); ctx.stroke();
  }

  ctx.strokeStyle = FACADE.coping; ctx.lineWidth = 1; ctx.setLineDash([]);
  path(outline.map(screen));
  ctx.stroke();
  return true;
}
