import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {applySceneStyle, applyImageryStyle, setSunLighting, createStarSkyBox, buildingStyle} from '../../../../digital_twin/visualization/web/globe_style.js';

test('SDC satellite-emphasis imagery keeps the original tone settings', () => {
  const layer = {};
  applyImageryStyle(layer,true);
  assert.deepEqual(layer, {brightness:.56, contrast:1.28, saturation:.5, gamma:.88});
});

test('scene starts with real-time lighting off while retaining atmosphere and stars', () => {
  const scene = {globe:{}, skyBox:{}, sun:{}, moon:{}, fog:{}};
  const C = {Color:{fromCssColorString:value=>value}};
  applySceneStyle(C, scene);
  assert.equal(scene.globe.baseColor, '#07111d');
  assert.equal(scene.globe.enableLighting, false);
  assert.equal(scene.globe.dynamicAtmosphereLighting, false);
  assert.equal(scene.globe.showGroundAtmosphere, true);
  assert.equal(scene.skyBox.show, true);
  assert.equal(scene.sun.show, false);
  assert.equal(scene.moon.show, false);
  assert.equal(scene.fog.screenSpaceErrorFactor, 4, 'far tiles in the haze are not refined');
});

test('default imagery and initial sun button both match sun-off mode',()=>{
  const layer={};applyImageryStyle(layer);
  assert.deepEqual(layer,{brightness:.9,contrast:1.08,saturation:.65,gamma:1.12});
  const html=readFileSync(new URL('../../../../user_application/web/index.html',import.meta.url),'utf8');
  const button=html.match(/<button\b[^>]*\bid="sunlight"[^>]*>/)?.[0];
  assert.ok(button);
  assert.match(button,/aria-pressed="false"/);
  assert.match(button,/title="실시간 태양 조명 꺼짐/);
});

test('sun toggle only changes presentation, preserving restrained imagery and stars', () => {
  const scene={globe:{},skyBox:{},sun:{},moon:{},fog:{}};
  applySceneStyle({Color:{fromCssColorString:v=>v}},scene);
  setSunLighting(scene,false);
  assert.equal(scene.globe.enableLighting,false);
  assert.equal(scene.globe.dynamicAtmosphereLighting,false);
  assert.equal(scene.skyBox.show,true);
  setSunLighting(scene,true);
  assert.equal(scene.globe.enableLighting,true);
  assert.equal(scene.globe.dynamicAtmosphereLighting,true);
});

test('star backdrop is deterministic sparse geometry, not a dense photograph or live feed',()=>{
 const draws=[];const canvas=()=>({getContext:()=>({set fillStyle(v){},fillRect(){},beginPath(){},arc(...a){draws.push(a);},fill(){}})});
 class SkyBox {constructor(options){this.sources=options.sources;}}
 const result=createStarSkyBox({SkyBox},canvas);
 assert.equal(Object.keys(result.sources).length,6);
 assert.equal(draws.length,720);
 assert.ok(draws.every(([_x,_y,r])=>r<=1.1));
});

test('sun-off mode lifts image shadows and restores exact sun-on settings',()=>{
 const layer={};const scene={globe:{imageryLayers:{length:1,get:()=>layer}}};
 setSunLighting(scene,false);
 assert.deepEqual(layer,{brightness:.9,contrast:1.08,saturation:.65,gamma:1.12});
 assert.equal(scene.globe.enableLighting,false);
 setSunLighting(scene,true);
 assert.deepEqual(layer,{brightness:.56,contrast:1.28,saturation:.5,gamma:.88});
});
test('imagery loaded after sun-off also receives the brighter style',()=>{
 const layer={};applyImageryStyle(layer,false);
 assert.equal(layer.brightness,.9);assert.equal(layer.gamma,1.12);
});

test('buildings are drawn in a neutral grey height ramp, not the baked OSM tint',()=>{
  const C={Cesium3DTileStyle:class {constructor(options){Object.assign(this,options);}}};
  const conditions=buildingStyle(C).color.conditions;
  assert.ok(conditions.length>=3,'a flat single colour reads as a cardboard block');
  for(const [expression,value] of conditions){
    const hex=value.match(/^color\('#([0-9a-f]{6})'\)$/)?.[1];
    assert.ok(hex,`unexpected colour expression: ${value}`);
    const [r,g,b]=[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16));
    assert.ok(Math.max(r,g,b)-Math.min(r,g,b)<=32,`#${hex} must stay a restrained blue-grey`);
    assert.ok(Math.min(r,g,b)>=125&&Math.max(r,g,b)<=205,`#${hex} must be readable without the glaring white city`);
    assert.ok(expression==='true' || expression.includes("cesium#estimatedHeight"),
      'height is the only feature property the ramp reads');
  }
  assert.equal(conditions.at(-1)[0],'true','a final catch-all keeps every feature coloured');
  for(const [expression] of conditions.filter(([value])=>value!=='true'))
    assert.match(expression,/^Number\(\$\{feature\['cesium#estimatedHeight'\]\}\) >=/,
      'the height must go through Number(): Cesium throws when a missing property meets >=');
  const heights=conditions.filter(([expression])=>expression.includes('>='))
    .map(([expression])=>Number(expression.match(/>=\s*(\d+)/)[1]));
  assert.ok(heights.length>=3);
  assert.deepEqual(heights,[...heights].sort((a,b)=>b-a),'conditions must run tallest first');
});

test("the globe applies the building style when the tileset attaches, at the operator's look",()=>{
  const source=readFileSync(new URL('../../../../digital_twin/visualization/web/globe.js',import.meta.url),'utf8');
  assert.match(source,/tiles\.style\s*=\s*buildingStyle\(C,appearanceOf\(this\.buildingAppearance\)\)/);
  // A tileset is recoloured by being handed a new style, so a change of tint or
  // level has to reach the ones already attached rather than only the next one.
  assert.match(source,/restyleBuildingTilesets\(\)\s*\{[\s\S]*?tiles\.style=buildingStyle\(this\.C,look\)/);
  assert.match(source,/setBuildingAppearance\([\s\S]*?this\.restyleBuildingTilesets\(\)/);
});

test('the tint and the level are a multiply over the height ramp, not a new ramp',()=>{
  const C={Cesium3DTileStyle:class {constructor(options){Object.assign(this,options);}}};
  const neutral=buildingStyle(C,{rgb:[1,1,1],brightness:1});
  const plain=buildingStyle(C);
  // Nothing chosen and neutral chosen have to draw the same, or the default
  // look would drift the moment the setting existed.
  assert.deepEqual(neutral.color.conditions,plain.color.conditions);
  const warm=buildingStyle(C,{rgb:[1,.886,.722],brightness:1});
  const colours=warm.color.conditions.map(([,expression])=>expression);
  assert.notDeepEqual(colours,plain.color.conditions.map(([,expression])=>expression));
  // Every band still has its own colour: which building is tall is unchanged.
  assert.equal(new Set(colours).size,colours.length);
});
