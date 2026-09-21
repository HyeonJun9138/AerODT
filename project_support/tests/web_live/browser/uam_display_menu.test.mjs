import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeElement,fakeDocument} from './fake_dom.mjs';
import {UamDisplayMenu,readUamDisplay} from '../../../../user_application/web/domains/uam/planning/uam_display_menu.js';
import {LiveGlobe} from '../../../../digital_twin/visualization/web/globe.js';
import {FlightLayer} from '../../../../digital_twin/visualization/web/flight_layer.js';
import {RouteLayer} from '../../../../digital_twin/visualization/web/route_layer.js';
import {VertiportLayer} from '../../../../digital_twin/visualization/web/vertiport_layer.js';
import {EntityScene} from '../../../../digital_twin/visualization/web/entity_scene.js';

test('operational status has its own persistent switch, including old saved settings',()=>{
  let saved=JSON.stringify({labels:false});const changes=[];
  const document={...fakeDocument,addEventListener(){},removeEventListener(){}};
  const menu=new UamDisplayMenu({button:new FakeElement('button'),mount:new FakeElement('div'),document,
    storage:{getItem:()=>saved,setItem:(_k,v)=>saved=v},onChange:s=>changes.push(s)});
  assert.ok(menu.rows.has('status'));assert.equal(menu.state.status,true);assert.equal(menu.state.labels,false);
  menu.rows.get('status').click();assert.equal(changes.at(-1).status,false);assert.equal(menu.state.labels,false);
  menu.master.click();menu.master.click();assert.equal(menu.state.status,false);
  assert.equal(readUamDisplay({getItem:()=>saved}).status,false);menu.destroy();
});

test('UAM menu reaches streamed fleet aircraft as well as single-flight replay',()=>{
  const calls=[];const noop=()=>{};
  const globe={entityScene:{setLayerVisible:(...x)=>calls.push(['visible',...x]),setDisplayOptions:(...x)=>calls.push(['options',...x])},
    vertiportLayer:{setVisible:noop,setLabelsVisible:noop,setLightsEnabled:noop},routeLayer:{setVisible:noop,setLabelsVisible:noop},
    flightLayer:{setDisplayOptions:s=>calls.push(['replay',s])},viewer:{scene:{requestRender:noop}}};
  LiveGlobe.prototype.setUamDisplay.call(globe,{labels:false,status:true});
  assert.ok(calls.some(x=>x[0]==='options'&&x[1]==='uam'&&x[2].labels===false&&x[2].status===true));
  assert.ok(calls.some(x=>x[0]==='replay'&&x[1].status===true));
  LiveGlobe.prototype.setUamDisplay.call(globe,{all:false});
  assert.deepEqual(calls.filter(x=>x[0]==='visible').at(-1),['visible','uam',false]);
});

test('chip opens without hiding, individual choices survive master off/on and storage failure',()=>{
  const events={},changes=[];let saved;
  const document={...fakeDocument,addEventListener:(k,f)=>events[k]=f,removeEventListener:k=>delete events[k]};
  const button=new FakeElement('button');button.focus=()=>button.focused=true;
  const menu=new UamDisplayMenu({button,mount:new FakeElement('div'),document,
    storage:{getItem:()=>null,setItem:(k,v)=>saved=v},onChange:s=>changes.push(s)});
  button.click();assert.equal(menu.isOpen,true);assert.equal(changes.length,0);
  menu.rows.get('routes').click();assert.equal(changes.at(-1).routes,false);
  menu.master.click();assert.equal(menu.state.all,false);assert.equal(menu.rows.get('routes').disabled,true);
  menu.master.click();assert.equal(menu.state.all,true);assert.equal(menu.state.routes,false);
  assert.equal(readUamDisplay({getItem:()=>saved}).routes,false);
  events.keydown({key:'Escape',stopPropagation(){}});assert.equal(menu.isOpen,false);assert.equal(button.focused,true);
  assert.equal(readUamDisplay({getItem(){throw Error();}}).all,true);
  menu.destroy();assert.equal(Object.keys(events).length,0);
});

test('aircraft and satellite menus retain separate choices and counts without toggling on open',()=>{
  const stored=new Map(),changes=[],menus=[];
  const document={...fakeDocument,addEventListener(){},removeEventListener(){}};
  const storage={getItem:k=>stored.get(k),setItem:(k,v)=>stored.set(k,v)};
  for(const id of ['aircraft','satellite'])menus.push(new UamDisplayMenu({id,title:id,document,storage,
    button:new FakeElement('button'),mount:new FakeElement('div'),defaults:{all:true,labels:true,models:true},
    items:[['labels','이름표'],['models','3D 모델']],onChange:s=>changes.push(s),
    onOpen:current=>menus.forEach(m=>{if(m!==current)m.open(false);})}));
  menus[0].button.click();assert.equal(changes.length,0);assert.equal(menus[0].state.all,true);
  menus[0].setCount('수신 항공기 12대');assert.equal(menus[0].count.textContent,'수신 항공기 12대');
  menus[0].rows.get('labels').click();menus[0].master.click();menus[0].master.click();
  assert.equal(menus[0].state.labels,false);assert.equal(menus[1].state.labels,true);
  menus[1].button.click();assert.equal(menus[0].isOpen,false);assert.equal(menus[1].isOpen,true);
  assert.equal(readUamDisplay(storage,{all:true,labels:true,models:true},'aerodt.aircraft-display.v1').labels,false);
  assert.equal(readUamDisplay(storage,{all:true,labels:true,models:true},'aerodt.satellite-display.v1').labels,true);
  menus[0].set('__proto__',false);assert.equal(Object.hasOwn(menus[0].state,'__proto__'),false);
});

test('entity display switches preserve point fallback and survive master toggles',()=>{
  const scene=Object.create(EntityScene.prototype),item={entity:{kind:'aircraft'},lod:'model',point:{},model:{},pixels:8};
  const layer={visible:true,points:{},labels:{},models:{}};
  Object.assign(scene,{layers:{aircraft:layer},items:new Map([['a',item]]),frameItems:[item],
    C:{Color:{WHITE:{}}},billboardFor:()=>null,releaseModel:i=>{i.model=null;},releaseBillboard(){}});
  scene.setDisplayOptions('aircraft',{labels:false,models:false});
  assert.equal(layer.labels.show,false);assert.equal(layer.models.show,false);
  assert.equal(item.model,null,'explicit 3D disable releases GPU resources and preserves the marker');
  assert.equal(item.point.show,true);assert.equal(item.lod,'billboard');
  scene.setLayerVisible('aircraft',false);scene.setLayerVisible('aircraft',true);
  assert.equal(layer.labels.show,false);assert.equal(layer.models.show,false);
  scene.setDisplayOptions('aircraft',{labels:true,models:true});
  assert.equal(layer.labels.show,true);assert.equal(layer.models.show,true);assert.equal(scene.needsLod,true);
});

test('master and category gates remain independent, with no route rebuild',()=>{
  const calls={};const target={setVisible:v=>calls.ports=v,setLabelsVisible:v=>calls.portLabels=v,setLightsEnabled:v=>calls.lights=v};
  const globe={vertiportLayer:target,routeLayer:{setVisible:v=>calls.routes=v,setLabelsVisible:v=>calls.routeLabels=v},
    flightLayer:{setDisplayOptions:v=>calls.flight=v},viewer:{scene:{requestRender(){}}}};
  LiveGlobe.prototype.setUamDisplay.call(globe,{routes:false,labels:false,passengers:false});
  assert.equal(calls.ports,true);assert.equal(calls.routes,false);assert.equal(calls.flight.aircraft,true);
  LiveGlobe.prototype.setUamDisplay.call(globe,{all:false});assert.equal(calls.ports,false);
  LiveGlobe.prototype.setUamDisplay.call(globe,{all:true});assert.equal(calls.routes,false);assert.equal(calls.portLabels,true);
});

test('labels stay hidden after async route/port creation and master cycling',()=>{
  const route=Object.create(RouteLayer.prototype);Object.assign(route,{owned:[],entities:{add:x=>x},visible:true});
  route.setLabelsVisible(false);const a=route.add({label:{},point:{}});assert.equal(a.label.show,false);assert.equal(a.show,true);
  route.setVisible(false);route.setVisible(true);assert.equal(a.label.show,false);
  const port=Object.create(VertiportLayer.prototype);Object.assign(port,{owned:new Map(),entities:{add:x=>x},visible:true});
  port.setLabelsVisible(false);port.add('VP',[{label:{},point:{}}]);assert.equal(port.owned.get('VP')[0].label.show,false);
});

test('planned aircraft, path and passengers toggle independently and restore',()=>{
  let passengers;const marker={label:{}},path={polyline:{}};
  const layer=Object.create(FlightLayer.prototype);Object.assign(layer,{owned:[marker,path],model:{},vehicle:{marker},sample:{time_s:7},passengers:{update:(t,v)=>passengers=v}});
  layer.setDisplayOptions({all:true,aircraft:false,paths:true,passengers:true,labels:false});
  assert.equal(marker.show,false);assert.equal(path.show,true);assert.equal(layer.model.show,false);assert.equal(passengers,true);
  layer.setDisplayOptions({all:false});assert.equal(path.show,false);assert.equal(passengers,false);
  layer.setDisplayOptions({all:true});assert.equal(marker.show,false);assert.equal(path.show,true);assert.equal(marker.label.show,false);
});

test('UAM, vertiport and route labels are independent and legacy choices migrate',()=>{
 const old=readUamDisplay({getItem:()=>JSON.stringify({labels:false})});
 assert.equal(old.labels,false);assert.equal(old.portLabels,false);assert.equal(old.routeLabels,false);
 const calls={};
 const globe={vertiportLayer:{setVisible(){},setLightsEnabled(){},setLabelsVisible:v=>calls.port=v},
 routeLayer:{setVisible(){},setLabelsVisible:v=>calls.route=v},
 flightLayer:{setDisplayOptions:v=>calls.flight=v.labels},
 entityScene:{setDisplayOptions:(_k,v)=>calls.uam=v.labels,setLayerVisible(){}},
 viewer:{scene:{requestRender(){}}}};
 LiveGlobe.prototype.setUamDisplay.call(globe,{labels:false,portLabels:true,routeLabels:false});
 assert.deepEqual(calls,{port:true,route:false,flight:false,uam:false});
 LiveGlobe.prototype.setUamDisplay.call(globe,{labels:true});
 assert.deepEqual(calls,{port:true,route:false,flight:true,uam:true});
 LiveGlobe.prototype.setUamDisplay.call(globe,{all:false});
 LiveGlobe.prototype.setUamDisplay.call(globe,{all:true});
 assert.deepEqual(calls,{port:true,route:false,flight:true,uam:true});
 const saved=readUamDisplay({getItem:()=>JSON.stringify({labels:true,portLabels:false,routeLabels:true})});
 assert.equal(saved.portLabels,false);assert.equal(saved.routeLabels,true);
});
