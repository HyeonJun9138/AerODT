// User input only. Authoritative motion remains in the runtime, never in this module.
import {loadProfile, mapPad} from '../../../joystick_profile.js?v=20260917-hardware';

const SOURCES = ['keyboard', 'screen', 'joystick'];

export class ManualFlightInput {
  constructor({target=globalThis.window,onChange=()=>{},onSuspend=()=>{},onReturn=()=>{},onLook=()=>{},onAction=()=>{},getGamepads,storage}={}) {
    Object.assign(this,{target,onChange,onSuspend,onReturn,onLook,onAction});this.keys=new Set();this.throttle=0;this.mode='multirotor';this.source='keyboard';this.active=false;
    // Injected so the mapping can be exercised without a device attached.
    this.getGamepads=getGamepads??(()=>{try{return globalThis.navigator?.getGamepads?.()??[];}catch{return [];}});
    this.storage=storage;this.padIndex=null;this.profile=loadProfile('',storage);this.padState=null;
    this.down=e=>this.key(e,true);this.up=e=>this.key(e,false);this.blur=()=>{this.returnOnFocus=this.returnOnFocus||this.active;this.suspend('focus');};this.focus=()=>{if(this.returnOnFocus){this.returnOnFocus=false;this.onReturn();}};
    target?.addEventListener('keydown',this.down,true);target?.addEventListener('keyup',this.up,true);target?.addEventListener('blur',this.blur);target?.addEventListener('focus',this.focus);
  }
  key(e,down){
    if(!down)this.keys.delete(e.code);
    if(!this.active||this.source!=='keyboard')return;
    // A key held during loading must be released and pressed anew. Browser
    // auto-repeat after readiness is not a fresh pilot command.
    if(down&&e.repeat&&!this.keys.has(e.code))return;
    if(e.ctrlKey||e.altKey||e.metaKey||e.target?.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName??'')){this.keys.clear();return;}
    if(!['KeyQ','KeyE','KeyW','KeyS','KeyZ','KeyX','ShiftLeft','ShiftRight','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))return;
    e.preventDefault?.();e.stopImmediatePropagation?.();
    if(down){this.keys.add(e.code);if(!e.repeat&&e.code==='KeyZ')this.setMode('fixed_wing');if(!e.repeat&&e.code==='KeyX')this.setMode('multirotor');}
  }
  setMode(mode){if(!['fixed_wing','multirotor'].includes(mode))throw new Error('Invalid flight mode');this.mode=mode;}
  setSource(source){if(!SOURCES.includes(source))throw new Error('Invalid input source');this.keys.clear();this.stick={x:0,y:0};this.padState=null;this.yaw=0;this.sendLook(0,0);this.source=source;this.groundIdleSeconds=0;this.groundIdleActive=false;}
  setYaw(value){if(Number.isFinite(value))this.yaw=Math.max(-1,Math.min(1,value));}
  setThrottle(value){if(Number.isFinite(value))this.throttle=Math.max(0,Math.min(1,value));}
  setStick(x,y){if(!Number.isFinite(x)||!Number.isFinite(y))return;const radius=Math.hypot(x,y),amount=Math.pow(Math.max(0,(Math.min(1,radius)-.04)/.96),1.5);this.stick=radius?{x:x/radius*amount,y:y/radius*amount}:{x:0,y:0};}
  // Idle jitter is a ground-only input condition, not a flight deadzone.
  // Require fresh stationary contact and a short stable interval; a deliberate
  // deflection leaves the latch immediately. The server still checks rotor stop,
  // deck contact and gate position before it accepts a ground procedure.
  groundIdle(command,sample,seconds){
    const axes=['roll','pitch','yaw'],near=(throttle,stick)=>
      Number.isFinite(command?.throttle)&&command.throttle>=0&&command.throttle<=throttle&&
      axes.every(k=>Number.isFinite(command?.[k])&&Math.abs(command[k])<=stick);
    const eligible=this.source==='joystick'&&command?.input_source==='joystick'&&sample?.airborne===false&&
      Number.isFinite(sample.speed_mps)&&sample.speed_mps<=.15;
    if(!eligible||!near(this.groundIdleActive ? .015 : .01,this.groundIdleActive ? .035 : .02)){
      this.groundIdleSeconds=0;this.groundIdleActive=false;return command;
    }
    this.groundIdleSeconds=(this.groundIdleSeconds??0)+Math.max(0,Math.min(.1,seconds||0));
    if(this.groundIdleSeconds>=.3)this.groundIdleActive=true;
    if(!this.groundIdleActive)return command;
    this.throttle=0;
    return {...command,throttle:0,roll:0,pitch:0,yaw:0};
  }
  // Where the head switch is pointing -- not how far the view should jump. The
  // jump belongs to whatever is drawing frames; sending one from here, on a
  // tick that fires once every three frames, is what made the view move in
  // steps. Sent while the switch is held and once more when it is let go, so
  // the far end can hold the last word without being told it every frame, and
  // so nothing keeps turning after the switch, the stick or the session is gone.
  sendLook(x,y,zoom=0){
    const held=Boolean(x||y||zoom);
    if(!held&&!this.looking)return;
    this.looking=held;
    this.onLook(x,y,this.profile?.view?.speed??1,zoom);
  }
  // The device the operator tuned, chosen by index when one has been picked and
  // otherwise the first one the browser reports. A gamepad slot can hold a
  // disconnected entry, so a live `connected` is what counts as present.
  pad(){
    const pads=[...(this.getGamepads()??[])].filter(pad=>pad&&pad.connected!==false);
    if(this.padIndex!=null){const chosen=pads.find(pad=>pad.index===this.padIndex);if(chosen)return chosen;}
    return pads[0]??null;
  }
  setProfile(profile){this.profile=profile;this.padState=null;}
  selectPad(index){this.padIndex=Number.isInteger(index)?index:null;this.padState=null;}
  start(){this.keys.clear();this.active=true;}
  suspend(reason='user'){this.keys.clear();this.stick={x:0,y:0};this.padState=this.padState?{down:this.padState.down}:null;this.yaw=0;this.sendLook(0,0);this.active=false;this.groundIdleSeconds=0;this.groundIdleActive=false;this.onSuspend(reason);}
  // One reading of the stick, turned into the same four numbers the keyboard
  // and the screen produce. Buttons act here rather than in the panel because
  // a mode change has to be in the command that leaves on this tick.
  readJoystick(dt,flight=true){
    const pad=this.pad();
    if(!pad){
      // Never found and gone missing are different sentences. Saying a cable
      // came out when it was never in sends the operator to the wrong place --
      // and opening the dashboard from another PC is exactly where that lands.
      if(this.padPresent!==false){const had=this.padPresent===true;this.padPresent=false;this.onAction(had?'device_lost':'device_absent');}
      // Attitude goes neutral so a vanished stick cannot keep commanding a
      // turn; throttle is retained, as releasing the keys does. The view is let
      // go for the same reason: a switch unplugged mid-push would otherwise
      // leave the camera turning with nothing left to stop it.
      this.padState=null;this.sendLook(0,0);return {roll:0,pitch:0,yaw:0,precision:1};
    }
    // A stick that turns up carries its own tuning. Without this the input kept
    // the profile it was built with -- the unnamed default -- and the saved one
    // only arrived if the operator opened the window and pressed 저장 again.
    if(this.padPresent!==true||(pad.id&&pad.id!==this.profile?.deviceId)){
      this.padPresent=true;this.padState=null;
      // The name is written back so this cannot re-fire every tick when a
      // stored profile carries a different one.
      if(pad.id&&pad.id!==this.profile?.deviceId){this.profile=loadProfile(pad.id,this.storage);this.profile.deviceId=pad.id;}
      this.onAction('device_found');
    }
    // The filter needs to know how long it has been: the send tick is nominally
    // 50 ms but a busy frame stretches it, and a fixed step would then steady the
    // stick by a different amount each time.
    const reading=mapPad(pad,this.profile,this.padState,dt||1/20);this.padState=reading;
    for(const action of reading.pressed){
      if(!flight&&action.startsWith('mode_'))continue;
      if(action==='mode_multirotor')this.setMode('multirotor');
      else if(action==='mode_fixed_wing')this.setMode('fixed_wing');
      else if(action==='mode_toggle')this.setMode(this.mode==='multirotor'?'fixed_wing':'multirotor');
      else this.onAction(action);
    }
    if(flight)this.setThrottle(reading.axes.throttle);
    const vx=Math.max(-1,Math.min(1,reading.view.x+Number(reading.held.has('view_right'))-Number(reading.held.has('view_left'))));
    const vy=Math.max(-1,Math.min(1,reading.view.y+Number(reading.held.has('view_down'))-Number(reading.held.has('view_up'))));
    const zoom=(reading.held.has('view_zoom_in')?-1:0)+(reading.held.has('view_zoom_out')?1:0);
    this.sendLook(vx,vy,zoom);
    return {roll:reading.axes.roll,pitch:reading.axes.pitch,yaw:reading.axes.yaw,
      precision:reading.held.has('precision')?0.25:1};
  }
  update(seconds){
    const dt=Number.isFinite(seconds)?Math.max(0,Math.min(.1,seconds)):0;
    if(!this.active){if(this.source==='joystick'&&!globalThis.document?.hidden)this.readJoystick(dt,false);return null;}
    if(this.source==='joystick'){
      const {roll,pitch,yaw,precision}=this.readJoystick(dt);
      if(!this.active)return null; // A pause button can suspend inside this reading.
      const command={throttle:this.throttle,roll:roll*precision,pitch:pitch*precision,yaw:yaw*precision,flight_mode:this.mode,input_source:'joystick'};
      this.onChange(command);return command;
    }
    if(this.source==='keyboard')this.setThrottle(this.throttle+dt*.02*(Number(this.keys.has('KeyW'))-Number(this.keys.has('KeyS'))));
    const x=this.source==='keyboard'?Number(this.keys.has('ArrowRight'))-Number(this.keys.has('ArrowLeft')):(this.stick?.x??0);
    const y=this.source==='keyboard'?Number(this.keys.has('ArrowDown'))-Number(this.keys.has('ArrowUp')):(this.stick?.y??0);
    const precision=(this.keys.has('ShiftLeft')||this.keys.has('ShiftRight')) ? 0.25 : 1;
    const command={throttle:this.throttle,roll:x*precision,pitch:y*precision,yaw:this.source==='keyboard'?(Number(this.keys.has('KeyE'))-Number(this.keys.has('KeyQ')))*precision:(this.yaw??0),flight_mode:this.mode,input_source:this.source};this.onChange(command);return command;
  }
  destroy(){this.suspend();this.target?.removeEventListener('keydown',this.down,true);this.target?.removeEventListener('keyup',this.up,true);this.target?.removeEventListener('blur',this.blur);this.target?.removeEventListener('focus',this.focus);}
}
