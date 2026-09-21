import test from 'node:test';
import assert from 'node:assert/strict';
import {routeGuidance} from '../../../../user_application/web/domains/uam/cockpit/cockpit_route.js';
import {CockpitPanel} from '../../../../user_application/web/domains/uam/cockpit/cockpit_panel.js';
import {fakeDocument} from './fake_dom.mjs';
import {CockpitView} from '../../../../user_application/web/domains/uam/cockpit/cockpit_view.js';
const entity={latitude_deg:.004,longitude_deg:.001,heading_deg:0};
const mission={route_points:[{id:'a',latitude_deg:0,longitude_deg:0},{id:'b',latitude_deg:.01,longitude_deg:0},{id:'c',latitude_deg:.01,longitude_deg:.01}]};
test('north leg cross-track is signed right; active target and bearing do not replace the plan',()=>{
 const before=structuredClone(mission),cue=routeGuidance(entity,mission);
 assert.equal(cue.index,1);assert.equal(cue.target.id,'b');assert.ok(Math.abs(cue.crossTrackM-111.32)<.01);assert.equal(cue.course,0);assert.ok(cue.bearing>350);assert.deepEqual(mission,before);
 assert.ok(routeGuidance({...entity,longitude_deg:-.001},mission).crossTrackM<0);
});
test('explicit target overrides proximity; invalid coordinates and zero-length legs are safe',()=>{
 assert.equal(routeGuidance(entity,{...mission,next_waypoint:'c'}).index,2);
 assert.equal(routeGuidance({},mission),null);assert.equal(routeGuidance(entity,{route_points:[mission.route_points[0],mission.route_points[0]]}),null);
 assert.equal(routeGuidance(entity,{route_points:[mission.route_points[0],{latitude_deg:NaN,longitude_deg:0}]}),null);
});
test('dateline route takes the short crossing and keeps finite geometry',()=>{
 const cue=routeGuidance({latitude_deg:0,longitude_deg:179.99,heading_deg:90},{route_points:[{latitude_deg:0,longitude_deg:179.98},{latitude_deg:0,longitude_deg:-179.98}]});
 assert.equal(cue.course,90);assert.ok(cue.distanceM<4000);
});
test('hold and stale observations suppress heading guidance while retaining reference plan',()=>{
 const p=new CockpitPanel({document:fakeDocument});p.open();
 const state={entity:{...entity,entity_id:'x',orientation_source:'attitude'},mission,nearby:[]};
 p.update(state,0);assert.equal(p.courseBug.getAttribute('visibility'),'visible');
 p.update({...state,mission:{...mission,holding:true}},100);assert.equal(p.courseBug.getAttribute('visibility'),'hidden');assert.match(p.guidanceText.textContent,/HOLD/);assert.ok(p.route.getAttribute('points').length);
 p.update({...state,stale:true},200);assert.equal(p.courseBug.getAttribute('visibility'),'hidden');
 p.update(state,300);assert.match(p.guidanceText.textContent,/PLAN/);assert.equal(p.courseBug.getAttribute('visibility'),'visible');assert.equal(p.root.querySelector('[data-action=route-guide]'),null);assert.equal(p.screens.nav.querySelector('.cockpit-nav-controls').children.length,3);
});
test('cabin buttons cycle explicit seats and label occupant preview independently of traffic',()=>{
 const actions=[],p=new CockpitPanel({document:fakeDocument,onViewpoint:id=>actions.push(id),onOccupants:show=>actions.push(show)});
 p.setCabin({viewpoints:[{id:'seat_01',label:'승객석 1'},{id:'seat_02',label:'승객석 2'}],occupant_nodes:['person']});
 p.rearButton.click();p.seatButton.click();p.seatButton.click();p.seatButton.click();p.occupantsButton.click();p.pilotButton.click();
 assert.deepEqual(actions,['cabin','seat_01','seat_02','seat_01',true,'pilot']);assert.match(p.occupantsButton.getAttribute('title'),/실제 탑승 인원과 무관/);
});
test('unselected cabins suppress illustration draw calls without switching off an active preview',()=>{
 const nodes=[{show:true},{show:true}],models=nodes.map(n=>({ready:true,getNode:()=>n}));
 const v=Object.create(CockpitView.prototype);Object.assign(v,{model:models[0],panel:{occupantsShown:true},globe:{items:new Map(models.map((model,i)=>[i,{model,assetId:'a'}])),entityScene:{assets:new Map([['a',{cockpit:{occupant_nodes:['person']}}]])}}});
 v.prepareCabinModels(0);assert.equal(nodes[0].show,true);assert.equal(nodes[1].show,false);
 v.panel.occupantsShown=false;v.prepareCabinModels(600);assert.equal(nodes[0].show,true,'prepared models are not rewritten; explicit controls own subsequent visibility');
});
