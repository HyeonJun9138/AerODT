import test from 'node:test';import assert from 'node:assert/strict';
import {PlanPanel} from '../../../../user_application/web/domains/uam/planning/plan_panel.js';
import {FakeElement,fakeDocument} from './fake_dom.mjs';
test('manual execute bypasses recorded flight generation and passes resolved plan to the session',async()=>{
 const calls=[];const document={...fakeDocument,body:new FakeElement('body')};
 const panel=new PlanPanel({document,controlHost:document.body,api:{fly:()=>assert.fail('must not generate autopilot run')},onPlan:p=>calls.push(['plan',p]),onManual:async args=>{calls.push(['manual',args]);return {run_id:'manual-test'};}});
 panel.controlMode='manual';panel.prepared={plan_id:'saved',plan:{legs:[{path:[[127,37,80,'msl']]}],decks:[]}};
 panel.values=()=>({control_mode:'manual'});panel.preparedValues=JSON.stringify(panel.values());panel.error=new FakeElement('p');panel.showPreparation=()=>{};
 await panel.build();assert.equal(panel.error.textContent,'');assert.equal(calls[1][0],'manual');assert.equal(calls[1][1].plan_id,'saved');assert.equal(panel.run.run_id,'manual-test');assert.equal(panel.recorded,null);assert.equal(panel.building,false);
});

test('manual follow uses current snapshots without a recorded run and releases cleanly',()=>{
 const followed=[];const panel=Object.create(PlanPanel.prototype);Object.assign(panel,{controlMode:'manual',recorded:null,following:false,onFollow:s=>followed.push(s),showTransport(){}});
 const first={time_s:1,position:{longitude:127,latitude:37,altitude_m:80}},next={time_s:2,position:{longitude:127.001,latitude:37,altitude_m:80}};
 panel.acceptManualSample(first);assert.equal(followed.length,0);panel.setFollowing(true);assert.equal(followed.at(-1),first);
 panel.acceptManualSample(next);assert.equal(followed.at(-1),next);panel.setFollowing(false);assert.equal(followed.at(-1),null);
 panel.acceptManualSample(first);assert.equal(followed.at(-1),null);panel.setFollowing(true);assert.equal(followed.at(-1),first);
});
