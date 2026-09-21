import test from 'node:test';import assert from 'node:assert/strict';
import {pilotSigns,signMesh,VertiportPilotDetail} from '../../../../digital_twin/visualization/web/vertiport_pilot_detail.js';
import {rotateLayout} from '../../../../digital_twin/visualization/web/vertiport_paint.js';
const layout={frame:{heading_deg:0},platform:{corners_m:[[-45,-45],[45,-45],[45,45],[-45,45]]},fatos:[{id:'F7',center_m:[0,22],radius_m:9,safety_radius_m:12}],gates:[{id:'G12',marking:'G12',center_m:[0,-20],radius_m:7}],edges:[{width_m:8,points_m:[[0,-20],[0,22]]}]};
test('all signs preserve actual IDs and stay clear of the manoeuvring circles and taxiway',()=>{
 const signs=pilotSigns(layout);assert.deepEqual(signs.map(s=>s.id),['F7','G12']);
 for(const s of signs){assert.ok(Math.abs(s.center[0])>4+s.radius);for(const z of [...layout.fatos,...layout.gates])assert.ok(Math.hypot(s.center[0]-z.center_m[0],s.center[1]-z.center_m[1])>=(z.safety_radius_m??z.radius_m)+s.radius);}
});
test('signs follow rotated layouts and render three readable faces with finite geometry',()=>{
 const a=pilotSigns(layout),b=pilotSigns(rotateLayout(layout,90));for(let i=0;i<a.length;i++){assert.ok(Math.abs(a[i].center[0]+b[i].center[1])<1e-6);assert.ok(Math.abs(a[i].center[1]-b[i].center[0])<1e-6);}
 const m=signMesh(b,90);assert.ok(m.positions.every(Number.isFinite));assert.ok(m.indices.every(i=>i<m.positions.length/3));assert.equal(m.normals.length,m.positions.length);assert.ok(Math.max(...m.indices)<65536);
});
test('a completely occupied platform does not invent a sign inside its safety area',()=>{assert.deepEqual(pilotSigns({...layout,platform:{corners_m:[[-8,-8],[8,-8],[8,8],[-8,8]]},gates:[],fatos:[{id:'F1',center_m:[0,0],radius_m:10}]}),[]);});
test('close detail has a two-port bound, one build per tick, and frees hidden or removed resources',()=>{
 const removed=[],scene={camera:{positionWC:{x:0,y:0,z:0}},primitives:{remove:x=>removed.push(x)}};
 const C={Cartesian3:{fromDegrees:(x,y,z)=>({x,y,z}),distance:(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)}};
 const d=new VertiportPilotDetail(C,scene,()=>{});d.build=id=>({deck:id,sign:id+'sign'});
 for(let i=0;i<5;i++)d.set(String(i),{layout:{frame:{longitude:i*10,latitude:0}}},{},0);
 d.tick();assert.equal(d.ready.size,1);d.tick();d.tick();assert.equal(d.ready.size,2);
 d.setVisible(false);assert.equal(d.ready.size,0);assert.equal(removed.length,4);d.setVisible(true);d.tick();d.destroy();assert.equal(d.ready.size,0);assert.equal(d.records.size,0);
});
