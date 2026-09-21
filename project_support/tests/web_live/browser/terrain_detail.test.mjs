import test from 'node:test';
import assert from 'node:assert/strict';
import {TerrainDetail} from '../../../../digital_twin/visualization/web/terrain_detail.js';

test('a long load queue raises the allowed error half a step at a time, never past the maximum',()=>{
 const detail=new TerrainDetail();
 assert.equal(detail.observe(300,1000,0),2,'not before the backlog has lasted');
 assert.equal(detail.observe(300,1000,500),2);
 assert.equal(detail.observe(300,1000,600),2.5,'one notch, uniformly, once the queue has stayed long');
 assert.equal(detail.observe(300,1000,700),2.5,'the next notch waits for the queue to stay long again');
 assert.equal(detail.observe(300,1000,1200),3);
 let value=3;for(let t=1300;t<20000;t+=100)value=detail.observe(500,1000,t);
 assert.equal(value,6,'bounded');
});

test('a drained queue brings detail back half a step at a time, slower than it went',()=>{
 const detail=new TerrainDetail();
 detail.observe(300,1000,0);detail.observe(300,1000,600);detail.observe(300,1000,1200);
 assert.equal(detail.value,3);
 assert.equal(detail.observe(0,1000,1300),3,'not at once');
 assert.equal(detail.observe(0,1000,3300),2.5,'after the queue has stayed drained');
 assert.equal(detail.observe(0,1000,5300),2);
 assert.equal(detail.observe(0,1000,9000),2,'never below the base');
});

test('a queue that hovers between the thresholds changes nothing and resets both timers',()=>{
 const detail=new TerrainDetail();
 detail.observe(300,1000,0);
 assert.equal(detail.observe(40,1000,500),2,'in between: neither congested nor drained');
 assert.equal(detail.observe(300,1000,700),2,'the congestion clock restarted');
 assert.equal(detail.observe(300,1000,1300),2.5);
});

test('a high view starts from a coarser floor and the floor releases with descent',()=>{
 assert.equal(TerrainDetail.floor(1000),2);
 assert.equal(TerrainDetail.floor(6500),2.5);
 assert.equal(TerrainDetail.floor(10000),3);
 assert.equal(TerrainDetail.floor(50000),3,'no coarser than one level from altitude alone');
 const detail=new TerrainDetail();
 assert.equal(detail.observe(0,12000,0),3,'the floor applies at once when climbing');
 assert.equal(detail.observe(0,1000,100),3,'descending does not sharpen at once');
 assert.equal(detail.observe(0,1000,2100),2.5,'it returns at the usual pace');
});
