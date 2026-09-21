import test from 'node:test';import assert from 'node:assert/strict';
import {boundsFor,clampRect,snapRect,snapTarget,resizeRect,readLayouts,placeRect} from '../../../../user_application/web/window_layout.js';
const area=boundsFor(1280,800,76);
test('side snapping leaves the centre free, lower row has three cells',()=>{
 const l=snapRect('left',area),r=snapRect('right',area);
 assert.ok(l.x+l.width<r.x);assert.ok(l.width<area.width*.4);
 for(const key of ['left-top','left-bottom','right-top','right-bottom','bottom-left','bottom-centre','bottom-right']){
  const p=snapRect(key,area);assert.ok(p.x>=area.x&&p.y>=area.y);assert.ok(p.x+p.width<=area.x+area.width+.01);assert.ok(p.y+p.height<=area.y+area.height+.01);
 }
 assert.equal(snapTarget({x:area.x+3,y:area.y+5},area),'left-top');
 assert.equal(snapTarget({x:640,y:area.y+area.height-2},area),'bottom-centre');
 assert.equal(snapTarget({x:640,y:300},area),null);
});
test('resize never loses title bar and small viewports override minimum dimensions',()=>{
 const p=resizeRect({x:100,y:100,width:400,height:300},'nw',-900,-900,area);
 assert.equal(p.x,area.x);assert.equal(p.y,area.y);
 const tiny=boundsFor(320,450,56),r=clampRect({x:9999,y:-20,width:900,height:900},tiny);
 assert.ok(r.width<=tiny.width&&r.height<=tiny.height&&r.x>=tiny.x&&r.y>=tiny.y);
});
test('corrupt layouts and blocked storage fail safely',()=>{
 assert.deepEqual(readLayouts({getItem:()=>'{bad'}),{});
 assert.deepEqual(readLayouts({getItem:()=>{throw Error('blocked');}}),{});
 assert.deepEqual(readLayouts({getItem:()=>JSON.stringify({version:1,windows:{a:{x:null,y:4,width:400,height:300}}})}),{});
});
test('opening a new panel uses an empty region before overlapping',()=>{
 const occupied=[snapRect('left',area)];const next=placeRect({width:350,height:300},area,occupied);
 assert.ok(next.x>=occupied[0].x+occupied[0].width);
});

test('small screens use a readable bottom strip and arranging ignores old coordinates',()=>{
 const a=boundsFor(500,700);const r=snapRect('bottom-centre',a);assert.equal(r.width,a.width);assert.equal(r.x,a.x);
 assert.deepEqual(placeRect({x:900,y:500,width:300,height:200},a),{x:a.x,y:a.y,width:300,height:200});
});
