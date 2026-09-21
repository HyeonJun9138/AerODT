import test from 'node:test';
import assert from 'node:assert/strict';
import {AirframeCamera} from '../../../../digital_twin/visualization/web/airframe_camera.js';

function fixture(){
  const camera=Object.create(AirframeCamera.prototype);
  Object.assign(camera,{enabled:true,widget:{},canvas:{ownerDocument:{hidden:false}},last:-Infinity,interval:60,generation:1,
    globe:{C:{Matrix4:{clone:matrix=>matrix.slice()}}}});
  const rendered=[];camera.renderFrame=frame=>rendered.push(frame);
  return {camera,rendered};
}
const flush=()=>new Promise(resolve=>setTimeout(resolve,10));

test('secondary scene waits until main render returns and coalesces latest immutable pose',async()=>{
  const {camera,rendered}=fixture();
  camera.update({matrix:[1],profile:{}},100);
  const matrix=[2];camera.update({matrix,profile:{}},101);matrix[0]=99;
  assert.equal(rendered.length,0,'must not render inside main postRender');
  await flush();assert.equal(rendered.length,1);assert.equal(rendered[0].matrix[0],2);
});
test('power off cancels queued secondary render',async()=>{
  const {camera,rendered}=fixture();camera.update({matrix:[1]},100);camera.stop();
  await flush();assert.equal(rendered.length,0);assert.equal(camera.pendingFrame,null);
});
test('generation changes prevent a queued frame rendering a replacement context',async()=>{
  const {camera,rendered}=fixture();camera.update({matrix:[1]},100);camera.generation++;
  await flush();assert.equal(rendered.length,0);
});
