import test from 'node:test';
import assert from 'node:assert/strict';
import {CockpitView} from '../../../../user_application/web/domains/uam/cockpit/cockpit_view.js';
import {CockpitPanel} from '../../../../user_application/web/domains/uam/cockpit/cockpit_panel.js';
import {CockpitConsole} from '../../../../user_application/web/domains/uam/cockpit/cockpit_console.js';
import {EntityScene} from '../../../../digital_twin/visualization/web/entity_scene.js';
import {fakeDocument} from './fake_dom.mjs';
const sample=Object.freeze({manual:true,time_s:12,position:{longitude:127,latitude:37,altitude_m:100},heading_deg:135,pitch_deg:8,roll_deg:-12,airborne:true,control_surface_deg:[0,0,0,0],manual_surface_display_deg:[-10,10,3,2],speed_mps:25});
function view(id='scenario:A1'){
 const v=Object.create(CockpitView.prototype);v.camera={active:true,entityId:id};v.readControls=()=>({entity_id:'scenario:A1',enabled:true,active:true,source:'keyboard'});v.readManual=()=>({sample,plan:{legs:[]}});return v;
}
test('assigned cockpit enables the same controls; unrelated aircraft never receives the lease',()=>{
 const v=view();assert.equal(v.manualControls().enabled,true);assert.equal(v.manualFrame().sample,sample);
 v.camera.entityId='scenario:A2';assert.equal(v.manualControls(),null);assert.equal(v.manualFrame(),null);
 v.camera.active=false;assert.equal(v.manualControls().entity_id,'scenario:A1','external view keeps assigned controls');
 v.camera.active=true;v.single=true;assert.equal(v.manualControls(),null,'fleet lease cannot drive a single preview');
 v.readControls=()=>({entity_id:'preview:selected-flight',enabled:true});assert.equal(v.manualControls().enabled,true);
});
test('manual cockpit cannot toggle the fleet playback even through direct action dispatch',()=>{
 const v=view();let count=0;v.playbackSources=()=>({button:{click(){count++;}},rate:{click(){count++;}}});
 v.playbackAction('toggle');v.playbackAction('rate');assert.equal(count,0);
 v.readControls=()=>null;v.playbackAction('toggle');assert.equal(count,1);
});
test('standalone and fleet instruments share the same pose, plan and route',()=>{
 const v=view(),states=[];v.globe={};v.panel={update:s=>states.push(s)};
 const plan={arrival:{name:'Gangnam'},legs:[{path:[[127,37,100],[128,38,120]]}]};
 v.paintManual(sample,plan,20,'scenario:A1');v.paintManual(sample,plan,20,'preview:selected-flight');
 const [a,b]=states;assert.equal(a.mission.timing.now_s,null,'fleet native elapsed time cannot masquerade as the PSU clock');assert.equal(b.mission.timing.now_s,12);assert.equal(b.mission.timing.elapsed_clock,true);delete a.mission.timing;delete b.mission.timing;delete a.entity.entity_id;delete b.entity.entity_id;assert.deepEqual(a,b);assert.equal(a.entity.roll_deg,-12);assert.equal(a.mission.route_points.length,2);
});
test('pilot presentation bypasses fleet lag only for its own aircraft and restores buffer on release',()=>{
 const scene=Object.create(EntityScene.prototype);let buffered=0,lifted=0;
 scene.C={Cartesian3:{fromDegrees:(x,y,z,e,out)=>Object.assign(out,{x,y,z}),fromArray:(a,i,out)=>Object.assign(out,{x:a[0],y:a[1],z:a[2]})},Ellipsoid:{WGS84:{}},HeadingPitchRoll:class{},Transforms:{headingPitchRollToFixedFrame:(p,h)=>({p:{...p},h:{...h}})}};
 scene.samples={position:(id,now,out)=>{buffered++;out.splice(0,3,1,2,3);},renderTime:()=>0,headingAt:()=>0};scene.array=[];scene.surfaceLift=()=>lifted++;
 const own={entity:{entity_id:'scenario:A1',orientation_source:'ground_track'},position:{}},other={entity:{entity_id:'scenario:A2'},position:{}};
 scene.setManualSample('scenario:A1',sample);scene.refreshPosition(own,1);scene.refreshPosition(other,1);
 assert.deepEqual(own.position,{x:127,y:37,z:100});assert.deepEqual(other.position,{x:1,y:2,z:3});assert.equal(buffered,1);assert.equal(lifted,1);
 const m=scene.matrix(own);assert.equal(m.h.pitch,8*Math.PI/180);assert.equal(m.h.roll,-12*Math.PI/180);
 let shown;own.model={ready:true};own.controlSurfaceSpec={nodes:[{}]};own.controlSurfaces={update:s=>shown=s};scene.updateControlSurfaces(own);assert.equal(shown,sample);assert.equal(sample.airborne,true);
 scene.setManualSample(null,null);scene.refreshPosition(own,2);assert.deepEqual(own.position,{x:1,y:2,z:3});assert.equal(scene.manualSample(other),null);
});
test('manual dock labels owner, hides playback, and shows the same input settings outside cockpit',()=>{
 const panel=new CockpitPanel({document:fakeDocument}),dock=new CockpitConsole({document:fakeDocument});
 panel.setPlayback({enabled:true});panel.setManualMode(true);dock.updateControls({entity_id:'scenario:A7',enabled:true,active:true,source:'keyboard',mode:'multirotor'});
 assert.equal(panel.dockTitle.textContent,'수동 조종');assert.equal(panel.playbackGroup.hidden,true);assert.equal(dock.controlOwner.textContent,'배정 기체 · A7');assert.equal(dock.controlsRoot.hidden,false);
 assert.match(dock.inputGuide.textContent,/W·S/);panel.close();assert.equal(panel.toolbar.hidden,false);
 panel.setPlayback({enabled:true,manualFleet:true,canToggle:true,canRate:false,time:'06:30:00'});
 assert.equal(panel.playbackGroup.hidden,false);assert.match(panel.playbackToggle.textContent,/시뮬레이션 재생/);
 panel.setManualMode(true);assert.equal(panel.playbackGroup.hidden,false);
 dock.updateControls({entity_id:'scenario:A7',active:false});assert.equal(dock.pause.textContent,'입력 재개');assert.equal(dock.source.disabled,true);
 panel.setManualMode(false);assert.equal(panel.toolbar.hidden,true);assert.equal(panel.dockTitle.textContent,'재생 설정');
});
