// Replay recorded snapshot arrival timing through a DisplaySamples implementation.
// Motion is synthesized from each recorded aircraft's velocity so that only the
// display layer is measured: holds, jumps, backward motion and display delay.
//   node project_support/tools/web_visualization/replay_display_motion.mjs --label after
//   options: --module <display_samples.js> --timing <probe json> --motion <probe json with aircraft> --fps 60
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';

const args=Object.fromEntries(process.argv.slice(2).map((value,index,all)=>value.startsWith('--')?[value.slice(2),all[index+1]]:null).filter(Boolean));
const root=path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')),'../../..');
const modulePath=path.resolve(args.module ?? path.join(root,'digital_twin/visualization/web/display_samples.js'));
const timingPath=path.resolve(args.timing ?? path.join(root,'data/workspace/performance/aircraft_motion_before.json'));
const motionPath=path.resolve(args.motion ?? timingPath);
const label=args.label ?? 'current',fps=Number(args.fps ?? 60);
const {DisplaySamples}=await import(pathToFileURL(modulePath).href);
const timing=JSON.parse(await fs.readFile(timingPath,'utf8'));
const motion=motionPath===timingPath?timing:JSON.parse(await fs.readFile(motionPath,'utf8'));

const seen=new Set(),arrivals=[];
for(const record of timing.records){if(seen.has(record.sequence))continue;seen.add(record.sequence);arrivals.push({at:record.arrival*1000,t:record.state_time,sequence:record.sequence});}
arrivals.sort((a,b)=>a.at-b.at);
const base=motion.records[0].entities.filter(e=>Array.isArray(e.velocity_ecef_mps) && Math.hypot(...e.velocity_ecef_mps)>30).slice(0,30);
if(!base.length)throw new Error('motion file has no moving aircraft; pass --motion with a probe that tracked aircraft');
const t0=arrivals[0].t;
const truth=(e,t)=>e.position_ecef_m.map((p,i)=>p+e.velocity_ecef_mps[i]*(t-t0));
const entities=t=>base.map(e=>({entity_id:e.entity_id,kind:'aircraft',quality:'valid',continuity_id:0,discontinuity:false,orientation_source:'ground_track',heading_deg:e.heading_deg,position_ecef_m:truth(e,t)}));

const samples=new DisplaySamples();const frameMs=1000/fps;const out=[0,0,0];
const per=new Map(base.map(e=>[e.entity_id,{last:null,lastNow:0,frames:0,holds:0,jumps:0,backward:0,delays:[],behind:[],steadyFrames:0,steadyHolds:0,steadyJumps:0,steadyBehind:[]}]));
const WARMUP=12; // arrival window length: metrics after it describe the steady state
let index=0,calls=0,cpu=0;
for(let now=arrivals[0].at;now<=arrivals.at(-1).at+3000;now+=frameMs){
  while(index<arrivals.length && arrivals[index].at<=now){const a=arrivals[index++];samples.replace({sequence:a.sequence,state_time:a.t,entities:entities(a.t)},a.at);}
  for(const e of base){
    const started=performance.now();const p=samples.position(e.entity_id,now,out);cpu+=performance.now()-started;calls++;
    if(!p)continue;const s=per.get(e.entity_id),v=e.velocity_ecef_mps,speed=Math.hypot(...v);
    const shownT=t0+((p[0]-e.position_ecef_m[0])*v[0]+(p[1]-e.position_ecef_m[1])*v[1]+(p[2]-e.position_ecef_m[2])*v[2])/(speed*speed);
    const steady=index>WARMUP;
    if(s.last){
      const d=[p[0]-s.last[0],p[1]-s.last[1],p[2]-s.last[2]],dist=Math.hypot(...d),expected=speed*(now-s.lastNow)/1000;
      const hold=dist<.05*expected,jump=dist>3*expected+1;
      s.frames++;if(hold)s.holds++;if(jump)s.jumps++;if(d[0]*v[0]+d[1]*v[1]+d[2]*v[2]<-1e-6)s.backward++;
      if(steady){s.steadyFrames++;if(hold)s.steadyHolds++;if(jump)s.steadyJumps++;}
    }
    s.delays.push(now/1000-shownT);s.behind.push(samples.stateTime-shownT);if(steady)s.steadyBehind.push(samples.stateTime-shownT);
    s.last=[p[0],p[1],p[2]];s.lastNow=now;
  }
}
const quantile=(values,q)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted.length?sorted[Math.min(sorted.length-1,Math.floor(sorted.length*q))]:null;};
const all=[...per.values()];const sum=key=>all.reduce((total,s)=>total+s[key],0);
const delays=all.flatMap(s=>s.delays),behind=all.flatMap(s=>s.behind);
const lags=arrivals.map(a=>a.at/1000-a.t),gaps=arrivals.slice(1).map((a,i)=>a.t-arrivals[i].t);
const report={label,module:path.relative(root,modulePath),timing:path.relative(root,timingPath),motion:path.relative(root,motionPath),fps,
  input:{snapshots:arrivals.length,entities:base.length,state_gap_s:{median:quantile(gaps,.5),max:Math.max(...gaps)},arrival_lag_s:{min:Math.min(...lags),median:quantile(lags,.5),max:Math.max(...lags)}},
  frames:sum('frames'),hold_fraction:sum('holds')/Math.max(1,sum('frames')),jump_frames:sum('jumps'),backward_frames:sum('backward'),
  display_delay_s:{median:quantile(delays,.5),p95:quantile(delays,.95),max:Math.max(...delays)},
  behind_newest_state_s:{median:quantile(behind,.5),p95:quantile(behind,.95),max:Math.max(...behind)},
  steady_state:{after_snapshots:WARMUP,frames:sum('steadyFrames'),hold_fraction:sum('steadyHolds')/Math.max(1,sum('steadyFrames')),jump_frames:sum('steadyJumps'),
    behind_newest_state_s:(b=>({median:quantile(b,.5),p95:quantile(b,.95),max:b.length?Math.max(...b):null}))(all.flatMap(s=>s.steadyBehind))},
  position_call_us:cpu/Math.max(1,calls)*1000,
  note:'Recorded arrival timing with synthesized constant-velocity motion; measures the display layer only, not the server estimate.'};
const folder=path.join(root,'data/workspace/performance');await fs.mkdir(folder,{recursive:true});
const file=path.join(folder,`display_replay_${label}.json`);await fs.writeFile(file,JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));console.log('saved',path.relative(root,file));
