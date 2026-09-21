import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeElement,fakeDocument} from './fake_dom.mjs';
import {VertiportPanel} from '../../../../user_application/web/domains/uam/operations/vertiport_panel.js';
import {PsuPanel} from '../../../../user_application/web/domains/uam/operations/psu_panel.js';
test('arrival board row focuses aircraft by aircraft ID, including keyboard',()=>{
 const calls=[],p=new VertiportPanel({document:fakeDocument,onFocusAircraft:id=>calls.push(id)}),host=new FakeElement('div');
 p.live={inbound:[{aircraft_id:'UAM1',flight_id:'FPL1',airborne:true}],holding:[],outbound:[]};
 p.fillLiveBoard(host); const row=host.querySelector('tbody').children[0];row.click();
 assert.deepEqual(calls,['UAM1']);row.onkeydown({key:'Enter',preventDefault(){}});assert.equal(calls.length,2);
});
test('PSU deck click focuses map and retains detail toggle',()=>{
 const calls=[],session={subscribe:()=>()=>{}};
 const p=new PsuPanel({document:fakeDocument,session,onFocusDeck:id=>calls.push(id),deckView:{open(){},close(){}}});
 p.deckHost=new FakeElement('div');p.drawDecks=()=>{};
 p.openDeck('VP1');p.openDeck('VP1');assert.deepEqual(calls,['VP1','VP1']);assert.equal(p.deckId,null);
});
import {OperationsFocus} from '../../../../user_application/web/domains/uam/operations/operations_focus.js';
test('operational aircraft links focus the received Physical aircraft',()=>{
 const selected=[],globe={items:new Map([['physical:UAM1',{}]]),select:id=>selected.push(id),focus:()=>{}};
 const nav=new OperationsFocus({globe:()=>globe});nav.aircraft('UAM1');
 assert.deepEqual(selected,['physical:UAM1']);
});
test('navigation uses current aircraft and ignores late deck responses',async()=>{
 const calls=[],pending={},globe={items:new Map([['scenario:UAM1',{}]]),select:id=>calls.push(['select',id]),focus:()=>calls.push(['track']),flyToVertiport:f=>calls.push(['deck',f.latitude])};
 const nav=new OperationsFocus({globe:()=>globe,readDeck:id=>new Promise(r=>pending[id]=r),notice:m=>calls.push(['notice',m])});
 const a=nav.deck('A'),b=nav.deck('B');pending.B({layout:{frame:{latitude:37,longitude:127}}});await b;pending.A({layout:{frame:{latitude:38,longitude:127}}});await a;
 assert.deepEqual(calls,[['deck',37]]);nav.aircraft('UAM1');nav.aircraft('missing');assert.deepEqual(calls.slice(1,3),[['select','scenario:UAM1'],['track']]);assert.equal(calls[3][0],'notice');
 const c=nav.deck('C');nav.aircraft('UAM1');pending.C({latitude:39,longitude:127});await c;assert.equal(calls.filter(c=>c[0]==='deck').length,1);
});
