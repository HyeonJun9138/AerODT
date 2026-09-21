// The thrust lever in the cabin.
//
// It is one control with three hands on it -- the keyboard integrating with W
// and S, a stick reporting where its own lever sits, and the mouse taking hold
// of this one. The number they all write is the only throttle there is, and
// this draws it; so what these tests hold is that the lever never becomes a
// fourth opinion, and that grabbing it does not also swing the pilot's head.
import test from 'node:test';
import assert from 'node:assert/strict';
import {CockpitThrottle, throttleFrame, leverAngle, throttleFromDrag, leverMatrix}
  from '../../../../digital_twin/visualization/web/cockpit_throttle.js';

// A cabin profile as the asset library writes one: the NAV screen carries an
// orthonormal frame, and everything here is placed from it.
const PROFILE = {screens: [
  {id: 'pfd', center: [-0.6, 1.1, 0.9], right: [0, 0, 1], up: [0, 1, 0], width: 0.4, height: 0.33},
  {id: 'nav', center: [0, 1.1, 0.9], right: [0, 0, 1], up: [0, 1, 0], width: 0.4, height: 0.33},
]};

import {CockpitStick,stickAngles,stickFromDrag} from '../../../../digital_twin/visualization/web/cockpit_stick.js';

// Only the pieces of Cesium the lever touches.
function fakeCesium() {
  const built = [];
  let FROZEN_IDENTITY;
  class Matrix4 {
    constructor(...v) {this.v = v.length ? v : new Array(16).fill(0);}
    static get IDENTITY() {return FROZEN_IDENTITY;}
    static fromTranslation(t) {const m = new Matrix4(); m.translation = [t.x, t.y, t.z]; return m;}
    static fromRotationTranslation(r) {const m = new Matrix4(); m.rotation = r; return m;}
    // Cesium's own IDENTITY is frozen, so a result written into it throws.
    // The fake freezes it too, or the code under test could rely on writing
    // there and only fail in the browser.
    static clone(source, out = new Matrix4()) {out.clonedFrom = source; return out;}
    static multiply(a, b, out) {
      if (Object.isFrozen(out)) throw new TypeError('cannot write into a frozen matrix');
      out.product = [a, b]; return out;
    }
  }
  FROZEN_IDENTITY = Object.freeze(new Matrix4(1));
  return {
    built,
    C: {
      CylinderGeometry:class {constructor(options){Object.assign(this,options);}}, EllipsoidGeometry:class {constructor(options){Object.assign(this,options);}},
      Matrix4, Matrix3: class {static fromRotationX(a){return {rotationX:a};}static fromRotationY(a){return {y:a};}static fromRotationZ(a){return {z:a};}static multiply(a,b,out){out.a=a;out.b=b;return out;}},
      Cartesian3: Object.assign(function (x, y, z) {return {x, y, z};}, {ZERO: {x: 0, y: 0, z: 0}}),
      Color: {fromCssColorString: css => ({css})},
      ColorGeometryInstanceAttribute: {fromColor: colour => colour},
      PerInstanceColorAppearance: Object.assign(
        class {constructor(options) {Object.assign(this, options);}}, {VERTEX_FORMAT: 'pic'}),
      BoxGeometry: {fromDimensions: options => ({box: options.dimensions, vertexFormat: options.vertexFormat})},
      GeometryInstance: class {constructor(options) {Object.assign(this, options);}},
      Primitive: class {constructor(options) {Object.assign(this, options); built.push(this);}},
    },
  };
}
const fakeScene = () => {
  const primitives = [];
  return {picked: null, primitives: {
      add: p => primitives.push(p),
      remove: p => {const i = primitives.indexOf(p); if (i >= 0) primitives.splice(i, 1); return i >= 0;},
      list: primitives,
    }, pick() {return this.picked;}};
};

test('the lever is placed from the cabin it sits in, not from metres', () => {
  // The airframes are unitless and differ in size. The NAV screen is the one
  // thing in the profile already sized to its own cabin, so it is the ruler.
  const frame = throttleFrame(PROFILE);
  assert.ok(frame);
  // Clear of the console, which hangs 1.32 screen heights below the screen.
  assert.ok(frame.anchor[1] > PROFILE.screens[1].center[1] - 0.33 * 1.32, '기본 시야 안의 콘솔 왼쪽');
  assert.ok(frame.anchor[2] < PROFILE.screens[1].center[2], '콘솔 왼쪽');
  // `right x up` is the direction the projection requires a screen to face,
  // so the lever leans toward the pilot by the same convention, not a guess.
  assert.deepEqual(frame.toward, [-1, 0, 0]);
  assert.deepEqual(frame.right, [0, 0, 1]);
  assert.equal(frame.span, 0.4);

  // Placement scales with the cabin: a cabin twice the size puts it twice as
  // far from the screen, in the same direction.
  const big = throttleFrame({screens: [{...PROFILE.screens[1], width: 0.8, height: 0.66}]});
  const offset = (f, i) => f.anchor[i] - f.rise * 0 - PROFILE.screens[1].center[i];
  assert.ok(Math.abs(offset(big, 1) - offset(frame, 1) * 2) < 1e-9);

  // A profile with no usable NAV screen is not a place to hang a lever.
  assert.equal(throttleFrame({screens: [{id: 'nav', center: [0, 0, 0], width: 0, height: 1}]}), null);
  assert.equal(throttleFrame({screens: []}), null);
  assert.equal(throttleFrame(null), null);
  // A frame whose axes are not unit vectors would skew every box on it.
  assert.equal(throttleFrame({screens: [{id: 'nav', center: [0, 0, 0], right: [0, 0, 0], up: [0, 1, 0], width: 1, height: 1}]}), null);
});

test('idle leans back, full is pushed away, and the sweep is monotonic', () => {
  const idle = leverAngle(0), full = leverAngle(1);
  assert.ok(Math.sin(idle) > 0, '유휴는 조종사 쪽으로 눕는다');
  assert.ok(Math.sin(full) < 0, '최대 출력은 앞으로 민다');
  assert.ok(leverAngle(0.5) < idle && leverAngle(0.5) > full);
  // Nothing out of range, whatever arrives.
  assert.equal(leverAngle(2), full);
  assert.equal(leverAngle(-1), idle);
  assert.equal(leverAngle(NaN), idle);
  assert.equal(leverAngle(undefined), idle);
  // A sweep an arm can make, not a windmill.
  assert.ok(Math.abs(full - idle) * 180 / Math.PI < 90);
});

test('dragging up is more power, and the pull is bounded at both ends', () => {
  assert.ok(throttleFromDrag(0.5, -50) > 0.5, '위로 끌면 출력이 오른다');
  assert.ok(throttleFromDrag(0.5, 50) < 0.5);
  // It moves from where it was, not from where the pointer is: grabbing a
  // lever at 80% and nudging it must not jump it to the middle.
  assert.ok(Math.abs(throttleFromDrag(0.8, -10) - 0.8) < 0.1);
  assert.equal(throttleFromDrag(0.9, -1000), 1);
  assert.equal(throttleFromDrag(0.1, 1000), 0);
  assert.equal(throttleFromDrag(0.5, NaN), null);
  assert.equal(throttleFromDrag(undefined, 10), null);
  // Small corrections have to be possible: a few pixels is a few percent.
  assert.ok(Math.abs(throttleFromDrag(0.5, -10) - 0.5) < 0.1);
});

test('the lever draws the throttle it is given, and rides the aircraft', () => {
  const {C, built} = fakeCesium();
  const scene = fakeScene();
  const lever = new CockpitThrottle(C, scene);
  assert.equal(lever.update({matrix: null, profile: PROFILE, throttle: 0.5}), false, 'no aircraft, no lever');

  assert.equal(lever.update({matrix: 'M', scale: 2, profile: PROFILE, throttle: 0.4}), true);
  assert.equal(scene.primitives.list.length, 2, '고정 부분과 움직이는 부분');
  assert.ok(built.every(p => p.asynchronous === false));
  // A per-instance distanceDisplayCondition is tested against a sphere fixed
  // at build time and is wrong under a model matrix: the whole thing vanishes.
  const instances = built.flatMap(p => p.geometryInstances);
  assert.ok(instances.length > 0);
  assert.ok(instances.every(i => !('distanceDisplayCondition' in i.attributes)));
  // Back faces are culled, so the boxes must be closed and opaque.
  assert.ok(built.every(p => p.appearance.closed === true && p.appearance.translucent === false));
  // Only the moving part answers a pick; the housing is not a control.
  assert.equal(built[0].allowPicking, false);
  assert.equal(built[1].allowPicking, true);
  // Each carries its own matrix to be written into. Cesium's default is the
  // frozen IDENTITY, and a result written there throws inside postRender.
  assert.ok(built[0].modelMatrix && built[1].modelMatrix);
  assert.notEqual(built[0].modelMatrix, built[1].modelMatrix, '두 부분이 같은 행렬을 쓰면 안 된다');
  assert.ok(!Object.isFrozen(built[0].modelMatrix));

  // The picture follows the number, and the number only.
  const angleOf = () => lever.lever.modelMatrix.product[1].product?.[1]?.rotation?.rotationX
    ?? lever.lever.modelMatrix.product[1].rotation?.rotationX;
  lever.update({matrix: 'M', scale: 2, profile: PROFILE, throttle: 0});
  const low = angleOf();
  lever.update({matrix: 'M', scale: 2, profile: PROFILE, throttle: 1});
  assert.ok(Math.sin(angleOf()) < Math.sin(low), '값이 오르면 레버가 앞으로 간다');
  assert.equal(lever.value, 1);

  // Hidden rather than rebuilt when there is nothing to fly.
  lever.update({matrix: 'M', scale: 2, profile: PROFILE, throttle: 0.4, visible: false});
  assert.equal(lever.base.show, false);
  assert.equal(lever.lever.show, false);
  assert.equal(scene.primitives.list.length, 2, 'still there, just not drawn');

  // Leaving the cockpit takes it out of the scene.
  lever.destroy();
  assert.equal(scene.primitives.list.length, 0);
});

test('a hand on the lever is not a hand on the camera', () => {
  const {C} = fakeCesium();
  const scene = fakeScene();
  const lever = new CockpitThrottle(C, scene);
  lever.update({matrix: 'M', scale: 1, profile: PROFILE, throttle: 0.5});

  // Pointer somewhere else in the cabin: the camera keeps it.
  scene.picked = {id: 'something-else'};
  assert.equal(lever.grab({x: 10, y: 10}, 0.5), false);
  assert.equal(lever.move({x: 10, y: 40}), null, 'and no throttle is written');

  scene.picked = {id: 'cockpit-throttle'};
  assert.equal(lever.grab({x: 10, y: 10}, 0.5), true);
  const pulled = lever.move({x: 10, y: -40});
  assert.ok(pulled > 0.5, '위로 끌면 출력이 오른다');
  // It keeps travelling from where it was grabbed, not from the last frame.
  assert.equal(lever.move({x: 10, y: 10}), 0.5, '제자리로 돌아오면 원래 값');
  lever.release();
  assert.equal(lever.move({x: 10, y: -40}), null, '놓으면 더 이상 쓰지 않는다');

  // Nothing drawn is nothing to grab, whatever the scene reports.
  lever.hide();
  assert.equal(lever.grab({x: 10, y: 10}, 0.5), false);
  lever.destroy();
});

test('the cockpit gives the lever the pointer first, and only to a hand allowed to fly', () => {
  const view = readSource();
  // A stick's own lever is the authority when one is attached; this one reports.
  assert.match(view, /controls\?\.enabled&&controls\.source!=='joystick'&&this\.throttle3d\?\.grab/);
  // Taking the pointer for the lever must return before the camera drag starts.
  const grab = view.indexOf('throttle3d?.grab');
  const camera = view.indexOf('this.drag={id:e.pointerId');
  assert.ok(grab > 0 && camera > grab, 'the camera drag is the fallback, not the first thing');
  // Dragging writes through the one path the keyboard and the stick also use.
  assert.match(view, /this\.onControl\?\.\('throttle',value\)/);
  // Injected, not imported: the cockpit is served from a different mount than
  // the visualization, so a direct import resolves in the browser and nowhere
  // else. Every other Cesium-side collaborator here arrives the same way.
  assert.doesNotMatch(view, /import .*cockpit_throttle/);
  assert.match(view, /Throttle\?new Throttle\(globe\.C,globe\.viewer\.scene\)/);
  assert.match(readSource('../../../../user_application/web/app.js'), /Throttle:CockpitThrottle/);
  // And the session no longer refuses a throttle that did not come from the
  // screen widget it used to come from.
  const session = readSource('../../../../user_application/web/domains/uam/cockpit/manual_flight_session.js');
  assert.match(session, /action==='throttle'&&i\.source!=='joystick'/);
});

function readSource(path = '../../../../user_application/web/domains/uam/cockpit/cockpit_view.js') {
  return require('node:fs').readFileSync(new URL(path, import.meta.url), 'utf8');
}
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);


test('3D stick follows bounded commands without rebuilding and re-entry recreates released geometry',()=>{
 const {C}=fakeCesium(),scene=fakeScene(),stick=new CockpitStick(C,scene),matrix=new C.Matrix4();
 assert.equal(stick.update({profile:PROFILE,matrix,scale:1,controls:{roll:1,pitch:-1}}),true);
 assert.equal(scene.primitives.list.length,2);const grip=stick.lever;
 stick.update({profile:PROFILE,matrix,scale:1,controls:{roll:-1,pitch:1}});
 assert.equal(stick.lever,grip);assert.deepEqual(stickAngles({roll:3,pitch:-2,yaw:NaN}),{roll:-.3,pitch:-.3,yaw:-0});
 scene.picked={id:'cockpit-stick'};assert.equal(stick.grab({x:10,y:10},{roll:0,pitch:0}),true);
 const value=stick.move({x:230,y:230});assert.ok(Math.hypot(value.x,value.y)<=1.000001);stick.release();assert.equal(stick.move({x:0,y:0}),null);
 stick.remove();assert.equal(scene.primitives.list.length,0);
 stick.update({profile:PROFILE,matrix,scale:1,controls:{}});assert.equal(scene.primitives.list.length,2);assert.notEqual(stick.lever,grip);stick.destroy();
 assert.equal(stickFromDrag({},NaN,0),null);
});


test('cockpit view forwards look and reset to its camera',async()=>{
 const {CockpitView}=await import('../../../../user_application/web/domains/uam/cockpit/cockpit_view.js');
 const calls=[],view=Object.create(CockpitView.prototype);
 view.camera={look:(x,y)=>calls.push([x,y]),resetLook:()=>calls.push('reset')};
 view.look(26,-13);view.resetLook();assert.deepEqual(calls,[[26,-13],'reset']);
});

// Check physical grip travel after the same local X rotation and cabin-axis
// correction as the renderer, rather than assuming an angle sign means forward.
test('grip travels away from the pilot for every increase of power', () => {
  const {C}=fakeCesium(), frame=throttleFrame(PROFILE);
  const toward=[frame.toward[0],-frame.toward[2],frame.toward[1]];
  let previous=Infinity;
  for (let i=0;i<=20;i++) {
    const m=leverMatrix(C,frame,2,leverAngle(i/20));
    const [base,spin]=m.product, a=spin.rotation.rotationX;
    const y=Math.cos(a)*frame.rise*.315,z=Math.sin(a)*frame.rise*.315;
    const v=base.v;
    const delta=[v[1]*y+v[2]*z,v[5]*y+v[6]*z,v[9]*y+v[10]*z];
    const pilotDistance=delta.reduce((sum,x,j)=>sum+x*toward[j],0);
    assert.ok(pilotDistance<previous,'more power must move grip away from pilot');
    if(i===0)assert.ok(pilotDistance>0,'idle grip lies toward pilot');
    if(i===20)assert.ok(pilotDistance<0,'full grip lies forward');
    previous=pilotDistance;
  }
});
