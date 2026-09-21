// Paints a vertiport apron the way an airport is marked: one texture per
// layout with the concrete deck and its panel joints, asphalt taxi lanes with
// yellow centrelines, stand circles with their numbers, FATO and TLOF
// perimeters with the identification letter, and the vertiport name written on
// the empty strip the layout reserves. Everything is drawn in the server
// layout's local metres; nothing about the shape is decided here.
import {cornerRadius, roundedOutline, rotatePoint, rotationOf} from './vertiport_shell.js';

export const PAINT = {
  deck: '#999b96', speckleDark: 'rgba(60,64,68,0.028)', speckleLight: 'rgba(255,255,255,0.035)', joint: '#777c7c',
  edge: '#e6e8ea', asphalt: '#353b3e', centreline: '#f2c744', stand: '#f2c744', white: '#f4f4f2',
  fatoTint: {takeoff: 'rgba(110,220,150,0.22)', landing: 'rgba(120,190,255,0.22)', both: 'rgba(255,255,255,0.10)'},
  name: '#f7f7f5', charger: '#2b3a44', chargerPanel: '#3d5261', chargerEdge: '#7fe9f5', bolt: '#ffd54a',
  // The people side: the pad each boarding shelter stands on, marked so the
  // place people come out at reads from above as part of the stand.
  boarding: '#68736c', boardingEdge: '#f7f7f5',
  shelterWall: '#e8ecee', shelterGlass: '#41616f', shelterGlassTop: '#9fc9d6', shelterDoor: '#1e2c33',
};
// A lightning bolt on the unit square, drawn in canvas coordinates (y down).
const BOLT = [[.10, -.55], [-.35, .08], [-.05, .08], [-.10, .55], [.35, -.08], [.05, -.08]];

// The face of a charging cabinet, the same on every side and on its roof: a
// dark panel inside a bright frame with the mark an electrical point carries.
// One texture serves every cabinet, so it is painted once and shared.
export function paintChargerFace(createCanvas, {pixels = 128} = {}) {
  const canvas = createCanvas(pixels, pixels);
  const ctx = canvas.getContext('2d');
  const inset = pixels * .12;
  ctx.fillStyle = PAINT.charger; ctx.fillRect(0, 0, pixels, pixels);
  ctx.fillStyle = PAINT.chargerPanel; ctx.fillRect(inset, inset, pixels - 2 * inset, pixels - 2 * inset);
  ctx.strokeStyle = PAINT.chargerEdge; ctx.lineWidth = Math.max(1, pixels * .05); ctx.setLineDash([]);
  ctx.strokeRect(inset, inset, pixels - 2 * inset, pixels - 2 * inset);
  ctx.beginPath();
  BOLT.forEach(([bx, by], index) => (index ? ctx.lineTo(pixels / 2 + bx * pixels * .62, pixels / 2 + by * pixels * .62)
    : ctx.moveTo(pixels / 2 + bx * pixels * .62, pixels / 2 + by * pixels * .62)));
  ctx.closePath(); ctx.fillStyle = PAINT.bolt; ctx.fill();
  return {canvas};
}
// The face of a boarding shelter: a glazed front with a doorway people come
// out of, under a solid head band. The same on every side, so one texture
// serves every stand and a shelter reads as a shelter from any angle.
export function paintShelterFace(createCanvas, {pixels = 128} = {}) {
  const canvas = createCanvas(pixels, pixels);
  const ctx = canvas.getContext('2d');
  const M = share => share * pixels;
  ctx.fillStyle = PAINT.shelterWall; ctx.fillRect(0, 0, pixels, pixels);
  // The head band the roof sits on, and the glazed front below it.
  ctx.fillStyle = PAINT.boarding; ctx.fillRect(0, 0, pixels, M(.22));
  ctx.fillStyle = PAINT.shelterGlass; ctx.fillRect(M(.08), M(.26), M(.84), M(.62));
  ctx.fillStyle = PAINT.shelterGlassTop; ctx.fillRect(M(.08), M(.26), M(.84), M(.14));
  // The doorway, which is what says people come out here.
  ctx.fillStyle = PAINT.shelterDoor; ctx.fillRect(M(.34), M(.40), M(.32), M(.48));
  ctx.strokeStyle = PAINT.boardingEdge; ctx.lineWidth = Math.max(1, M(.02)); ctx.setLineDash([]);
  ctx.strokeRect(M(.34), M(.40), M(.32), M(.48));
  ctx.strokeRect(M(.08), M(.26), M(.84), M(.62));
  return {canvas};
}

export const ROLE_LABEL = {takeoff: '이륙', landing: '착륙', both: '이착륙'};
const FONT = '"Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';

// The same layout turned to another heading (clockwise from north, as the
// server does it): a rigid display transform, no shape is recomputed.
export function rotateLayout(layout, headingDeg) {
  const from = Number(layout.frame?.heading_deg) || 0;
  const heading = ((headingDeg % 360) + 360) % 360;
  const rotation = rotationOf(heading - from);
  const turn = point => rotatePoint(point, rotation);
  const corners = (layout.platform?.corners_m ?? []).map(turn);
  const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
  return {
    ...layout,
    frame: {...layout.frame, heading_deg: heading},
    platform: layout.platform ? {...layout.platform, corners_m: corners} : layout.platform,
    name_area: layout.name_area ? {...layout.name_area, center_m: turn(layout.name_area.center_m)} : layout.name_area,
    fatos: (layout.fatos ?? []).map(item => ({...item, center_m: turn(item.center_m)})),
    gates: (layout.gates ?? []).map(item => ({...item, center_m: turn(item.center_m)})),
    chargers: (layout.chargers ?? []).map(item => ({...item, center_m: turn(item.center_m)})),
    nodes: (layout.nodes ?? []).map(item => ({...item, position_m: turn(item.position_m)})),
    edges: (layout.edges ?? []).map(item => ({...item, points_m: item.points_m.map(turn)})),
    // The people side turns with everything else. Its rectangles are given in
    // the design frame, so turning back to a heading of zero puts them back on
    // the axes the painter draws them on.
    barrier: layout.barrier ? {...layout.barrier, runs_m: (layout.barrier.runs_m ?? []).map(run => run.map(turn))} : layout.barrier,
    boarding_points: (layout.boarding_points ?? []).map(item => ({...item, center_m: turn(item.center_m)})),
    bounds_m: corners.length ? {min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)]} : layout.bounds_m,
  };
}

// Deterministic speckle so a repaint of the same layout is pixel-identical.
function* noise(seed) {
  let state = seed >>> 0 || 1;
  for (;;) {state = (state * 1664525 + 1013904223) >>> 0; yield state / 4294967296;}
}

// What a painting shows, as a string: the name and every mark the painter
// reads, in the design frame and to five centimetres (a turn and its undoing
// round each point to the millimetre, and no deck is painted finer than a
// twelfth of a metre). A heading is a display transform of the same paint,
// and where the deck stands is not what it looks like, so neither is part of it.
const round = value => Math.round(Number(value) * 20) / 20;
const roundPoints = points => (points ?? []).map(point => Array.isArray(point) ? point.map(round) : round(point));
export function apronSignature(layout, name = '') {
  if (!layout?.platform?.corners_m) return null;
  const design = rotateLayout(layout, 0);
  return JSON.stringify([String(name ?? ''),
    roundPoints(design.platform?.corners_m), round(design.platform?.corner_radius_m ?? -1),
    design.name_area ? [roundPoints([design.name_area.center_m]), design.name_area.along, round(design.name_area.length_m), round(design.name_area.height_m)] : null,
    (design.fatos ?? []).map(f => [f.id, f.role, f.marking, roundPoints([f.center_m]), round(f.radius_m), round(f.tlof_radius_m ?? -1)]),
    (design.gates ?? []).map(g => [g.marking, roundPoints([g.center_m]), round(g.radius_m)]),
    (design.edges ?? []).map(e => [roundPoints(e.points_m), round(e.width_m)]),
    (design.boarding_points ?? []).map(b => [roundPoints([b.center_m]), roundPoints([b.size_m])])]);
}

// Paintings by what they show. Every layer that paints decks shares it: the
// map, the placement preview, the camera lens and the form's thumbnail each
// ask for the same design many times over, and a deck at map resolution is
// 50-70 ms to paint plus a texture upload. Bounded so a long session of
// designs does not keep every canvas it ever drew.
export const APRON_CACHE_LIMIT = 48;
const paintings = new Map();
export function cachedApron(layout, name = '', createCanvas, options = {}) {
  const signature = apronSignature(layout, name);
  if (signature === null) return null;
  const key = `${options.maxPixels ?? ''}|${options.maxPixelsPerMetre ?? ''}|${signature}`;
  const hit = paintings.get(key);
  if (hit) {paintings.delete(key); paintings.set(key, hit); return hit;}
  const painted = paintApron(layout, name ?? '', createCanvas, options);
  if (!painted) return null;
  paintings.set(key, painted);
  while (paintings.size > APRON_CACHE_LIMIT) paintings.delete(paintings.keys().next().value);
  return painted;
}

// A tile of dots the canvas repeats, where it can: seventy thousand rectangles
// painted one by one were most of a deck's paint time. The tile is drawn with
// the same generator, so the field is as deterministic as it was.
const TILE_PIXELS = 256;
function dotPattern(ctx, createCanvas, random, {perPixels, size = TILE_PIXELS, colours, spread = 1.4}) {
  if (typeof ctx.createPattern !== 'function') return null;
  let tile, tctx;
  try {tile = createCanvas(size, size); tctx = tile.getContext('2d');} catch {return null;}
  if (!tctx) return null;
  const dots = Math.round(size * size / perPixels);
  for (let i = 0; i < dots; i++) {
    const x = random.next().value * size, y = random.next().value * size;
    tctx.fillStyle = colours[random.next().value < .5 ? 0 : 1];
    tctx.fillRect(x, y, 1 + random.next().value * spread, 1 + random.next().value * spread);
  }
  try {return ctx.createPattern(tile, 'repeat');} catch {return null;}
}

function fitFont(ctx, text, heightPx, maxWidthPx, weight = 'bold') {
  let size = heightPx;
  ctx.font = `${weight} ${size}px ${FONT}`;
  const width = ctx.measureText?.(text)?.width;
  if (Number.isFinite(width) && width > maxWidthPx && width > 0) {
    size = Math.max(4, size * maxWidthPx / width);
    ctx.font = `${weight} ${size}px ${FONT}`;
  }
  return size;
}

// Returns {canvas, pixelsPerMetre, width_m, depth_m, origin_m}. `createCanvas(width, height)`
// supplies the drawing surface so the painter runs anywhere a 2D context exists.
export function paintApron(layout, name, createCanvas, {maxPixels = 2048, maxPixelsPerMetre = 12} = {}) {
  const design = rotateLayout(layout, 0);
  const corners = design.platform?.corners_m ?? [];
  if (corners.length < 3) return null;
  const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const width = maxX - minX, depth = maxY - minY;
  const ppm = Math.min(Math.max(1, maxPixelsPerMetre), maxPixels / Math.max(width, depth));
  const canvas = createCanvas(Math.max(1, Math.ceil(width * ppm)), Math.max(1, Math.ceil(depth * ppm)));
  const ctx = canvas.getContext('2d');
  const X = x => (x - minX) * ppm, Y = y => (maxY - y) * ppm, M = m => m * ppm;
  const circle = (cx, cy, r) => {ctx.beginPath(); ctx.arc(X(cx), Y(cy), M(r), 0, Math.PI * 2); ctx.closePath();};
  const text = (label, cx, cy, heightM, color, {maxWidthM = width, weight = 'bold', angle = 0} = {}) => {
    ctx.save();
    ctx.translate(X(cx), Y(cy));
    if (angle) ctx.rotate(angle);
    fitFont(ctx, label, M(heightM), M(maxWidthM), weight);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color;
    ctx.fillText(label, 0, 0);
    ctx.restore();
  };

  // Deck: concrete with speckle and panel joints.
  ctx.fillStyle = PAINT.deck; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const random = noise(Math.round(width * 1000 + depth));
  const speckle = dotPattern(ctx, createCanvas, random, {perPixels: 14, colours: [PAINT.speckleDark, PAINT.speckleLight]});
  if (speckle) {ctx.fillStyle = speckle; ctx.fillRect(0, 0, canvas.width, canvas.height);}
  else {
    const dots = Math.min(70000, Math.round(canvas.width * canvas.height / 14));
    for (let i = 0; i < dots; i++) {
      const x = random.next().value * canvas.width, y = random.next().value * canvas.height, dark = random.next().value < .5;
      ctx.fillStyle = dark ? PAINT.speckleDark : PAINT.speckleLight;
      ctx.fillRect(x, y, 1+random.next().value*1.4, 1+random.next().value*1.4);
    }
  }
  // Slight variation between poured slabs, plus restrained expansion-joint shadows.
  for(let x=minX;x<maxX;x+=7.5)for(let y=minY;y<maxY;y+=7.5){
    ctx.fillStyle=`rgba(${random.next().value>.5?'245,237,220':'40,43,40'},${.015+random.next().value*.035})`;
    ctx.fillRect(X(x)+1,Y(Math.min(y+7.5,maxY))+1,M(Math.min(7.5,maxX-x))-2,M(Math.min(7.5,maxY-y))-2);
  }
  ctx.strokeStyle = PAINT.joint; ctx.lineWidth = Math.max(1, M(.06));
  const pitch = 7.5;
  for (let x = minX + pitch; x < maxX; x += pitch) {ctx.beginPath(); ctx.moveTo(X(x), 0); ctx.lineTo(X(x), canvas.height); ctx.stroke();}
  for (let y = minY + pitch; y < maxY; y += pitch) {ctx.beginPath(); ctx.moveTo(0, Y(y)); ctx.lineTo(canvas.width, Y(y)); ctx.stroke();}

  // Taxi lanes: asphalt first so crossings merge, then one centreline each.
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash([]);
  for (const edge of design.edges ?? []) {
    ctx.beginPath();
    edge.points_m.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.strokeStyle = PAINT.asphalt; ctx.lineWidth = M(edge.width_m); ctx.stroke();
  }
  // Asphalt aggregate and wheel-polished bands, clipped mathematically to each lane.
  // The aggregate is a tiled pattern stroked along the lane where the canvas can
  // tile; otherwise the dots are placed one by one as before.
  const grain = dotPattern(ctx, createCanvas, random, {perPixels: Math.max(8, ppm), colours: ['rgba(4,10,13,.065)', 'rgba(204,205,193,.045)'], spread: 1});
  if (grain) for (const edge of design.edges ?? []) {
    ctx.beginPath();
    edge.points_m.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.strokeStyle = grain; ctx.lineWidth = M(Math.max(.2, edge.width_m - .2)); ctx.stroke();
  }
  const grainBudget = 80000 / Math.max(1, (design.edges??[]).reduce((n,e)=>n+Math.max(0,e.points_m.length-1),0));
  for(const edge of design.edges??[])for(let k=1;k<edge.points_m.length;k++){
    const a=edge.points_m[k-1],b=edge.points_m[k],dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);if(length<.01)continue;
    const count=grain?0:Math.min(grainBudget,Math.ceil(length*edge.width_m*ppm));
    for(let n=0;n<count;n++){const t=random.next().value,o=(random.next().value-.5)*(edge.width_m-.2),x=a[0]+dx*t-dy/length*o,y=a[1]+dy*t+dx/length*o;
      ctx.fillStyle=random.next().value>.45?'rgba(204,205,193,.045)':'rgba(4,10,13,.065)';ctx.fillRect(X(x),Y(y),1+random.next().value,1+random.next().value);
    }
    for(const offset of [-edge.width_m*.22,edge.width_m*.22]){ctx.beginPath();ctx.moveTo(X(a[0]-dy/length*offset),Y(a[1]+dx/length*offset));ctx.lineTo(X(b[0]-dy/length*offset),Y(b[1]+dx/length*offset));ctx.strokeStyle='rgba(8,12,15,.06)';ctx.lineWidth=M(.65);ctx.stroke();}
  }
  for (const edge of design.edges ?? []) {
    ctx.beginPath();
    edge.points_m.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.strokeStyle = PAINT.centreline; ctx.lineWidth = M(.3); ctx.stroke();
  }

  // Where people come out, painted before the stands so a stand marking that
  // reaches it still reads on top: a small marked pad under each shelter, so
  // the place people appear at is part of the stand rather than a box dropped
  // on spare concrete.
  for (const point of design.boarding_points ?? []) {
    const [cx, cy] = point.center_m, [sx, sy] = point.size_m;
    const pad = [sx + 1.6, sy + 1.6];
    ctx.fillStyle = PAINT.boarding;
    ctx.fillRect(X(cx - pad[0] / 2), Y(cy + pad[1] / 2), M(pad[0]), M(pad[1]));
    ctx.strokeStyle = PAINT.boardingEdge; ctx.lineWidth = M(.24); ctx.setLineDash([]);
    ctx.strokeRect(X(cx - pad[0] / 2), Y(cy + pad[1] / 2), M(pad[0]), M(pad[1]));
  }

  // Stands: the yellow stand circle, its centre point and number.
  for (const gate of design.gates ?? []) {
    const [cx, cy] = gate.center_m, r = gate.radius_m;
    circle(cx, cy, r); ctx.strokeStyle = PAINT.stand; ctx.lineWidth = M(.25); ctx.setLineDash([]); ctx.stroke();
    circle(cx, cy, .3); ctx.fillStyle = PAINT.stand; ctx.fill();
    text(gate.marking, cx, cy + r * .45, Math.max(1.6, r * .32), PAINT.stand, {maxWidthM: r * 1.4});
  }

  // FATOs: role tint, dashed FATO perimeter, solid TLOF, the letter and the role.
  for (const fato of design.fatos ?? []) {
    const [cx, cy] = fato.center_m, r = fato.radius_m, tlof = fato.tlof_radius_m || r * .55;
    circle(cx, cy, r); ctx.fillStyle = PAINT.fatoTint[fato.role] ?? PAINT.fatoTint.both; ctx.fill();
    circle(cx, cy, r); ctx.strokeStyle = PAINT.white; ctx.lineWidth = M(.3); ctx.setLineDash([M(1.5), M(1.5)]); ctx.stroke();
    ctx.setLineDash([]);
    circle(cx, cy, tlof); ctx.strokeStyle = PAINT.white; ctx.lineWidth = M(.3); ctx.stroke();
    text(fato.marking ?? 'F', cx, cy + tlof * .08, Math.max(2.5, tlof * .95), PAINT.white, {maxWidthM: tlof * 1.6});
    text(`${fato.id} ${ROLE_LABEL[fato.role] ?? fato.role}`, cx, cy - tlof - 1.2, Math.max(.9, r * .11), PAINT.white, {maxWidthM: r * 1.8, weight: '600'});
  }

  // Service drainage channels stay at the deck boundary, away from stand centres.
  for(const x of [minX+.7,maxX-.7])for(let y=minY+3;y<maxY-3;y+=5){
    ctx.fillStyle='#484e4c';ctx.fillRect(X(x)-M(.18),Y(y),M(.36),M(1.4));
    ctx.fillStyle='#93978f';for(let j=0;j<7;j++)ctx.fillRect(X(x)-M(.16),Y(y)+M(j*.2),M(.32),Math.max(.5,M(.05)));
  }
  // Deck perimeter line, following the rounded corners the building is built with.
  ctx.strokeStyle = PAINT.edge; ctx.lineWidth = Math.max(1, M(.15)); ctx.setLineDash([]);
  const edge = roundedOutline(corners, Math.max(0, cornerRadius(width, depth, design.platform?.corner_radius_m) - .4));
  ctx.beginPath();
  edge.forEach(([x, y], index) => (index ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
  if (edge.length) ctx.lineTo(X(edge[0][0]), Y(edge[0][1]));
  ctx.stroke();

  // The name on the reserved empty strip, as aprons carry the airport's name.
  const area = design.name_area;
  if (area && name) {
    const [cx, cy] = area.center_m;
    text(name, cx, cy, area.height_m * .8, PAINT.name, {maxWidthM: area.length_m * .92, angle: area.along === 'y' ? -Math.PI / 2 : 0});
  }
  return {canvas, pixelsPerMetre: ppm, width_m: width, depth_m: depth, origin_m: [minX, minY]};
}
