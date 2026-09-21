import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../../../../user_application/web/index.html',import.meta.url),'utf8');
const source=html.match(/<script type="module" id="app-bootstrap">([\s\S]*?)<\/script>/)[1];

function setup(){
  let timeout,success,failure,cleared=0,reloads=0;
  const elements={loading:{hidden:false,dataset:{phase:'loading'},setAttribute(){}},
    'loading-progress':{value:0,getAttribute(){return String(this.value);}},'loading-step':{},retry:{hidden:true}};
  new Function('load','document','location','console','setTimeout','clearTimeout',source.replace('import(','load('))(
    ()=>new Promise((resolve,reject)=>{success=resolve;failure=reject;}),{getElementById:id=>elements[id]},
    {reload(){reloads++;}},{error(){}},fn=>{timeout=fn;return 1;},()=>{cleared++;});
  return {elements,delay:()=>timeout(),success,failure,state:()=>({cleared,reloads})};
}

test('a stalled module request offers retry without rejecting a late successful startup',async()=>{
  const h=setup();h.delay();
  assert.equal(h.elements.retry.hidden,false);assert.equal(h.elements.loading.dataset.phase,'loading');
  assert.match(h.elements['loading-step'].textContent,/평소보다 오래/);
  h.elements.retry.onclick();assert.equal(h.state().reloads,1);
  h.success();await Promise.resolve();assert.equal(h.state().cleared,1);
  assert.equal(h.elements.loading.dataset.phase,'loading','the live loader retains ownership');
});

test('the module watchdog cannot replace working progress, a handover or a render error',()=>{
  for(const phase of ['ready','leaving','error']){
    const h=setup();h.elements.loading.dataset.phase=phase;h.delay();
    assert.equal(h.elements.retry.hidden,true);assert.equal(h.elements.loading.dataset.phase,phase);
  }
  const h=setup();h.elements['loading-progress'].value=15;h.delay();assert.equal(h.elements.retry.hidden,true);
});

test('a failed module graph cancels the pending watchdog and shows the retry action',async()=>{
  const h=setup();h.failure(new Error('download failed'));await Promise.resolve();
  assert.equal(h.state().cleared,1);assert.equal(h.elements.loading.dataset.phase,'error');
  assert.equal(h.elements.retry.hidden,false);
});

test('the external widget CSS is preloaded without blocking the local loading surface',()=>{
  assert.match(html,/<link rel="preload" as="style" href="https:\/\/cesium.com[^\"]+widgets.css">/);
  assert.doesNotMatch(html,/<link rel="stylesheet"[^>]*href="https:[^>]*widgets.css/);
});

test('every inline startup script is syntactically complete in the delivered HTML',()=>{
  const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(match=>! /\bsrc\s*=/.test(match[1]));
  assert.ok(scripts.length>=2);
  for(const [,attributes,body] of scripts)assert.doesNotThrow(()=>new Function(body),`invalid inline script ${attributes}`);
});
