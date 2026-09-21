import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Resolve the dashboard's served absolute imports without creating a browser.
const file=new URL('../../../../user_application/web/selection_panel.js',import.meta.url);
const source=readFileSync(file,'utf8').replace(/from '([^']+)'/g,(_match,path)=>{
 const url=path.startsWith('/visualization/')?new URL('../../digital_twin/visualization/web/'+path.slice(15),file):new URL(path,file);
 return `from '${url.href}'`;
});
const {SelectionPanel}=await import('data:text/javascript,'+encodeURIComponent(source));

function harness(t){
 const timers=new Map(),loaded=[];let id=0,now=0;
 t.mock.method(globalThis,'setTimeout',fn=>{timers.set(++id,fn);return id;});
 t.mock.method(globalThis,'clearTimeout',key=>timers.delete(key));
 t.mock.method(performance,'now',()=>now);
 const panel=Object.create(SelectionPanel.prototype);
 Object.assign(panel,{entityId:'a',previewKey:'plane',isNavigating:()=>true,isPrimaryModelPreparing:()=>false,
  preview:{close(){},onStatus(){},show:asset=>loaded.push(asset.asset_id)}});
 const tick=(elapsed=150)=>{now+=elapsed;const next=timers.entries().next().value;if(next){timers.delete(next[0]);next[1]();}};
 return {panel,timers,loaded,tick};
}
test('preview load yields the first turn and stays deferred until main navigation settles',t=>{
 const {panel,timers,loaded,tick}=harness(t);
 panel.queuePreview({asset_id:'plane'},'plane');assert.deepEqual(loaded,[]);assert.equal(timers.size,1);
 for(let i=0;i<10;i++)tick();assert.deepEqual(loaded,[]);assert.equal(timers.size,1);
 panel.isNavigating=()=>false;tick();assert.deepEqual(loaded,['plane']);assert.equal(timers.size,0);
});
test('changing preview cancels the old asset and disposing prevents late second-context loads',t=>{
 const {panel,timers,loaded,tick}=harness(t);
 panel.queuePreview({asset_id:'plane'},'plane');panel.previewKey='satellite';
 panel.queuePreview({asset_id:'satellite'},'satellite');assert.equal(timers.size,1);
 panel.isNavigating=()=>false;tick();assert.deepEqual(loaded,['satellite']);
 panel.queuePreview({asset_id:'satellite'},'satellite');panel.destroy();assert.equal(timers.size,0);tick();assert.deepEqual(loaded,['satellite']);
});
test('closing the selection while deferred makes even an already queued callback inert',t=>{
 const {panel,loaded,tick}=harness(t);panel.queuePreview({asset_id:'plane'},'plane');
 panel.entityId=null;panel.isNavigating=()=>false;tick();assert.deepEqual(loaded,[]);
});

test('a settled camera still gives the selected flight model its download and GPU preparation first',t=>{
 const {panel,loaded,tick}=harness(t);let primary='downloading';
 panel.isPrimaryModelPreparing=id=>{assert.equal(id,'a');return primary!=='ready';};
 panel.queuePreview({asset_id:'plane'},'plane');
 tick(3300);panel.isNavigating=()=>false;tick();assert.deepEqual(loaded,[]);
 primary='preparing';tick(3200);assert.deepEqual(loaded,[]);
 primary='ready';tick();assert.deepEqual(loaded,['plane']);
});

test('a failed primary releases the preview without waiting for the model deadline',t=>{
 const {panel,loaded,tick}=harness(t);let failed=false;
 panel.isNavigating=()=>false;panel.isPrimaryModelPreparing=()=>!failed;
 panel.queuePreview({asset_id:'plane'},'plane');tick();assert.deepEqual(loaded,[]);
 failed=true;tick();assert.deepEqual(loaded,['plane']);
});

test('a hung primary cannot indefinitely starve a stationary visible selection preview',t=>{
 const {panel,loaded,timers,tick}=harness(t);
 panel.isNavigating=()=>false;panel.isPrimaryModelPreparing=()=>true;
 panel.queuePreview({asset_id:'plane'},'plane');tick(11999);assert.deepEqual(loaded,[]);
 tick(1);assert.deepEqual(loaded,['plane']);assert.equal(timers.size,0);
});

test('the primary deadline does not bypass navigation or hidden-tab deferral',t=>{
 const {panel,loaded,tick}=harness(t);panel.isPrimaryModelPreparing=()=>true;
 panel.queuePreview({asset_id:'plane'},'plane');tick(20000);assert.deepEqual(loaded,[]);
 panel.isNavigating=()=>false;tick();assert.deepEqual(loaded,['plane']);
});

test('switching between aircraft of the same type checks the current primary, not the previous one',t=>{
 const {panel,loaded,tick}=harness(t);const preparing=new Set(['a','b']),checked=[];
 panel.isNavigating=()=>false;panel.isPrimaryModelPreparing=id=>{checked.push(id);return preparing.has(id);};
 panel.queuePreview({asset_id:'plane'},'plane');tick();
 preparing.delete('a');panel.entityId='b';tick();assert.deepEqual(loaded,[]);
 preparing.delete('b');tick();assert.deepEqual(loaded,['plane']);assert.deepEqual(checked,['a','b','b']);
});

test('a canceled callback cannot open a second preview when the same asset is queued again',t=>{
 const {panel,loaded,timers,tick}=harness(t);
 panel.queuePreview({asset_id:'plane'},'plane');const stale=timers.values().next().value;
 panel.queuePreview({asset_id:'plane'},'plane');panel.isNavigating=()=>false;
 stale();assert.deepEqual(loaded,[]);assert.equal(timers.size,1);
 tick();assert.deepEqual(loaded,['plane']);
});

test('collapsing the card cancels a primary-model wait while preserving the selected target',t=>{
 const {panel,loaded,timers}=harness(t),card={dataset:{},setAttribute(){}};
 panel.$=id=>id==='selection'?card:null;panel.isPrimaryModelPreparing=()=>true;
 panel.queuePreview({asset_id:'plane'},'plane');const stale=timers.values().next().value;
 panel.setCollapsed(true);assert.equal(panel.entityId,'a');assert.equal(panel.collapsed,true);
 assert.equal(card.dataset.open,'false');assert.equal(panel.previewKey,null);
 panel.isNavigating=()=>false;stale();assert.deepEqual(loaded,[]);
});

test('constructor uses only its injected root lookup and owns its preview container',()=>{
 const firstNodes=new Map([['model-preview',{}],['preview-credits',{}]]),secondNodes=new Map([['model-preview',{}],['preview-credits',{}]]);
 const first=new SelectionPanel({}, {document:{getElementById(){throw Error('global lookup');}},lookup:id=>firstNodes.get(id)});
 const second=new SelectionPanel({}, {document:{getElementById(){throw Error('global lookup');}},lookup:id=>secondNodes.get(id)});
 assert.equal(first.preview.container,firstNodes.get('model-preview'));assert.equal(second.preview.container,secondNodes.get('model-preview'));assert.notEqual(first.preview,second.preview);
 first.destroy();second.destroy();
});

test('a scoped panel creates one namespaced sensor section when absent from template',()=>{
 const inserted=[],mission={before:node=>inserted.push(node)},preview={};
 const doc={createElement:()=>({dataset:{}})};
 const panel=new SelectionPanel({}, {document:doc,root:{id:'selection-window-test'},lookup:id=>id==='model-preview'?preview:id==='mission'?mission:null});
 panel.setSensors(null);panel.setSensors(null);
 assert.equal(inserted.length,1);assert.equal(inserted[0].id,'selection-window-test-physical-sensor-detail');assert.equal(inserted[0].dataset.selectionId,'physical-sensor-detail');panel.destroy();
});
