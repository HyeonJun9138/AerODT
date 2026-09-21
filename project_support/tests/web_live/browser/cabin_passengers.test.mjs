import test from 'node:test';import assert from 'node:assert/strict';
import {cabinAt,showCabin,showDoors} from '../../../../digital_twin/visualization/web/cabin_passengers.js';
const walk={phase:'boarding',elapsed_s:0,walk:{release_s:[2,4,6],walk_s:10,enter_s:1,duration_s:19,door_side:-1}};
test('seat changes occur at the door; rewind and multiple aircraft remain independent',()=>{
 assert.deepEqual(cabinAt(null,{...walk,elapsed_s:12}).seats,[]);
 assert.deepEqual(cabinAt(null,{...walk,elapsed_s:13}).seats,[0]);
 assert.deepEqual(cabinAt(null,{...walk,elapsed_s:17}).seats,[0,1,2]);
 assert.deepEqual(cabinAt(null,{...walk,phase:'alighting',elapsed_s:4}).seats,[2]);
 assert.deepEqual(cabinAt(null,walk).seats,[]);
 assert.deepEqual(cabinAt({on_board:2}).seats,[0,1]);
});
test('door opens before first passenger release and closes before taxi',()=>{
 assert.equal(cabinAt(null,walk).open,0);
 assert.equal(cabinAt(null,{...walk,elapsed_s:2}).open,1);
 assert.equal(cabinAt(null,{...walk,elapsed_s:19}).open,0);
 assert.equal(cabinAt(null,walk).side,-1);
});
test('only occupied seat nodes appear, camera seat hidden, correct door only',()=>{
 const nodes=Object.fromEntries(['a','b','c','left','right'].map(k=>[k,{originalMatrix:{}}]));
 const C={Cartesian3:class{},Matrix4:class{static multiplyByScale(){return 'size'}static multiply(a,b){return b}static fromRotationTranslation(r){return r}},Matrix3:{fromRotationY:x=>x}};
 const model={ready:true,getNode:n=>nodes[n]},profile={occupant_nodes:['a','b','c'],ground_door:{nodes:{left:'left',right:'right'},open_deg:78}};
 showCabin(C,model,profile,[0,2],{ownSeat:'a'});
 assert.equal(nodes.a.show,false);assert.equal(nodes.b.show,false);assert.equal(nodes.c.show,true);
 // `right` is the starboard hatch and swings positive, `left` the port hatch
 // and negative, so each free edge travels away from the fuselage. The side
 // that is not being used stays shut. Both halves are pinned here because
 // the two keys once named the nodes on the opposite sides, which opened the
 // door away from the stairs and the queue.
 showDoors(C,model,profile,{side:-1,open:1});
 assert.ok(nodes.left.matrix<0,'the port hatch swings outward');
 assert.equal(nodes.right.matrix,0,'the starboard hatch stays shut');
 showDoors(C,model,profile,{side:1,open:1});
 assert.ok(nodes.right.matrix>0,'the starboard hatch swings outward');
 assert.equal(nodes.left.matrix,0,'the port hatch stays shut');
 showDoors(C,model,profile,{side:1,open:0});assert.equal(Math.abs(nodes.right.matrix),0);
 showCabin(C,model,profile,[]);assert.equal(nodes.c.show,false);
});
