import test from 'node:test';
import assert from 'node:assert/strict';
import {AircraftCameraPanel} from '../../../../user_application/web/aircraft_camera_panel.js';
import {FakeElement,fakeDocument} from './fake_dom.mjs';
test('camera window presents a frame completed between ticks and waits for a new direction frame',()=>{
 const entity={entity_id:'u1',kind:'uam',quality:'nominal'};
 const camera={frameNumber:0,enabled:true,update(){},stop(){},set(){},clear(){},destroy(){}};
 const globe={items:new Map([['u1',{entity,assetId:'a',model:{ready:false},position:{}}]]),entityScene:{assets:new Map([['a',{size_m:12}]]),matrix:()=>Array(16).fill(0),scaleOf:()=>1}};
 const panel=new AircraftCameraPanel({globe,document:{...fakeDocument,body:new FakeElement('body'),hidden:false},workspace:{manage:()=>({minimized:false,shell:{hidden:false}}),release(){}},Camera:class{constructor(){return camera;}},requestFrame:()=>1,cancelFrame(){}});
 panel.select(entity,{selected:true});let paints=0;panel.paint=()=>paints++;
 panel.tick(10);assert.equal(paints,0);assert.equal(panel.cover.hidden,false);
 camera.frameNumber=1;panel.tick(20);assert.equal(paints,1);assert.equal(panel.cover.hidden,true);
 panel.tick(30);assert.equal(paints,1);
 panel.setDirection('right');panel.tick(40);assert.equal(panel.cover.hidden,false);assert.equal(paints,1);
 camera.frameNumber=2;panel.tick(50);assert.equal(panel.cover.hidden,true);assert.equal(paints,2);
 panel.destroy();
});
