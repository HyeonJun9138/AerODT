// Read-only replay presentation. The PlanPanel remains the sole playback clock.
export function replayDisplayEntity({plan,run,sample:s}) {
 if(!s?.position||!run?.run_id)return null;
 const lat=s.position.latitude*Math.PI/180,lon=s.position.longitude*Math.PI/180;
 const e2=6.69437999014e-3,n=6378137/Math.sqrt(1-e2*Math.sin(lat)**2),h=s.position.altitude_m;
 return {entity_id:`replay:${run.run_id}`,name:plan?.vehicle?.id??'UAM',kind:'uam',source:'replay',provenance:'simulation',derivation:'simulated',quality:'nominal',
  visual_asset_id:plan?.aircraft?.asset_id,model_id:'recorded_flight',state_time:s.time_s,observation_time:s.time_s,received_time:s.time_s,continuity_id:0,
  position_ecef_m:[(n+h)*Math.cos(lat)*Math.cos(lon),(n+h)*Math.cos(lat)*Math.sin(lon),(n*(1-e2)+h)*Math.sin(lat)],
  velocity_ecef_mps:null,recorded_speed_mps:s.speed_mps,
  latitude_deg:s.position.latitude,longitude_deg:s.position.longitude,altitude_m:h,heading_deg:s.heading_deg,pitch_deg:s.pitch_deg,roll_deg:s.roll_deg,
  battery_pct:s.battery_pct,tilt_deg:s.tilt_deg,rotor_radps:s.rotor_radps,orientation_source:'attitude',flight_phase:s.stage};
}
export class ReplayPresentation {
 constructor({getJSON,postJSON,onDetails=()=>{},onSnapshot=()=>{},onPrediction=()=>{},onError=()=>{}}){
  Object.assign(this,{getJSON,postJSON,onDetails,onSnapshot,onPrediction,onError});this.epoch=0;this.serial=0;this.lastRequest=-Infinity;
 }
 update(state){
  const old=this.state,next=state?.run?.run_id;
  const reset=next!==old?.run?.run_id || (state?.sample&&old?.sample&&(state.sample.time_s<old.sample.time_s||state.sample.stage!==old.sample.stage));
  if(reset){this.serial++;this.controller?.abort();this.controller=null;this.pending=false;this.epoch++;this.prediction=null;this.onPrediction(null);this.onSnapshot(null);this.lastRequest=-Infinity;}
  this.state=state;this.entity=replayDisplayEntity(state??{});
  if(!this.entity){if(this.selected)this.onDetails(null);this.selected=false;return;}
  if(this.selected)this.onDetails(this.entity,state);
 }
 pick(){if(!this.entity)return;this.selected=true;this.onDetails(this.entity,this.state,{reopen:true});}
 deselect(){this.selected=false;}
 async refresh(enabled,settings={}){
  const key=JSON.stringify([enabled,settings.model,settings.seconds]);
  if(key!==this.settingsKey){this.settingsKey=key;this.serial++;this.controller?.abort();this.pending=false;this.prediction=null;this.onPrediction(null);this.lastRequest=-Infinity;}
  if(!this.entity||!enabled){if(this.entity)this.onSnapshot({epoch:this.epoch,state_time:this.entity.state_time,entities:[this.entity]},null);return;}
  if(this.pending)return;
  const {run,sample}=this.state;
  const stamp=`${run.run_id}:${sample.time_s}:${key}`;
  if(stamp===this.lastStamp&&this.prediction){this.onSnapshot(this.lastSnapshot,this.prediction);return;}
  const serial=this.serial,epoch=this.epoch,controller=new AbortController();this.controller=controller;this.pending=true;this.lastStamp=stamp;
  try{
   const answer=this.postJSON?await this.postJSON(`/api/simulation/runs/${encodeURIComponent(run.run_id)}/prediction`,{seconds:sample.time_s,epoch,heights:this.state.plan?.resolved?this.state.plan.legs.flatMap(leg=>leg.path.map(p=>p[2])):undefined},{signal:controller.signal}):await this.getJSON(`/api/simulation/runs/${encodeURIComponent(run.run_id)}/prediction?seconds=${encodeURIComponent(sample.time_s)}&epoch=${epoch}`,{signal:controller.signal});
   if(serial!==this.serial||controller.signal.aborted||!answer)return;
   if(answer.snapshot?.epoch!==epoch||answer.run_id!==run.run_id)return;
   this.lastSnapshot=answer.snapshot;this.prediction=answer.prediction;this.onSnapshot(answer.snapshot,answer.prediction);this.onPrediction(answer.prediction);
  }catch(error){if(serial===this.serial&&!controller.signal.aborted){this.prediction=null;this.onPrediction(null);this.onSnapshot({epoch,state_time:sample.time_s,entities:[this.entity]},null);this.onError(error);}}
  finally{if(serial===this.serial){this.pending=false;this.controller=null;}}
 }
 destroy(){this.serial++;this.controller?.abort();this.onPrediction(null);this.onSnapshot(null);}
}
