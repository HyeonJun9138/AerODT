import test from 'node:test';
import assert from 'node:assert/strict';
import {FATO_NODE_RADIUS_M, FILL_ALPHA, FILL_ALPHA_HOVER, LABEL_FAR_METRES, LINE_WIDTH, LINK_LABEL_FAR_METRES,
  NODE_GROUND_METRES, NODE_PIXELS, NODE_PIXELS_HOVER, NODE_PIXELS_MIN, RouteLayer, VISIBLE_METRES,
  altitudeText, corridorWidth, hubRadiusAt, nodeHeight}
  from '../../../../digital_twin/visualization/web/route_layer.js';

// A stand-in for the pieces of Cesium the layer touches. Positions keep their
// degrees so a test can read where things were put.
class Cartesian3 {constructor(x = 0, y = 0, z = 0) {Object.assign(this, {x, y, z});} static fromDegrees(lon, lat, h = 0) {return new Cartesian3(lon, lat, h);}}
class Entities {constructor() {this.values = [];} add(d) {const e = {...d}; this.values.push(e); return e;} remove(e) {this.values = this.values.filter(v => v !== e);}}
class Primitives {constructor() {this.values = [];} add(p) {this.values.push(p); return p;} remove(p) {this.values = this.values.filter(v => v !== p);}}
class Primitive {
  constructor(o) {Object.assign(this, o); this.ready = true; this.colors = new Map();}
  getGeometryInstanceAttributes(id) {
    if (!this.geometryInstances.some(i => i.id === id)) return undefined;
    if (!this.colors.has(id)) this.colors.set(id, {color: null});
    return this.colors.get(id);
  }
}
const C = {Cartesian3, Cartesian2: class {constructor(x, y) {this.x = x; this.y = y;}},
  Color: {fromCssColorString: css => ({css, withAlpha(alpha) {return {css, alpha};}})},
  LabelStyle: {FILL_AND_OUTLINE: 'fo'}, VerticalOrigin: {BOTTOM: 'b'}, NearFarScalar: class {constructor(...a) {this.a = a;}},
  DistanceDisplayCondition: class {constructor(near, far) {this.near = near; this.far = far;}},
  PolylineDashMaterialProperty: class {constructor(o) {Object.assign(this, o); this.dashed = true;}},
  ArcType: {NONE: 'none'},
  Geometry: class {constructor(o) {Object.assign(this, o);}}, GeometryAttribute: class {constructor(o) {Object.assign(this, o);}},
  ComponentDatatype: {DOUBLE: 'double'}, PrimitiveType: {TRIANGLES: 'triangles'},
  BoundingSphere: {fromVertices: values => ({vertices: values.length / 3})},
  GeometryInstance: class {constructor(o) {Object.assign(this, o);}},
  ColorGeometryInstanceAttribute: {fromColor: color => ({color}), toValue: (color, result) => Object.assign(result ?? {}, {value: color})},
  DistanceDisplayConditionGeometryInstanceAttribute: {fromDistanceDisplayCondition: condition => ({condition})},
  PerInstanceColorAppearance: class {constructor(o) {Object.assign(this, o);}},
  Primitive};

const nodes = [
  {id: 'rn-a', name: '진입', latitude: 37.53, longitude: 126.93, altitude_m: 304.8, altitude_reference: 'agl'},
  {id: 'rn-b', name: '순항점', latitude: 37.53, longitude: 126.97, altitude_m: 600, altitude_reference: 'msl'},
  {id: 'rn-c', name: '강하점', latitude: 37.55, longitude: 126.99, altitude_m: 600, altitude_reference: 'msl'},
];

test('arrival mesh colours are zero in constructor input, before Cesium becomes ready',async()=>{
 const {layer}=setup();layer.fadeIn=true;
 layer.C={...C,ColorGeometryInstanceAttribute:{...C.ColorGeometryInstanceAttribute,
  fromColor:color=>({value:new Uint8Array([10,20,30,Math.round(color.alpha*255)])})}};
 await layer.show({nodes,links:[{id:'fade',from:'rn-a',to:'rn-b',segment:'F',width_m:300}]});
 for(const instance of layer.primitive.geometryInstances)assert.equal(instance.attributes.color.value[3],0);
 for(const mesh of layer.fadeMeshes){assert.equal(mesh.applied[3],0);assert.equal(mesh.base[3],Math.round(FILL_ALPHA*255));}
});

test('superseded ground resolution does not clear and redraw the arriving network',async()=>{
 const {layer}=setup();let release;let calls=0,draws=0;
 layer.groundHeights=async points=>{if(++calls===1)await new Promise(r=>release=r);return points.map(()=>0);};
 const draw=layer.draw.bind(layer);layer.draw=()=>{draws++;draw();};
 const network={nodes,links:[]};
 const old=layer.show(network);await layer.show(network);release();await old;
 assert.equal(draws,1);assert.equal(layer.markers.size,nodes.length);
});
const fatos = [{id: 'fato:vp-1:F1', kind: 'fato', name: '여의도 F1', vertiport: 'vp-1', fato: 'F1', role: 'takeoff', latitude: 37.52, longitude: 126.93, platform_height_m: 2, hover_m: 30}];
const links = [
  {id: 'rl-1', name: '여의도 F1 → 진입', from: 'fato:vp-1:F1', to: 'rn-a', segment: 'C', width_m: null},
  {id: 'rl-2', name: '진입 → 순항점', from: 'rn-a', to: 'rn-b', segment: 'F', width_m: 300},
  {id: 'rl-3', name: '진입 → 강하점', from: 'rn-a', to: 'rn-c', segment: 'F', width_m: 400},
];

function setup({ground = 50, deck = null} = {}) {
  const entities = new Entities(), scene = {primitives: new Primitives()};
  const asked = [];
  const layer = new RouteLayer(C, {entities, scene}, {groundHeights: async points => {asked.push(points); return points.map(() => ground);}, deckTop: () => deck});
  return {layer, entities, scene, asked};
}
test('zoom only resizes markers, preserving line materials, helpers and in-progress mesh fades',async()=>{
 const {layer,entities}=setup();await layer.show({nodes,fatos,links});layer.select('rn-a');
 const owned=[...entities.values],materials=[...layer.lines.values()].map(x=>x.entity.polyline.material);
 const colours=[...layer.fills.values()].map(x=>layer.primitive.getGeometryInstanceAttributes(x.id).color);
 layer.restyle=()=>{throw Error('camera scale must not restyle the network');};
 assert.equal(layer.setPixelScale(100),true);
 assert.deepEqual(entities.values,owned,'selected drop-line and all helpers retain identity');
 for(const [i,line] of [...layer.lines.values()].entries())assert.equal(line.entity.polyline.material,materials[i]);
 for(const [i,fill] of [...layer.fills.values()].entries())assert.equal(layer.primitive.getGeometryInstanceAttributes(fill.id).color,colours[i]);
 assert.equal(layer.markers.get('rn-a').entity.point.pixelSize,layer.nodeScale()*NODE_PIXELS_HOVER);
 assert.equal(layer.setPixelScale(10000),false,'already clamped marker size does no rendering work');
});

test('a node stands over the ground for AGL, where it says for absolute, and a FATO hovers over its deck', () => {
  assert.equal(nodeHeight(nodes[0], 50), 354.8);
  assert.equal(nodeHeight(nodes[1], 50), 600);
  assert.equal(nodeHeight(fatos[0], 50, 61.5), 91.5, 'the placed deck top plus the hover height');
  assert.equal(nodeHeight(fatos[0], 50, null), 82, 'not placed yet: ground plus the platform height');
  assert.equal(altitudeText(nodes[0]), '1,000 ft · 305 m AGL');
  assert.equal(altitudeText(nodes[1]), '1,969 ft · 600 m 절대');
  assert.equal(corridorWidth(links[0]), 0, 'a climb is a line');
  assert.equal(corridorWidth(links[2]), 400);
  assert.equal(corridorWidth({segment: 'C', width_m: 300}), 0, 'a width on a non-cruise link is ignored');
  assert.equal(hubRadiusAt('rn-a', links), 200, 'half the widest corridor at the node');
  assert.equal(hubRadiusAt('rn-b', links), 150);
  assert.equal(hubRadiusAt('fato:vp-1:F1', links), 0, 'a line makes no hub');
});

test('showing a network measures every endpoint once and draws corridors, hubs, points, lines, columns and labels', async () => {
  const {layer, entities, scene, asked} = setup({ground: 50, deck: 61.5});
  await layer.show({nodes, fatos, links}, [{id: 'F', color: '#00ffff'}]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].length, 4, 'three waypoints and one FATO in one request');
  assert.equal(scene.primitives.values.length, 1, 'every translucent surface in one primitive');
  const [primitive] = scene.primitives.values;
  assert.equal(primitive.appearance.translucent, true);
  assert.equal(primitive.geometryInstances.length, 5, 'two corridors and three hubs (진입, 순항점, 강하점)');
  const corridors = primitive.geometryInstances.filter(i => i.id.startsWith('link:'));
  assert.deepEqual(corridors.map(i => i.id), ['link:rl-2', 'link:rl-3']);
  assert.equal(corridors[0].attributes.color.color.css, '#00ffff', "the server's colour for the segment");
  assert.equal(corridors[0].attributes.color.color.alpha, FILL_ALPHA);
  const hubs = primitive.geometryInstances.filter(i => i.id.startsWith('hub:'));
  assert.deepEqual(hubs.map(i => i.id).sort(), ['hub:rn-a', 'hub:rn-b', 'hub:rn-c']);
  const points = entities.values.filter(e => e.point);
  for (const entity of entities.values) {
    if (entity.point) assert.equal(entity.point.disableDepthTestDistance, 0, 'route points do not pierce aircraft');
    if (entity.label) assert.equal(entity.label.disableDepthTestDistance, 0, 'route names and altitude obey scene depth');
  }
  assert.equal(points.length, 4, 'a point per waypoint and FATO, no spheres');
  assert.equal(entities.values.filter(e => e.ellipsoid).length, 0);
  const a = points.find(e => e.aerodtRoute.id === 'rn-a');
  assert.equal(a.position.z, 354.8, 'over the measured ground');
  assert.equal(a.point.pixelSize, NODE_PIXELS);
  const f = points.find(e => e.aerodtRoute.id === 'fato:vp-1:F1');
  assert.equal(f.position.z, 91.5, 'over the deck');
  const column = entities.values.find(e => e.cylinder);
  assert.equal(column.cylinder.length, 30, 'the vertical phase from the deck to the hover point');
  assert.equal(column.cylinder.topRadius, FATO_NODE_RADIUS_M);
  assert.equal(column.position.z, 76.5, 'centred between deck and hover');
  const line = entities.values.find(e => e.polyline && e.aerodtRoute?.id === 'rl-1');
  assert.ok(line, 'the climb is a line');
  assert.equal(line.polyline.width, LINE_WIDTH);
  assert.equal(line.polyline.positions[0].z, 91.5); assert.equal(line.polyline.positions.at(-1).z, 354.8, 'along the height profile');
  assert.equal(entities.values.filter(e => e.polyline && !e.aerodtRoute).length, 0, 'no outlines, no drop line while nothing is selected');
  const labels = entities.values.filter(e => e.label);
  assert.ok(labels.some(e => e.label.text === '진입\n1,000 ft · 305 m AGL'));
  assert.ok(labels.some(e => e.label.text === 'F · 진입 → 순항점'));
  assert.ok(labels.some(e => e.label.text === 'C · 여의도 F1 → 진입'));
  assert.ok(labels.some(e => /F1 이륙 B/.test(e.label.text)));
  assert.deepEqual(layer.position('rn-a'), {node: nodes[0], longitude: 126.93, latitude: 37.53, height: 354.8, ground: 50, base: 50});
});

test('nothing of a route is drawn from far away: every part carries the same near range', async () => {
  const {layer, entities, scene} = setup({ground: 50, deck: 61.5});
  await layer.show({nodes, fatos, links});
  layer.select('rn-a');
  const far = graphic => graphic.distanceDisplayCondition;
  for (const entity of entities.values) {
    const graphic = entity.point ?? entity.polyline ?? entity.cylinder;
    if (!graphic) continue;
    assert.equal(far(graphic).near, 0);
    assert.equal(far(graphic).far, VISIBLE_METRES, 'points, lines, the drop line and the FATO column');
  }
  for (const instance of scene.primitives.values[0].geometryInstances) {
    assert.equal(instance.attributes.distanceDisplayCondition.condition.far, VISIBLE_METRES, 'corridors and hubs');
  }
  // Labels go before the geometry does, and a link's name before a waypoint's.
  const labels = entities.values.filter(e => e.label);
  const waypoint = labels.find(e => e.label.text.startsWith('진입'));
  const link = labels.find(e => e.label.text.startsWith('F · '));
  assert.equal(waypoint.label.distanceDisplayCondition.far, LABEL_FAR_METRES);
  assert.equal(link.label.distanceDisplayCondition.far, LINK_LABEL_FAR_METRES);
  assert.ok(LINK_LABEL_FAR_METRES < LABEL_FAR_METRES && LABEL_FAR_METRES < VISIBLE_METRES);
  // A view from 200 km up must hold the whole network: measured over Seoul, its
  // far corner is 205.7 km from that camera, so the limit is not 200 km exactly.
  assert.ok(VISIBLE_METRES >= 210000, 'a 200 km view reaches further than 200 km');
});

test('a link whose endpoint is missing is skipped rather than drawn to nowhere', async () => {
  const {layer, scene, entities} = setup();
  await layer.show({nodes: [nodes[0]], fatos: [], links});
  assert.equal(scene.primitives.values.length, 0, 'no corridor, and a lone node has no hub');
  assert.equal(entities.values.filter(e => e.polyline).length, 0);
});

test('picks are answered for points, columns, lines, corridors and hubs, and nothing else', async () => {
  const {layer, entities, scene} = setup();
  await layer.show({nodes, fatos, links});
  const point = entities.values.find(e => e.point && e.aerodtRoute.id === 'rn-b');
  assert.deepEqual(layer.pick({id: point}), {kind: 'node', id: 'rn-b'});
  const line = entities.values.find(e => e.polyline && e.aerodtRoute?.id === 'rl-1');
  assert.deepEqual(layer.pick({id: line}), {kind: 'link', id: 'rl-1'});
  assert.deepEqual(layer.pick({id: 'link:rl-2', primitive: scene.primitives.values[0]}), {kind: 'link', id: 'rl-2'});
  assert.deepEqual(layer.pick({id: 'hub:rn-a'}), {kind: 'node', id: 'rn-a'});
  assert.equal(layer.pick({id: {name: 'an aircraft entity'}}), null);
  assert.equal(layer.pick({id: 'something:else'}), null);
  assert.equal(layer.pick(undefined), null);
});

test('the pair a card is asking about is drawn between the two waypoints until it is answered', async () => {
  const {layer, entities} = setup();
  await layer.show({nodes, fatos, links});
  const count = entities.values.length;
  const preview = () => entities.values.filter(e => (e.polyline?.material?.dashed && !e.aerodtRoute) || (e.label && !e.aerodtRoute && !e.point));
  assert.equal(layer.previewLink('rn-b', 'rn-c'), true);
  const drawn = preview();
  assert.equal(drawn.length, 2, 'a dashed line and the pair it joins, named');
  const [line, label] = drawn;
  assert.equal(line.polyline.positions[0].x, 126.97, 'it starts at one waypoint');
  assert.equal(line.polyline.positions.at(-1).x, 126.99, 'and ends at the other');
  assert.equal(label.label.text, '순항점 → 강하점');
  // Both ends read as chosen while the card asks, so the line is unambiguous.
  const ends = ['rn-b', 'rn-c'].map(id => entities.values.find(e => e.point && e.aerodtRoute.id === id));
  assert.ok(ends.every(e => e.point.pixelSize === NODE_PIXELS_HOVER));
  assert.equal(layer.previewLink('rn-b', 'rn-c'), false, 'the same pair is not redrawn');
  assert.equal(layer.previewLink(null, null), true);
  assert.equal(preview().length, 0, 'answered or given up, it goes');
  assert.equal(entities.values.length, count, 'and leaves nothing behind');
});

test('the names are drawn at the size the display setting asks for, over the labels that already exist', async () => {
  const {layer, entities} = setup();
  await layer.show({nodes, fatos, links});
  const named = text => entities.values.find(e => e.label?.text?.startsWith(text));
  assert.equal(named('진입').label.font, '600 12px sans-serif', 'the size the layer was designed at');
  assert.equal(named('F · ').label.font, '600 11px sans-serif');
  const count = entities.values.length;
  assert.equal(layer.setLabelScale(1.4), true);
  assert.equal(named('진입').label.font, '600 16.8px sans-serif', 'written over the label, not redrawn');
  assert.equal(named('F · ').label.font, '600 15.4px sans-serif');
  assert.equal(entities.values.length, count, 'nothing was rebuilt');
  assert.equal(layer.setLabelScale(1.4), false, 'the same size again changes nothing');
  assert.equal(layer.setLabelScale('크게'), false, 'and an unusable one is ignored');
  assert.equal(named('진입').label.font, '600 16.8px sans-serif');
  // A network shown afterwards is drawn at the size that is set.
  await layer.show({nodes, fatos, links: []});
  assert.equal(named('진입').label.font, '600 16.8px sans-serif');
});

test('hover and selection restyle in place: nothing is rebuilt, the selected waypoint gets its drop line', async () => {
  const {layer, entities, scene} = setup();
  await layer.show({nodes, fatos, links});
  const count = entities.values.length;
  const point = () => entities.values.find(e => e.point && e.aerodtRoute.id === 'rn-a');
  const before = point();
  assert.equal(layer.hover({kind: 'node', id: 'rn-a'}), true);
  assert.equal(layer.hover({kind: 'node', id: 'rn-a'}), false, 'no change reported twice');
  assert.equal(point(), before, 'the same entity, restyled');
  assert.equal(point().point.pixelSize, NODE_PIXELS_HOVER);
  assert.equal(entities.values.length, count);
  layer.hover({kind: 'link', id: 'rl-2'});
  assert.equal(point().point.pixelSize, NODE_PIXELS);
  const [primitive] = scene.primitives.values;
  assert.equal(primitive.getGeometryInstanceAttributes('link:rl-2').color.value.alpha, FILL_ALPHA_HOVER, 'the corridor brightens through its colour attribute');
  assert.equal(primitive.getGeometryInstanceAttributes('link:rl-3').color.value.alpha, FILL_ALPHA);
  layer.hover({kind: 'link', id: 'rl-1'});
  const line = entities.values.find(e => e.polyline && e.aerodtRoute?.id === 'rl-1');
  assert.equal(line.polyline.width, LINE_WIDTH + 2);
  layer.hover(null);
  assert.equal(line.polyline.width, LINE_WIDTH);
  layer.select('rn-a');
  assert.equal(point().point.outlineWidth, 4, 'a ring marks the selection');
  const drops = entities.values.filter(e => e.polyline?.material?.dashed);
  assert.equal(drops.length, 1, 'a dashed drop line under the selected waypoint');
  assert.equal(drops[0].polyline.positions[0].z, 50); assert.equal(drops[0].polyline.positions[1].z, 354.8);
  layer.select(null);
  assert.equal(entities.values.filter(e => e.polyline?.material?.dashed).length, 0);
  // A waypoint the selection cannot be joined to is drawn faint and small, so
  // a click that would only be refused is not made.
  layer.select('rn-a', ['rn-b']);
  const other = entities.values.find(e => e.point && e.aerodtRoute.id === 'rn-b');
  assert.equal(other.point.color.alpha, 0.28);
  assert.equal(other.point.pixelSize, NODE_PIXELS - 2);
  assert.equal(point().point.outlineWidth, 4, 'the selection itself is unaffected');
  layer.select('rn-a');
  assert.equal(other.point.color.alpha, 1, 'the same selection with nothing blocked puts it back');
  layer.select(null);
  layer.setVisible(false);
  assert.ok(entities.values.every(e => e.show === false));
  assert.equal(scene.primitives.values[0].show, false);
  await layer.refresh();
  assert.equal(scene.primitives.values[0].show, false, 'hidden stays hidden through a refresh');
  layer.destroy();
  assert.equal(entities.values.length, 0);
  assert.equal(scene.primitives.values.length, 0);
});

// A waypoint is a place in the air, not a dot on a screen. Drawn at a size on
// the ground it behaves like the map does: zoom out and the network becomes a
// fine web instead of a heap of blobs.
test('waypoint markers are drawn at a size on the ground, so pulling the camera back makes them smaller', async () => {
  const {layer, entities} = setup();
  await layer.show({nodes, fatos, links});
  const size = id => entities.values.find(e => e.aerodtRoute?.id === id && e.point).point.pixelSize;
  assert.equal(size('rn-a'), NODE_PIXELS, 'before anything is known about the camera, the symbol size');
  layer.setPixelScale(NODE_GROUND_METRES / (NODE_PIXELS * 4));
  assert.equal(size('rn-a'), NODE_PIXELS, 'close in it is capped: a waypoint never grows into a blob');
  layer.setPixelScale(NODE_GROUND_METRES / 6);
  assert.equal(size('rn-a'), 6, 'from further away it is the ground it covers');
  assert.equal(size('fato:vp-1:F1'), 6, 'a FATO marker goes with it');
  assert.ok(entities.values.find(e => e.aerodtRoute?.id === 'rn-a' && e.point).point.outlineWidth < 2,
    'and its ring thins with it rather than swallowing the dot');
  layer.setPixelScale(NODE_GROUND_METRES);
  assert.equal(size('rn-a'), NODE_PIXELS_MIN, 'far out it stops where it can still be seen and pointed at');
  assert.equal(layer.setPixelScale(0), false, 'a scale that could not be measured leaves them as they are');
  assert.equal(size('rn-a'), NODE_PIXELS_MIN, 'rather than snapping back to the symbol size');
  assert.equal(layer.setPixelScale(NODE_GROUND_METRES * 1.005), false, 'a change too small to see is not worth a restyle');
  layer.setPixelScale(NODE_GROUND_METRES / 6);
  layer.hover({kind: 'node', id: 'rn-a'});
  assert.equal(size('rn-a'), NODE_PIXELS_HOVER * 6 / NODE_PIXELS, 'what is pointed at still stands out, in proportion');
  assert.ok(size('rn-a') > size('rn-b'));
});

test('the network drops to background while another tool owns the map, and comes back unchanged', async () => {
  const {layer, entities} = setup();
  await layer.show({nodes, fatos, links});
  const line = [...layer.lines.values()][0].entity;
  const marker = [...layer.markers.values()][0].entity;
  const labelled = entities.values.filter(entity => entity.label);
  const before = {line: line.polyline.material.alpha, marker: marker.point.color.alpha,
    labels: labelled.every(entity => entity.label.show)};
  assert.equal(before.labels, true);

  assert.equal(layer.setQuiet(true), true);
  assert.ok(line.polyline.material.alpha < before.line, 'lines fade');
  assert.ok(marker.point.color.alpha < before.marker, 'so do the waypoints');
  // Names are the first thing to go: a hundred link names over another layer's
  // work is what makes the map unreadable.
  assert.equal(labelled.some(entity => entity.label.show), false);
  assert.equal(layer.setQuiet(true), false, 'saying it twice changes nothing');

  assert.equal(layer.setQuiet(false), true);
  assert.equal(line.polyline.material.alpha, before.line);
  assert.equal(marker.point.color.alpha, before.marker);
  assert.equal(labelled.every(entity => entity.label.show), true);
  // Quiet is a way of drawing, not a change to the network or to what is shown.
  assert.equal(entities.values.length, labelled.length + entities.values.filter(e => !e.label).length);
});

test('the operator\u2019s own label setting survives a spell in the background', async () => {
  const {layer, entities} = setup();
  await layer.show({nodes, fatos, links});
  layer.setLabelsVisible(false);
  const labelled = entities.values.filter(entity => entity.label);
  assert.equal(labelled.some(entity => entity.label.show), false);
  layer.setQuiet(true);
  layer.setQuiet(false);
  assert.equal(labelled.some(entity => entity.label.show), false, 'labels were off before and stay off');
  layer.setLabelsVisible(true);
  assert.equal(labelled.every(entity => entity.label.show), true);
});

test('both FATO uses independent departure and arrival heights, with reversible unsaved preview', async () => {
  const {layer} = setup({deck: 61.5});
  const fato = {...fatos[0], role: 'both', takeoff_height_m: 45, landing_height_m: 75};
  const out = links[0], incoming = {id:'arrival',from:'rn-a',to:fato.id,segment:'G',name:'arrival'};
  await layer.show({nodes,fatos:[fato],links:[out,incoming]});
  assert.equal(layer.lines.get(out.id).positions[0][2], 106.5);
  assert.equal(layer.lines.get(incoming.id).positions.at(-1)[2], 136.5);
  layer.previewVertiportHeights('vp-1',{takeoff_height_m:90,landing_height_m:120});
  assert.equal(layer.heightPreviewEntities.filter(e=>e.polyline).length,4,'two links and two vertical phases');
  const endpoints=layer.linkEndpoints(out,{vertiportId:'vp-1',heights:{takeoff_height_m:90,landing_height_m:120}});
  assert.equal(endpoints.from.height,151.5);
  assert.equal(layer.linkEndpoints(incoming,{vertiportId:'vp-1',heights:{landing_height_m:120}}).to.height,181.5);
  assert.equal(layer.lines.get(out.id).positions[0][2],106.5,'saved drawing remains unchanged');
  assert.equal(fato.takeoff_height_m,45,'preview never mutates network');
  layer.previewVertiportHeights(null);
  assert.equal(layer.heightPreviewEntities.length,0);
});

test('both FATO shows the separate landing vertical phase and defaults missing heights to thirty metres', async () => {
  const {layer,entities}=setup({deck:61.5});
  const fato={...fatos[0],role:'both',takeoff_height_m:45,landing_height_m:75};
  await layer.show({nodes,fatos:[fato],links:[]});
  assert.ok(entities.values.some(e=>e.label?.text === 'F1 착륙 J' && e.position.z===136.5));
  const {hover_m,...legacy}=fatos[0];
  assert.equal(nodeHeight(legacy,50,61.5),91.5);
});

test('globe conflict preview filters the facility and sends direction-specific absolute endpoints without saving', async () => {
  const {LiveGlobe}=await import('../../../../digital_twin/visualization/web/globe.js');
  const {layer}=setup({deck:61.5});
  const fato={...fatos[0],role:'both',takeoff_height_m:45,landing_height_m:75};
  await layer.show({nodes,fatos:[fato],links:[...links,{id:'arrival',from:'rn-a',to:fato.id,segment:'G'}]});
  const globe={routeLayer:layer,groundHeights:async points=>points.map(()=>50),clearedGround:[]};
  const request=await LiveGlobe.prototype.routeConflictRequest.call(globe,null,{vertiportId:'vp-1',heights:{takeoff_height_m:90,landing_height_m:120}});
  assert.deepEqual(request.links.map(l=>l.id),['rl-1','arrival']);
  assert.equal(request.links[0].from.height,151.5);
  assert.equal(request.links[1].to.height,181.5);
  assert.ok(request.links[0].grounds.every(h=>h===50));
  assert.equal(fato.takeoff_height_m,45);
  layer.previewVertiportHeights('vp-1',{takeoff_height_m:90,landing_height_m:120});
  layer.setHeightPreviewConflicts({'rl-1':{collisions:1},arrival:{tight:1}});
  const colours=layer.heightPreviewEntities.filter(e=>e.polyline).map(e=>e.polyline.material.color.css);
  assert.deepEqual(colours,['#ff4d4d','#ff4d4d','#ff9a9a','#ff9a9a']);
  assert.equal(layer.conflicts.size,0,'preview reports never overwrite saved route checks');
});

test('terrain-only preview conflict is red and a failed terrain sample is marked unavailable', async () => {
  const {LiveGlobe}=await import('../../../../digital_twin/visualization/web/globe.js');
  const {layer}=setup({deck:61.5});
  await layer.show({nodes,fatos,links});
  layer.previewVertiportHeights('vp-1',{takeoff_height_m:90,landing_height_m:120});
  layer.setHeightPreviewConflicts({'rl-1':{collisions:0,terrain_collisions:1}});
  assert.equal(layer.heightPreviewEntities[0].polyline.material.color.css,'#ff4d4d');
  const request=await LiveGlobe.prototype.routeConflictRequest.call({routeLayer:layer,groundHeights:async()=>{throw Error('missing terrain');}},null,{vertiportId:'vp-1'});
  assert.equal(request.links[0].terrain_available,false);
});
