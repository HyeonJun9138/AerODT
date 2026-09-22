import test from 'node:test';import assert from 'node:assert/strict';
import {ManualFlightDisplay} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_display.js';
const sample=(t,x=t*10,heading=0)=>({time_s:t,position:{longitude:127+x/88000,latitude:37,altitude_m:80},heading_deg:heading,pitch_deg:0,roll_deg:0,airborne:true});
test('irregular delivery remains continuous beyond the old 60ms freeze',()=>{
 const d=new ManualFlightDisplay();d.reset(sample(0),0);d.push(sample(.05),50);
 let old=d.sample(50);for(const now of [66,82,98,114,130]){const next=d.sample(now);assert.ok(next.position.longitude>old.position.longitude);old=next;}
 d.push(sample(.13),132);assert.ok(d.sample(148).position.longitude>old.position.longitude);
});
test('lost packets are bounded to two gaps (100 ms at 20 Hz), pause removes projection and does not mutate telemetry',()=>{
 const d=new ManualFlightDisplay(),s=sample(.05);d.reset(sample(0),0);d.push(s,50);const original=JSON.stringify(s);
 for(let now=60;now<=3000;now+=16)d.sample(now);
 assert.ok(d.display.position.longitude<=127+1.5/88000+1e-10);assert.ok(d.display.position.longitude>127+1.3/88000);assert.deepEqual(d.sample(3001,false).position,s.position);assert.equal(JSON.stringify(s),original);
});
test('heading crosses north by the short arc; delayed invalid or discontinuous states do not explode',()=>{
 const d=new ManualFlightDisplay();d.reset(sample(0,0,359),0);d.push(sample(.05,.5,1),50);assert.ok(d.sample(66).heading_deg<5||d.display.heading_deg>355);
 assert.equal(d.push(sample(.01),70),false);assert.equal(d.push({time_s:1,position:{longitude:NaN}},80),false);
 const ground={...sample(1,500),airborne:false};d.push(ground,1000);assert.equal(d.display,ground);assert.equal(d.previous,null);
});

for(const airborne of [false,true])test(`duplicate replies do not rewind a ${airborne?'airborne':'ground'} turn or extend stale prediction`,()=>{
 const d=new ManualFlightDisplay(),at=t=>({...sample(t,t*10,30*t),airborne});d.reset(at(0),0);d.push(at(.06),100);
 for(let now=116;now<=180;now+=16)d.sample(now);
 const before=d.display.heading_deg,received=d.at;
 d.push({...at(.06),ground_handling:{locked:false,phase:'idle'}},185);
 assert.equal(d.display.heading_deg,before);assert.equal(d.at,received);
 assert.ok(d.sample(196).heading_deg>=before);
 for(let now=200;now<=1000;now+=20){d.push(at(.06),now);d.sample(now);}
 const frozen=d.display.heading_deg;d.push(at(.06),1010);assert.ok(Math.abs(d.sample(1020).heading_deg-frozen)<.001);
});

test('slow steady delivery does not produce periodic reverse yaw between packets',()=>{
 const d=new ManualFlightDisplay(),at=t=>sample(t,t*10,30*t);d.reset(at(0),0);
 let last=0,backwards=0,minimum=Infinity,maximum=0;
 for(let now=10;now<=4000;now+=10){
  if(now%120===0)d.push(at(now/2000),now);
  const heading=d.sample(now).heading_deg,step=heading-last;
  if(now>600){if(step<-.0001)backwards++;minimum=Math.min(minimum,step);maximum=Math.max(maximum,step);}
  last=heading;
 }
 assert.equal(backwards,0);assert.ok(minimum>.08,`minimum yaw advance ${minimum}`);assert.ok(maximum/minimum<2,`uneven frame advance ${maximum/minimum}`);
 assert.ok(Math.abs(d.pace-.5)<.01);
});


test('paced display remains frame-rate independent, crosses north and follows a real reversal',()=>{
 const run=hz=>{
  const d=new ManualFlightDisplay(),raw=t=>({...sample(t,t*10,(359+(t<1?20*t:20-20*(t-1))+360)%360),pitch_deg:5*t,roll_deg:-8*t});
  d.reset(raw(0),0);let nextPacket=120;
  for(let now=1000/hz;now<=4000.01;now+=1000/hz){while(nextPacket<=now+.001){d.push(raw(nextPacket/2000),nextPacket);nextPacket+=120;}d.sample(now);}
  return d.display;
 };
 const results=[30,60,120].map(run);
 for(const s of results){assert.ok(s.heading_deg<10||s.heading_deg>350);assert.ok(s.pitch_deg>8);assert.ok(s.roll_deg< -12);}
 const difference=(a,b)=>Math.abs(((a-b+540)%360)-180);
 assert.ok(difference(results[0].heading_deg,results[2].heading_deg)<.5);
});
test('real-time delivery at eight samples a second keeps the pose moving between samples',()=>{
 // Measured on the live server on 2026-09-21 with the day playing: a state
 // sample every 108-138 ms at the median (p95 165-194), each carrying the
 // same span of flight time, so the clock kept 1.0x. Fed here every 120 ms.
 // The old fixed 80 ms horizon ran out 40 ms before the next sample: the pose stood still,
 // then the next sample was a jump - a surge and a hold eight times a second
 // in the one pose the cockpit camera is bolted to.
 const d=new ManualFlightDisplay(),at=t=>sample(t,t*10,30*t);d.reset(at(0),0);
 let last=null;const advances=[],turns=[];
 for(let now=10;now<=6000;now+=10){
  if(now%120===0)d.push(at(now/1000),now);
  const s=d.sample(now);
  if(now>1000&&last){advances.push(s.position.longitude-last.position.longitude);turns.push(((s.heading_deg-last.heading_deg+540)%360)-180);}
  last=s;
 }
 for(const [name,steps] of [['advance',advances],['yaw',turns]]){
  const minimum=Math.min(...steps),maximum=Math.max(...steps);
  assert.ok(minimum>0,`${name} stalled between samples: ${minimum}`);
  assert.ok(maximum/minimum<1.5,`${name} surges and holds: ${maximum/minimum}`);
 }
 assert.ok(Math.abs(d.pace-1)<.02);assert.ok(Math.abs(d.horizon-.24)<1e-9,`horizon follows the 120 ms gap: ${d.horizon}`);
 // A lost packet is still bounded: about two of the gaps it has
 // been seeing, not the whole silence.
 for(let now=6010;now<=9000;now+=10)d.sample(now);
 assert.ok(d.display.time_s<=6+.12*2+1e-9,`prediction ran on through a silence: ${d.display.time_s}`);
});
test('a reply held up by the tick never moves the pose backwards, and the pause is short',()=>{
 // Measured: 5-8% of replies arrive 180-357 ms after the previous one while
 // the day plays, carrying an ordinary 120-135 ms of flight time, with the
 // next reply right behind. The display has by then run past that sample.
 const d=new ManualFlightDisplay(),at=t=>sample(t,t*10,30*t);d.reset(at(0),0);
 const arrivals=[];for(let t=120;t<=1200;t+=120)arrivals.push([t,t]);
 // Two replies held back by a 230 ms tick, then delivered together.
 arrivals.push([1320+230,1320],[1320+235,1440]);for(let t=1560;t<=3000;t+=120)arrivals.push([t,t]);
 let next=0,last=null,backwards=0,held=0,minimum=Infinity,maximum=0;
 for(let now=10;now<=3000;now+=10){
  while(next<arrivals.length&&arrivals[next][0]<=now){d.push(at(arrivals[next][1]/1000),now);next++;}
  const s=d.sample(now);
  if(last&&now>600){
   const step=s.position.longitude-last.position.longitude,turn=((s.heading_deg-last.heading_deg+540)%360)-180;
   if(step<-1e-12||turn<-1e-9)backwards++;
   if(step<1e-12)held++;
   if(now>1300&&now<1800){minimum=Math.min(minimum,step);maximum=Math.max(maximum,step);}
  }
  last=s;
 }
 assert.equal(backwards,0,'the pose never moves backwards');
 assert.ok(held<=6,`held for ${held} frames of 10 ms`);
 assert.ok(d.display.time_s<=3.24+1e-9);
});
