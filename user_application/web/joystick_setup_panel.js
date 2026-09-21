// Tuning and assignment for a hand controller, shown when the operator picks
// 조이스틱 as the input source. Everything it changes is a value in the
// profile; the profile is what flies the aircraft, so this window never talks
// to the session directly. Saving writes it to the browser, keyed by the name
// of the device, so the same stick plugged in next week comes back tuned.
import {buildElement} from './dom_builder.js';
import {AXIS_FUNCTIONS, BUTTON_ACTIONS, defaultProfile, loadProfile, saveProfile,
  mapPad, movedAxis, pressedButton, normaliseProfile} from './joystick_profile.js?v=20260917-hardware';

const VIEW_KINDS = [['buttons', '버튼 · 4방향'], ['axes', '축 · 아날로그'], ['hat', 'POV · 단일 축'], ['none', '사용 안 함']];
const percent = value => `${Math.round(value * 100)}%`;

export class JoystickSetupPanel {
  constructor({document=globalThis.document,window=globalThis.window,storage,getGamepads,
    onApply=()=>{},onSelectPad=()=>{},onClose=()=>{}}={}) {
    Object.assign(this,{document,window,storage,onApply,onSelectPad,onClose});
    this.getGamepads=getGamepads??(()=>{try{return globalThis.navigator?.getGamepads?.()??[];}catch{return [];}});
    this.padIndex=null;this.capture=null;this.frame=null;this.reading=null;
    this.profile=loadProfile('',storage);
    const e=(tag,props,...children)=>buildElement(document,tag,props,...children);
    this.e=e;
    const button=(text,onclick,extra={})=>e('button',{type:'button',text,onclick,...extra});

    this.device=e('select',{class:'joy-device','aria-label':'조이스틱 장치',
      onchange:()=>this.chooseDevice(this.device.value)});
    this.deviceNote=e('p',{class:'joy-note',text:'조이스틱을 연결하고 버튼을 한 번 누르면 목록에 나타납니다.'});

    this.axisRows=new Map();
    const axisTable=e('div',{class:'joy-rows'});
    for(const [name,label] of AXIS_FUNCTIONS)axisTable.append(this.axisRow(name,label));

    this.viewKind=e('select',{'aria-label':'시야 조작 방식',onchange:()=>{this.profile.view.kind=this.viewKind.value;this.paint();}},
      ...VIEW_KINDS.map(([value,text])=>e('option',{value,text})));
    this.viewSource=e('code',{class:'joy-index',text:'—'});
    this.viewSpeed=e('input',{type:'range',min:'0.2',max:'3',step:'0.1','aria-label':'시야 이동 속도',
      oninput:()=>{this.profile.view.speed=Number(this.viewSpeed.value);this.viewSpeedOut.textContent=`${this.profile.view.speed.toFixed(1)}×`;}});
    this.viewSpeedOut=e('output',{text:'1.0×'});
    this.viewInvert=e('input',{type:'checkbox','aria-label':'시야 상하 반전',
      onchange:()=>{this.profile.view.invertY=Boolean(this.viewInvert.checked);}});
    this.viewLive=e('output',{class:'joy-live',text:'0.00 / 0.00'});
    this.viewDetect=button('자동 감지',()=>this.startCapture({target:'view'}),{class:'joy-detect'});

    // Everything the browser reports, bound or not. Without it the window could
    // only show the four axes it had been told about, so a stick whose axes sit
    // somewhere else looked identical to one that was not reporting at all.
    this.rawAxes=e('div',{class:'joy-raw-axes'});
    this.rawButtons=e('div',{class:'joy-raw-buttons'});
    this.rawNote=e('p',{class:'joy-note',text:'장치가 보고하는 값입니다. 여기서 아무것도 움직이지 않으면 브라우저가 장치를 읽지 못하는 것입니다.'});
    this.raw=e('details',{class:'joy-rawbox'},e('summary',{text:'장치 원시 값 보기'}),this.rawNote,this.rawAxes,this.rawButtons);

    this.buttonList=e('div',{class:'joy-buttons'});
    this.buttonNote=e('p',{class:'joy-note',text:'버튼을 누르면 해당 줄이 켜집니다. 그 줄에서 기능을 고르세요.'});

    this.hint=e('p',{class:'joy-hint',hidden:'',text:''});
    this.status=e('p',{class:'joy-status',text:''});

    this.form=e('form',{class:'joy-form',method:'dialog',onsubmit:event=>{event.preventDefault?.();this.save();}},
      e('header',{class:'joy-head'},e('h2',{text:'조이스틱 설정'}),
        e('div',{class:'joy-head-device'},this.device,
          button('×',()=>this.close(),{class:'joy-close','aria-label':'조이스틱 설정 닫기',title:'닫기'}))),
      this.deviceNote,this.hint,this.raw,
      e('section',{class:'joy-section'},e('h3',{text:'축 조정'}),
        e('p',{class:'joy-note',text:'감도를 올리면 중앙 부근이 부드러워집니다. 전체 범위는 그대로입니다. 축이 떨리면 안정화를 올리세요 — 잡고 있는 위치의 흔들림까지 잡습니다.'}),axisTable),
      e('section',{class:'joy-section'},e('h3',{text:'시야 조작 · 스틱 머리 스위치'}),
        e('div',{class:'joy-view'},
          e('label',{class:'joy-field'},e('span',{text:'방식'}),this.viewKind),
          e('label',{class:'joy-field'},e('span',{text:'입력'}),this.viewSource),
          this.viewDetect,
          e('label',{class:'joy-field'},e('span',{text:'속도'}),this.viewSpeed,this.viewSpeedOut),
          e('label',{class:'joy-field joy-check'},this.viewInvert,e('span',{text:'상하 반전'})),
          e('label',{class:'joy-field'},e('span',{text:'현재'}),this.viewLive))),
      e('section',{class:'joy-section'},e('h3',{text:'버튼 기능'}),this.buttonNote,this.buttonList),
      e('footer',{class:'joy-foot'},this.status,
        button('기본값',()=>this.reset(),{class:'joy-reset'}),
        e('button',{type:'submit',class:'joy-save',text:'저장'})));
    this.root=e('dialog',{class:'joy-setup','aria-label':'조이스틱 설정'},this.form);
    // Escape closes a dialog without going through `close`, and the aircraft is
    // waiting on that call to be handed back.
    this.root.onclose=()=>{if(!this.root.hidden)this.close();};
    this.root.hidden=true;
    document.body.append(this.root);
    this.onConnect=()=>this.refreshDevices();
    window?.addEventListener?.('gamepadconnected',this.onConnect);
    window?.addEventListener?.('gamepaddisconnected',this.onConnect);
  }

  axisRow(name,label){
    const e=this.e;
    const fill=e('i',{class:'joy-fill'});
    const bar=e('div',{class:'joy-bar',role:'img','aria-label':`${label} 현재 입력`},e('i',{class:'joy-centre'}),fill);
    const index=e('code',{class:'joy-index',text:'—'});
    const out=e('output',{class:'joy-live',text:'0.00'});
    const invert=e('input',{type:'checkbox','aria-label':`${label} 반전`,
      onchange:()=>{this.profile.axes[name].invert=Boolean(invert.checked);}});
    const dead=e('input',{type:'range',min:'0',max:'40',step:'1','aria-label':`${label} 데드존`,
      oninput:()=>{this.profile.axes[name].deadzone=Number(dead.value)/100;deadOut.textContent=`${dead.value}%`;}});
    const deadOut=e('output',{text:'0%'});
    const expo=e('input',{type:'range',min:'0',max:'90',step:'1','aria-label':`${label} 감도 곡선`,
      oninput:()=>{this.profile.axes[name].expo=Number(expo.value)/100;expoOut.textContent=`${expo.value}%`;}});
    const expoOut=e('output',{text:'0%'});
    // One knob for "it is shaky". Two would be more exact, and nobody would
    // know which of them to move.
    const steady=e('input',{type:'range',min:'0',max:'100',step:'1','aria-label':`${label} 안정화`,
      title:'떨림 억제와 부드럽게 하기. 올릴수록 흔들림이 줄고 반응이 약간 느려집니다.',
      oninput:()=>{this.profile.axes[name].stability=Number(steady.value)/100;steadyOut.textContent=`${steady.value}%`;}});
    const steadyOut=e('output',{text:'0%'});
    const detect=e('button',{type:'button',class:'joy-detect',text:'자동 감지',
      onclick:()=>this.startCapture({target:'axis',name})});
    const row=e('div',{class:'joy-row','data-axis':name},
      e('div',{class:'joy-row-name'},e('strong',{text:label.split(' · ')[0]}),e('small',{text:label.split(' · ')[1]??''})),
      bar,out,index,detect,
      e('label',{class:'joy-field joy-check'},invert,e('span',{text:'반전'})),
      e('label',{class:'joy-field'},e('span',{text:'데드존'}),dead,deadOut),
      e('label',{class:'joy-field'},e('span',{text:'감도'}),expo,expoOut),
      e('label',{class:'joy-field'},e('span',{text:'안정화'}),steady,steadyOut));
    this.axisRows.set(name,{row,fill,bar,index,out,invert,dead,deadOut,expo,expoOut,steady,steadyOut});
    return row;
  }

  // Raw, unbound, straight from the device: one bar per axis and one lamp per
  // button, numbered. Moving something and seeing nothing here is the answer to
  // "why is nothing happening" -- the browser is not reading the stick.
  paintRaw(pad){
    const e=this.e,axes=pad?.axes??[],buttons=pad?.buttons??[];
    if(this.rawCount?.[0]!==axes.length||this.rawCount?.[1]!==buttons.length){
      this.rawCount=[axes.length,buttons.length];this.rawCells=null;
      if(!axes.length&&!buttons.length){
        this.rawAxes.replaceChildren(e('p',{class:'joy-note',text:'보고되는 축과 버튼이 없습니다.'}));
        this.rawButtons.replaceChildren();
      } else {
        const cells=[];
        this.rawAxes.replaceChildren(...axes.map((_,index)=>{
          const fill=e('i',{class:'joy-fill'}),value=e('output',{class:'joy-live',text:'0.00'});
          cells.push({fill,value});
          return e('div',{class:'joy-raw-axis'},e('code',{text:`A${index}`}),
            e('div',{class:'joy-bar'},e('i',{class:'joy-centre'}),fill),value);
        }));
        const lamps=[];
        this.rawButtons.replaceChildren(...buttons.map((_,index)=>{
          const lamp=e('i',{class:'joy-lamp'});lamps.push(lamp);
          return e('span',{class:'joy-raw-button'},lamp,e('code',{text:`B${index}`}));
        }));
        this.rawCells={axes:cells,buttons:lamps};
      }
    }
    if(!this.rawCells)return;
    this.rawCells.axes.forEach((cell,index)=>{
      const value=Number.isFinite(axes[index])?Math.max(-1,Math.min(1,axes[index])):0;
      cell.value.textContent=value.toFixed(2);
      cell.fill.style.setProperty('left',`${50+Math.min(0,value)*50}%`);
      cell.fill.style.setProperty('width',`${Math.abs(value)*50}%`);
    });
    this.rawCells.buttons.forEach((lamp,index)=>{
      const button=buttons[index];
      const down=typeof button==='object'?Boolean(button?.pressed)||Number(button?.value)>.5:Number(button)>.5;
      lamp.setAttribute('data-on',String(down));
    });
  }
  pads(){return [...(this.getGamepads()??[])].filter(pad=>pad&&pad.connected!==false);}
  // Why the list can be empty, in the order the reasons are likely.
  //
  // The usual one is that the browser has not been told yet: it hides gamepads
  // until one is used on the page. The other is the page itself. Served over
  // plain http to anything but localhost, it is not a 'secure context', and a
  // browser that gates the Gamepad API there shows exactly what a machine with
  // nothing plugged in shows. That silence is worth naming, because then the
  // answer is in the address bar rather than in the cable -- and opening the
  // dashboard from another PC is precisely when it applies.
  emptyReason(){
    const view=this.window,press='조이스틱을 연결하고 버튼을 한 번 누르면 목록에 나타납니다.';
    if(view&&typeof view.navigator?.getGamepads!=='function')
      return '이 브라우저는 조이스틱(Gamepad API)을 제공하지 않습니다. 최신 Chrome · Edge · Firefox로 열어 주세요.';
    if(view?.isSecureContext===false)
      return `${press} 그래도 비어 있으면 주소가 원인입니다 — ${view.location?.origin??'이 주소'}는 http라 보안 연결이 아니고, 브라우저가 거기서 조이스틱을 막기도 합니다. 서버와 같은 PC면 http://127.0.0.1:8766 으로, 다른 PC면 https 또는 브라우저의 예외 설정이 필요합니다.`;
    return `${press} 브라우저는 입력이 한 번 있어야 장치를 알려줍니다.`;
  }
  pad(){const pads=this.pads();
    if(this.padIndex!=null){const chosen=pads.find(pad=>pad.index===this.padIndex);if(chosen)return chosen;}
    return pads[0]??null;}

  refreshDevices(){
    const e=this.e,pads=this.pads();
    this.device.replaceChildren(...(pads.length
      ?pads.map(pad=>e('option',{value:String(pad.index),text:String(pad.id??`장치 ${pad.index}`).slice(0,54)}))
      :[e('option',{value:'',text:'연결된 장치 없음'})]));
    const current=this.pad();
    if(current){this.device.value=String(current.index);this.padIndex=current.index;}
    this.deviceNote.textContent=pads.length
      ?`${pads.length}개 연결됨 · 설정은 장치 이름별로 따로 저장됩니다.`
      :this.emptyReason();
    // A device that has its own saved tuning takes it; otherwise the one on
    // screen carries over, so switching sticks does not silently wipe work.
    if(current&&current.id&&current.id!==this.profile.deviceId){
      const stored=loadProfile(current.id,this.storage);
      this.profile=stored;this.profile.deviceId=current.id;
    }
    this.buildButtons(current);this.paint();
  }

  chooseDevice(value){
    const index=value===''?null:Number(value);
    this.padIndex=Number.isFinite(index)?index:null;
    this.onSelectPad(this.padIndex);
    this.refreshDevices();
  }

  buildButtons(pad){
    const e=this.e,count=Math.max(pad?.buttons?.length??0,this.assignedCount());
    if(this.buttonCount===count&&this.buttonRows)return;
    this.buttonCount=count;this.buttonRows=new Map();
    this.buttonList.replaceChildren(...(count?Array.from({length:count},(_,index)=>{
      const lamp=e('i',{class:'joy-lamp'});
      const select=e('select',{'aria-label':`버튼 ${index} 기능`,onchange:()=>{
        const action=select.value;
        if(action==='none')delete this.profile.buttons[index];else this.profile.buttons[index]=action;
      }},...BUTTON_ACTIONS.map(([value,text])=>e('option',{value,text})));
      const row=e('div',{class:'joy-button','data-button':String(index)},lamp,e('code',{text:`B${index}`}),select);
      this.buttonRows.set(index,{row,lamp,select});
      return row;
    }):[e('p',{class:'joy-note',text:'장치가 연결되면 버튼 목록이 나타납니다.'})]));
  }
  assignedCount(){const keys=Object.keys(this.profile.buttons??{}).map(Number).filter(Number.isInteger);
    return keys.length?Math.max(...keys)+1:0;}

  // 자동 감지: remember where everything rests, then take the first thing that
  // moves far enough. Waiting for a release afterwards stops one press from
  // being read as the answer to the next question too.
  startCapture(request){
    const pad=this.pad();
    if(!pad){this.say('연결된 장치가 없습니다.');return;}
    this.capture={...request,rest:[...(pad.axes??[])],until:Date.now()+8000};
    this.showHint(request.target==='view'
      ?'시야 스위치를 위로 밀거나 눌러 주세요. (1/4)'
      :'해당 축을 끝까지 움직여 주세요.');
  }
  applyCapture(pad){
    const capture=this.capture;
    if(!capture)return;
    if(Date.now()>capture.until){this.capture=null;this.showHint('');this.say('감지 시간이 지났습니다. 다시 눌러 주세요.');return;}
    const axis=movedAxis(pad,capture.rest);
    if(capture.target==='axis'){
      if(axis==null)return;
      this.profile.axes[capture.name].axis=axis;
      this.capture=null;this.showHint('');this.say(`${capture.name} → 축 ${axis}`);this.paint();return;
    }
    const directions=['위','아래','왼쪽','오른쪽'];
    const pressed=pressedButton(pad);
    if(capture.releasing){if(pressed==null&&movedAxis(pad,capture.rest)==null)capture.releasing=false;return;}
    if(pressed!=null){
      capture.buttons??=[];
      if(capture.buttons.includes(pressed)){this.showHint('다른 방향 버튼을 눌러 주세요.');return;}
      capture.buttons.push(pressed);capture.until=Date.now()+15000;
      if(capture.buttons.length<4){capture.releasing=true;this.showHint(`놓은 뒤 ${directions[capture.buttons.length]} 방향을 눌러 주세요. (${capture.buttons.length+1}/4)`);return;}
      this.profile.view.kind='buttons';this.profile.view.buttons=capture.buttons;
      for(const index of capture.buttons)delete this.profile.buttons[index];
      this.capture=null;this.showHint('');this.say(`시야 위/아래/왼쪽/오른쪽 → ${capture.buttons.join(', ')}`);this.paint();return;
    }
    if(axis!=null){
      capture.axes??=[];capture.axes.push({axis,value:pad.axes[axis]});capture.until=Date.now()+15000;
      if(capture.axes.length<4){capture.releasing=true;this.showHint(`중립으로 놓은 뒤 ${directions[capture.axes.length]} 방향을 끝까지 밀어 주세요. (${capture.axes.length+1}/4)`);return;}
      const [u,d,l,rr]=capture.axes;
      if(capture.axes.every(a=>a.axis===u.axis)){
        this.profile.view.kind='hat';this.profile.view.hat={axis:u.axis,neutral:capture.rest[u.axis],values:capture.axes.map(a=>a.value)};
      }else if(u.axis===d.axis&&l.axis===rr.axis&&u.axis!==l.axis){
        this.profile.view.kind='axes';this.profile.view.axes=[l.axis,u.axis];
        this.profile.view.invertY=u.value>d.value;
      }else{this.capture=null;this.showHint('');this.say('상하/좌우 축이 일치하지 않습니다. 중립에서 다시 감지하세요.');return;}
      this.capture=null;this.showHint('');this.say('시야 방향 4개를 기록했습니다. 저장하면 적용됩니다.');this.paint();
    }
  }

  showHint(text){this.hint.textContent=text;this.hint.hidden=!text;
    if(text)this.hint.removeAttribute('hidden');else this.hint.setAttribute('hidden','');}
  say(text){this.status.textContent=text;}

  // Controls follow the profile, and the live readings follow the device. Both
  // on every frame, so a value changed by 자동 감지 shows without a reload.
  paint(){
    const pad=this.pad();
    this.reading=pad?mapPad(pad,this.profile,this.reading):null;
    this.paintRaw(pad);
    for(const [name,row] of this.axisRows){
      const binding=this.profile.axes[name];
      row.index.textContent=binding.axis==null?'—':`축 ${binding.axis}`;
      row.invert.checked=Boolean(binding.invert);
      if(binding.invert)row.invert.setAttribute('checked','');else row.invert.removeAttribute('checked');
      row.dead.value=String(Math.round(binding.deadzone*100));row.deadOut.textContent=percent(binding.deadzone);
      row.expo.value=String(Math.round(binding.expo*100));row.expoOut.textContent=percent(binding.expo);
      row.steady.value=String(Math.round(binding.stability*100));row.steadyOut.textContent=percent(binding.stability);
      const value=this.reading?this.reading.axes[name]:0;
      row.out.textContent=value.toFixed(2);
      // A lever fills from the left; a stick fills from the centre outwards.
      const lever=name==='throttle'&&binding.absolute!==false;
      row.fill.style.setProperty('left',lever?'0%':`${50+Math.min(0,value)*50}%`);
      row.fill.style.setProperty('width',`${(lever?value:Math.abs(value))*(lever?100:50)}%`);
      row.row.setAttribute('data-live',value?'true':'false');
    }
    this.viewKind.value=this.profile.view.kind;
    this.viewSource.textContent=this.profile.view.kind==='hat'?`POV 축 ${this.profile.view.hat?.axis??9}`:this.profile.view.kind==='axes'?`축 ${this.profile.view.axes.join(', ')}`
      :this.profile.view.kind==='buttons'?`위/아래/좌/우 ${this.profile.view.buttons.join(', ')}`:'—';
    this.viewSpeed.value=String(this.profile.view.speed);
    this.viewSpeedOut.textContent=`${this.profile.view.speed.toFixed(1)}×`;
    this.viewInvert.checked=Boolean(this.profile.view.invertY);
    if(this.profile.view.invertY)this.viewInvert.setAttribute('checked','');else this.viewInvert.removeAttribute('checked');
    const view=this.reading?.view??{x:0,y:0};
    this.viewLive.textContent=`${view.x.toFixed(2)} / ${view.y.toFixed(2)}`;
    this.buildButtons(pad);
    for(const [index,row] of this.buttonRows??[]){
      const action=this.profile.buttons?.[index]??'none';
      if(row.select.value!==action)row.select.value=action;
      const down=Boolean(this.reading?.down?.has(index));
      row.row.setAttribute('data-down',String(down));
      row.lamp.setAttribute('data-on',String(down));
    }
    if(pad&&this.capture)this.applyCapture(pad);
  }

  tick(){this.paint();this.frame=this.window?.requestAnimationFrame?.(()=>this.tick())??null;}

  open(){
    // The window is built once and kept for the life of the page, so anything
    // that rebuilt the DOM around it since leaves this element detached --
    // and `showModal` on a detached dialog throws. That left the aircraft held
    // with its controls dead and no window to close, which is what a pilot met.
    if(!this.root.isConnected)this.document.body.append(this.root);
    this.profile=loadProfile(this.pad()?.id??'',this.storage);
    this.root.hidden=false;this.root.removeAttribute('hidden');
    this.root.showModal?.();
    // A modal that did not open is worse than one that failed loudly: it takes
    // the page's clicks with it and gives nothing back. Say so, so the caller
    // can hand the aircraft its controls again.
    if(this.root.showModal&&!this.root.open)throw new Error('조이스틱 설정 창을 열지 못했습니다');
    this.refreshDevices();
    this.say('');
    if(!this.frame)this.tick();
  }
  close(){
    if(this.frame!=null)this.window?.cancelAnimationFrame?.(this.frame);
    this.frame=null;this.capture=null;this.showHint('');
    this.root.hidden=true;this.root.setAttribute('hidden','');this.root.close?.();
    this.onClose();
  }
  save(){
    const pad=this.pad();
    if(pad?.id)this.profile.deviceId=pad.id;
    const saved=saveProfile(this.profile,this.storage);
    this.profile=saved;this.onApply(saved);
    this.say('저장했습니다. 다음에 연결해도 그대로 사용합니다.');
    this.paint();
  }
  reset(){
    this.profile=normaliseProfile(defaultProfile(this.pad()?.id??this.profile.deviceId??''));
    this.buttonCount=null;this.buildButtons(this.pad());this.paint();
    this.say('기본값으로 되돌렸습니다. 저장해야 남습니다.');
  }
  destroy(){
    this.close();
    this.window?.removeEventListener?.('gamepadconnected',this.onConnect);
    this.window?.removeEventListener?.('gamepaddisconnected',this.onConnect);
    this.root.remove();
  }
}
