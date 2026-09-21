import test from 'node:test';
import assert from 'node:assert/strict';
import {mapEntityName} from '../../../../digital_twin/visualization/web/entity_labels.js';
import * as labels from '../../../../digital_twin/visualization/web/entity_labels.js';
import {describeEntity} from '../../../../user_application/web/entity_details.js';

test('scenario map and hover show aircraft only while details keep the flight name',()=>{
  const entity={entity_id:'scenario:UAM0015',source:'scenario',kind:'uam',name:'UAM0015 · FPL000069'};
  assert.equal(mapEntityName(entity),'UAM0015');
  assert.equal(describeEntity(entity).name,'UAM0015 · FPL000069');
  assert.equal(mapEntityName({...entity,name:'UAM0015 · FPL000070'}),'UAM0015');
});
test('other map labels retain their existing names and fallback',()=>{
  assert.equal(mapEntityName({entity_id:'aircraft:15',name:'KE123'}),'KE123');
  assert.equal(mapEntityName({entity_id:'satellite:1'}),'satellite:1');
});

test('UAM operational status is a separate second line, independently switchable',()=>{
  assert.equal(typeof labels.mapEntityLabel,'function');
  const e={entity_id:'scenario:UAM0045',source:'scenario',kind:'uam',flight_phase:'hold',name:'UAM0045 · FPL2'};
  assert.equal(labels.mapEntityLabel(e),'UAM0045\n체공');
  assert.equal(labels.mapEntityLabel(e,{labels:false,status:true}),'체공');
  assert.equal(labels.mapEntityLabel(e,{labels:true,status:false}),'UAM0045');
  assert.equal(labels.mapEntityLabel(e,{labels:false,status:false}),'');
  assert.equal(labels.mapEntityLabel({...e,flight_phase:'descent'}),'UAM0045\n접근');
  assert.equal(labels.mapEntityLabel({...e,flight_phase:null,speed_mps:0}),'UAM0045');
  assert.equal(labels.mapEntityLabel({kind:'aircraft',name:'KE123',flight_phase:'cruise'}),'KE123');
});

test('ground labels distinguish the observed stopped wait from a restricted moving aircraft',()=>{
  const e={entity_id:'scenario:UAM0070',source:'scenario',kind:'uam',flight_phase:'gate_in',
    ground_waiting:true,ground_action:'ground_wait',speed_mps:0};
  assert.equal(labels.mapEntityLabel(e),'UAM0070\n지상 대기');
  assert.equal(labels.mapEntityLabel(e,{labels:false,status:true}),'지상 대기');
  assert.equal(labels.mapEntityLabel(e,{labels:true,status:false}),'UAM0070');
  assert.equal(labels.mapEntityLabel(e,{labels:false,status:false}),'');
  assert.equal(labels.mapEntityLabel({...e,ground_waiting:false}),'UAM0070\n지상 이동 · 감속');
  assert.equal(labels.mapEntityLabel({...e,ground_waiting:false,ground_action:null}),'UAM0070\n지상 이동 · 도착');
  assert.equal(labels.mapEntityLabel({...e,flight_phase:'descent'}),'UAM0070\n접근','old ground fields cannot hide flight status');
});
