import test from 'node:test';
import assert from 'node:assert/strict';
import {statusLabel,frdToPreviewQuaternion,TwinningTestPanel,newOperationId} from '../../../../user_application/web/domains/uam/live_twinning/twinning_test_panel.js';

test('connection is distinct from fresh sensor reception',()=>{
 assert.equal(statusLabel({enabled:false}),'Test Mode OFF');
 assert.equal(statusLabel({enabled:false,armed:true}),'Test Mode ON · 수신 중지');
 assert.match(statusLabel({enabled:true,connected:true,status:'stale'}),/수신 중단/);
 assert.match(statusLabel({enabled:true,connected:false}),/연결 대기/);
});
test('default fetch retains the browser global receiver',async()=>{
 const saved=globalThis.fetch;
 globalThis.fetch=function(){assert.equal(this,globalThis);return Promise.resolve({ok:true,json:async()=>({enabled:false})});};
 try{assert.equal((await new TwinningTestPanel().api()).enabled,false);}finally{globalThis.fetch=saved;}
});
test('FRD to right-handed X forward Y left Z up uses a basis change',()=>{
 assert.deepEqual(frdToPreviewQuaternion([1,0,0,0]),[1,0,-0,-0]);
 assert.deepEqual(frdToPreviewQuaternion([.5,.5,.5,.5]),[.5,.5,-.5,-.5]);
});

test('pagehide cancels a pending start even before enabled response',async()=>{
 let sent;const panel=new TwinningTestPanel({beacon:(url,body)=>{sent={url,body};}});
 panel.operationId='pending-start';panel.state={enabled:false};panel.pageHidden();
 assert.equal(sent.url,'/api/twinning-test/stop');
 assert.equal(JSON.parse(await sent.body.text()).operation_id,'pending-start');
});
test('operation IDs also work on LAN HTTP where randomUUID is unavailable',()=>{
 assert.match(newOperationId({getRandomValues:a=>a.fill(15)}),/^[a-f0-9]{32}$/);
});

test('concurrent preview imports create only the most recent selected asset',async()=>{
 let resolve,created=0;const shown=[];
 const pending=new Promise(r=>resolve=r);
 const panel=new TwinningTestPanel({loadPreview:()=>pending});
 const nodes={asset:{value:'a'},preview:{},'engine-credit':{},credit:{},'model-status':{}};
 panel.$=key=>nodes[key];panel.assets=[{asset_id:'a'},{asset_id:'b'}];panel.buttons=()=>{};
 const saved=globalThis.Cesium;globalThis.Cesium={};
 try{
  const a=panel.showAsset();nodes.asset.value='b';const b=panel.showAsset();
  resolve({TwinningPreview:class{constructor(){created++;}async show(a){shown.push(a.asset_id);}}});
  await Promise.all([a,b]);assert.equal(created,1);assert.deepEqual(shown,['b']);
 }finally{globalThis.Cesium=saved;}
});

test('sensor freshness is independent and missing GPS is not a zero fix',()=>{
 const p=new TwinningTestPanel();p.state={status:'receiving',sensors:{gps:{status:'waiting'},attitude:{status:'stale'}}};
 assert.equal(p.sensorStatus('gps'),'waiting');assert.equal(p.sensorStatus('attitude'),'stale');
});
test('map receives full snapshot and mount alignment',()=>{
 let received;const p=new TwinningTestPanel();p.state={gps:{latitude_deg:37}};p.$=()=>({value:'90'});p.preview={update:(...args)=>received=args};p.applyPose();assert.deepEqual(received,[p.state,90]);
});
test('history uses GET and is not requested more often than once per second',async()=>{
 const calls=[];const p=new TwinningTestPanel({fetch:async(url,opts)=>{calls.push([url,opts]);return {ok:true,json:async()=>({session_id:1,rows:[],now_s:10})};}});p.renderHistory=()=>{};
 await p.pollHistory(1000);await p.pollHistory(1500);await p.pollHistory(2001);
 assert.equal(calls.length,2);assert.equal(calls[0][0],'/api/twinning-test/history');assert.equal(calls[0][1].method,'GET');
});

test('GPS-only reception is reported as sensor reception, not attitude',()=>{
 assert.equal(statusLabel({enabled:true,connected:true,status:'waiting',sensors:{gps:{status:'receiving'},attitude:{status:'waiting'}}}),'센서 수신 중');
});
test('a poll started before stop cannot restore stale enabled state',async()=>{
 let release;const pending=new Promise(r=>release=r);const p=new TwinningTestPanel();p.dialog={};p.state={enabled:true};p.$=()=>({value:'a'});p.buttons=()=>{};p.paint=()=>{};p.applyPose=()=>{};p.pollHistory=()=>{};
 p.api=async action=>action==='stop'?{enabled:false}:pending;
 const poll=p.poll(0);await p.control('stop');release({enabled:true,asset_id:'a'});await poll;clearTimeout(p.timer);
 assert.equal(p.state.enabled,false);
});

import {FakeElement,fakeDocument} from './fake_dom.mjs';
function monitorFixture(){const nodes={};const p=new TwinningTestPanel({document:fakeDocument});p.dialog={};p.$=key=>nodes[key]??(nodes[key]=new FakeElement('div'));p.buttons=()=>{};return {p,nodes};}
test('waiting sensors show missing values while actual GPS height remains signed',()=>{
 const {p,nodes}=monitorFixture();p.state={enabled:true,connected:true,session_id:4,status:'receiving',gps:{latitude_deg:37.5,longitude_deg:127,altitude_m:90,altitude_reference:'msl',horizontal_accuracy_m:3},gps_height_above_start_m:-10,gps_origin_altitude_m:100,sensors:{gps:{status:'receiving'},attitude:{status:'waiting'},acceleration:{status:'waiting'}}};p.paint();
 assert.match(nodes['attitude-values'].textContent,/ROLL   —/);assert.match(nodes['gps-values'].textContent,/-10.0 m/);assert.match(nodes['gps-values'].textContent,/90.0 m MSL/);assert.equal(nodes['attitude-status'].dataset.status,'waiting');assert.equal(nodes['horizon-wait'].textContent,'센서 대기');
});
test('history chart never extends stopped samples to the present',()=>{
 const {p,nodes}=monitorFixture();p.history={now_s:100,rows:[{time_s:50,attitude:[1,2,3]},{time_s:51,attitude:[2,3,4]},{time_s:80,attitude:[4,5,6]}]};p.renderHistory();
 const paths=nodes['attitude-chart'].querySelectorAll('path').filter(n=>n.getAttribute('fill')==='none');assert.equal(paths.length,3);assert.match(paths[0].getAttribute('d'),/^M93.00 .*L99.10 .*M276.00 /);assert.doesNotMatch(paths[0].getAttribute('d'),/398.00/);
 assert.equal(nodes['acceleration-chart'].textContent,'실제 센서 샘플 대기');
});

test('flow pulse advances only on a new accepted count while receiving',()=>{
 const {p,nodes}=monitorFixture();p.state={enabled:true,connected:true,count:5,sensors:{attitude:{status:'receiving',age_seconds:.2}},status:'receiving'};p.paint();
 assert.equal(nodes['flow-nodes'].dataset.pulse,'none');p.state.count=6;p.paint();assert.equal(nodes['flow-nodes'].dataset.pulse,'a');p.paint();assert.equal(nodes['flow-nodes'].dataset.pulse,'a');
 p.state.sensors.attitude.status='stale';p.paint();assert.equal(nodes['flow-nodes'].dataset.pulse,'none');assert.match(nodes['attitude-status'].textContent,/0.2s/);
});
test('history chart shows the actual 60 second time axis',()=>{
 const {p,nodes}=monitorFixture();p.history={now_s:100,rows:[{time_s:99,attitude:[1,2,3]}]};p.renderHistory();assert.match(nodes['attitude-chart'].textContent,/-60s/);assert.match(nodes['attitude-chart'].textContent,/-30s/);assert.match(nodes['attitude-chart'].textContent,/지금/);
});

test('GPS with unavailable relative altitude is not labelled as a valid map position',()=>{
 const {p,nodes}=monitorFixture();p.state={enabled:true,connected:true,sensors:{gps:{status:'receiving'}},gps_height_above_start_m:null};p.paint();assert.match(nodes['gps-map-status'].textContent,/고도 기준/);assert.doesNotMatch(nodes['gps-map-status'].textContent,/GPS 수신 중/);
});

test('the sender row appears only when there is a choice to make',()=>{
 const {p,nodes}=monitorFixture();
 p.state={enabled:true,connected:true,sensors:{},devices:[],selected_device:null};p.paint();
 assert.equal(nodes.devices.hidden,true,'no senders, no row');
 p.state.devices=[{device_id:'phone_A',status:'receiving',connected:true,count:12}];
 p.state.selected_device='phone_A';p.paint();
 assert.equal(nodes.devices.hidden,true,'one sender is not a choice');
 p.state.devices.push({device_id:'sim_B',status:'stale',connected:true,count:3});
 p.paint();
 assert.equal(nodes.devices.hidden,false);
 const chips=nodes.devices.children;
 assert.equal(chips.length,2);
 assert.equal(chips[0].textContent,'phone_A');
 assert.equal(chips[0].getAttribute('aria-pressed'),'true','the chosen one is marked');
 assert.equal(chips[1].getAttribute('aria-pressed'),'false');
 assert.equal(chips[1].dataset.status,'stale');
 // A sender that dropped its socket reads differently from one gone quiet.
 p.state.devices[1].connected=false;p.paint();
 assert.equal(nodes.devices.children[1].dataset.status,'gone');
});

test('picking a sender asks the receiver to follow it, and never twice',async()=>{
 const {p,nodes}=monitorFixture();
 const sent=[];p.control=async(action,body)=>{sent.push([action,body]);return true;};
 p.state={enabled:true,connected:true,sensors:{},selected_device:'phone_A',
  devices:[{device_id:'phone_A',status:'receiving',connected:true},
           {device_id:'sim_B',status:'receiving',connected:true}]};
 p.paint();
 await nodes.devices.children[1].onclick();
 assert.deepEqual(sent,[['select',{device_id:'sim_B'}]]);
 // Choosing the one already chosen changes nothing, so it asks nothing.
 await nodes.devices.children[0].onclick();
 assert.equal(sent.length,1);
});
