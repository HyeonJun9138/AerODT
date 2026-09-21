const {interpolateSurfaceAngles}=await import(import.meta.url.startsWith('file:')
  ? '../../../../../digital_twin/visualization/web/control_surface_pose.js' : '/visualization/control_surface_pose.js');
// A bounded display projection of native snapshots, never a source of control or logs.
const angles=['heading_deg','pitch_deg','roll_deg'];
const delta=(a,b)=>((b-a+540)%360)-180;
export class ManualFlightDisplay {
 reset(sample=null,now=0){this.latest=sample;this.previous=null;this.display=sample;this.at=now;this.last=now;this.arrivals=sample?[{time:sample.time_s,at:now}]:[];this.pace=1;}
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
  // At most 80 ms of native motion and 200 ms of wall-time prediction.
  // Match the observed playback pace instead of overshooting slow delivery.
  const ahead=prev&&dt>0?Math.min(.08,Math.min(.2,age)*this.pace):0,weight=dt>0?ahead/dt:0;
  const target={...s,position:{...s.position},time_s:s.time_s+ahead};
  // Derive the display-only surface indication from received native samples,
  // not from extrapolated attitude, wall time or local stick input.
  for(const [key,rate] of [['roll_deg','roll_rate_deg_s'],['pitch_deg','pitch_rate_deg_s'],['heading_deg','yaw_rate_deg_s']])
   target[rate]=prev&&dt>0&&Number.isFinite(prev[key])&&Number.isFinite(s[key])
    ?Math.max(-120,Math.min(120,delta(prev[key],s[key])/dt)):(s[rate]??0);
  for(const key of Object.keys(target.position))target.position[key]+=prev?(s.position[key]-prev.position[key])*weight:0;
  for(const key of angles)if(prev&&Number.isFinite(s[key])&&Number.isFinite(prev[key]))target[key]=s[key]+Math.max(-120*dt,Math.min(120*dt,delta(prev[key],s[key])))*weight;
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
