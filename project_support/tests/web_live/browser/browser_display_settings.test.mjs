import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {browserDisplaySettings} from '../../../../user_application/web/browser_display_settings.js';
import {LibraryPanel} from '../../../../user_application/web/library_panel.js';
import {fakeDocument} from './fake_dom.mjs';

const fixture = JSON.parse(readFileSync(new URL('browser_display_fixture.json', import.meta.url)));
const storage = () => {const values = new Map();return {getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};};
function server() {
  let value = structuredClone(fixture);
  const sent = [];
  return {sent, get value(){return value;}, api: {
    describe:async()=>structuredClone(value),
    apply:async patch=>{sent.push(patch);for(const [id,fields] of Object.entries(patch.sources))Object.assign(value.values[id],fields);return structuredClone(value);},
  }};
}

test('two computers retain independent choices after server changes, refreshes and reopening',async()=>{
  const s=server(),aStore=storage(),bStore=storage();
  const a=browserDisplaySettings({api:s.api,storage:aStore}),b=browserDisplaySettings({api:s.api,storage:bStore});
  const original=await a.api.describe();await b.api.describe();
  await a.api.apply({sources:{buildings:{quality:'compact',opacity:.3,enabled:false},imagery:{provider:'vworld_midnight'}}});
  await b.api.apply({sources:{buildings:{quality:'wide',opacity:.85},imagery:{provider:'world_imagery'}}});
  assert.equal(s.sent.length,0,'display edits never write the server');
  assert.deepEqual(s.value.values,original.values,'source settings preserved');
  s.value.values.buildings.brightness=.4;
  const after=await a.api.describe();
  assert.equal(after.values.buildings.brightness,original.values.buildings.brightness,'untouched choices seeded only once');
  assert.equal(after.values.buildings.quality,'compact');
  assert.equal((await b.api.describe()).values.buildings.quality,'wide');
  const reopened=browserDisplaySettings({api:s.api,storage:aStore});
  assert.equal((await reopened.api.describe()).values.imagery.provider,'vworld_midnight');
});

test('all personal fields stay local while acquisition, UAM and estimation still reach server',async()=>{
  const s=server(),p=browserDisplaySettings({api:s.api,storage:storage()});await p.api.describe();
  const patch={sources:{terrain:{enabled:false,provider:'local_dem'},buildings:{enabled:false,provider:'vworld_hybrid',quality:'compact',distance:'near',opacity:.25,tint:'teal',brightness:1.2},imagery:{provider:'vworld_base'},clouds:{enabled:true,product:'modis',opacity:.3,refresh_seconds:900},uam:{enabled:false},aircraft:{poll_seconds:120},state_estimation:{enabled:false},uam_prediction:{seconds:45}}};
  const result=await p.api.apply(patch);
  assert.deepEqual(s.sent,[{sources:{uam:{enabled:false},aircraft:{poll_seconds:120},state_estimation:{enabled:false},uam_prediction:{seconds:45}}}]);
  for(const id of ['terrain','buildings','imagery','clouds'])assert.deepEqual(result.values[id],patch.sources[id]);
  assert.match(result.sources.find(s=>s.id==='buildings').provider,/혼합/);
  assert.match(result.state.find(s=>s.id==='buildings').message,/브라우저에서 숨김/);
});

test('in-flight stale descriptions cannot overwrite a local choice',async()=>{
  const s=server(),p=browserDisplaySettings({api:s.api,storage:storage()});await p.api.describe();
  let resolve;const old=structuredClone(s.value);s.api.describe=()=>new Promise(r=>resolve=r);
  const pending=p.api.describe();
  await p.api.apply({sources:{buildings:{quality:'compact'}}});resolve(old);
  assert.equal((await pending).values.buildings.quality,'compact');
});

test('invalid local values are recovered and invalid edits cannot bypass source limits',async()=>{
  const s=server(),store=storage();store.setItem('aerodt.map-display.v1',JSON.stringify({sources:{buildings:{quality:'bogus',opacity:99},uam:{enabled:false}}}));
  const p=browserDisplaySettings({api:s.api,storage:store});
  assert.deepEqual((await p.api.describe()).values,s.value.values);
  for(const fields of [{opacity:9},{enabled:'false'},{quality:'bogus'},{brightness:NaN}])await assert.rejects(p.api.apply({sources:{buildings:fields}}));
  assert.equal(s.sent.length,0);
});

test('unavailable storage stays local in memory and reports its persistence limitation once',async()=>{
  const s=server();let warnings=0;
  const p=browserDisplaySettings({api:s.api,storage:{getItem(){throw Error('blocked');},setItem(){throw Error('quota');}},onStorageError:()=>warnings++});
  await p.api.describe();await p.api.apply({sources:{buildings:{opacity:.35}}});
  assert.equal((await p.api.describe()).values.buildings.opacity,.35);
  assert.equal(warnings,1);assert.equal(s.sent.length,0);
});

test('sunlight and place-name toggles survive reopening independently of another computer',()=>{
  const s=server(),store=storage(),a=browserDisplaySettings({api:s.api,storage:store});
  a.setToggle('sunlight',true);a.setToggle('place-names',false);
  assert.equal(a.setToggle('uam',false),false);
  const again=browserDisplaySettings({api:s.api,storage:store}),b=browserDisplaySettings({api:s.api,storage:storage()});
  assert.equal(again.toggle('sunlight',false),true);assert.equal(again.toggle('place-names',true),false);
  assert.equal(b.toggle('sunlight',false),false);assert.equal(b.toggle('place-names',true),true);
});

test('failed mixed shared edits keep personal preferences at the last accepted values',async()=>{
  const s=server(),p=browserDisplaySettings({api:s.api,storage:storage()});const before=await p.api.describe();
  s.api.apply=async()=>{throw Error('server validation');};
  await assert.rejects(p.api.apply({sources:{buildings:{opacity:.3},aircraft:{poll_seconds:0}}}));
  assert.equal((await p.api.describe()).values.buildings.opacity,before.values.buildings.opacity);
});

test('Library form, external settings rows and Live cloud form apply the effective local values',async()=>{
  const s=server(),prefs=browserDisplaySettings({api:s.api,storage:storage()}),applied=[];
  const panel=new LibraryPanel({document:fakeDocument,api:prefs.api,onDisplay:(id,values)=>applied.push([id,values])});
  await panel.sync();await panel.setField('buildings','quality','compact');
  panel.render(fakeDocument.createElement('div'));await panel.ready;
  assert.equal(panel.body.querySelector('[name=buildings__quality]').value,'compact');
  panel.body.querySelector('[name=buildings__opacity]').value='.45';await panel.save();
  assert.equal(applied.findLast(([id])=>id==='buildings')[1].opacity,.45);
  const live=new LibraryPanel({document:fakeDocument,section:'live',api:prefs.api,onDisplay:(id,values)=>applied.push([id,values])});
  await live.sync();await live.setField('clouds','enabled',true);await live.sync();
  assert.equal(applied.findLast(([id])=>id==='clouds')[1].enabled,true);
  assert.equal(s.sent.length,0);
});
