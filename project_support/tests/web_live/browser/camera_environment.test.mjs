import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraEnvironment,CameraEnvironment} from '../../../../digital_twin/visualization/web/camera_environment.js';
import {cellsFor} from '../../../../digital_twin/visualization/web/vworld_building_layer.js';
test('a tracked deck keeps its foreground and requests a smaller region than a city overview',()=>{
 const options={height:350,range:200,maximum:40000};
 const close=cameraEnvironment({...options,following:true});
 const free=cameraEnvironment(options);
 assert.ok(close.range>1000&&close.range<2500);assert.ok(close.range<free.range);
 assert.ok(close.density>free.density);assert.ok(close.visualDensity>free.visualDensity);
 const focus={longitude:127,latitude:37.5};
 assert.ok(cellsFor(null,64,focus,close.range).length<cellsFor(null,64,focus,40000).length);
});
test('an overview, distant selection and explicit fog off preserve the requested extent',()=>{
 assert.equal(cameraEnvironment({height:30000,maximum:40000}).range,40000);
 assert.equal(cameraEnvironment({height:350,range:30000,following:true}).following,false);
 assert.equal(cameraEnvironment({height:350,range:100,following:true,fog:0,maximum:20000}).range,20000);
 assert.equal(cameraEnvironment({fog:0}).density,0);
});
test('camera transitions converge smoothly, then stabilize rather than requesting new cells forever',()=>{
 const policy=new CameraEnvironment();const city={height:20000,maximum:40000};
 assert.equal(policy.update(city,0).range,40000);
 const close={height:300,range:100,following:true,maximum:40000};
 let last=40000;
 for(let now=200;now<10000;now+=200){const next=policy.update(close,now).range;assert.ok(next<=last);last=next;}
 assert.equal(last,900);assert.equal(policy.update(close,11000).range,900);
 assert.ok(policy.update(city,11200).range>900);assert.ok(policy.value.range<40000);
});
