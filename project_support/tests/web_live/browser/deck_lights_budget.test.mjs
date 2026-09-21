import test from 'node:test';
import assert from 'node:assert/strict';
import {DeckLights,LIGHT_FAR_METRES,LIGHT_ALPHA_STEPS} from '../../../../digital_twin/visualization/web/deck_lights.js';

class Points {items=[];add(item){this.items.push(item);return item;}remove(item){this.items=this.items.filter(i=>i!==item);}}
const color=(css,alpha=1)=>({css,alpha,withAlpha(a){return color(css,a);}});
const C={PointPrimitiveCollection:Points,Color:{fromCssColorString:css=>color(css)},
 NearFarScalar:class{constructor(...a){this.a=a;}},DistanceDisplayCondition:class{constructor(near,far){Object.assign(this,{near,far});}}};
const layout={lighting:{fato_perimeter:{colour:'green',spacing_m:5,minimum:8},taxiway_centreline:{colour:'green',spacing_m:12},
 taxiway_edge:{colour:'blue',spacing_m:18},beacon:{colour:'white',period_s:2,flash_s:.35,center_m:[0,26]}},
 fatos:[{id:'F1',center_m:[-18,15],radius_m:9}],edges:[{id:'E1',width_m:8.4,points_m:[[-10,-15],[-10,30]]}]};
function lit(cameraAt){
 const scene={primitives:{add:p=>p,remove(){}},camera:{positionWC:cameraAt}};
 const lights=new DeckLights(C,scene);
 // One world position per lamp, all standing near the origin of a deck at x=0.
 lights.set('vp',layout,Array.from({length:64},(_,i)=>({x:i,y:0,z:0})));
 return lights;
}

test('a deck too far away to show a lamp is not recoloured at all',()=>{
 const lights=lit({x:LIGHT_FAR_METRES*3,y:0,z:0});
 const colours=lights.points.items.map(p=>p.color);
 assert.equal(lights.tick(.7),false,'nothing on screen changed');
 assert.deepEqual(lights.points.items.map(p=>p.color),colours,'no lamp was touched');
});

test('a deck the camera can see breathes, in steps, and only the lamps whose step moved are written',()=>{
 const lights=lit({x:0,y:0,z:500});
 assert.equal(lights.tick(.7),true);
 const first=lights.points.items.map(p=>p.color);
 assert.equal(lights.tick(.7+1e-4),false,'a tenth of a millisecond later no step has moved');
 assert.deepEqual(lights.points.items.map(p=>p.color),first,'the same colour objects: nothing allocated for nothing');
 assert.equal(lights.tick(.7+1.2),true);
 const later=lights.points.items.map(p=>p.color.alpha);
 assert.ok(later.some((a,i)=>a!==first[i].alpha),'the field is alive');
 assert.ok(later.every(a=>Math.abs(a*LIGHT_ALPHA_STEPS-Math.round(a*LIGHT_ALPHA_STEPS))<1e-9),'brightness is quantised so the eye sees a breath and the GPU sees a few uploads');
 assert.ok(LIGHT_ALPHA_STEPS>=16,'fine enough that the steps do not read as flicker');
});

test('a camera the scene does not know about is treated as near, so a stub scene still lights up',()=>{
 const lights=new DeckLights(C,{primitives:{add:p=>p,remove(){}}});
 lights.set('vp',layout,[{x:0,y:0,z:0},{x:1,y:0,z:0}]);
 assert.equal(lights.tick(.3),true);
});
