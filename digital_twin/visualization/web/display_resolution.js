// Per-view presentation only. No shared settings, simulation clock or GPU identity.
// Cesium is kept in CSS-pixel mode; our scale includes DPR exactly once. This
// bounds allocation even while a window is moved to a higher-density display.
const PIXELS={balanced:4194304,fast:6291456,constrained:2073600,sharp:8294400};
const MODES=new Set(['auto','sharp','efficient']);
export const displayMode=value=>MODES.has(value)?value:'auto';
const positive=(value,fallback)=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):fallback;

export function displayProfile({width=1920,height=1080,dpr=1}={}, {mode='auto',tier='balanced',maxDimension=8192}={}) {
  width=Math.max(1,Math.round(positive(width,1920)));height=Math.max(1,Math.round(positive(height,1080)));
  dpr=Math.min(4,Math.max(.5,positive(dpr,1)));mode=displayMode(mode);
  const budget=mode==='sharp'?PIXELS.sharp:mode==='efficient'?PIXELS.constrained:PIXELS[tier]??PIXELS.balanced;
  const limit=Math.min(8192,positive(maxDimension,8192));
  const pixelRatio=Math.min(dpr,2,Math.sqrt(budget/(width*height)),limit/Math.max(width,height));
  // CSS viewport, not device pixels: do not double-enlarge text already made
  // larger by Windows scaling / browser zoom, or infer physical monitor inches.
  const textScale=width>=2400&&height>=1100?1.2:width>=1800&&height>=900?1.1:1;
  return {mode,tier,width,height,dpr,pixelRatio,budget,
    renderWidth:Math.max(1,Math.floor(width*pixelRatio)),renderHeight:Math.max(1,Math.floor(height*pixelRatio)),
    textScale,labelPercent:Math.round(textScale*100)};
}

export function drawingBufferLimit(canvas) {
  try {
    // Reuse Cesium's context; never create a second canvas or query GPU names.
    const gl=canvas.getContext?.('webgl2')||canvas.getContext?.('webgl');
    if(gl)return Math.min(8192,positive(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),8192),
      positive(gl.getParameter(gl.MAX_TEXTURE_SIZE),8192));
  } catch {} // Context loss is reported by the viewer, not an optional profile.
  return 8192;
}

// Which grades are cheaper than which, and how long live frames have to
// disagree with the grade in hand before it is lowered.
const TIER_RANK={constrained:0,balanced:1,fast:2};
const REGRADE_AFTER_MS=6000;
// A frame gap past this is a tab that stopped being drawn, not a slow one.
const GAP_CEILING_MS=400;
// How many samples each of those pixels costs. Cesium 1.143 defaults to four,
// so a balanced budget of 4.19 million pixels was being drawn as 16.8 million
// samples in the opaque pass - on displays that were already missing their
// frame target. The airframe camera set this to 1 for its own 576x288 widget
// (airframe_camera.js) and the map, with twenty-five times the pixels, went on
// paying four. FXAA still smooths edges for every tier at a fraction of that,
// so what a slower grade gives up is sub-pixel geometry coverage, not aliased
// edges. A display graded fast keeps all four: it can afford them.
export const TIER_MSAA={constrained:1,balanced:2,fast:4};
export const MODE_MSAA={sharp:4,efficient:1};

// How few frames still settle it. A slow display needs far less evidence than
// a fast one: four frames that each took 80 ms already prove the budget is too
// high, while calling a display fast on four frames would raise its cost on a
// guess. Asking both verdicts for twenty was measured handing the MIDDLE budget
// to the machines least able to pay it - 14 fps was graded cheap, 12 fps was
// graded balanced and drew twice the pixels, and below 8 fps every frame was
// discarded as noise and nothing was graded at all. Too few frames in the
// window is itself the slow signal, not a reason to ignore the window.
export const SLOW_SAMPLES=4,FAST_SAMPLES=20;
export function cadenceTier({status,samples,p50Ms,p75Ms}={}) {
  if(status!=='measured'||!Number.isFinite(p50Ms)||!Number.isFinite(p75Ms))return 'balanced';
  if(samples>=SLOW_SAMPLES&&p50Ms>=38&&p75Ms>=42)return 'constrained';
  if(samples<FAST_SAMPLES)return 'balanced';
  return p50Ms<=22&&p75Ms<=28?'fast':'balanced';
}

// A bounded initial-view cadence check, NOT a GPU benchmark / future FPS promise.
// Ignore warmup frames and background-sized gaps. A throttled tab must not be
// mistaken for a weak GPU, and cannot hold the loading screen indefinitely.
export function sampleRenderCadence(scene,{signal,document=globalThis.document,now=()=>performance.now(),
  setTimer=setTimeout,clearTimer=clearTimeout,timeoutMs=1800}={}) {
  return new Promise(resolve=>{
    const values=[];let previous=null,warmup=6,elapsed=0,done=false,remove,timer;
    const finish=status=>{
      if(done)return;done=true;remove?.();clearTimer(timer);
      signal?.removeEventListener('abort',abort);document?.removeEventListener('visibilitychange',visibility);
      values.sort((a,b)=>a-b);
      resolve({status,samples:values.length,p50Ms:values.length?values[Math.floor((values.length-1)*.5)]:null,
        p75Ms:values.length?values[Math.floor((values.length-1)*.75)]:null});
    };
    const abort=()=>finish('cancelled'),visibility=()=>{if(document?.hidden)finish('hidden');};
    if(signal?.aborted){abort();return;}
    if(document?.hidden){finish('hidden');return;}
    signal?.addEventListener('abort',abort,{once:true});document?.addEventListener('visibilitychange',visibility);
    remove=scene.postRender.addEventListener(()=>{
      if(done)return;
      if(document?.hidden){finish('hidden');return;}
      const time=now(),dt=previous===null?0:time-previous;previous=time;
      // The ceiling separates a slow display from a throttled tab, and it used
      // to be 120 ms - inside the range a struggling display actually delivers,
      // so an 8 fps machine had every one of its frames thrown away and was
      // then graded on nothing. A backgrounded tab is caught by `document.hidden`
      // above and by gaps far longer than this.
      if(warmup-->0||dt<4||dt>GAP_CEILING_MS)return;
      values.push(dt);elapsed+=dt;
      if(values.length>=FAST_SAMPLES&&elapsed>=700)finish('measured');
    });
    // Out of time. What was collected is the answer - a window that produced
    // only a handful of frames is describing a display, not failing to measure
    // one. Below SLOW_SAMPLES there is genuinely nothing to read.
    timer=setTimer(()=>finish(values.length>=SLOW_SAMPLES?'measured':'unavailable'),timeoutMs);
    scene.requestRender();
  });
}

export class DisplayResolution {
  constructor(viewer,{environment=globalThis,mode='auto',onChange=()=>{},sample=sampleRenderCadence}={}) {
    this.viewer=viewer;this.environment=environment;this.mode=displayMode(mode);this.tier='balanced';
    this.maxDimension=drawingBufferLimit(viewer.canvas);
    // Cesium's pixelated upscaler makes fractional browser zoom and temporary
    // motion resolution look blocky. Let the compositor interpolate instead.
    if(viewer.canvas.style)viewer.canvas.style.imageRendering='auto';
    this.onChange=onChange;this.sample=sample;this.motionScale=1;this.revision=0;this.slowSince=null;
    this.result={status:'pending',samples:0};
    this.resize=()=>{
      if(this.disposed)return;
      // Re-budget before the next resize can multiply the old ratio by a new
      // 4K viewport. Only the readout / label layout is debounced, not the cap.
      this.refresh({notify:false});
      environment.clearTimeout(this.resizeTimer);
      this.resizeTimer=environment.setTimeout(()=>{if(!this.disposed)this.refresh();},200);
    };
    this.visibility=()=>{if(!environment.document?.hidden)this.resize();};
    environment.addEventListener?.('resize',this.resize);
    environment.document?.addEventListener('visibilitychange',this.visibility);
    if(environment.ResizeObserver){this.observer=new environment.ResizeObserver(this.resize);this.observer.observe(viewer.container??viewer.canvas);}
    this.watchDensity();this.refresh();
  }
  watchDensity() {
    this.densityQuery?.removeEventListener?.('change',this.densityChanged);
    this.densityChanged=()=>{this.watchDensity();this.resize();};
    this.densityQuery=this.environment.matchMedia?.(`(resolution: ${this.environment.devicePixelRatio||1}dppx)`);
    this.densityQuery?.addEventListener?.('change',this.densityChanged);
  }
  refresh({notify=true}={}) {
    if(this.disposed)return;
    const e=this.environment,c=this.viewer.container??this.viewer.canvas;
    const profile=displayProfile({width:c.clientWidth||e.innerWidth,height:c.clientHeight||e.innerHeight,dpr:e.devicePixelRatio},
      {mode:this.mode,tier:this.tier,maxDimension:this.maxDimension});
    // A resize during the brief sample changes the workload. Do not grade the
    // new display with frames collected at the old dimensions.
    if(this.profile&&this.calibration&&['width','height','dpr'].some(key=>this.profile[key]!==profile[key])){
      this.revision++;this.calibration.abort();this.result={status:'unavailable',samples:0};
    }
    this.profile=profile;
    this.applySamples();
    this.applyMotion(this.motionScale);if(notify)this.onChange(this.profile,this.result);
  }
  // Samples per pixel for the grade in hand. Assigning this rebuilds the
  // scene's framebuffers, so it is written only when it actually changes.
  applySamples() {
    const scene=this.viewer?.scene;if(!scene||!('msaaSamples' in scene))return;
    const wanted=MODE_MSAA[this.mode]??TIER_MSAA[this.tier]??TIER_MSAA.balanced;
    if(scene.msaaSamples!==wanted){scene.msaaSamples=wanted;scene.requestRender?.();}
  }
  setMode(value) {
    this.revision++;this.calibration?.abort();this.mode=displayMode(value);
    if(this.result.status==='sampling')this.result={status:'unavailable',samples:0};
    this.refresh();
  }
  applyMotion(value=1) {
    if(this.disposed)return;
    this.motionScale=Number.isFinite(value)?Math.min(1,Math.max(.5,value)):1;
    // An explicit sharp-mode choice must not silently inherit a reduced motion
    // scale (which can remain low at rest when the bottleneck is not pixels).
    // Auto/efficient keep their existing adaptive budget. Allocation limits in
    // displayProfile still apply in sharp mode, including on HiDPI displays.
    const scale=(this.profile?.pixelRatio??1)*(this.mode==='sharp'?1:this.motionScale),v=this.viewer;
    // Keep CSS controls / font sizes untouched. Only the WebGL drawing buffer
    // is cheaper during navigation, then returns to this client's sharp base.
    if(v.useBrowserRecommendedResolution!==true)v.useBrowserRecommendedResolution=true;
    if(Math.abs(v.resolutionScale-scale)>1e-6){v.resolutionScale=scale;v.scene.requestRender();}
  }
  // What the live frames say about the grade the startup sample handed out.
  //
  // That sample runs on the first view: an almost empty globe, before the city,
  // the fleet or a deck exists. A display that looked quick there keeps its
  // budget for the whole session however heavy the scene becomes, which is how
  // an ultrawide ends up drawing every one of its 4.95 million pixels at ten
  // frames a second -- the grade is measured once and the work grows after it.
  //
  // Live frames may only lower the grade, never raise it. Raising it from a
  // quiet moment would put the cost straight back and oscillate; 다시 맞추기 is
  // how a display asks to be graded again. `mode` other than auto is the
  // operator's own choice of budget and is not second-guessed here.
  observe({p50Ms, p75Ms, samples = 0, now = 0} = {}) {
    if(this.disposed||this.mode!=='auto'||this.result.status==='sampling')return this.tier;
    const graded=cadenceTier({status:'measured',samples,p50Ms,p75Ms});
    if(!(samples>=20&&TIER_RANK[graded]<TIER_RANK[this.tier])){this.slowSince=null;return this.tier;}
    // Long enough that a building batch or a shader link cannot re-grade a
    // display; short enough that nobody sits through a minute of it.
    this.slowSince??=now;
    if(now-this.slowSince<REGRADE_AFTER_MS)return this.tier;
    this.slowSince=null;this.tier=graded;
    this.result={...this.result,tier:graded,regraded:true};
    this.refresh();
    return this.tier;
  }
  async calibrate({signal}={}) {
    if(this.disposed||signal?.aborted)return this.profile;
    this.calibration?.abort();const controller=new AbortController();this.calibration=controller;
    const revision=++this.revision,abort=()=>controller.abort();
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    // Sample the same bounded baseline every time, not the previous reduced
    // result (which would oscillate between sharp and efficient on each retry).
    this.tier='balanced';this.result={status:'sampling',samples:0};this.refresh();
    try {
      const result=await this.sample(this.viewer.scene,{signal:controller.signal,document:this.environment.document});
      if(this.disposed||revision!==this.revision||controller.signal.aborted)return this.profile;
      this.result=result;this.tier=cadenceTier(result);this.refresh();return this.profile;
    } catch {
      // Optional calibration must not turn a working map into a failed boot.
      if(!this.disposed&&revision===this.revision){
        this.result={status:'unavailable',samples:0};this.tier='balanced';this.refresh();
      }
      return this.profile;
    } finally {
      signal?.removeEventListener('abort',abort);
      if(this.calibration===controller)this.calibration=null;
    }
  }
  destroy() {
    this.disposed=true;this.revision++;this.calibration?.abort();this.observer?.disconnect();
    this.environment.clearTimeout(this.resizeTimer);this.environment.removeEventListener?.('resize',this.resize);
    this.environment.document?.removeEventListener('visibilitychange',this.visibility);
    this.densityQuery?.removeEventListener?.('change',this.densityChanged);
  }
}
