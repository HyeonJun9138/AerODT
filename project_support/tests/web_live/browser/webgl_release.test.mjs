// Every secondary Cesium widget on the page gives its WebGL context back when
// it closes. Found live: the map's own context - the oldest on the page - was
// evicted by the browser after a dozen camera restarts, and from then on every
// model on the map stopped drawing while the labels went on moving.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {releaseWidgetContext,releaseCanvasContext} from '../../../../digital_twin/visualization/web/webgl_release.js';

function fakeCanvas({lost=false,extension=true,context=true}={}){
  const calls=[];
  const gl={isContextLost:()=>lost,getExtension:name=>{calls.push(['getExtension',name]);
    return name==='WEBGL_lose_context'&&extension?{loseContext(){calls.push(['loseContext']);}}:null;}};
  return {calls,canvas:{getContext(kind){calls.push(['getContext',kind]);return context&&kind==='webgl2'?gl:null;}}};
}

test('a destroyed widget has its context released, in that order',()=>{
  const {calls,canvas}=fakeCanvas();
  const events=[];
  const widget={canvas,destroyed:false,isDestroyed(){return this.destroyed;},destroy(){this.destroyed=true;events.push('destroy');}};
  assert.equal(releaseWidgetContext(widget),true);
  assert.deepEqual(events,['destroy']);
  assert.deepEqual(calls.filter(c=>c[0]!=='getContext'),[['getExtension','WEBGL_lose_context'],['loseContext']]);
  // Asking for the existing context, never creating a fresh one to lose.
  assert.deepEqual(calls[0],['getContext','webgl2']);
});

test('a widget that is already destroyed is not destroyed twice, but is still released',()=>{
  const {calls,canvas}=fakeCanvas();
  let destroys=0;
  const widget={canvas,isDestroyed:()=>true,destroy(){destroys++;}};
  assert.equal(releaseWidgetContext(widget),true);
  assert.equal(destroys,0);
  assert.ok(calls.some(c=>c[0]==='loseContext'));
});

test('nothing is done for no widget, no canvas, a lost context, or a missing extension',()=>{
  assert.equal(releaseWidgetContext(null),false);
  assert.equal(releaseWidgetContext({}),false);
  assert.equal(releaseCanvasContext(fakeCanvas({lost:true}).canvas),false);
  assert.equal(releaseCanvasContext(fakeCanvas({extension:false}).canvas),false);
  assert.equal(releaseCanvasContext(fakeCanvas({context:false}).canvas),false);
  assert.equal(releaseCanvasContext({getContext(){throw new Error('no gl');}}),false);
});

test('every secondary widget on the page closes through the release, not a bare destroy',()=>{
  // The map (globe.js) is the one context that must stay; everything else is
  // opened and closed while the page lives and must hand its context back.
  for(const path of ['digital_twin/visualization/web/airframe_camera.js',
                     'digital_twin/visualization/web/model_preview.js',
                     'digital_twin/visualization/web/twinning_map.js']){
    const source=readFileSync(path,'utf-8');
    assert.match(source,/import \{releaseWidgetContext\} from '\.\/webgl_release\.js'/,`${path} imports the release`);
    assert.match(source,/releaseWidgetContext\(this\.widget\);this\.widget=null/,`${path} releases on close`);
    assert.doesNotMatch(source,/this\.widget\?\.destroy\(\);this\.widget=null/,`${path} must not merely destroy`);
  }
});

test('the map says so when its context is taken away, instead of quietly losing its models',()=>{
  const globe=readFileSync('digital_twin/visualization/web/globe.js','utf-8');
  assert.match(globe,/v\.canvas\.addEventListener\('webglcontextlost'/);
  assert.match(globe,/this\.contextLost=true/);
  assert.match(globe,/새로고침/,'the only recovery is a reload, and the message says so');
});
