import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeDocument,FakeElement} from './fake_dom.mjs';
import {paintCockpitMarks} from '../../../../user_application/web/domains/uam/cockpit/cockpit_marks.js';

test('steady instrument updates reuse glyphs and never detach the SVG tree',()=>{
 let created=0,replaced=0;
 const document={...fakeDocument,createElementNS:(ns,tag)=>{created++;return fakeDocument.createElementNS(ns,tag);}};
 const parent=new FakeElement('g'),replace=parent.replaceChildren.bind(parent);
 parent.replaceChildren=(...args)=>{replaced++;replace(...args);};
 for(let frame=0;frame<1000;frame++)paintCockpitMarks(document,parent,[['path',{d:`M${frame} 0`,fill:'red'}],['text',{x:frame,text:'WP 1'}]]);
 assert.equal(created,2);assert.equal(replaced,1);assert.equal(parent.children[0].getAttribute('d'),'M999 0');
 assert.equal(parent.children[1].textContent,'WP 1');
});

test('reordering, empty data and shrinking traffic retain no visible stale glyphs',()=>{
 const parent=new FakeElement('g');
 paintCockpitMarks(fakeDocument,parent,[['line',{x1:0}],['text',{text:'old'}]]);
 paintCockpitMarks(fakeDocument,parent,[['text',{text:'new'}],['line',{x1:2}]]);
 assert.equal(parent.children[0].textContent,'new');assert.equal(parent.children[1].getAttribute('x1'),'2');
 paintCockpitMarks(fakeDocument,parent,[]);assert.equal(parent.children.length,0);
 paintCockpitMarks(fakeDocument,parent,Array.from({length:100},(_,i)=>['text',{text:String(i)}]));
 paintCockpitMarks(fakeDocument,parent,[]);assert.equal(parent.children.length,0);
 assert.ok(parent.cockpitMarkPools.get('text').length<=8);
});
