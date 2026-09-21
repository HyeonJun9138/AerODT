import {buildElement} from '../../../dom_builder.js';
import {ManualFlightInput} from './manual_flight_input.js?v=20260918-pause-recovery';
import {JoystickSetupPanel} from '../../../joystick_setup_panel.js?v=20260917-hardware';

// Presentation and input only; the caller sends commands and supplies snapshots.
export class ManualFlightPanel {
  constructor({document=globalThis.document,target=globalThis.window,onCommand=()=>{},onPause=()=>{},onExit=()=>{},onResume=()=>{},
    onLook=()=>{},onAction=()=>{},onHold=()=>{},storage,getGamepads}={}){
    this.document=document;this.window=target;this.storage=storage;this.getGamepads=getGamepads;this.onResume=onResume;
    this.input=new ManualFlightInput({target,getGamepads,storage,onChange:onCommand,onReturn:onResume,onLook,
      onAction:(action,amount)=>this.handleAction(action,amount,onAction,onResume,onHold),
      onSuspend:reason=>{this.setStatus('held','대기',reason==='transport'?'응답 지연 · 연결 확인 후 자동 복귀':'입력 보호 중 · 창으로 돌아오면 자동 재개');onPause(reason);}});
    const e=(tag,attrs,...children)=>buildElement(document,tag,attrs,...children);
    const button=(text,onclick,extra={})=>e('button',{type:'button',text,onclick,...extra});
    // State and the button that fixes it were two controls side by side: a
    // sentence saying input was held, and a separate 'resume' to press. They
    // are one thing to an operator, so they are one control -- the chip reads
    // the state, and when the state is one you can leave, its label becomes the
    // way out. The key legend that used to ride along in the same sentence is
    // available in the bottom controls; it stays in the title.
    this.status=e('span',{class:'manual-status',text:'대기'});
    this.stateChip=e('button',{type:'button',class:'manual-state','data-state':'idle',
      onclick:()=>{if(this.state!=='held')return;onResume();this.paint();}},
      e('i',{class:'manual-dot','aria-hidden':'true'}),e('b',{class:'manual-badge',text:'MANUAL'}),this.status);
    this.source=e('select',{'aria-label':'조작 입력 방식',title:'조작 입력 방식 · 키보드 / 화면 스틱 / 조이스틱',onchange:()=>{
      this.releaseStick();this.input.setSource(this.source.value);
      // Picking the stick is also the request to set it up: the bindings are
      // the only thing standing between a connected device and a flying
      // aircraft, so the window opens the first time rather than hiding behind
      // a second control nobody would look for.
      if(this.source.value==='joystick')this.openJoystickSetup();else this.joystick?.close();
      if(!this.input.active)onResume();this.root?.focus?.({preventScroll:true});this.paint();
    }},e('option',{value:'keyboard',text:'키보드'}),e('option',{value:'screen',text:'화면'}),e('option',{value:'joystick',text:'조이스틱'}));this.source.value='keyboard';
    this.mode=e('select',{'aria-label':'비행 모드',title:'비행 모드 · X 멀티로터 / Z 고정익',onchange:()=>{this.input.setMode(this.mode.value);if(!this.input.active)onResume();this.root?.focus?.({preventScroll:true});}},e('option',{value:'multirotor',text:'멀티로터'}),e('option',{value:'fixed_wing',text:'고정익'}));
    this.root=e('section',{class:'manual-flight-panel',hidden:'',tabindex:'-1','aria-label':'수동 비행 조작'},
      // Settings do not belong on the operations strip. Which device is flying
      // the aircraft, and which flight mode it is in, are set at the flight
      // console -- the strip says what the aircraft is doing and how to stop.
      // The selects still exist, unmounted: they are the console's handles.
      e('div',{class:'manual-toolbar'},this.stateChip,button('종료',()=>onExit(),{class:'manual-exit',title:'수동 조작을 끝냅니다'})));
    // One path decides the label, so the chip never shows a state nobody set.
    // `idle` is not `held`: there is no session yet, so there is nothing to
    // resume and the chip is a label until one starts.
    this.setStatus('idle','대기','수동 입력 대기 · 계획에서 수동 실행하면 시작됩니다');
    this.locate=button('◎ 내 기체 찾기',()=>{onAction('find_aircraft');this.focusControls();},{class:'manual-locate',hidden:'','aria-label':'내 조종 기체 찾기',title:'현재 조종하는 기체를 확대하고 외부에서 추적합니다'});
    document.body.append(this.root,this.locate);this.paint();
    this.visibility=()=>{if(document.hidden)this.input.blur();else this.input.focus();};document.addEventListener?.('visibilitychange',this.visibility);
  }
  // `state` is what the engine and the browser say is happening; `text` is the
  // one word that says it, and `detail` the sentence behind it. Only a held
  // session can be resumed by pressing, so only then is the chip a button.
  setStatus(state,text,detail=''){
    this.state=state;
    if(!this.stateChip)return;
    const resumable=state==='held';
    this.stateChip.setAttribute('data-state',state);
    // Not `disabled`: a disabled button is greyed by the browser, and this chip
    // has to stay readable in every state -- it is the state display first and
    // a button only when there is something to press. The click is guarded.
    this.stateChip.setAttribute('aria-disabled',String(!resumable));
    this.status.textContent=resumable?'재개':text;
    this.stateChip.setAttribute('title',detail||text);
    this.stateChip.setAttribute('aria-label',`수동 조작 · ${text}${resumable?' · 눌러서 재개':''}`);
  }
  // The window is built the first time a stick is asked for, so a page that
  // never uses one never carries it.
  openJoystickSetup(){
    this.joystick??=new JoystickSetupPanel({document:this.document,window:this.window,
      storage:this.storage,getGamepads:this.getGamepads,
      onApply:profile=>{this.input.setProfile(profile);this.paint();},
      onClose:()=>this.releaseTuning(),
      onSelectPad:index=>this.input.selectPad(index)});
    // The aircraft is held while the bindings are changed. Finding an axis
    // means pushing the stick to its stop, and doing that to a flying aircraft
    // is exactly what the operator is not asking for.
    if(this.input.active){this.tuningHeld=true;this.input.suspend('tuning');}
    // After opening, not before: `open` loads the profile belonging to whatever
    // device is actually attached, and handing over the one from before that
    // would put the unnamed default back on a tuned stick.
    try{
      this.joystick.open();
      this.input.setProfile(this.joystick.profile);
    }catch(error){
      // The hold above is released by the window's own close. If the window
      // never opened there is nothing to close, and the aircraft would stay
      // held with its controls greyed out and no way back but Escape.
      this.releaseTuning();
      throw error;
    }
    return this.joystick;
  }
  releaseTuning(){
    if(!this.tuningHeld)return;
    this.tuningHeld=false;this.onResume?.();
  }
  // Buttons on the stick reach the rest of the application through here. Flight
  // modes are already applied in the input, because they belong to the command
  // that leaves on the same tick; what is left is the view and the session.
  handleAction(action,amount,onAction,onResume,onHold=()=>{}){
    // The holds answer here rather than out in the application: they are about
    // this aircraft and nothing else on the page. `hold_off` lets a pilot give
    // both up with one button instead of remembering which one is on.
    if(action==='hold_altitude'||action==='hold_position'||action==='hold_off'){
      onHold(action==='hold_off'?'off':action.slice(5));
      return;
    }
    if(action==='pause'){
      if(this.input.active)this.input.suspend();else onResume();
      return;
    }
    onAction(action,amount);
  }
  releaseStick(){this.input.setStick(0,0);}
  paint(){if(this.mode.value!==this.input.mode)this.mode.value=this.input.mode;}
  open(){this.root.hidden=false;this.locate.hidden=false;this.root.focus?.({preventScroll:true});this.input.start();this.setStatus('preparing','준비 중','수동 입력 활성 · 전환 요청은 엔진에서 판정');this.paint();}
  // While the joystick window is open it owns the keyboard: pulling focus back
  // to the strip would close the operator out of the control they are setting.
  focusControls(){if(this.joystick&&!this.joystick.root.hidden)return;if(!this.root.hidden&&!this.document.hidden&&this.input.active)this.root.focus?.({preventScroll:true});}
  tick(seconds){const command=this.input.update(seconds);this.paint(command);return command;}
  mountDashboard(dashboard){this.dashboard=dashboard;this.toolbar=this.root.querySelector('.manual-toolbar');dashboard.setManualControls(this.toolbar);}
  close(){if(this.toolbar){this.root.append(this.toolbar);this.dashboard?.setManualControls(null);this.dashboard=null;}this.input.returnOnFocus=false;this.input.suspend();this.releaseStick();this.joystick?.close();this.root.hidden=true;this.locate.hidden=true;}
  destroy(){this.close();this.joystick?.destroy();this.joystick=null;this.input.destroy();this.document.removeEventListener?.('visibilitychange',this.visibility);this.root.remove();this.locate.remove();}
}
