import test from 'node:test';
import assert from 'node:assert/strict';
import {navTraffic} from '../../../../user_application/web/domains/uam/cockpit/cockpit_view.js';
import {CockpitPanel} from '../../../../user_application/web/domains/uam/cockpit/cockpit_panel.js';
import {fakeDocument} from './fake_dom.mjs';
test('manual NAV shares current fleet observations and excludes ownship',()=>{
 const own={entity_id:'A',kind:'uam',latitude_deg:37,longitude_deg:127};
 const other={...own,entity_id:'B',heading_deg:90,name:'UAM002'};
 const items=new Map([['A',{entity:own}],['B',{entity:other}],['S',{entity:{...own,entity_id:'S',kind:'satellite'}}]]);
 assert.deepEqual(navTraffic(items,'A'),[other]);
 const panel=new CockpitPanel({document:fakeDocument});panel.open();
 panel.update({entity:{...own,orientation_source:'attitude',heading_deg:0},mission:{},nearby:navTraffic(items,'A')},0);
 assert.equal(panel.contacts.children.filter(e=>e.getAttribute('data-contact-id')==='B').length,1);
 assert.ok(panel.contacts.children.some(e=>e.textContent==='UAM002'));
 assert.match(panel.navStatus.textContent,/관측 교통 1/);
});
test('out-of-range contacts cannot consume the visible contact budget',()=>{
 const own={entity_id:'A',latitude_deg:37,longitude_deg:127,orientation_source:'attitude',heading_deg:0};
 const nearby=Array.from({length:100},(_,i)=>({...own,entity_id:'far'+i,latitude_deg:40}));
 nearby.push({...own,entity_id:'visible',longitude_deg:127.0001});
 const panel=new CockpitPanel({document:fakeDocument});panel.open();
 panel.update({entity:own,mission:{},nearby},0);
 assert.ok(panel.contacts.children.some(e=>e.getAttribute('data-contact-id')==='visible'));
});
