// Turning propellers: what turns, how fast, and — most of all — that a spin
// leaves the propeller where the model put it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ASSUMED_RADPS, FULL_SCALE_RADPS, MAX_STEP_S, RotorSpin, VISIBLE_MAX_RADPS, rateOf, tiltOf,
  visibleRate, FLIGHT_MAX_RADPS, flightSpinOf}
  from '../../../../digital_twin/visualization/web/rotor_spin.js';

const library = new URL('../../../../digital_twin/model_library/visual_assets/', import.meta.url);
const asset = name => JSON.parse(readFileSync(new URL(`aircraft/civilian/${name}/asset.json`, library), 'utf8'));
const catalogSource = readFileSync(
  new URL('../../../../digital_twin/model_library/visual_catalog.py', import.meta.url), 'utf8');
const layerSource = readFileSync(
  new URL('../../../../digital_twin/visualization/web/flight_layer.js', import.meta.url), 'utf8');

// Just enough Cesium to do the matrix arithmetic, in the same column-major
// layout Cesium uses, so the test exercises the real index maths.
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mul3 = (left, right) => {
  const out = new Array(9).fill(0);
  for (let column = 0; column < 3; column++)
    for (let row = 0; row < 3; row++)
      for (let k = 0; k < 3; k++) out[column * 3 + row] += left[k * 3 + row] * right[column * 3 + k];
  return out;
};
const C = {
  Cartesian3: class {constructor(x = 0, y = 0, z = 0) {this.x = x; this.y = y; this.z = z;}},
  Matrix3: class {
    constructor() {return Object.assign([], [1, 0, 0, 0, 1, 0, 0, 0, 1]);}
    static clone(matrix, result) {return Object.assign(result ?? [], matrix);}
    static multiply(left, right, result) {return Object.assign(result ?? [], mul3(left, right));}
    static fromRotationX(angle, result) {
      const c = Math.cos(angle), s = Math.sin(angle);
      return Object.assign(result ?? [], [1, 0, 0, 0, c, s, 0, -s, c]);
    }
    static fromRotationY(angle, result) {
      const c = Math.cos(angle), s = Math.sin(angle);
      return Object.assign(result ?? [], [c, 0, -s, 0, 1, 0, s, 0, c]);
    }
    static fromRotationZ(angle, result) {
      const c = Math.cos(angle), s = Math.sin(angle);
      return Object.assign(result ?? [], [c, s, 0, -s, c, 0, 0, 0, 1]);
    }
  },
  Matrix4: class {
    constructor() {return Object.assign([], identity());}
    static clone(matrix, result) {return Object.assign(result ?? [], matrix);}
    static getTranslation(matrix, result) {
      const out = result ?? {};
      out.x = matrix[12]; out.y = matrix[13]; out.z = matrix[14];
      return out;
    }
    static getMatrix3(matrix, result) {
      const out = result ?? [];
      for (let column = 0; column < 3; column++)
        for (let row = 0; row < 3; row++) out[column * 3 + row] = matrix[column * 4 + row];
      return out;
    }
    static fromRotationTranslation(rotation, translation, result) {
      const out = Object.assign(result ?? [], identity());
      for (let column = 0; column < 3; column++)
        for (let row = 0; row < 3; row++) out[column * 4 + row] = rotation[column * 3 + row];
      out[12] = translation.x; out[13] = translation.y; out[14] = translation.z;
      return out;
    }
  },
};

// A model whose nodes are only a name and a matrix, which is all the spin uses.
function fakeModel(nodes) {
  const made = new Map(nodes.map(({name, translation = [0, 0, 0]}) => {
    const matrix = identity();
    matrix[12] = translation[0]; matrix[13] = translation[1]; matrix[14] = translation[2];
    return [name, {name, matrix: matrix.slice(), originalMatrix: matrix.slice()}];
  }));
  return {getNode: name => made.get(name) ?? undefined, nodes: made};
}

const AIRTAXI_ROTORS = {axis: 'y', nodes: [
  {name: 'Prop_FL', turn: -1}, {name: 'Prop_FR', turn: 1},
  {name: 'Prop_RL', turn: 1}, {name: 'Prop_RR', turn: -1}]};

test('startup ramps from zero while flight reaches a much faster presentation', () => {
  assert.equal(visibleRate(0, true), 0);
  assert.equal(visibleRate(300, true), FLIGHT_MAX_RADPS);
  assert.equal(FLIGHT_MAX_RADPS / (2 * Math.PI), 12);
  const rates = [0, 30, 60, 150, 270, 300].map(r => visibleRate(r, true));
  assert.ok(rates.every((rate, i) => !i || rate > rates[i - 1]));
  assert.ok(visibleRate(270, true) > visibleRate(270) * 5);
  assert.equal(flightSpinOf({kind: 'vertical', stage: 'takeoff'}), true);
  assert.equal(flightSpinOf({kind: 'air', stage: 'cruise'}), true);
  assert.equal(flightSpinOf({kind: 'ground', airborne: true}), false);
  assert.equal(flightSpinOf({kind: 'air', motor_state: 'shutdown'}), false);
  assert.equal(flightSpinOf({kind: 'air', stage: 'charge'}), false);
  assert.equal(visibleRate(0, flightSpinOf({kind:'air'})), 0);
});

test('flight rate reaches the node animation, without moving the hub', () => {
  const model = fakeModel([{name:'Prop_FL', translation:[2,3,4]}]);
  const spin = new RotorSpin(C, AIRTAXI_ROTORS);spin.attach(model);
  spin.advance(1 / 60, 300, 0, true);
  assert.ok(Math.abs(spin.angle - FLIGHT_MAX_RADPS / 60) < 1e-12);
  assert.deepEqual(model.getNode('Prop_FL').matrix.slice(12,15), [2,3,4]);
  const before = spin.angle;spin.advance(1 / 60, 0, 0, true);
  assert.equal(spin.angle, before);
});

test('a propeller turns where it stands: the hub does not move', () => {
  const model = fakeModel([{name: 'Prop_FL', translation: [2, 0.65, -2.59]},
    {name: 'Prop_FR', translation: [2, 0.65, 2.59]},
    {name: 'Prop_RL', translation: [-1.5, 2.4, -2.62]},
    {name: 'Prop_RR', translation: [-1.5, 2.4, 2.62]}]);
  const spin = new RotorSpin(C, AIRTAXI_ROTORS);
  assert.equal(spin.attach(model), 4);
  assert.deepEqual(spin.missing, []);
  const hub = node => model.getNode(node).matrix.slice(12, 15);
  const before = ['Prop_FL', 'Prop_FR', 'Prop_RL', 'Prop_RR'].map(hub);
  spin.advance(0.5, 400);
  assert.deepEqual(['Prop_FL', 'Prop_FR', 'Prop_RL', 'Prop_RR'].map(hub), before,
    'a spin must not swing the propeller around the aircraft');
  // And it really did turn.
  const turned = model.getNode('Prop_FL').matrix;
  assert.notEqual(turned[0], 1);
  assert.ok(Math.abs(turned[0] ** 2 + turned[8] ** 2 - 1) < 1e-9, 'still a rotation, not a squash');
});

test('the two directions really are opposite', () => {
  const model = fakeModel([{name: 'Prop_FL'}, {name: 'Prop_FR'}]);
  const spin = new RotorSpin(C, AIRTAXI_ROTORS);
  spin.attach(model);
  spin.advance(0.3, 500);
  const clockwise = model.getNode('Prop_FL').matrix;
  const counter = model.getNode('Prop_FR').matrix;
  assert.ok(Math.abs(clockwise[2]) > 1e-6, 'it turned at all');
  assert.ok(Math.abs(clockwise[2] + counter[2]) < 1e-9, 'and the pair turned opposite ways');
});

test('every frame turns from the model as authored, so the blades never drift off the shaft', () => {
  const model = fakeModel([{name: 'Prop_FL', translation: [2, 0.65, -2.59]}]);
  const spin = new RotorSpin(C, AIRTAXI_ROTORS);
  spin.attach(model);
  for (let frame = 0; frame < 600; frame++) spin.advance(1 / 60, 400);
  const matrix = model.getNode('Prop_FL').matrix;
  assert.deepEqual(matrix.slice(12, 15), [2, 0.65, -2.59]);
  // Ten seconds of spinning is still an exact rotation: compounding matrices
  // frame after frame would have crept away from one by now.
  assert.ok(Math.abs(matrix[0] ** 2 + matrix[8] ** 2 - 1) < 1e-12);
  assert.ok(spin.angle >= 0 && spin.angle < Math.PI * 2, 'the angle is held inside one turn');
});

test('how fast it looks follows how fast it is really turning, and stops when it stops', () => {
  assert.equal(VISIBLE_MAX_RADPS, 8 * Math.PI, 'visual cap is four revolutions per second');
  assert.ok(Math.abs(visibleRate(275) - 4 * Math.PI) < 1e-12, 'half throttle now displays two revolutions per second');
  assert.equal(visibleRate(0), 0, 'a parked aircraft looks parked');
  assert.equal(visibleRate(-5), 0);
  assert.equal(visibleRate(undefined), 0);
  assert.equal(visibleRate(FULL_SCALE_RADPS), VISIBLE_MAX_RADPS);
  assert.equal(visibleRate(FULL_SCALE_RADPS * 4), VISIBLE_MAX_RADPS, 'and is capped where it stops reading');
  assert.ok(visibleRate(270) < visibleRate(500), 'a harder-working rotor looks faster');
  assert.equal(visibleRate(FULL_SCALE_RADPS / 2), VISIBLE_MAX_RADPS / 2);
});

test('a flown state is turned at its own rotor speed; one without rotors is only indicated', () => {
  // The native engine measured it, so that is what is used.
  assert.equal(rateOf({rotor_radps: 412, kind: 'air'}), 412);
  assert.equal(rateOf({rotor_radps: 0, kind: 'air'}), 0, 'a measured zero is a stopped rotor');
  // Nothing measured it: airborne means turning, parked means still.
  assert.equal(rateOf({kind: 'air', speed_mps: 40}), ASSUMED_RADPS);
  assert.equal(rateOf({kind: 'vertical', speed_mps: 3}), ASSUMED_RADPS);
  assert.equal(rateOf({kind: 'ground', stage: 'gate_out', speed_mps: 4}), 0);
  assert.equal(rateOf({kind: 'ground', stage: 'charge', speed_mps: 0}), 0);
  assert.equal(rateOf(null), 0);
});

test('nothing spins when the model has no rotors, rather than something else being turned', () => {
  const spin = new RotorSpin(C, {axis: 'y', nodes: []});
  assert.equal(spin.attach(fakeModel([{name: 'Prop_FL'}])), 0);
  assert.equal(spin.attached, false);
  assert.equal(spin.advance(1, 400), false);
  // A model that never had the nodes says which ones it is missing.
  const other = new RotorSpin(C, AIRTAXI_ROTORS);
  assert.equal(other.attach(fakeModel([{name: 'Prop_FL'}])), 1);
  assert.deepEqual(other.missing, ['Prop_FR', 'Prop_RL', 'Prop_RR']);
  assert.equal(other.attach({}), 0, 'a model with no nodes at all is simply not spun');
});

test('a stalled tab does not fling the blades round when it comes back', () => {
  const model = fakeModel([{name: 'Prop_FL'}]);
  const spin = new RotorSpin(C, AIRTAXI_ROTORS);
  spin.attach(model);
  spin.advance(30, FULL_SCALE_RADPS);          // half a minute in one frame
  const long = spin.angle;
  assert.ok(long >= 0 && long < Math.PI * 2);
  spin.angle = 0;
  spin.advance(MAX_STEP_S, FULL_SCALE_RADPS);
  assert.equal(Math.round(long * 1e6), Math.round(spin.angle * 1e6),
    'a long stall advances by the clamp, not by the whole gap');
  // And the clamp is not a whole turn, so a stall does not resume in exactly
  // the place it stopped and look as though nothing happened.
  assert.ok(Math.abs(long % (Math.PI * 2)) > 0.1, 'the clamped step is not a full revolution');
});

test('a sixty-frame second turns the blades smoothly rather than in one jump', () => {
  const model = fakeModel([{name: 'Prop_FL'}]);
  const spin = new RotorSpin(C, AIRTAXI_ROTORS);
  spin.attach(model);
  const seen = [];
  for (let frame = 0; frame < 12; frame++) {
    spin.advance(1 / 60, 400);
    seen.push(Math.round(spin.angle * 1e4));
  }
  assert.equal(new Set(seen).size, seen.length, 'every frame is a new angle');
  const steps = seen.slice(1).map((angle, at) => angle - seen[at]);
  const expectedStep = visibleRate(400) / 60 * 1e4;
  assert.ok(steps.every(step => Math.abs(step - expectedStep) <= 1), 'each step follows the faster rate evenly');
  assert.ok(expectedStep < Math.PI / 6 * 1e4, 'under 30 degrees per frame at 60 FPS');
});

// ---- the ducts tilt ---------------------------------------------------------

// A canted duct, exactly as the air taxi authors one: yawed thirty degrees in
// plan, so a tilt applied in the wrong frame is visibly wrong.
const CANT = Math.PI / 6;
const yawed = angle => {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [c, 0, -s, 0, 1, 0, s, 0, c];
};
function tiltModel() {
  const shroud = C.Matrix4.fromRotationTranslation(yawed(-CANT), {x: 2, y: 0.65, z: -2.59}, []);
  const prop = C.Matrix4.fromRotationTranslation([1, 0, 0, 0, 1, 0, 0, 0, 1], {x: 2, y: 0.65, z: -2.59}, []);
  const made = new Map([
    ['Shroud_FL', {name: 'Shroud_FL', matrix: shroud.slice(), originalMatrix: shroud.slice()}],
    ['Prop_FL', {name: 'Prop_FL', matrix: prop.slice(), originalMatrix: prop.slice()}],
  ]);
  return {getNode: name => made.get(name) ?? undefined};
}
const TILTING = {axis: 'y', nodes: [{name: 'Prop_FL', turn: -1}],
  tilt: {axis: 'z', sign: -1, frame: 'parent', nodes: ['Shroud_FL', 'Prop_FL']}};
// The direction a part's thrust points, which for a rotor disc is its own +Y
// carried by whatever the matrix has done to it.
const thrustOf = matrix => ({x: matrix[4], y: matrix[5], z: matrix[6]});

test('a fully tilted duct points its thrust at the nose, not at the tail', () => {
  const model = tiltModel();
  const spin = new RotorSpin(C, TILTING);
  assert.equal(spin.attach(model), 2);
  assert.deepEqual(spin.counts, {spinning: 1, tilting: 2, total: 2});
  // Rotors up: thrust straight up, which is what a multirotor does.
  spin.advance(0, 0, 0);
  const lifting = thrustOf(model.getNode('Prop_FL').matrix);
  assert.ok(Math.abs(lifting.y - 1) < 1e-9, 'nought tilt lifts');
  // Fully forward: thrust along the model's forward axis, +X.
  spin.advance(0, 0, Math.PI / 2);
  const pulling = thrustOf(model.getNode('Prop_FL').matrix);
  assert.ok(Math.abs(pulling.x - 1) < 1e-9, `ninety degrees pulls forward, not ${JSON.stringify(pulling)}`);
  assert.ok(Math.abs(pulling.y) < 1e-9);
  // Half way there, leaning forward and still partly lifting.
  spin.advance(0, 0, Math.PI / 4);
  const between = thrustOf(model.getNode('Prop_FL').matrix);
  assert.ok(between.x > 0.6 && between.y > 0.6, 'it leans rather than jumping');
});

test('the hinge is the airframe axis, so a canted duct swings the same way as a straight one', () => {
  const model = tiltModel();
  const spin = new RotorSpin(C, TILTING);
  spin.attach(model);
  spin.advance(0, 0, Math.PI / 2);
  const duct = thrustOf(model.getNode('Shroud_FL').matrix);
  const prop = thrustOf(model.getNode('Prop_FL').matrix);
  // The duct is yawed thirty degrees; had the tilt been applied about its own
  // canted axis, its thrust would have ended up thirty degrees off the nose.
  assert.ok(Math.abs(duct.x - 1) < 1e-9, `the duct faces the nose, not ${JSON.stringify(duct)}`);
  assert.ok(Math.abs(duct.z) < 1e-9, 'and is not swung sideways by its own cant');
  assert.ok(Math.abs(duct.x - prop.x) < 1e-9, 'the propeller went with its duct');
});

test('a tilted propeller still turns about its own shaft, wherever the duct has put it', () => {
  const model = tiltModel();
  const spin = new RotorSpin(C, TILTING);
  spin.attach(model);
  spin.advance(0.2, 400, Math.PI / 2);
  const first = thrustOf(model.getNode('Prop_FL').matrix);
  const hub = model.getNode('Prop_FL').matrix.slice(12, 15);
  spin.advance(0.2, 400, Math.PI / 2);
  const second = thrustOf(model.getNode('Prop_FL').matrix);
  // Turning about the shaft cannot move the shaft.
  assert.ok(Math.abs(first.x - second.x) < 1e-9 && Math.abs(first.y - second.y) < 1e-9,
    'the disc still faces the nose after turning');
  assert.deepEqual(model.getNode('Prop_FL').matrix.slice(12, 15), hub, 'and stays on its hub');
  // It really did turn: the blade direction across the disc changed.
  const before = spin.angle;
  spin.advance(0.2, 400, Math.PI / 2);
  assert.notEqual(spin.angle, before);
});

test('the tilt is the angle the simulation reached, and a state without one lifts', () => {
  assert.equal(tiltOf({tilt_deg: 0}), 0);
  assert.ok(Math.abs(tiltOf({tilt_deg: 90}) - Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(tiltOf({tilt_deg: 45}) - Math.PI / 4) < 1e-12);
  assert.equal(tiltOf({}), 0, 'nothing measured it, so the rotors are lifting');
  assert.equal(tiltOf(null), 0);
});

test('a model with no tilt declared is not tilted', () => {
  const model = fakeModel([{name: 'Prop_FL'}]);
  const spin = new RotorSpin(C, AIRTAXI_ROTORS);          // no tilt block
  spin.attach(model);
  const before = model.getNode('Prop_FL').matrix.slice();
  spin.advance(0, 0, Math.PI / 2);
  assert.deepEqual(model.getNode('Prop_FL').matrix.slice(), before,
    'a Joby whose nacelles could not be separated stays as it is');
});

// ---- what the library says each airframe has -------------------------------

test('every UAM airframe in the library declares the propellers it has', () => {
  for (const [name, count] of [['projectairsim_airtaxi', 4], ['kp2a', 4], ['joby_s4', 6]]) {
    const rotors = asset(name).rotors;
    assert.ok(rotors, `${name} declares its rotors`);
    assert.equal(rotors.nodes.length, count, `${name} has ${count} propellers`);
    assert.equal(rotors.axis, 'y', `${name} spins about the axis its discs are thin along`);
    assert.ok(rotors.note?.length > 40, `${name} says where those figures came from`);
    // Turning every rotor the same way would leave the airframe unbalanced;
    // every one of these is an even number of counter-rotating pairs.
    const turns = rotors.nodes.map(node => node.turn);
    assert.deepEqual(turns.filter(t => t > 0).length, turns.filter(t => t < 0).length,
      `${name} turns as many one way as the other`);
    assert.ok(new Set(rotors.nodes.map(node => node.name)).size === count, 'no node named twice');
  }
});

test('a declared direction says whether it was read or inferred', () => {
  // The air taxi's directions come from the vehicle model package it was
  // exported from; the Joby carries none, and says so rather than implying one.
  for (const node of asset('projectairsim_airtaxi').rotors.nodes) {
    assert.match(node.declared, /clock-wise/);
  }
  assert.match(asset('joby_s4').rotors.direction_basis, /Inferred/);
  assert.match(asset('projectairsim_airtaxi').rotors.note, /model\.jsonc/);
});

test('the catalogue carries the rotors to the browser, and the layer turns them', () => {
  assert.match(catalogSource, /rotors=meta\.get\('rotors'\)/, 'the library projects its rotor record');
  assert.match(catalogSource, /'turn':node\.get\('turn',1\)/);
  assert.match(layerSource, /import \{RotorSpin, rateOf, tiltOf, flightSpinOf\}/);
  assert.match(layerSource, /if \(!this\.model\?\.ready\) return 0;/,
    'the propellers are looked up once the model can answer for its nodes');
  assert.match(layerSource, /this\.rotors\.advance\(elapsed, rateOf\(sample\), tiltOf\(sample\), flightSpinOf\(sample\)\)/);
  // Real seconds, not simulated ones: playing at sixteen times speed must not
  // spin the blades sixteen times faster.
  assert.match(layerSource, /performance\?\.now/);
});

test('five single-flight rigs have complete nodes and model-specific shaft directions', () => {
  const mul4=(a,b)=>{const o=Array(16).fill(0);for(let c=0;c<4;c++)for(let r=0;r<4;r++)for(let k=0;k<4;k++)o[c*4+r]+=a[k*4+r]*b[c*4+k];return o;};
  const matrixOf=n=>{
    if(n.matrix)return n.matrix.slice();
    const [x,y,z,w]=n.rotation??[0,0,0,1],s=n.scale??[1,1,1],t=n.translation??[0,0,0];
    return [(1-2*y*y-2*z*z)*s[0],(2*x*y+2*z*w)*s[0],(2*x*z-2*y*w)*s[0],0,
      (2*x*y-2*z*w)*s[1],(1-2*x*x-2*z*z)*s[1],(2*y*z+2*x*w)*s[1],0,
      (2*x*z+2*y*w)*s[2],(2*y*z-2*x*w)*s[2],(1-2*x*x-2*y*y)*s[2],0,...t,1];
  };
  for(const id of ['projectairsim_airtaxi','joby_s4','kp2a','x_57','amvlab_evtol']){
    const meta=asset(id), spec=meta.flight_visual?.rotors??meta.rotors;
    const bytes=readFileSync(new URL(`aircraft/civilian/${id}/${meta.flight_visual?.path??meta.model.path}`,library));
    const doc=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
    const nodes=doc.nodes.map(n=>({name:n.name,originalMatrix:matrixOf(n),matrix:matrixOf(n)}));
    const parents=new Map();doc.nodes.forEach((n,i)=>(n.children??[]).forEach(c=>parents.set(c,i)));
    const model={getNode:name=>nodes.find(n=>n.name===name)};
    const spin=new RotorSpin(C,spec);spin.attach(model);assert.deepEqual(spin.missing,[],id);
    const world=i=>parents.has(i)?mul4(world(parents.get(i)),nodes[i].matrix):nodes[i].matrix;
    const zero=nodes.map(n=>n.matrix.slice());
    for(const tilt of [0,45,90,45,0]){
      spin.advance(0,0,tilt*Math.PI/180);
      for(const [j,s] of spec.nodes.entries()){
        const i=nodes.findIndex(n=>n.name===s.name),m=world(i),a={x:0,y:1,z:2}[s.axis??spec.axis??'y'];
        const vector=[m[a*4],m[a*4+1],m[a*4+2]],length=Math.hypot(...vector),v=vector.map(x=>x/length);
        const aft=id==='kp2a'&&j>=2;
        // Duct cants are intrinsic to AirTaxi. Other shaft axes are orthogonal.
        if(id!=='projectairsim_airtaxi'){
          const expected=(id==='x_57'&&s.start_at_tilt_deg!=null?90:aft?0:tilt)*Math.PI/180;
          assert.ok(Math.abs(Math.abs(v[1])-Math.cos(expected))<.002,`${id} rotor ${j} up at ${tilt}: ${v}`);
          assert.ok(Math.abs(Math.abs(v[0])-Math.sin(expected))<.002,`${id} rotor ${j} forward at ${tilt}: ${v}`);
          if(id==='joby_s4'&&tilt===90)assert.ok(j<4?v[0]>.99:v[0]<-.99,'Joby front / rear oppose');
        }
      }
    }
    nodes.forEach((n,i)=>n.matrix.forEach((v,j)=>assert.ok(Math.abs(v-zero[i][j])<1e-8,`${id} reversible ${n.name}`)));
  }
});
for (const variant of ['original', 'flight']) {
  test(`KP2 ${variant}: only rear lift props stop in fixed-wing and resume from held phase`, () => {
    const meta = asset('kp2a');
    const spec = variant === 'flight' ? meta.flight_visual.rotors : meta.rotors;
    const model = fakeModel(spec.nodes.map(n => ({...n, translation:[1,2,3]})));
    const spin = new RotorSpin(C, spec); spin.attach(model);
    const rear = spec.nodes.filter(n => n.stop_at_tilt_deg === 85);
    assert.equal(rear.length, 2);
    assert.ok(rear.every(n => n.name.includes('PropellerB_')));
    const snapshot = n => model.getNode(n.name).matrix.slice();
    const initial = rear.map(snapshot);
    spin.advance(1/60, 300, 0, true);
    rear.forEach((n,i) => assert.notDeepEqual(snapshot(n), initial[i]));
    for (const tilt of [85,90]) {
      spin.advance(0, 0, tilt*Math.PI/180, true);
      const held = spec.nodes.map(snapshot);
      for (let i=0;i<17;i++) spin.advance(1/60,300,tilt*Math.PI/180,true);
      spec.nodes.forEach((n,i) => {
        if(n.stop_at_tilt_deg) assert.deepEqual(snapshot(n),held[i]);
        else assert.notDeepEqual(snapshot(n),held[i]);
        assert.deepEqual(snapshot(n).slice(12,15),[1,2,3]);
      });
    }
    const part = spin.parts.find(p=>p.node.name===rear[0].name), phase=part.angle;
    spin.advance(0,300,84*Math.PI/180,true);
    assert.equal(part.angle,phase,'no phase jump when leaving fixed-wing');
    spin.advance(1/60,300,84*Math.PI/180,true);
    assert.ok(Math.abs(part.angle-(phase+FLIGHT_MAX_RADPS/60)%(2*Math.PI))<1e-12);
  });
}

test('other aircraft retain all propeller rotation at fixed-wing tilt', () => {
  for (const id of ['projectairsim_airtaxi','joby_s4','x_57','amvlab_evtol']) {
    const meta=asset(id),spec=meta.flight_visual?.rotors??meta.rotors;
    assert.ok(spec.nodes.every(n=>n.stop_at_tilt_deg==null));
    const model=fakeModel(spec.nodes),spin=new RotorSpin(C,spec);spin.attach(model);
    spin.advance(0,0,Math.PI/2,true);
    const before=spec.nodes.map(n=>model.getNode(n.name).matrix.slice());
    spin.advance(1/60,300,Math.PI/2,true);
    spec.nodes.forEach((n,i)=>assert.notDeepEqual(model.getNode(n.name).matrix,before[i],id));
  }
});

test('steady tilt uploads only turning props, not stationary ducts or held lift props',()=>{
  const spec={axis:'y',nodes:[{name:'active'},{name:'held',stop_at_tilt_deg:85}],
    tilt:{axis:'z',nodes:['active','held','duct']}};
  const model=fakeModel([{name:'active'},{name:'held'},{name:'duct'}]);
  const writes={active:0,held:0,duct:0};
  for(const [name,node] of model.nodes){let matrix=node.matrix;
    Object.defineProperty(node,'matrix',{get:()=>matrix,set(value){matrix=value;writes[name]++;}});}
  const spin=new RotorSpin(C,spec);spin.tilt=Math.PI/2;spin.attach(model);
  Object.keys(writes).forEach(name=>writes[name]=0);
  for(let frame=0;frame<120;frame++)spin.advance(1/60,300,Math.PI/2,true);
  assert.deepEqual(writes,{active:120,held:0,duct:0},'240 redundant hierarchy invalidations eliminated over 120 frames');
  spin.advance(0,0,Math.PI/4,true);
  assert.deepEqual(writes,{active:121,held:1,duct:1},'every part still follows measured tilt immediately');
});

test('a rig whose only propeller is held reports no changed GPU transform',()=>{
  const model=fakeModel([{name:'held'}]);
  const spin=new RotorSpin(C,{axis:'y',nodes:[{name:'held',stop_at_tilt_deg:85}]});
  spin.tilt=Math.PI/2;spin.attach(model);
  assert.equal(spin.advance(1/60,300,Math.PI/2,true),false);
  assert.equal(spin.advance(1/60,300,Math.PI/4,true),true);
});

test('X57 twelve inboard props start in fixed-wing and hold phase in VTOL',()=>{
 const spec=asset('x_57').flight_visual.rotors,small=spec.nodes.filter(n=>n.start_at_tilt_deg===85);
 assert.equal(small.length,12);assert.equal(spec.nodes.length,14);
 const model=fakeModel(spec.nodes),spin=new RotorSpin(C,spec);spin.attach(model);
 const snapshot=()=>small.map(n=>model.getNode(n.name).matrix.slice());const initial=snapshot();
 spin.advance(1/60,300,0,true);assert.deepEqual(snapshot(),initial);
 spin.advance(1/60,300,Math.PI/2,true);const cruise=snapshot();
 cruise.forEach((m,i)=>assert.notDeepEqual(m,initial[i]));
 spin.advance(1/60,300,0,true);assert.deepEqual(snapshot(),cruise);
 spin.advance(0,0,Math.PI/2,true);assert.deepEqual(snapshot(),cruise);
});

test('paused initial render attaches all flight rigs at VTOL without spinning; late load preserves seek tilt', async()=>{
  const {FlightLayer}=await import('../../../../digital_twin/visualization/web/flight_layer.js');
  for(const id of ['kp2a','amvlab_evtol','joby_s4','x_57','projectairsim_airtaxi']){
    for(const tilt of [undefined,0,90]){
      let frame,requested=0;
      const mockC={...C,Cartesian2:class {constructor(x,y){this.x=x;this.y=y;}},PrimitiveCollection:class {}};
      const scene={primitives:{add:v=>v},preRender:{addEventListener:fn=>{frame=fn;return ()=>{};}},requestRender:()=>requested++};
      const layer=new FlightLayer(mockC,{entities:{},scene});
      layer.updateLabelLayout=()=>{};layer.updateControlSurfaces=()=>{};
      const meta=asset(id),spec=meta.flight_visual?.rotors??meta.rotors;
      const names=[...spec.nodes,...(spec.tilt?.nodes??[]).map(n=>typeof n==='string'?{name:n}:n)];
      const model=fakeModel(names);model.ready=false;
      layer.model=model;layer.rotorSpec=spec;layer.sample=tilt===undefined?null:{tilt_deg:tilt};
      frame();assert.equal(layer.rotors,null,'wait for model nodes');
      model.ready=true;frame();
      assert.ok(layer.rotors?.attached,id);
      assert.equal(layer.rotors.tilt,(tilt??0)*Math.PI/180);
      assert.equal(layer.rotors.angle,0,'no playback, no rotation');
      assert.equal(requested,1,'one follow-up frame flushes node transforms');
      const expectedModel=fakeModel(names),expected=new RotorSpin(C,spec);
      expected.tilt=(tilt??0)*Math.PI/180;expected.attach(expectedModel);
      for(const n of names)assert.deepEqual(model.getNode(n.name).matrix,expectedModel.getNode(n.name).matrix);
      for(let i=0;i<20;i++)frame();
      assert.equal(requested,1);assert.equal(layer.rotors.angle,0);
    }
  }
});
