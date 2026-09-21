import test from 'node:test';
import assert from 'node:assert/strict';
import {CockpitEnvironment} from '../../../../digital_twin/visualization/web/cockpit_environment.js';

function fixture(){
 const stages=[];
 const scene={globe:{enableLighting:false},skyAtmosphere:{perFragmentAtmosphere:false,saturationShift:.04,brightnessShift:.02,atmosphereMieAnisotropy:.9},
  shadowMap:{enabled:false,size:2048,maximumDistance:5000,softShadows:false,darkness:.3},
  postProcessStages:{add:s=>{stages.push(s);return s;},remove:s=>{stages.splice(stages.indexOf(s),1);return true;}}};
 const C={PostProcessStage:class{constructor(o){Object.assign(this,o);this.enabled=true;}}};
 return {scene,stages,view:new CockpitEnvironment(C,scene)};
}
test('enter/exit restores the exact operator sky and shadow settings, including repeated entry',()=>{
 const {view,scene,stages}=fixture(),sky={...scene.skyAtmosphere},shadow={...scene.shadowMap};
 for(let i=0;i<3;i++){
  view.update(true);assert.equal(scene.skyAtmosphere.perFragmentAtmosphere,true);
  assert.equal(scene.shadowMap.enabled,true);assert.ok(scene.shadowMap.maximumDistance<=250);
  for(let frame=0;frame<100;frame++)view.update(true);
  assert.equal(stages.length,1);view.update(false);
  assert.deepEqual(scene.skyAtmosphere,sky);assert.deepEqual(scene.shadowMap,shadow);assert.equal(stages[0].enabled,false);
 }
 view.destroy();assert.equal(stages.length,0);view.destroy();
});
test('a live sunlight toggle changes cloud illumination without rebuilding or changing the clock',()=>{
 const {view,scene,stages}=fixture();const clock={currentTime:123};scene.clock=clock;
 view.update(true);assert.equal(stages[0].uniforms.inspectionDay(),1);
 scene.globe.enableLighting=true;view.update(true);assert.equal(stages[0].uniforms.inspectionDay(),0);
 assert.equal(stages.length,1);assert.deepEqual(clock,{currentTime:123});
 view.update(false);assert.equal(scene.globe.enableLighting,true);
});
test('destroy while active restores settings and removes the GPU stage',()=>{
 const {view,scene,stages}=fixture();view.update(true);view.destroy();
 assert.equal(scene.shadowMap.enabled,false);assert.equal(scene.skyAtmosphere.saturationShift,.04);
 assert.equal(stages.length,0);assert.equal(view.active,false);
});
test('missing atmosphere/render support leaves a usable map',()=>{
 const scene={};const view=new CockpitEnvironment({},scene);view.update(true);assert.equal(view.active,false);view.destroy();
 const minimal={skyAtmosphere:{perFragmentAtmosphere:false}};
 const fallback=new CockpitEnvironment({},minimal);fallback.update(true);fallback.update(false);
 assert.equal(minimal.skyAtmosphere.perFragmentAtmosphere,false);
});

test('fleet cockpit adds no shadow map or full-screen cloud pass and preserves operator settings',()=>{
 const {view,scene,stages}=fixture(),sky={...scene.skyAtmosphere},shadow={...scene.shadowMap};
 view.update(true,{economy:true});assert.equal(stages.length,0);assert.deepEqual(scene.shadowMap,shadow);
 assert.equal(scene.skyAtmosphere.perFragmentAtmosphere,sky.perFragmentAtmosphere);
 for(let i=0;i<100;i++)view.update(true,{economy:false});
 assert.equal(stages.length,0,'recovered FPS cannot keep recompiling the expensive effect');
 view.update(false);assert.deepEqual(scene.shadowMap,shadow);assert.deepEqual(scene.skyAtmosphere,sky);
 view.update(true);assert.equal(stages.length,1,'a new cockpit session can use normal effects');view.destroy();
});

test('busy rich cockpit sheds only its own effects and exit restores original values',()=>{
 const {view,scene,stages}=fixture(),sky={...scene.skyAtmosphere},shadow={...scene.shadowMap};
 view.update(true);view.update(true,{economy:true});assert.equal(stages[0].enabled,false);
 assert.deepEqual(scene.shadowMap,shadow);
 for(let i=0;i<100;i++)view.update(true);assert.equal(stages.length,1);assert.equal(stages[0].enabled,false);
 view.update(false);assert.deepEqual(scene.skyAtmosphere,sky);assert.deepEqual(scene.shadowMap,shadow);
 view.destroy();assert.equal(stages.length,0);
});
