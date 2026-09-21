import test from 'node:test';
import assert from 'node:assert/strict';
import {DisplaySamples} from '../../../../digital_twin/visualization/web/display_samples.js';

// Truth: x = 100 m/s * t. Wall clock is ms; state time is seconds.
const sample=(t,changes={})=>({entity_id:'a',kind:'aircraft',quality:'valid',continuity_id:0,orientation_source:'ground_track',heading_deg:90,position_ecef_m:[100*t,0,0],...changes});
const snapshot=(sequence,t,entities=[sample(t)])=>({sequence,state_time:t,entities});

// Replays arrivals with jitter and renders at 100 ms between them.
function replay({count=16,gap=2.5,lag=k=>k%2?4400:3000,stepMs=100,samples=new DisplaySamples(),entities=t=>[sample(t)],from=6}={}) {
  const frames=[];const arrivals=Array.from({length:count},(_,k)=>({k,t:k*gap,at:k*gap*1000+lag(k)})).sort((a,b)=>a.at-b.at);
  let now=arrivals[0].at,index=0;const position=[0,0,0];
  while(index<arrivals.length) {
    while(index<arrivals.length && arrivals[index].at<=now){const a=arrivals[index++];samples.replace(snapshot(a.k+1,a.t,entities(a.t)),a.at);}
    if(samples.position('a',now,position))frames.push({now,x:position[0],delay:samples.delaySeconds(now),warm:index>from});
    now+=stepMs;
  }
  return {samples,frames};
}
const deltas=frames=>frames.slice(1).map((f,i)=>f.x-frames[i].x);

test('10x simulation remains continuous between packets, with no 2x catch-up ceiling',()=>{
  const samples=new DisplaySamples();const frames=[];
  for(let now=0;now<=8000;now+=20){
    if(now%100===0)samples.replace({...snapshot(now/100+1,now/100),clock_rate:10},now);
    const p=samples.position('a',now);
    if(now>2000)frames.push({x:p[0]});
  }
  const d=deltas(frames);
  assert.ok(d.every(v=>v>19.9 && v<20.1),'100 m/s at 10x advances 20 m each 20 ms frame');
  assert.equal(samples.breaks,0);
  samples.replace({...snapshot(99,110),clock_rate:10},11000);
  assert.equal(samples.breaks,0,'30 simulated seconds is only 3 wall seconds, not a restart');
});

test('speed changes and pause preserve position continuity and never extrapolate',()=>{
  const samples=new DisplaySamples();let t=0,last=-Infinity,lastClock=-Infinity;
  for(let now=0;now<=12000;now+=20){
    const rate=now<3000?1:now<7000?10:now<9000?0:2;
    if(now%100===0){t+=rate*.1;samples.replace({...snapshot(now+1,t,[sample(t,{source:'scenario'})]),clock_rate:rate},now);}
    const p=samples.position('a',now)[0];
    assert.ok(p>=last-1e-8 && p<=t*100+1e-8);last=p;
    const clock=samples.clockTime(now);assert.ok(clock>=lastClock && clock<=t+1e-8);lastClock=clock;
  }
  assert.equal(samples.breaks,0);
});

test('irregular arrivals are absorbed: no holds, no jumps, bounded delay',()=>{
  const {frames}=replay();const warm=frames.filter(f=>f.warm);const d=deltas(warm);
  assert.ok(warm.length>40);
  assert.ok(d.every(v=>v>0),'displayed position keeps advancing between late messages');
  assert.ok(Math.max(...d)<=10*1.6 && Math.min(...d)>=10*.4,'per-frame motion stays near the 10 m truth');
  assert.ok(warm.every(f=>f.delay>=0 && f.delay<=5.5),'display delay is bounded');
});
test('display never extrapolates past the newest sample',()=>{
  const samples=new DisplaySamples();samples.replace(snapshot(1,0),3000);samples.replace(snapshot(2,2.5),5500);
  assert.deepEqual(samples.position('a',5500+60000),[250,0,0]);
  assert.deepEqual(samples.positionAt('a',10),[250,0,0]);assert.deepEqual(samples.positionAt('a',-5),[0,0,0]);
  assert.deepEqual(samples.positionAt('a',1.25),[125,0,0]);
});
test('a late message holds briefly, then the grown buffer resumes motion without a jump or reversal',()=>{
  const {frames,samples}=replay({lag:k=>k===8?7000:3000});const d=deltas(frames.filter(f=>f.warm));
  assert.ok(d.every(v=>v>=0),'never reverses');assert.ok(d.some(v=>v<1),'the late sample causes a short hold');
  assert.ok(Math.max(...d)<=10*2.05,'resuming never sweeps faster than the bounded catch-up rate');
  assert.ok(d.slice(-10).every(v=>v>5),'motion resumes at real speed');
  assert.ok(samples.bufferMs>2750 && samples.bufferMs<=5000,'the buffer grew to cover the observed jitter within its cap');
});
test('duplicate, older and equal-time snapshots are rejected',()=>{
  const samples=new DisplaySamples();
  assert.equal(samples.replace(snapshot(5,10),0),true);
  assert.equal(samples.replace(snapshot(5,10),100),false);
  assert.equal(samples.replace(snapshot(4,9),200),false);
  assert.equal(samples.replace(snapshot(6,9.5),300),false);
  assert.equal(samples.replace(snapshot(1,20),400),true,'newer server epoch restarts the sequence');
});
test('a long break resynchronizes instead of sweeping across minutes',()=>{
  const samples=new DisplaySamples();
  for(let k=0;k<4;k++)samples.replace(snapshot(k+1,k*2.5),k*2500+3000);
  samples.replace(snapshot(5,600),603000);
  assert.deepEqual(samples.position('a',603001),[60000,0,0]);
  assert.equal(samples.entries.get('a').count,1,'old samples are discarded at a break');
  assert.ok(samples.delaySeconds(603001)<=5.5);
});
test('continuity changes and discontinuities reset the ring immediately',()=>{
  const samples=new DisplaySamples();samples.replace(snapshot(1,0),3000);samples.replace(snapshot(2,2.5),5500);
  samples.replace(snapshot(3,5,[sample(5,{position_ecef_m:[90000,0,0],continuity_id:1})]),8000);
  assert.deepEqual(samples.position('a',8000),[90000,0,0]);
  samples.replace(snapshot(4,7.5,[sample(7.5,{position_ecef_m:[1,0,0],continuity_id:1,discontinuity:true})]),10500);
  assert.deepEqual(samples.position('a',10500),[1,0,0]);assert.equal(samples.entries.get('a').count,1);
});
test('heading interpolates across north the short way and only for ground-track sources',()=>{
  const samples=new DisplaySamples();
  samples.replace(snapshot(1,0,[sample(0,{heading_deg:350})]),3000);samples.replace(snapshot(2,2.5,[sample(2.5,{heading_deg:10})]),5500);
  assert.ok(Math.abs(samples.headingAt('a',1.25))<1e-9);assert.equal(samples.headingAt('a',0),350);assert.equal(samples.headingAt('a',2.5),10);
  assert.ok(Math.abs(samples.headingAt('a',0.625)-355)<1e-9);
  samples.replace(snapshot(3,5,[sample(5,{heading_deg:10,orientation_source:'unavailable'})]),8000);
  assert.ok(Number.isNaN(samples.headingAt('a',5)));
  samples.replace(snapshot(4,7.5,[sample(7.5,{heading_deg:null})]),10500);
  assert.ok(Number.isNaN(samples.headingAt('a',7.5)));
});
test('stale frozen samples are interpolated like any other rather than popping',()=>{
  const samples=new DisplaySamples();
  samples.replace(snapshot(1,0),3000);samples.replace(snapshot(2,2.5,[sample(2.5,{quality:'stale',position_ecef_m:[250,0,0]})]),5500);
  samples.replace(snapshot(3,5,[sample(5,{quality:'stale',position_ecef_m:[250,0,0]})]),8000);
  assert.deepEqual(samples.positionAt('a',1.25),[125,0,0]);assert.deepEqual(samples.positionAt('a',3.75),[250,0,0]);
});
test('sample rings are bounded, reused and never mutate snapshot arrays',()=>{
  const samples=new DisplaySamples();const first=sample(0);samples.replace(snapshot(1,0,[first]),3000);const entry=samples.entries.get('a');
  for(let k=1;k<40;k++)samples.replace(snapshot(k+1,k*2.5,[sample(k*2.5)]),k*2500+3000);
  assert.equal(samples.entries.get('a'),entry);assert.ok(entry.count<=samples.capacity);assert.deepEqual(first.position_ecef_m,[0,0,0]);
  const out=[0,0,0];assert.equal(samples.position('a',100000,out),out);
});
test('display delay tracks slower and faster transport without accumulating',()=>{
  const lag=k=>k<12?3000:k<24?6000:3000;const {frames}=replay({count:40,lag});
  const warm=frames.filter(f=>f.warm);
  assert.ok(warm.every(f=>f.delay<=5.5),'delay bounded even while transport is slow');
  assert.ok(warm.slice(-5).every(f=>f.delay<=4),'delay shrinks after transport recovers');
  const d=deltas(warm);
  assert.ok(d.every(v=>v>=0),'no backward motion while the clock adapts');
  assert.ok(Math.max(...d)<=10*2.05,'recovered time is caught up at most at twice real speed');
  assert.ok(d.some(v=>v>10*1.5),'the display does catch up instead of keeping the extra delay');
});
test('absent entities are removed and entities re-added start a fresh ring',()=>{
  const samples=new DisplaySamples();samples.replace(snapshot(1,0),3000);samples.replace(snapshot(2,2.5,[]),5500);
  assert.equal(samples.entries.size,0);assert.equal(samples.position('a',6000),null);
  samples.replace(snapshot(3,5),8000);assert.deepEqual(samples.position('a',8000),[500,0,0]);
});

test('10 Hz native UAM display uses a small adaptive buffer, including accelerated playback',()=>{
  for(const rate of [1,10]){
    const samples=new DisplaySamples();let last=-Infinity;const delays=[];
    for(let now=0;now<5000;now+=20){
      const t=now/1000*rate;
      if(now%100===0)samples.replace({...snapshot(now+1,t,[sample(t,{kind:'uam',source:'scenario',
        velocity_ecef_mps:[100,0,0]})]),clock_rate:rate},now);
      const x=samples.position('a',now)[0];
      assert.ok(x>=last && x<=samples.stateTime*100+1e-6);last=x;
      if(now>2000)delays.push(now/1000-x/100/rate);
    }
    assert.ok(Math.max(...delays)<.18,'stable native transport should not impose half a second of delay');
    assert.ok(Math.min(...delays)>.1,'still enough history to interpolate between real states');
  }
});

test('native velocity interpolation reconstructs acceleration and clamps corrupt slopes',()=>{
  const samples=new DisplaySamples();
  const native=(t,x,v)=>sample(t,{kind:'uam',source:'scenario',position_ecef_m:[x,0,0],velocity_ecef_mps:[v,0,0]});
  samples.replace(snapshot(1,0,[native(0,0,0)]),0);
  samples.replace(snapshot(2,1,[native(1,1,2)]),1000);
  assert.ok(Math.abs(samples.positionAt('a',.5)[0]-.25)<1e-8,'reconstructs x=t² between measured endpoints');
  samples.replace(snapshot(3,2,[native(2,2,10000)]),2000);
  for(let t=1;t<=2;t+=.01)assert.ok(samples.positionAt('a',t)[0]>=1 && samples.positionAt('a',t)[0]<=2);
  assert.deepEqual(samples.positionAt('a',500),[2,0,0]);
});

test('background aircraft interpolate their own 1 Hz states inside a 10 Hz Physical stream',()=>{
  const samples=new DisplaySamples();const frames=[];
  for(let now=0;now<=14000;now+=20){
    if(now%100===0){
      const own=Math.floor(now/1000);
      samples.replace(snapshot(now+1,now/1000,[sample(own,{source:'opensky',state_time:own})]),now);
    }
    const x=samples.position('a',now)[0];
    if(now>6000)frames.push({x});
  }
  const d=deltas(frames);
  assert.ok(d.every(v=>v>1.99 && v<2.01),'100 m/s advances 2 m every frame, not hold/burst');
  assert.equal(samples.entries.get('a').time(0),14);
  assert.equal(samples.entries.get('a').time(1),13,'repeated packets do not evict useful history');
  assert.equal(samples.position('a',100000)[0],1400,'no extrapolation during source outage');
});

test('background timing is independent from fast Physical and other source clocks',()=>{
  const samples=new DisplaySamples();const frames=[];
  for(let now=0;now<=12000;now+=20){
    if(now%100===0){
      const own=Math.floor(now/1000),sat=Math.floor(now/2000)*2;
      samples.replace(snapshot(now+1,now/1000,[sample(own,{source:'opensky',state_time:own}),
        sample(sat,{entity_id:'sat',kind:'satellite',source:'celestrak',state_time:sat}),
        sample(now/1000,{entity_id:'physical',kind:'uam',source:'physical_uam',state_time:now/1000})]),now);
    }
    const x=samples.position('a',now)[0],sat=samples.position('sat',now)[0];
    if(now>6000)frames.push({x,sat});
  }
  assert.ok(deltas(frames).every(v=>Math.abs(v-2)<1e-6));
  assert.ok(frames.slice(1).every((f,i)=>Math.abs(f.sat-frames[i].sat-2)<1e-6));
  assert.equal(samples.entries.get('physical').clock,null);
  assert.equal(samples.sourceClocks.size,2);
});

test('held discontinuity resets once and a new epoch clears background timing',()=>{
  const samples=new DisplaySamples();
  const packet=(seq,t,et,changes={})=>snapshot(seq,t,[sample(et,{source:'opensky',state_time:et,...changes})]);
  samples.replace(packet(1,0,0),0);
  samples.replace(packet(2,1,1,{discontinuity:true,continuity_id:1}),1000);
  samples.position('a',1000);
  samples.replace(packet(3,1.1,1,{discontinuity:true,continuity_id:1}),1100);
  assert.equal(samples.entries.get('a').count,1);
  samples.replace(packet(4,2,2,{continuity_id:1}),2000);
  assert.equal(samples.entries.get('a').count,2);
  samples.replace({...packet(1,0,0),epoch:1},3000);
  assert.equal(samples.entries.get('a').count,1);
  assert.equal(samples.sourceClocks.get('opensky').lastTime,0);
  assert.equal(samples.position('a',3000)[0],0);
});

test('background recovery after a long source outage resets instead of bridging minutes',()=>{
  const samples=new DisplaySamples();
  for(let now=0;now<=20000;now+=100){
    const own=now<1000?0:now<20000?1:20;
    samples.replace(snapshot(now+1,now/1000,[sample(own,{source:'opensky',state_time:own})]),now);
    samples.position('a',now);
  }
  assert.equal(samples.entries.get('a').count,1);
  assert.equal(samples.position('a',20000)[0],2000);
});

test('scenario playback does not alternate holds and bursts when delivered rate is below requested 2x',()=>{
  const samples=new DisplaySamples();const frames=[];let t=0;
  for(let now=0;now<=20000;now+=20){
    if(now%300===0){t+=.25;samples.replace({...snapshot(now+1,t,[sample(t,{kind:'uam',source:'scenario'})]),clock_rate:2},now);}
    const x=samples.position('a',now)[0];
    if(now>6000)frames.push({x});
    assert.ok(x<=t*100+1e-8,'display must not invent future position');
  }
  const d=deltas(frames);
  assert.ok(d.every(v=>v>0.5 && v<3),'delayed but continuous motion rather than freeze/catch-up');
});

test('scenario display recovers throughput, respects speed changes/pause and resets on seek',()=>{
  const samples=new DisplaySamples();let t=1000000,last=-Infinity,lastClock=-Infinity;const delays=[];
  for(let now=0;now<=24000;now+=20){
    const rate=now<14000?2:now<16000?0:4;
    if(now%100===0){
      t+=(now<6000?.8:rate)*.1;
      samples.replace({...snapshot(now+1,t,[sample(t,{kind:'uam',source:'scenario'})]),clock_rate:rate},now);
    }
    const p=samples.position('a',now)[0]/100,clock=samples.clockTime(now);
    assert.ok(p>=last-1e-8 && p<=t+1e-8);last=p;
    assert.ok(clock>=lastClock-1e-8 && clock<=t+1e-8);lastClock=clock;
    if(now>21000)delays.push((t-p)/rate);
  }
  assert.ok(Math.max(...delays)<.2,'buffer shrinks after normal throughput returns');
  samples.replace({...snapshot(1,100,[sample(100,{kind:'uam',source:'scenario'})]),clock_rate:2,epoch:1},25000);
  assert.equal(samples.position('a',25000)[0],10000,'seek starts a fresh display timeline');
  assert.equal(samples.clockTime(25000),100);
  assert.equal(samples.position('a',100000)[0],10000,'outage never extrapolates');
});

test('regular small packet delays do not modulate constant taxi speed every buffer window',()=>{
  const samples=new DisplaySamples(),speeds=[];let last=null,index=0;
  const arrivals=Array.from({length:501},(_,i)=>({t:i*.1,at:i*100+([0,15,35,5,50,0,20,5,80,0][i%10])}));
  for(let now=0;now<49000;now+=10){
    while(index<arrivals.length && arrivals[index].at<=now){const a=arrivals[index++];
      samples.replace({...snapshot(index,a.t,[sample(a.t,{kind:'uam',source:'scenario',flight_phase:'gate_out',velocity_ecef_mps:[100,0,0]})]),clock_rate:1},a.at);}
    const x=samples.position('a',now)[0];if(now>10000)speeds.push((x-last)/.01);last=x;
    assert.ok(x<=samples.stateTime*100+1e-6);
  }
  assert.ok(Math.min(...speeds)>90 && Math.max(...speeds)<110,`steady taxi: ${Math.min(...speeds)}..${Math.max(...speeds)} m/s`);
});
