import test from 'node:test';
import assert from 'node:assert/strict';
import {surfaceChart} from '../../../../user_application/web/domains/uam/cockpit/cockpit_surface.js';
import {CockpitPanel} from '../../../../user_application/web/domains/uam/cockpit/cockpit_panel.js';
import {fakeDocument} from './fake_dom.mjs';
const records=new Map([['VP1',{layout:{frame:{latitude:37,longitude:127},gates:[{id:'G5',center_m:[0,0]}],fatos:[{id:'F4',center_m:[20,20]}],edges:[]}}]]);
const position={latitude_deg:37,longitude_deg:127,manual:true,airborne:false,stage:'gate_out'};
const plan={departure:{vertiport:'VP1',gate:'G5',fato:'F1'}};
const psu={procedure:{origin:'VP1',destination:'VP2',departure_gate:'G5',departure_fato:'F4',ground_chart:{vertiport:'VP1',taxi_granted:true,points:[position,{latitude_deg:37.0001,longitude_deg:127.0001}],occupied:[{aircraft_id:'U2',latitude_deg:37.0001,longitude_deg:127,radius_m:7}]}}};
test('NAV uses live F4 over original F1 and draws server route and occupied footprints',()=>{
 const chart=surfaceChart(records,position,plan,null,psu);
 assert.equal(chart.fato,'F4');assert.equal(plan.departure.fato,'F1');assert.equal(chart.taxiGranted,true);
 const panel=new CockpitPanel({document:fakeDocument});panel.open();panel.groundButton.click();
 panel.update({entity:{...position,orientation_source:'attitude',heading_deg:0},mission:{surface:chart},nearby:[]},0);
 assert.equal(panel.readouts.distance.textContent,'F4');
 assert.ok(panel.surface.children.some(e=>e.getAttribute('data-ground-route')==='assigned'));
 assert.ok(panel.surface.children.some(e=>e.getAttribute('data-ground-occupant')==='U2'));
});
test('stale PSU keeps last assignment labelled but removes route authority and occupancy',()=>{
 const chart=surfaceChart(records,position,plan,null,{...psu,stale:true});
 assert.equal(chart.fato,'F4');assert.equal(chart.stale,true);assert.equal(chart.taxiGranted,false);
 assert.deepEqual(chart.taxiPath,[]);assert.deepEqual(chart.occupied,[]);
});

