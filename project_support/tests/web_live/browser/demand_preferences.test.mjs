import test from 'node:test';
import assert from 'node:assert/strict';
import {DemandPanel} from '../../../../user_application/web/domains/uam/planning/demand_panel.js';
import {fakeDocument} from './fake_dom.mjs';
const memory=()=>{let value=null;return {getItem:()=>value,setItem:(_k,v)=>{value=v;}};};
const panel=storage=>new DemandPanel({api:{},document:fakeDocument,storage});
test('new planning window restores edited form but never a generated result or server defaults',()=>{
 const storage=memory(),a=panel(storage);
 a.state={...a.state,scope:['a','b'],operating:{start:'08:00',end:'19:00'},seed:{mode:'fixed',value:42},
  fleet:{...a.state.fleet,count:3},manual:{want:true,seats:'6',vertiport:'a'},schedule_planning:{fato_headway_s:85},weight_defaults:{a:{departure:9}}};
 a.result={flights:99};const b=panel(storage);
 for(const key of ['scope','operating','seed','fleet','manual','schedule_planning'])assert.deepEqual(b.state[key],a.state[key]);
 assert.equal(b.result,null);assert.equal(b.state.weight_defaults,undefined);
 b.state={...b.state,seed:{mode:'fixed',value:7}};assert.equal(panel(storage).state.seed.value,7);
});
test('explicit reset persists while corrupt and unavailable storage remain usable',()=>{
 const storage=memory(),a=panel(storage);a.state={...a.state,operating:{start:'09:00',end:'18:00'}};
 a.repaint=()=>{};a.say=()=>{};a.setScrapping=()=>{};a.reset();
 assert.equal(panel(storage).state.operating.start,'06:30');
 assert.equal(panel({getItem:()=>'{bad'}).state.operating.start,'06:30');
 const blocked=panel({getItem(){throw Error();},setItem(){throw Error();}});
 assert.doesNotThrow(()=>{blocked.state={...blocked.state,seed:{mode:'fixed',value:5}};});
});
