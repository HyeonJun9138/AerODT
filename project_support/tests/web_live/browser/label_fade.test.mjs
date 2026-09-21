import test from 'node:test';
import assert from 'node:assert/strict';
import {labelFadeAlpha} from '../../../../digital_twin/visualization/web/label_fade.js';
import {PlaceLabels} from '../../../../digital_twin/visualization/web/place_labels.js';
import {EntityScene} from '../../../../digital_twin/visualization/web/entity_scene.js';

test('label fade is clamped and smoothly increases over 900 ms',()=>{
  assert.equal(labelFadeAlpha(-1),0);assert.equal(labelFadeAlpha(0),0);
  assert.equal(labelFadeAlpha(450),.5);assert.equal(labelFadeAlpha(900),1);
  assert.equal(labelFadeAlpha(2000),1);
  let last=0;for(let t=0;t<=900;t+=10){const a=labelFadeAlpha(t);assert.ok(a>=last);last=a;}
});
test('place labels warm tiles and fade after intro without restarting on repeated enable',async()=>{
  const layer={show:true};
  const p=new PlaceLabels({load:async()=>({}),attach:()=>layer,suspended:true});
  await p.setEnabled(true);assert.equal(layer.show,false);assert.equal(layer.alpha,0);
  p.setSuspended(false);assert.equal(layer.alpha,.001);
  p.update(0);p.update(450);assert.equal(layer.alpha,.5);
  await p.setEnabled(true);p.update(900);assert.equal(layer.alpha,1);assert.equal(p.update(1000),false);
  await p.setEnabled(false);assert.equal(layer.show,false);
  await p.setEnabled(true);assert.equal(layer.alpha,.001);
  p.destroy();assert.equal(p.update(2000),false);
});
test('late imagery waits for readiness but has a bounded wait',async()=>{
  let ready=false;const layer={};const p=new PlaceLabels({load:async()=>({}),attach:()=>layer,isReady:()=>ready});
  await p.setEnabled(true);p.update(0);p.update(2000);assert.equal(layer.alpha,.001);
  ready=true;p.update(2100);p.update(2550);assert.equal(layer.alpha,.5);
  p.setSuspended(true);p.setSuspended(false);ready=false;
  p.update(3000);p.update(5500);p.update(5950);assert.equal(layer.alpha,.5);
});
test('entity text and background fade together, finish, restart and clean removed labels',()=>{
  const scene=Object.create(EntityScene.prototype);
  scene.C={Color:{WHITE:{withAlpha:alpha=>({alpha})},BLACK:{withAlpha:alpha=>({alpha})}}};
  const a={entity:{entity_id:'a'},label:{},labelSmall:true};
  scene.items=new Map([['a',a]]);scene.fadingLabels=new Set();
  scene.fadeLabelsIn(0);assert.equal(a.label.fillColor.alpha,0);
  scene.updateLabelFades(450);assert.equal(a.label.fillColor.alpha,.5);assert.equal(a.label.backgroundColor.alpha,.275);
  scene.updateLabelFades(900);assert.equal(a.label.fillColor.alpha,1);assert.equal(scene.fadingLabels.size,0);
  scene.fadeLabelsIn(1000);assert.equal(a.label.fillColor.alpha,0);
  scene.items.delete('a');scene.updateLabelFades(1200);assert.equal(scene.fadingLabels.size,0);
});

test('arrival dots and glyphs share the slow curve, including late item visibility',()=>{
 const scene=Object.create(EntityScene.prototype);
 scene.C={NearFarScalar:class {constructor(n,nearValue,f,farValue){Object.assign(this,{nearValue,farValue});}},
  Color:{WHITE:{withAlpha:alpha=>({alpha})},BLACK:{withAlpha:alpha=>({alpha})}}};
 const a={entity:{entity_id:'a'},point:{},billboard:{},label:{}};
 scene.items=new Map([['a',a]]);scene.fadingLabels=new Set();
 scene.fadeLabelsIn(0,2200);assert.equal(a.point.translucencyByDistance.nearValue,0);
 scene.updateLabelFades(1100);assert.equal(a.point.translucencyByDistance.nearValue,.5);
 assert.equal(a.billboard.translucencyByDistance.nearValue,.5);assert.equal(a.label.fillColor.alpha,.5);
 const late={point:{}};scene.items.set('late',late);scene.fadePoint(late);
 assert.equal(late.point.translucencyByDistance.nearValue,.5);
 scene.updateLabelFades(2200);assert.equal(a.point.translucencyByDistance.nearValue,1);
 assert.equal(late.point.translucencyByDistance.nearValue,1);
});

test('geographic names require stable tiles, then keep fading even if tiles refine',async()=>{
 let ready=true;const layer={};
 const p=new PlaceLabels({suspended:true,stableMs:250,load:async()=>({}),attach:()=>layer,isReady:()=>ready});
 await p.setEnabled(true);p.setSuspended(false,2200);
 p.update(0);ready=false;p.update(100);ready=true;p.update(200);p.update(400);
 assert.equal(layer.alpha,.001,'a transient ready frame cannot start the reveal');
 p.update(450);p.update(1550);assert.equal(layer.alpha,.5);
 ready=false;p.update(2100);assert.ok(layer.alpha>.5,'later tile refinement never restarts the fade');
 p.update(2650);assert.equal(layer.alpha,1);
});
