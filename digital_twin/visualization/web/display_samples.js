// Display-only, bounded interpolation between Live Twin states. The runtime
// owns motion; this layer only owns display timing. No velocity extrapolation
// or orbit propagation: a display never runs ahead of the newest sample.
import {PhysicalPlayback} from './physical_playback.js';
import {surfaceRates,interpolateSurfaceAngles,validSurfaceAngles} from './control_surface_pose.js';
const WINDOW=12,STRIDE=9;
const PLAYBACK_WINDOW=48;

// Per-entity ring of recent samples: time, x, y, z, ground-track heading.
class SampleRing {
  constructor(capacity){this.capacity=capacity;this.data=new Float64Array(capacity*STRIDE);this.count=0;this.head=0;this.renderT=-Infinity;this.renderedAt=0;this.entity=null;this.seen=0;}
  slot(newestOffset){return (this.head-newestOffset+this.capacity)%this.capacity;}
  time(newestOffset){return this.data[this.slot(newestOffset)*STRIDE];}
  push(t,position,heading,reset,entity) {
    if(reset)this.count=0;
    if(this.count && t<=this.data[this.head*STRIDE]) { /* equal or older time replaces the newest */ }
    else {this.head=this.count?(this.head+1)%this.capacity:0;this.count=Math.min(this.capacity,this.count+1);}
    const base=this.head*STRIDE;this.data[base]=t;this.data[base+1]=position[0];this.data[base+2]=position[1];this.data[base+3]=position[2];this.data[base+4]=heading;
    for(const [i,key] of ['pitch_deg','roll_deg','tilt_deg','rotor_radps'].entries()){
      const missing=entity?.source==='physical_uam' && i>=2?NaN:0;
      this.data[base+5+i]=entity?.[key] ?? missing;
    }
    if(entity?.kind==='uam' && (entity.source==='scenario' || entity.display_observation)){
      this.velocities ??= new Float64Array(this.capacity*3).fill(NaN);
      for(let k=0;k<3;k++)this.velocities[this.head*3+k]=entity.velocity_ecef_mps?.[k] ?? NaN;
    }
    // Keep the datum at the same time as the position, not the latest packet's
    // phase: at high playback speed those can be seconds apart. Only scenario
    // streams with a deck datum allocate this small parallel ring.
    if(entity?.surface_reference || this.surfaces){
      this.surfaces ??= new Array(this.capacity);
      this.surfaces[this.head]=entity?.surface_reference ?? null;
    }
    if(entity?.display_observation){this.utcTimes ??= new Float64Array(this.capacity);this.utcTimes[this.head]=entity.display_observation.observation_time;}
    if(validSurfaceAngles(entity?.control_surface_deg)||this.controlAngles){
      this.controlAngles??=new Array(this.capacity);
      this.controlAngles[this.head]=validSurfaceAngles(entity?.control_surface_deg)?entity.control_surface_deg.slice():null;
    }
    if(reset)this.renderT=t;
  }
  // Newest offset i such that time(i+1) <= t <= time(i); -1 clamps to newest, count-1 to oldest.
  locate(t) {
    if(!this.count)return null;
    if(!(t<this.time(0)))return {i:0,f:0};
    for(let i=0;i<this.count-1;i++){const a=this.time(i+1),b=this.time(i);if(t>=a)return {i:i+1,f:b>a?(t-a)/(b-a):0};}
    return {i:this.count-1,f:0};
  }
  positionAt(t,result) {
    const at=this.locate(t);if(!at)return null;
    const a=this.slot(at.i)*STRIDE,b=this.slot(Math.max(0,at.i-1))*STRIDE,f=at.f;
    for(let k=1;k<=3;k++){
      const start=this.data[a+k],delta=this.data[b+k]-start;
      result[k-1]=start+delta*f;
      if(!this.velocities || !(f>0 && f<1))continue;
      const dt=this.data[b]-this.data[a];
      const va=this.velocities[this.slot(at.i)*3+k-1],vb=this.velocities[this.slot(Math.max(0,at.i-1))*3+k-1];
      if(!Number.isFinite(va) || !Number.isFinite(vb) || Math.abs(delta)<1e-9)continue;
      // Bounded Hermite reconstruction BETWEEN two actual native states.
      // Limit slopes so bad telemetry cannot overshoot either endpoint.
      let ma=Math.max(0,va*dt/delta),mb=Math.max(0,vb*dt/delta);
      const length=Math.hypot(ma,mb);if(length>3){ma*=3/length;mb*=3/length;}
      result[k-1]=start+delta*((-2*f+3)*f*f+(f*f*f-2*f*f+f)*ma+(f*f*f-f*f)*mb);
    }
    return result;
  }
  telemetryAt(t,result={}) {
    const at=this.locate(t);if(!at)return result;
    const a=this.slot(at.i)*STRIDE,b=this.slot(Math.max(0,at.i-1))*STRIDE;
    for(const [i,key] of ['pitch_deg','roll_deg','tilt_deg','rotor_radps'].entries()){
      const start=this.data[a+5+i],end=this.data[b+5+i];
      const delta=i<2?((end-start+540)%360)-180:end-start;
      result[key]=start+delta*at.f;
    }
    return result;
  }
  controlSurfaceAt(t,result={}) {
    this.telemetryAt(t,result);
    const at=this.locate(t);
    result.control_surface_deg=at?interpolateSurfaceAngles(this.controlAngles?.[this.slot(at.i)],this.controlAngles?.[this.slot(Math.max(0,at.i-1))],at.f):null;
    const older=at?Math.min(Math.max(1,at.i),this.count-1):0;
    const a=this.slot(older)*STRIDE,b=this.slot(Math.max(0,older-1))*STRIDE;
    const dt=this.count>1?this.data[b]-this.data[a]:0;
    const pose=base=>({heading_deg:this.data[base+4],pitch_deg:this.data[base+5],roll_deg:this.data[base+6]});
    surfaceRates(pose(a),pose(b),dt,result);
    // Position and attitude must describe the SAME buffered observation pair.
    result.speed_mps=dt>0?Math.hypot(...[1,2,3].map(k=>this.data[b+k]-this.data[a+k]))/dt:0;
    return result;
  }
  headingAt(t) {
    const at=this.locate(t);if(!at)return NaN;
    const a=this.data[this.slot(at.i)*STRIDE+4],b=this.data[this.slot(Math.max(0,at.i-1))*STRIDE+4];
    if(!Number.isFinite(a))return b;if(!Number.isFinite(b) || at.f===0)return a;
    const delta=((b-a+540)%360)-180;return ((a+delta*at.f)%360+360)%360;
  }
  surfaceAt(t,result={}) {
    const at=this.surfaces?this.locate(t):null;
    result.from=at?this.surfaces[this.slot(at.i)] ?? null:null;
    result.to=at?this.surfaces[this.slot(Math.max(0,at.i-1))] ?? null:null;
    result.fraction=at?.f ?? 0;
    return result;
  }
}
// How long a stream may be refused as out of order before it is taken as the
// twin's new clock. Long enough that ordinary reordering never reaches it.
const STALL_MS=3000;
const headingOf=entity=>['ground_track','attitude'].includes(entity.orientation_source) && Number.isFinite(entity.heading_deg)?entity.heading_deg:NaN;

export class DisplaySamples {
  constructor({capacity=6,minBufferMs=500,maxBufferMs=5000,marginMs=250,maxGapSeconds=10,catchUpRate=2}={}) {
    Object.assign(this,{capacity,minBufferMs,maxBufferMs,marginMs,maxGapSeconds,catchUpRate});
    this.entries=new Map();this.sourceClocks=new Map();this.sequence=-1;this.stateTime=-Infinity;this.generation=0;this.epoch=0;
    // Recent arrivals: state time (s) and arrival lag (ms) estimate the server
    // clock offset plus transport delay and the jitter the buffer must cover.
    this.windowTimes=new Float64Array(WINDOW);this.windowLags=new Float64Array(WINDOW);this.windowCount=0;this.windowHead=0;
    this.lagMs=0;this.bufferMs=minBufferMs;this.breaks=0;
    this.clockRate=1;this.lastMovingRate=1;
    this.clockT=-Infinity;this.clockAt=0;
    // When the first of a run of refusals arrived, so a stream that is refused
    // for longer than a few seconds can be taken at its word instead.
    this.refusedAt=null;
  }
  // Drop one entity's history. Used when a caller knows the twin is no longer
  // showing it, so nothing can interpolate it back onto the map.
  forget(id){return this.entries.delete(id);}
  replace(snapshot,receivedMs) {
    // The twin's clock was deliberately moved — a scheduled day was put on the
    // map, or handed back. That is not the clock slipping, so the older time is
    // accepted, and everything anchored to the old one is dropped rather than
    // interpolated across a jump of days.
    const epoch=snapshot.epoch ?? 0;
    const rebased=epoch!==this.epoch;
    const late=!rebased && (snapshot.state_time<this.stateTime || (snapshot.sequence<=this.sequence && snapshot.state_time<=this.stateTime));
    if(late) {
      // One packet out of order is a packet out of order. Seconds of them are
      // not: the twin's clock has moved and this is now the only stream there
      // is. Refusing it for ever would leave the map showing a world that has
      // gone, with nothing on screen saying so - which is what a frozen map
      // looks like from the operator's chair.
      this.refusedAt ??= receivedMs;
      if(receivedMs-this.refusedAt<STALL_MS)return false;
    }
    this.refusedAt=null;
    const t=snapshot.state_time,generation=++this.generation;
    const rate=Number.isFinite(snapshot.clock_rate)?Math.max(0,Math.min(100,snapshot.clock_rate)):1;
    this.hasClockRate=Number.isFinite(snapshot.clock_rate);
    const rateChanged=rate!==this.clockRate;
    if(rateChanged){
      this.windowCount=0; // New clock slope, not a discontinuity in position.
      this.transitionRate=Math.max(this.clockRate,rate,this.lastMovingRate);
      this.transitionUntil=receivedMs+1000;
    }
    this.clockRate=rate;if(rate>0)this.lastMovingRate=rate;
    this.scenarioStream=this.hasClockRate && snapshot.entities.some(entity=>entity.kind==='uam' && entity.source==='scenario');
    const normalized=t/(rate || this.lastMovingRate);
    // A long silence (hidden tab, server restart) resynchronizes; sweeping
    // across minutes of motion would misrepresent the twin.
    const broken=rebased || late || (this.windowCount>0 && normalized-this.windowTimes[(this.windowHead+WINDOW-1)%WINDOW]>this.maxGapSeconds);
    if(broken){this.windowCount=0;this.breaks++;this.clockT=t;this.clockAt=receivedMs;}
    if(broken || rateChanged)this.sourceClocks.clear();
    this.observe(normalized,receivedMs);
    if(this.scenarioStream)this.observePlayback(t,receivedMs,broken,rateChanged);
    else this.playback=null;
    for(const entity of snapshot.entities) {
      const observed=entity.source==='physical_uam'?entity.display_observation:null;
      if(observed && Number.isFinite(observed.time) && Number.isFinite(observed.observation_time)
        && ['physical','utc'].includes(observed.clock) && typeof observed.context==='string'
        && Array.isArray(observed.position_ecef_m) && observed.position_ecef_m.length===3 && observed.position_ecef_m.every(Number.isFinite)){
        let sample=this.entries.get(entity.entity_id);
        if(!sample || !sample.physical){sample=new SampleRing(Math.max(64,this.capacity));this.entries.set(entity.entity_id,sample);}
        const fresh=!sample.count || observed.time>sample.time(0);
        const changed=sample.context!==observed.context || sample.physical?.clock!==observed.clock;
        const restart=broken || changed || !sample.physical || (fresh && (receivedMs-sample.physical.last>10000 || observed.time-sample.time(0)>this.maxGapSeconds));
        if(fresh || restart){
          const pose={...entity,...observed,orientation_source:observed.heading_deg==null?'unavailable':'attitude'};
          sample.push(observed.time,observed.position_ecef_m,headingOf(pose),restart,pose);
          if(restart){sample.physical=new PhysicalPlayback(observed.time,receivedMs,observed.clock);sample.renderT=observed.time;}
          else sample.physical.observe(observed.time,receivedMs);
          sample.context=observed.context;
        }
        // Clock calibration may translate UTC while the accepted physical
        // observation remains identical. Retiming its existing slot cannot
        // make it a new fix or change the monotonic playback cursor.
        if(!fresh && !restart && observed.time===sample.time(0) && sample.utcTimes){
          const delta=observed.observation_time-sample.utcTimes[sample.head];
          if(Number.isFinite(delta) && delta)for(let i=0;i<sample.count;i++)sample.utcTimes[sample.slot(i)]+=delta;
        }
        sample.entity=entity;sample.seen=generation;sample.clock=null;continue;
      }
      const p=entity.position_ecef_m;
      if(!Array.isArray(p) || p.length!==3 || !p.every(Number.isFinite))continue;
      let sample=this.entries.get(entity.entity_id);
      if(!sample){sample=new SampleRing(entity.source==='scenario'?Math.max(32,this.capacity):this.capacity);this.entries.set(entity.entity_id,sample);}
      const reset=broken || Boolean(entity.discontinuity) || Boolean(sample.entity && (sample.entity.continuity_id ?? 0)!==(entity.continuity_id ?? 0));
      // Background states are reused while Physical publishes at 10 Hz. The
      // enclosing world's time is NOT a new aircraft/orbit state. Buffer the
      // source cadence separately so a fast feed cannot empty its history.
      const background=!this.hasClockRate && ['aircraft','satellite'].includes(entity.kind) && Number.isFinite(entity.state_time);
      const sampleTime=background?Math.min(t,entity.state_time):t;
      const sourceBroken=background && sample.count>0 && sampleTime-sample.time(0)>this.maxGapSeconds;
      sample.clock=null;
      if(background){
        let clock=this.sourceClocks.get(entity.source);
        if(!clock){
          clock={windowTimes:new Float64Array(WINDOW),windowLags:new Float64Array(WINDOW),
            windowCount:0,windowHead:0,lagMs:0,bufferMs:this.minBufferMs,lastTime:-Infinity};
          this.sourceClocks.set(entity.source,clock);
        }
        if(sampleTime>clock.lastTime){
          if(sampleTime-clock.lastTime>this.maxGapSeconds)clock.windowCount=0;
          this.observe(sampleTime,receivedMs,clock);clock.lastTime=sampleTime;
        }
        sample.clock=clock;
      }
      // A repeated discontinuity flag on a held state must not reset each frame.
      const fresh=!sample.count || sampleTime>sample.time(0);
      const changedContinuity=sample.entity && (sample.entity.continuity_id ?? 0)!==(entity.continuity_id ?? 0);
      if(!background || fresh || broken || changedContinuity)
        sample.push(sampleTime,p,headingOf(entity),reset || sourceBroken,entity);
      sample.entity=entity;sample.seen=generation;
    }
    for(const [id,sample] of this.entries)if(sample.seen!==generation)this.entries.delete(id);
    this.sequence=snapshot.sequence;this.stateTime=t;this.epoch=epoch;
    return true;
  }
  observe(t,receivedMs,clock=this) {
    clock.windowTimes[clock.windowHead]=t;clock.windowLags[clock.windowHead]=receivedMs-t*1000;
    clock.windowHead=(clock.windowHead+1)%WINDOW;clock.windowCount=Math.min(WINDOW,clock.windowCount+1);
    const start=(clock.windowHead-clock.windowCount+WINDOW)%WINDOW;
    let lagMin=Infinity,lagMax=-Infinity,gapMax=0,previous=NaN;
    for(let i=0;i<clock.windowCount;i++) {
      const j=(start+i)%WINDOW,lag=clock.windowLags[j];
      if(lag<lagMin)lagMin=lag;if(lag>lagMax)lagMax=lag;
      if(i>0)gapMax=Math.max(gapMax,clock.windowTimes[j]-previous);previous=clock.windowTimes[j];
    }
    // Enough to cover the worst recent interval plus arrival jitter, clamped so
    // the display delay is short and never accumulates.
    clock.lagMs=lagMin;
    const floor=(clock===this && this.scenarioStream)?Math.min(120,this.minBufferMs):this.minBufferMs;
    const margin=(clock===this && this.scenarioStream)?Math.min(40,this.marginMs):this.marginMs;
    clock.bufferMs=Math.min(this.maxBufferMs,Math.max(floor,gapMax*1000+(lagMax-lagMin)+margin));
  }
  observePlayback(t,now,reset,rateChanged) {
    // Requested speed is not necessarily delivered speed. Pace the DISPLAY
    // cursor from received states, without changing the simulation clock or
    // extrapolating positions. A shared cursor keeps camera/model/time aligned.
    if(!this.playback || reset)this.playback={times:new Float64Array(PLAYBACK_WINDOW),arrivals:new Float64Array(PLAYBACK_WINDOW),
      count:0,head:0,time:t,at:now,rate:this.clockRate,delayS:.14*this.clockRate};
    const p=this.playback;
    if(rateChanged){p.count=0;p.rate=this.clockRate;p.delayS=.14*this.clockRate;}
    const since=Math.max(0,(now-(p.received??now))/1000);
    p.times[p.head]=t;p.arrivals[p.head]=now;
    p.head=(p.head+1)%PLAYBACK_WINDOW;p.count=Math.min(PLAYBACK_WINDOW,p.count+1);
    p.latest=t;p.received=now;
    if(this.clockRate===0){p.rate=0;return;}
    const first=(p.head-p.count+PLAYBACK_WINDOW)%PLAYBACK_WINDOW;
    const elapsed=(now-p.arrivals[first])/1000;
    const measured=elapsed>0?Math.max(0,Math.min(this.clockRate,(t-p.times[first])/elapsed)):this.clockRate;
    // A short worst-case window used to change rate and reserve on every
    // packet, slowing even constant-speed taxiing by ~36% under 80 ms jitter.
    // Estimate sustained throughput, then low-pass it in wall time. Start-up
    // can adopt a slow producer quickly; steady transport must not pump speed.
    p.rate=p.count<=3?measured:p.rate+(1-Math.exp(-since/1.5))*(measured-p.rate);
    const gaps=[],lags=[];
    for(let i=0;i<p.count;i++){
      const j=(first+i)%PLAYBACK_WINDOW;
      if(i)gaps.push((p.arrivals[j]-p.arrivals[(j+PLAYBACK_WINDOW-1)%PLAYBACK_WINDOW])/1000);
      lags.push((p.arrivals[j]-p.arrivals[first])/1000-(p.times[j]-p.times[first])/Math.max(.001,p.rate));
    }
    gaps.sort((a,b)=>a-b);lags.sort((a,b)=>a-b);
    const quantile=(values,f)=>values[Math.floor((values.length-1)*f)]??0;
    const reserve=Math.min(this.maxBufferMs/1000,Math.max(.14,
      quantile(gaps,.9)+quantile(lags,.9)-quantile(lags,.1)+.04))*p.rate;
    const tau=reserve>p.delayS ? .5 : 3;
    p.delayS+=(1-Math.exp(-since/tau))*(reserve-p.delayS);
  }
  playbackTime(now) {
    const p=this.playback;
    if(this.clockRate===0){p.time=this.stateTime;p.at=now;return p.time;}
    const dt=Math.max(0,now-p.at)/1000;
    // Correct buffer occupancy gradually instead of re-anchoring the clock
    // every packet (which repeatedly held then raced to the newest sample).
    const target=p.latest+(now-p.received)/1000*p.rate-p.delayS;
    const error=target-(p.time+dt*p.rate);
    const correction=Math.max(-p.rate*.08,Math.min(p.rate*.08,error*.5));
    p.time=Math.max(p.time,Math.min(p.latest,p.time+dt*(p.rate+correction)));
    p.at=now;return p.time;
  }
  displayTime(nowMs){
    if(this.playback)return this.playbackTime(nowMs);
    return this.clockRate===0?this.stateTime:(nowMs-this.lagMs-this.bufferMs)/1000*this.clockRate;
  }
  clockTime(nowMs) {
    let t=Math.min(this.stateTime,this.displayTime(nowMs));
    if(Number.isFinite(this.clockT)){
      const rate=nowMs<this.transitionUntil?this.transitionRate:(this.clockRate || this.lastMovingRate);
      t=Math.max(this.clockT,Math.min(t,this.clockT+this.catchUpRate*rate*Math.max(0,nowMs-this.clockAt)/1000));
    }
    this.clockT=t;this.clockAt=nowMs;return t;
  }
  delaySeconds(nowMs){return Math.max(0,this.stateTime-this.displayTime(nowMs));}
  renderTime(id){const sample=this.entries.get(id);return sample && sample.count?(Number.isFinite(sample.renderT)?sample.renderT:sample.time(0)):NaN;}
  observationTime(id,t=this.renderTime(id)){
    const sample=this.entries.get(id);if(!sample?.utcTimes)return t;
    const at=sample.locate(t);if(!at)return t;
    const a=sample.utcTimes[sample.slot(at.i)],b=sample.utcTimes[sample.slot(Math.max(0,at.i-1))];return a+(b-a)*at.f;
  }
  physicalTiming(id){const sample=this.entries.get(id);return sample?.physical?{
    rate:sample.physical.rate,buffer_seconds:Math.max(0,(sample.time(0)-sample.renderT)/Math.max(.02,sample.physical.rate)),
    observation_time:this.observationTime(id)}:null;}
  position(id,nowMs,result=[0,0,0]) {
    const sample=this.entries.get(id);if(!sample || !sample.count)return null;
    if(sample.physical){
      const t=sample.physical.advance(nowMs,sample.time(0),sample.time(sample.count-1));
      sample.renderT=t;sample.renderedAt=nowMs;return sample.positionAt(t,result);
    }
    // Per-entity monotonic render time: a re-estimated clock or a late sample
    // may pause an object briefly but never moves it backwards, and after a
    // pause it catches up at a bounded rate instead of jumping.
    const displayTime=sample.clock?(nowMs-sample.clock.lagMs-sample.clock.bufferMs)/1000:this.displayTime(nowMs);
    let t=Math.min(displayTime,sample.time(0));
    if(Number.isFinite(sample.renderT)) {
      if(t<sample.renderT)t=sample.renderT;
      else {
        const rate=nowMs<this.transitionUntil?this.transitionRate:(this.clockRate || this.lastMovingRate);
        t=Math.min(t,sample.renderT+this.catchUpRate*rate*Math.max(0,nowMs-sample.renderedAt)/1000);
      }
    }
    sample.renderT=t;sample.renderedAt=nowMs;
    return sample.positionAt(t,result);
  }
  positionAt(id,stateTime,result=[0,0,0]){const sample=this.entries.get(id);return sample?sample.positionAt(stateTime,result):null;}
  heading(id,nowMs){const sample=this.entries.get(id);if(!sample || !sample.count)return NaN;const t=Number.isFinite(sample.renderT)?sample.renderT:Math.min(this.displayTime(nowMs),sample.time(0));return sample.headingAt(t);}
  telemetryAt(id,stateTime,result={}){return this.entries.get(id)?.telemetryAt(stateTime,result) ?? result;}
  controlSurfaceAt(id,stateTime,result={}){return this.entries.get(id)?.controlSurfaceAt(stateTime,result) ?? null;}
  surfaceAt(id,stateTime,result={}){return this.entries.get(id)?.surfaceAt(stateTime,result) ?? Object.assign(result,{from:null,to:null,fraction:0});}
  headingAt(id,stateTime){const sample=this.entries.get(id);return sample?sample.headingAt(stateTime):NaN;}
}
// Between a model and a dot there is a painted glyph. A model is its own draw
// call and only a couple of dozen can be afforded; a whole collection of glyphs
// is one draw call whatever the count. So the middle distance - too far to be
// worth a model, near enough that which way it is pointing matters - is drawn
// as a billboard rather than thrown away to a three-pixel dot.
export const BILLBOARD_PIXELS = 2.5;
export function chooseLod({distance, previous = 'point', visible = true, selected = false, sizeM = 0, viewportHeight = 0, fov = Math.PI/3, symbol = false}) {
  if (!visible) return 'hidden';
  const threshold = selected ? 150000 : previous === 'model' ? 50000 : 35000;
  const pixels=sizeM*viewportHeight/(2*Math.max(1,distance)*Math.tan(fov/2));
  // Known-sized models must be big enough on screen, not merely <35 km away.
  const measured=sizeM>0 && viewportHeight>0;
  if((selected && distance<threshold) || (measured ? pixels>(previous==='model'?4:6) : distance<threshold))return 'model';
  // Only something whose size is known gets a glyph. Without a size there is no
  // apparent size to judge, and promoting everything nearby would put a glyph on
  // each of a thousand satellites - which is the smear the point tier exists to
  // condense, drawn larger. Each step down asks a little less than the step up
  // did, so something on the boundary does not flicker between tiers.
  const wasGlyph=previous==='billboard' || previous==='model';
  if(measured && pixels>(wasGlyph?BILLBOARD_PIXELS*0.8:BILLBOARD_PIXELS))return 'billboard';
  // Too small to measure on screen is not the same as not worth marking. An
  // aircraft or a satellite is a symbol on a traffic display, not an object
  // whose true angular size matters: sixteen metres at five hundred kilometres
  // will never be two pixels across, and which one it is still reads at a
  // glance from its shape and its colour. The caller says where that holds.
  if(symbol)return 'billboard';
  return 'point';
}
// Ground track is a display orientation, not measured attitude. An interpolated
// track may be supplied; otherwise the newest sample's track is used.
export function displayHeading(entity, headingDeg = entity.heading_deg) {
  if (!['ground_track','attitude'].includes(entity.orientation_source)) return 0;
  const heading = Number.isFinite(headingDeg) ? headingDeg : entity.heading_deg;
  return Number.isFinite(heading) ? (heading - 90) * Math.PI / 180 : 0;
}
export function provenanceLabel(entity) {
  return entity.provenance === 'fixture' ? '시험 입력 (LIVE 아님)' : entity.provenance === 'cached' ? `저장 궤도 기반 계산 · 수집 ${new Date(entity.received_time*1000).toISOString()}` : entity.provenance === 'live' ? '실제 공급자' : '출처 유형 미확인';
}
