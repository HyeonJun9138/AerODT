// World-space annotations obey depth: aircraft and opaque geometry occlude them.
// Draws the route network on the globe: waypoints as points at their
// altitude (sized like the satellites, a little larger), the FATO endpoints of
// every vertiport as a vertical take-off or landing column over the deck,
// cruise links as translucent corridors that meet in rounded hubs, and the
// other profile segments as lines along the same height profile. Geometry
// comes from route_geometry.js; this layer resolves ground and deck heights,
// converts to world positions and draws. It holds no definitions of its own:
// the network it is shown is the truth. Hover and selection change colours in
// place rather than redrawing, so pointing at things costs nothing.
import {bearing, corridorMesh, distanceMetres, hubMesh, hubRadius, neighbourClips, profilePositions} from './route_geometry.js';
import {groundMarkerPixels} from './render_policy.js';

export const NODE_PIXELS = 9;
export const NODE_PIXELS_HOVER = 12;
// A waypoint is a place in the air, not a dot on a screen: it is drawn at this
// size on the ground, so zooming out shrinks it the way the map under it
// shrinks. The pixel sizes above are what it is drawn at close in, where the
// ground size would be larger than the symbol; this is the smallest it goes, so
// a network seen whole still reads as waypoints joined by links rather than a
// heap of overlapping blobs.
export const NODE_GROUND_METRES = 120;
export const NODE_PIXELS_MIN = 3;
export const FATO_NODE_RADIUS_M = 10;
export const FILL_ALPHA = .32;
export const FILL_ALPHA_HOVER = .5;
export const FILL_ALPHA_SELECTED = .62;
export const LINE_WIDTH = 3.5;
// Colours per segment, the same as the server's options; a segment the server
// names that is not here is drawn in the cruise colour.
// The three runs of the profile, plus the letters they absorbed so a link
// saved before they were joined still draws in its own colour.
export const SEGMENT_COLORS = {C: '#ffb457', F: '#7fe9f5', G: '#a5c8ff',
  D: '#ffb457', E: '#ffb457', H: '#a5c8ff', I: '#a5c8ff'};
export const CORRIDOR_SEGMENT = 'F';
// The tints the painted deck gives each FATO role, so the column over a FATO matches it.
const ROLE_COLORS = {takeoff: '#6edc96', landing: '#78beff', both: '#c9eef5'};
const NODE_COLOR = '#e6f7fb';
const HOVER_COLOR = '#ffffff';
const SELECTED_COLOR = '#fff2a8';
// A waypoint on its way somewhere else: what it is leaving, drawn faint.
const MOVING_ALPHA = .3;
// A waypoint that cannot be joined to the selected one, because the pair is
// already linked: drawn faint and small so the eye skips it.
const BLOCKED_ALPHA = .28;
// A link the buildings under it have something to say about, with the worst
// building named where it stands.
//
// Both warnings are red: through a building strongly, close over one lightly.
// Amber was too near the climb colour above (#ffb457), so a descent that ran
// close over a roof read as a climb segment and the operator reasonably
// concluded the segment had not saved. A warning has to look like a warning
// and like nothing else on the map.
export const CONFLICT_COLOR = '#ff4d4d';
export const TIGHT_COLOR = '#ff9a9a';
export const PROBLEM_COLOR = '#ffa552';
export const CONFLICT_LABEL_FAR_METRES = 40000;
// A route is local infrastructure over the ground it crosses, not something to
// read from orbit: past this camera distance none of it is drawn, so a
// continental view shows the map rather than a network of dots. 200 km up is
// the whole metropolitan area in one view — where the network is looked at as
// a network — and this is the distance the vertiport markers leave at too, so
// the ports and the routes between them appear and go together. It is a camera
// distance rather than an altitude, and from 200 km over Seoul the network
// measures 199.5–205.7 km away, so the limit carries the headroom a tilted view
// of the same height needs. The names go long before that: the link names
// first, then the waypoint names, then the geometry itself, because text is
// what knots up at a distance, not lines.
export const VISIBLE_METRES = 260000;
export const LABEL_FAR_METRES = 25000;
export const LINK_LABEL_FAR_METRES = 18000;
const FEET_PER_METRE = 1 / .3048;

// The width a link is drawn with: only a cruise corridor has one.
export function corridorWidth(link) {
  const width = Number(link.width_m);
  return link.segment === CORRIDOR_SEGMENT && Number.isFinite(width) && width > 0 ? width : 0;
}

// Half-width of the widest corridor at a node; zero for a node with only lines.
export function hubRadiusAt(id, links) {
  return hubRadius(links.filter(link => link.from === id || link.to === id).map(corridorWidth), 0);
}

// The absolute height a node is drawn at: over the ground for AGL, as given
// for absolute; a FATO endpoint hovers over its deck.
export function nodeHeight(node, ground, deckTop = null) {
  if (node.kind === 'fato') {
    const base = Number.isFinite(deckTop) ? deckTop : (ground ?? 0) + (Number(node.platform_height_m) || 0);
    const field = node.role === 'landing' ? 'landing_height_m' : 'takeoff_height_m';
    return base + (Number(node[field] ?? node.hover_m ?? 30) || 0);
  }
  const altitude = Number(node.altitude_m) || 0;
  return node.altitude_reference === 'msl' ? altitude : (ground ?? 0) + altitude;
}

export function altitudeText(node) {
  const metres = Number(node.altitude_m) || 0;
  const reference = node.altitude_reference === 'msl' ? '절대' : 'AGL';
  return `${Math.round(metres * FEET_PER_METRE).toLocaleString()} ft · ${Math.round(metres)} m ${reference}`;
}

function mixColors(colors) {
  if (!colors.length) return NODE_COLOR;
  const parts = colors.map(css => [1, 3, 5].map(i => parseInt(css.slice(i, i + 2), 16)));
  const mean = [0, 1, 2].map(k => Math.round(parts.reduce((sum, p) => sum + p[k], 0) / parts.length));
  return '#' + mean.map(v => v.toString(16).padStart(2, '0')).join('');
}

// How much of itself the network keeps while another tool owns the map.
export const QUIET_ALPHA = 0.22;

export class RouteLayer {
  // `groundHeights` answers terrain heights for a list of {longitude, latitude};
  // `deckTop(vertiportId)` the deck height of a placed vertiport or null.
  constructor(C, viewer, {groundHeights = async points => points.map(() => 0), deckTop = () => null, fadeIn = false} = {}) {
    this.C = C; this.entities = viewer.entities; this.scene = viewer.scene;
    this.groundHeights = groundHeights; this.deckTop = deckTop;
    this.fadeIn = fadeIn;
    this.network = null; this.segments = {...SEGMENT_COLORS};
    this.owned = []; this.primitive = null; this.placed = new Map();
    // What each drawn thing is, so hover and selection can restyle it in place.
    this.markers = new Map(); this.lines = new Map(); this.fills = new Map(); this.drop = null;
    this.visible = true; this.selected = null; this.hovered = null; this.version = 0;
    // The waypoints the selection cannot be joined to, and the pair a card is
    // asking about, drawn between them until it is answered.
    this.blocked = new Set(); this.previewPair = null; this.previewEntities = [];
    // What the last building check said about each link, by link id, kept
    // across redraws until the link is checked again or goes.
    this.conflicts = new Map(); this.conflictEntities = [];
    // How much larger than its design size each name is drawn, from the display
    // setting. Every label carries the size it was designed at, so a change is
    // a font written over the labels that exist rather than a redraw.
    this.labelScale = 1;
    // Faint background mode, and the operator's own label setting kept apart
    // from what is on screen while it is on.
    this.quiet = false; this.labelsWanted = true; this.labelsVisible = true;
    // How much ground one pixel covers where the network is, so the markers can
    // be drawn at a size on the ground instead of a size on the screen. Zero
    // until the camera has said, which draws them at their symbol size.
    this.metresPerPixel = 0;
    // A corridor's colour attribute can only be written once the primitive has
    // been through a frame, so a restyle that came too early is finished after
    // the next render rather than lost.
    this.fillsPending = false;
    this.onRendered = () => {if (this.fillsPending && this.primitive?.ready) this.restyle();};
    this.scene.postRender?.addEventListener?.(this.onRendered);
  }
  color(css, alpha) {return this.C.Color.fromCssColorString(css).withAlpha(alpha * (this.quiet ? QUIET_ALPHA : 1));}
  // The camera moved: the markers are re-sized where they stand. A change too
  // small to see is not worth the restyle, so drifting costs nothing.
  setPixelScale(metresPerPixel) {
    const value = Number.isFinite(metresPerPixel) && metresPerPixel > 0 ? metresPerPixel : 0;
    // Nothing to measure with — a hidden tab has no canvas — so the markers
    // keep the size they had rather than snapping back to their symbol size.
    if (!value) return false;
    if (Math.abs(value - this.metresPerPixel) <= this.metresPerPixel * .02) return false;
    const previous=this.nodeScale();
    this.metresPerPixel = value;
    if(this.nodeScale()===previous)return false;
    // Zoom changes pixel dimensions, not materials, conflict geometry or picks.
    // Full restyle here rebuilt annotations throughout every camera approach.
    const scale=this.nodeScale();
    for(const [id,{entity}] of this.markers){
      const selected=this.selected===id || this.previewPair?.from===id || this.previewPair?.to===id;
      const hovered=this.hovered?.kind==='node' && this.hovered.id===id;
      const leaving=this.moving?.id===id,blocked=!selected&&!leaving&&this.blocked.has(id);
      entity.point.pixelSize=scale*(leaving||blocked?NODE_PIXELS-2:selected||hovered?NODE_PIXELS_HOVER:NODE_PIXELS);
      entity.point.outlineWidth=scale*(!leaving&&!blocked&&selected?4:2);
    }
    return true;
  }
  // How wide a waypoint marker is now, and how much of its symbol size that is:
  // hover, selection and the faint states keep their proportions as it shrinks.
  nodePixels() {return groundMarkerPixels(NODE_GROUND_METRES, this.metresPerPixel, {min: NODE_PIXELS_MIN, max: NODE_PIXELS});}
  nodeScale() {return this.nodePixels() / NODE_PIXELS;}
  // How near the camera must be for something to be drawn at all.
  within(far = VISIBLE_METRES) {return new this.C.DistanceDisplayCondition(0, far);}
  // The same limit for a geometry instance inside the shared primitive.
  instanceRange() {
    const attribute = this.C.DistanceDisplayConditionGeometryInstanceAttribute;
    return attribute ? {distanceDisplayCondition: attribute.fromDistanceDisplayCondition(this.within())} : {};
  }
  segmentColor(segment) {return this.segments[segment] ?? SEGMENT_COLORS.F;}
  // The colour a link is drawn in: what the buildings said first, then
  // whether it still fits its FATO, then its segment.
  linkColor(id, css) {
    const report = this.conflicts.get(id);
    if (report?.collisions > 0) return CONFLICT_COLOR;
    if (report?.tight > 0) return TIGHT_COLOR;
    if (this.problems?.has(id)) return PROBLEM_COLOR;
    return css;
  }
  // The building check's word on some links: {linkId: report}. Links not
  // named keep what they had; a null report clears one.
  setConflicts(reports) {
    for (const [id, report] of Object.entries(reports ?? {})) {
      if (report) this.conflicts.set(id, report); else this.conflicts.delete(id);
    }
    if (this.network) this.restyle();
  }
  clearConflicts() {this.conflicts.clear(); if (this.network) this.restyle();}
  // The map shows exactly this network; `segments` may carry the server's colours.
  async show(network, segments = null) {
    this.network = network;
    if (segments) this.segments = {...SEGMENT_COLORS, ...Object.fromEntries(segments.map(s => [s.id, s.color]))};
    // A link that went takes its report with it; the rest keep theirs.
    const ids = new Set((network?.links ?? []).map(link => link.id));
    for (const id of [...this.conflicts.keys()]) if (!ids.has(id)) this.conflicts.delete(id);
    this.problems = new Set((network?.links ?? []).filter(link => link.problem).map(link => link.id));
    if (await this.resolve() === false) return;
    this.draw();
  }
  // Terrain or a vertiport moved: every height is measured again.
  refresh() {return this.network ? this.show(this.network) : Promise.resolve();}
  endpoints() {return [...(this.network?.nodes ?? []), ...(this.network?.fatos ?? [])];}
  async resolve() {
    const version = ++this.version;
    const nodes = this.endpoints();
    let heights = [];
    try {heights = (await this.groundHeights(nodes.map(n => ({longitude: n.longitude, latitude: n.latitude})))) ?? [];} catch {heights = [];}
    if (version !== this.version) return false;
    this.placed = new Map();
    nodes.forEach((node, index) => {
      const ground = Number.isFinite(heights[index]) ? heights[index] : 0;
      const deck = node.kind === 'fato' ? this.deckTop(node.vertiport) : null;
      const height = nodeHeight(node, ground, deck);
      this.placed.set(node.id, {node, longitude: node.longitude, latitude: node.latitude, height, ground,
        base: node.kind === 'fato' ? (Number.isFinite(deck) ? deck : ground + (Number(node.platform_height_m) || 0)) : ground});
    });
  }
  // Direction belongs to the link, not a both-role FATO marker.
  linkEndpoints(link, {vertiportId = null, heights = null} = {}) {
    const endpoint = (id, field) => {
      const place = this.placed.get(id);
      if (!place || place.node.kind !== 'fato') return place;
      const source = place.node.vertiport === vertiportId && heights ? heights : place.node;
      const value = Number(source[field] ?? place.node[field] ?? place.node.hover_m ?? 30);
      return {...place, height: place.base + value};
    };
    return {from: endpoint(link.from, 'takeoff_height_m'), to: endpoint(link.to, 'landing_height_m')};
  }
  previewVertiportHeights(vertiportId = null, heights = null) {
    this.heightPreview = vertiportId && heights ? {vertiportId, heights: {...heights}} : null;
    this.heightPreviewConflicts = {};
    this.drawHeightPreview();
  }
  setHeightPreviewConflicts(reports) {
    this.heightPreviewConflicts = reports ?? {};
    this.drawHeightPreview();
  }
  drawHeightPreview() {
    for (const entity of this.heightPreviewEntities ?? []) {
      this.entities.remove(entity); this.owned = this.owned.filter(item => item !== entity);
    }
    this.heightPreviewEntities = [];
    if (!this.heightPreview) return;
    const C = this.C, options = this.heightPreview;
    const addLine = (positions, css) => this.heightPreviewEntities.push(this.add({polyline: {
      positions: this.world(positions), width: LINE_WIDTH + 1,
      material: new C.PolylineDashMaterialProperty({color: this.color(css, .95), dashLength: 14}),
      arcType: C.ArcType?.NONE, distanceDisplayCondition: this.within()}}));
    for (const link of this.network?.links ?? []) {
      if (![link.from, link.to].some(id => this.placed.get(id)?.node.vertiport === options.vertiportId)) continue;
      const {from, to} = this.linkEndpoints(link, options);
      if (!from || !to) continue;
      const report = this.heightPreviewConflicts?.[link.id];
      const css = report?.collisions > 0 || report?.terrain_collisions > 0 ? CONFLICT_COLOR : report?.tight > 0 ? TIGHT_COLOR : SELECTED_COLOR;
      addLine(profilePositions(from, to), css);
      for (const place of [from, to]) if (place.node.vertiport === options.vertiportId) {
        addLine([[place.longitude, place.latitude, place.base], [place.longitude, place.latitude, place.height]], css);
      }
    }
  }
  // Where a node stands, as the map placed it, for the panel's cards and camera.
  position(id) {return this.placed.get(id) ?? null;}
  clear() {
    this.revision=(this.revision??0)+1;
    this.fadeMeshes=[];
    for (const entity of this.owned) this.entities.remove(entity);
    this.owned = []; this.markers = new Map(); this.lines = new Map(); this.fills = new Map(); this.drop = null; this.ghost = []; this.previewEntities = []; this.conflictEntities = []; this.heightPreviewEntities = [];
    if (this.primitive) {this.scene.primitives.remove(this.primitive); this.primitive = null;}
  }
  // `revision` counts every change to what is drawn, so a caller can tell an
  // unchanged network from a redrawn one without comparing entities.
  add(description) {const entity = this.entities.add(description); entity.show = this.visible;if(entity.label)entity.label.show=this.labelsVisible!==false; this.owned.push(entity); this.revision=(this.revision??0)+1; return entity;}
  setLabelsVisible(value) {this.labelsWanted = Boolean(value); return this.applyLabels();}
  applyLabels() {
    // Names are the first thing to go when the network is only background:
    // a hundred link names over another layer's work is what makes it unreadable.
    const show = this.labelsWanted !== false && !this.quiet;
    if (this.labelsVisible === show) return false;
    this.labelsVisible = show;
    for (const entity of this.owned) if (entity.label) entity.label.show = show;
    return true;
  }
  // The network drawn as background while another tool owns the map: the same
  // network, faint and unnamed, so it can still be seen but not read as the
  // thing being worked on. It is not hidden — the operator has to keep their
  // bearings — and nothing about the network itself changes.
  setQuiet(quiet) {
    const value = Boolean(quiet);
    if (this.quiet === value) return false;
    this.quiet = value;
    this.applyLabels();
    if (this.network) this.restyle();
    return true;
  }
  world(points) {return points.map(([lon, lat, h]) => this.C.Cartesian3.fromDegrees(lon, lat, h));}
  meshInstance(mesh, css, alpha, id) {
    const mid=mesh.positions[Math.floor(mesh.positions.length/2)];
    const C = this.C;
    const color = C.ColorGeometryInstanceAttribute.fromColor(this.color(css, alpha));
    const item = {id,position:C.Cartesian3.fromDegrees(...mid)};
    // ready becomes true AFTER the first draw. Seed that first draw transparent
    // rather than waiting one frame to discover and fade a full-colour mesh.
    if (this.fadeIn) {item.base=Array.from(color.value);color.value[3]=0;item.applied=Array.from(color.value);}
    (this.fadeMeshes??=[]).push(item);
    const values = new Float64Array(mesh.positions.length * 3);
    this.world(mesh.positions).forEach((p, i) => {values[3 * i] = p.x; values[3 * i + 1] = p.y; values[3 * i + 2] = p.z;});
    const indices = values.length / 3 > 65535 ? new Uint32Array(mesh.indices) : new Uint16Array(mesh.indices);
    const geometry = new C.Geometry({
      attributes: {position: new C.GeometryAttribute({componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values})},
      indices, primitiveType: C.PrimitiveType.TRIANGLES, boundingSphere: C.BoundingSphere.fromVertices(values)});
    return new C.GeometryInstance({geometry, id,
      attributes: {color, ...this.instanceRange()}});
  }
  labelFont(size) {return `600 ${Math.round(size * this.labelScale * 10) / 10}px sans-serif`;}
  // Names are drawn at the operator's size; null or an unusable value is ignored.
  setLabelScale(scale) {
    const next = Number(scale);
    if (!Number.isFinite(next) || next <= 0 || next === this.labelScale) return false;
    this.labelScale = next;
    for (const entity of this.owned) if (entity.label && entity.aerodtLabelSize) entity.label.font = this.labelFont(entity.aerodtLabelSize);
    return true;
  }
  label(position, text, {size = 12, color = '#ffffff', offsetY = 0, far = LABEL_FAR_METRES, near = 0} = {}) {
    const C = this.C;
    return {aerodtLabelSize: size, label: {text, font: this.labelFont(size), fillColor: this.color(color, 1), outlineColor: this.color('#06121a', .9), outlineWidth: 3,
      style: C.LabelStyle.FILL_AND_OUTLINE, verticalOrigin: C.VerticalOrigin.BOTTOM, pixelOffset: new C.Cartesian2(0, offsetY),
      disableDepthTestDistance: 0, distanceDisplayCondition: new C.DistanceDisplayCondition(near, far),
      scaleByDistance: new C.NearFarScalar(1000, 1, LABEL_FAR_METRES, .5)}, position};
  }
  draw() {
    this.clear();
    if (!this.network) return;
    const C = this.C;
    const links = (this.network.links ?? []).filter(link => this.placed.has(link.from) && this.placed.has(link.to));
    const hubs = new Map();
    for (const [id] of this.placed) hubs.set(id, hubRadiusAt(id, links));
    // Every corridor mouth at every node, so each corridor knows its neighbours.
    const mouths = new Map();
    const corridors = links.filter(link => corridorWidth(link) > 0);
    for (const link of corridors) {
      const from = this.placed.get(link.from), to = this.placed.get(link.to), half = corridorWidth(link) / 2;
      for (const [id, angle] of [[link.from, bearing(from, to)], [link.to, bearing(to, from)]]) {
        if (!mouths.has(id)) mouths.set(id, []);
        mouths.get(id).push({link: link.id, angle, halfWidth: half, css: this.segmentColor(link.segment)});
      }
    }
    const clips = new Map();
    for (const [id, at] of mouths) {
      const found = neighbourClips(at);
      at.forEach((mouth, index) => clips.set(`${mouth.link}@${id}`, found[index]));
    }
    const instances = [];
    for (const link of corridors) {
      const {from, to} = this.linkEndpoints(link);
      const mesh = corridorMesh(from, to, corridorWidth(link), {fromHub: hubs.get(link.from), toHub: hubs.get(link.to),
        fromClip: clips.get(`${link.id}@${link.from}`), toClip: clips.get(`${link.id}@${link.to}`)});
      if (!mesh) continue;
      const css = this.segmentColor(link.segment);
      instances.push(this.meshInstance(mesh, css, FILL_ALPHA, `link:${link.id}`));
      this.fills.set(link.id, {id: `link:${link.id}`, css});
      const mid = mesh.positions[Math.floor(mesh.positions.length / 2)];
      this.add({...this.label(C.Cartesian3.fromDegrees(mid[0], mid[1], mid[2] + 4), `${link.segment} · ${link.name}`, {size: 11, color: css, far: LINK_LABEL_FAR_METRES}),
        aerodtRoute: {kind: 'link', id: link.id}});
    }
    for (const link of links) {
      if (corridorWidth(link) > 0) continue;
      const {from, to} = this.linkEndpoints(link);
      if (distanceMetres(from, to) < 1e-3) continue;
      const css = this.segmentColor(link.segment);
      const positions = profilePositions(from, to);
      const line = this.add({polyline: {positions: this.world(positions), width: LINE_WIDTH, material: this.color(css, .85), arcType: C.ArcType?.NONE,
        distanceDisplayCondition: this.within()}, aerodtRoute: {kind: 'link', id: link.id}});
      this.lines.set(link.id, {entity: line, css, positions});
      const mid = positions[Math.floor(positions.length / 2)];
      this.add({...this.label(C.Cartesian3.fromDegrees(mid[0], mid[1], mid[2] + 4), `${link.segment} · ${link.name}`, {size: 11, color: css, far: LINK_LABEL_FAR_METRES}),
        aerodtRoute: {kind: 'link', id: link.id}});
    }
    for (const [id, place] of this.placed) {
      const at = mouths.get(id) ?? [];
      const radius = hubs.get(id);
      if (at.length && radius > 0) {
        const css = mixColors(at.map(m => m.css));
        instances.push(this.meshInstance(hubMesh(place, radius), css, FILL_ALPHA, `hub:${id}`));
      }
      this.drawNode(place);
    }
    if (instances.length) {
      this.primitive = this.scene.primitives.add(new C.Primitive({geometryInstances: instances, asynchronous: false,
        appearance: new C.PerInstanceColorAppearance({flat: true, translucent: true, closed: false})}));
      this.primitive.show = this.visible;
      this.primitive.aerodtRoute = true;
    }
    this.restyle();
    this.drawHeightPreview();
  }
  drawNode(place) {
    const C = this.C;
    const {node} = place;
    const position = C.Cartesian3.fromDegrees(place.longitude, place.latitude, place.height);
    if (node.kind === 'fato') {
      const css = ROLE_COLORS[node.role] ?? ROLE_COLORS.both;
      const hover = Math.max(1, place.height - place.base);
      // The vertical phase over the FATO: a column from the deck to the hover point.
      this.add({position: C.Cartesian3.fromDegrees(place.longitude, place.latitude, place.base + hover / 2),
        cylinder: {length: hover, topRadius: FATO_NODE_RADIUS_M, bottomRadius: FATO_NODE_RADIUS_M, material: this.color(css, .18),
          outline: true, outlineColor: this.color(css, .5), numberOfVerticalLines: 0, slices: 32,
          distanceDisplayCondition: this.within()},
        aerodtRoute: {kind: 'node', id: node.id}});
      const marker = this.add({position, aerodtRoute: {kind: 'node', id: node.id},
        point: {pixelSize: NODE_PIXELS, color: this.color(css, 1), outlineColor: this.color('#06121a', .9), outlineWidth: 2,
          disableDepthTestDistance: 0, distanceDisplayCondition: this.within()},
        ...this.label(position, `${node.fato} ${node.role === 'takeoff' ? '이륙 B' : node.role === 'landing' ? '착륙 J' : '이착륙 B/J'}`,
          {size: 11, color: css, offsetY: -12, far: LINK_LABEL_FAR_METRES})});
      this.markers.set(node.id, {entity: marker, css});
      const landing = this.linkEndpoints({from: node.id, to: node.id}).to;
      if (node.role === 'both' && landing.height !== place.height) {
        marker.label.text = `${node.fato} 이륙 B`;
        const landingPosition = C.Cartesian3.fromDegrees(place.longitude, place.latitude, landing.height);
        this.add({...this.label(landingPosition, `${node.fato} 착륙 J`, {size: 11, color: ROLE_COLORS.landing, offsetY: -12, far: LINK_LABEL_FAR_METRES}),
          aerodtRoute: {kind: 'node', id: node.id},
          point: {pixelSize: NODE_PIXELS, color: this.color(ROLE_COLORS.landing, 1), disableDepthTestDistance: 0, distanceDisplayCondition: this.within()}});
        this.add({polyline: {positions: this.world([[place.longitude, place.latitude, place.base], [place.longitude, place.latitude, landing.height]]),
          width: LINE_WIDTH, material: this.color(ROLE_COLORS.landing, .65), arcType: C.ArcType?.NONE, distanceDisplayCondition: this.within()},
          aerodtRoute: {kind: 'node', id: node.id}});
      }
      return;
    }
    const marker = this.add({position, aerodtRoute: {kind: 'node', id: node.id},
      point: {pixelSize: NODE_PIXELS, color: this.color(NODE_COLOR, 1), outlineColor: this.color('#06121a', .9), outlineWidth: 2,
        disableDepthTestDistance: 0, distanceDisplayCondition: this.within()},
      ...this.label(position, `${node.name}\n${altitudeText(node)}`, {size: 12, color: NODE_COLOR, offsetY: -12})});
    this.markers.set(node.id, {entity: marker, css: NODE_COLOR});
  }
  // The colours of everything, from the hovered and selected ids. Cheap enough
  // to run on every hover change: nothing is rebuilt.
  restyle() {
    const C = this.C;
    const scale = this.nodeScale();
    for (const [id, {entity, css}] of this.markers) {
      // Both ends of the pair a card is asking about read as chosen, so the
      // line drawn between them is never ambiguous.
      const selected = this.selected === id || this.previewPair?.from === id || this.previewPair?.to === id;
      const hovered = this.hovered?.kind === 'node' && this.hovered.id === id;
      const leaving = this.moving?.id === id;
      const blocked = !selected && !leaving && this.blocked.has(id);
      const color = leaving ? css : selected ? SELECTED_COLOR : hovered ? HOVER_COLOR : css;
      const alpha = leaving ? MOVING_ALPHA : blocked ? BLOCKED_ALPHA : 1;
      entity.point.pixelSize = scale * (leaving || blocked ? NODE_PIXELS - 2 : (selected || hovered) ? NODE_PIXELS_HOVER : NODE_PIXELS);
      entity.point.color = this.color(color, alpha);
      entity.point.outlineColor = leaving || blocked ? this.color('#06121a', .3) : selected ? this.color(SELECTED_COLOR, .55) : this.color('#06121a', .9);
      // The ring is part of the marker: at a distance it thins with it rather
      // than swallowing the dot it is drawn around.
      entity.point.outlineWidth = scale * (!leaving && !blocked && selected ? 4 : 2);
      if (entity.label) entity.label.fillColor = this.color(color, alpha);
    }
    for (const [id, {entity, css}] of this.lines) {
      const hovered = this.hovered?.kind === 'link' && this.hovered.id === id;
      const shown = this.linkColor(id, css);
      entity.polyline.width = hovered ? LINE_WIDTH + 2 : LINE_WIDTH;
      const color = this.color(hovered ? HOVER_COLOR : shown, hovered ? 1 : .85);
      // A link that no longer fits its FATO is dashed, so it reads as a question rather than a route.
      entity.polyline.material = this.problems?.has(id) && C.PolylineDashMaterialProperty
        ? new C.PolylineDashMaterialProperty({color, dashLength: 16}) : color;
    }
    if (this.primitive?.ready !== false && this.primitive?.getGeometryInstanceAttributes) {
      this.fillsPending = false;
      for (const [id, {id: instanceId, css}] of this.fills) {
        const hovered = this.hovered?.kind === 'link' && this.hovered.id === id;
        const attributes = this.primitive.getGeometryInstanceAttributes(instanceId);
        if (attributes) attributes.color = C.ColorGeometryInstanceAttribute.toValue(this.color(this.linkColor(id, css), hovered ? FILL_ALPHA_HOVER : FILL_ALPHA), attributes.color);
      }
    } else if (this.primitive) {
      this.fillsPending = true;
    }
    this.drawConflicts();
    // The selected waypoint shows its height with a dashed line to the ground.
    this.drawMove();
    this.drawPreview();
    if (this.drop) {this.entities.remove(this.drop); this.owned = this.owned.filter(e => e !== this.drop); this.drop = null;}
    const place = this.selected ? this.placed.get(this.selected) : null;
    if (place && place.node.kind !== 'fato') {
      const color = this.color(SELECTED_COLOR, .6);
      const material = C.PolylineDashMaterialProperty ? new C.PolylineDashMaterialProperty({color, dashLength: 12}) : color;
      this.drop = this.add({polyline: {positions: this.world([[place.longitude, place.latitude, place.ground], [place.longitude, place.latitude, place.height]]),
        width: 1.5, material, arcType: C.ArcType?.NONE, distanceDisplayCondition: this.within()}});
    }
  }
  // The worst building under each link the check spoke about, named where it
  // stands: a marker on its top and what the path and the building measure.
  drawConflicts() {
    for (const entity of this.conflictEntities ?? []) {this.entities.remove(entity); this.owned = this.owned.filter(item => item !== entity);}
    this.conflictEntities = [];
    const C = this.C;
    for (const [id, report] of this.conflicts) {
      const worst = report?.buildings?.[0];
      if (!worst?.position || !this.lines.has(id) && !this.fills.has(id)) continue;
      const collision = worst.collision === true;
      const css = collision ? CONFLICT_COLOR : TIGHT_COLOR;
      const top = Number(worst.top_m) || 0;
      const text = `${collision ? '⚠ 건물 충돌' : '△ 건물 근접'} · ${worst.name || '건물'} ${Math.round(worst.height_m)} m\n경로 ${Math.round(worst.path_m)} m · 여유 ${Math.round(worst.clearance_m)} m`;
      this.conflictEntities.push(this.add({position: C.Cartesian3.fromDegrees(worst.position.longitude, worst.position.latitude, top),
        aerodtRoute: {kind: 'link', id},
        point: {pixelSize: 8, color: this.color(css, 1), outlineColor: this.color('#06121a', .9), outlineWidth: 2,
          disableDepthTestDistance: 0, distanceDisplayCondition: this.within(CONFLICT_LABEL_FAR_METRES)},
        ...this.label(C.Cartesian3.fromDegrees(worst.position.longitude, worst.position.latitude, top), text,
          {size: 11, color: css, offsetY: -10, far: CONFLICT_LABEL_FAR_METRES})}));
      this.conflictEntities.push(this.add({polyline: {positions: this.world([[worst.position.longitude, worst.position.latitude, top],
        [worst.position.longitude, worst.position.latitude, Number(worst.path_m) || top]]),
        width: 2, material: this.color(css, .8), arcType: C.ArcType?.NONE, distanceDisplayCondition: this.within(CONFLICT_LABEL_FAR_METRES)}}));
    }
  }
  // The pair a card is asking about, drawn between the two waypoints along the
  // same height profile a real link would take, so which two are being joined
  // is read off the map rather than remembered. It goes when the card is
  // answered or given up.
  drawPreview() {
    for (const entity of this.previewEntities ?? []) {this.entities.remove(entity); this.owned = this.owned.filter(item => item !== entity);}
    this.previewEntities = [];
    const pair = this.previewPair;
    const {from, to} = pair ? this.linkEndpoints(pair) : {};
    if (!from || !to || distanceMetres(from, to) < 1e-3) return;
    const C = this.C;
    const positions = profilePositions(from, to);
    const color = this.color(SELECTED_COLOR, .95);
    const material = C.PolylineDashMaterialProperty ? new C.PolylineDashMaterialProperty({color, dashLength: 14}) : color;
    this.previewEntities.push(this.add({polyline: {positions: this.world(positions), width: LINE_WIDTH, material,
      arcType: C.ArcType?.NONE, distanceDisplayCondition: this.within()}}));
    const mid = positions[Math.floor(positions.length / 2)];
    this.previewEntities.push(this.add(this.label(C.Cartesian3.fromDegrees(mid[0], mid[1], mid[2] + 6),
      `${from.node.name} → ${to.node.name}`, {size: 12, color: SELECTED_COLOR, offsetY: -4})));
  }
  // The pair to draw, or null for none. Returns true when it changed.
  previewLink(from = null, to = null) {
    const next = from && to ? {from, to} : null;
    if ((next?.from ?? null) === (this.previewPair?.from ?? null) && (next?.to ?? null) === (this.previewPair?.to ?? null)) return false;
    this.previewPair = next;
    if (this.network) this.restyle();
    return true;
  }
  // Where the ghost stands for a given cursor pose: the waypoint's own altitude
  // over the ground under the cursor.
  ghostAt(place, pose) {
    const ground = Number.isFinite(pose.height) ? pose.height : place.ground;
    return {ground, target: [pose.longitude, pose.latitude, nodeHeight(place.node, ground, null)]};
  }
  // The ghost, the dashed line back to where the waypoint stands and its drop to
  // the ground. Built once when the waypoint is taken up, then only moved.
  drawMove() {
    for (const entity of this.ghost ?? []) {this.entities.remove(entity); this.owned = this.owned.filter(item => item !== entity);}
    this.ghost = [];
    const place = this.moving ? this.placed.get(this.moving.id) : null;
    if (!place) return;
    const C = this.C;
    const {ground, target} = this.ghostAt(place, this.moving.pose);
    const dashed = C.PolylineDashMaterialProperty
      ? new C.PolylineDashMaterialProperty({color: this.color(SELECTED_COLOR, .55), dashLength: 10}) : this.color(SELECTED_COLOR, .55);
    this.ghost.push(this.add({position: C.Cartesian3.fromDegrees(...target),
      point: {pixelSize: NODE_PIXELS_HOVER * this.nodeScale(), color: this.color(SELECTED_COLOR, .95), outlineColor: this.color('#06121a', .9), outlineWidth: 2 * this.nodeScale(),
        disableDepthTestDistance: 0, distanceDisplayCondition: this.within()},
      ...this.label(C.Cartesian3.fromDegrees(...target), `${place.node.name} → 위치변경`, {size: 12, color: SELECTED_COLOR, offsetY: -12})}));
    this.ghost.push(this.add({polyline: {positions: this.world([[place.longitude, place.latitude, place.height], target]),
      width: 2, material: dashed, arcType: C.ArcType?.NONE, distanceDisplayCondition: this.within()}}));
    this.ghost.push(this.add({polyline: {positions: this.world([[this.moving.pose.longitude, this.moving.pose.latitude, ground], target]),
      width: 1.5, material: dashed, arcType: C.ArcType?.NONE, distanceDisplayCondition: this.within()}}));
  }
  // The same three drawings, moved. Writing a position is all Cesium needs;
  // removing and adding entities on every frame is not.
  placeGhost() {
    const place = this.moving ? this.placed.get(this.moving.id) : null;
    if (!place || this.ghost?.length !== 3) {this.drawMove(); return;}
    const C = this.C;
    const {ground, target} = this.ghostAt(place, this.moving.pose);
    const [marker, back, drop] = this.ghost;
    marker.position = C.Cartesian3.fromDegrees(...target);
    back.polyline.positions = this.world([[place.longitude, place.latitude, place.height], target]);
    drop.polyline.positions = this.world([[this.moving.pose.longitude, this.moving.pose.latitude, ground], target]);
  }
  // What a scene pick landed on: a node or link of this layer, or null.
  pick(picked) {
    const id = picked?.id;
    if (id?.aerodtRoute) return {...id.aerodtRoute};
    if (typeof id === 'string') {
      const [kind, rest] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
      if (kind === 'link' && rest) return {kind: 'link', id: rest};
      if (kind === 'hub' && rest) return {kind: 'node', id: rest};
    }
    return null;
  }
  // A waypoint being moved: the place it is leaving is drawn faint, a ghost
  // follows the cursor and a dashed line joins the two, so the operator sees
  // both where it came from and where it would land. `pose` is the ground under
  // the cursor; null puts everything back.
  moveNode(id, pose) {
    const next = id && pose && Number.isFinite(pose.latitude) ? {id, pose} : null;
    const carried = (next?.id ?? null) === (this.moving?.id ?? null);
    const same = carried && next?.pose?.latitude === this.moving?.pose?.latitude
      && next?.pose?.longitude === this.moving?.pose?.longitude && next?.pose?.height === this.moving?.pose?.height;
    if (same) return false;
    const wasCarrying = Boolean(this.moving), nowCarrying = Boolean(next);
    this.moving = next;
    if (!this.network) return true;
    // A cursor that is still carrying the same waypoint only moves the ghost:
    // restyling every marker, line and corridor on each frame is what made it
    // stutter. Taking it up or putting it down is the only time weight changes.
    if (carried && wasCarrying && nowCarrying) this.placeGhost();
    else this.restyle();
    return true;
  }
  // The selected node is drawn brighter with its drop line; null clears it.
  // `blocked` is the waypoints it cannot be joined to, drawn unavailable.
  select(id, blocked = []) {
    const ids = new Set(blocked);
    const same = this.selected === id && ids.size === this.blocked.size && [...ids].every(item => this.blocked.has(item));
    if (same) return;
    this.selected = id; this.blocked = ids;
    if (this.network) this.restyle();
  }
  // What the pointer is over: {kind, id} or null. Returns true when it changed.
  hover(hit) {
    const same = (hit?.kind ?? null) === (this.hovered?.kind ?? null) && (hit?.id ?? null) === (this.hovered?.id ?? null);
    if (same) return false;
    this.hovered = hit ? {kind: hit.kind, id: hit.id} : null;
    if (this.network) this.restyle();
    return true;
  }
  setVisible(visible) {
    this.visible = Boolean(visible);
    for (const entity of this.owned) entity.show = this.visible;
    if (this.primitive) this.primitive.show = this.visible;
  }
  destroy() {this.clear(); this.network = null; this.scene.postRender?.removeEventListener?.(this.onRendered);}
}

export {distanceMetres};
