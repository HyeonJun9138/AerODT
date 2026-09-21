import test from 'node:test';
import assert from 'node:assert/strict';
import {ManualAssignmentPanel} from '../../../../user_application/web/domains/uam/cockpit/manual_assignment_panel.js';
import {ManualFlightSession} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_session.js';
import {arriveAtManualAircraft} from '../../../../user_application/web/domains/uam/cockpit/manual_assignment_arrival.js';
import {DemandPanel} from '../../../../user_application/web/domains/uam/planning/demand_panel.js';
import {fakeDocument} from './fake_dom.mjs';
const status={loaded:true,control_open:true,manual_aircraft:null};
const flush=()=>new Promise(r=>setImmediate(r));
test('manual choice changes propagate while a day console is already open',async()=>{
 let assigned=0;
 const watcher=new ManualAssignmentPanel({api:{offers:async()=>({flights:[{flight_id:'F1',seats:6,origin:'VP001'}]}),assign:async()=>({aircraft_id:'A1'})},onAssigned:()=>assigned++});
 const panel=new DemandPanel({api:{},document:fakeDocument,onManualRequest:r=>{watcher.setRequest(r);watcher.tick(status);}});
 panel.state.manual={want:false,seats:6,vertiport:'VP001'};panel.repaint=()=>{};panel.scopeRecords=()=>[];
 const nodes=panel.manualStep();const checkbox=nodes[0].children[0];
 checkbox.onchange({target:{checked:true}});await flush();
 assert.equal(assigned,1);assert.equal(watcher.request.want,true);
});
test('stale console paints during camera preparation never start a second assignment',async()=>{
 let assignments=0,finish;const ready=new Promise(r=>finish=r);
 const panel=new ManualAssignmentPanel({api:{offers:async()=>({flights:[{flight_id:'F1',aircraft_id:'A1'}]}),assign:async()=>{assignments++;return {aircraft_id:'A1'};}},onAssigned:()=>ready});
 panel.setRequest({want:true});panel.tick(status,0);await flush();
 for(let i=1;i<5;i++)panel.tick(status,i*6000);
 assert.equal(panel.assignment.aircraft_id,'A1');assert.equal(assignments,1);assert.equal(panel.busy,true);
 finish();await flush();panel.tick(status,30000);await flush();assert.equal(assignments,1);
 panel.tick({...status,manual_aircraft:'A1'},31000);panel.tick(status,32000);assert.equal(panel.assignment,null);
 await flush();
});
test('no camera journey is flown on the way into a cockpit',async()=>{
 // There used to be a glide from the manual socket's own pose, because the
 // fleet snapshot lagged and the camera had somewhere to be. The cockpit takes
 // the camera over outright, so the journey was only ever something to sit
 // through -- and the model could not start loading until it had landed. The
 // framing is still set up and then landed in one step, because that is the
 // view handed back on leaving the cockpit; nothing is flown.
 let t=0,zooms=0,focus=0,finished=0,entered=0;
 const globe={sceneMode:'3d',items:new Map(),stopTracking(){},
  async flyToFlightSmoothly(){zooms++;},
  select(id){this.selected=id;},focus(){focus++;this.approaching=true;this.approach={};},
  finishApproach(){finished++;this.approaching=false;this.approach=null;return true;},
  cockpit:{usable:()=>true,enter(){entered++;return true;}}};
 await arriveAtManualAircraft({aircraftId:'A1',getGlobe:()=>globe,now:()=>t,
  wait:async ms=>{t+=ms;if(t>=400)globe.items.set('scenario:A1',{});}});
 assert.equal(zooms,0,'글라이드는 없다');
 assert.equal(focus,1);assert.equal(finished,1,'틀만 잡고 한 프레임에 끝낸다');
 assert.equal(entered,1);
 assert.equal(globe.approaching,false,'접근 애니메이션이 남아 있지 않다');
});
test('manual start waits for cockpit preparation rather than only socket handshake',async()=>{
 const oldWS=globalThis.WebSocket,oldLoc=globalThis.location;let socket,finish,resolved=false;
 globalThis.location={href:'http://localhost/',protocol:'http:'};globalThis.WebSocket=class {static OPEN=1;constructor(){socket=this;this.readyState=1;}send(){}close(){}};
 const session=Object.create(ManualFlightSession.prototype),input={setThrottle(){},setMode(){}};
 Object.assign(session,{generation:0,stop(){this.generation++;},contactDecks:async()=>[],panel:{input,open(){},setStatus(){}},display:{reset(){}},onSample(){},onTelemetry(){},onReady:()=>new Promise(r=>finish=r),loop(){},resume(){this.resumed=true;},pollPsu(){},sendControls(){},notify(){}});
 try{
 const started=session.start({plan:{legs:[{path:[[127,37,100]]}]},aircraft_id:'A1'}).then(()=>resolved=true);
 await flush();socket.onmessage({data:JSON.stringify({type:'ready',sample:{},run_id:'R1'})});await flush();assert.equal(resolved,false);assert.equal(session.resumed,undefined);
 finish();await started;assert.equal(session.resumed,true);
 }finally{clearInterval(session.transport);clearInterval(session.psuTimer);globalThis.WebSocket=oldWS;globalThis.location=oldLoc;}
});
