import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {retainShaderPrograms,DEFAULT_RETAINED_PROGRAMS} from '../../../../digital_twin/visualization/web/shader_retention.js';

// A stand-in with Cesium 1.143's ShaderCache semantics: a program released by
// its last user waits in _shadersToRelease until the next frame destroys it;
// asking for the same source before that frame revives it. Measured on this
// machine, one D3D11 link wait is 50-1000 ms, which is the stutter a released
// program costs when its primitive comes back.
class FakeShaderCache {
 constructor(){this._shaders={};this._shadersToRelease={};this.compiles=0;this.destroyed=[];this._numberOfShaders=0;}
 getShaderProgram(keyword){
  let cached=this._shaders[keyword];
  if(cached)delete this._shadersToRelease[keyword];
  else{this.compiles++;cached={keyword,count:0,shaderProgram:{keyword,destroyed:false}};cached.shaderProgram._cachedShader=cached;this._shaders[keyword]=cached;this._numberOfShaders++;}
  cached.count++;return cached.shaderProgram;
 }
 releaseShaderProgram(program){const cached=program._cachedShader;if(cached&&--cached.count===0)this._shadersToRelease[cached.keyword]=cached;}
 destroyReleasedShaderPrograms(){
  for(const keyword in this._shadersToRelease){if(!Object.hasOwn(this._shadersToRelease,keyword))continue;
   const cached=this._shadersToRelease[keyword];delete this._shaders[keyword];cached.shaderProgram.destroyed=true;this.destroyed.push(keyword);--this._numberOfShaders;}
  this._shadersToRelease={};
 }
 get numberOfShaders(){return this._numberOfShaders;}
}
const sceneWith=cache=>({context:{shaderCache:cache}});
const cycle=(cache,keyword)=>{const program=cache.getShaderProgram(keyword);cache.releaseShaderProgram(program);return program;};

test('without retention Cesium recompiles a program whose last primitive went away a frame earlier',()=>{
 const cache=new FakeShaderCache();
 const first=cycle(cache,'footprint');cache.destroyReleasedShaderPrograms();
 const second=cache.getShaderProgram('footprint');
 assert.equal(cache.compiles,2);assert.notEqual(first,second);assert.equal(first.destroyed,true);
});

test('a retained program survives the frame and is reused without a recompile',()=>{
 const cache=new FakeShaderCache(),retention=retainShaderPrograms(sceneWith(cache));
 assert.ok(retention,'the cache was patched');
 const first=cycle(cache,'footprint');
 for(let frame=0;frame<5;frame++)cache.destroyReleasedShaderPrograms();
 const second=cache.getShaderProgram('footprint');
 assert.equal(cache.compiles,1,'one compile for the whole life of the page');
 assert.equal(first,second);assert.equal(first.destroyed,false);
 assert.deepEqual(cache.destroyed,[]);
 assert.equal(retention.stats().retained,0,'a program back in use is no longer counted as retained');
 cache.releaseShaderProgram(second);cache.destroyReleasedShaderPrograms();
 assert.equal(retention.stats().retained,1);
});

test('retention is bounded: the programs released longest ago are the ones given back',()=>{
 const cache=new FakeShaderCache(),retention=retainShaderPrograms(sceneWith(cache),{limit:3});
 for(const keyword of ['a','b','c','d','e']){cycle(cache,keyword);cache.destroyReleasedShaderPrograms();}
 assert.deepEqual(cache.destroyed,['a','b'],'oldest first, newest kept');
 assert.equal(retention.stats().retained,3);assert.equal(retention.stats().limit,3);
 assert.equal(cache.numberOfShaders,3);
 // Releasing an already retained program again refreshes its place in the line.
 cycle(cache,'c');cycle(cache,'f');cache.destroyReleasedShaderPrograms();
 assert.deepEqual(cache.destroyed,['a','b','d'],'c was touched again, so d is the oldest now');
});

test('a retained program that comes back into use is never destroyed by the trim',()=>{
 const cache=new FakeShaderCache();retainShaderPrograms(sceneWith(cache),{limit:2});
 cycle(cache,'a');cycle(cache,'b');cache.destroyReleasedShaderPrograms();
 const revived=cache.getShaderProgram('a');
 cycle(cache,'c');cycle(cache,'d');cache.destroyReleasedShaderPrograms();
 assert.equal(revived.destroyed,false,'in use, whatever its age');
 assert.ok(!cache.destroyed.includes('a'));assert.ok(cache.destroyed.includes('b'));
 assert.equal(cache._shaders.a,revived._cachedShader);
});

test('patching is idempotent, keeps the default bound, and tolerates a scene without a shader cache',()=>{
 const cache=new FakeShaderCache(),scene=sceneWith(cache);
 const first=retainShaderPrograms(scene),second=retainShaderPrograms(scene);
 assert.equal(first,second);assert.equal(first.stats().limit,DEFAULT_RETAINED_PROGRAMS);
 assert.ok(DEFAULT_RETAINED_PROGRAMS>=256,'a whole session of terrain, material and pick variants fits');
 assert.equal(retainShaderPrograms({}),null);assert.equal(retainShaderPrograms(null),null);
 assert.equal(retainShaderPrograms({_context:{shaderCache:new FakeShaderCache()}})?.stats().limit,DEFAULT_RETAINED_PROGRAMS,'the private context is accepted too');
});

test('the map and the aircraft camera widget both keep their programs',()=>{
 const source=relative=>readFileSync(new URL('../../../../'+relative,import.meta.url),'utf8');
 assert.match(source('digital_twin/visualization/web/globe.js'),/retainShaderPrograms\(v\.scene\)/);
 assert.match(source('digital_twin/visualization/web/airframe_camera.js'),/retainShaderPrograms\(scene\)/);
});
