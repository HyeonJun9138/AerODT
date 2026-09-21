import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeElement,fakeDocument} from './fake_dom.mjs';
import {PilotPanel} from '../../../../user_application/web/domains/uam/operations/pilot_panel.js';
import {VertiportPanel} from '../../../../user_application/web/domains/uam/operations/vertiport_panel.js';
import {PsuPanel} from '../../../../user_application/web/domains/uam/operations/psu_panel.js';
import {StakeholderPanel} from '../../../../user_application/web/domains/uam/operations/stakeholder_panel.js';

const documentOf=()=>({...fakeDocument,body:new FakeElement('body')});
const profile={values:{cruise_kt:100},fields:[{name:'cruise_kt',label:'순항 속도',unit:'kt',min:20,max:200,step:1}],phases:[]};
const flight=id=>({aircraft_id:id,flight_id:`F-${id}`,phase:'descent',origin:'V1',destination:'V2',altitude_m:250,speed_mps:30,
 clearance:{sequence:2},instruction:{clearance:'approach',reason:'분리 유지',traffic_id:'C',cpa_s:20,miss_m:100}});
const settle=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
test('pilot has a top launch and compact summary; detailed controls only exist in the console',async()=>{
 const document=documentOf(),body=new FakeElement('div');let requests=0;
 const panel=new PilotPanel({document,api:{read:async()=>profile,operations:async()=>{requests++;return {clock:'07:00:00',state:'playing',aircraft:[flight('A'),flight('B')]};}}});
 await panel.render(body);await settle();
 assert.equal(body.children[0].children[0].className,'stakeholder-launch');
 assert.equal(body.querySelector('#pilot-fields'),null);assert.equal(body.querySelector('.po-traffic'),null);
 assert.match(body.textContent,/250/);assert.match(body.textContent,/접근 시작/);
 const selector=body.querySelector('select');selector.value='B';selector.onchange();
 const before=requests;panel.open();await settle();assert.equal(requests,before,'opening detail must reuse the same poll');
 assert.ok(panel.console.querySelector('#pilot-fields'));assert.ok(panel.console.querySelector('.po-traffic'));
 assert.equal(panel.console.querySelector('.po-selector').querySelector('select').value,'B');
 panel.set('cruise_kt','125');panel.fold();assert.equal(panel.consoleBody.hidden,true);assert.equal(panel.consoleBody.inert,true);
 panel.close();assert.equal(document.body.getAttribute('data-pilot-console'),null);
 panel.open();assert.equal(panel.console.querySelector('#pilot-cruise_kt').value,'125');
 panel.deactivate();assert.ok(panel.operations.timer,'open console keeps one live subscription');
 panel.close();assert.equal(panel.operations.timer,null);panel.destroy();
});

test('pilot drafts survive role remount and the console receives a late profile without reopening',async()=>{
 let resolve;const document=documentOf(),body=new FakeElement('div');
 const panel=new PilotPanel({document,api:{read:()=>new Promise(r=>resolve=r)}});
 panel.render(body);panel.open();panel.deactivate();resolve(profile);await panel.ready;
 assert.ok(panel.console.querySelector('#pilot-fields'));panel.set('cruise_kt','135');
 panel.close();await panel.render(new FakeElement('div'));
 panel.open();assert.equal(panel.console.querySelector('#pilot-cruise_kt').value,'135');panel.destroy();
});

const record={id:'V1',name:'여의도',layout:{frame:{latitude:37.5,longitude:127},platform:{corners_m:[[-30,-30],[30,-30],[30,30],[-30,30]]},
 fatos:[{id:'F1',role:'both',center_m:[0,20],radius_m:9}],gates:[{id:'G1',center_m:[0,-10],radius_m:5}],chargers:[],edges:[]}};
test('vertiport launch is first even when empty; board, layout and practice move to detail',async()=>{
 const document=documentOf(),body=new FakeElement('div');let rows=[];
 const panel=new VertiportPanel({document,api:{list:async()=>({vertiports:rows})}});
 panel.render(body);await panel.ready;
 assert.equal(body.children[0].children[0].className,'stakeholder-launch');assert.equal(body.children[0].children[0].disabled,true);
 rows=[record];await panel.refresh();assert.equal(body.children[0].children[0].disabled,false);
 assert.equal(body.querySelector('.vp-board'),null);assert.equal(body.querySelector('svg'),null);
 panel.open();assert.ok(panel.console.querySelector('.vp-board'));assert.ok(panel.console.querySelector('svg'));
 assert.ok(panel.console.querySelector('.stakeholder-console-header'));assert.ok(panel.expandButton);
 panel.fold();assert.equal(panel.consoleBody.inert,true);panel.destroy();
});

test('PSU uses the same launch class and header contract',()=>{
 const document=documentOf(),session={subscribe:()=>()=>{},data:{requests:[],facilities:{},history:[]},online:false};
 const panel=new PsuPanel({document,session}),body=new FakeElement('div');panel.render(body);
 assert.equal(body.children[0].children[0].className,'stakeholder-launch');
 panel.open();assert.ok(panel.console.querySelector('.stakeholder-console-header'));panel.destroy();
});

test('leaving the sidebar detaches every summary, without closing the independent control panels',()=>{
 const calls=[];
 const role=name=>({deactivate:()=>calls.push(name),close:()=>calls.push(`close ${name}`)});
 const panel=new StakeholderPanel({document:documentOf(),pilotPanel:role('pilot'),vertiportPanel:role('vertiport'),psuPanel:role('psu')});
 panel.deactivate();assert.deepEqual(calls.sort(),['pilot','psu','vertiport']);
});
