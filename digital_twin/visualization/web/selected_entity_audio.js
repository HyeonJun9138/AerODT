import {entitySoundProfile} from './entity_sound_profile.js';

// The audio clock owns smoothing. No per-frame buffer generation, file loads,
// runtime commands or simulated-time acceleration of oscillator pitch.
const scheduledTargets=new WeakMap();
// Rotors are no longer the only thing an aircraft can be heard doing: one with
// its rotors stopped still rolls across a deck, and one in the air still drives
// its nacelles over. A voice is wanted if any of the three is happening.
const audible=profile=>profile.level>0||profile.roll>0||profile.servo>0;
// How many aircraft's tilt histories are kept. One is selected and six are
// traffic, so this is already generous; it exists so a fleet flying past over
// an afternoon cannot turn the measurement into a register of everything ever
// heard.
const MOTION_MEMORY=24;
function target(param,value,time,tau=.28){
  const previous=scheduledTargets.get(param);
  if(previous?.value===value&&previous.tau===tau)return;
  scheduledTargets.set(param,{value,tau});
  param.cancelAndHoldAtTime?.(time);
  // Preserve the running envelope: cancelling a target can jump back to its
  // previous event value. Web Audio computes continuity when retargeted.
  param.setTargetAtTime(value,time,tau);
}
function makeVoice(context,destination,noise,wave,offset=0) {
  const nodes=[],sources=[];
  const make=method=>{const node=context[method]();nodes.push(node);return node;};
  const output=make('createGain');output.gain.value=0;
  const panner=make('createStereoPanner');output.connect(panner);panner.connect(destination);
  const lowpass=make('createBiquadFilter');lowpass.type='lowpass';lowpass.Q.value=.55;lowpass.frequency.value=1600;lowpass.connect(output);
  const rotor=make('createGain');rotor.gain.value=0;rotor.connect(lowpass);
  const tones=[];
  for(const detune of [-2.5,2.5]){
    const osc=make('createOscillator');osc.setPeriodicWave(wave);osc.detune.value=detune;osc.frequency.value=100;
    // Unequal layers avoid the deep periodic cancellation of two equally
    // loud, slightly detuned rotors (heard as an artificial on/off pulse).
    const layer=make('createGain');layer.gain.value=tones.length?.32:1;
    osc.connect(layer);layer.connect(rotor);sources.push(osc);tones.push(osc);
  }
  const motor=make('createOscillator');motor.type='sine';motor.frequency.value=500;
  const motorGain=make('createGain');motorGain.gain.value=0;motor.connect(motorGain);motorGain.connect(lowpass);sources.push(motor);
  const air=make('createBufferSource');air.buffer=noise;air.loop=true;
  const airFilter=make('createBiquadFilter');airFilter.type='bandpass';airFilter.frequency.value=650;airFilter.Q.value=.6;
  const airGain=make('createGain');airGain.gain.value=0;air.connect(airFilter);airFilter.connect(airGain);airGain.connect(lowpass);sources.push(air);
  const flutter=make('createOscillator');flutter.type='sine';flutter.frequency.value=12;
  const flutterDepth=make('createGain');flutterDepth.gain.value=0;flutter.connect(flutterDepth);flutterDepth.connect(rotor.gain);sources.push(flutter);
  // Wheels on a deck: low and broadband, nothing tonal in it. It takes a second
  // tap off the noise already running rather than starting another source --
  // eight voices are built, and looping buffer sources are the expensive part.
  const rollFilter=make('createBiquadFilter');rollFilter.type='lowpass';rollFilter.frequency.value=170;rollFilter.Q.value=.9;
  const rollGain=make('createGain');rollGain.gain.value=0;
  air.connect(rollFilter);rollFilter.connect(rollGain);rollGain.connect(lowpass);
  // The tilt actuators: a narrow band that exists only while something is being
  // driven. A tone for the drive and a little of the same noise through the same
  // narrow filter for the grain of the mechanism, so it reads as machinery
  // rather than as a sine being faded up.
  const servo=make('createOscillator');servo.type='sawtooth';servo.frequency.value=180;
  const servoFilter=make('createBiquadFilter');servoFilter.type='bandpass';servoFilter.frequency.value=900;servoFilter.Q.value=3.2;
  const servoGrain=make('createGain');servoGrain.gain.value=.45;
  const servoGain=make('createGain');servoGain.gain.value=0;
  servo.connect(servoFilter);air.connect(servoGrain);servoGrain.connect(servoFilter);
  servoFilter.connect(servoGain);servoGain.connect(lowpass);sources.push(servo);
  for(const source of sources){if(source===air)source.start(0,offset);else source.start();}
  return {output,panner,lowpass,rotor,tones,motor,motorGain,airFilter,airGain,flutter,flutterDepth,
    rollFilter,rollGain,servo,servoFilter,servoGain,nodes,sources};
}

function makeAmbient(context,destination,noise){
  const output=context.createGain();output.gain.value=0;output.connect(destination);
  const lowpass=context.createBiquadFilter();lowpass.type='lowpass';lowpass.Q.value=.5;lowpass.connect(output);
  const airFilter=context.createBiquadFilter();airFilter.type='bandpass';airFilter.Q.value=.45;airFilter.connect(lowpass);
  const airGain=context.createGain();airGain.gain.value=0;airGain.connect(airFilter);
  const air=context.createBufferSource();air.buffer=noise;air.loop=true;air.connect(airGain);air.start(0,8.3);
  const gust=context.createOscillator();gust.frequency.value=.13;
  const depth=context.createGain();depth.gain.value=.045;gust.connect(depth);depth.connect(airGain.gain);gust.start();
  return {output,lowpass,airGain,airFilter,sources:[air,gust],nodes:[output,lowpass,airFilter,airGain,air,gust,depth]};
}

export class SelectedEntityAudio {
  constructor({createContext=()=>new (globalThis.AudioContext??globalThis.webkitAudioContext)()}={}){
    this.createContext=createContext;this.enabled=false;this.hidden=false;this.volume=.45;this.voices=[];this.active=0;this.key=null;this.version=0;this.traffic=[];this.trafficVolume=.65;this.environmentVolume=.45;
    this.motion=new Map();
  }
  // A tilt angle says where the nacelles are; only its rate says whether
  // anything is driving them, and that takes two observations. Smoothed,
  // because updates are 50 ms apart and the angle arrives rounded: the raw
  // difference quantises into steps of several degrees a second, and an
  // actuator built straight on it chatters instead of running.
  tiltRate(entity){
    const id=entity?.entity_id,now=this.context.currentTime;
    if(!id||!Number.isFinite(entity.tilt_deg))return 0;
    const seen=this.motion.get(id),gap=seen?now-seen.at:0;
    if(seen&&gap<=1e-3)return seen.rate;    // same audio frame: nothing new to measure
    // A gap long enough for the aircraft to have done anything in between says
    // nothing about a servo, so the measurement starts again rather than
    // reporting the whole change as one sweep.
    const rate=!seen||gap>1.5?0:seen.rate+((entity.tilt_deg-seen.tilt)/gap-seen.rate)*.35;
    // Deleted before it is set, so insertion order is recency order and the
    // eviction below takes the least recently heard rather than whichever
    // aircraft happened to be heard first and has been flying ever since.
    this.motion.delete(id);this.motion.set(id,{tilt:entity.tilt_deg,at:now,rate});
    if(this.motion.size>MOTION_MEMORY){
      for(const [key,value] of this.motion)if(now-value.at>5)this.motion.delete(key);
      const excess=this.motion.size-MOTION_MEMORY;
      if(excess>0)for(const key of [...this.motion.keys()].slice(0,excess))this.motion.delete(key);
    }
    return rate;
  }
  profileFor(sample){
    return entitySoundProfile(sample?.entity,sample?.distance,{tiltRate:this.tiltRate(sample?.entity)});
  }
  build(){
    const c=this.context=this.createContext();
    this.master=c.createGain();this.master.gain.value=0;
    this.limiter=c.createDynamicsCompressor();
    for(const [key,value] of Object.entries({threshold:-12,knee:6,ratio:8,attack:.005,release:.2}))this.limiter[key].value=value;
    this.master.connect(this.limiter);this.limiter.connect(c.destination);
    const dataLength=Math.ceil(c.sampleRate*11),buffer=c.createBuffer(1,dataLength,c.sampleRate),data=buffer.getChannelData(0);
    // Warm the colour filter with a full period before writing its output.
    // The wrap is an ordinary noise transition, with no repeating fade/notch.
    let seed=0x4ae0d7,low=0;
    for(let i=0;i<dataLength;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[i]=seed/2147483648-1;}
    for(let i=0;i<dataLength;i++)low=.88*low+.12*data[i];
    for(let i=0;i<dataLength;i++){low=.88*low+.12*data[i];data[i]=low*2;}
    const wave=c.createPeriodicWave(new Float32Array(7),new Float32Array([0,1,.3,.14,.07,.035,.015]));
    this.voices=[makeVoice(c,this.master,buffer,wave),makeVoice(c,this.master,buffer,wave,1.7)];
    this.traffic=Array.from({length:6},(_,i)=>({...makeVoice(c,this.master,buffer,wave,2+i),key:null,releaseUntil:0}));
    this.ambient=makeAmbient(c,this.master,buffer);
    this.effects=Array.from({length:4},()=>{
      const tone=c.createOscillator(),gain=c.createGain();tone.type='sine';gain.gain.value=0;
      tone.connect(gain);gain.connect(this.master);tone.start();return {tone,gain,sources:[tone],nodes:[tone,gain]};
    });this.effectIndex=0;this.effectTimes=new Map();
    this.ready=true;
  }
  async enable(){
    if(this.disposed)return false;
    const version=++this.version;clearTimeout(this.suspendTimer);
    try{
      if(!this.context)this.build();
      if(!this.hidden)await this.context.resume();
      if(version!==this.version||this.disposed)return false;
      if(this.hidden)await this.context.suspend();
      this.enabled=true;this.applyVolume();return true;
    }catch{
      this.enabled=false;
      if(!this.ready){
        await this.context?.close().catch(()=>{});
        this.context=null;this.master=null;this.limiter=null;this.voices=[];this.traffic=[];this.ambient=null;
      }
      return false;
    }
  }
  applyVolume(){if(this.master)target(this.master.gain,this.enabled&&!this.hidden?this.volume**1.3*.85:0,this.context.currentTime,.16);}
  setVolume(value){if(Number.isFinite(value)){this.volume=Math.max(0,Math.min(1,value));this.applyVolume();}}
  setMix(channel,value){
    if(['traffic','environment'].includes(channel)&&Number.isFinite(value))this[channel+'Volume']=Math.max(0,Math.min(1,value));
  }
  disable(){
    this.version++;this.enabled=false;this.applyVolume();clearTimeout(this.suspendTimer);
    this.suspendTimer=setTimeout(()=>{if(!this.enabled&&!this.disposed)void this.context?.suspend().catch(()=>{});},800);
  }
  async setHidden(hidden){
    this.hidden=Boolean(hidden);this.applyVolume();
    if(!this.context||this.disposed)return;
    if(hidden){this.master.gain.cancelScheduledValues(this.context.currentTime);this.master.gain.setValueAtTime(0,this.context.currentTime);scheduledTargets.delete(this.master.gain);await this.context.suspend().catch(()=>{});}
    else if(this.enabled){try{await this.context.resume();this.applyVolume();}catch{this.disable();}}
  }
  update(sample){
    if(!this.enabled||this.hidden||this.disposed||!this.context)return;
    const c=this.context,profile=this.profileFor(sample),key=sample?.entity?.entity_id??null;
    if(key!==this.key){target(this.voices[this.active].output.gain,0,c.currentTime,.23);this.active=1-this.active;this.key=key;}
    if(!key||!audible(profile)){for(const voice of this.voices)target(voice.output.gain,0,c.currentTime,.25);}
    else this.updateVoice(this.voices[this.active],sample,profile,sample.cockpit?1.25:1);
    this.updateTraffic(sample);
    const env=sample?.environment;
    const wind=Math.max(0,Math.min(1,env?.speed??0)),cockpit=Boolean(sample?.cockpit);
    const ambientLevel=env ? this.environmentVolume/.45* (cockpit?.55:1)*(.035+.10*wind) : 0;
    target(this.ambient.output.gain,ambientLevel,c.currentTime,env?1.2:.25);
    target(this.ambient.airGain.gain,.45,c.currentTime,.7);
    target(this.ambient.airFilter.frequency,180+wind*550,c.currentTime,.8);
    target(this.ambient.lowpass.frequency,cockpit?850:2400,c.currentTime,.7);
  }
  updateTraffic(sample){
    const now=this.context.currentTime;
    const nearby=(sample?.nearby??[]).filter(s=>s.entity?.entity_id!==this.key)
      .map(s=>({sample:s,profile:this.profileFor(s)}))
      .filter(s=>audible(s.profile)).slice(0,6);
    const ids=new Set(nearby.map(s=>s.sample.entity.entity_id));
    for(const voice of this.traffic){
      if(voice.key&&!ids.has(voice.key)){
        voice.key=null;voice.releaseUntil=now+.8;target(voice.output.gain,0,now,.16);
      }
    }
    for(const {sample:other,profile} of nearby){
      const id=other.entity.entity_id;
      const voice=this.traffic.find(v=>v.key===id)??this.traffic.find(v=>!v.key&&v.releaseUntil<=now);
      if(!voice)continue;
      voice.key=id;
      this.updateVoice(voice,{...other,cockpit:sample.cockpit},profile,this.trafficVolume*(sample.cockpit?.46:1));
    }
  }
  updateVoice(v,sample,profile,level){
    const c=this.context,space=profile.timbre==='space',jet=profile.timbre==='jet';
    const response=sample?.entity?.manual ? .10 : .38;
    const rotor=space?.075:jet?.025:.065*(1-.3*profile.cruise);
    // What each part is worth at the listener, before they are folded into the
    // one output gain this voice has. An aircraft can be doing any of the three
    // without the others -- rolling with its rotors stopped is exactly the case
    // that used to be silent -- so the output carries the loudest of them and
    // each part is then set to its share of that.
    //
    // This is arranged so nothing changes in the air: with no roll and no servo
    // the presence *is* `profile.level`, every share is one, and each target
    // below is the value it has always been.
    const want={rotor:profile.level,roll:(profile.roll??0)*.42,servo:(profile.servo??0)*.5};
    const presence=Math.max(want.rotor,want.roll,want.servo);
    const share=part=>presence>0?want[part]/presence:0;
    const rotorShare=share('rotor');
    target(v.output.gain,presence*level*(sample.cockpit?.72:1),c.currentTime,.35);
    target(v.panner.pan,Number.isFinite(sample.pan)?Math.max(-1,Math.min(1,sample.pan)):0,c.currentTime,.18);
    for(let i=0;i<v.tones.length;i++)target(v.tones[i].frequency,profile.frequency*(space&&i?1.5:1),c.currentTime,response);
    target(v.rotor.gain,rotor*rotorShare,c.currentTime);
    target(v.motor.frequency,profile.frequency*(space?2:jet?7:5.1),c.currentTime,response);
    target(v.motorGain.gain,(space?.012:jet?.015:.009+.008*profile.cruise)*rotorShare,c.currentTime);
    target(v.airGain.gain,(space?.015:jet?.65:.19+.24*profile.speed+.055*profile.cruise)*rotorShare,c.currentTime,.4);
    target(v.airFilter.frequency,space?230:jet?500+900*profile.speed:500+550*profile.speed,c.currentTime,.4);
    target(v.lowpass.frequency,profile.cutoff*(sample?.cockpit ? .62 : 1),c.currentTime,.2);
    target(v.flutter.frequency,profile.pulse,c.currentTime,.4);
    target(v.flutterDepth.gain,rotor*(space?.12:jet?.035:.055*(1-.45*profile.cruise))*rotorShare,c.currentTime);
    // Rolling settles like a surface; a servo must not. Its whole character is
    // that it starts and stops with the movement, so it is given a short time
    // constant and a pitch that rises with how fast the nacelles are being
    // driven, which is what an actuator under load actually does.
    target(v.rollGain.gain,.85*share('roll'),c.currentTime,.25);
    target(v.rollFilter.frequency,115+(profile.roll??0)*250,c.currentTime,.3);
    target(v.servoGain.gain,.6*share('servo'),c.currentTime,.06);
    target(v.servo.frequency,152+(profile.servoRate??0)*118,c.currentTime,.08);
    target(v.servoFilter.frequency,760+(profile.servoRate??0)*540,c.currentTime,.08);
  }
  playEffect(kind='click'){
    if(!this.enabled||this.hidden||this.disposed||this.context?.state!=='running'||!this.effects)return false;
    const patterns={click:[[0,720,.025,.085]],request:[[0,560,.05,.12],[.085,820,.07,.12]],received:[[0,880,.07,.14],[.12,1175,.11,.12]],error:[[0,340,.10,.12],[.16,270,.14,.10]]};
    const notes=patterns[kind];if(!notes)return false;
    const now=this.context.currentTime;
    if(now-(this.effectTimes.get(kind)??-Infinity)<(kind==='click'?.045:.25))return false;
    this.effectTimes.set(kind,now);
    const v=this.effects[this.effectIndex++%this.effects.length];
    v.gain.gain.cancelScheduledValues(now);v.gain.gain.setValueAtTime(0,now);v.tone.frequency.cancelScheduledValues(now);
    for(const [offset,hz,duration,level] of notes){
      const at=now+offset;v.tone.frequency.setValueAtTime(hz,at);
      v.gain.gain.setTargetAtTime(level,at,.003);v.gain.gain.setTargetAtTime(0,at+duration,.012);
    }
    return true;
  }
  async destroy(){
    this.disposed=true;this.enabled=false;this.version++;clearTimeout(this.suspendTimer);
    for(const v of [...this.voices,...this.traffic,...(this.ambient?[this.ambient]:[]),...(this.effects??[])]){for(const source of v.sources)source.stop();for(const node of v.nodes)node.disconnect();}
    this.voices=[];this.master?.disconnect();this.limiter?.disconnect();
    await this.context?.close().catch(()=>{});
  }
}
