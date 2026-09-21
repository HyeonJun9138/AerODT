import {missionStage,describePilotDecision} from '../../../entity_details.js';
import {mountAlignment,paintAlignment,modeNames} from '../../../uam_alignment_panel.js';
import {CalibrationMonitor,paintCalibration} from '../../../sensor_calibration_panel.js';
const n=(v,d=1)=>Number.isFinite(v)?v.toFixed(d):'—';
const el=(tag,text,className)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(className)e.className=className;return e;};

export class PhysicalUamPanel {
  constructor({onFocus=()=>{},onToggle=async()=>{}}={}){this.onFocus=onFocus;this.onToggle=onToggle;this.generation=0;}
  mount(parent){
    this.close();this.box=el('section',null,'physical-uam-card');this.box.setAttribute('aria-label','Physical UAM 실시간 수신');
    const title=el('div',null,'physical-title');title.append(el('span','PHYSICAL → DIGITAL','physical-eyebrow'),el('h3','실시간 UAM 센서'));
    this.switch=el('button','연결 확인 중');this.switch.type='button';this.switch.disabled=true;
    this.switch.onclick=async()=>{this.switch.disabled=true;try{if(await this.onToggle(!this.state?.enabled)===false)throw Error();await this.refresh();}catch{this.message.textContent='수신 설정 저장 실패 · 다시 시도해 주세요';}finally{this.switch.disabled=false;}};
    title.append(this.switch);this.message=el('p','센서 서버 연결을 확인합니다.','physical-note');
    this.metrics=el('div',null,'physical-metrics');this.list=el('div',null,'physical-aircraft');
    const flow=el('p','GNSS · AHRS · 기압계 → 상태 추정 → 선택 기체 예측','physical-flow');
    this.operationNote=el('p','운항 정보 연결 확인 중','physical-note');
    this.box.append(title,this.message,this.metrics,this.operationNote);this.calibration=new CalibrationMonitor();this.calibration.mount(this.box);this.updateAlignment=mountAlignment(this.box);this.box.append(this.list,flow);parent.append(this.box);
    void this.refresh();this.timer=setInterval(()=>void this.refresh(),1000);
  }
  close(){this.generation++;clearInterval(this.timer);this.calibration?.close();this.box?.remove();this.box=null;}
  async refresh(){
    if(!this.box||this.pending||document.hidden)return;
    const generation=this.generation;this.pending=true;
    try{
      const response=await fetch('/api/live/uam',{cache:'no-store',signal:AbortSignal.timeout(4000)});
      if(!response.ok)throw Error();const value=await response.json();
      if(generation!==this.generation||!this.box)return;
      this.state=value;this.message.textContent=value.message+(value.telemetry_shards>1?` · ${value.telemetry_shards}개 그룹 병렬 수신`:'');this.box.dataset.status=value.status;
      this.updateAlignment(value.alignment);
      this.calibration?.update(value);
      const ops=value.operations;
      this.operationNote.textContent=ops?.source==='physical'?`운항 정보 ${ops.history_complete?'동기화':'수집 중'} · 이벤트 ${(ops.event_count??0).toLocaleString()}건 · ${ops.rules_match===true?'운항 로직 일치':ops.rules_match===false?'운항 로직 버전 다름':'버전 확인 중'}${ops.stale?' · 운영 현황 수신 지연':''}`:'운항 정보 연결 대기';
      this.switch.textContent=value.enabled?'수신 켜짐':'수신 꺼짐';this.switch.setAttribute('aria-pressed',String(value.enabled));this.switch.disabled=false;
      const age=value.aircraft.length?Math.max(...value.aircraft.map(x=>x.measurement_age_s)):null;
      this.metrics.replaceChildren(...[['수신 기체',value.aircraft.length],['측정 경과',`${n(age)} s`],['누락 패킷',value.counters.missing_packets]].map(([name,v])=>{const e=el('div');e.append(el('small',name),el('strong',String(v)));return e;}));
      this.list.replaceChildren(...[...value.aircraft].sort((a,b)=>a.name.localeCompare(b.name)).map(item=>{const b=el('button');b.type='button';b.disabled=!value.receiving;
        const name=el('strong',item.name),text=el('span',`${item.route.origin} → ${item.route.destination} · ${missionStage(item.phase)}`),hint=el('small',item.estimation?`${modeNames[item.estimation.mode]||item.estimation.mode} · 수평 ${n(item.estimation.horizontal_sigma_m)} m`:'지도에서 보기 · 센서 / 예측 ↗');
        b.append(name,text,hint);b.onclick=()=>this.onFocus(item.entity_id);return b;}));
      if(!value.aircraft.length)this.list.append(el('p',value.simulation_suspended?'Simulation 종료 시 현재 시간으로 재연결합니다.':'센서 패킷을 기다리는 중입니다.'));
    }catch{if(generation===this.generation&&this.box)this.message.textContent='수신 상태 확인 실패 · 다시 연결 중';}
    finally{this.pending=false;}
  }
}

export function paintPhysicalSensors(parent,detail){
  if(!detail){parent.hidden=true;return;}
  parent.hidden=false;parent.className='physical-sensors';
  const title=el('div',null,'physical-title');title.append(el('h3','Physical 센서 관측'),el('span',`#${detail.sequence}`,'physical-sequence'));
  const subtitle=el('p',`${detail.route.origin} → ${detail.route.destination} · ${detail.mission_id}`,'physical-note');
  const latency=el('p',`추정 지연 ${n(detail.transport_latency_s*1000,0)} ms · 시계 보정 ${n(detail.clock_offset_s,3)} s (±${n(detail.clock_uncertainty_s*1000,0)} ms) · ${detail.estimator}`,'physical-note');
  const playback=el('p',detail.display_mode==='buffered_observations'?'지도 · 수신된 보정 관측을 짧게 버퍼링해 연속 재생합니다. 아래 현재 시점 추정값과 표시 시점은 다릅니다.':'','physical-note');
  if(Number.isFinite(detail.display_timing?.age_s))playback.append(el('strong',` 지도 표시 ${n(detail.display_timing.age_s,2)}초 전 관측`));
  const lag=detail.latency_breakdown;
  if(lag)playback.append(el('span',` 관측→송신 ${n(lag.sender_age_s,2)}s · 전송 ${n(lag.transport_s,2)}s · 수신 후 ${n(lag.receiver_age_s,2)}s`));
  const grid=el('div',null,'physical-sensor-grid');
  for(const [id,label] of [['gnss','GNSS'],['ahrs','AHRS 자세'],['barometer','기압 고도'],['imu','IMU'],['vehicle','기체 보고']]){
    const item=detail.sensors[id],card=el('section');card.append(el('h4',label));
    if(!item){card.append(el('p','관측 없음'));grid.append(card);continue;}
    const age=detail.server_time-item.sample_time-(detail.clock_offset_s??0),v=item.values,u=item.uncertainty;
    card.dataset.stale=String(age>2);
    card.append(el('small',`${item.nominal_hz} Hz · ${n(age,2)}초 전 · #${item.sequence}`));
    let lines=[];
    if(id==='gnss')lines=[`${n(v.latitude_deg,6)}° / ${n(v.longitude_deg,6)}°`,`${n(v.altitude_ellipsoid_m)} m · 3D FIX`,
      `N/E/D ${v.velocity_ned_mps.map(x=>n(x)).join(' / ')} m/s`,`위치 σ ${u.position_variance_ned_m2.map(x=>n(Math.sqrt(x))).join(' / ')} m`];
    else if(id==='ahrs')lines=[`Yaw ${n(v.heading_deg)}° · Pitch ${n(v.pitch_deg)}°`,`Roll ${n(v.roll_deg)}° · σ ${n(Math.sqrt(u.attitude_variance_deg2[0]),2)}°`];
    else if(id==='barometer')lines=[`${n(v.altitude_ellipsoid_m)} m · ${n(v.pressure_pa,0)} Pa`,`고도 σ ${n(Math.sqrt(u.altitude_variance_m2))} m · 기준면 보정`];
    else if(id==='imu')lines=[`가속도 ${v.specific_force_mps2.map(x=>n(x,2)).join(' / ')} m/s²`,`각속도 ${v.angular_rate_radps.map(x=>n(x,3)).join(' / ')} rad/s`];
    else lines=[`${missionStage(v.flight_phase)} · 틸트 ${n(v.tilt_deg)}°`,`${n(v.rotor_radps*60/(2*Math.PI),0)} rpm · ${v.grounded?'접지':'비행 중'}`];
    for(const line of lines)card.append(el('p',line));grid.append(card);
  }
  const operations=detail.operations;
  if(operations){
    const decision=describePilotDecision({state:{...operations,phase:detail.sensors.vehicle?.values?.flight_phase},
      clearance:operations.clearance});
    const card=el('section',null,'physical-operations');card.dataset.level=decision.level;
    card.append(el('h4',`Physical 운항 · ${detail.flight_id||'주기'}`),el('strong',decision.title),
      el('p',decision.reason),el('small',decision.source));
    for(const field of decision.fields)card.append(el('p',`${field.label}: ${field.value}`));
    card.append(el('small',`보고 ${detail.report_hz||10} Hz`));grid.append(card);
  }
  const note=el('p','모사 센서 · IMU는 FRD 비력/각속도, 고도는 타원체 기준입니다. 예측은 관측 이력과 전달받은 임무 의도를 사용합니다.','physical-note');
  const alignment=paintAlignment(detail),calibration=paintCalibration(detail.calibration);parent.replaceChildren(title,subtitle,latency,playback,...(calibration?[calibration]:[]),...(alignment?[alignment]:[]),grid,note);
}
