import test from 'node:test';
import assert from 'node:assert/strict';
import {CockpitPanel} from '../../../../user_application/web/domains/uam/cockpit/cockpit_panel.js';
import {CockpitView} from '../../../../user_application/web/domains/uam/cockpit/cockpit_view.js';
import {fakeDocument} from './fake_dom.mjs';
test('selected UAM dock stays visible through repeated manual/observation and camera updates',()=>{
 const p=new CockpitPanel({document:fakeDocument});p.setDockAvailable(true);p.setDockExpanded(true);
 for(let i=0;i<100;i++){
  p.setManualMode(i%2===0);p.setPlayback({enabled:i%3===0});
  assert.equal(p.toolbar.hidden,false);assert.equal(p.dockExpanded,true);
 }
 p.open();p.close();assert.equal(p.toolbar.hidden,false,'external view keeps selected aircraft action');
 p.setManualMode(false);p.setDockAvailable(false);assert.equal(p.toolbar.hidden,true,'deselection removes unused dock');
});
test('preparing UAM has an explanation, and ready controls replace it without removing the button',()=>{
 const p=new CockpitPanel({document:fakeDocument});p.setDockAvailable(true);assert.equal(p.dockHint.hidden,false);
 p.setManualMode(true);assert.equal(p.dockHint.hidden,true);assert.equal(p.toolbar.hidden,false);
 p.setManualMode(false);p.setPlayback({enabled:true});assert.equal(p.dockHint.hidden,true);assert.equal(p.playbackGroup.hidden,false);
});
test('external-view playback works, but a manual lease blocks fleet playback commands',()=>{
 const v=Object.create(CockpitView.prototype);v.camera={active:false};v.panel={dockAvailable:true};let clicks=0;
 v.playbackSources=()=>({button:{click(){clicks++;}}});v.readControls=()=>null;
 v.playbackAction('toggle');assert.equal(clicks,1);
 v.readControls=()=>({entity_id:'scenario:A1'});v.playbackAction('toggle');assert.equal(clicks,1);
});
