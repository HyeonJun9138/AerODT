// Offline display-clock diagnostic. Optional --trace JSON from a read-only WS
// capture ({rows:[{wall,t}]}); --baseline old display_samples.js compares code.
// No server commands, browser controls or writes to runtime records.
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {DisplaySamples} from '../../../digital_twin/visualization/web/display_samples.js';
const root=new URL('../../../',import.meta.url);
const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
let Old=null;
if(option('--baseline')){
 const oldText=readFileSync(option('--baseline'),'utf8').replace("'./physical_playback.js'",JSON.stringify(new URL('digital_twin/visualization/web/physical_playback.js',root).href));
 Old=(await import('data:text/javascript;base64,'+Buffer.from(oldText).toString('base64'))).DisplaySamples;
}
const q=(a,f)=>[...a].sort((a,b)=>a-b)[Math.floor((a.length-1)*f)];
function replay(Type,arrivals,end){
 const samples=new Type(),rates=[],delays=[];let index=0,last=null,backward=0,future=0;
 for(let now=0;now<end;now+=10){
  while(index<arrivals.length && arrivals[index].at<=now){const a=arrivals[index++];samples.replace({sequence:index,state_time:a.t,clock_rate:1,entities:[{entity_id:'a',kind:'uam',source:'scenario',position_ecef_m:[100*a.t,0,0],velocity_ecef_mps:[100,0,0]}]},a.at);}
  if(!samples.entries.size)continue;
  const x=samples.position('a',now)[0];
  if(now>10000 && last!==null){rates.push((x-last)/.01);delays.push(samples.stateTime-x/100);}
  if(last!==null && x<last-1e-6)backward++;
  if(x>samples.stateTime*100+1e-6)future++;
  last=x;
 }
 return {speed_mps:{min:Math.min(...rates),p05:q(rates,.05),p50:q(rates,.5),p95:q(rates,.95),max:Math.max(...rates)},delay_s:{p50:q(delays,.5),p95:q(delays,.95),max:Math.max(...delays)},backward,future};
}
const regular=Array.from({length:501},(_,i)=>({t:i*.1,at:i*100+[0,15,35,5,50,0,20,5,80,0][i%10]}));
const compare=(arrivals,end)=>({...(Old?{before:replay(Old,arrivals,end)}:{}),after:replay(DisplaySamples,arrivals,end)});
const result={scope:'Offline display-clock replay; constant 100 m/s truth. Live trace supplies packet/state timing, not a claim of in-flight speed.',jitter:compare(regular,49000)};
if(option('--trace')){
 const live=JSON.parse(readFileSync(option('--trace'),'utf8'));
 const actual=live.rows.map(r=>({at:r.wall*1000,t:r.t-live.rows[0].t}));
 result.liveTiming=compare(actual,actual.at(-1).at);
}
if(option('--output'))writeFileSync(pathToFileURL(resolve(option('--output'))),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
