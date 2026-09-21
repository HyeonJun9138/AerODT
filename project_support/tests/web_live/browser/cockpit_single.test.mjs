import test from 'node:test';import assert from 'node:assert/strict';
import {CockpitView} from '../../../../user_application/web/domains/uam/cockpit/cockpit_view.js';
const noop=()=>{};
function fixture(){const profile={eye:[0,1,0],screens:[]},sample={time_s:5,position:{latitude:37,longitude:127,altitude_m:300},heading_deg:45,pitch_deg:2,roll_deg:1,rotor_radps:50,battery_pct:90,mode:'cruise',stage:'cruise'},matrix=[1,0,0,0,0,1,0,0,0,0,1,0,1,2,3,1];
const layer={plan:{vehicle:{id:'single'},aircraft:{asset_id:'kp2a'}},sample,model:{ready:true,show:true,modelMatrix:matrix,scale:1},visible:true,asset:()=>({cockpit:profile,asset_id:'kp2a'})};
const v=Object.create(CockpitView.prototype);Object.assign(v,{globe:{flightLayer:layer,items:new Map(),entityScene:{assets:new Map(),layers:{}},stopTracking:noop,sceneMode:'3d',flyToFlight:noop,followFlight:noop},document:{body:{classList:{add:noop,remove:noop}}},button:{setAttribute:noop},panel:{open(){this.active=true;},close(){this.active=false;},update(s){this.state=s;}},camera:{enter({entityId}){this.active=true;this.entityId=entityId;return true;},update(frame){this.frame=frame;return true;},exit(){this.active=false;}}});return {v,layer,matrix};}
test('single replay cockpit uses its existing model matrix and replay telemetry without entity selection',()=>{const {v,layer,matrix}=fixture();assert.equal(v.enterSingle(),true);assert.equal(v.camera.frame.matrix,matrix);assert.equal(v.panel.state.telemetry.battery_soc_pct,90);layer.sample={...layer.sample,time_s:1};v.update(200);assert.equal(v.panel.state.stateTime,1);assert.equal(v.active,true);});
test('single replay model not ready cannot enter, plan removal and hidden aircraft exit',()=>{const {v,layer}=fixture();layer.model.ready=false;assert.equal(v.enterSingle(),false);layer.model.ready=true;v.enterSingle();layer.plan=null;v.update(100);assert.equal(v.active,false);});

import {LiveGlobe} from '../../../../digital_twin/visualization/web/globe.js';
test('single playback follow callback cannot overwrite cockpit camera',()=>{
 const sample={position:{latitude:37,longitude:127,altitude_m:300}},g={cockpit:{active:true,single:true}};
 LiveGlobe.prototype.followFlight.call(g,sample);assert.equal(g.followedFlightSample,sample);
});
test('single cockpit closes when the aircraft is hidden or the model is replaced',()=>{
 for(const change of [l=>l.visible=false,l=>l.display={aircraft:false},l=>l.model={...l.model}]){const {v,layer}=fixture();v.enterSingle();change(layer);v.update(300);assert.equal(v.active,false);}
});

import {FlightLayer} from '../../../../digital_twin/visualization/web/flight_layer.js';
test('single replay label stays hidden through display refresh and restores user label preference',()=>{
 const label={show:true},layer={vehicle:{marker:{label}},owned:[],visible:true,labelHasText:true,scene:{requestRender(){}},updateLabelText(){},updateCabin(){},display:{}};
 FlightLayer.prototype.setCockpitLabelsHidden.call(layer,true);assert.equal(label.show,false);
 FlightLayer.prototype.applyDisplay.call(layer);assert.equal(label.show,false);
 FlightLayer.prototype.setCockpitLabelsHidden.call(layer,false);assert.equal(label.show,true);
 layer.labelHasText=false;FlightLayer.prototype.setCockpitLabelsHidden.call(layer,true);FlightLayer.prototype.setCockpitLabelsHidden.call(layer,false);assert.equal(label.show,false);
});
test('shared cockpit entry also accepts the single replay when no live entity is selected',()=>{const {v}=fixture();assert.equal(v.enter(),true);assert.equal(v.single,true);});

test('moving a flight refreshes an already engaged external follow anchor, but never enables follow',()=>{
 const first={position:{longitude:1}},next={position:{longitude:2}};let rendered=0;
 const g={flightLayer:{moveTo:()=>true},viewer:{scene:{requestRender:()=>rendered++}},followedFlightSample:first};
 LiveGlobe.prototype.moveFlight.call(g,next);assert.equal(g.followedFlightSample,next);assert.equal(rendered,1);
 g.followedFlightSample=null;LiveGlobe.prototype.moveFlight.call(g,first);assert.equal(g.followedFlightSample,null);
});

test('successful cockpit and external-follow switches hand focus back without replacing the flight',()=>{
 const {v,layer}=fixture(),plan=layer.plan,model=layer.model;let changes=0;
 v.onViewChange=()=>changes++;assert.equal(v.enterSingle(),true);assert.equal(changes,1);
 v.exit(true);assert.equal(changes,2);assert.equal(v.active,false);assert.equal(layer.plan,plan);assert.equal(layer.model,model);
 layer.model.ready=false;assert.equal(v.enterSingle(),false);assert.equal(changes,2);
});
