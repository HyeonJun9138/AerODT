import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PICK_SLACK_PX,AirspaceLayer, CREDIT, HIDDEN_KINDS, KIND_STYLE, polygonsOf, airspaceBoundaryOf, pickThroughAirspace, hatchSpacingForScale, hatchAngleForFeature} from '../../../../digital_twin/visualization/web/airspace_layer.js';

const web = new URL('../../../../user_application/web/', import.meta.url);
const app = readFileSync(new URL('app.js', web), 'utf8');
const html = readFileSync(new URL('index.html', web), 'utf8');
const css = readFileSync(new URL('styles.css', web), 'utf8');
const globe = readFileSync(new URL('../../digital_twin/visualization/web/globe.js', web), 'utf8');
const selection = readFileSync(new URL('selection_panel.js', web), 'utf8');
// Resolve the browser's served import URLs for Node without changing panel code.
const panelSource=selection.replace("'./entity_details.js'",JSON.stringify(new URL('entity_details.js',web).href))
 .replace("'/visualization/model_preview.js'",JSON.stringify(new URL('../../digital_twin/visualization/web/model_preview.js',web).href))
 .replace("'/visualization/entity_labels.js'",JSON.stringify(new URL('../../digital_twin/visualization/web/entity_labels.js',web).href));
const {SelectionPanel}=await import(`data:text/javascript;base64,${Buffer.from(panelSource).toString('base64')}`);

class Cartesian3 {constructor(x, y) {this.x = x; this.y = y;} static fromDegreesArray(flat) {const out = []; for (let i = 0; i < flat.length; i += 2) out.push(new Cartesian3(flat[i], flat[i + 1])); return out;}}
class Options {constructor(options) {Object.assign(this, options);}}
class GroundPolylinePrimitive extends Options {destroyCount=0; destroy(){this.destroyCount++;}}
class GroundPrimitive extends GroundPolylinePrimitive {updates=0;update(){this.updates++;}static supportsMaterials(scene){return scene.supportsMaterials;}}
class MaterialAppearance extends Options {static MaterialSupport={TEXTURED:{vertexFormat:'textured'}};}
class PolygonHierarchy {constructor(positions,holes=[]){this.positions=positions;this.holes=holes;}}
class Material extends Options {constructor(options){super(options);this.uniforms=options.fabric.uniforms;}}
class Primitives {values=[]; add(p){this.values.push(p);return p;} remove(p){this.values=this.values.filter(v=>v!==p);p.destroy();}}
const C = {Cartesian3,GeometryInstance:Options,GroundPolylineGeometry:Options,GroundPolylinePrimitive,PolylineColorAppearance:class{},
  PerInstanceColorAppearance:class extends Options {static FLAT_VERTEX_FORMAT='flat';},
  GroundPrimitive,MaterialAppearance,PolygonHierarchy,PolygonGeometry:Options,Material,SceneMode:{MORPHING:0},
  Color: {fromCssColorString: css => ({css, withAlpha(alpha) {return {css, alpha};}})},
  ColorGeometryInstanceAttribute:{fromColor:color=>color},
  ClassificationType: {TERRAIN: 'terrain'}, ArcType: {GEODESIC: 'geodesic'}, Credit: class {constructor(text) {this.text = text;}}};
const square = (x, y, size = .1) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
const feature = (id, kind, geometry) => ({type:'Feature',id,geometry,properties:{name:id,kind}});
const collection = {type: 'FeatureCollection', features: [
  feature('p73','prohibited',{type:'Polygon',coordinates:[square(126.9,37.5)]}),
  feature('ctr','control',{type:'MultiPolygon',coordinates:[[square(126.7,37.5)],[square(126.7,37.7),square(126.72,37.72,.02)]]}),
  feature('fir','fir',{type:'Polygon',coordinates:[square(120,30,10)]}),
]};
function setup(supportsMaterials=true) {
 const credits={added:[],removed:[],addStaticCredit(c){this.added.push(c);},removeStaticCredit(c){this.removed.push(c);}};
 const groundPrimitives=new Primitives(),entities={add(){throw new Error('Airspace must not add a pickable entity or filled polygon');}};
 const layer=new AirspaceLayer(C,{entities,scene:{groundPrimitives,supportsMaterials,frameState:{creditDisplay:credits}}});
 return {layer,groundPrimitives,credits};
}
test('polygon and multipolygon rings are preserved',()=>{
 assert.equal(polygonsOf({type:'Polygon',coordinates:[square(0,0)]}).length,1);
 assert.equal(polygonsOf({type:'MultiPolygon',coordinates:[[square(0,0)],[square(1,1)]]}).length,2);
 assert.deepEqual(polygonsOf({type:'LineString',coordinates:[]}),[]);assert.deepEqual(polygonsOf(null),[]);
});
test('airspace draws hoverable boundaries and sparse non-pickable hatching, with a faint interactive fill',()=>{
 const {layer,groundPrimitives,credits}=setup(),original=structuredClone(collection);
 assert.equal(layer.show(collection),3);assert.equal(groundPrimitives.values.length,0);
 assert.equal(layer.setEnabled(true),true);assert.equal(groundPrimitives.values.length,4);
 const primitive=layer.outline,lines=primitive.geometryInstances;
 assert.equal(primitive.allowPicking,true,'only thin boundary geometry offers hover info');
 assert.equal(primitive.classificationType,'terrain');assert.equal(primitive.asynchronous,true);
 assert.ok(primitive.appearance instanceof C.PolylineColorAppearance);
 assert.equal(lines.length,4,'one prohibited ring, two control outer rings, one inner exclusion');
 assert.ok(HIDDEN_KINDS.has('fir'));
 for(const line of lines){
  assert.ok(line.geometry instanceof C.GroundPolylineGeometry);
  assert.equal(line.geometry.loop,true);assert.equal(line.geometry.width,1.6);
  assert.equal(line.geometry.positions.length,4,'duplicate closing vertex removed; loop closes it');
  assert.ok(airspaceBoundaryOf(line));assert.equal('polygon' in line,false);
 }
 assert.deepEqual(lines[0].attributes.color,{css:KIND_STYLE.prohibited.color,alpha:KIND_STYLE.prohibited.outline});
 assert.deepEqual(lines[3].attributes.color,{css:KIND_STYLE.control.color,alpha:KIND_STYLE.control.outline});
 assert.deepEqual(collection,original,'source geometry is read-only');
 assert.equal(layer.hatches.length,2,'batched by kind rather than individual stripes');
 for(const hatch of layer.hatches){
  assert.equal(hatch.allowPicking,false,'hatch and all transparent gaps must pass picks through');
  assert.equal(hatch.classificationType,'terrain');assert.equal(hatch.asynchronous,true);
  const material=hatch.appearance.material;
  assert.equal(material.fabric.uniforms.spacing,4000);assert.ok(material.fabric.uniforms.anchor);assert.ok(material.fabric.uniforms.direction);
  assert.ok(material.fabric.uniforms.color.alpha<=.28);
  assert.match(material.fabric.source,/material.alpha = color.a \* coverage/);
  assert.match(material.fabric.source,/dot\(ground - anchor, direction\)/);
  assert.match(material.fabric.source,/eye \/ eye.w/);
  assert.match(material.fabric.source,/czm_sceneMode3D/);
  assert.match(material.fabric.source,/dFdx\(diagonal\)/);
  assert.doesNotMatch(material.fabric.source,/gl_FragCoord.x \+ gl_FragCoord.y/);
  assert.doesNotMatch(material.fabric.source,/czm_frameNumber|czm_frameTime/);
  assert.ok(hatch.geometryInstances.every(i=>!i.id));
  hatch.update({passes:{pick:true,render:false}});assert.equal(hatch.updates,0,'no hatch geometry enters the 2D/3D pick pass');
  hatch.update({passes:{pick:false,render:true}});assert.equal(hatch.updates,1);
  hatch.update({mode:0,passes:{pick:false,render:true}});assert.equal(hatch.updates,1,'hide hatching during a scene morph');
 }
 assert.equal(layer.hatches[1].geometryInstances.length,2,'multipolygons share one material batch');
 assert.equal(layer.hatches[1].geometryInstances[1].geometry.polygonHierarchy.holes.length,1,'holes stay clear');
 assert.equal(credits.added.length,1);assert.equal(credits.added[0].text,CREDIT);
 assert.equal(layer.setEnabled(true),false);
 layer.setEnabled(false);assert.equal(groundPrimitives.values.length,0);assert.equal(primitive.destroyCount,1);
 assert.equal(credits.removed.length,1);
});
test('faint interiors preserve holes and expose airspace metadata without stealing a vehicle pick',()=>{
 const {layer}=setup();layer.show(collection);layer.setEnabled(true);
 assert.equal(layer.fill.allowPicking,true);assert.equal(layer.fill.geometryInstances.length,3);
 assert.ok(layer.fill.geometryInstances.every(i=>i.attributes.color.alpha<=.07&&airspaceBoundaryOf({id:i.id})));
 assert.equal(layer.fill.geometryInstances[2].geometry.polygonHierarchy.holes.length,1);
 const fill={id:layer.fill.geometryInstances[0].id},vehicle={id:'uam'};
 assert.equal(pickThroughAirspace({drillPick:()=>[fill,vehicle]}, {},fill),vehicle);
});
test('ground spacing stays fixed within zoom bands and changes by nested powers of two',()=>{
 assert.equal(hatchSpacingForScale(80),4000);
 for(const scale of [90,100,120,124,100,60,46])assert.equal(hatchSpacingForScale(scale,4000),4000);
 assert.equal(hatchSpacingForScale(126,4000),8000);
 for(const scale of [125,124,122,100])assert.equal(hatchSpacingForScale(scale,8000),8000,'no threshold chatter');
 assert.equal(hatchSpacingForScale(90,8000),4000);
 assert.equal(hatchSpacingForScale(10),500);assert.equal(hatchSpacingForScale(2),125);
 assert.equal(hatchSpacingForScale(.001),31.25);assert.equal(hatchSpacingForScale(1e8),128000);
 for(const value of [null,NaN,Infinity,0,-1])assert.equal(hatchSpacingForScale(value,2000),2000);
 // Coarser lines are an exact subset, not a shifted/restarted pattern.
 for(const spacing of [125,250,500,1000,2000,4000]){
  const diagonal=spacing*6;
  assert.equal(diagonal%spacing,0);assert.equal(diagonal%(spacing*2),0);
 }
});
test('zoom updates only material spacing, never rebuilds or reallocates airspace geometry',()=>{
 const {layer,groundPrimitives}=setup();layer.show(collection);layer.setEnabled(true);
 const original=[...groundPrimitives.values];
 assert.equal(layer.setPixelScale(80),true);assert.equal(layer.setPixelScale(90),false);
 assert.equal(layer.setPixelScale(126),true);assert.equal(layer.hatchSpacing,8000);
 assert.ok(layer.hatches.every(h=>h.appearance.material.uniforms.spacing===8000));
 assert.deepEqual(groundPrimitives.values,original);
 for(const p of original)assert.equal(p.destroyCount,0);
 for(const invalid of [NaN,Infinity,0,-1])assert.equal(layer.setPixelScale(invalid),false);
 layer.setEnabled(false);layer.setEnabled(true);
 assert.ok(layer.hatches.every(h=>h.appearance.material.uniforms.spacing===8000));layer.destroy();
});
test('zones have varied but persistent angles, sharing at most four batches per kind',()=>{
 const features=Array.from({length:40},(_,i)=>feature(`zone-${i}`,'restricted',{type:'Polygon',coordinates:[square(i*.2,30)]}));
 const angles=features.map(hatchAngleForFeature);assert.equal(new Set(angles).size,4);
 assert.deepEqual(features.map(f=>hatchAngleForFeature(structuredClone(f))),angles);
 const {layer}=setup();layer.show({features});layer.setEnabled(true);assert.equal(layer.hatches.length,4);
 assert.equal(layer.hatches.reduce((sum,h)=>sum+h.geometryInstances.length,0),40);
 const directions=layer.hatches.map(h=>h.appearance.material.uniforms.direction);
 layer.setPixelScale(80);layer.setPixelScale(180);
 assert.deepEqual(layer.hatches.map(h=>h.appearance.material.uniforms.direction),directions);
 layer.show({features});assert.deepEqual(layer.hatches.map(h=>h.appearance.material.uniforms.direction),directions);
 layer.destroy();
});
test('redraw, clear and repeated destruction release the batch and source credit',()=>{
 const {layer,groundPrimitives,credits}=setup();layer.show(collection);layer.setEnabled(true);
 const first=layer.outline,hatches=layer.hatches;layer.show(collection);assert.equal(first.destroyCount,1);assert.equal(groundPrimitives.values.length,4);
 assert.ok(hatches.every(h=>h.destroyCount===1));
 const second=layer.outline,secondHatches=layer.hatches;layer.destroy();layer.destroy();
 assert.ok(secondHatches.every(h=>h.destroyCount===1));
 assert.equal(second.destroyCount,1);assert.equal(groundPrimitives.values.length,0);assert.equal(credits.removed.length,1);
 assert.equal(layer.collection,null);
});
test('unsupported material rendering falls back to boundary only; invalid holes are not hatched over',()=>{
 const {layer}=setup(false);layer.show(collection);layer.setEnabled(true);
 assert.ok(layer.outline);assert.equal(layer.hatches.length,0);layer.destroy();
 const {layer:other}=setup();other.show({features:[feature('bad-hole','prohibited',{type:'Polygon',coordinates:[square(0,0),[[0,0],[1,1]]]})]});
 other.setEnabled(true);assert.equal(other.outline.geometryInstances.length,1);assert.equal(other.hatches.length,0);other.destroy();
});
test('picks bypass only airspace outlines, preserving aircraft and route/vertiport editing priority',()=>{
 const boundary={id:{airspaceBoundary:{name:'P73',kindLabel:'비행금지구역'}}},position={x:10,y:20};
 let drills=0;
 for(const id of ['aircraft','satellite',{routeNode:'node'},{vertiport:'port'}]){
  const target={id},scene={pick:()=>boundary,drillPick:()=>{drills++;return [boundary,boundary,target];}};
  assert.equal(pickThroughAirspace(scene,position),target);
  assert.equal(pickThroughAirspace(scene,position,target),target,'ordinary picks never invoke drilling');
 }
 assert.equal(drills,4);
 assert.equal(pickThroughAirspace({pick:()=>boundary,drillPick:()=>[boundary]},position),null);
 assert.equal(pickThroughAirspace({pick:()=>null},position),null);
 assert.equal(airspaceBoundaryOf(boundary).name,'P73');assert.equal(airspaceBoundaryOf(null),null);
});
test('boundary tooltip is small text, clears on leave, and never overrides entity details',()=>{
 const nodes=Object.fromEntries(['hover-card','hover-name','hover-detail','globe'].map(id=>[id,{hidden:true,textContent:'',style:{},getBoundingClientRect:()=>({width:500,height:300})}]));
 const panel={$:id=>nodes[id]},zone={name:'P73',kindLabel:'비행금지구역',lower:'GND',upper:'FL 100'},pointer={x:20,y:30};
 SelectionPanel.prototype.hover.call(panel,null,pointer,zone);
 assert.equal(nodes['hover-card'].hidden,false);assert.equal(nodes['hover-name'].textContent,'P73');assert.match(nodes['hover-detail'].textContent,/비행금지구역.*GND ~ FL 100/);
 SelectionPanel.prototype.hover.call(panel,{name:'KAL123',kind:'aircraft'},pointer,zone);
 assert.equal(nodes['hover-name'].textContent,'KAL123');assert.doesNotMatch(nodes['hover-detail'].textContent,/비행금지/);
 SelectionPanel.prototype.hover.call(panel,null,null);assert.equal(nodes['hover-card'].hidden,true);
});
test('empty, hidden and malformed rings create no render or interaction surface',()=>{
 const {layer,groundPrimitives}=setup();layer.setEnabled(true);
 layer.show({features:[feature('bad','restricted',{type:'Polygon',coordinates:[[[0,0],[1,1]],[[0,0],[1,NaN],[2,2]],[[0,0],[1,1],[0,0]]]})]});
 assert.equal(groundPrimitives.values.length,0);
 layer.shownKinds.clear();layer.show(collection);assert.equal(groundPrimitives.values.length,0);layer.destroy();
});
test('the display switch and source loading remain; airspace no longer steals hover or clicks',()=>{
 assert.match(html,/<button id="airspace"[^>]*aria-pressed="false"/);
 assert.match(app,/for\(const id of \['sunlight','buildings','terrain','place-names','airspace','clouds'\]\)/);
 assert.match(app,/getJSON\('\/api\/airspace'\)/);assert.match(app,/localStorage\.setItem\('aerodt\.airspace'/);
 assert.match(app,/state==='unconfigured'/);assert.match(globe,/this\.airspaceLayer=new AirspaceLayer\(C,v\)/);
 assert.match(globe,/setAirspaceEnabled\(enabled\)/);assert.match(globe,/this\.airspaceLayer\?\.destroy\(\)/);
 assert.doesNotMatch(app+globe+selection,/onAirspace|hoverZone|airspaceLayer\??\.hover|airspaceLayer\.pickBest|tooltip\.dataset\.zone/);
 assert.match(globe,/!picked && !editing && !this.groundPick\?airspaceBoundaryOf/);
 assert.match(globe,/routeLayer.pick\(pickThroughAirspace/);assert.match(globe,/vertiportLayer.pick\(pickThroughAirspace/);
 assert.match(app,/selectionPanel.hover\(entity,pointer,airspace\)/);
 assert.match(css,/button#airspace\[aria-pressed=true\]/);
});

test('a pick reaches a little past the pointer, so a small moving object can be hit', () => {
  // Aircraft a few kilometres out are a handful of pixels and they are moving.
  // A pick that only looked straight down the pointer missed far more than it
  // hit, which is what made them hard to click.
  assert.ok(PICK_SLACK_PX >= 12, 'enough slack to catch what the pointer is aimed at');
  assert.ok(PICK_SLACK_PX <= 24, 'not so much that it reaches past it to something else');
  const asked = [];
  const scene = {pick: (position, w, h) => {asked.push([w, h]); return null;},
    drillPick: (position, limit, w, h) => {asked.push(['drill', w, h]); return [];}};
  pickThroughAirspace(scene, {x: 10, y: 10});
  assert.deepEqual(asked[0], [PICK_SLACK_PX, PICK_SLACK_PX], 'the window is the slack, both ways');
});
