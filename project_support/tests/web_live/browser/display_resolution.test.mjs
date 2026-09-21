import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {displayProfile,cadenceTier,sampleRenderCadence,DisplayResolution,drawingBufferLimit,TIER_MSAA,MODE_MSAA} from '../../../../digital_twin/visualization/web/display_resolution.js';
import {displayQualitySetting} from '../../../../user_application/web/display_settings.js';
import {FakeElement,fakeDocument} from './fake_dom.mjs';
import {LiveGlobe} from '../../../../digital_twin/visualization/web/globe.js';

const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
test('HD, HiDPI, 4K and ultrawide displays include density once and obey the pixel budget',()=>{
  for(const mode of ['auto','sharp','efficient'])for(const tier of ['balanced','fast','constrained'])
    for(const [width,height,dpr] of [[1366,768,1],[1920,1080,1],[1536,864,1.25],[1920,1080,2],
      [2560,1440,1.5],[3840,2160,1],[3840,2160,2],[7680,2160,2],[15360,8640,4]]){
      const p=displayProfile({width,height,dpr},{mode,tier});
      assert.ok(p.renderWidth*p.renderHeight<=p.budget+1);
      assert.ok(p.pixelRatio<=Math.min(dpr,2));assert.ok(Math.max(p.renderWidth,p.renderHeight)<=8192);
      assert.ok(p.renderWidth>0&&p.renderHeight>0);
    }
  near(displayProfile({width:1536,height:864,dpr:1.25}).pixelRatio,1.25);
  near(displayProfile({width:2560,height:1440,dpr:1.5},{mode:'sharp'}).pixelRatio,1.5);
  assert.ok(displayProfile({width:1920,height:1080,dpr:2}).pixelRatio>1.4,'denser than the old CSS-only drawing');
});
test('browser zoom / OS scaling is not applied twice to the UI and map name sizes never auto-shrink',()=>{
  assert.equal(displayProfile({width:3840,height:2160,dpr:1}).labelPercent,120);
  assert.equal(displayProfile({width:1920,height:1080,dpr:2}).labelPercent,110);
  assert.equal(displayProfile({width:960,height:540,dpr:4}).labelPercent,100);
  assert.equal(displayProfile({width:800,height:600,dpr:.8}).textScale,1);
});
test('invalid metrics and old preference values are safe and do not become zero-sized buffers',()=>{
  for(const input of [{},{width:0,height:NaN,dpr:-1},{width:Infinity,height:-1,dpr:'no'}]){
    const p=displayProfile(input,{mode:'obsolete',tier:'unknown'});
    assert.equal(p.mode,'auto');assert.ok(Number.isFinite(p.pixelRatio));assert.ok(p.renderWidth>0);
  }
});
test('old GPU allocation limits also bound a wide sharp-mode drawing buffer without reading GPU identity',()=>{
  const gl={MAX_RENDERBUFFER_SIZE:1,MAX_TEXTURE_SIZE:2,getParameter:key=>key===1?4096:8192};
  const maxDimension=drawingBufferLimit({getContext:()=>gl});assert.equal(maxDimension,4096);
  const p=displayProfile({width:7680,height:2160,dpr:2},{mode:'sharp',maxDimension});
  assert.equal(p.renderWidth,4096);assert.ok(p.renderHeight<=4096);
  assert.equal(drawingBufferLimit({getContext(){throw Error('lost');}}),8192);
  assert.equal(drawingBufferLimit({}),8192);
});
test('cadence choices use enough visible frames, not a lone hitch or missing measurement',()=>{
  assert.equal(cadenceTier({status:'measured',samples:30,p50Ms:16,p75Ms:18}),'fast');
  assert.equal(cadenceTier({status:'measured',samples:30,p50Ms:33,p75Ms:34}),'balanced');
  assert.equal(cadenceTier({status:'measured',samples:30,p50Ms:45,p75Ms:60}),'constrained');
  assert.equal(cadenceTier({status:'measured',samples:3,p50Ms:60,p75Ms:60}),'balanced');
  assert.equal(cadenceTier({status:'unavailable',samples:30,p50Ms:60,p75Ms:60}),'balanced');
});

function cadenceHarness({hidden=false,signal}={}) {
  const listeners=new Set(),timers=new Map(),document=new EventTarget();document.hidden=hidden;
  let time=0,id=0;
  const scene={postRender:{addEventListener(fn){listeners.add(fn);return ()=>listeners.delete(fn);}},requestRender(){}};
  const pending=sampleRenderCadence(scene,{signal,document,now:()=>time,
    setTimer(fn){timers.set(++id,fn);return id;},clearTimer(id){timers.delete(id);}});
  return {pending,listeners,timers,document,frame(dt=16.67){time+=dt;for(const fn of [...listeners])fn();},
    expire(){for(const fn of [...timers.values()])fn();}};
}
test('short post-render warmup measures cadence and releases every subscription/timer',async()=>{
  const h=cadenceHarness();for(let i=0;i<6;i++)h.frame(80);
  for(let i=0;i<50;i++)h.frame(16.67);
  const result=await h.pending;assert.equal(result.status,'measured');near(result.p50Ms,16.67);
  assert.equal(cadenceTier(result),'fast');assert.equal(h.listeners.size,0);assert.equal(h.timers.size,0);
});
test('a slower display is never handed a bigger budget than a faster one',async()=>{
  // Measured before this was fixed: 14 fps was graded cheap, 12 fps was graded
  // balanced and told to draw twice the pixels, and at 8 fps every frame was
  // discarded as noise so nothing was graded at all. The grade has to fall as
  // the display slows, or the machines least able to pay get the larger bill.
  // 1800 ms is the sampler's own window, so how many frames fit in it is part
  // of what is being tested here.
  const graded=[];
  for(const fps of [60,40,30,20,16,14,12,10,8,6]){
    const gap=1000/fps,h=cadenceHarness();
    for(let i=0;i*gap<1800;i++)h.frame(gap);
    h.expire();
    const tier=cadenceTier(await h.pending);
    graded.push({fps,tier,pixels:(p=>p.renderWidth*p.renderHeight)(displayProfile(
      {width:3440,height:1384,dpr:1},{mode:'auto',tier}))});
  }
  for(const [faster,slower] of graded.slice(0,-1).map((x,i)=>[x,graded[i+1]]))
    assert.ok(slower.pixels<=faster.pixels,
      `${slower.fps} fps was given ${slower.pixels} pixels while ${faster.fps} fps was given ${faster.pixels}`);
  for(const row of graded)
    if(row.fps<=20)assert.equal(row.tier,'constrained',`${row.fps} fps must get the cheap budget`);
  assert.equal(graded[0].tier,'fast','a display that is genuinely quick still earns the large budget');
});

test('throttled / empty / hidden tabs fall back without being classified as a weak GPU',async()=>{
  for(const gap of [1000,0]){
    const h=cadenceHarness();for(let i=0;i<10;i++)h.frame(gap);h.expire();
    const r=await h.pending;assert.equal(r.status,'unavailable');assert.equal(cadenceTier(r),'balanced');
  }
  const hidden=cadenceHarness({hidden:true});assert.equal((await hidden.pending).status,'hidden');
  assert.equal(hidden.listeners.size,0);assert.equal(hidden.timers.size,0);
  const h=cadenceHarness();h.frame();h.document.hidden=true;h.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal((await h.pending).status,'hidden');assert.equal(h.timers.size,0);
});
test('isolated shader stalls do not bias the median, and cancellation cleans up even before sampling',async()=>{
  const h=cadenceHarness();for(let i=0;i<6;i++)h.frame();h.frame(110);h.frame(1500);
  for(let i=0;i<45;i++)h.frame();assert.equal(cadenceTier(await h.pending),'fast');
  for(const initially of [false,true]){
    const controller=new AbortController();if(initially)controller.abort();
    const h=cadenceHarness({signal:controller.signal});controller.abort();
    assert.equal((await h.pending).status,'cancelled');assert.equal(h.listeners.size,0);assert.equal(h.timers.size,0);
  }
});

function resolutionHarness(options={}) {
  const environment=new EventTarget(),document=new EventTarget(),timers=new Map(),queries=[];let id=0,observer;
  Object.assign(environment,{document,innerWidth:1920,innerHeight:1080,devicePixelRatio:2,
    setTimeout(fn){timers.set(++id,fn);return id;},clearTimeout(id){timers.delete(id);},
    matchMedia(){const query=new EventTarget();queries.push(query);return query;},
    ResizeObserver:class {constructor(fn){observer=this;this.fn=fn;}observe(){}disconnect(){this.disconnected=true;}}});
  let writes=0,scale=1;
  let samples=0;
  const viewer={canvas:{clientWidth:1920,clientHeight:1080,style:{}},
    scene:{requestRender(){},get msaaSamples(){return this._m??4;},set msaaSamples(v){this._m=v;samples++;}},
    get resolutionScale(){return scale;},set resolutionScale(v){scale=v;writes++;}};
  const r=new DisplayResolution(viewer,{environment,...options});
  return {r,viewer,environment,timers,queries,get observer(){return observer;},get writes(){return writes;},
    get samples(){return samples;},
    flush(){for(const [id,fn] of [...timers]){timers.delete(id);fn();}}};
}
test('the grade sets how many samples each pixel costs, not just how many pixels',()=>{
  // Cesium defaults to four samples per pixel. A balanced budget of 4.19
  // million pixels is then 16.8 million samples in the opaque pass, paid by
  // displays already missing their frame target - while the airframe camera
  // had set its own widget to 1 all along. FXAA still runs for every grade, so
  // what a slower grade gives up is sub-pixel coverage, not aliased edges.
  const h=resolutionHarness();
  assert.equal(h.viewer.scene.msaaSamples,TIER_MSAA.balanced,'the starting grade sets it at once');
  for(const tier of ['constrained','fast','balanced']){
    h.r.tier=tier;h.r.refresh();
    assert.equal(h.viewer.scene.msaaSamples,TIER_MSAA[tier],`${tier} keeps its own sample count`);
  }
  assert.ok(TIER_MSAA.constrained<TIER_MSAA.balanced&&TIER_MSAA.balanced<TIER_MSAA.fast,
    'a slower grade may never cost more samples than a faster one');
  // An operator who picked a budget by hand is not second-guessed by a grade.
  h.r.setMode('efficient');assert.equal(h.viewer.scene.msaaSamples,MODE_MSAA.efficient);
  h.r.setMode('sharp');assert.equal(h.viewer.scene.msaaSamples,MODE_MSAA.sharp);
  // Assigning it rebuilds the scene's framebuffers, so a refresh that changes
  // nothing must not touch it.
  const before=h.samples;for(let i=0;i<20;i++)h.r.refresh();assert.equal(h.samples,before);
});

test('motion is a multiplier of the calibrated base, with no repeated buffer reallocations at rest',()=>{
  const h=resolutionHarness();const base=h.r.profile.pixelRatio;
  h.r.applyMotion(.7);near(h.viewer.resolutionScale,base*.7);
  h.r.applyMotion(1);near(h.viewer.resolutionScale,base);assert.equal(h.viewer.useBrowserRecommendedResolution,true);
  assert.equal(h.viewer.canvas.style.imageRendering,'auto');
  const before=h.writes;for(let i=0;i<100;i++)h.r.applyMotion(1);assert.equal(h.writes,before);
  h.r.destroy();
});

test('explicit sharp mode restores full bounded resolution and stays sharp during navigation',()=>{
  const h=resolutionHarness();
  h.r.applyMotion(.7);
  h.r.setMode('sharp');near(h.viewer.resolutionScale,h.r.profile.pixelRatio);
  const writes=h.writes;
  for(const scale of [.6,.7,.85,1,.7])h.r.applyMotion(scale);
  assert.equal(h.writes,writes,'motion cannot repeatedly resize a sharp-mode buffer');
  near(h.viewer.resolutionScale,h.r.profile.pixelRatio);
  h.r.setMode('auto');near(h.viewer.resolutionScale,h.r.profile.pixelRatio*.7);
  h.r.setMode('efficient');near(h.viewer.resolutionScale,h.r.profile.pixelRatio*.7);
  h.r.destroy();
});
test('globe frames hand the transient budget to client resolution rather than overwriting it with one',()=>{
  const h=resolutionHarness();const g={entryActive:true,timing:{record(){},recentMs:16},viewer:h.viewer,
    renderBudget:{update:()=>1,moving:false},displayResolution:h.r};
  LiveGlobe.prototype.frame.call(g);near(h.viewer.resolutionScale,h.r.profile.pixelRatio);h.r.destroy();
});
test('resize, browser density changes and element resizing debounce and keep bounds, then teardown unsubscribes',()=>{
  const h=resolutionHarness();
  h.viewer.canvas.clientWidth=2560;h.viewer.canvas.clientHeight=1440;
  for(let i=0;i<20;i++)h.environment.dispatchEvent(new Event('resize'));
  assert.equal(h.timers.size,1);h.flush();assert.equal(h.r.profile.width,2560);
  h.environment.devicePixelRatio=1.25;h.queries.at(-1).dispatchEvent(new Event('change'));h.flush();
  assert.equal(h.r.profile.dpr,1.25);
  h.viewer.canvas.clientWidth=800;h.observer.fn();h.flush();assert.equal(h.r.profile.width,800);
  h.r.resize();h.r.destroy();assert.equal(h.timers.size,0);assert.equal(h.observer.disconnected,true);
  h.environment.dispatchEvent(new Event('resize'));h.environment.document.dispatchEvent(new Event('visibilitychange'));
  h.queries.at(-1).dispatchEvent(new Event('change'));assert.equal(h.timers.size,0);
});
test('a larger container is re-budgeted immediately, before delayed canvas resize and debounced labels',()=>{
  const updates=[];const h=resolutionHarness({onChange:p=>updates.push(p)});
  h.viewer.container={clientWidth:3840,clientHeight:2160};
  h.environment.dispatchEvent(new Event('resize'));
  assert.equal(h.r.profile.width,3840,'read the new container, not the canvas still at the old size');
  assert.ok(3840*2160*h.viewer.resolutionScale**2<=h.r.profile.budget+.001);
  assert.equal(updates.length,1,'text and readouts wait for resize to settle');
  h.flush();assert.equal(updates.length,2);assert.equal(updates.at(-1).width,3840);h.r.destroy();
});
test('actual sampling changes auto budget, but manual quality choices are retained and late samples cannot undo them',async()=>{
  let finish;
  const h=resolutionHarness({sample:()=>new Promise(r=>finish=r)});
  const pending=h.r.calibrate();finish({status:'measured',samples:40,p50Ms:16,p75Ms:18});await pending;
  assert.equal(h.r.tier,'fast');assert.equal(h.r.profile.budget,6291456);
  const late=h.r.calibrate();h.r.setMode('efficient');finish({status:'measured',samples:40,p50Ms:16,p75Ms:18});await late;
  assert.equal(h.r.mode,'efficient');assert.equal(h.r.profile.budget,2073600);
  const gone=h.r.calibrate();const profile=h.r.profile;h.r.destroy();finish({status:'measured',samples:40,p50Ms:16,p75Ms:18});
  await gone;assert.equal(h.r.profile,profile);
});
test('quality settings are browser-only, expose actual dimensions, and manual preferences survive a new view',async()=>{
  const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
  const document={...fakeDocument,documentElement:new FakeElement('html')},labels=[];
  const setting=displayQualitySetting({document,storage,applyLabels:p=>labels.push(p)});
  const h=resolutionHarness({sample:async()=>({status:'measured',samples:40,p50Ms:16,p75Ms:18})});
  setting.attach(h.r);assert.match(setting.status.textContent,/1920 × 1080 · 배율 200%/);
  assert.equal(values.size,0,'measurements are not stored');assert.equal(labels.at(-1),110);
  await setting.calibrate();assert.match(setting.status.textContent,/프레임 확인 완료/);
  setting.select.value='sharp';setting.select.onchange();assert.equal(values.get('aerodt.display-quality'),'sharp');
  assert.equal(h.r.profile.budget,8294400);assert.equal(document.documentElement.style['--display-text-scale'],'1.1');
  const next=displayQualitySetting({document,storage});assert.equal(next.select.value,'sharp');h.r.destroy();
});
test('a resized window cannot receive stale cadence from the previous resolution',async()=>{
  let finish;
  const h=resolutionHarness({sample:()=>new Promise(r=>finish=r)});
  const pending=h.r.calibrate();h.viewer.canvas.clientWidth=3840;h.r.resize();h.flush();
  finish({status:'measured',samples:40,p50Ms:16,p75Ms:18});await pending;
  assert.equal(h.r.profile.width,3840);assert.equal(h.r.tier,'balanced');assert.equal(h.r.result.status,'unavailable');
  h.r.destroy();h.observer.fn();assert.equal(h.timers.size,0,'late resize delivery after teardown is inert');
});
test('optional measurement failures fall back to a usable profile and external teardown cancels the sample',async()=>{
  const h=resolutionHarness({sample:async()=>{throw Error('measurement unavailable');}});
  const profile=await h.r.calibrate();assert.ok(profile.renderWidth>0);assert.equal(h.r.result.status,'unavailable');h.r.destroy();
  let aborted=false;
  const other=resolutionHarness({sample:(_scene,{signal})=>new Promise(resolve=>{
    signal.addEventListener('abort',()=>{aborted=true;resolve({status:'cancelled',samples:0});});
  })});
  const controller=new AbortController(),pending=other.r.calibrate({signal:controller.signal});controller.abort();await pending;
  assert.equal(aborted,true);other.r.destroy();
});
test('blocked storage and invalid settings do not prevent startup',()=>{
  for(const storage of [{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}}, {getItem:()=> 'obsolete'}]){
    const setting=displayQualitySetting({document:fakeDocument,storage});assert.equal(setting.select.value,'auto');
    setting.select.value='efficient';assert.doesNotThrow(()=>setting.select.onchange());
  }
});
test('startup really waits for display preparation before releasing the intro, not a fake loading delay',()=>{
  const root=new URL('../../../../',import.meta.url);
  const app=readFileSync(new URL('user_application/web/app.js',root),'utf8');
  assert.match(app,/displayQuality.attach\(globe.displayResolution\)/);
  assert.match(app,/display:10/);
  assert.ok(app.indexOf('await displayQuality.calibrate')<app.indexOf('await globe.waitForInitialView'));
  assert.ok(app.indexOf('await globe.waitForInitialView')<app.indexOf("report('globe'"));
  assert.equal((app.match(/await globe\.waitForInitialView/g)||[]).length,1,'one readiness gate follows the final buffer resize');
  assert.ok(app.indexOf('await displayQuality.calibrate')<app.indexOf('loadingScreen.finish('));
  assert.match(app,/applyLabels:percent=>mapLabelSetting.recommend\(percent\)/);
  const source=readFileSync(new URL('digital_twin/visualization/web/display_resolution.js',root),'utf8');
  assert.doesNotMatch(source,/fetch\(|localStorage|hardwareConcurrency|deviceMemory|WEBGL_debug_renderer_info/);
});
