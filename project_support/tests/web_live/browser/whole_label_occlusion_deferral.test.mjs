// The occlusion sweep is asked for in postRender but runs in the next task,
// so its depth reads wait for the GPU outside the frame's own task.
import test from 'node:test';
import assert from 'node:assert/strict';
import {WholeLabelOcclusion} from '../../../../digital_twin/visualization/web/whole_label_occlusion.js';

function fixture(){
 const reads=[];
 const scene={mode:3,pickPositionSupported:true,pickPosition:p=>{reads.push([p.x,p.y]);return {x:0,y:0,z:50};}};
 const viewer={scene,camera:{positionWC:{x:0,y:0,z:0},directionWC:{x:0,y:0,z:1}},canvas:{clientWidth:800,clientHeight:600}};
 const C={Cartesian2:class{constructor(x,y){this.x=x;this.y=y;}},SceneTransforms:{worldToWindowCoordinates:()=>({x:400,y:300})},SceneMode:{SCENE2D:2}};
 const items=new Map([[0,{entity:{kind:'uam'},lod:'model',position:{x:0,y:0,z:100},labelRect:{width:40,height:16},label:{text:'UAM',show:true}}]]);
 const queued=[];
 const check=new WholeLabelOcclusion(C,viewer,items);
 check.defer=fn=>{queued.push(fn);return queued.length;};
 return {reads,items,item:items.get(0),check,queued,collection:null};
}

test('a scheduled sweep reads nothing until its task runs, then hides the blocked name',()=>{
 const f=fixture();
 f.check.schedule();
 assert.equal(f.reads.length,0,'postRender itself reads no depth');
 assert.equal(f.queued.length,1);
 f.check.schedule();f.check.schedule();
 assert.equal(f.queued.length,1,'one task at a time');
 f.queued[0]();
 assert.ok(f.reads.length>0);
 assert.equal(f.item.label.show,false);
 f.check.schedule();
 assert.equal(f.queued.length,2,'after it ran, the next frame may ask again');
});

test('operator motion is answered at once and makes a queued sweep a no-op',()=>{
 const f=fixture();
 f.check.schedule();
 f.check.schedule({moving:true});
 assert.equal(f.check.pending,null);
 f.queued[0]();
 assert.equal(f.reads.length,0,'the stale task reads nothing');
 f.check.schedule({moving:()=>false});
 assert.equal(f.queued.length,2);
 f.queued[1]();
 assert.ok(f.reads.length>0,'a fresh task after the motion reads again');
});

test('a task that runs at once leaves nothing marked as queued, and a disposed check never reads',()=>{
 const f=fixture();
 f.check.defer=fn=>{fn();};
 f.check.schedule();
 assert.ok(f.reads.length>0);
 assert.equal(f.check.deferred,null);
 const g=fixture();
 g.check.schedule();
 g.check.dispose();
 g.queued[0]();
 assert.equal(g.reads.length,0);
 g.check.schedule();
 assert.equal(g.queued.length,1,'nothing more is queued once disposed');
});

test('the production scheduler is a macrotask, not the render task',()=>{
 const f=fixture();
 const fresh=new WholeLabelOcclusion(f.check.C,f.check.viewer,f.items);
 assert.equal(typeof fresh.defer,'function');
 let ran=false;
 const token=fresh.defer(()=>{ran=true;});
 assert.equal(ran,false,'not run synchronously');
 assert.ok(token!==undefined);
 return new Promise(resolve=>setTimeout(()=>{assert.equal(ran,true);resolve();},20));
});
