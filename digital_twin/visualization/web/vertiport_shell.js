// The vertiport read as a building: the rounded outline its deck and slab
// share, that prism as a mesh in local metres, and the facade painted on its
// sides. Everything here is derived from the server layout's platform
// rectangle and the platform height it was given; no shape or size of a
// vertiport is decided here.

// One floor of the facade, and the shortest wall that can hold one. A slab
// lower than this is a deck edge, so it gets a plinth and a coping and no
// windows — a one-metre platform with glazing would read as a toy.
export const STOREY_M = 3.4;
export const WINDOW_MIN_M = 2.6;
// One horizontal repeat of the facade texture, so a long wall shows the same
// window pitch as a short one.
export const FACADE_TILE_M = 6;
// One window bay. A curtain wall is divided about every metre and a half, and
// drawing it at that pitch is what makes a window read as a window: a single
// unbroken ribbon four metres wide and one and a half tall reads as a slot,
// however tall the glass is.
export const BAY_M = 1.5;
// How much of a storey is glass, and where its sill sits in that storey. A
// glazed band a little over half the floor-to-floor height is what an office
// or a terminal actually has; much less and the building looks squashed.
export const GLASS_OF_STOREY = 0.58;
export const SILL_OF_STOREY = 0.2;
// Drawn widths of the frame members. They are wider than the real sections on
// purpose: a nine-centimetre mullion is under a pixel at the distance a deck
// is usually seen from, and glazing with no visible division is a dark band.
export const MULLION_M = 0.16;
export const TRANSOM_M = 0.14;
// The wall between two windows. Wide enough that the windows stay separate
// things at the distance a deck is looked at from, which a mullion inside a
// continuous ribbon cannot be.
export const PIER_M = 0.5;
// How far the clad wall reaches below the deck's own thickness, so a building
// on uneven ground still meets the terrain in cladding and not in bare slab.
export const FACADE_BURY_M = 2;
const CORNER_SEGMENTS = 6;

// The clad height of a platform this thick: what both the placed building and
// the preview that follows the cursor are painted for, so they never differ.
export function facadeWall(platformHeightM) {return Math.max(0.2, (Number(platformHeightM) || 0) + FACADE_BURY_M);}
// The wall height a facade is actually painted for: half-metre steps, so a
// small edit repaints nothing and anything that reports what a deck this tall
// becomes reports the same building the map draws.
export function facadeHeight(platformHeightM) {return Math.round(facadeWall(platformHeightM) * 2) / 2;}

export const FACADE = {
  wall: '#9aa2a8', wallShade: '#828b92', plinth: '#5c646b', coping: '#ccd2d6',
  joint: 'rgba(38,44,50,0.28)', reveal: 'rgba(28,34,40,0.35)',
  glass: '#3c5563', glassTop: '#8fbdcd', spandrel: '#6f787f', mullion: '#d3d9dd', sill: '#e0e5e8',
  // The pier between bays and the shadow inside the head of a window: the two
  // things that give a facade depth rather than a printed look.
  pier: '#8a9299', head: 'rgba(20,26,32,0.30)', glassLow: '#2f4552',
};

const round3 = value => Math.round(value * 1000) / 1000 + 0;

// Clockwise from north, as the server turns a layout.
export function rotationOf(degrees) {const angle = degrees * Math.PI / 180; return {cos: Math.cos(angle), sin: Math.sin(angle)};}
export function rotatePoint([x, y], {cos, sin}) {return [round3(x * cos + y * sin), round3(-x * sin + y * cos)];}
export function rotatePoints(points, degrees) {const turn = rotationOf(degrees); return points.map(point => rotatePoint(point, turn));}

export function boundsOf(points) {
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  return {min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)]};
}

// How far the corners of a deck this size are taken off: enough to read as a
// shaped building. A layout may ask for its own radius — a ring of stands wants
// a round deck — and half the short side is as round as a rectangle gets.
export function cornerRadius(width, depth, requested = null) {
  const short = Math.max(0, Math.min(width, depth));
  const radius = Number.isFinite(requested) ? Number(requested) : Math.min(0.22 * short, 12);
  return Math.max(0, Math.min(radius, short / 2));
}

// A convex outline with rounded corners, in the same local metres. Each corner
// becomes a curve between points cut back along its two edges, so the sides
// keep their length and only the points are lost.
export function roundedOutline(corners, radius, segments = CORNER_SEGMENTS) {
  const count = corners.length;
  if (count < 3 || !(radius > 0)) return corners.map(([x, y]) => [round3(x), round3(y)]);
  const along = (from, to) => {
    const dx = to[0] - from[0], dy = to[1] - from[1], length = Math.hypot(dx, dy) || 1;
    const step = Math.min(radius, length / 2) / length;
    return [from[0] + dx * step, from[1] + dy * step];
  };
  const points = [];
  for (let index = 0; index < count; index++) {
    const corner = corners[index], previous = corners[(index - 1 + count) % count], next = corners[(index + 1) % count];
    const start = along(corner, previous), end = along(corner, next);
    for (let step = 0; step <= segments; step++) {
      const t = step / segments, u = 1 - t;
      points.push([round3(u * u * start[0] + 2 * u * t * corner[0] + t * t * end[0]),
        round3(u * u * start[1] + 2 * u * t * corner[1] + t * t * end[1])]);
    }
  }
  return points;
}

// The outline split into the straight sides and the curves between them.
// `roundedOutline` lays each corner down as `segments + 1` points in order, so
// what falls between one corner's last point and the next corner's first is a
// straight side. Splitting them lets a wall carry windows along its flats and
// plain cladding round its curves, where a window texture wrapped round a tight
// radius is a smear of glazing rather than a window.
export function outlineSpans(points, {corners = 4, segments = CORNER_SEGMENTS} = {}) {
  const perCorner = segments + 1;
  const count = points.length;
  if (!count) return [];
  if (count !== corners * perCorner) {
    // Not an outline this module laid out: one ring, no curves to separate.
    return [{kind: 'side', indices: [...points.keys(), 0]}];
  }
  const spans = [];
  for (let index = 0; index < corners; index++) {
    const first = index * perCorner;
    const arc = Array.from({length: perCorner}, (_, step) => first + step);
    spans.push({kind: 'corner', indices: arc});
    spans.push({kind: 'side', indices: [arc[arc.length - 1], ((index + 1) % corners) * perCorner]});
  }
  return spans.filter(span => spanLength(span.indices.map(at => points[at])) > 0.01);
}

export function spanLength(points) {
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    total += Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
  }
  return total;
}

// Texture coordinates of design-frame points over the platform's bounding
// rectangle: the deck canvas is painted over exactly that rectangle.
export function outlineTexture(points, bounds) {
  const width = (bounds.max[0] - bounds.min[0]) || 1, depth = (bounds.max[1] - bounds.min[1]) || 1;
  return points.map(([x, y]) => [(x - bounds.min[0]) / width, (y - bounds.min[1]) / depth]);
}

export function centroidOf(points) {
  const count = points.length || 1;
  return points.reduce((sum, point) => [sum[0] + point[0] / count, sum[1] + point[1] / count], [0, 0]);
}

// The same outline pushed out from its centre, so cladding drawn on it stands
// clear of the mass behind it instead of fighting it for the same pixels.
export function offsetOutline(points, metres) {
  const centre = centroidOf(points);
  return points.map(([x, y]) => {
    const dx = x - centre[0], dy = y - centre[1], length = Math.hypot(dx, dy);
    if (!length) return [round3(x), round3(y)];
    return [round3(x + dx / length * metres), round3(y + dy / length * metres)];
  });
}

function signedArea(points) {
  let sum = 0;
  for (let index = 0, count = points.length; index < count; index++) {
    const [x1, y1] = points[index], [x2, y2] = points[(index + 1) % count];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

// The prism as raw vertex arrays in local metres: sides carrying the facade
// and a cap carrying the deck texture. `rows` are ascending [height, v] pairs,
// so a band can repeat one row of the texture — that is how the buried skirt
// below the cladding is painted in the plinth colour without a second
// primitive. Built once per design, so a preview that follows the cursor only
// changes its transform.
export function shellMesh(outline, texture, {rows = [[-1, 0], [0, 1]], capHeight = 0, tileMetres = FACADE_TILE_M} = {}) {
  const flip = signedArea(outline) < 0;
  const ring = flip ? [...outline].reverse() : outline;
  const uv = flip ? [...texture].reverse() : texture;
  const count = ring.length;
  const walked = [0];
  for (let index = 0; index < count; index++) {
    const from = ring[index], to = ring[(index + 1) % count];
    walked.push(walked[index] + Math.hypot(to[0] - from[0], to[1] - from[1]));
  }
  const perimeter = walked[count] || 1;
  const repeats = facadeRepeats(perimeter, tileMetres);
  const sides = {positions: [], normals: [], st: [], indices: []};
  for (let index = 0; index < count; index++) {
    const from = ring[index], to = ring[(index + 1) % count];
    const dx = to[0] - from[0], dy = to[1] - from[1], length = Math.hypot(dx, dy) || 1;
    const normal = [dy / length, -dx / length, 0];
    // The walk around the ring is reported as a fraction; how many times the
    // facade repeats over it is the material's business, because a coordinate
    // outside 0..1 does not survive Cesium's vertex compression.
    const u0 = walked[index] / perimeter, u1 = walked[index + 1] / perimeter;
    for (let row = 0; row + 1 < rows.length; row++) {
      const [lowZ, lowV] = rows[row], [highZ, highV] = rows[row + 1];
      const base = sides.positions.length / 3;
      for (const [point, u, z, v] of [[from, u0, lowZ, lowV], [to, u1, lowZ, lowV], [to, u1, highZ, highV], [from, u0, highZ, highV]]) {
        sides.positions.push(point[0], point[1], z);
        sides.normals.push(normal[0], normal[1], normal[2]);
        sides.st.push(u, v);
      }
      sides.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const cap = {positions: [], normals: [], st: [], indices: []};
  const centre = centroidOf(ring), centreUV = centroidOf(uv);
  cap.positions.push(centre[0], centre[1], capHeight); cap.normals.push(0, 0, 1); cap.st.push(centreUV[0], centreUV[1]);
  for (let index = 0; index < count; index++) {
    cap.positions.push(ring[index][0], ring[index][1], capHeight);
    cap.normals.push(0, 0, 1);
    cap.st.push(uv[index]?.[0] ?? 0, uv[index]?.[1] ?? 0);
  }
  for (let index = 0; index < count; index++) cap.indices.push(0, 1 + index, 1 + ((index + 1) % count));
  return {sides, cap, perimeter_m: perimeter, facade_repeats: repeats};
}

// How many repeats of the facade texture fit around a wall of this perimeter.
export function facadeRepeats(perimetreM, tileMetres = FACADE_TILE_M) {return Math.max(1, Math.round(perimetreM / tileMetres));}

// How many floors a wall of this height carries, and the bands above and below
// them. A wall too short for a storey gets no windows at all.
export function facadePlan(heightM) {
  const height = Math.max(0.2, Number(heightM) || 0);
  const plinth = Math.min(0.7, height * 0.18);
  const coping = Math.min(0.4, height * 0.12);
  const band = height - plinth - coping;
  const storeys = band >= WINDOW_MIN_M ? Math.max(1, Math.round(band / STOREY_M)) : 0;
  return {height_m: height, plinth_m: plinth, coping_m: coping, band_m: band, storeys};
}

// One horizontal tile of the facade, repeated around the building: a concrete
// wall with panel joints, a plinth at its foot, a coping at the parapet and a
// glazed ribbon per storey. `createCanvas(width, height)` supplies the surface,
// so this runs wherever a 2D context exists.
export function paintFacade(heightM, createCanvas, {tileMetres = FACADE_TILE_M, pixelsPerMetre = 64, maxPixels = 512, windows = true} = {}) {
  const plan = windows ? facadePlan(heightM) : {...facadePlan(heightM), storeys: 0};
  const ppm = Math.max(2, Math.min(pixelsPerMetre, maxPixels / Math.max(tileMetres, plan.height_m)));
  const canvas = createCanvas(Math.max(1, Math.ceil(tileMetres * ppm)), Math.max(1, Math.ceil(plan.height_m * ppm)));
  const ctx = canvas.getContext('2d');
  const width = canvas.width, height = canvas.height;
  const M = metres => metres * ppm;
  // Metres above the foot of the wall to a canvas row; the wall is painted
  // upright and the texture runs from foot (v 0) to parapet (v 1).
  const Y = metres => height - metres * ppm;
  const band = (fromM, heightM_, color) => {ctx.fillStyle = color; ctx.fillRect(0, Y(fromM + heightM_), width, Math.max(1, M(heightM_)));};

  ctx.fillStyle = FACADE.wall; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = FACADE.wallShade; ctx.fillRect(0, 0, Math.max(1, M(0.25)), height);
  ctx.fillStyle = FACADE.joint;
  for (let x = BAY_M; x < tileMetres; x += BAY_M) ctx.fillRect(M(x), 0, Math.max(1, M(0.05)), height);

  if (plan.storeys) {
    const storey = plan.band_m / plan.storeys;
    const margin = Math.min(0.6, tileMetres * 0.12);
    const glassWidth = width - 2 * M(margin);
    // Whole bays across the tile, so the division falls at the same pitch on
    // every wall and the seam between two tiles lands on a pier.
    const bays = Math.max(1, Math.round((tileMetres - 2 * margin) / BAY_M));
    const bayWidth = glassWidth / bays;
    for (let index = 0; index < plan.storeys; index++) {
      const floor = plan.plinth_m + index * storey;
      const sill = floor + storey * SILL_OF_STOREY;
      const glass = Math.max(0.6, storey * GLASS_OF_STOREY);
      // The spandrel under the floor above, so a storey reads as a storey.
      ctx.fillStyle = FACADE.spandrel;
      ctx.fillRect(M(margin), Y(sill + glass + TRANSOM_M), glassWidth, Math.max(1, M(TRANSOM_M)));
      // Punched windows, not one ribbon: a window in each bay with wall in
      // between. An unbroken band of glazing four metres wide and a metre and a
      // half tall is the squashed slot this replaces — at any distance where
      // the mullions inside it are thinner than a pixel, that is all it can be.
      for (let bay = 0; bay < bays; bay++) {
        const left = M(margin) + bayWidth * bay + M(PIER_M) / 2;
        const paneWidth = Math.max(1, bayWidth - M(PIER_M));
        ctx.fillStyle = FACADE.glass; ctx.fillRect(left, Y(sill + glass), paneWidth, Math.max(1, M(glass)));
        // Glass is darker low down and catches the sky at its head; that
        // gradient is most of what tells a viewer it is glazing at all.
        ctx.fillStyle = FACADE.glassLow;
        ctx.fillRect(left, Y(sill + glass * 0.36), paneWidth, Math.max(1, M(glass * 0.36)));
        ctx.fillStyle = FACADE.glassTop;
        ctx.fillRect(left, Y(sill + glass), paneWidth, Math.max(1, M(glass * 0.28)));
        // Soft reflected sky, a shaded inner reveal and a narrow reflected mullion.
        if (ctx.createLinearGradient) {
          const reflection=ctx.createLinearGradient(0,Y(sill+glass),0,Y(sill));
          reflection.addColorStop(0,'rgba(178,203,209,.52)');
          reflection.addColorStop(.48,'rgba(65,90,100,.08)');
          reflection.addColorStop(1,'rgba(9,22,29,.60)');
          ctx.fillStyle=reflection;ctx.fillRect(left,Y(sill+glass),paneWidth,M(glass));
        }
        ctx.fillStyle='rgba(7,17,23,.45)';ctx.fillRect(left,Y(sill+glass),Math.max(1,M(.08)),M(glass));
        ctx.fillStyle='rgba(220,228,221,.16)';ctx.fillRect(left+paneWidth*.72,Y(sill+glass*.92),Math.max(1,M(.045)),M(glass*.82));
        // The reveal: a window set into a wall is in shadow at its head.
        ctx.fillStyle = FACADE.head;
        ctx.fillRect(left, Y(sill + glass), paneWidth, Math.max(1, M(0.12)));
        // One mullion down the middle of a wide pane, and the frame around it.
        ctx.fillStyle = FACADE.mullion;
        if (bayWidth > M(1.2)) {
          ctx.fillRect(left + paneWidth / 2 - Math.max(1, M(MULLION_M)) / 2, Y(sill + glass),
            Math.max(1, M(MULLION_M)), Math.max(1, M(glass)));
        }
        ctx.fillStyle = FACADE.sill;
        ctx.fillRect(left - M(PIER_M) / 4, Y(sill), paneWidth + M(PIER_M) / 2, Math.max(1, M(TRANSOM_M)));
      }
    }
    // The piers either side of the glazing, which carry the seam between tiles.
    ctx.fillStyle = FACADE.pier;
    ctx.fillRect(0, Y(plan.height_m - plan.coping_m), Math.max(1, M(margin)), Math.max(1, M(plan.band_m)));
    ctx.fillRect(width - Math.max(1, M(margin)), Y(plan.height_m - plan.coping_m),
      Math.max(1, M(margin)), Math.max(1, M(plan.band_m)));
  } else {
    // Too low for a storey: one shadow line where the deck slab overhangs.
    band(Math.max(0, plan.height_m - plan.coping_m - 0.18), 0.18, FACADE.reveal);
  }
  band(0, plan.plinth_m, FACADE.plinth);
  band(plan.height_m - plan.coping_m, plan.coping_m, FACADE.coping);
  return {canvas, tile_m: tileMetres, pixelsPerMetre: ppm, ...plan};
}
