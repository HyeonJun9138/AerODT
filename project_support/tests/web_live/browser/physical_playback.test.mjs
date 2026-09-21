import test from 'node:test';
import assert from 'node:assert/strict';
import {DisplaySamples} from '../../../../digital_twin/visualization/web/display_samples.js';

const entity=(t,x,current=x,context='p:m')=>({entity_id:'physical:A',kind:'uam',source:'physical_uam',orientation_source:'attitude',
  state_time:t,position_ecef_m:[current,0,0],heading_deg:150,pitch_deg:40,roll_deg:20,continuity_id:1,
  display_observation:{time:t,observation_time:1000+t,context,clock:'physical',position_ecef_m:[x,0,0],
    velocity_ecef_mps:[10,0,0],heading_deg:359,pitch_deg:2,roll_deg:1,tilt_deg:70,rotor_radps:200,surface_reference:null}});
function push(b,e,i,now){b.replace({sequence:i,state_time:1000+now/1000,entities:[e]},now);}

test('coasting/current-time sawtooth is excluded from the physical display buffer',()=>{
  const b=new DisplaySamples();let last=-Infinity,back=0,moved=0,stop=0;
  for(let frame=0;frame<900;frame++){
    const now=frame*1000/60;
    if(frame%6===0){const fix=Math.floor(frame/30)*.25;push(b,entity(fix,fix*10,fix*10+(frame%30)*2),frame+1,now);}
    const x=b.position('physical:A',now)[0];if(x<last-.001)back++;if(x>last+.001)moved++;else stop++;last=x;
    assert.equal(b.telemetryAt('physical:A',b.renderTime('physical:A')).pitch_deg,2);
  }
  assert.equal(back,0);assert.ok(moved>750,{moved,stop});assert.ok(last<=72.5);
  assert.equal(b.entries.get('physical:A').count,30,'one entry per accepted observation');
});
test('long outages hold the final observation, then restart without sweeping unobserved distance',()=>{
  const b=new DisplaySamples();push(b,entity(1,10),1,0);push(b,entity(2,20),2,1000);
  for(let n=0;n<1000;n++)b.position('physical:A',n*20);
  assert.equal(b.position('physical:A',20000)[0],20);
  push(b,entity(30,300),3,20010);assert.equal(b.position('physical:A',20010)[0],300);
  push(b,entity(0,500,600,'p:newmission'),4,20100);assert.equal(b.position('physical:A',20100)[0],500);
});
test('repeated discontinuity and stale states do not flush accepted observation history',()=>{
  const b=new DisplaySamples();for(let i=0;i<8;i++)push(b,{...entity(i*.2,i*2),discontinuity:i===7},i+1,i*300);
  const count=b.entries.get('physical:A').count;
  for(let i=0;i<10;i++)push(b,{...entity(1.4,14),discontinuity:true,quality:'stale'},20+i,2500+i*100);
  assert.equal(b.entries.get('physical:A').count,count);
});

test('held stale snapshots beyond ten seconds never replay the old segment',()=>{
  const b=new DisplaySamples();push(b,entity(1,10),1,0);push(b,entity(2,20),2,1000);
  for(let now=1000;now<30000;now+=20){
    if(now%100===0)push(b,{...entity(2,20),quality:'stale'},now,now);
    b.position('physical:A',now);
  }
  assert.equal(b.entries.get('physical:A').count,2);
  assert.equal(b.position('physical:A',30000)[0],20);
});

test('clock remapping preserves the motion cursor and translates overlay UTC',()=>{
  const b=new DisplaySamples();push(b,entity(1,10),1,0);push(b,entity(2,20),2,1000);
  for(let now=1000;now<1600;now+=20)b.position('physical:A',now);
  const t=b.renderTime('physical:A'),utc=b.observationTime('physical:A'),e=entity(2,20);
  e.display_observation.observation_time+=3;push(b,e,3,1600);
  assert.equal(b.renderTime('physical:A'),t);
  assert.equal(b.observationTime('physical:A'),utc+3);
  assert.equal(b.entries.get('physical:A').count,2);
});

test('a legitimate reversal and heading wrap remain visible between bounded endpoints',()=>{
  const b=new DisplaySamples();
  for(let i=0;i<6;i++){
    const e=entity(i,i<=3?i*10:60-i*10);e.display_observation.heading_deg=i<3?359:1;
    e.display_observation.velocity_ecef_mps=[i<3?10:-10,0,0];push(b,e,i+1,i*500);
  }
  assert.ok(b.positionAt('physical:A',4.5)[0]<b.positionAt('physical:A',3.5)[0]);
  for(let t=0;t<5;t+=.01){assert.ok(b.positionAt('physical:A',t)[0]>=0 && b.positionAt('physical:A',t)[0]<=30);}
  assert.ok(Math.abs((b.headingAt('physical:A',2.5)+180)%360-180)<2);
});

test('worker transport retains accepted observation metadata and independent source removal',async()=>{
  const {SnapshotEncoder,SnapshotDecoder}=await import('../../../../communication/browser/snapshot_codec.js');
  const e=entity(1,10);const snapshot={schema_version:1,sequence:1,state_time:1001,entities:[e],sources:[]};
  const decoded=new SnapshotDecoder().decode(new SnapshotEncoder().encode(snapshot));
  assert.deepEqual(decoded.entities[0].display_observation,e.display_observation);
  const b=new DisplaySamples();b.replace(decoded,0);
  b.replace({...snapshot,sequence:2,state_time:1002,entities:[]},1000);
  assert.equal(b.position('physical:A',1000),null);
});
