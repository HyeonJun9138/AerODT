import test from 'node:test';
import assert from 'node:assert/strict';
import {groundRoutes,routeMovements,flowDelay,FLOW_PERIOD_MS,groundRouteLegend,routeMotionEnabled}
  from '../../../../user_application/web/vertiport_ground_routes.js';
import {resourcesOf} from '../../../../user_application/web/vertiport_operations.js';
import {layoutView} from '../../../../user_application/web/vertiport_layout_view.js';
import {VertiportPanel} from '../../../../user_application/web/domains/uam/operations/vertiport_panel.js';
import {DeckDetail} from '../../../../user_application/web/domains/uam/operations/deck_detail.js';
import {fakeDocument as doc,FakeElement} from './fake_dom.mjs';

const record={id:'VP1',name:'Test deck',layout:{frame:{heading_deg:0},
  platform:{corners_m:[[-10,-10],[40,-10],[40,40],[-10,40]]},
  gates:[{id:'G1',center_m:[0,0],radius_m:3}],fatos:[{id:'F1',center_m:[30,30],radius_m:5}],
  edges:[{id:'E1',from:'G1',to:'J1',points_m:[[0,0],[10,0],[10,10]]},
    {id:'E2',from:'F1',to:'J1',points_m:[[30,30],[10,30],[10,10]]}]}};
const resources=resourcesOf(record);
const departure={aircraft_id:'UAM1',flight_id:'FPL1',phase:'gate_out',direction:'departure',from:'G1',to:'F1',on_ground:true};
const arrival={...departure,aircraft_id:'UAM2',flight_id:'FPL2',phase:'gate_in',direction:'arrival',from:'F1',to:'G1'};
const flights=[{id:'DEMO',callsign:'AD101',direction:'arrival',gate:'G1',fato:'F1',bookings:[{key:'taxiway:E1',start:100,end:200}]}];
const draw=(moves,over={})=>layoutView(doc,record,resources,flights,{},150,{movements:moves,...over});

test('a full taxi route traverses reversed edges and bends in departure/arrival order without mutating layout',()=>{
  const original=JSON.stringify(resources),[out]=groundRoutes(resources,[departure]),[back]=groundRoutes(resources,[arrival]);
  assert.deepEqual(out.points,[[0,0],[10,0],[10,10],[10,30],[30,30]]);
  assert.deepEqual(back.points,[...out.points].reverse());
  assert.deepEqual(out.edges,['E1','E2']);assert.deepEqual(back.edges,['E2','E1']);
  assert.equal(JSON.stringify(resources),original);
});

test('routes follow only active ground movements, clearing immediately on takeoff or completion',()=>{
  assert.equal(draw([departure,arrival]).querySelectorAll('.vp-route').length,2);
  const inactive=[{...departure,phase:'takeoff',on_ground:false},{...arrival,phase:'landing',on_ground:false},
    {...departure,phase:'charge'},{...departure,to:'G1'},null];
  assert.deepEqual(groundRoutes(resources,inactive),[]);
  assert.equal(draw([]).querySelectorAll('.vp-route').length,0,'live empty cannot fall back to examples');
  assert.equal(draw(inactive).querySelectorAll('.vp-route').length,0);
  assert.deepEqual(groundRoutes(resources,undefined),[]);
});

test('broken topology, geometry and unknown nodes never draw a direct shortcut',()=>{
  assert.equal(groundRoutes(resources,[{...departure,to:'missing'}]).length,0);
  for(const points_m of [undefined,[[10,10]],[[30,30],[NaN,10]],[[30,30],[11,10]]]){
    const broken=resources.map(r=>r.id==='E2'?{...r,points_m}:r);
    assert.equal(groundRoutes(broken,[departure]).length,0);
    assert.match(groundRouteLegend(doc,broken,[departure]).textContent,/경로 연결 없음 1대/);
  }
});

test('example paths are explicitly opt-in and use the complete arrival route only within the booking window',()=>{
  assert.deepEqual(routeMovements(null,flights,150,false),[]);
  assert.deepEqual(routeMovements([],flights,150,true),[]);
  assert.equal(routeMovements(null,flights,200,true).length,0);
  const example=routeMovements(null,flights,150,true);
  assert.equal(example[0].from,'F1');assert.equal(example[0].to,'G1');assert.equal(example[0].example,true);
  assert.equal(draw(null).querySelectorAll('.vp-route').length,1);
  assert.equal(draw(null,{states:new Map()}).querySelectorAll('.vp-route').length,0);
});

test('flow continuity depends on absolute presentation time, not poll order or simulation speed',()=>{
  const id=groundRoutes(resources,[departure])[0].id;
  const first=flowDelay(id,123456),next=flowDelay(id,123456+3000);
  assert.equal(((-next+first)+FLOW_PERIOD_MS)%FLOW_PERIOD_MS,3000%FLOW_PERIOD_MS);
  assert.equal(flowDelay(id,123456+FLOW_PERIOD_MS),first);
  assert.deepEqual(groundRoutes(resources,[arrival,departure]).map(r=>r.id),groundRoutes(resources,[departure,arrival]).map(r=>r.id));
});

test('reduced motion is the default, while an explicit light toggle persists across polling redraws',()=>{
  const reduced={...doc,defaultView:{matchMedia:()=>({matches:true})}};
  assert.equal(routeMotionEnabled(reduced),false);assert.equal(routeMotionEnabled(reduced,true),true);
  const detail=new DeckDetail({document:reduced});detail.id=record.id;detail.record=record;
  detail.deck={time_s:21600,movements:[arrival]};detail.render(new FakeElement('div'));
  assert.equal(detail.root.querySelector('.vp-layout').getAttribute('data-route-motion'),'off');
  detail.root.querySelector('.vp-route-motion').click();detail.paint();
  assert.equal(detail.root.querySelector('.vp-layout').getAttribute('data-route-motion'),'on');
  assert.equal(detail.root.querySelector('.vp-route-motion').getAttribute('aria-pressed'),'true');
  detail.root.querySelector('.vp-route-motion').click();
  assert.equal(detail.root.querySelector('.vp-layout').getAttribute('data-route-motion'),'off');
  assert.equal(detail.root.querySelectorAll('.vp-route').length,1,'turning light off still keeps the complete path');
});

test('rotated diagrams keep routes on the same saved geometry and leave resources selectable',()=>{
  const rotated={...record,layout:{...record.layout,frame:{heading_deg:90}}};
  const svg=layoutView(doc,rotated,resources,[],{},0,{demo:false,movements:[departure]});
  const line=svg.querySelector('.vp-route-bed').getAttribute('points').split(' ').map(p=>p.split(',').map(Number));
  assert.ok(Math.abs(line.at(-1)[0]+30)<1e-8);assert.ok(Math.abs(line.at(-1)[1]+30)<1e-8);
  assert.equal(svg.querySelectorAll('.vp-route-terminal').length,2);
  assert.equal(svg.querySelectorAll('.vp-resource').length,resources.length);
});

test('vertiport and PSU paint identical paths from their live movement snapshots and clear a new empty snapshot',()=>{
  const panel=new VertiportPanel({document:doc,host:new FakeElement('div'),now:()=>150});
  panel.records=[record];panel.selectedId=record.id;
  panel.live={vertiport_id:record.id,clock:'06:00:00',movements:[arrival]};
  const detail=new DeckDetail({document:doc});detail.record=record;
  detail.deck={clock:'06:00:00',time_s:21600,movements:[arrival]};
  assert.equal(panel.diagram().querySelector('.vp-route-bed').getAttribute('points'),detail.layout().querySelector('.vp-route-bed').getAttribute('points'));
  assert.match(panel.routeLegend().textContent,/UAM2F1 → G1/);
  assert.match(detail.layout().textContent,/UAM2F1 → G1/);
  panel.live.movements=[];detail.deck.movements=[];
  assert.equal(panel.diagram().querySelectorAll('.vp-route').length,0);
  assert.equal(detail.layout().querySelectorAll('.vp-route').length,0);
  assert.match(detail.layout().textContent,/현재 유도로 이동 없음/);
});

test('switching facilities restores the live source label and selected resource state with the new snapshot',async()=>{
  const second={...record,id:'VP2',name:'Second deck'};
  const panel=new VertiportPanel({document:doc,host:new FakeElement('div'),now:()=>150,
    api:{scenarioVertiport:async id=>({vertiport_id:id,clock:'06:00:00',stands:{G1:'FPL7'},movements:[departure]})}});
  panel.records=[record,second];panel.selectedId=record.id;panel.live={vertiport_id:record.id,clock:'06:00:00'};
  panel.showingLive=true;panel.drawSide=()=>{};
  let rebuilt=0;panel.console={};panel.drawConsole=()=>rebuilt++;
  panel.choose(second.id);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(panel.live.vertiport_id,second.id);assert.equal(panel.showingLive,true);
  assert.equal(rebuilt,2,'console is rebuilt after the new facility becomes live');
  panel.draft.selected='gate:G1';panel.resourceStatus=new FakeElement('span');panel.restrictionButton=new FakeElement('button');
  panel.updateResourceStatus();assert.match(panel.resourceStatus.textContent,/예정.*FPL7/);
});
