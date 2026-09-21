import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const preview=await import('../../../../digital_twin/visualization/web/model_preview.js').catch(()=>({}));

test('the preview engine credit goes to the shared page credit area, not inside the model box',()=>{
  assert.equal(typeof preview.ModelPreview,'function');
  const credits={id:'map-credits'};
  const view=new preview.ModelPreview({},{},()=>{},{creditContainer:credits});
  const options=view.widgetOptions();
  assert.equal(options.creditContainer,credits,'one credit area for the page, not one per widget');
  assert.equal(options.globe,false);assert.equal(options.baseLayer,false);
  assert.equal(options.requestRenderMode,true);assert.equal(options.maximumRenderTimeChange,Infinity,'idle previews never request frames just because time passed');
  assert.equal(new preview.ModelPreview({},{}).widgetOptions().creditContainer,undefined,
    'without a shared area the engine keeps its own default credit');
});
test('preview does not install an idle spin renderer and input/resize request fresh frames',()=>{
 const source=readFileSync(new URL('../../../../digital_twin/visualization/web/model_preview.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/preRender\.addEventListener/);
 assert.match(source,/const pose=this\.pose=[^\n]*requestRender/);
 assert.match(source,/ResizeObserver\([^\n]*requestRender/);
});

test('closing a pending preview disposes the late model without creating a WebGL widget',async()=>{
  assert.equal(typeof preview.ModelPreview,'function');
  let resolve,destroyed=0,loads=0;
  const C={Cartesian3:{fromDegrees:()=>({})},Transforms:{eastNorthUpToFixedFrame:()=>({})},CesiumWidget:class{constructor(){throw Error('must not create after close');}}};
  const view=new preview.ModelPreview(C,{},()=>{},{loadModel:()=>{loads++;return new Promise(r=>resolve=r);}});
  const pending=view.show({asset_id:'a',uri:'/visual-assets/a.glb'});view.show({asset_id:'a',uri:'/visual-assets/a.glb'});
  view.close();resolve({destroy(){destroyed++;}});await pending;
  assert.equal(loads,1);assert.equal(destroyed,1);
});

test('a rejected old preview cannot replace the new target status',async()=>{
  let reject,resolve;const statuses=[];
  const C={Cartesian3:{fromDegrees:()=>({})},Transforms:{eastNorthUpToFixedFrame:()=>({})}};
  const view=new preview.ModelPreview(C,{},s=>statuses.push(s),{loadModel:(_C,a)=>new Promise((r,j)=>{if(a.asset_id==='a')reject=j;else resolve=r;})});
  const first=view.show({asset_id:'a',uri:'/visual-assets/a.glb'});const second=view.show({asset_id:'b',uri:'/visual-assets/b.glb'});
  reject(Error('old'));await first;assert.equal(statuses.at(-1),'loading');
  view.close();resolve({destroy(){}});await second;assert.equal(statuses.includes('error'),false);
});

test('render readiness deadline is suspended while the preview tab is hidden',()=>{
  assert.equal(typeof preview.ModelPreview.prototype.setVisible,'function');
  const set=globalThis.setTimeout,clear=globalThis.clearTimeout,timers=new Map();let id=0,errors=0;
  globalThis.setTimeout=fn=>{timers.set(++id,fn);return id;};globalThis.clearTimeout=id=>timers.delete(id);
  try {
    const view=new preview.ModelPreview({},{});view.widget={};view.fail=()=>errors++;
    view.setVisible(true);assert.equal(timers.size,1);view.setVisible(false);assert.equal(timers.size,0);assert.equal(errors,0);
    view.setVisible(true);assert.equal(timers.size,1);view.ready=true;view.setVisible(false);view.setVisible(true);assert.equal(timers.size,0);
  } finally {globalThis.setTimeout=set;globalThis.clearTimeout=clear;}
});

test('focused preview supports keyboard orbit and bounded zoom without consuming unrelated keys',()=>{
  assert.equal(typeof preview.ModelPreview.prototype.handleKey,'function');
  const view=new preview.ModelPreview({},{});Object.assign(view,{heading:0,pitch:0,range:100,minimumRange:20,baseRange:100,pose:()=>{}});
  let prevented=0;const key=k=>view.handleKey({key:k,preventDefault(){prevented++;}});
  key('ArrowRight');assert.ok(view.heading>0);key('ArrowUp');assert.ok(view.pitch<0);
  for(let i=0;i<50;i++)key('+');assert.equal(view.range,20);
  const old=prevented;key('Tab');assert.equal(prevented,old);
});

test('the page keeps one visible credit area and the preview writes into a separate sink',()=>{
  const markup=readFileSync(new URL('../../../../user_application/web/index.html',import.meta.url),'utf8');
  assert.match(markup,/id="map-credits"/);
  assert.match(markup,/id="preview-credits"[^>]*hidden/,'the duplicate engine logo is not shown a second time');
  const box=markup.slice(markup.indexOf('id="model-preview"'),markup.indexOf('id="preview-image"'));
  assert.doesNotMatch(box,/credit/i,'no credit container inside the model box');
  const app=readFileSync(new URL('../../../../user_application/web/app.js',import.meta.url),'utf8');
  assert.match(app,/creditContainer:\$\('preview-credits'\)/);
});
