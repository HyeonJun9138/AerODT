import test from 'node:test';
import assert from 'node:assert/strict';
import {entitySoundProfile} from '../../../../digital_twin/visualization/web/entity_sound_profile.js';
import {SelectedEntityAudio} from '../../../../digital_twin/visualization/web/selected_entity_audio.js';
import {selectedSoundSample,sceneSoundSample,EntitySoundControls} from '../../../../user_application/web/domains/uam/audio/entity_sound_controls.js';
import {DisplaySamples} from '../../../../digital_twin/visualization/web/display_samples.js';

const uam={entity_id:'u1',kind:'uam',flight_phase:'climb',rotor_radps:300,tilt_deg:0,velocity_ecef_mps:[40,0,0]};
test('RPM drives pitch, zero is silent, tilt changes mix and distance attenuates',()=>{
  const a=entitySoundProfile(uam,100),b=entitySoundProfile({...uam,rotor_radps:450},100);
  assert.ok(b.frequency>a.frequency);assert.ok(b.level>a.level);
  assert.equal(entitySoundProfile({...uam,rotor_radps:0},10).level,0);
  assert.equal(entitySoundProfile({...uam,motor_state:'off'},10).level,0);
  assert.ok(entitySoundProfile({...uam,tilt_deg:90},100).cruise>a.cruise);
  assert.ok(entitySoundProfile(uam,3000).level<a.level/5);
  assert.equal(entitySoundProfile(uam,100000).level,0);
});
test('fallback never pretends missing Physical telemetry is measured',()=>{
  assert.equal(entitySoundProfile({...uam,source:'physical_uam',rotor_radps:null},10).level,0);
  const fallback=entitySoundProfile({...uam,rotor_radps:null},10);
  assert.equal(fallback.estimated,true);assert.ok(fallback.level>0);
  assert.equal(entitySoundProfile({...uam,rotor_radps:null,flight_phase:'parked'},10).level,0);
  assert.equal(entitySoundProfile({...uam,quality:'stale'},10).level,0);
  assert.equal(entitySoundProfile({...uam,rotor_radps:-1},10).level,0);
  for(const distance of [NaN,Infinity,-1])assert.equal(entitySoundProfile(uam,distance).level,0);
  assert.equal(entitySoundProfile(null,10).level,0);
});
test('UAM timbres, known propellers, jet fallback and satellite effect are distinct',()=>{
  const joby=entitySoundProfile({...uam,visual_asset_id:'joby_s4'},100);
  const x57=entitySoundProfile({...uam,visual_asset_id:'nasa_x57'},100);
  assert.notEqual(joby.frequency,x57.frequency);
  assert.equal(entitySoundProfile({kind:'aircraft',aircraft_type:'C172'},100).timbre,'propeller');
  assert.equal(entitySoundProfile({kind:'aircraft'},100).timbre,'jet');
  assert.equal(entitySoundProfile({kind:'satellite'},100).timbre,'space');
  assert.equal(entitySoundProfile({kind:'satellite'},100).estimated,true);
});

class Param {value=0;events=[];setTargetAtTime(value,time,tau){this.value=value;this.events.push({value,time,tau});}setValueAtTime(value){this.value=value;}cancelScheduledValues(){} }
class Node {constructor(){for(const key of ['gain','frequency','detune','Q','threshold','knee','ratio','attack','release','pan'])this[key]=new Param();}connect(){return this;}disconnect(){}start(){this.started=true;}stop(){this.stopped=true;}setPeriodicWave(){} }
class Context {
  currentTime=0;sampleRate=8000;state='suspended';nodes=[];destination=new Node();
  node(){const n=new Node();this.nodes.push(n);return n;}
  createGain(){return this.node();}createOscillator(){return this.node();}createBufferSource(){return this.node();}
  createBiquadFilter(){return this.node();}createDynamicsCompressor(){return this.node();}createStereoPanner(){return this.node();}
  createPeriodicWave(){return {};}
  createBuffer(channels,length){return {getChannelData:()=>new Float32Array(length)};}
  async resume(){this.state='running';}async suspend(){this.state='suspended';}async close(){this.state='closed';}
}
test('manual rotor response is quicker and cockpit attenuates high frequencies without rebuilding nodes',async()=>{
 const audio=new SelectedEntityAudio({createContext:()=>new Context()});await audio.enable();audio.update({entity:uam,distance:5});const voice=audio.voices[audio.active],tau=voice.tones[0].frequency.events.at(-1).tau,cutoff=voice.lowpass.frequency.value,count=audio.context.nodes.length;
 audio.update({entity:{...uam,manual:true},distance:5,cockpit:true});assert.ok(voice.tones[0].frequency.events.at(-1).tau<tau);assert.ok(voice.lowpass.frequency.value<cutoff);assert.equal(audio.context.nodes.length,count);await audio.destroy();
});
test('audio is lazy, bounded, fades between targets and releases its context',async()=>{
  let created=0;const c=new Context(),audio=new SelectedEntityAudio({createContext:()=>{created++;return c;}});
  audio.update({entity:uam,distance:10});assert.equal(created,0);
  assert.equal(await audio.enable(),true);audio.update({entity:uam,distance:10});
  const count=c.nodes.length;const first=audio.active;
  audio.update({entity:{...uam,entity_id:'u2'},distance:10});assert.notEqual(audio.active,first);
  assert.equal(audio.voices[first].output.gain.value,0);
  for(let i=0;i<200;i++)audio.update({entity:{...uam,entity_id:`u${i}`},distance:i});
  assert.equal(c.nodes.length,count);
  audio.setVolume(.4);assert.equal(audio.volume,.4);
  await audio.setHidden(true);assert.equal(c.state,'suspended');
  await audio.setHidden(false);assert.equal(c.state,'running');
  audio.update(null);assert.ok(audio.voices.every(v=>v.output.gain.value===0));
  await audio.destroy();assert.equal(c.state,'closed');assert.ok(c.nodes.filter(n=>n.started).every(n=>n.stopped));
});
test('unsupported or rejected audio activation remains muted',async()=>{
  const audio=new SelectedEntityAudio({createContext:()=>{throw Error('unsupported');}});
  assert.equal(await audio.enable(),false);assert.equal(audio.enabled,false);
  const c=new Context();c.resume=async()=>{throw Error('denied');};
  const denied=new SelectedEntityAudio({createContext:()=>c});assert.equal(await denied.enable(),false);
  assert.equal(denied.enabled,false);await denied.destroy();
});

test('selection adapter uses displayed telemetry and world camera distance, never stale scratch data',()=>{
  const entity={...uam,source:'physical_uam'},item={entity,position:{x:10,y:20,z:30}};
  const globe={selected:'u1',items:new Map([['u1',item]]),viewer:{camera:{positionWC:{x:13,y:24,z:30}}},
    entityScene:{layers:{uam:{visible:true}},samples:{renderTime:()=>123,telemetryAt:()=>({rotor_radps:220,tilt_deg:44})}}};
  const at=selectedSoundSample(globe);assert.equal(at.distance,5);assert.equal(at.entity.rotor_radps,220);
  assert.equal(entity.rotor_radps,300);entity.rotor_radps=null;
  assert.equal(selectedSoundSample(globe).entity.rotor_radps,null);
  globe.entityScene.layers.uam.visible=false;assert.equal(selectedSoundSample(globe),null);
  globe.selected=null;assert.equal(selectedSoundSample(globe),null);
});

test('controls default on, unlock on interaction, persist mute, and stop polling when hidden',async()=>{
  const elements=Object.fromEntries(['sound-toggle','sound-volume','sound-volume-value','sound-status'].map(id=>[id,{value:'45',setAttribute(k,v){this[k]=v;}}]));
  const listeners=new Map(),document={hidden:false,getElementById:id=>elements[id],addEventListener:(k,v)=>listeners.set(k,v),removeEventListener:k=>listeners.delete(k)};
  const c=new Context(),audio=new SelectedEntityAudio({createContext:()=>c});
  const saved=[],controls=new EntitySoundControls({document,audio,readSample:()=>({entity:uam,distance:100}),storage:{getItem:()=>null,setItem:(...v)=>saved.push(v)}});
  assert.equal(audio.enabled,false);assert.equal(controls.preferred,true);await controls.activate();assert.equal(audio.enabled,true);
  assert.ok(controls.timer);elements['sound-volume'].value='60';elements['sound-volume'].oninput();assert.equal(audio.volume,.6);
  assert.ok(saved.every(([key])=>key==='aerodt.sound.volume.v1'));
  document.hidden=true;await listeners.get('visibilitychange')();assert.equal(controls.timer,null);assert.equal(c.state,'suspended');
  document.hidden=false;await listeners.get('visibilitychange')();assert.ok(controls.timer);
  await elements['sound-toggle'].onclick();assert.equal(controls.timer,null);assert.equal(audio.enabled,false);
  assert.ok(saved.some(([k,v])=>k==='aerodt.sound.enabled.v1'&&v==='false'));await controls.destroy();assert.equal(listeners.size,0);
});

test('real display buffers cannot turn absent RPM into a measured zero, and preview takes focus',()=>{
  const samples=new DisplaySamples(),entity={...uam,rotor_radps:null,tilt_deg:null,position_ecef_m:[10,20,30]};
  samples.replace({sequence:1,state_time:100,entities:[entity]},100000);samples.position('u1',100000);
  const globe={selected:'u1',items:new Map([['u1',{entity,position:{x:10,y:20,z:30}}]]),
    viewer:{camera:{positionWC:{x:13,y:24,z:30}}},entityScene:{layers:{uam:{visible:true}},samples}};
  const at=selectedSoundSample(globe);assert.equal(at.entity.rotor_radps,null);
  assert.ok(entitySoundProfile(at.entity,at.distance).level>0);
  globe.flightAnchor={x:13,y:24,z:25};globe.followedFlightSample={rotor_radps:350,kind:'air',stage:'cruise'};
  assert.equal(selectedSoundSample(globe).entity.entity_id,'preview:selected-flight');
  assert.equal(selectedSoundSample(globe).entity.rotor_radps,350);
});

test('partial context setup failure closes the failed graph and can be retried',async()=>{
  const bad=new Context(),good=new Context();bad.createPeriodicWave=()=>{throw Error('wave allocation failed');};
  let count=0;const audio=new SelectedEntityAudio({createContext:()=>++count===1?bad:good});
  assert.equal(await audio.enable(),false);assert.equal(bad.state,'closed');
  assert.equal(await audio.enable(),true);audio.update({entity:uam,distance:100});assert.equal(audio.voices.length,2);
  await audio.destroy();
});

test('single cockpit keeps replay sound without an external tracking anchor',()=>{
 const globe={cockpit:{active:true,single:true,entityId:'preview:selected-flight'},items:new Map(),flightLayer:{sample:{stage:'cruise',position:{longitude:127,latitude:37,altitude_m:300},rotor_radps:100},asset:()=>({asset_id:'kp2a'})},C:{Cartesian3:{fromDegrees:()=>({x:1,y:2,z:3})}},viewer:{camera:{positionWC:{x:1,y:2,z:4}}}};
 const sample=selectedSoundSample(globe);assert.ok(sample);assert.equal(sample.entity.visual_asset_id,'kp2a');assert.equal(sample.distance,1);
});


test('scene audio works without selection, pans traffic, excludes stopped and hidden entities, caps interpolation',()=>{
 const items=new Map(Array.from({length:1500},(_,i)=>['a'+i,{entity:{...uam,entity_id:'a'+i},position:{x:i+10,y:0,z:0}}]));
 let calls=0;
 const globe={items,viewer:{camera:{positionWC:{x:0,y:0,z:0},rightWC:{x:1,y:0,z:0},positionCartographic:{height:100}}},entityScene:{layers:{uam:{visible:true}},samples:{renderTime:()=>1,telemetryAt:()=>{calls++;return {rotor_radps:320};}}}};
 let frame=sceneSoundSample(globe,0);assert.equal(frame.nearby.length,6);assert.equal(calls,6);assert.ok(frame.environment);assert.equal(frame.nearby[0].pan,1);
 globe.viewer.camera.rightWC.x=-1;assert.equal(sceneSoundSample(globe,50).nearby[0].pan,-1);
 globe.selected='a0';frame=sceneSoundSample(globe,60);assert.ok(frame.nearby.every(s=>s.entity.entity_id!=='a0'));
 items.get('a1').entity.rotor_radps=0;assert.ok(sceneSoundSample(globe,70).nearby.every(s=>s.entity.entity_id!=='a1'));
 globe.entityScene.layers.uam.visible=false;assert.equal(sceneSoundSample(globe,80).nearby.length,0);
 globe.sceneMode='2d';assert.equal(sceneSoundSample(globe,90),null);
});

test('traffic voices retain identity, release before reuse, and share global mute lifecycle',async()=>{
 const c=new Context(),audio=new SelectedEntityAudio({createContext:()=>c});await audio.enable();
 const others=Array.from({length:10},(_,i)=>({entity:{...uam,entity_id:'t'+i},distance:20+i,pan:i%2?1:-1}));
 audio.update({nearby:others,environment:{speed:0}});assert.equal(audio.traffic.filter(v=>v.key).length,6);
 const first=audio.traffic.find(v=>v.key==='t0'),count=c.nodes.length;assert.equal(first.panner.pan.value,-1);assert.ok(audio.ambient.output.gain.value>0);
 audio.update({nearby:others.slice(0,6).reverse()});assert.equal(audio.traffic.find(v=>v.key==='t0'),first);
 audio.update({nearby:others.slice(6)});assert.equal(audio.traffic.filter(v=>v.key).length,0);
 c.currentTime=1;audio.update({nearby:others.slice(6),cockpit:true});assert.equal(audio.traffic.filter(v=>v.key).length,4);assert.equal(c.nodes.length,count);
 audio.setMix('traffic',0);audio.setMix('environment',0);audio.update({nearby:others,environment:{speed:1}});
 assert.ok(audio.traffic.every(v=>v.output.gain.value===0));assert.equal(audio.ambient.output.gain.value,0);
 audio.update(null);assert.ok(audio.traffic.every(v=>v.output.gain.value===0));await audio.destroy();assert.ok(c.nodes.filter(n=>n.started).every(n=>n.stopped));
});

test('steady RPM does not accumulate identical audio automation and retarget holds the envelope',async()=>{
 const c=new Context(),audio=new SelectedEntityAudio({createContext:()=>c});await audio.enable();audio.update({entity:uam,distance:10});
 const frequency=audio.voices[audio.active].tones[0].frequency,count=frequency.events.length;let holds=0;frequency.cancelAndHoldAtTime=()=>holds++;
 for(let i=0;i<100;i++)audio.update({entity:uam,distance:10});assert.equal(frequency.events.length,count);
 audio.update({entity:{...uam,rotor_radps:350},distance:10});assert.equal(holds,1);await audio.destroy();
});


test('assigned cockpit and exterior audio follow manual native RPM rather than parked fleet telemetry',()=>{
 const item={entity:{...uam,rotor_radps:0,flight_phase:'parked',quality:'stale',motor_state:'off'},position:{x:0,y:0,z:0}};
 const manual={rotor_radps:350,tilt_deg:0,airborne:true,stage:'cruise',manual:true,position:{longitude:127,latitude:37,altitude_m:80}};
 const globe={cockpit:{active:true,entityId:'u1'},selected:'u1',items:new Map([['u1',item]]),viewer:{camera:{positionWC:{x:0,y:0,z:3}}},entityScene:{manualSample:()=>manual}};
 let sample=selectedSoundSample(globe);assert.equal(sample.entity.rotor_radps,350);assert.ok(entitySoundProfile(sample.entity,sample.distance).level>0);
 globe.cockpit.active=false;sample=selectedSoundSample(globe);assert.equal(sample.entity.rotor_radps,350);
 manual.rotor_radps=0;assert.equal(entitySoundProfile(selectedSoundSample(globe).entity,3).level,0);
 assert.equal(item.entity.rotor_radps,0);assert.equal(item.entity.quality,'stale');
});

test('default cockpit mix retains audible own rotor level and softly isolates environment',async()=>{
 const a=new SelectedEntityAudio({createContext:()=>new Context()});await a.enable();a.update({entity:uam,distance:3,environment:{speed:.4}});
 const exterior=a.voices[a.active].output.gain.value,environment=a.ambient.output.gain.value;
 a.update({entity:uam,distance:3,cockpit:true,environment:{speed:.4}});
 assert.ok(a.voices[a.active].output.gain.value>=exterior*.89);assert.ok(a.ambient.output.gain.value>=environment*.5);assert.ok(a.master.gain.value>.28);
 await a.destroy();
});

test('effects use bounded voices, suppress repeats and obey master mute',async()=>{
 const c=new Context(),a=new SelectedEntityAudio({createContext:()=>c});assert.equal(a.playEffect('click'),false);await a.enable();const n=c.nodes.length;
 for(const kind of ['click','request','received','error']){assert.equal(a.playEffect(kind),true);assert.equal(a.playEffect(kind),false);}
 for(let i=0;i<100;i++){c.currentTime+=.3;assert.equal(a.playEffect('received'),true);}assert.equal(c.nodes.length,n);assert.equal(a.effects.length,4);
 a.disable();assert.equal(a.playEffect('click'),false);await a.destroy();assert.ok(c.nodes.filter(n=>n.started).every(n=>n.stopped));
});
test('saved mute prevents default activation',async()=>{
 const el={setAttribute(){}};const document={hidden:false,getElementById:()=>el,addEventListener(){},removeEventListener(){}};
 const a=new SelectedEntityAudio({createContext:()=>new Context()}),controls=new EntitySoundControls({document,audio:a,readSample:()=>null,storage:{getItem:k=>k==='aerodt.sound.enabled.v1'?'false':null,setItem(){}}});
 assert.equal(controls.preferred,false);assert.equal(await controls.activate(),false);assert.equal(a.enabled,false);await controls.destroy();
});
