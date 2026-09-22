import {facilityGraphic} from './vertiport_facilities.js?v=20260917-realism';
// World-space annotations obey depth: aircraft and opaque geometry occlude them.
// Places generated vertiport layouts on the globe as a raised platform slab
// with a painted deck on top (markings, taxi lanes and the name, see
// vertiport_paint.js), plus a marker that stays visible from any distance.
// Geometry comes from the server's model-library layout in local metres; this
// layer only resolves the ground height, converts to world positions and
// draws. It holds no definitions of its own.
import {cachedApron, paintChargerFace, paintShelterFace, rotateLayout} from './vertiport_paint.js?v=20260917-pilot-detail';
import {DeckLights, elevationOf, lampsFor} from './deck_lights.js';
import {boundsOf, cornerRadius, facadeHeight, facadeRepeats, facadeWall, offsetOutline, outlineSpans, outlineTexture,
  paintFacade, roundedOutline, rotatePoints, shellMesh, spanLength} from './vertiport_shell.js?v=20260914-realism';
import {BaseStructures, baseMesh, basePlan, cladHeight} from './vertiport_base.js?v=20260917-base';
import {VertiportPilotDetail} from './vertiport_pilot_detail.js?v=20260917-realism';
import {TerminalShells} from './terminal_shell.js?v=20260922-terminal';
import {gateSigns, paintBoard, peopleOn} from './terminal_board.js?v=20260922-life';
import {TerminalPeople} from './terminal_people.js?v=20260922-life';

export {rotateLayout};

// The mass below the cladding: the plinth colour, so a building on a slope
// reads as one base rather than a slab under a wall.
const PLATFORM_COLOR = '#5c646b';
const PLATFORM_EDGE = '#3b464f';
const MARKER_COLOR = '#7fe9f5';
const NAME_COLOR = '#c9f2fa';
// The edge a vertiport wears while the pointer is over it.
const HOVER_COLOR = '#ffffff';
const PREVIEW_ID = '__preview__';
// Markings are readable up to here; beyond it only the marker and name remain.
const NEAR_METRES = 8000;
const NAME_BILLBOARD_FROM = 350;
// How far the slab reaches below its deck, so a slope shows no gap under it.
const SKIRT_METRES = 8;
// A tile that is not loaded answers with a height far from the ground the
// cursor sits on; anything beyond this is discarded rather than believed.
const PLAUSIBLE_RELIEF_METRES = 300;
const DECK_LIFT_METRES = 0.03;
// A vertiport is a landmark, not a city, so its marker does go eventually and
// the map is the map again — but not before the network can be taken in whole:
// 200 km up is the whole metropolitan area in one view, which is where an
// operator looks to see where the ports are. This is a camera distance, not an
// altitude, and from 200 km over Seoul the eighteen ports measure 199.9–205.7 km
// away, so the limit carries the headroom a tilted view of the same height
// needs. The route network leaves at the same distance.
const MARKER_FAR_METRES = 260000;
// How faint a vertiport being edited is drawn. It stays on the map where it was
// saved, so the preview of what it is becoming reads against what is there now
// instead of against a second solid deck.
const DIM_ALPHA = 0.3;
// How far the cladding stands clear of the mass it covers, so the two never
// fight for the same pixels.
const FACADE_OFFSET_METRES = 0.08;
// The bright edge that makes a small cabinet read as a building from above.
const CHARGER_EDGE = '#7fe9f5';
// The people side: a glazed edge barrier with a metal rail, the stair and lift
// head that goes down into the building, and the two colours a terminal uses to
// tell boarding from arriving.
const BARRIER_GLASS = '#9fd8e6';
const BARRIER_RAIL = '#dfe6ea';
const BOARDING_COLOR = '#2f7f5f';
const BOARDING_EDGE = '#d8f3e5';
// The name beside the far marker, at the size it was designed at; the display
// setting scales it and every other name together.
const MARKER_LABEL_SIZE = 12;

// The building outline a layout stands on: the platform rectangle with its
// corners taken off. It is worked out in the design frame, where the deck
// texture is painted, and then turned to the layout's heading, so the paint
// stays attached to the shape. Cached against the platform it was built from,
// because a preview moving with the cursor asks for it every frame.
const shells = new WeakMap();
// The base of a design in local metres, built once: a colonnade is the same
// fifty solids however many times the deck is redrawn, and the preview that
// follows the cursor carries the very same one.
const bases = new WeakMap();
export function baseOf(layout) {
  const platform = layout?.platform;
  const height = Math.max(0, Number(platform?.height_m) || 0);
  const heading = Number(layout?.frame?.heading_deg) || 0;
  const cached = platform ? bases.get(platform) : null;
  if (cached && cached.heading === heading && cached.height === height) return cached.mesh;
  const shell = shellOf(layout);
  const plan = shell ? basePlan(height, shell.cladding) : null;
  const mesh = plan ? baseMesh(shell.cladding, plan, {headingDeg: heading}) : null;
  if (platform) bases.set(platform, {heading, height, mesh});
  return mesh;
}

export function shellOf(layout) {
  const platform = layout?.platform;
  const heading = Number(layout?.frame?.heading_deg) || 0;
  const cached = platform ? shells.get(platform) : null;
  if (cached && cached.heading === heading) return cached.shell;
  const design = rotateLayout(layout, 0).platform?.corners_m ?? [];
  if (design.length < 3) return null;
  const bounds = boundsOf(design);
  const width = bounds.max[0] - bounds.min[0], depth = bounds.max[1] - bounds.min[1];
  const outline = roundedOutline(design, cornerRadius(width, depth, platform?.corner_radius_m));
  const points = rotatePoints(outline, heading);
  let perimeter = 0;
  for (let index = 0; index < points.length; index++) {
    const from = points[index], to = points[(index + 1) % points.length];
    perimeter += Math.hypot(to[0] - from[0], to[1] - from[1]);
  }
  const shell = {points, cladding: offsetOutline(points, FACADE_OFFSET_METRES),
    texture: outlineTexture(outline, bounds), width_m: width, depth_m: depth, perimeter_m: perimeter};
  if (platform) shells.set(platform, {heading, shell});
  return shell;
}

export function localToWorld(C, frame, points, height = 0) {
  const origin = C.Cartesian3.fromDegrees(frame.longitude, frame.latitude, height);
  const enu = C.Transforms.eastNorthUpToFixedFrame(origin);
  return points.map(([east, north, up = 0]) => C.Matrix4.multiplyByPoint(enu, new C.Cartesian3(east, north, up), new C.Cartesian3()));
}

export function layoutToWorld(C, layout, height = 0) {
  const frame = layout.frame;
  const [origin] = localToWorld(C, frame, [[0, 0]], height);
  const circles = group => localToWorld(C, frame, group.map(item => item.center_m), height)
    .map((center, index) => ({...group[index], center}));
  const shell = shellOf(layout);
  return {
    origin,
    platform: localToWorld(C, frame, layout.platform?.corners_m ?? [], height),
    outline: shell ? localToWorld(C, frame, shell.points, height) : [],
    cladding: shell ? localToWorld(C, frame, shell.cladding, height) : [],
    texture: shell?.texture ?? [],
    perimeter: shell?.perimeter_m ?? 0,
    fatos: circles(layout.fatos ?? []).map(item => ({id: item.id, role: item.role, marking: item.marking, radius: item.radius_m,
      safety: item.safety_radius_m ?? item.radius_m, tlof: item.tlof_radius_m ?? 0, center: item.center})),
    gates: circles(layout.gates ?? []).map(item => ({id: item.id, marking: item.marking, radius: item.radius_m, center: item.center})),
    taxiways: (layout.edges ?? []).map(edge => ({id: edge.id, width: edge.width_m, positions: localToWorld(C, frame, edge.points_m, height)})),
  };
}

// The ground a vertiport covers, in degrees: its own outline pushed out a
// little. A deck built on top of an existing building leaves that building
// standing through it and around it, which reads as two buildings in the same
// place; handing these to the building layers lets them leave that ground to
// the vertiport. Pushed out because a wall that stops exactly at the deck edge
// still shows a sliver of itself beside the cladding.
export function footprintsOf(layouts, expandMetres = 3) {
  const rings = [];
  for (const layout of layouts ?? []) {
    const shell = layout && shellOf(layout);
    if (!shell || shell.points.length < 3) continue;
    const ring = geographicPoints(layout.frame, offsetOutline(shell.points, expandMetres));
    // The box around it, worked out once. Every building in view is tested
    // against every ring, so recomputing this per building would walk these
    // outlines tens of millions of times to answer a question that never
    // changes while the vertiports stand still.
    ring.bounds = degreeBounds(ring);
    rings.push(ring);
  }
  return rings;
}

// The bounding box of a ring, so a building on the other side of the city is
// rejected without walking its outline.
function degreeBounds(points, longitude = point => point.longitude, latitude = point => point.latitude) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const point of points) {
    const x = longitude(point), y = latitude(point);
    if (x < west) west = x;
    if (x > east) east = x;
    if (y < south) south = y;
    if (y > north) north = y;
  }
  return {west, south, east, north};
}

function pointInPolygon(polygon, longitude, latitude, x = point => point.longitude, y = point => point.latitude) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index], b = polygon[previous];
    if ((y(a) > latitude) !== (y(b) > latitude)
      && longitude < (x(b) - x(a)) * (latitude - y(a)) / (y(b) - y(a)) + x(a)) {
      inside = !inside;
    }
  }
  return inside;
}

// Whether two segments cross. Touching at an endpoint is not crossing: two
// buildings that share a wall are neighbours, not one inside the other.
function segmentsCross(p, q, r, s) {
  const side = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = side(p, q, r), d2 = side(p, q, s), d3 = side(r, s, p), d4 = side(r, s, q);
  return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0);
}

// Whether a building's outline — [[longitude, latitude], ...] — overlaps one of
// these rings at all.
//
// Testing one point of the building, its centre, misses the case this exists
// for: a neighbour whose middle is outside the deck but whose corner runs
// through it stays standing and pokes out of the vertiport. Two polygons
// overlap exactly when a corner of one is inside the other or their edges
// cross, and all three are cheap after a bounding-box rejection.
export function overlapsFootprint(rings, outline) {
  if (!rings?.length || !outline || outline.length < 3) return false;
  const box = degreeBounds(outline, point => point[0], point => point[1]);
  for (const ring of rings) {
    if (ring.length < 3) continue;
    const ringBox = ring.bounds ?? degreeBounds(ring);
    if (box.east < ringBox.west || ringBox.east < box.west
      || box.north < ringBox.south || ringBox.north < box.south) continue;
    // A corner of the building standing on the deck's ground.
    for (const point of outline) if (pointInPolygon(ring, point[0], point[1])) return true;
    // Or the deck entirely inside the building, which has no corner of its own
    // inside and no crossing edge.
    for (const point of ring) {
      if (pointInPolygon(outline, point.longitude, point.latitude,
        item => item[0], item => item[1])) return true;
    }
    // Or a wall driven straight across it.
    for (let index = 0; index < outline.length; index++) {
      const a = outline[index], b = outline[(index + 1) % outline.length];
      for (let at = 0; at < ring.length; at++) {
        const c = ring[at], d = ring[(at + 1) % ring.length];
        if (segmentsCross(a, b, [c.longitude, c.latitude], [d.longitude, d.latitude])) return true;
      }
    }
  }
  return false;
}

// Whether a point in degrees falls inside one of those rings.
export function insideFootprint(rings, longitude, latitude) {
  for (const ring of rings ?? []) {
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const a = ring[index], b = ring[previous];
      if ((a.latitude > latitude) !== (b.latitude > latitude)
        && longitude < (b.longitude - a.longitude) * (latitude - a.latitude) / (b.latitude - a.latitude) + a.longitude) {
        inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}

// Where the ground matters for a platform: its origin, a grid over the slab
// (corners included) and every marking centre, so a bump inside the outline
// is not missed.
export function groundSamplePoints(layout, steps = 4) {
  const corners = layout.platform?.corners_m ?? [];
  const points = [[0, 0]];
  if (corners.length === 4) {
    const [c0, c1, , c3] = corners;
    for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps; j++) {
      const u = i / steps, w = j / steps;
      points.push([c0[0] + u * (c1[0] - c0[0]) + w * (c3[0] - c0[0]), c0[1] + u * (c1[1] - c0[1]) + w * (c3[1] - c0[1])]);
    }
  }
  for (const item of [...(layout.fatos ?? []), ...(layout.gates ?? [])]) points.push(item.center_m);
  return points;
}

// Geographic positions of local-metre points, close enough for terrain sampling.
export function geographicPoints(frame, points) {
  const metresPerDegree = 111320;
  const cosLat = Math.cos(frame.latitude * Math.PI / 180) || 1e-9;
  return points.map(([east, north]) => ({longitude: frame.longitude + east / (metresPerDegree * cosLat), latitude: frame.latitude + north / metresPerDegree}));
}

// Flight GLBs already have their feet at Y=0. Three centimetres clear the deck
// paint (top + 0.02 m), not a model-dependent or seat-dependent arbitrary lift.
export const DECK_CONTACT_CLEARANCE_M = 0.03;
export function deckSurfaceOffset(layout, top, referenceAltitude, position) {
  const frame=layout?.frame;
  if(!frame || ![top,referenceAltitude,position?.longitude,position?.latitude,position?.height,
      frame.latitude,frame.longitude].every(Number.isFinite))return 0;
  const rad=Math.PI/180;
  const east=(position.longitude/rad-frame.longitude)*111320*Math.cos(frame.latitude*rad);
  const north=(position.latitude/rad-frame.latitude)*111320;
  let radius=0;
  for(const [x,y] of layout.platform?.corners_m ?? [])radius=Math.max(radius,Math.hypot(x,y));
  const fade=(value,near,far)=>{const t=Math.max(0,Math.min(1,(value-near)/(far-near)));return 1-t*t*(3-2*t);};
  // Full registration on the deck and the first 10 m of the vertical. Fade
  // back to reported altitude by 150 m AGL / 250 m beyond the footprint.
  // A much higher display deck needs a longer vertical blend: smoothstep's
  // maximum slope is 1.5/span, so 1.6*delta prevents a rising aircraft from
  // visually descending (or crossing the deck) as its correction fades out.
  const delta=top+DECK_CONTACT_CLEARANCE_M-referenceAltitude;
  const blendTop=Math.max(150,10+1.6*Math.max(0,delta));
  const weight=fade(position.height-referenceAltitude,10,blendTop)*fade(Math.hypot(east,north),radius,radius+250);
  return delta*weight;
}

const defaultCanvas = (width, height) => {
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  return canvas;
};

// Ground under a following preview: the whole footprint measured from tiles
// already in memory, reduced by the layout's reference. No request is made, so
// a moving preview never waits; with nothing loaded the cursor height carries it.
export function followGround(layout, pose, heightAt) {
  const reference = layout.ground_reference ?? 'highest';
  if (reference === 'manual' && Number.isFinite(layout.frame?.altitude_m)) {
    const height = layout.frame.altitude_m;
    return {reference, top: height, bottom: height, min: height, max: height, mean: height};
  }
  const frame = {...layout.frame, latitude: pose.latitude, longitude: pose.longitude};
  // The cursor height comes from a ray against the rendered globe and is
  // trustworthy; tile samples are not, so keep only those near it.
  const cursor = Number.isFinite(pose.height) ? pose.height : null;
  const heights = [];
  for (const point of geographicPoints(frame, groundSamplePoints(layout))) {
    const height = heightAt?.(point.longitude, point.latitude);
    if (!Number.isFinite(height)) continue;
    if (cursor !== null && Math.abs(height - cursor) > PLAUSIBLE_RELIEF_METRES) continue;
    heights.push(height);
  }
  if (cursor !== null) heights.push(cursor);
  if (!heights.length) {
    const height = Number.isFinite(pose.height) ? pose.height : 0;
    return {reference, top: height, bottom: height, min: height, max: height, mean: height};
  }
  const min = Math.min(...heights), max = Math.max(...heights);
  const mean = heights.reduce((a, b) => a + b, 0) / heights.length;
  return {reference, top: reference === 'lowest' ? min : reference === 'mean' ? mean : max, bottom: min, min, max, mean};
}

// The charging cabinets a layout carries, in local metres: a square building
// per stand, standing on the deck on the side the layout kept free of taxiways.
// Returns null when a layout has none, which is how a vertiport saved before
// them still draws.
export function chargerBoxes(layout, deckLift = 0) {
  const chargers = layout?.chargers ?? [];
  const dims = layout?.dimensions ?? {};
  const side = Number(dims.charger_size_m), height = Number(dims.charger_height_m);
  if (!chargers.length || !(side > 0) || !(height > 0)) return null;
  return {side, height, heading: Number(layout.frame?.heading_deg) || 0,
    centres: chargers.map(charger => charger.center_m), lift: deckLift + height / 2};
}

// What the people side of a layout puts on the deck, in local metres: the runs
// of edge protection right round it, and the boarding shelter beside each
// stand's charging cabinet. The layout decided all of it; this only reports it
// in the shape the scene draws.
export function deckFurniture(layout) {
  const barrier = layout?.barrier;
  const runs = (barrier?.runs_m ?? []).filter(run => Array.isArray(run) && run.length >= 2);
  const height = Number(barrier?.height_m) || 0;
  const boarding = (layout?.boarding_points ?? []).filter(point => point?.center_m && point.size_m);
  if (!runs.length && !boarding.length) return null;
  return {
    heading: Number(layout?.frame?.heading_deg) || 0,
    barrier: height > 0 && runs.length ? {height, runs} : null,
    boarding: boarding.map(point => ({id: point.id, gate: point.gate,
      centre: point.center_m, size: point.size_m, height: Number(point.height_m) || 2.8})),
  };
}

// The moving preview: the building shell and its painted deck, built once and
// afterwards only transformed. Entity geometry would be rebuilt on every frame
// of a CallbackProperty, which is far too heavy for a textured deck.
class FollowPreview {
  constructor(C, scene, layout, shell, painted, facade, cabinets, visible) {
    this.C = C; this.scene = scene; this.layout = layout;
    this.thickness = Math.max(0, Number(layout.platform?.height_m) || 0);
    // Rows from the buried foot to the deck: the lowest band repeats the foot
    // of the facade, so the part below the cladding reads as plinth and the
    // windows keep the height they were painted for.
    const wall = cladHeight(this.thickness);
    const mesh = shellMesh(shell.points, shell.texture,
      {rows: [[-(wall + SKIRT_METRES), 0], [-wall, 0], [0, 1]], capHeight: DECK_LIFT_METRES});
    this.slab = scene.primitives.add(this.textured(mesh.sides, facade.canvas, mesh.facade_repeats));
    this.deck = scene.primitives.add(this.textured(mesh.cap, painted.canvas));
    // Every cabinet in one primitive: they share a face, so only their places differ.
    const boxes = cabinets && chargerBoxes(layout, DECK_LIFT_METRES);
    this.boxes = boxes ? scene.primitives.add(new C.Primitive({
      geometryInstances: boxInstances(C, boxes),
      appearance: new C.MaterialAppearance({materialSupport: C.MaterialAppearance.MaterialSupport.TEXTURED,
        material: C.Material.fromType('Image', {image: cabinets.canvas}), closed: true, translucent: false}),
      asynchronous: false})) : null;
    // The base stands on the ground rather than under the deck, so it is placed
    // by its own matrix; everything else about it is the placed building's.
    this.base = baseOf(layout);
    this.bases = this.base && C.Primitive ? new BaseStructures(C, scene) : null;
    this.setVisible(visible);
  }
  // One repeat of the texture over the whole mesh unless the material is told
  // otherwise: the facade tiles around the building, the deck does not.
  textured(mesh, image, repeats = 1) {
    const C = this.C;
    const attribute = (values, size, datatype) => new C.GeometryAttribute({componentDatatype: datatype, componentsPerAttribute: size, values});
    return new C.Primitive({
      geometryInstances: new C.GeometryInstance({geometry: new C.Geometry({
        attributes: {
          position: attribute(new Float64Array(mesh.positions), 3, C.ComponentDatatype.DOUBLE),
          normal: attribute(new Float32Array(mesh.normals), 3, C.ComponentDatatype.FLOAT),
          st: attribute(new Float32Array(mesh.st), 2, C.ComponentDatatype.FLOAT),
        },
        indices: new Uint16Array(mesh.indices),
        primitiveType: C.PrimitiveType.TRIANGLES,
        boundingSphere: C.BoundingSphere.fromVertices(mesh.positions)})}),
      appearance: texturedAppearance(C, image, repeats),
      asynchronous: false});
  }
  // The shell is already turned to the layout's heading, so a pose only needs
  // the local frame that stands on it.
  update(pose, ground) {
    const C = this.C;
    const origin = C.Cartesian3.fromDegrees(pose.longitude, pose.latitude, ground.top + this.thickness);
    const matrix = C.Transforms.eastNorthUpToFixedFrame(origin, undefined, new C.Matrix4());
    this.slab.modelMatrix = matrix;
    this.deck.modelMatrix = C.Matrix4.clone(matrix, new C.Matrix4());
    if (this.boxes) this.boxes.modelMatrix = C.Matrix4.clone(matrix, new C.Matrix4());
    this.bases?.set(PREVIEW_ID, {mesh: this.base, key: 'preview',
      matrix: C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(pose.longitude, pose.latitude, ground.top), undefined, new C.Matrix4()),
      far: this.far ?? NEAR_METRES * 2});
    this.origin = origin;
    this.ground = ground;
  }
  setVisible(visible) {
    this.slab.show = visible; this.deck.show = visible;
    if (this.boxes) this.boxes.show = visible;
    this.bases?.setVisible(visible);
  }
  destroy() {
    this.scene.primitives.remove(this.slab); this.scene.primitives.remove(this.deck);
    if (this.boxes) this.scene.primitives.remove(this.boxes);
    this.bases?.destroy();
  }
}

// The image-textured appearance the preview slab, deck and cabinets are drawn
// with. Exported so the loading screen can compile its program before the
// first placement does.
export function texturedAppearance(C, image, repeats = 1, {translucent = false, closed = false} = {}) {
  return new C.MaterialAppearance({materialSupport: C.MaterialAppearance.MaterialSupport.TEXTURED,
    material: C.Material.fromType('Image', {image, repeat: new C.Cartesian2(repeats, 1)}), closed, translucent});
}

// Box instances for a set of cabinets, turned with the layout so they stand
// square to the deck rather than to north.
function boxInstances(C, boxes) {
  const spin = C.Matrix3.fromRotationZ(-C.Math.toRadians(boxes.heading));
  return boxes.centres.map(([east, north]) => new C.GeometryInstance({
    geometry: C.BoxGeometry.fromDimensions({vertexFormat: C.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
      dimensions: new C.Cartesian3(boxes.side, boxes.side, boxes.height)}),
    modelMatrix: C.Matrix4.fromRotationTranslation(spin, new C.Cartesian3(east, north, boxes.lift), new C.Matrix4())}));
}

export class VertiportLayer {
  // `groundHeights` answers terrain heights for a list of {longitude, latitude};
  // `heightAt` answers one height from loaded tiles without a request;
  // `onPlaced(id, {reference, top, min, max, mean})` hears where a deck ended up.
  constructor(C, viewer, {groundHeights = async points => points.map(() => 0), heightAt = () => undefined,
    onPlaced = () => {}, createCanvas = defaultCanvas} = {}) {
    this.C = C; this.entities = viewer.entities; this.scene = viewer.scene;
    this.groundHeights = groundHeights; this.heightAt = heightAt; this.onPlaced = onPlaced; this.createCanvas = createCanvas;
    this.owned = new Map(); this.records = new Map(); this.versions = new Map(); this.visible = true;
    this.detailDistance = NEAR_METRES;
    this.recordSignatures = new Map(); this.placements = new Map(); this.loadingMarkers = new Set();
    // How much larger than its design size each name is drawn, from the display
    // setting. Every label carries the size it was designed at, so a change is a
    // font written over the labels that exist rather than a redraw.
    this.labelScale = 1;
    // While a preview follows the cursor, primitives carry it; only the transform moves.
    this.following = null; this.followState = null; this.followPreview = null;
    // Ground already resolved per position: a design edit at the same place
    // shows at once and is only rebuilt if a fresh sample disagrees.
    this.groundCache = new Map();
    // One painted deck per layout object, and one facade per wall height in
    // half-metre steps: a design edit that does not change the height repaints
    // nothing.
    this.facades = new Map();
    // Ids drawn faint, and the ground each placement used, so a change of
    // emphasis redraws without measuring the terrain again.
    this.dimmed = new Set(); this.grounds = new Map();
    // The vertiport under the pointer, drawn with a bright edge.
    this.hovered = null;
    // The lamps of every placed deck, in one point collection.
    this.lights = viewer.scene?.primitives && C.PointPrimitiveCollection
      ? new DeckLights(C, viewer.scene) : null;
    // The colonnade, terrace and steps of every placed building.
    this.bases = viewer.scene?.primitives && C.Primitive ? new BaseStructures(C, viewer.scene) : null;
    this.pilotDetail = viewer.scene?.primitives && typeof C.Material === 'function' ? new VertiportPilotDetail(C, viewer.scene, createCanvas) : null;
    // The storey under each deck, stood up only while somebody is there to walk it.
    this.terminals = new TerminalShells(C, this.entities);
    // ...and the life in it: the schedule on the wall and the people it puts
    // in the room. Both are fed from one answer, so they cannot disagree.
    this.terminalPeople = null; this.terminalBoard = null;
  }

  // Stand this deck's interior up, or take it down. Answers whether it is up.
  //
  // On demand rather than on distance: it is hidden under its own deck, so
  // nothing above ground can see it, and the caller knows the one thing
  // proximity cannot -- that a person is about to be inside it.
  showTerminal(id, on = true) {
    const up = this.terminals.set(id, on, {layout: this.records.get(id)?.layout, deckTop: this.deckTop(id)});
    if (!on || !up) {this.terminalPeople?.hide(); this.terminalBoard = null;}
    else if (!this.terminalPeople && this.scene?.primitives && this.C.Model?.fromGltfAsync) {
      this.terminalPeople = new TerminalPeople(this.C, this.scene,
        {assets: this.personAsset ?? (() => null), warning: this.onWarning ?? (() => {})});
      void this.terminalPeople.fill();
    }
    return up;
  }

  // What the deck's board says, and therefore who is standing where. One
  // answer drives both: a second reading of 'who is waiting' would drift
  // from the first within a minute.
  showTerminalLife(id, board, waiting) {
    const record = this.records.get(id), plan = record?.layout?.terminal?.plan;
    if (!this.terminals.has(id) || !plan) return 0;
    this.terminalBoard = board ?? null;
    const face = this.entities.getById(`vertiport:${id}:terminal:board:face`);
    if (face?.wall) {
      this.boardCanvas ??= this.createCanvas(1, 1);
      if (paintBoard(this.boardCanvas, board, {title: record.name || '운항 시간표', now: board?.clock ?? ''}) >= 0) {
        // A fresh material each time: Cesium uploads the canvas when the
        // material is replaced, and the same object is not re-read.
        face.wall.material = new this.C.ImageMaterialProperty({image: this.boardCanvas});
      }
    }
    // Each gate says which flight it is boarding, so standing at one tells
    // you what the wall a hundred metres away would have.
    const signs = gateSigns(board);
    for (const lounge of plan.lounges ?? []) {
      const sign = this.entities.getById(`vertiport:${id}:terminal:lounge:${lounge.id}:sign`);
      if (sign?.label) sign.label.text = signs.get(lounge.gate) ?? `${lounge.gate} 탑승 대기`;
    }
    const people = peopleOn(plan, {waiting});
    return this.terminalPeople?.show(people, record.layout.frame, this.deckTop(id) - (Number(record.layout.terminal?.floor_drop_m) || 0)) ?? 0;
  }
  // The vertiport a scene pick landed on, or null for anything else. Entity
  // ids are `vertiport:<id>:<part>`; the preview is not a vertiport to pick.
  pick(picked) {
    const identity = picked?.id;
    const name = typeof identity === 'string' ? identity : identity?.id;
    if (typeof name !== 'string' || !name.startsWith('vertiport:')) return null;
    const rest = name.slice('vertiport:'.length);
    const end = rest.indexOf(':');
    const id = end === -1 ? rest : rest.slice(0, end);
    return id && id !== PREVIEW_ID ? {kind: 'vertiport', id} : null;
  }
  // Hover changes colours on the entities that are already there, so pointing
  // at a vertiport costs nothing. Returns true when the hover moved.
  setHovered(id = null) {
    const next = id ?? null;
    if (this.hovered === next) return false;
    const previous = this.hovered;
    this.hovered = next;
    for (const target of new Set([previous, next])) if (target) this.applyHighlight(target);
    return true;
  }
  applyHighlight(id) {
    const entities = this.owned.get(id);
    if (!entities) return;
    const lit = this.hovered === id;
    const fade = this.dimmed.has(id) ? DIM_ALPHA : 1;
    for (const entity of entities) {
      const name = typeof entity.id === 'string' ? entity.id : '';
      if (name.endsWith(':platform') && entity.polygon) {
        entity.polygon.outlineColor = this.color(lit ? HOVER_COLOR : PLATFORM_EDGE, fade);
        entity.polygon.outlineWidth = lit ? 3 : 1;
      } else if (name.endsWith(':marker') && entity.point) {
        entity.point.pixelSize = lit ? 12 : 9;
        entity.point.color = this.color(lit ? HOVER_COLOR : MARKER_COLOR, fade);
      } else if (name.endsWith(':name') && entity.label) {
        entity.label.fillColor = this.color(lit ? HOVER_COLOR : NAME_COLOR, fade);
      }
    }
  }
  // The vertiports drawn faint: the one being edited, or none.
  setDimmed(ids = []) {
    const next = new Set(ids);
    const changed = [...new Set([...next, ...this.dimmed])].filter(id => next.has(id) !== this.dimmed.has(id));
    this.dimmed = next;
    for (const id of changed) {
      const record = this.records.get(id), ground = this.grounds.get(id);
      if (!record || !ground) continue;
      this.rebuild(id, record, ground);
    }
    return changed.length > 0;
  }
  // The face every charging cabinet wears, painted once for the whole layer.
  cabinets() {
    if (this.cabinetFace === undefined) this.cabinetFace = paintChargerFace(this.createCanvas);
    return this.cabinetFace;
  }
  // The face of a boarding shelter, painted once and shared by every stand.
  shelters() {
    if (this.shelterFace === undefined) this.shelterFace = paintShelterFace(this.createCanvas);
    return this.shelterFace;
  }
  // The cladding for a platform this thick, painted once and shared by the
  // placed building and the preview that follows the cursor.
  // The cladding for a wall this thick. `windows` false paints the same wall
  // without glazing, which is what goes round a corner radius.
  facade(platformHeightM, windows = true) {
    // The wall above the base storey, in the same half-metre steps the cache
    // has always used: a building with a colonnade is clad from its canopy up.
    const height = cladHeight(platformHeightM);
    const key = windows ? height : `${height}:blank`;
    if (!this.facades.has(key)) this.facades.set(key, paintFacade(height, this.createCanvas, {windows}));
    return this.facades.get(key);
  }
  groundKey(frame) {return `${frame.latitude},${frame.longitude},${frame.altitude_m ?? ''}`;}
  color(css, alpha) {return this.C.Color.fromCssColorString(css).withAlpha(alpha);}
  raise(position, up) {const C = this.C; return new C.Cartesian3(position.x, position.y, position.z + up);}
  labelFont(size, weight = 'bold') {return `${weight} ${Math.round(size * this.labelScale * 10) / 10}px sans-serif`;}
  // Names are drawn at the operator's size; null or an unusable value is ignored.
  setLabelScale(scale) {
    const next = Number(scale);
    if (!Number.isFinite(next) || next <= 0 || next === this.labelScale) return false;
    this.labelScale = next;
    for (const entities of this.owned.values()) {
      for (const entity of entities) if (entity.label && entity.aerodtLabelSize) entity.label.font = this.labelFont(entity.aerodtLabelSize);
    }
    return true;
  }
  // Change only display ranges; existing geometry, textures and measured deck
  // heights stay ready when the camera approaches again.
  setPerformanceOptions({detailDistance} = {}) {
    const value = Number(detailDistance);
    if (!Number.isFinite(value)) return false;
    const next = Math.max(1000, Math.min(NEAR_METRES, value));
    if (next === this.detailDistance) return false;
    this.detailDistance = next;
    const C = this.C;
    for (const [id, entities] of this.owned) for (const entity of entities) {
      const part = String(entity.id).slice(`vertiport:${id}:`.length);
      const range = far => new C.DistanceDisplayCondition(0, far);
      if (part === 'platform' && entity.polygon) entity.polygon.distanceDisplayCondition = range(NEAR_METRES * 4);
      else if (part.startsWith('facade:') && entity.wall) entity.wall.distanceDisplayCondition = range(next * 2);
      else if (part === 'deck' && entity.polygon) entity.polygon.distanceDisplayCondition = range(next);
      else if (part === 'name' && entity.label) entity.label.distanceDisplayCondition = new C.DistanceDisplayCondition(NAME_BILLBOARD_FROM, next);
      else if (part === 'marker') {
        const far = new C.DistanceDisplayCondition(this.loadingMarkers.has(id) ? 0 : next, MARKER_FAR_METRES);
        if (entity.point) entity.point.distanceDisplayCondition = far;
        if (entity.label) entity.label.distanceDisplayCondition = far;
      } else for (const property of ['box', 'model', 'wall', 'polyline']) {
        if (entity[property]) entity[property].distanceDisplayCondition = range(Math.min(next, 3000));
      }
    }
    this.scene?.requestRender?.();
    return true;
  }
  label(position, text, {size = 14, weight = 'bold', offsetY = 0, color = '#ffffff', near = 0, far = this.detailDistance, alpha = 1} = {}) {
    const C = this.C;
    return {position, aerodtLabelSize: size, label: {text, font: this.labelFont(size, weight), fillColor: this.color(color, alpha),
      outlineColor: this.color('#06121a', .9 * alpha), outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: C.VerticalOrigin.CENTER, pixelOffset: new C.Cartesian2(0, offsetY),
      disableDepthTestDistance: 0, distanceDisplayCondition: new C.DistanceDisplayCondition(near, far),
      scaleByDistance: new C.NearFarScalar(500, 1, NEAR_METRES, .35)}};
  }
  // The painted deck for a record. Paintings are cached by what they show, not
  // by which layout object asked: a heading slider tick, a server answer with
  // the same design or a list refresh all hand back the same canvas.
  painting(record) {
    const layout = record.layout;
    return cachedApron(layout, record.name ?? '', this.createCanvas);
  }
  // Ground under the platform, sampled over a grid and every marking, then
  // reduced by the layout's ground reference: the deck clears the highest
  // point, sits at the mean, at the lowest, or at a stated altitude. The base
  // always sinks below the lowest sample. A failed sample means the ellipsoid.
  async resolveGround(layout) {
    const frame = layout.frame, reference = layout.ground_reference ?? 'highest';
    if (reference === 'manual' && Number.isFinite(frame.altitude_m)) {
      return {reference, top: frame.altitude_m, bottom: frame.altitude_m, min: frame.altitude_m, max: frame.altitude_m, mean: frame.altitude_m};
    }
    let heights = [];
    try {
      heights = ((await this.groundHeights(geographicPoints(frame, groundSamplePoints(layout)))) ?? []).filter(Number.isFinite);
    } catch {heights = [];}
    // Nothing measured (terrain not ready, or failed): the ellipsoid for now, and never remembered.
    if (!heights.length) return {reference, top: 0, bottom: 0, min: 0, max: 0, mean: 0, uncertain: true};
    const min = Math.min(...heights), max = Math.max(...heights), mean = heights.reduce((a, b) => a + b, 0) / heights.length;
    const top = reference === 'lowest' ? min : reference === 'mean' ? mean : max;
    return {reference, top, bottom: min, min, max, mean};
  }
  // Heights and world positions for a layout over ground {top, bottom}.
  geometryState(layout, ground) {
    const thickness = Math.max(0, Number(layout.platform?.height_m) || 0);
    const top = ground.top + thickness, base = ground.bottom - Math.max(3, thickness);
    return {top, base, surface: top + 0.02, world: layoutToWorld(this.C, layout, top)};
  }
  // Following: `dynamic` wraps every value in a callback so a moved pose is
  // picked up each frame without rebuilding the entities.
  build(id, record, ground) {
    const C = this.C;
    const fixed = this.geometryState(record.layout, ground);
    const S = () => fixed;
    const val = fn => fn();
    const within = far => new C.DistanceDisplayCondition(0, far);
    const state = S();
    const descriptions = [];
    const prefix = `vertiport:${id}:`;
    // Faint while this vertiport is being edited: the paint keeps its colours
    // and loses its weight, so the preview beside it is the solid one.
    const fade = this.dimmed.has(id) ? DIM_ALPHA : 1;
    const tint = fade < 1 ? {color: this.color('#ffffff', fade), transparent: true} : {};
    if (state.world.outline.length >= 3) {
      // The mass: the rounded footprint from below the lowest ground to the
      // deck. Above ground the cladding covers it; what stays visible is the
      // part of a slope the cladding does not reach.
      descriptions.push({id: prefix + 'platform', polygon: {hierarchy: val(() => new C.PolygonHierarchy(S().world.outline)), height: val(() => S().base),
        extrudedHeight: val(() => S().top), material: this.color(PLATFORM_COLOR, fade), outline: true, outlineColor: this.color(PLATFORM_EDGE, fade), outlineWidth: 1,
        distanceDisplayCondition: within(NEAR_METRES * 4)}});
      const facade = this.facade(Number(record.layout.platform?.height_m) || 0);
      if (facade && state.world.cladding.length >= 3) {
        // The wall is clad span by span: windows along the flats, plain
        // cladding round the curves. A window texture wrapped round a corner
        // radius is a smear of glazing, not a window, and the corners of a deck
        // this size are tight.
        const local = shellOf(record.layout)?.cladding ?? [];
        const spans = local.length === state.world.cladding.length
          ? outlineSpans(local) : [{kind: 'side', indices: [...state.world.cladding.keys(), 0]}];
        const blank = this.facade(Number(record.layout.platform?.height_m) || 0, false);
        const foot = state.top - facade.height_m;
        spans.forEach((span, index) => {
          const positions = span.indices.map(at => state.world.cladding[at]);
          if (positions.length < 2) return;
          const painted = span.kind === 'corner' && blank ? blank : facade;
          const length = spanLength(span.indices.map(at => local[at] ?? [0, 0]));
          descriptions.push({id: `${prefix}facade:${index}`, wall: {positions,
            minimumHeights: positions.map(() => foot), maximumHeights: positions.map(() => state.top),
            material: new C.ImageMaterialProperty({image: painted.canvas,
              repeat: new C.Cartesian2(facadeRepeats(length), 1), ...tint}),
            distanceDisplayCondition: within(this.detailDistance * 2)}});
        });
      }
      // The base storey: a terrace, a colonnade carrying the canopy the clad
      // wall starts on, a glazed lobby and the steps up to it.
      if (this.bases) {
        const mesh = baseOf(record.layout);
        const frame = record.layout.frame;
        this.bases.set(id, mesh ? {
          mesh, key: `${facade?.height_m ?? 0}:${state.top}:${fade}`,
          matrix: C.Transforms.eastNorthUpToFixedFrame(
            C.Cartesian3.fromDegrees(frame.longitude, frame.latitude, state.top - (Number(record.layout.platform?.height_m) || 0)),
            undefined, new C.Matrix4()),
          far: this.detailDistance * 2, fade,
        } : {mesh: null, matrix: null, far: 0});
      }
      const painted = this.painting(record);
      if (id !== PREVIEW_ID && fade === 1) this.pilotDetail?.set(id, record, shellOf(record.layout), state.top);
      if (painted) {
        // The deck texture maps onto the platform rectangle the paint was made
        // in, so the rounded outline carries it corner for corner.
        const corners = state.world.texture.map(([s, t]) => new C.Cartesian2(s, t));
        descriptions.push({id: prefix + 'deck', polygon: {shadows:C.ShadowMode?.RECEIVE_ONLY,hierarchy: val(() => new C.PolygonHierarchy(S().world.outline)), height: val(() => S().surface),
          material: new C.ImageMaterialProperty({image: painted.canvas, ...tint}), textureCoordinates: new C.PolygonHierarchy(corners),
          distanceDisplayCondition: within(this.detailDistance)}});
      }
    }
    // The lamps: placed on the deck this vertiport actually came out at, in
    // one point collection rather than as entities, because a lit field is
    // thousands of them.
    if (this.lights) {
      const lamps = lampsFor(record.layout);
      this.lights.set(id, record.layout,
        lamps.length ? localToWorld(C, record.layout.frame,
          lamps.map(lamp => [...lamp.point, elevationOf(lamp.kind)]), state.surface) : []);
    }
    const boxes = chargerBoxes(record.layout, 0.02);
    if (boxes) {
      // Small square buildings standing on the deck beside their stands; the
      // layout already chose the side that keeps them off the taxiway.
      const heading = C.Math.toRadians(boxes.heading);
      const positions = localToWorld(C, record.layout.frame, boxes.centres, state.top + boxes.lift);
      record.layout.chargers.forEach((charger, index) => {
        const position = positions[index];
        descriptions.push({id: `${prefix}charger:${charger.id}`, position,
          orientation: C.Transforms.headingPitchRollQuaternion(position, new C.HeadingPitchRoll(heading, 0, 0)),
          model: facilityGraphic(C,'charger',[boxes.side,boxes.side,boxes.height],fade,Math.min(this.detailDistance,3000))});
      });
    }
    // The people side: edge protection right round the deck, and the shelter
    // people come out of beside each stand's cabinet.
    const furniture = deckFurniture(record.layout);
    if (furniture) {
      const heading = C.Math.toRadians(furniture.heading);
      if (furniture.barrier) {
        const {height, runs} = furniture.barrier;
        runs.forEach((run, index) => {
          const positions = localToWorld(C, record.layout.frame, run, state.top);
          descriptions.push({id: `${prefix}barrier:${index}`, wall: {positions,
            minimumHeights: positions.map(() => state.top + 0.02),
            maximumHeights: positions.map(() => state.top + height - 0.08),
            material: this.color(BARRIER_GLASS, 0.42 * fade),
            outline: true, outlineColor: this.color(BARRIER_RAIL, 0.9 * fade), outlineWidth: 1,
            distanceDisplayCondition: within(Math.min(this.detailDistance, 3000))}});
          // The rail along the top is what makes a glazed balustrade read as
          // something solid rather than a tinted pane floating on a deck.
          descriptions.push({id: `${prefix}barrier-rail:${index}`, polyline: {
            positions: localToWorld(C, record.layout.frame, run, state.top + height),
            width: 2.5, arcType: C.ArcType?.NONE, material: this.color(BARRIER_RAIL, fade),
            distanceDisplayCondition: within(Math.min(this.detailDistance, 3000))}});
        });
      }
      for (const point of furniture.boarding) {
        const [position] = localToWorld(C, record.layout.frame, [point.centre], state.top + point.height / 2 + 0.02);
        descriptions.push({id: `${prefix}boarding:${point.id}`, position,
          orientation: C.Transforms.headingPitchRollQuaternion(position, new C.HeadingPitchRoll(heading, 0, 0)),
          model: facilityGraphic(C,'boarding',[point.size[0],point.size[1],point.height],fade,Math.min(this.detailDistance,3000))});
      }
    }
    if (record.name) {
      // Close up the painted name reads on the deck; further out a billboard takes over, then the marker.
      descriptions.push({id: prefix + 'name', ...this.label(val(() => this.raise(S().world.origin, 1)), record.name, {size: 13, offsetY: -34, color: NAME_COLOR, near: NAME_BILLBOARD_FROM, alpha: fade})});
      const far = new C.DistanceDisplayCondition(this.detailDistance, MARKER_FAR_METRES);
      descriptions.push({id: prefix + 'marker', position: val(() => this.raise(S().world.origin, 2)), aerodtLabelSize: MARKER_LABEL_SIZE,
        point: {pixelSize: 9, color: this.color(MARKER_COLOR, fade), outlineColor: this.color('#06121a', .9 * fade), outlineWidth: 2,
          disableDepthTestDistance: 0, distanceDisplayCondition: far},
        label: {text: record.name, font: this.labelFont(MARKER_LABEL_SIZE), fillColor: this.color('#e6fbff', fade), outlineColor: this.color('#06121a', .9 * fade),
          outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, verticalOrigin: C.VerticalOrigin.BOTTOM, pixelOffset: new C.Cartesian2(0, -10),
          disableDepthTestDistance: 0, distanceDisplayCondition: far}});
    }
    return descriptions;
  }
  add(id, descriptions) {
    // `revision` counts every change to what is drawn (see RouteLayer.add).
    this.revision = (this.revision ?? 0) + 1;
    const created = descriptions.map(description => {
      const entity = this.entities.add(description);
      entity.show = this.visible;
      if(entity.label)entity.label.show=this.labelsVisible!==false;
      return entity;
    });
    this.owned.set(id, created);
    // A vertiport rebuilt while the pointer is on it keeps its bright edge.
    if (this.hovered === id) this.applyHighlight(id);
  }
  rebuild(id, record, ground) {
    // Batch each phase separately: Cesium's EntityCollection cancels a removal
    // followed by an addition with the same id inside one suspended transaction.
    // That leaves visualizers bound to the discarded entity (or pending marker).
    // Two notifications retain batching without losing replacement identities.
    this.entities.suspendEvents?.();
    try {
      this.remove(id, {keepRecord: true});
    } finally {
      this.entities.resumeEvents?.();
    }
    this.entities.suspendEvents?.();
    try {this.add(id, this.build(id, record, ground));}
    finally {this.entities.resumeEvents?.();}
  }
  // A preview at a cursor pose {latitude, longitude, height}. The deck sits on
  // the highest ground under the whole footprint (measured from loaded tiles),
  // so it is never buried, and later poses only move the transform.
  follow(layout, name = '', pose) {
    const record = {id: PREVIEW_ID, name, layout};
    this.versions.set(PREVIEW_ID, (this.versions.get(PREVIEW_ID) ?? 0) + 1);
    this.records.set(PREVIEW_ID, record);
    this.remove(PREVIEW_ID, {keepRecord: true});
    // A follow that replaces a follow has to take the previous primitives with
    // it: leaving them behind is what left an older deck standing on the map
    // every time the design or the heading changed mid-placement.
    this.clearFollow();
    const painted = this.painting(record);
    const shell = shellOf(layout);
    const facade = this.facade(Number(layout.platform?.height_m) || 0);
    this.following = layout;
    this.followPreview = painted && shell && facade && this.scene?.primitives
      ? new FollowPreview(this.C, this.scene, layout, shell, painted, facade, this.cabinets(), this.visible) : null;
    this.add(PREVIEW_ID, this.followLabels(PREVIEW_ID, record));
    this.moveFollow(pose);
    // A following preview is measured too, so the panel can show the ground
    // under it while it is being placed, not only once it is placed.
    const ground = followGround(layout, pose, this.heightAt);
    this.onPlaced(PREVIEW_ID, {reference: ground.reference, top: ground.top + Math.max(0, Number(layout.platform?.height_m) || 0),
      min: ground.min, max: ground.max, mean: ground.mean});
    return Promise.resolve();
  }
  moveFollow(pose) {
    if (!this.following) return;
    const ground = followGround(this.following, pose, this.heightAt);
    this.followState = this.geometryState(this.posed(this.following, pose), ground);
    this.followPreview?.update(pose, ground);
    this.scene?.requestRender?.();
  }
  // A following preview keeps only its two labels as entities: cheap, and they
  // read the pose each frame without rebuilding any geometry.
  followLabels(id, record) {
    if (!record.name) return [];
    const C = this.C, prefix = `vertiport:${id}:`;
    const origin = up => new C.CallbackProperty(() => this.raise(this.followState.world.origin, up), false);
    const far = new C.DistanceDisplayCondition(this.detailDistance, MARKER_FAR_METRES);
    return [
      {id: prefix + 'name', ...this.label(origin(1), record.name, {size: 13, offsetY: -34, color: '#c9f2fa', near: NAME_BILLBOARD_FROM})},
      {id: prefix + 'marker', position: origin(2), aerodtLabelSize: MARKER_LABEL_SIZE,
        point: {pixelSize: 9, color: this.color(MARKER_COLOR, 1), outlineColor: this.color('#06121a', .9), outlineWidth: 2,
          disableDepthTestDistance: 0, distanceDisplayCondition: far},
        label: {text: record.name, font: this.labelFont(MARKER_LABEL_SIZE), fillColor: this.color('#e6fbff', 1), outlineColor: this.color('#06121a', .9),
          outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, verticalOrigin: C.VerticalOrigin.BOTTOM, pixelOffset: new C.Cartesian2(0, -10),
          disableDepthTestDistance: 0, distanceDisplayCondition: far}}];
  }
  posed(layout, pose) {return {...layout, frame: {...layout.frame, latitude: pose.latitude, longitude: pose.longitude}};}
  clearFollow() {
    this.followPreview?.destroy();
    this.followPreview = null; this.following = null; this.followState = null;
  }
  pendingMarker(id, record) {
    const C = this.C, frame = record.layout.frame;
    const sampled = this.heightAt?.(frame.longitude, frame.latitude);
    const height = Number.isFinite(sampled) ? sampled : 0;
    const position = C.Cartesian3.fromDegrees(frame.longitude, frame.latitude, height);
    return [{id: `vertiport:${id}:marker`, position,
      point: {pixelSize: 9, color: this.color(MARKER_COLOR, 1), outlineColor: this.color('#06121a', .9), outlineWidth: 2,
        heightReference: C.HeightReference?.CLAMP_TO_GROUND, disableDepthTestDistance: 0,
        distanceDisplayCondition: new C.DistanceDisplayCondition(0, MARKER_FAR_METRES)},
      ...this.label(position, record.name ?? '', {size: MARKER_LABEL_SIZE, offsetY: -18, color: NAME_COLOR, far: MARKER_FAR_METRES})}];
  }
  // Only a lightweight marker appears before terrain resolves. It never
  // reports a guessed deck height to flight contact/presentation code.
  async place(id, record) {
    const version = (this.versions.get(id) ?? 0) + 1;
    this.versions.set(id, version);
    this.records.set(id, record);
    const key = this.groundKey(record.layout.frame) + '|' + (record.layout.ground_reference ?? 'highest');
    const cached = this.groundCache.get(key);
    const settle = ground => {
      if (id === PREVIEW_ID) this.clearFollow();
      this.loadingMarkers.delete(id);
      this.grounds.set(id, ground);
      this.rebuild(id, record, ground);
      const thickness = Math.max(0, Number(record.layout.platform?.height_m) || 0);
      this.onPlaced(id, {reference: ground.reference, top: ground.top + thickness, min: ground.min, max: ground.max, mean: ground.mean});
    };
    if (cached) settle(cached);
    else if (!this.owned.has(id)) {
      this.loadingMarkers.add(id);
      this.add(id, this.pendingMarker(id, record));
    }
    const ground = await this.resolveGround(record.layout);
    if (this.versions.get(id) !== version || this.records.get(id) !== record) return;
    if (!ground.uncertain) this.groundCache.set(key, ground);
    if (!cached || cached.top !== ground.top || cached.bottom !== ground.bottom) settle(ground);
  }
  // The deck height of a placed vertiport, for whatever stands on it; null until placed.
  contactDecks() {
    const decks=[];
    for(const [id,record] of this.records){
      const height=this.deckTop(id),shell=shellOf(record.layout);
      if(!Number.isFinite(height)||!shell)continue;
      const outline=localToWorld(this.C,record.layout.frame,shell.points,height).map(p=>{
        const c=this.C.Cartographic.fromCartesian(p);
        return [this.C.Math.toDegrees(c.longitude),this.C.Math.toDegrees(c.latitude)];
      });
      decks.push({id,height_m:height,outline});
    }
    return decks;
  }
  // Every surface a person may stand on here, and every way between them.
  //
  // The deck is the one the aircraft lands on -- the same polygon as
  // `contactDecks`, so a pilot can only walk where their aircraft could have
  // stood. Under it is the terminal storey the layout derives, and the stair
  // cores are the structures already standing beside each charger. A level is
  // carried because the two floors are the same longitude and latitude: which
  // one you are on is a fact about the person, not about the point.
  walkWorld() {
    const C=this.C,surfaces=[],links=[],blocks=[];
    for(const [id,record] of this.records){
      const deckTop=this.deckTop(id),shell=shellOf(record.layout);
      if(!Number.isFinite(deckTop)||!shell)continue;
      const frame=record.layout.frame;
      const ring=(points,height)=>localToWorld(C,frame,points,height).map(point=>{
        const at=C.Cartographic.fromCartesian(point);
        return [C.Math.toDegrees(at.longitude),C.Math.toDegrees(at.latitude)];
      });
      const place=(point,height)=>{const [lon,lat]=ring([point],height)[0];return {longitude:lon,latitude:lat};};
      surfaces.push({id,level:0,height_m:deckTop,outline:ring(shell.points,deckTop)});
      const terminal=record.layout.terminal;
      if(!Array.isArray(terminal?.outline_m)||terminal.outline_m.length<3)continue;
      const floor=deckTop-(Number(terminal.floor_drop_m)||0);
      surfaces.push({id:`${id}:terminal`,level:-1,height_m:floor,outline:ring(terminal.outline_m,floor)});
      // The fit-out is solid where it stands: shops, benches, the screening
      // wall. The cores are deliberately not in here -- they are the way
      // between floors, and a walker has to be able to step into one.
      (terminal.plan?.blocks_m??[]).forEach((outline,index)=>{
        if(!Array.isArray(outline)||outline.length<3)return;
        blocks.push({id:`${id}:block:${index}`,level:-1,outline:ring(outline,floor)});
      });
      for(const core of terminal.cores??[]){
        if(!Array.isArray(core?.center_m)||!Array.isArray(core?.size_m))continue;
        // A square of the door's longer side, square to east and north. The
        // footprint is a turned rectangle, but this is a threshold rather than
        // a wall: slightly generous is a door nobody can miss, and the extra
        // is under a metre on one axis.
        const half=Math.max(core.size_m[0],core.size_m[1])/2;
        const foot=[[-half,-half],[half,-half],[half,half],[-half,half]]
          .map(([x,y])=>[core.center_m[0]+x,core.center_m[1]+y]);
        links.push({id:`${id}:${core.id}:down`,from:0,to:-1,core:core.id,gate:core.gate,
          outline:ring(foot,deckTop),exit:place(core.landing_m??core.center_m,floor)});
        links.push({id:`${id}:${core.id}:up`,from:-1,to:0,core:core.id,gate:core.gate,
          outline:ring(foot,floor),exit:place(core.deck_exit_m??core.center_m,deckTop)});
      }
    }
    return {surfaces,links,blocks};
  }
  deckTop(id) {
    const record = this.records.get(id), ground = this.grounds.get(id);
    // Per-frame registration must not rebuild every outline, FATO and gate
    // merely to retrieve one scalar height.
    return record && ground ? ground.top+Math.max(0,Number(record.layout.platform?.height_m)||0) : null;
  }
  // Where the cabinet a charging connection names stands, for the cable that
  // leaves it: its centre, the height of its cable track (mid-height, in the
  // displayed deck's frame), its footprint side and the heading it is turned
  // to. Null for a cabinet this layer has not placed.
  chargerCabinet(connection) {
    const record = this.records.get(connection?.vertiport_id);
    const charger = record?.layout?.chargers?.find(item => item.id === connection?.charger_id);
    const boxes = charger && chargerBoxes(record.layout, 0.02);
    const top = boxes ? this.deckTop(connection.vertiport_id) : null;
    const centre = charger?.center_m;
    if (!boxes || !Number.isFinite(top) || !Array.isArray(centre) || !centre.slice(0, 2).every(Number.isFinite)) return null;
    // The same east-north-up placement the cabinet model itself gets (the flat
    // metres-per-degree shortcut drifts by decimetres 80 m from the frame).
    let [{longitude, latitude}] = geographicPoints(record.layout.frame, [centre]);
    if (this.C.Cartographic?.fromCartesian && this.C.Transforms?.eastNorthUpToFixedFrame) {
      const carto = this.C.Cartographic.fromCartesian(localToWorld(this.C, record.layout.frame, [centre], 0)[0]);
      if (carto) {longitude = carto.longitude * 180 / Math.PI; latitude = carto.latitude * 180 / Math.PI;}
    }
    return {longitude, latitude, altitude: top + boxes.lift, side: boxes.side, height: boxes.height, heading_deg: boxes.heading};
  }
  surfaceOffset(reference,position) {
    if(!reference)return 0;
    return deckSurfaceOffset(this.records.get(reference.vertiport_id)?.layout,
      this.deckTop(reference.vertiport_id),reference.altitude_m,position);
  }
  // The map shows exactly the saved list; anything not in it is removed.
  show(records) {
    const keep = new Set(records.map(record => record.id));
    // How many decks this list actually placed, changed or took away, so the
    // caller knows whether anything standing on them needs redrawing.
    let changed = 0;
    for (const id of [...this.records.keys()]) if (id !== PREVIEW_ID && !keep.has(id)) {this.remove(id); changed++;}
    const placements = records.filter(record => record.layout).map(record => {
      const id = record.id;
      // API list refreshes return fresh objects. Compare display content, not
      // identity, so an unchanged deck does not repaint/re-upload or resample.
      const signature = JSON.stringify([record.name ?? '', record.layout]);
      const pending = this.placements.get(id);
      if (pending?.signature === signature) {changed++; return pending.promise;}
      if (this.recordSignatures.get(id) === signature && this.owned.has(id)
          && this.grounds.has(id) && !this.grounds.get(id).uncertain) return Promise.resolve();
      changed++;
      this.recordSignatures.set(id, signature);
      const placement = {signature, promise: this.place(id, record)};
      this.placements.set(id, placement);
      return placement.promise.finally(() => {
        if (this.placements.get(id) === placement) this.placements.delete(id);
      });
    });
    this.showChanged = changed;
    return Promise.all(placements);
  }
  preview(layout, name = '') {
    if (!layout) {this.remove(PREVIEW_ID); return Promise.resolve();}
    return this.place(PREVIEW_ID, {id: PREVIEW_ID, name, layout});
  }
  setLabelsVisible(value) {this.labelsVisible=Boolean(value);for(const entities of this.owned.values())for(const entity of entities)if(entity.label)entity.label.show=this.labelsVisible;}
  setVisible(visible) {
    this.visible = Boolean(visible);
    for (const entities of this.owned.values()) for (const entity of entities) entity.show = this.visible;
    this.followPreview?.setVisible(this.visible);
    this.lights?.setVisible(this.visible);
    this.bases?.setVisible(this.visible);
    this.pilotDetail?.setVisible(this.visible);
    this.terminals?.setVisible(this.visible);
    if (!this.visible) this.terminalPeople?.hide();
  }
  // The lamps burn brighter and dimmer as the seconds pass; the beacon flashes.
  tickLights(seconds) {
    // The bases are walked on the same beat: which of them the camera is near
    // enough to is a distance each, for at most a couple of dozen buildings.
    this.bases?.tick();
    this.pilotDetail?.tick();
    return Boolean(this.lights?.tick(seconds));
  }
  setLightsEnabled(enabled) {return Boolean(this.lights?.setEnabled(enabled));}
  // Terrain came or went: every platform needs its ground height again.
  refresh() {
    this.groundCache.clear();
    return Promise.all([...this.records.entries()].map(([id, record]) => this.place(id, record)));
  }
  remove(id, {keepRecord = false} = {}) {
    if (this.owned.has(id)) this.revision = (this.revision ?? 0) + 1;
    for (const entity of this.owned.get(id) ?? []) this.entities.remove(entity);
    this.owned.delete(id);
    this.lights?.clear(id);
    this.bases?.clear(id);
    this.pilotDetail?.clear(id);
    this.terminals?.clear(id);
    if (!keepRecord) {
      if (this.hovered === id) this.hovered = null;
      this.records.delete(id); this.grounds.delete(id); this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
      this.recordSignatures.delete(id); this.placements.delete(id); this.loadingMarkers.delete(id);
      if (id === PREVIEW_ID) this.clearFollow();
    }
  }
  clear() {for (const id of [...new Set([...this.owned.keys(), ...this.records.keys()])]) this.remove(id);}
  destroy() {this.clear(); this.lights?.destroy(); this.bases?.destroy(); this.pilotDetail?.destroy(); this.terminals?.destroy(); this.terminalPeople?.destroy();}
}
