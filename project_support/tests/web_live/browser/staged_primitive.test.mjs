import test from 'node:test';
import assert from 'node:assert/strict';
import {StagedPrimitive} from '../../../../digital_twin/visualization/web/staged_primitive.js';
import {configureTerrainStreaming} from '../../../../digital_twin/visualization/web/terrain_layer.js';
const child=()=>({ready:false,updates:0,draws:0,destroyed:0,update(){this.updates++;if(this.show)this.draws++;this.ready=true;},destroy(){this.destroyed++;}});
const frame=n=>({frameNumber:n,passes:{render:true}});
test('dense cell uploads one child per render frame, including while hidden',()=>{
 const parts=Array.from({length:8},child),p=new StagedPrimitive(parts);p.show=false;
 for(let i=0;i<8;i++){
  p.update(frame(i));p.update(frame(i));
  assert.equal(parts.filter(c=>c.updates>0).length,i+1);
  assert.equal(p.ready,i===7);assert.equal(parts.reduce((n,c)=>n+c.draws,0),0);
 }
 p.show=true;p.update(frame(9));assert.ok(parts.every(c=>c.draws===1));
 p.destroy();p.destroy();assert.ok(parts.every(c=>c.destroyed===1));
 assert.equal(p.isDestroyed(),true);p.update(frame(10));assert.ok(parts.every(c=>c.draws===1));
});
test('several compiling cells share one allowance without pausing resident drawing',()=>{
 const gate={},aParts=[child(),child()],bParts=[child(),child()];
 const a=new StagedPrimitive(aParts,gate),b=new StagedPrimitive(bParts,gate);
 a.update(frame(0));b.update(frame(0));assert.equal(bParts[0].updates,0);
 a.update(frame(1));b.update(frame(1));assert.equal(bParts[0].updates,0);
 a.update(frame(2));b.update(frame(2));assert.equal(bParts[0].updates,1);
 assert.ok(aParts.every(c=>c.draws>=2),'ready geometry still draws each frame');
 b.update({frameNumber:3,passes:{render:false,pick:true}});assert.equal(bParts[1].updates,0);
 b.update(frame(3));assert.equal(b.ready,true);
});
test('an asynchronous child must become ready before the next begins',()=>{
 const first=child(),last=child();first.update=function(){this.updates++;};
 const p=new StagedPrimitive([first,last]);p.update(frame(0));p.update(frame(1));
 assert.equal(last.updates,0);first.ready=true;p.update(frame(2));assert.equal(last.updates,0);
 p.update(frame(3));assert.equal(last.updates,1);assert.equal(p.ready,true);
});
test('map loading slice shrinks without changing imagery quality or assuming private field exists',()=>{
 const g={_surface:{_loadQueueTimeSlice:5,_updateHeightsTimeSlice:2}};configureTerrainStreaming(g);
 assert.equal(g._surface._loadQueueTimeSlice,1);assert.equal(g._surface._updateHeightsTimeSlice,2);
 assert.equal(g.maximumScreenSpaceError,2);assert.equal(g.preloadSiblings,false);
 const missing={};configureTerrainStreaming(missing);assert.equal(missing._surface,undefined);
 const smaller={_surface:{_loadQueueTimeSlice:.5}};configureTerrainStreaming(smaller);assert.equal(smaller._surface._loadQueueTimeSlice,.5);
});
