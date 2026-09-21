import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {RouteGeometryFade} from '../../../../digital_twin/visualization/web/route_geometry_fade.js';
import {ARRIVAL_FADE_MS, LABEL_FADE_MS} from '../../../../digital_twin/visualization/web/label_fade.js';
const C={SceneMode:{SCENE2D:2},Cartesian3:{distance:(a,b)=>Math.abs(a.x-b.x)},Color:{clone:c=>({...c})}};
const color=alpha=>({red:1,green:.5,blue:0,alpha});
const viewer={clock:{currentTime:0},scene:{mode:3},camera:{positionWC:{x:100},positionCartographic:{height:100}}};
test('points, outlines and dashed route colors fade without rebuilding or cumulative alpha loss',()=>{
 const fade=new RouteGeometryFade(C),point={color:color(1),outlineColor:color(.8)},material={color:color(.6),dashLength:16};
 const layer={visible:true,owned:[{position:{x:0},point},{polyline:{positions:[{x:0}],material}}]};
 fade.update(layer,viewer,0);assert.equal(point.color.alpha,0);assert.equal(material.color.alpha,0);
 fade.update(layer,viewer,450);assert.equal(point.color.alpha,.5);assert.equal(point.outlineColor.alpha,.4);assert.equal(material.color.alpha,.3);
 fade.update(layer,viewer,900);assert.equal(point.color.alpha,1);assert.equal(material.color.alpha,.6);
 const stable=material.color;fade.update(layer,viewer,1000);assert.equal(material.color,stable);assert.equal(material.dashLength,16);
 point.color={...color(.7),green:1};fade.update(layer,viewer,1100);assert.equal(point.color.green,1);assert.equal(point.color.alpha,.7);
 layer.visible=false;fade.update(layer,viewer,1200);layer.visible=true;fade.update(layer,viewer,1300);assert.equal(point.color.alpha,0);
});
test('corridor and hub instance bytes fade, respect restyle and zoom limits',()=>{
 const fade=new RouteGeometryFade(C),attributes={color:new Uint8Array([255,128,0,100])};
 const layer={visible:true,owned:[],primitive:{ready:true,getGeometryInstanceAttributes:()=>attributes},fadeMeshes:[{id:'hub',position:{x:0}}]};
 fade.update(layer,viewer,0);fade.update(layer,viewer,450);assert.equal(attributes.color[3],50);
 fade.update(layer,viewer,900);assert.equal(attributes.color[3],100);
 attributes.color=new Uint8Array([255,255,255,150]);fade.update(layer,viewer,1000);assert.equal(attributes.color[3],150);
 const v={...viewer,camera:{positionWC:{x:240500}}};fade.update(layer,v,1100);assert.equal(attributes.color[3],75);
 v.camera.positionWC.x=260000;fade.update(layer,v,1200);assert.equal(attributes.color[3],0);
});

test('a transparent first GPU draw retains original mesh colour after readiness',()=>{
 const fade=new RouteGeometryFade(C),attributes={color:new Uint8Array([255,128,0,0])};
 const layer={visible:true,owned:[],primitive:{ready:false,getGeometryInstanceAttributes:()=>attributes},
  fadeMeshes:[{id:'late',position:{x:0},base:[255,128,0,100],applied:[255,128,0,0]}]};
 fade.update(layer,viewer,0,2200);assert.equal(attributes.color[3],0,'first GPU frame starts transparent');
 layer.primitive.ready=true;fade.update(layer,viewer,20,2200);assert.equal(attributes.color[3],0);
 fade.update(layer,viewer,1120,2200);assert.equal(attributes.color[3],50);
 fade.update(layer,viewer,2220,2200);assert.equal(attributes.color[3],100);
});

test('a second arrival fades the network back in, rather than losing its colour', () => {
  // The fade multiplies each thing's full-strength colour, read once from the
  // layer. A second arrival restarts the clock; if it also forgot the colours,
  // the reading would be taken while everything was faded out and transparent
  // would be recorded as full strength - so the network would come back at
  // nothing and stay there.
  const fade = new RouteGeometryFade(C);
  const viewer = {clock: {currentTime: 0}, scene: {mode: 3}, camera: {positionWC: {x: 0}, positionCartographic: {height: 0}}};
  const line = {show: true, polyline: {positions: [{x: 0}], material: {color: {red: 0, green: 1, blue: 1, alpha: 0.85}},
    distanceDisplayCondition: {near: 0, far: 260000}}};
  const layer = {owned: [line], visible: true};
  const alpha = () => line.polyline.material.color.alpha;

  fade.update(layer, viewer, 0);
  assert.equal(alpha(), 0, 'nothing is drawn at full strength on the first pass');
  fade.update(layer, viewer, LABEL_FADE_MS);
  assert.equal(alpha(), 0.85, 'up to the colour the layer drew it in');

  // A second arrival: hidden, clock restarted, then shown again.
  layer.visible = false;
  fade.update(layer, viewer, LABEL_FADE_MS + 1);
  assert.equal(alpha(), 0, 'held at nothing while it is away');
  fade.restart();
  layer.visible = true;
  fade.update(layer, viewer, 2000, ARRIVAL_FADE_MS);
  assert.equal(alpha(), 0, 'starts from nothing again');
  fade.update(layer, viewer, 2000 + ARRIVAL_FADE_MS, ARRIVAL_FADE_MS);
  assert.equal(alpha(), 0.85, 'and comes all the way back');
});

test('the entry restarts the fades and does not replace them', () => {
  const globe = readFileSync(new URL('../../../../digital_twin/visualization/web/globe.js', import.meta.url), 'utf8');
  const entry = globe.slice(globe.indexOf('  entry({reducedMotion'));
  const head = entry.slice(0, entry.indexOf('return ENTRY.fly'));
  assert.match(head, /this\.infrastructureLabelFade\?\.restart\(\);/);
  assert.match(head, /this\.routeGeometryFade\?\.restart\(\);/);
  assert.doesNotMatch(head, /Fade=undefined/, 'replacing one loses the colours it had read');
  assert.match(head, /this\.arrivalFadeUntil=0;/, 'the previous arrival window does not carry into this one');
});
