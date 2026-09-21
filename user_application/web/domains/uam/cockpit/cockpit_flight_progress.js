// Read-only flight-plan presentation. No clock, flight-state or event ownership.
import {routeGuidance,angleDelta} from './cockpit_route.js';
const finite=Number.isFinite;
export const sameAircraft=(a,b)=>Boolean(a&&b&&String(a).replace(/^(scenario|physical):/,'')===String(b).replace(/^(scenario|physical):/,''));
export function flightClock(clock,displayTime){
 if(!finite(clock?.time_s)||!finite(clock?.epoch_time)||!finite(displayTime))return null;
 const drift=displayTime-clock.epoch_time;
 return Math.abs(drift)<=30?clock.time_s+drift:null;
}
export function flightTiming(detail,now_s){
 const flight=detail?.flight??{},id=flight.flight_id;
 const event=kind=>(detail?.events??[]).filter(e=>id&&e.flight_id===id&&e.kind===kind&&finite(e.time_s)&&(!finite(now_s)||e.time_s<=now_s)).sort((a,b)=>a.time_s-b.time_s)[0]?.time_s;
 return {now_s,off_block_s:flight.off_block_s,planned_takeoff_s:flight.lift_off_s,planned_landing_s:flight.touchdown_s,
  actual_takeoff_s:event('takeoff'),actual_landing_s:event('touchdown')};
}
export function manualFlightTiming({entityId,detail,psu,plan,sample}){
 const matched=sameAircraft(entityId,detail?.state?.aircraft_id)&&(!psu?.flight_id||detail?.flight?.flight_id===psu.flight_id)?detail:null;
 const linked=psu?.flight_id&&(!matched?.flight?.flight_id||matched.flight.flight_id===psu.flight_id)?psu:null;
 const now=linked?.procedure?.timeline?.now_s;
 const timing=flightTiming(matched,finite(now)?now:null);
 if(linked){timing.off_block_s??=linked.procedure?.timeline?.off_block_s;timing.stale=Boolean(linked.stale||linked.error);}
 // Standalone replay/manual clocks are elapsed seconds, not time of day.
 if(entityId==='preview:selected-flight'){
  timing.now_s=sample.time_s;timing.elapsed_clock=true;
  const legs=plan.legs??[];
  timing.planned_takeoff_s=legs.find(l=>l.stage==='takeoff')?.start_s;
  timing.planned_landing_s=legs.find(l=>l.stage==='landing')?.end_s;
  timing.off_block_s=legs.find(l=>l.stage==='gate_out')?.start_s;
 }
 return timing;
}
export function navClock(value,elapsed=false){
 if(!finite(value)||value<0)return '—';
 const sec=Math.floor(value),day=Math.floor(sec/86400),hours=elapsed?Math.floor(sec/3600):Math.floor(sec/3600)%24;
 return `${!elapsed&&day?`+${day}d `:''}${[hours,Math.floor(sec/60)%60,sec%60].map(v=>String(v).padStart(2,'0')).join(':')}`;
}
export function navDuration(value){
 if(!finite(value)||value<0)return '—';
 const s=Math.ceil(value);return s>=3600?navClock(s,true):`${Math.floor(s/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`;
}
const distance=(a,b)=>{
 const r=Math.PI/180,lat=(b.latitude_deg-a.latitude_deg)*r,lon=angleDelta(b.longitude_deg,a.longitude_deg)*r;
 const h=Math.sin(lat/2)**2+Math.cos(a.latitude_deg*r)*Math.cos(b.latitude_deg*r)*Math.sin(lon/2)**2;
 return 12742000*Math.asin(Math.sqrt(Math.max(0,Math.min(1,h))));
};
export function groundSpeed(entity){
 if(finite(entity.ground_speed_mps)&&entity.ground_speed_mps>=0)return entity.ground_speed_mps;
 const ned=entity.velocity_ned_mps;
 if(Array.isArray(ned)&&ned.length===3&&ned.every(finite))return Math.hypot(ned[0],ned[1]);
 const v=entity.velocity_ecef_mps;
 if(Array.isArray(v)&&v.length===3&&v.every(finite)&&finite(entity.latitude_deg)&&finite(entity.longitude_deg)){
  const lat=entity.latitude_deg*Math.PI/180,lon=entity.longitude_deg*Math.PI/180;
  return Math.hypot(-v[0]*Math.sin(lon)+v[1]*Math.cos(lon),-v[0]*Math.sin(lat)*Math.cos(lon)-v[1]*Math.sin(lat)*Math.sin(lon)+v[2]*Math.cos(lat));
 }
 // A scalar 3D speed alone cannot establish horizontal progress in VTOL.
 return null;
}
export function flightProgress(entity,mission,{stale=false,cue=routeGuidance(entity,mission)}={}){
 const points=mission.route_points??[],timing=mission.timing??{};
 let remaining=null;
 if(cue){remaining=distance(entity,points[cue.index]);for(let i=cue.index+1;i<points.length;i++)remaining+=distance(points[i-1],points[i]);}
 const speed=groundSpeed(entity),unreliable=stale||timing.stale;
 const blocked=unreliable?'DATA STALE':!cue?'NO ROUTE':mission.holding?'HOLD':entity.airborne!==true?'GROUND / NO AIR DATA':!finite(speed)?'NO GROUND SPEED':!(speed>.5)?'LOW GROUND SPEED':null;
 const ete=!blocked?remaining/speed:null;
 const now=timing.now_s,takeoff=timing.actual_takeoff_s,landed=timing.actual_landing_s;
 const elapsed=finite(now)&&finite(takeoff)&&now>=takeoff?Math.max(0,(finite(landed)&&landed<=now?landed:now)-takeoff):null;
 return {remaining,ete,eta:finite(ete)&&finite(now)?now+ete:null,elapsed,speed,note:blocked??'LIVE GS / ROUTE END · NO HOLD / LANDING ALLOWANCE'};
}
