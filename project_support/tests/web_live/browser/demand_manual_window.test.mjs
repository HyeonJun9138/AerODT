import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeDocument} from './fake_dom.mjs';
import {createPanel,copyPanel} from '../../../../user_application/web/panel_instances.js';
import {DemandPanel} from '../../../../user_application/web/domains/uam/planning/demand_panel.js';

for(const seats of ['4','6','8'])test(`visible cloned demand panel retains ${seats}-seat manual request across generation`,async()=>{
 const events=[];const applied={loaded:true,schedule:{flights:12}};
 const source=createPanel(DemandPanel,{document:fakeDocument,
  api:{generate:async request=>{assert.deepEqual(request.manual,{want:true,seats,vertiport:'a'});return {flights:12,applied};}},
  onPlanLoaded:(plan,manual)=>events.push(['loaded',plan,manual]),
  onControlPanel:(plan,manual)=>events.push(['open',plan,manual])});
 const visible=copyPanel(source);
 visible.records=['a','b'].map((id,i)=>({id,name:id,gates:4,latitude:37.5,longitude:127+i/10}));
 visible.state={...visible.state,scope:['a','b'],manual:{want:true,seats,vertiport:'a'}};
 await visible.generate();
 assert.deepEqual(events,[['loaded',applied,{want:true,seats,vertiport:'a'}],['open',applied,{want:true,seats,vertiport:'a'}]]);
 assert.equal(source.plan,null);assert.equal(source.manualRequest().want,false);
 assert.equal(visible.plan,applied);
});


test('reading a day in another setup window does not cancel the pending manual request', async () => {
 const applied={loaded:true,schedule:{flights:12}};
 const events=[];
 const panel=new DemandPanel({document:fakeDocument,api:{},plans:{describe:async()=>applied},
   onPlanLoaded:(...args)=>events.push(args)});
 await panel.readPlan();
 assert.deepEqual(events,[[applied]]);
 assert.equal(panel.manualRequest().want,false);
 // Explicitly applying a new plan still publishes the user's selection.
 panel.state.manual={want:true,seats:'6',vertiport:null};
 await panel.adoptPlan(applied);
 assert.deepEqual(events[1],[applied,{want:true,seats:'6',vertiport:null}]);
});
