import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveGlobe} from '../../../../digital_twin/visualization/web/globe.js';
import {setSunLighting} from '../../../../digital_twin/visualization/web/globe_style.js';
const labels = await import('../../../../digital_twin/visualization/web/place_labels.js').catch(() => ({}));

test('opening-flight suppression survives late loading and preserves the user toggle',async()=>{
  let resolve;const layer={show:true};let loads=0;
  const places=new labels.PlaceLabels({suspended:true,load:()=>{loads++;return new Promise(r=>resolve=r);},attach:()=>layer});
  const pending=places.setEnabled(true);resolve({});await pending;
  assert.equal(layer.show,false,'loaded labels stay hidden throughout the intro');
  places.setSuspended(false);assert.equal(layer.show,true);
  places.setSuspended(true);assert.equal(layer.show,false);
  await places.setEnabled(false);places.setSuspended(false);
  assert.equal(layer.show,false,'finishing the intro must not override names switched off');
  await places.setEnabled(true);assert.equal(layer.show,true);assert.equal(loads,1);
});

test('provider arriving after the intro is immediately visible if still enabled',async()=>{
  let resolve;const layer={show:false};
  const places=new labels.PlaceLabels({suspended:true,load:()=>new Promise(r=>resolve=r),attach:()=>layer});
  const pending=places.setEnabled(true);places.setSuspended(false);resolve({});await pending;
  assert.equal(layer.show,true);
});

test('place labels load once and honor a toggle while the provider is pending', async () => {
  assert.equal(typeof labels.PlaceLabels, 'function');
  let resolve, loads=0; const layer={show:true};
  const places=new labels.PlaceLabels({load:()=>{loads++;return new Promise(r=>resolve=r);},attach:()=>layer});
  const pending=places.setEnabled(true);places.setEnabled(false);resolve({});await pending;
  assert.equal(layer.show,false);await places.setEnabled(true);
  assert.equal(layer.show,true);assert.equal(loads,1);
});

test('failed labels can be retried and destroyed labels cannot attach late', async () => {
  assert.equal(typeof labels.PlaceLabels, 'function');
  let loads=0,resolve,attached=0;const statuses=[];
  const places=new labels.PlaceLabels({load:()=>{if(++loads===1)throw Error('offline');return new Promise(r=>resolve=r);},attach:()=>{attached++;return {};},onStatus:s=>statuses.push(s)});
  await places.setEnabled(true);assert.equal(statuses.at(-1),'error');
  const pending=places.setEnabled(true);places.destroy();resolve({});await pending;
  assert.equal(attached,0);
});

test('sunlight changes base imagery but preserves label overlay contrast',()=>{
  const base={},overlay={aerodtRole:'place_labels',brightness:1,contrast:1,gamma:1};
  const scene={globe:{imageryLayers:{length:2,get:i=>[base,overlay][i]}}};
  setSunLighting(scene,false);assert.equal(base.brightness,.9);assert.equal(overlay.brightness,1);
});

test('late tile failures keep hidden labels off and next activation replaces the failed layer',async()=>{
  let loads=0,detached=0;const callbacks=[],statuses=[];
  const places=new labels.PlaceLabels({load:async()=>{loads++;return {errorEvent:{addEventListener(fn){callbacks.push(fn);return ()=>{};}}};},attach:()=>({}),detach:()=>{detached++;},onStatus:s=>statuses.push(s)});
  await places.setEnabled(true);await places.setEnabled(false);assert.equal(callbacks.length,1);callbacks[0]();
  assert.equal(statuses.at(-1),'off');await places.setEnabled(true);
  assert.equal(loads,2);assert.equal(detached,1);
  callbacks[0]();assert.equal(statuses.at(-1),'ready');
  callbacks[1]();assert.equal(statuses.at(-1),'partial');
  places.destroy();callbacks[1]();assert.equal(statuses.filter(s=>s==='partial').length,1);
});

test('home resets tracking and returns both initial and animated camera to Seoul',()=>{
  let stopped=0,cancelled=0;const views=[];
  const globe=Object.create(LiveGlobe.prototype);
  Object.assign(globe,{motion:{cancel(){cancelled++;}},stopTracking(){stopped++;},C:{Cartesian3:{fromDegrees:(...args)=>args}},viewer:{camera:{setView:v=>views.push(v),flyTo:v=>views.push(v)}}});
  globe.reset(true);globe.reset();assert.equal(stopped,2);assert.equal(cancelled,2);
  for(const v of views){assert.equal(v.destination[0],126.978);assert.equal(v.destination[1],37.5665);assert.equal(v.destination[2],120000);}
});
