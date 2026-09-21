const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const num=(v,d=2)=>Number.isFinite(v)?v.toFixed(d):'—';

export function calibrationState(value){
  if(value?.status==='applied')return '기지 오차 역보정 적용';
  if(value?.status==='stochastic')return '일반 잡음 모드 · 기존 추정 필터 사용';
  if(value?.status==='unsupported')return '오차 규칙을 확인할 수 없습니다';
  return '보정 관측 대기';
}

export function paintCalibration(value){
  if(!value)return null;
  const box=el('section',undefined,'cal-inline');box.append(el('h4',calibrationState(value)));
  if(value.status==='applied'){
    box.append(el('p',`고도 ${num(value.raw.altitude_ellipsoid_m)} → ${num(value.corrected.altitude_ellipsoid_m)} m`),
      el('p',`제거한 기지 위치 편향 ${num(value.removed_position_bias_m)} m · 같은 관측 시점`));
  }
  box.append(el('small','알려진 규칙의 역보정 시연입니다. 실제 위치 오차·통신 지연을 0으로 보증하지 않습니다.'));
  return box;
}

function plot(points,altitude=false){
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox',altitude?'0 0 580 130':'0 0 580 300');
  svg.setAttribute('role','img');svg.setAttribute('aria-label',altitude?'같은 관측 시점의 보정 전후 고도':'같은 관측 시점의 보정 전후 평면 경로');
  if(!points.length)return svg;
  const base=points[0].corrected,project=(p,i)=>altitude?[i,p.altitude_ellipsoid_m]:[
    (p.longitude_deg-base.longitude_deg)*111320*Math.cos(base.latitude_deg*Math.PI/180),(p.latitude_deg-base.latitude_deg)*111320];
  const groups=['raw','corrected',...(points[0].reference?['reference']:[])];
  const lines=groups.map(key=>points.map((p,i)=>project(p[key],i))),all=lines.flat();
  const xs=all.map(p=>p[0]),ys=all.map(p=>p[1]),mx=(Math.min(...xs)+Math.max(...xs))/2,my=(Math.min(...ys)+Math.max(...ys))/2;
  const dx=Math.max(12,Math.max(...xs)-Math.min(...xs)),dy=Math.max(12,Math.max(...ys)-Math.min(...ys));
  const h=altitude?130:300,pad=30,scale=Math.min(520/dx,(h-pad*2)/dy);
  const xy=p=>[290+(p[0]-mx)*(altitude?520/dx:scale),h/2-(p[1]-my)*scale];
  svg.innerHTML=`<path d="M30 ${h/2} H550 M290 15 V${h-15}" class="cal-grid"/>`;
  // Reference first, so the recovered line remains visible on top of it.
  for(const index of groups.map((_,i)=>i).reverse()){
    const line=lines[index],path=document.createElementNS(svg.namespaceURI,'path');
    path.setAttribute('d',line.map((p,i)=>(i?'L':'M')+xy(p).join(',')).join(' '));path.setAttribute('class','cal-trace '+groups[index]);svg.append(path);
    const dot=document.createElementNS(svg.namespaceURI,'circle'),p=xy(line.at(-1));dot.setAttribute('cx',p[0]);dot.setAttribute('cy',p[1]);
    dot.setAttribute('r',groups[index]==='reference'?7:4);dot.setAttribute('class','cal-dot '+groups[index]);svg.append(dot);
  }
  return svg;
}

export class CalibrationMonitor {
  mount(parent){
    this.close();this.aircraft=[];this.box=el('section',undefined,'cal-card');
    const row=el('div',undefined,'cal-card-title');row.append(el('span','PHYSICAL → LIVE TWIN','physical-eyebrow'),el('h3','오차가 보정되는 과정'));
    this.note=el('p','고정 편향 → 수신부 역보정 → 상태 추정','physical-note');
    const open=this.openButton=el('button','보정 과정 보기 ↗');open.type='button';open.onclick=()=>this.open();
    this.box.append(row,this.note,open);parent.append(this.box);
  }
  update(status){
    this.aircraft=status?.aircraft||[];
    const count=this.aircraft.filter(x=>x.calibration_profile==='known_bias_v1').length;
    if(this.note)this.note.textContent=count?`실제 수신 ${count}대에 기지 오차 역보정 적용 중`:'기지 편향 시연 준비 · 일반 잡음에는 기존 추정 필터 사용';
  }
  close(){this.closeDialog();this.box?.remove();this.box=null;}
  closeDialog(){this.generation=(this.generation||0)+1;clearTimeout(this.timer);this.abort?.abort();this.dialog?.close?.();this.dialog?.remove();this.dialog=null;this.openButton?.focus?.();}
  async open(){
    this.closeDialog();const generation=this.generation;
    const dialog=this.dialog=el('dialog',undefined,'cal-dialog');dialog.setAttribute('aria-label','Live Twinning 센서 보정 과정');
    const header=el('header'),title=el('div');title.append(el('small','LIVE TWINNING · SENSOR CALIBRATION'),el('h2','불확실한 관측에서 정합된 상태로'));
    const close=el('button','닫기');close.type='button';close.onclick=()=>this.closeDialog();header.append(title,close);
    const toolbar=el('div',undefined,'cal-toolbar'),label=el('label','관측 대상'),select=this.select=el('select');select.setAttribute('aria-label','보정 관측 대상');
    const example=el('option','원리 시연 · 예시 데이터');example.value='example';select.append(example);
    for(const a of this.aircraft){const option=el('option',a.name+' · 실제 수신');option.value=a.entity_id;select.append(option);}
    label.append(select);this.badge=el('strong','예시 데이터 · 실제 운항 아님','cal-source');toolbar.append(label,this.badge);
    this.content=el('div',undefined,'cal-content');this.content.append(el('p','보정 데이터를 불러오는 중입니다.'));
    this.slider=el('input');this.slider.type='range';this.slider.min=0;this.slider.max=40;this.slider.value=20;this.slider.setAttribute('aria-label','예시 관측 시점');
    const scrub=this.scrub=el('label','예시 관측 시점');scrub.className='cal-scrub';scrub.append(this.slider);
    this.slider.oninput=()=>this.renderExample();
    select.onchange=()=>{this.generation++;clearTimeout(this.timer);this.abort?.abort();this.points=[];this.context=null;this.scrub.hidden=select.value!=='example';this.content.replaceChildren(el('p','보정 데이터를 불러오는 중입니다.'));void this.load();};
    dialog.append(header,toolbar,this.content,scrub,el('p','보정 결과는 각 센서의 관측 시점 기준입니다. 이후의 시각 정렬·상태 추정·통신 지연은 별도로 남습니다.','cal-footer'));
    dialog.addEventListener('cancel',e=>{e.preventDefault();e.stopPropagation();this.closeDialog();});
    dialog.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();this.closeDialog();}});
    document.body.append(dialog);dialog.showModal();close.focus();
    if(generation===this.generation)await this.load();
  }
  async load(){
    if(!this.dialog)return;
    const generation=this.generation,id=this.select.value;const controller=this.abort=new AbortController();const deadline=setTimeout(()=>controller.abort(),5000);
    try{
      const response=await fetch(id==='example'?'/api/live/uam/calibration-example':'/api/live/uam/'+encodeURIComponent(id),{cache:'no-store',signal:controller.signal});
      if(!response.ok)throw Error('보정 데이터를 불러오지 못했습니다. 수신 서버 업데이트·연결 상태를 확인해 주세요.');
      const value=await response.json();if(generation!==this.generation||!this.dialog||this.select.value!==id)return;
      if(id==='example'){this.example=value;this.slider.max=value.points.length-1;this.renderExample();}
      else{
        const c=value.calibration;this.badge.textContent='실제 수신 · '+id.replace('physical:','');
        if(c?.status!=='applied'){
          this.points=[];this.context=null;this.content.replaceChildren(el('h3',calibrationState(c)),el('p','Physical 콘솔의 센서 관측 탭에서 ‘기지 편향 시연’을 적용하면 이곳에서 보정 전·후를 확인할 수 있습니다.'),el('p','일반 난수 잡음을 정확히 되돌렸다고 표시하지 않습니다.'));
        }else{
          const context=[value.process_id,value.mission_id,c.model_id].join(':');
          if(context!==this.context){this.context=context;this.points=[];}
          const last=this.points.at(-1);
          if(!last||c.sample_time>last.sample_time){
            if(last&&c.sample_time-last.sample_time>2)this.points=[];
            this.points.push(c);this.points=this.points.slice(-40);
          }
          this.paint(this.points,c,false,Math.max(0,value.server_time-c.receiver_sample_time));
        }
      }
    }catch(e){if(generation===this.generation&&this.dialog&&this.select.value===id&&e.name!=='AbortError')this.content.replaceChildren(el('p',e.message,'cal-error'));
      else if(generation===this.generation&&this.dialog&&this.select.value===id)this.content.replaceChildren(el('p','연결이 지연되고 있습니다. 다시 확인 중입니다.','cal-error'));
    }finally{clearTimeout(deadline);if(generation===this.generation&&this.dialog&&this.select.value===id)this.timer=setTimeout(()=>this.load(),id==='example'?15000:1000);}
  }
  renderExample(){
    if(!this.example||!this.dialog||this.select.value!=='example')return;
    this.badge.textContent=this.example.label;const index=Math.min(this.example.points.length-1,Number(this.slider.value));
    this.paint(this.example.points.slice(0,index+1),this.example.points[index],true,0);
  }
  paint(points,c,example,age){
    const layout=el('div',undefined,'cal-layout'),visual=el('section',undefined,'cal-visual');
    const legend=el('div',undefined,'cal-legend');for(const [key,label] of [['raw','오차가 포함된 관측'],['corrected','역보정 결과'],...(example?[['reference','예시 참조 경로']]:[])])legend.append(el('span',label,key));
    visual.append(el('h3','평면 위치 · 보정 전 / 후'),legend,plot(points),el('h4','고도 · 같은 관측 시점'),plot(points,true),el('small',example?'슬라이더로 관측 시점을 이동해 보세요.':'최근 최대 40개 관측 · 2초를 넘는 누락은 연결하지 않습니다.'));
    const side=el('section',undefined,'cal-explain'),flow=el('ol',undefined,'cal-steps');
    for(const [title,body] of [['Physical 관측','정해진 편향을 센서 값에 추가'],['Live Twinning 역보정','알려진 보정 계수로 편향 제거'],['상태 추정으로 전달','시각 정렬과 기존 추정 필터로 연결']]){const li=el('li');li.append(el('strong',title),el('span',body));flow.append(li);}
    const rule=c.rule,coeff=el('div',undefined,'cal-coeff');
    for(const [label,value,unit] of [['북쪽',rule.north_m,'m'],['동쪽',rule.east_m,'m'],['고도',rule.height_m,'m'],['방위',rule.heading_deg,'°']]){const row=el('div');row.append(el('span',label),el('strong',`${value>0?'+':''}${value}${unit} → ${value>0?'−':'+'}${Math.abs(value)}${unit}`));coeff.append(row);}
    const metric=el('div',undefined,'cal-result');metric.append(el('small','제거한 기지 위치 편향'),el('strong',num(c.removed_position_bias_m)+' m'));
    const values=el('div',undefined,'cal-values');values.append(el('span','관측 고도 → 역보정 고도'),el('strong',`${num(c.raw.altitude_ellipsoid_m)} → ${num(c.corrected.altitude_ellipsoid_m)} m`));
    if(c.heading)values.append(el('span','관측 방위 → 역보정 방위'),el('strong',`${num(c.heading.raw,1)} → ${num(c.heading.corrected,1)}°`));
    const note=el('p',example?`예시 참조값 대비 잔차 ${num(c.truth_error_m,6)} m · 동일 관측 시점의 수치 검증`:'실제 참조 위치 미사용 · 실제 위치 오차는 별도 검증이 필요합니다.','cal-note');
    side.append(flow,coeff,metric,values,note,el('p',example?'예시에는 난수 잡음이 없습니다. 기지 편향만 정확하게 제거하는 개념 시연입니다.':`관측 경과 ${num(age,1)}초${age>2?' · 지연 관측':''} · 지연을 없애거나 현재 시점의 정확성을 보증하는 값은 아닙니다.`,'cal-note'));
    layout.append(visual,side);this.content.replaceChildren(layout);
  }
}
