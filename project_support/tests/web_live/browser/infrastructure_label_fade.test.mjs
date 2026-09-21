import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {InfrastructureLabelFade} from '../../../../digital_twin/visualization/web/infrastructure_label_fade.js';
import {RouteGeometryFade} from '../../../../digital_twin/visualization/web/route_geometry_fade.js';
import {ARRIVAL_FADE_MS, LABEL_FADE_MS, labelFadeAlpha} from '../../../../digital_twin/visualization/web/label_fade.js';
const C={NearFarScalar:class {constructor(near,nearValue,far,farValue){Object.assign(this,{near,nearValue,far,farValue});}},Cartesian3:{distance:(a,b)=>Math.abs(a.x-b.x)},SceneMode:{SCENE2D:2}};
const viewer={scene:{mode:3},camera:{positionWC:{x:500},positionCartographic:{height:500}}};
test('route and port annotations fade on creation, range entry and visibility restoration',()=>{
 const f=new InfrastructureLabelFade(C),e={position:{x:0},label:{distanceDisplayCondition:{near:0,far:1000},fillColor:'selected'}};
 f.update([e],viewer,0);assert.equal(e.label.translucencyByDistance.nearValue,0);
 f.update([e],viewer,450);assert.equal(e.label.translucencyByDistance.nearValue,.5);
 f.update([e],viewer,900);assert.equal(e.label.translucencyByDistance.nearValue,1);
 const done=e.label.translucencyByDistance;f.update([e],viewer,1000);assert.equal(e.label.translucencyByDistance,done);
 assert.equal(e.label.fillColor,'selected');assert.equal(e.label.show,undefined);
 f.update([e],viewer,1100,false);f.update([e],viewer,1200,true);assert.equal(e.label.translucencyByDistance.nearValue,0);
 viewer.camera.positionWC.x=2000;f.update([e],viewer,1300);viewer.camera.positionWC.x=500;
 f.update([e],viewer,1400);f.update([e],viewer,1850);assert.equal(e.label.translucencyByDistance.nearValue,.5);
});
test('Cesium properties, hidden labels and newly rebuilt entities are respected',()=>{
 const f=new InfrastructureLabelFade(C),e={show:true,position:{getValue:()=>({x:0})},label:{show:{getValue:()=>false}}};
 f.update([e],viewer,0);f.update([e],viewer,1000);assert.equal(e.label.translucencyByDistance.nearValue,0);
 e.label.show={getValue:()=>true};f.update([e],viewer,2000);f.update([e],viewer,2900);assert.equal(e.label.translucencyByDistance.nearValue,1);
 const next={...e,label:{}};f.update([next],viewer,3000);assert.equal(next.label.translucencyByDistance.nearValue,0);
});

test('port marker points reveal with their text rather than popping in ahead of it',()=>{
 const f=new InfrastructureLabelFade(C),e={position:{x:0},point:{},label:{}};
 f.update([e],viewer,0,true,0,2200,true);
 assert.equal(e.point.translucencyByDistance.nearValue,0);
 f.update([e],viewer,1100,true,0,2200,true);
 assert.equal(e.point.translucencyByDistance.nearValue,.5);
 assert.equal(e.label.translucencyByDistance.nearValue,.5);
});

test('zoom fades towards both distance boundaries without changing display limits',()=>{
 const f=new InfrastructureLabelFade(C),range={near:100,far:1100};
 const e={position:{x:0},label:{distanceDisplayCondition:range}};
 const v={scene:{mode:3},camera:{positionWC:{x:500}}};
 f.update([e],v,0);f.update([e],v,900);assert.equal(e.label.translucencyByDistance.nearValue,1);
 v.camera.positionWC.x=1025;f.update([e],v,1000);assert.equal(e.label.translucencyByDistance.nearValue,.5);
 v.camera.positionWC.x=1100;f.update([e],v,1100);assert.equal(e.label.translucencyByDistance.nearValue,0);
 v.camera.positionWC.x=175;f.update([e],v,1200);assert.equal(e.label.translucencyByDistance.nearValue,.5);
 assert.equal(e.label.distanceDisplayCondition,range);
});

test('planned UAM scale threshold fades before its hard show cutoff',()=>{
 const f=new InfrastructureLabelFade(C),e={label:{scale:.35}};
 f.update([e],viewer,0,true,.2);f.update([e],viewer,900,true,.2);
 assert.ok(e.label.translucencyByDistance.nearValue>.999);
 e.label.scale=.275;f.update([e],viewer,1000,true,.2);assert.ok(Math.abs(e.label.translucencyByDistance.nearValue-.5)<1e-9);
 e.label.scale=.2;f.update([e],viewer,1100,true,.2);assert.equal(e.label.translucencyByDistance.nearValue,0);
});

// ---- the arrival hand-over ---------------------------------------------
// What the opening flight held back becomes visible all at once. If a frame is
// drawn between that and the first fade update, the network is on screen at
// full strength for a frame, gone the next, and only then fades in - which is
// what it looked like: a flash, a blink, then a slow appearance.

test('a fade started on the arrival keeps the arrival length all the way up', () => {
  // The window is only about which length a fade is given when it starts, so a
  // label that began on the slow curve is not jerked onto the fast one.
  assert.ok(ARRIVAL_FADE_MS > LABEL_FADE_MS, 'the arrival is the slower of the two');
  assert.equal(labelFadeAlpha(0, ARRIVAL_FADE_MS), 0);
  assert.equal(labelFadeAlpha(ARRIVAL_FADE_MS, ARRIVAL_FADE_MS), 1);
  assert.equal(labelFadeAlpha(ARRIVAL_FADE_MS * 2, ARRIVAL_FADE_MS), 1, 'clamped');
  // Half way along its own length, whatever that length is.
  assert.equal(labelFadeAlpha(ARRIVAL_FADE_MS / 2, ARRIVAL_FADE_MS), labelFadeAlpha(LABEL_FADE_MS / 2));
  // At the moment the ordinary fade would be finished, the arrival is not.
  assert.ok(labelFadeAlpha(LABEL_FADE_MS, ARRIVAL_FADE_MS) < 1);
  assert.equal(labelFadeAlpha(100, 0), 1, 'a zero length cannot divide by zero');
});

test('the length a fade is given is fixed when it starts, not read again later', () => {
  const fade = new InfrastructureLabelFade(C);
  const entity = {position: {x: 0}, label: {distanceDisplayCondition: {near: 0, far: 1000}}};
  // Starts during the arrival window, so it is given the slow length.
  fade.update([entity], viewer, 0, true, 0, ARRIVAL_FADE_MS);
  assert.equal(entity.label.translucencyByDistance.nearValue, 0, 'nothing is drawn at full strength on the first pass');
  // Later frames pass the ordinary length, because the window has closed. The
  // fade already running must not be jerked onto it.
  fade.update([entity], viewer, LABEL_FADE_MS, true, 0, LABEL_FADE_MS);
  assert.ok(entity.label.translucencyByDistance.nearValue < 1, 'still on the slow curve');
  assert.equal(entity.label.translucencyByDistance.nearValue, labelFadeAlpha(LABEL_FADE_MS, ARRIVAL_FADE_MS));
  fade.update([entity], viewer, ARRIVAL_FADE_MS, true, 0, LABEL_FADE_MS);
  assert.equal(entity.label.translucencyByDistance.nearValue, 1);
});

test('the route geometry fade takes its length the same way', () => {
  const fade = new RouteGeometryFade(C);
  const key = {};
  const range = {near: 0, far: 260000};
  assert.equal(fade.alpha(key, null, range, viewer, 0, true, ARRIVAL_FADE_MS), 0);
  assert.equal(fade.alpha(key, null, range, viewer, LABEL_FADE_MS, true, LABEL_FADE_MS),
    labelFadeAlpha(LABEL_FADE_MS, ARRIVAL_FADE_MS));
  assert.equal(fade.alpha(key, null, range, viewer, ARRIVAL_FADE_MS, true, LABEL_FADE_MS), 1);
});

test('the arrival opens the slow window and keeps asking to be drawn', () => {
  // The hand-over order is checked where it happens, in entry_performance. What
  // is left here is that the window and the per-frame painter are one piece of
  // code - a frame during the arrival cannot use a different length from the
  // pass that put everything at zero - and that a still camera is asked to keep
  // drawing, since a request-render viewer would otherwise stop the fade half
  // way up and leave the network permanently half visible.
  const globe = readFileSync(new URL('../../../../digital_twin/visualization/web/globe.js', import.meta.url), 'utf8');
  assert.match(globe, /startArrivalFade\(now=performance\.now\(\)\) \{\r?\n\s*this\.arrivalFadeUntil=now\+ARRIVAL_FADE_MS;\r?\n\s*this\.lastAnnotation=-Infinity;\r?\n\s*this\.paintInfrastructureFade\(now\);/);
  assert.match(globe, /if\(now<\(this\.arrivalFadeUntil \?\? 0\)\)v\.scene\.requestRender/);
  assert.match(globe, /fadeLength\(now\) \{return now<\(this\.arrivalFadeUntil \?\? 0\)\?ARRIVAL_FADE_MS:LABEL_FADE_MS;\}/);
});
