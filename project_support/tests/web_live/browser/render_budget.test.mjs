import test from 'node:test';
import assert from 'node:assert/strict';
import {CameraRenderBudget} from '../../../../digital_twin/visualization/web/render_budget.js';
test('cockpit translation does not lower clarity when head pose is unchanged',()=>{const b=new CameraRenderBudget();b.configure({minimumScale:.7,targetFps:60});const c={positionWC:{x:0,y:0,z:0},directionWC:{x:1,y:0,z:0},upWC:{x:0,y:0,z:1}};for(let now=0;now<3000;now+=33){c.positionWC.x+=1;b.update(c,{now,frameMs:33,viewPose:[0,0,0,0,-.2,70,0,0,1]});}assert.equal(b.scale,1);assert.equal(b.moving,false);});

const camera=()=>({positionWC:{x:1,y:2,z:3},directionWC:{x:0,y:0,z:-1},upWC:{x:0,y:1,z:0}});
test('lens and orthographic zoom engage motion without camera translation',()=>{
 for(const key of ['fov','width','left','right','top','bottom']){
  const b=new CameraRenderBudget(),c=camera();c.frustum={[key]:1};
  for(let now=0;now<=1500;now+=50){c.frustum[key]+=.001;b.update(c,{now,frameMs:60});}
  assert.equal(b.moving,true,key);assert.equal(b.scale,.7,key);
  b.update(c,{now:2000,frameMs:16});assert.equal(b.moving,false,key);
 }
});
test('projection roundoff and first projection observation do not start motion',()=>{
 const b=new CameraRenderBudget(),c=camera();c.frustum={fov:1};
 for(let now=0;now<1000;now+=50){c.frustum.fov+=1e-8;b.update(c,{now,frameMs:60});}
 assert.equal(b.moving,false);assert.equal(b.scale,1);
});
test('motion budget reduces pixels only for sustained moving-camera load and restores crisp idle view',()=>{
 const b=new CameraRenderBudget(),c=camera();
 for(let now=0;now<=3000;now+=50){c.positionWC.x++;b.update(c,{now,frameMs:50});}
 assert.equal(b.scale,.7);assert.ok(b.scale*b.scale<.5,'half the moving-view pixels, not half the geometry');
 assert.equal(b.update(c,{now:3400,frameMs:50}),.7);
 // Still 50 ms a frame. Handing the whole buffer back the moment the camera
 // settles is what made this oscillate: the next touch of the camera took it
 // straight off again, so the buffer swung instead of settling.
 assert.equal(b.update(c,{now:3800,frameMs:50}),.7,'a display that still cannot pay does not get it back');
 assert.equal(b.update(c,{now:9000,frameMs:50}),.7,'and it does not get it back by waiting, either');
 // Once frames are cheap it climbs back, a step at a time.
 let scale=.7;for(let now=9400;now<=12000;now+=400)scale=b.update(c,{now,frameMs:14});
 assert.equal(scale,1,'and it does come all the way back');
});
test('fast motion, stationary GPU load and long scheduling gaps never blur the map',()=>{
 for(const kind of ['fast','idle','gap']){
  const b=new CameraRenderBudget(),c=camera();
  for(let now=0;now<6000;now+=100){if(kind!=='idle')c.positionWC.x++;b.update(c,{now,frameMs:kind==='gap'?1000:kind==='fast'?16:60});}
  assert.equal(b.scale,1,kind);
 }
});
test('isolated compilation stalls and coordinate roundoff do not trigger buffer resizing',()=>{
 const b=new CameraRenderBudget(),c=camera();
 for(let now=0;now<6000;now+=100){c.positionWC.x+=.00001;b.update(c,{now,frameMs:60});}
 assert.equal(b.scale,1);
 c.positionWC.x+=100;b.update(c,{now:6200,frameMs:70});
 assert.equal(b.update(c,{now:6300,frameMs:16}),1);
});
test('entry/morph disables adaptation and returns native resolution',()=>{
 const b=new CameraRenderBudget(),c=camera();
 for(let now=0;now<4000;now+=100){c.directionWC.x+=.001;b.update(c,{now,frameMs:50});}
 assert.equal(b.scale,.7);
 assert.equal(b.update(c,{now:4100,frameMs:50,enabled:false}),1);
});

test('rest after a scripted arrival never causes a delayed downscale and upscale',()=>{
 const b=new CameraRenderBudget(),c=camera();
 for(let now=0;now<=4300;now+=33){c.positionWC.x+=100;b.update(c,{now,frameMs:33,enabled:false});}
 for(let now=4300;now<=5500;now+=33){
  assert.equal(b.update(c,{now,frameMs:40}),1,'arrival layer work must keep its settled buffer');
  assert.equal(b.moving,false,'only actual operator movement starts a new navigation budget');
 }
 for(let now=5600;now<6100;now+=33){c.positionWC.x++;b.update(c,{now,frameMs:40});}
 assert.equal(b.moving,true);assert.equal(b.scale,.85,'subsequent real navigation still adapts');
});
test('approaching prepares the pixel budget immediately; idle restores native resolution',()=>{
 const b=new CameraRenderBudget(),c=camera();
 assert.equal(b.update(c,{now:0,frameMs:16,approaching:true}),.85);assert.equal(b.moving,true);
 // Cheap frames, so it climbs - but a step at a time, not a snap.
 assert.equal(b.update(c,{now:701,frameMs:16}),.9);assert.equal(b.moving,false);
 let scale=.9;for(let now=1101;now<=2200;now+=400)scale=b.update(c,{now,frameMs:16});
 assert.equal(scale,1);
});

test('the buffer settles instead of swinging when the camera is touched now and then',()=>{
 // Reported as the image going well, then not, then well again. Simulated
 // against this class before the restore was made gradual: a nudge every two
 // seconds swung the buffer 1.00-0.85-1.00 ten times in twelve seconds and
 // averaged 12.5 fps, against 15.9 fps for the same scene when the camera never
 // stopped and the buffer simply stayed down. Snapping back to full the instant
 // the camera settled put the whole cost on again every time.
 const b=new CameraRenderBudget(),c=camera();b.configure({minimumScale:.7,targetFps:30});
 let now=0,scale=1,flips=0,previous=1,direction=0;
 while(now<12000){
  // A frame costs less when the buffer is smaller; half of it is fixed.
  const frameMs=83*(.5+.5*scale*scale);
  now+=frameMs;
  if(now%2000<150)c.positionWC.x++;
  scale=b.update(c,{now,frameMs,relative:true});
  const step=Math.sign(scale-previous);
  if(step!==0&&direction!==0&&step!==direction)flips++;
  if(step!==0)direction=step;
  previous=scale;
 }
 assert.ok(flips<=1,`the buffer changed direction ${flips} times; it must settle, not oscillate`);
 assert.equal(scale,.7,'and it settles at the floor it was heading for');
});
test('tracking world translation is not mistaken for operator navigation',()=>{
 const b=new CameraRenderBudget(),c=camera();
 Object.assign(c,{position:{x:0,y:0,z:600},direction:{x:0,y:0,z:-1},up:{x:0,y:1,z:0}});
 for(let now=0;now<3000;now+=33){c.positionWC.x+=100;b.update(c,{now,frameMs:33,relative:true});}
 assert.equal(b.scale,1);assert.equal(b.moving,false);
 for(let now=3000;now<=3300;now+=33){c.position.x++;b.update(c,{now,frameMs:33,relative:true});}
 assert.equal(b.scale,.85,'actual orbit responds in hundreds of milliseconds, not several seconds');
 assert.equal(b.moving,true);
});

// Aircraft yaw must count even with a completely still head; translation must not.
test('cockpit body yaw engages streaming budget without head input or resolution preference changes',async()=>{
 const {cockpitBudgetPose}=await import('../../../../digital_twin/visualization/web/render_budget.js');
 const b=new CameraRenderBudget(),c=camera();c.frustum={fov:1.2};
 for(let now=0;now<2000;now+=50){
  const yaw=now*.00021;c.directionWC={x:Math.cos(yaw),y:Math.sin(yaw),z:0};
  c.upWC={x:0,y:0,z:1};c.positionWC.x+=2;
  b.update(c,{now,frameMs:60,relative:true,viewPose:cockpitBudgetPose(c)});
 }
 assert.equal(b.moving,true);assert.equal(b.scale,.7);
 const stable=new CameraRenderBudget();
 for(let now=0;now<2000;now+=50){c.positionWC.x+=2;stable.update(c,{now,frameMs:60,relative:true,viewPose:cockpitBudgetPose(c)});}
 assert.equal(stable.moving,false);assert.equal(stable.scale,1);
});
