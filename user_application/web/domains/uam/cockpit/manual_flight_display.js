const {interpolateSurfaceAngles}=await import(import.meta.url.startsWith('file:')
  ? '../../../../../digital_twin/visualization/web/control_surface_pose.js' : '/visualization/control_surface_pose.js');
// A bounded display projection of native snapshots, never a source of control or logs.
const angles=['heading_deg','pitch_deg','roll_deg'];
// How far past the newest sample the display may run: a multiple of the gap
// it has been seeing between samples, within these bounds. At a healthy
// 20 Hz feed a sample lands every 50 ms and the floor is what the old fixed
// 80 ms was, never reached. Under a busy day the tick stretches the round
// trip and samples land every 108-138 ms at the median (measured on the live
// server, 2026-09-21; p95 165-194 ms) while the clock still keeps 1.0x. Run
// only 80 ms into such a gap and the pose stands still for the rest of it,
// then the next sample is a jump: a surge and a hold eight times a second,
// in the one pose the cockpit camera is bolted to. Running two gaps covers
// the jitter and most tick-length reply delays (p95 was 1.4x the mean, the
// rare ones 2-2.9x), and still stops a lost packet's
// prediction within a gap or so of the silence beginning.
const HORIZON_GAPS=2,HORIZON_MIN_S=.08,HORIZON_MAX_S=.3;
const delta=(a,b)=>((b-a+540)%360)-180;
export class ManualFlightDisplay {
 reset(sample=null,now=0){this.latest=sample;this.previous=null;this.display=sample;this.at=now;this.last=now;this.arrivals=sample?[{time:sample.time_s,at:now}]:[];this.pace=1;this.horizon=HORIZON_MIN_S;}
 push(sample,now){
  if(!sample?.position||!Object.values(sample.position).every(Number.isFinite)||!Number.isFinite(sample.time_s))return false;
  const old=this.latest,dt=sample.time_s-(old?.time_s??sample.time_s);
  if(old&&dt<0)return false;
  if(old&&dt===0){
   // A zero-step reply/ground acknowledgement updates status, not the motion
   // clock. Replacing the projected attitude here rewound every ongoing turn.
   this.latest=sample;return true;
  }
  const p=sample.position,q=old?.position;
  const metres=q?Math.hypot((p.longitude-q.longitude)*111320*Math.cos(p.latitude*Math.PI/180),(p.latitude-q.latitude)*111320,p.altitude_m-q.altitude_m):Infinity;
  if(!old||dt>.3||metres>Math.max(10,dt*180)||sample.airborne!==old.airborne){this.reset(sample,now);return true;}
  this.arrivals.push({time:sample.time_s,at:now});
  while(this.arrivals.length>2&&(this.arrivals.length>12||now-this.arrivals[0].at>700))this.arrivals.shift();
  // The mean gap over the same window the pace is read from: what the next
  // wait is likely to be, so the horizon covers it.
  const gap=(this.arrivals.at(-1).at-this.arrivals[0].at)/(1000*(this.arrivals.length-1));
  this.horizon=Math.max(HORIZON_MIN_S,Math.min(HORIZON_MAX_S,gap*HORIZON_GAPS));
  const first=this.arrivals[0],wall=(now-first.at)/1000;
  // Native elapsed time and wall time are not interchangeable when delivery
  // is back-pressured. Use a window rather than one burst's arrival interval.
  if(wall>=.08)this.pace=Math.max(.25,Math.min(1.25,(sample.time_s-first.time)/wall));
  this.previous=old;this.latest=sample;this.at=now;return true;
 }
 sample(now,active=true,command=null){
  const s=this.latest;if(!s)return null;
  if(!active){
   const held={...s};
   if(this.display?.manual_surface_display_deg){held.manual_surface_display_deg=this.display.manual_surface_display_deg.slice();held.control_surface_display_source=this.display.control_surface_display_source;}
   for(const rate of ['roll_rate_deg_s','pitch_rate_deg_s','yaw_rate_deg_s'])held[rate]=this.display?.[rate]??s[rate]??0;
   this.reset(held,now);return held;
  }
  const prev=this.previous,dt=s.time_s-(prev?.time_s??s.time_s),age=Math.max(0,(now-this.at)/1000);
  // Up to the horizon of native motion beyond the newest sample, advanced at
  // the observed playback pace instead of overshooting slow delivery.
  const ahead=prev&&dt>0?Math.min(this.horizon??HORIZON_MIN_S,age*this.pace):0;
  // Never back. A reply held up by the day's tick arrives after the display
  // has already run past its time (the next one is usually right behind it,
  // which is why running ahead was right); moving the pose back to it was a
  // twitch, and the pose then sprang forward again. Held where it is until
  // the samples catch up, which is a pause of a frame or two, not a jerk.
  const shownTime=Number.isFinite(this.display?.time_s)?this.display.time_s:-Infinity;
  const time=Math.max(s.time_s+ahead,Math.min(shownTime,s.time_s+Math.max(ahead,this.horizon??HORIZON_MIN_S)));
  const lead=time-s.time_s,run=dt>0?lead/dt:0;
  const target={...s,position:{...s.position},time_s:time};
  // Derive the display-only surface indication from received native samples,
  // not from extrapolated attitude, wall time or local stick input.
  for(const [key,rate] of [['roll_deg','roll_rate_deg_s'],['pitch_deg','pitch_rate_deg_s'],['heading_deg','yaw_rate_deg_s']])
   target[rate]=prev&&dt>0&&Number.isFinite(prev[key])&&Number.isFinite(s[key])
    ?Math.max(-120,Math.min(120,delta(prev[key],s[key])/dt)):(s[rate]??0);
  for(const key of Object.keys(target.position))target.position[key]+=prev?(s.position[key]-prev.position[key])*run:0;
  for(const key of angles)if(prev&&Number.isFinite(s[key])&&Number.isFinite(prev[key]))target[key]=s[key]+Math.max(-120*dt,Math.min(120*dt,delta(prev[key],s[key])))*run;
  // Normal cadence keeps the 35 ms response. Slow delivery needs a longer
  // (at most 120 ms) correction envelope to avoid packet-shaped camera turns.
  const elapsed=Math.max(0,Math.min(.1,(now-this.last)/1000)),blend=1-Math.exp(-elapsed/(Math.min(.12,.035/Math.min(1,this.pace)**1.5))),from=this.display??target;
  const shown={...target,position:{...target.position}};
  for(const key of Object.keys(shown.position))shown.position[key]=from.position[key]+(target.position[key]-from.position[key])*blend;
  for(const key of angles)if(Number.isFinite(from[key])&&Number.isFinite(target[key]))shown[key]=from[key]+delta(from[key],target[key])*blend;
  shown.control_surface_deg=interpolateSurfaceAngles(from.control_surface_deg,target.control_surface_deg,blend)??target.control_surface_deg??null;
  // Presentation of pilot demand on representative aircraft. Keep measured
  // control_surface_deg intact: the AirTaxi mixer has zero aileron allocation
  // in hover and is not a KP2/Joby/AMV aircraft-specific actuator model.
  if(s.manual){
   const allowed=command&&age<=.5&&!s.ground_handling?.locked;
   const input=key=>allowed&&Number.isFinite(command[key])?Math.max(-1,Math.min(1,command[key])):0;
   const demand=[-20*input('roll'),20*input('roll'),20*input('pitch'),20*input('yaw')];
   const previous=from.manual_surface_display_deg??[0,0,0,0];
   shown.manual_surface_display_deg=demand.map((v,i)=>previous[i]+Math.max(-90*elapsed,Math.min(90*elapsed,(v-previous[i])*(1-Math.exp(-elapsed/.08)))));
   shown.control_surface_display_source='manual_input_visualization';
  }
  shown.heading_deg=(shown.heading_deg+360)%360;
  shown.time_s=Math.max(from.time_s,target.time_s);
  this.last=now;this.display=shown;return shown;
 }
}
