import test from 'node:test';import assert from 'node:assert/strict';
import {FlightLayer} from '../../../../digital_twin/visualization/web/flight_layer.js';
import {VertiportLayer} from '../../../../digital_twin/visualization/web/vertiport_layer.js';
import {ManualFlightInput} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_input.js';

test('manual samples never rebuild or expose the sea-level drop line',()=>{
 let writes=0;const drop={show:true,polyline:{set positions(v){writes++;}}};
 const layer=Object.create(FlightLayer.prototype);
 Object.assign(layer,{C:{Cartesian3:{fromDegrees:(...v)=>v}},vehicle:{drop,marker:{point:{},label:{}}},visible:true,model:null,loadModel(){},color:x=>x,updateLabelText(){}});
 const sample={manual:true,position:{longitude:127,latitude:37,altitude_m:100}};
 for(let i=0;i<60;i++)assert.equal(layer.moveTo(sample),true);
 assert.equal(writes,0);assert.equal(drop.show,false);
 layer.moveTo({...sample,manual:false});assert.equal(writes,1);assert.equal(drop.show,true);
});
test('fine throttle input retains fractional precision after release',()=>{
 const m=new ManualFlightInput({target:null});m.start();m.setThrottle(.201);m.keys.add('KeyS');
 m.update(.05);assert.ok(Math.abs(m.throttle-.2)<1e-10);m.keys.clear();m.update(.1);assert.ok(Math.abs(m.throttle-.2)<1e-10);
});
test('contact geometry excludes unresolved deck heights',()=>{
 const layer=Object.create(VertiportLayer.prototype);
 layer.records=new Map([['missing',{layout:{}}]]);layer.deckTop=()=>null;
 assert.deepEqual(layer.contactDecks(),[]);
});
