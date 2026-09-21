import test from 'node:test';import assert from 'node:assert/strict';
import {EntityScene} from '../../../../digital_twin/visualization/web/entity_scene.js';
import {ManualFlightPanel} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_panel.js';
import {fakeDocument,FakeElement} from './fake_dom.mjs';
const color=name=>({name,withAlpha(alpha){return {name,alpha};}});
test('only leased aircraft gets pilot label and colour; release and reassignment restore others',()=>{
 const s=Object.create(EntityScene.prototype);s.C={Color:{WHITE:color('white'),BLACK:color('black'),fromCssColorString:color}};s.layers={uam:{showLabels:true,showStatus:true}};s.fadingLabels=new Set();
 const a={entity:{entity_id:'scenario:A',name:'A',kind:'uam'},label:{}},b={entity:{entity_id:'scenario:B',name:'B',kind:'uam'},label:{}};s.items=new Map([['scenario:A',a],['scenario:B',b]]);
 s.setManualSample('scenario:A',{});assert.match(a.label.text,/내 조종/);assert.equal(a.label.fillColor.name,'#6fffe0');assert.equal(s.labelColour(b).name,'white');
 s.startLabelFade(a,0);s.updateLabelFades(1000);assert.equal(a.label.fillColor.name,'#6fffe0');
 s.setManualSample('scenario:B',{});assert.doesNotMatch(a.label.text,/내 조종/);assert.equal(a.label.fillColor.name,'white');assert.match(b.label.text,/내 조종/);
 s.setManualSample(null,null);assert.equal(b.label.fillColor.name,'white');assert.doesNotMatch(b.label.text,/내 조종/);
});
test('find-own-aircraft action remains independent of dashboard and closes with session',()=>{
 const document={...fakeDocument,body:new FakeElement('body')},actions=[];
 const p=new ManualFlightPanel({document,target:null,onAction:a=>actions.push(a)});
 assert.equal(p.locate.hidden,true);p.open();assert.equal(p.locate.hidden,false);assert.equal(p.locate.parent,document.body);
 p.locate.onclick({});assert.deepEqual(actions,['find_aircraft']);assert.equal(p.input.active,true);
 p.close();assert.equal(p.locate.hidden,true);p.destroy();assert.ok(!document.body.children.includes(p.locate));
});

