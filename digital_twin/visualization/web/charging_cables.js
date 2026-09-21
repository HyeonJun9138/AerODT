// The stand cable while an aircraft charges: a real cable, not a line drawn
// on the deck. It leaves the cabinet's cable track (mid-height, right round
// the cabinet body) on the side that looks at the stand, droops to the deck,
// runs along it and rises into the port on the aircraft's side, where a plug
// sits against the fuselage.
//
// Display only. The server says which cabinet feeds which aircraft and where
// the socket is (`charging_connection`), the vertiport layer says where that
// cabinet's body stands and how tall it is, and the aircraft's own package
// says where its port is. Nothing here decides any of it.
const METRES_PER_DEGREE = 111319.49;
export const CABLE_RADIUS_M = .024;
export const CABLE_SIDES = 8;
// The plug: along the cable, across, high (metres).
export const PLUG_SIZE_M = [.14, .09, .07];
// The cabinet body inside its footprint, as a half side in the model's unit
// frame (see build_vertiport_facilities.py: the cladding spans x -.385..0.185
// and z -.23..0.33 around its offset centre, and the cable track band stands
// proud to +/-.205 of the body's own centre). A half side within the band
// for every heading, so the cable leaves through the wall rather than from
// the empty footprint edge.
export const CABINET_BODY_HALF = .19;
const RUBBER = [.03, .032, .035];
const PLUG = [.22, .25, .27];
const KEY_DIGITS = 8;

// The cable's route as [longitude, latitude, altitude] points, with the port
// it ends in and the deck it lies on, or null while there is nothing to draw.
// `lift` is the terrain registration the aircraft is drawn with; `cabinet`
// (optional) is where the cabinet body stands: {longitude, latitude,
// altitude of its cable track, side, heading_deg}.
export function cableGeometry(entity, lift = 0, cabinet = null) {
  const c = entity.charging_connection;
  if (!c || entity.flight_phase !== 'parked' || entity.source !== 'scenario') return null;
  const values = [entity.longitude_deg, entity.latitude_deg, entity.altitude_m, c.longitude_deg, c.latitude_deg, c.altitude_m, c.port_right_m, c.port_height_m, lift];
  if (!values.every(Number.isFinite)) return null;
  const eastScale = METRES_PER_DEGREE * Math.cos(entity.latitude_deg * Math.PI / 180);
  if (Math.abs(eastScale) < 1) return null;
  const dx = (c.longitude_deg - entity.longitude_deg) * eastScale, dy = (c.latitude_deg - entity.latitude_deg) * METRES_PER_DEGREE;
  if (Math.hypot(dx, dy) > 50) return null;
  const deck = entity.altitude_m + lift;
  // The port is on the side of the aircraft the cabinet is on.
  const heading = (entity.heading_deg ?? 0) * Math.PI / 180;
  const sign = (dx * Math.cos(heading) - dy * Math.sin(heading)) >= 0 ? 1 : -1;
  const right = sign * c.port_right_m;
  const port = [entity.longitude_deg + Math.cos(heading) * right / eastScale,
    entity.latitude_deg - Math.sin(heading) * right / METRES_PER_DEGREE, deck + c.port_height_m];
  // The outlet: where the line from the cabinet's centre to the port leaves
  // the cabinet body, at the height of its cable track. Without the cabinet,
  // the server's socket on the footprint face.
  let outlet = [c.longitude_deg, c.latitude_deg, c.altitude_m + lift];
  if (cabinet && [cabinet.longitude, cabinet.latitude, cabinet.altitude, cabinet.side].every(Number.isFinite) && cabinet.side > 0) {
    const east = (port[0] - cabinet.longitude) * eastScale, north = (port[1] - cabinet.latitude) * METRES_PER_DEGREE;
    // Into the cabinet's own frame (a heading turns the body clockwise from north).
    const turn = (Number(cabinet.heading_deg) || 0) * Math.PI / 180;
    const bx = east * Math.cos(turn) - north * Math.sin(turn), by = east * Math.sin(turn) + north * Math.cos(turn);
    const half = CABINET_BODY_HALF * cabinet.side, reach = Math.hypot(east, north);
    // On the wall toward the port; a port inside the body (nothing real, but
    // a layout can say so) still leaves the cable a short way to run.
    const t = Math.min(half / Math.max(Math.abs(bx), Math.abs(by), .01), Math.max(0, 1 - .3 / Math.max(reach, .01)));
    outlet = [cabinet.longitude + east * t / eastScale, cabinet.latitude + north * t / METRES_PER_DEGREE, cabinet.altitude];
  }
  const east = (port[0] - outlet[0]) * eastScale, north = (port[1] - outlet[1]) * METRES_PER_DEGREE;
  const length = Math.hypot(east, north);
  if (!(length > .05)) return null;
  const along = [east / length, north / length];
  const radius = CABLE_RADIUS_M, low = deck + radius, high = outlet[2];
  // The route in two dimensions: distance along the cable's line, height.
  const route = [[0, high]];
  const stub = Math.min(.3, length * .15);
  route.push([stub, high]);
  const curve = (a, b, c2, d, n) => {
    for (let i = 1; i <= n; i++) {
      const t = i / n, s = 1 - t;
      route.push([s * s * s * a[0] + 3 * s * s * t * b[0] + 3 * s * t * t * c2[0] + t * t * t * d[0],
        s * s * s * a[1] + 3 * s * s * t * b[1] + 3 * s * t * t * c2[1] + t * t * t * d[1]]);
    }
  };
  // The last few centimetres run level into the port, so the plug sits square
  // against the fuselage.
  const entry = Math.min(.06, length * .1), end = length - entry;
  const reach = Math.min(1.5, length * .4), run = Math.min(1.2, length * .35);
  if (stub + reach + run + .2 >= end) {
    // Too close for a run along the deck: one sag from the outlet to the port.
    const span = end - stub, sag = Math.min(high, port[2], low + .1);
    curve([stub, high], [stub + span * .35, sag], [end - span * .35, sag], [end, port[2]], 10);
  } else {
    curve([stub, high], [stub + reach * .55, high], [stub + reach * .45, low], [stub + reach, low], 7);
    route.push([end - run, low]);
    curve([end - run, low], [end - run * .55, low], [end - run * .45, port[2]], [end, port[2]], 7);
  }
  route.push([length, port[2]]);
  const points = route.map(([d, z]) => [outlet[0] + along[0] * d / eastScale, outlet[1] + along[1] * d / METRES_PER_DEGREE, z]);
  return {points, port, along, outlet, deck, radius};
}

// Vector helpers on plain {x, y, z} objects, so the mesh is built without
// the engine (and tested without it).
const sub = (a, b) => ({x: a.x - b.x, y: a.y - b.y, z: a.z - b.z});
const add = (a, b) => ({x: a.x + b.x, y: a.y + b.y, z: a.z + b.z});
const scale = (a, s) => ({x: a.x * s, y: a.y * s, z: a.z * s});
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x});
const norm = a => {const m = Math.hypot(a.x, a.y, a.z); return m > 0 ? scale(a, 1 / m) : {x: 0, y: 0, z: 0};};

class Mesh {
  constructor() {this.positions = []; this.normals = []; this.indices = [];}
  vertex(p, n) {this.positions.push(p.x, p.y, p.z); this.normals.push(n.x, n.y, n.z); return this.positions.length / 3 - 1;}
}

// A tube of `sides` facets along `points`, its rings turned smoothly from
// one segment to the next (a parallel-transported frame, so it never twists).
export function tubeMesh(points, radius, sides, mesh = new Mesh()) {
  const n = points.length;
  if (n < 2) return mesh;
  const segments = [];
  for (let i = 0; i < n - 1; i++) segments.push(norm(sub(points[i + 1], points[i])));
  const tangents = points.map((_, i) => i === 0 ? segments[0] : i === n - 1 ? segments[n - 2] : norm(add(segments[i - 1], segments[i])));
  // The first ring is set against the radial (near enough up on the ground);
  // failing that, against whichever axis the cable runs least along.
  let helper = norm(points[0]);
  if (Math.hypot(helper.x, helper.y, helper.z) < .5 || Math.abs(dot(helper, tangents[0])) > .9) {
    const t = tangents[0], axes = [{x: 1, y: 0, z: 0}, {x: 0, y: 1, z: 0}, {x: 0, y: 0, z: 1}];
    helper = axes[[Math.abs(t.x), Math.abs(t.y), Math.abs(t.z)].indexOf(Math.min(Math.abs(t.x), Math.abs(t.y), Math.abs(t.z)))];
  }
  let u = norm(cross(tangents[0], helper));
  const rings = [];
  for (let i = 0; i < n; i++) {
    const t = tangents[i];
    u = norm(sub(u, scale(t, dot(u, t))));
    const v = cross(t, u);
    const ring = [];
    for (let j = 0; j < sides; j++) {
      const a = 2 * Math.PI * j / sides;
      const normal = add(scale(u, Math.cos(a)), scale(v, Math.sin(a)));
      ring.push(mesh.vertex(add(points[i], scale(normal, radius)), normal));
    }
    rings.push(ring);
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < sides; j++) {
    const k = (j + 1) % sides;
    const a = rings[i][j], b = rings[i][k], c = rings[i + 1][k], d = rings[i + 1][j];
    mesh.indices.push(a, b, c, a, c, d);
  }
  return mesh;
}

// A box around `center` with its edges along the three unit `axes`.
export function boxMesh(center, axes, size, mesh = new Mesh()) {
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    for (const sign of [-1, 1]) {
      const normal = scale(axes[axis], sign);
      const corners = [];
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        corners.push(add(add(add(center, scale(axes[axis], sign * size[axis] / 2)), scale(axes[u], a * size[u] / 2)), scale(axes[v], b * size[v] / 2)));
      }
      if (sign < 0) corners.reverse();
      const first = corners.map(p => mesh.vertex(p, normal));
      mesh.indices.push(first[0], first[1], first[2], first[0], first[2], first[3]);
    }
  }
  return mesh;
}

function toGeometry(C, mesh) {
  return new C.Geometry({
    attributes: {
      position: new C.GeometryAttribute({componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: new Float64Array(mesh.positions)}),
      normal: new C.GeometryAttribute({componentDatatype: C.ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: new Float32Array(mesh.normals)}),
    },
    indices: new Uint16Array(mesh.indices),
    primitiveType: C.PrimitiveType.TRIANGLES,
    boundingSphere: C.BoundingSphere.fromVertices(mesh.positions),
  });
}

// The cable and its plug as one primitive: the tube along the route, the plug
// against the fuselage at the port, pointing the way the cable arrives.
export function cablePrimitive(C, geometry) {
  const points = geometry.points.map(p => C.Cartesian3.fromDegrees(p[0], p[1], p[2]));
  const tube = tubeMesh(points, geometry.radius, CABLE_SIDES);
  const port = points[points.length - 1];
  // Level, whatever the last sample's slope: square to the fuselage side.
  // A right-handed frame (along x across = up), or every face of the box
  // would wind clockwise and be culled as a back face.
  let up = norm(port), along = norm(sub(port, points[points.length - 2]));
  along = norm(sub(along, scale(up, dot(along, up))));
  const across = norm(cross(up, along));
  up = cross(along, across);
  const [length, width, height] = PLUG_SIZE_M;
  const plug = boxMesh(sub(port, scale(along, length / 2 - .01)), [along, across, up], [length, width, height]);
  const colour = rgb => C.ColorGeometryInstanceAttribute.fromColor(new C.Color(rgb[0], rgb[1], rgb[2], 1));
  return new C.Primitive({
    geometryInstances: [
      new C.GeometryInstance({geometry: toGeometry(C, tube), attributes: {color: colour(RUBBER)}}),
      new C.GeometryInstance({geometry: toGeometry(C, plug), attributes: {color: colour(PLUG)}}),
    ],
    appearance: new C.PerInstanceColorAppearance({translucent: false, closed: true}),
    // Never picked: a hit on the cable answers with no id, which the slack
    // pick around a small aircraft would take for 'something else here' and
    // the hover for nothing at all. The warm-up draws this same unpicked
    // program (globe.js, 'cable') so the first cable compiles nothing.
    asynchronous: false, allowPicking: false,
  });
}

const keyOf = geometry => JSON.stringify(geometry.points.map(p => p.map(v => Number(v.toFixed(KEY_DIGITS)))));

export class ChargingCables {
  // `cabinet(connection)` answers where the cabinet body of a connection
  // stands (see VertiportLayer.chargerCabinet), or null.
  constructor(C, viewer, {cabinet = null} = {}) {this.C = C; this.viewer = viewer; this.items = new Map(); this.cabinet = cabinet;}
  retain(entities) {
    const active = new Set([...entities].filter(e => e.charging_connection && e.flight_phase === 'parked').map(e => e.entity_id));
    for (const id of this.items.keys()) if (!active.has(id)) this.remove(id);
  }
  remove(id) {
    const item = this.items.get(id);
    if (!item) return;
    this.viewer.scene.primitives.remove(item.primitive);
    this.items.delete(id);
  }
  update(items, visible, liftOf) {
    const C = this.C;
    if (!C.Primitive || !C.Geometry || !C.GeometryInstance || !C.Cartesian3?.fromDegrees) return;
    const active = new Set();
    for (const item of items) {
      if (!visible(item) || item.lod !== 'model' || !item.model?.show || !item.entity.charging_connection) continue;
      const cabinet = this.cabinet ? this.cabinet(item.entity.charging_connection) : null;
      const geometry = cableGeometry(item.entity, liftOf(item), cabinet);
      if (!geometry) continue;
      const id = item.entity.entity_id;
      active.add(id);
      const key = keyOf(geometry);
      const entry = this.items.get(id);
      if (entry && entry.key === key) continue;
      if (entry) this.viewer.scene.primitives.remove(entry.primitive);
      this.items.set(id, {key, primitive: this.viewer.scene.primitives.add(cablePrimitive(C, geometry))});
    }
    for (const id of this.items.keys()) if (!active.has(id)) this.remove(id);
  }
  destroy() {
    for (const item of this.items.values()) this.viewer.scene.primitives.remove(item.primitive);
    this.items.clear();
  }
}
