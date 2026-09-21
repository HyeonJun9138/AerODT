import test from 'node:test';
import assert from 'node:assert/strict';
import {OperatingEnvironment} from '../../../../user_application/web/domains/uam/operations/operating_environment.js';

test('reported ports/routes replace the displayed environment and return to saved Simulation on toggle',async()=>{
  let source='physical';const calls=[];
  const globe={showVertiports:async p=>calls.push(p),showRoutes:async n=>calls.push(n),setScenarioPassengers:()=>{}};
  const view=new OperatingEnvironment({globe:()=>globe,readRevision:async()=>({revision:source}),
    read:async()=>({source,revision:source,vertiports:[source+'-port'],network:source+'-routes'})});
  await view.refresh();await view.refresh();assert.deepEqual(calls,[['physical-port'],'physical-routes']);
  source='scenario';await view.refresh();assert.deepEqual(calls.slice(2),[['scenario-port'],'scenario-routes']);
  view.close();source='physical';await view.refresh();assert.equal(calls.length,4);
});

test('closing during a slow environment read does not redraw the map',async()=>{
  let resolve;const calls=[];
  const view=new OperatingEnvironment({globe:()=>({showVertiports:p=>calls.push(p)}),
    readRevision:async()=>({revision:'next'}),read:()=>new Promise(r=>resolve=r)});
  const pending=view.refresh();await Promise.resolve();view.close();resolve({source:'physical',revision:'next',vertiports:[]});
  await pending;assert.equal(calls.length,0);
});
