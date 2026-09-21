import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeDocument,FakeElement} from './fake_dom.mjs';
import {UamPredictionControls} from '../../../../user_application/web/domains/uam/prediction/uam_prediction_controls.js';
import {ManualFlightPanel} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_panel.js';
const values={enabled:true,model:'uam_route_mlp_comparison',short_enabled:true,mid_enabled:true,long_enabled:true};
test('prediction shortcuts wait for confirmed settings, serialize writes, and retain state on failure',async()=>{
 let finish,calls=[];const ui=new UamPredictionControls({document:fakeDocument,onChange:(key,value)=>{calls.push([key,value]);return new Promise(resolve=>finish=resolve);}});
 assert.equal(ui.master.disabled,true);await ui.change('enabled',true);assert.equal(calls.length,0);
 ui.update(values);const pending=ui.change('short_enabled',false);
 assert.equal(ui.master.disabled,true);assert.equal(ui.buttons.get('short_enabled').getAttribute('aria-pressed'),'true');
 await ui.change('long_enabled',false);assert.equal(calls.length,1);
 finish(false);await pending;assert.equal(ui.buttons.get('short_enabled').getAttribute('aria-pressed'),'true');
 assert.match(ui.note.textContent,/저장하지 못/);
 const success=ui.change('short_enabled',false);ui.update({...values,short_enabled:false});finish(true);await success;
 assert.equal(ui.buttons.get('short_enabled').getAttribute('aria-pressed'),'false');assert.equal(ui.master.disabled,false);
});
test('Live Twin updates do not write back and comparison horizons are gated by model and master',async()=>{
 let writes=0;const ui=new UamPredictionControls({document:fakeDocument,onChange:()=>{writes++;}});
 ui.update({...values,enabled:false});assert.equal(ui.buttons.get('mid_enabled').disabled,true);
 ui.update({...values,model:'other'});await ui.change('mid_enabled',false);assert.equal(writes,0);
 ui.update({...values,mid_enabled:false});assert.equal(ui.buttons.get('mid_enabled').disabled,false);
 assert.equal(ui.buttons.get('mid_enabled').getAttribute('aria-pressed'),'false');assert.equal(writes,0);
});
test('camera focus handoff retains commands and throttle without resuming a held or closed session',()=>{
 let focus=0,pauses=0;const document={...fakeDocument,body:new FakeElement('body'),hidden:false};
 const p=new ManualFlightPanel({document,target:null,onPause:()=>pauses++});
 p.root.focus=()=>focus++;p.open();focus=0;p.input.setThrottle(.42);p.input.keys.add('ArrowUp');
 p.focusControls();assert.equal(focus,1);assert.equal(p.input.throttle,.42);assert.equal(p.input.active,true);
 assert.equal(p.input.keys.has('ArrowUp'),true);assert.equal(pauses,0);
 p.input.suspend();p.focusControls();assert.equal(focus,1);assert.equal(p.input.active,false);
 p.close();p.focusControls();assert.equal(focus,1);
});
