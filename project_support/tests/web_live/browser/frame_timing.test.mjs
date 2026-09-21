import test from 'node:test';
import assert from 'node:assert/strict';
import {FrameTiming} from '../../../../digital_twin/visualization/web/frame_timing.js';
test('frame telemetry measures rolling frame interval and excludes first sample',()=>{
 const timing=new FrameTiming();timing.record(0);
 for(let i=1;i<=60;i++)timing.record(i*1000/60);
 const stats=timing.summary();assert.ok(Math.abs(stats.fps-60)<.001);assert.ok(Math.abs(stats.frameMs-1000/60)<.001);
 assert.ok(stats.p95Ms<17);assert.equal(stats.samples,60);
});
test('median used for adaptive LOD is not skewed by a single browser scheduling pause',()=>{
 const t=new FrameTiming();t.record(0);
 for(let i=1;i<60;i++)t.record(i*20);
 t.record(2180);const s=t.summary();assert.equal(s.p50Ms,20);assert.ok(s.frameMs>35);
});
test('per-frame consumers share one bounded-cadence percentile calculation',()=>{
 const t=new FrameTiming();t.record(0);t.record(16);const first=t.summary();
 for(let now=32;now<200;now+=16){t.record(now);assert.equal(t.summary(),first);}
 t.record(240);assert.notEqual(t.summary(),first);assert.equal(t.summary().samples,13);
});
test('navigation load signal responds to recent frames and ignores a background gap',()=>{
 const t=new FrameTiming();let now=0;t.record(now);
 for(let i=0;i<120;i++){now+=16;t.record(now);}
 for(let i=0;i<6;i++){now+=33;t.record(now);}
 assert.ok(t.recentMs>29);assert.equal(t.summary().p50Ms,16);
 const recent=t.recentMs;t.record(now+1000);assert.equal(t.recentMs,recent);
});
