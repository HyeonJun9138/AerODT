import test from 'node:test';
import assert from 'node:assert/strict';
import {CameraSpringArm} from '../../../../digital_twin/visualization/web/camera_spring_arm.js';
const p=x=>({x,y:0,z:0});
test('spring absorbs a position step without oscillation and settles',()=>{
 const s=new CameraSpringArm();s.update(p(0),0,'a');let last=0;
 for(let t=16;t<=1500;t+=16){const v=s.update(p(10),t,'a');assert.ok(v.x>=last-1e-8&&v.x<=10);last=v.x;}
 assert.ok(last>9.999);
});
test('same frame is stable; epoch/target switch and long frame gap reset',()=>{
 const s=new CameraSpringArm();s.update(p(0),0,'a');const x=s.update(p(10),16,'a').x;
 assert.equal(s.update(p(10),16,'a').x,x);
 assert.equal(s.update(p(100),32,'b').x,100);
 assert.equal(s.update(p(300),2000,'b').x,300);
 s.reset();assert.equal(s.update(p(50),2016,'b').x,50);
});
test('constant motion is frame-rate independent and speedup lag stays bounded',()=>{
 const run=hz=>{const s=new CameraSpringArm();s.update(p(0),0,'a');for(let i=1;i<=hz*2;i++)s.update(p(i/hz*100),i/hz*1000,'a');return s.position.x;};
 assert.ok(Math.abs(run(30)-run(144))<1e-6);
 const s=new CameraSpringArm();s.update(p(0),0,'a');
 for(let i=1;i<180;i++){const x=i*100;assert.ok(x-s.update(p(x),i*16,'a',20).x<=20.00001);}
});
test('camera smoothing never mutates displayed aircraft position',()=>{
 const s=new CameraSpringArm(),target=Object.freeze(p(12));s.update(p(0),0,'a');s.update(target,16,'a');assert.equal(target.x,12);
});

test('8 Hz small aircraft vibration is attenuated without smoothing the aircraft',()=>{
 const s=new CameraSpringArm();s.update(p(0),0,'a');let input=0,output=0;
 for(let i=1;i<=240;i++){const x=Math.sin(2*Math.PI*8*i/60);const filtered=s.update(p(x),i/60*1000,'a').x;
  if(i>60){input+=x*x;output+=filtered*filtered;}}
 assert.ok(Math.sqrt(output/input)<.1);
});
