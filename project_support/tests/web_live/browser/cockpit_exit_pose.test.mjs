import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CockpitCamera} from '../../../../digital_twin/visualization/web/cockpit_camera.js';
import {CockpitView} from '../../../../user_application/web/domains/uam/cockpit/cockpit_view.js';
import {LiveGlobe} from '../../../../digital_twin/visualization/web/globe.js';

// Leaving the cockpit to look at the same aircraft used to put the camera back
// where the pilot had been standing before they got in -- the vertiport they
// were looking at -- and then fly in from there. The view went to the vertiport
// and came back. Leaving on purpose now keeps the pose, so the camera starts at
// the aircraft and pulls out from it.

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
class V {constructor(x = 0, y = 0, z = 0) {Object.assign(this, {x, y, z});} static clone(p) {return new V(p.x, p.y, p.z);}}
const C = {Cartesian3: V, SceneMode: {SCENE3D: 3}, Matrix4: {IDENTITY: identity, clone: m => [...m]}};
const profile = {eye: [2, 3, 4], forward: [1, 0, 0], up: [0, 1, 0]};

function fixture() {
  const inputs = {enableInputs: true, enableRotate: false, enableZoom: true, enableTranslate: true,
    enableTilt: false, enableLook: true, enableCollisionDetection: true};
  const frustum = {near: 1, far: 1e8, fov: 1.2, aspectRatio: 1.7, clone() {return {...this};}};
  // Standing off at the vertiport, which is where the pilot was looking from.
  const camera = {frustum, positionWC: new V(10, 20, 30), directionWC: new V(1, 0, 0), upWC: new V(0, 0, 1),
    transform: identity, cancelFlight() {this.cancelled = true;}, setView(v) {this.last = v; this.views = (this.views ?? 0) + 1;}};
  const viewer = {camera, scene: {mode: 3, screenSpaceCameraController: inputs}, isDestroyed: () => false};
  const cockpit = new CockpitCamera(C, viewer);
  cockpit.enter({entityId: 'uam1', profile});
  cockpit.update({matrix: identity, scale: 2, now: 0, epoch: 1});
  return {camera, inputs, frustum, cockpit, atAircraft: camera.last.destination};
}

test('leaving on purpose leaves the camera at the aircraft, not back at the vertiport', () => {
  const f = fixture();
  f.cockpit.exit(true);
  assert.deepEqual(f.camera.last.destination, f.atAircraft, 'the camera never went back');
  // The cockpit's own settings are still handed back: they are its, not the pose's.
  assert.equal(f.camera.frustum, f.frustum, 'the near plane the cockpit narrowed is restored');
  assert.equal(f.inputs.enableRotate, false);
  assert.equal(f.inputs.enableZoom, true, 'and the controls the cockpit locked are usable again');
  assert.equal(f.cockpit.active, false);
});

test('an exit nobody asked for still puts the camera back where the pilot was', () => {
  const f = fixture();
  f.cockpit.exit();
  // Nothing to look at where it is standing -- the model is gone -- so the view
  // the operator had before is the best answer left.
  assert.deepEqual(f.camera.last.destination, new V(10, 20, 30));
  assert.equal(f.camera.frustum, f.frustum);
  assert.equal(f.cockpit.active, false);
});

test('a cockpit that was never entered is not moved by either kind of exit', () => {
  for (const keep of [true, false]) {
    const viewer = {camera: {setView() {throw new Error('moved a camera it never took');}},
      scene: {mode: 3, screenSpaceCameraController: {}}, isDestroyed: () => false};
    new CockpitCamera(C, viewer).exit(keep);
  }
});

function viewStub(camera) {
  return {camera, hideScreens() {}, showOccupants() {}, restoreNameplates() {}, model: null,
    entityId: 'uam1', single: false, singlePlan: null, drag: null, panel: {close() {}},
    button: {textContent: '', setAttribute() {}}, lastState: 0,
    document: {body: {classList: {remove() {}}}},
    globe: {items: {get: () => null}, entityScene: {applyVisibility() {}}}};
}

test('the view hands the reason for leaving down to the camera', () => {
  const asked = [];
  const stub = () => viewStub({exit: keep => asked.push(keep)});
  CockpitView.prototype.exit.call(stub(), true);            // leaving to follow it
  CockpitView.prototype.exit.call(stub());                  // the model went away
  CockpitView.prototype.exit.call(stub(), false, true);     // finding my own aircraft
  assert.deepEqual(asked, [true, false, true]);
});

test('looking at the target from outside leaves the cockpit before it flies', () => {
  const app = readFileSync(new URL('../../../../user_application/web/app.js', import.meta.url), 'utf8');
  // Both of the ways out of the cockpit that end up looking at the same
  // aircraft keep the pose; neither may go back and fly in again.
  assert.match(app, /\$\('focus'\)\.onclick=\(\)=>\{\s*\r?\n\s*const leaving=Boolean\(globe\.cockpit\?\.active\);\s*\r?\n\s*if\(leaving\)globe\.cockpit\.exit\(false,true\)/);
  assert.match(app, /focusDetail\(false,\{departure:leaving\}\)/,'target view marks only a cockpit exit as a vertical departure');
  assert.match(app, /manualFlight\.sample\)\{g\.cockpit\?\.exit\(false,true\)/);
  assert.doesNotMatch(app, /g\.cockpit\?\.exit\(\);g\.flyToFlight/, 'the old restore-then-fly is gone');
});

// `focus` is the other half of it. It flies from where the camera is now -- that
// is the whole point of its "never further away than the operator already is" --
// so a cockpit that snapped back to the vertiport before it measured made the
// approach start there. Every route into `focus` had that, not just the button.
function globeStub() {
  const asked = [];
  const globe = Object.create(LiveGlobe.prototype);
  Object.assign(globe, {
    cockpit: {active: true, exit: (follow, keep) => {asked.push([follow, keep]); globe.cockpit.active = false;}},
    C: {Matrix4: {IDENTITY: 'identity'}}, motion: {cancel() {}}, clearPreload() {},
    viewer: {camera: {cancelFlight() {}, lookAtTransform() {}}},
  });
  return {globe, asked};
}

test('stopping in order to look at that same aircraft keeps the pose; any other stop does not', () => {
  const asking = globeStub();
  asking.globe.stopTracking(true);
  assert.deepEqual(asking.asked, [[false, true]], '자리는 지키고 조종석만 나온다');
  assert.equal(asking.globe.tracking, false, 'and it is still a stop');

  const plain = globeStub();
  plain.globe.stopTracking();
  assert.deepEqual(plain.asked, [[false, false]], '그냥 멈추는 것은 예전처럼 되돌린다');

  // Nothing to exit is nothing to do.
  const none = globeStub();
  none.globe.cockpit.active = false;
  none.globe.stopTracking(true);
  assert.deepEqual(none.asked, []);
});

test('focus stops in the pose-keeping way, so its approach is measured from the aircraft', () => {
  const source = readFileSync(new URL('../../../../digital_twin/visualization/web/globe.js', import.meta.url), 'utf8');
  const lines = source.split(/\r?\n/), start = lines.findIndex(line => line.startsWith('  focus(track = true'));
  assert.ok(start > 0, 'focus()');
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('  }')) break;
    body.push(line);
  }
  assert.match(body.join('\n'), /this\.stopTracking\(true\)/);
  assert.doesNotMatch(body.join('\n'), /this\.stopTracking\(\)/, 'the bare stop is what sent it to the vertiport');
});

test('외부 추적 from inside the cockpit is the way out, not a toggle', () => {
  const app = readFileSync(new URL('../../../../user_application/web/app.js', import.meta.url), 'utf8');
  // You cannot already be following the aircraft you are sitting in, so there
  // is nothing to toggle: leaving is the whole action, and it keeps the pose.
  assert.match(app, /if\(globe\.cockpit\?\.active\)\{globe\.cockpit\.exit\(true\);\$\('track'\)\.setAttribute\('aria-pressed','true'\);return;\}/);
  // And it happens before the toggle that would otherwise have read the
  // cockpit's own tracking state and turned following off instead.
  const handler = app.slice(app.indexOf("$('track').onclick"));
  assert.ok(handler.indexOf('cockpit.exit(true)') < handler.indexOf('detailsTracked()'));
});

test('both cockpit exits request the rise-then-translate departure path',()=>{
 const source=readFileSync(new URL('../../../../user_application/web/domains/uam/cockpit/cockpit_view.js',import.meta.url),'utf8');
 assert.match(source,/else if\(follow&&item\)this\.globe\.focus\(true,undefined,\{departure:true\}\)/);
});
