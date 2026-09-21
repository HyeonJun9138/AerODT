import test from 'node:test';
import assert from 'node:assert/strict';
import {surfaceChart,fitGroundRangeKm,GROUND_RANGES_KM} from '../../../../user_application/web/domains/uam/cockpit/cockpit_surface.js';
import {CockpitPanel} from '../../../../user_application/web/domains/uam/cockpit/cockpit_panel.js';
import {fakeDocument} from './fake_dom.mjs';
const records=new Map([['VP1',{name:'테스트',layout:{frame:{latitude:37,longitude:127},gates:[{id:'G1',center_m:[20,0],radius_m:8}],fatos:[{id:'F2',center_m:[0,30],radius_m:10}],edges:[{points_m:[[20,0],[0,30]]}]}}]]);
const entity={entity_id:'scenario:U1',orientation_source:'attitude',latitude_deg:37,longitude_deg:127,heading_deg:0};
test('surface chart reads real geometry and only explicit plan assignments without mutating inputs',()=>{
 const before=structuredClone(records),chart=surfaceChart(records,entity,{departure:{vertiport:'VP1',gate:'G1',fato:'F2'}});
 assert.equal(chart.gate,'G1');assert.equal(chart.fato,'F2');assert.equal(chart.places.length,2);assert.ok(chart.places[0].longitude_deg>127);assert.deepEqual(records,before);
 assert.equal(surfaceChart(records,entity).gate,null);assert.equal(surfaceChart(records,{latitude_deg:0,longitude_deg:0}),null);
});
test('live assignments honor aircraft identity and updated clearance rather than planned stands',()=>{
 const detail={state:{aircraft_id:'U1',clearance:{vertiport:'VP1',stand:'G2',fato:'F3'}}};
 assert.equal(surfaceChart(records,entity,null,detail).gate,'G2');detail.state.clearance.stand='G4';assert.equal(surfaceChart(records,entity,null,detail).gate,'G4');
 detail.state.aircraft_id='U2';assert.equal(surfaceChart(records,entity,null,detail).gate,null);
});
test('ground NAV uses metre ranges, labels assignments and restores air route without flight commands',()=>{
 const p=new CockpitPanel({document:fakeDocument});p.open();p.groundButton.click();
 assert.equal(p.rangeButton.textContent,'200 m','no deck yet, so nothing to fit to');
 const chart=surfaceChart(records,entity,{departure:{vertiport:'VP1',gate:'G1',fato:'F2'}});
 p.update({entity,mission:{surface:chart},nearby:[]},0);
 // The range is fitted to the deck: this one reaches 40 m from the aircraft.
 assert.equal(p.rangeButton.textContent,'50 m');assert.equal(p.readouts.destination.textContent,'G1');assert.equal(p.readouts.distance.textContent,'F2');assert.equal(p.surface.children.length,5);
 assert.equal(p.screens.nav.querySelector('.cockpit-metric-distance').querySelector('small').textContent,'');
 for(let i=0;i<10;i++){p.rangeButton.click();assert.ok(Number.isFinite(p.rangeKm));assert.match(p.rangeButton.textContent,/ m$/);}
 p.update({entity,mission:{},nearby:[]},100);assert.equal(p.surface.children.length,0);assert.equal(p.readouts.destination.textContent,'미할당');
 p.groundButton.click();p.update({entity,mission:{},nearby:[]},200);assert.equal(p.rangeButton.textContent,'1 km');assert.equal(p.route.getAttribute('visibility'),'visible');p.close();assert.equal(p.surface.children.length,0);
});

test('the ground range is fitted to the stand and pad being taxied between, and does not flicker',()=>{
 // A deck 128 m long: at the fixed 200 m range every one of these stands was
 // drawn inside a quarter of the rose, which is the knot this fit undoes.
 const M=111320,cos=Math.cos(37*Math.PI/180);
 const at=([e,n])=>({entity_id:'scenario:U1',orientation_source:'attitude',heading_deg:0,
  latitude_deg:37+n/M,longitude_deg:127+e/(M*cos)});
 const wide=new Map([['VP5',{name:'목동',layout:{frame:{latitude:37,longitude:127},
  gates:[{id:'G1',center_m:[-37,-68],radius_m:7.2},{id:'G2',center_m:[37,60],radius_m:7.2}],
  fatos:[{id:'F1',center_m:[0,0],radius_m:9},{id:'F2',center_m:[0,50],radius_m:9}],
  edges:[{points_m:[[-37,-68],[0,0],[37,60]]}]}}]]);
 const leg=(gate,fato)=>({departure:{vertiport:'VP5',gate,fato}});
 const stand=at([-37,-68]);

 // Assigned: fit what this aircraft taxis between. Unassigned: the whole deck.
 assert.equal(fitGroundRangeKm(surfaceChart(wide,stand,leg('G1','F1')),stand),.1);
 assert.equal(fitGroundRangeKm(surfaceChart(wide,stand),stand),.2);
 assert.ok(GROUND_RANGES_KM.includes(.1),'a fitted range is one of the offered steps');
 assert.equal(fitGroundRangeKm(null,stand),null);
 assert.equal(fitGroundRangeKm(surfaceChart(wide,stand),{latitude_deg:NaN,longitude_deg:127}),null);
 assert.equal(fitGroundRangeKm(surfaceChart(wide,stand),stand,[]),null);

 const p=new CockpitPanel({document:fakeDocument});p.open();p.groundButton.click();
 p.update({entity:stand,mission:{surface:surfaceChart(wide,stand,leg('G1','F1'))},nearby:[]},0);
 assert.equal(p.rangeKm,.1,'fitted when the leg appears');
 assert.equal(p.rangeButton.textContent,'100 m');

 // Halfway to the pad the fit is one step tighter. Following it there and back
 // is how a range flickers while an aircraft taxis, so one step is ignored.
 const half=at([-18.5,-34]);
 assert.equal(fitGroundRangeKm(surfaceChart(wide,half,leg('G1','F1')),half),.075);
 p.update({entity:half,mission:{surface:surfaceChart(wide,half,leg('G1','F1'))},nearby:[]},200);
 assert.equal(p.rangeKm,.1);

 // Held off the deck the chart outgrows the range, and it widens at once.
 const far=at([0,800]);
 p.update({entity:far,mission:{surface:surfaceChart(wide,far,leg('G1','F1'))},nearby:[]},400);
 assert.equal(p.rangeKm,.1,'far approach fits the destination deck instead of empty air');
 // Back on the stand the fit has fallen three steps, which is a real change.
 p.update({entity:stand,mission:{surface:surfaceChart(wide,stand,leg('G1','F1'))},nearby:[]},600);
 assert.equal(p.rangeKm,.1);

 // A range the pilot chose is theirs for this leg, and the next leg is fitted.
 p.rangeButton.click();const chosen=p.rangeKm;assert.notEqual(chosen,.1);
 p.update({entity:stand,mission:{surface:surfaceChart(wide,stand,leg('G1','F1'))},nearby:[]},800);
 assert.equal(p.rangeKm,chosen);
 p.update({entity:stand,mission:{surface:surfaceChart(wide,stand,leg('G1','F2'))},nearby:[]},1000);
 assert.equal(p.rangeKm,.15,'the pad further up the deck is fitted again');

 // A label clears the stand it names rather than being swallowed by it.
 const circle=[...p.surface.children].find(node=>node.tagName==='CIRCLE');
 const text=[...p.surface.children].find(node=>node.tagName==='TEXT');
 assert.ok(Number(circle.getAttribute('r'))>4,'a fitted stand is drawn large');
 assert.ok(Number(text.getAttribute('y'))<Number(circle.getAttribute('cy'))-Number(circle.getAttribute('r')));
 p.close();assert.equal(p.groundFitKey,null);
});

test('manual contact at the origin displays departure chart rather than remote destination',()=>{
 const all=new Map(records);all.set('VP2',{name:'도착',layout:{frame:{latitude:38,longitude:128}}});
 const plan={departure:{vertiport:'VP1',gate:'G1',fato:'F2'},arrival:{vertiport:'VP2',gate:'G9',fato:'F9'}};
 const chart=surfaceChart(all,{...entity,manual:true,airborne:false,phase:'parked'},plan);
 assert.equal(chart.id,'VP1');assert.equal(chart.gate,'G1');assert.equal(chart.fato,'F2');
});
