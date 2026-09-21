import test from 'node:test';import assert from 'node:assert/strict';
import {SimulationPanel,definitionFromForm} from '../../../../user_application/web/domains/uam/planning/simulation_panel.js';
test('height fields round trip into the definition',()=>{
 const r=definitionFromForm({name:'test',latitude:37,longitude:127,heading_deg:0,gates:4,pattern:'row',vehicle_class:'medium',fatos:[{role:'both'}],takeoff_height_m:120,landing_height_m:90});
 assert.equal(r.definition?.takeoff_height_m,120);assert.equal(r.definition?.landing_height_m,90);
});
test('locked save does not call mutation API',async()=>{
 let writes=0;const p=new SimulationPanel({api:{editState:async()=>({locked:true,message:'locked'}),create:async()=>{writes++;}},setTimer:null});p.error={textContent:''};
 await p.save();assert.equal(writes,0);assert.equal(p.error.textContent,'locked');
});
test('late lock response cannot overwrite a new editor generation',async()=>{
 let resolve;const p=new SimulationPanel({api:{editState:()=>new Promise(r=>{resolve=r;})},setTimer:null});p.editGeneration=1;p.editLocked=false;
 const pending=p.readEditState();p.editGeneration=2;resolve({locked:true,message:'old'});await pending;assert.equal(p.editLocked,false);
});
test('late collision response cannot paint after leaving the editor',async()=>{
 let resolve,paint=0;const p=new SimulationPanel({api:{checkHeights:()=>new Promise(r=>{resolve=r;}),heightConflicts:()=>paint++,heightPreview:()=>{}},setTimer:null});
 p.editingId='vp';p.heightReport={textContent:''};const pending=p.checkHeightPreview({takeoff_height_m:80,landing_height_m:60});p.leave();resolve({links:{a:{collisions:1}}});await pending;assert.equal(paint,0);
});
test('missing edit-state API is not described as an active simulation',async()=>{
 const p=new SimulationPanel({api:{editState:async()=>{throw Object.assign(new Error('HTTP 404'),{status:404});},checkHeights:async()=>({})},setTimer:null});
 p.editNotice={textContent:''};p.heightReport={textContent:''};p.editingId='vp';
 await p.readEditState();await p.checkHeightPreview({});
 assert.match(p.editNotice.textContent,/재시작/);assert.doesNotMatch(p.heightReport.textContent,/실행 중/);
});
