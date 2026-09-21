import {describePilotDecision} from './pilot_decision.js';
export {describePilotDecision};
const finite=value=>typeof value==='number' && Number.isFinite(value);
const formats=new Map();

const number=(value,digits=1,suffix='')=>{

  if(!finite(value))return '정보 없음';

  if(!formats.has(digits))formats.set(digits,new Intl.NumberFormat('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits}));

  return `${formats.get(digits).format(value)}${suffix}`;

};

const date=value=>finite(value) && finite(new Date(value*1000).getTime())?new Date(value*1000).toISOString().slice(0,19).replace('T',' ')+' UTC':'정보 없음';



// The shipped shape is a rendering, never a photograph or a measured attitude.

function representation(entity,asset) {

  if(!asset)return entity.visual_match==='none'

    ? '연결된 시각 모델 없음 · 로켓 본체/파편은 점으로만 표시'

    : '연결된 시각 모델 없음';

  if(asset.temporary)return '임시 대표 형상 · 실제 대상 형상 아님 · 렌더링 이미지';

  if(entity.visual_match==='exact')return '해당 대상의 대표 모델 · 렌더링 이미지이며 실제 촬영 이미지나 현재 자세가 아님';

  if(entity.visual_match==='series')return '동일 계열 모델 · 세부 형상은 실제 대상과 다를 수 있으며 실제 촬영 이미지가 아님';

  return '대표 형상 · 실제 기종/위성과의 일치 미확인 · 렌더링 이미지';

}



export function describeEntity(entity,asset) {

  const satellite=entity.kind==='satellite';

  const velocity=entity.velocity_ecef_mps;

  const speed=Array.isArray(velocity) && velocity.length===3 && velocity.every(finite)?Math.hypot(...velocity):null;

  const heading=['ground_track','attitude'].includes(entity.orientation_source)?entity.heading_deg:null;

  return {

    name:entity.name || entity.entity_id || '이름 없음',kind:satellite?'SATELLITE':entity.kind==='uam'?'UAM':'AIRCRAFT',

    quality:entity.quality==='stale'?(satellite?'오래된 상태':'오래된 상태 · 추정 정지'):['valid','nominal'].includes(entity.quality)?'유효 상태':'상태 확인 필요',

    representation:representation(entity,asset),

    fields:[

      {key:'id',label:'식별자',value:entity.entity_id || '정보 없음'},

      {key:'latitude',label:'위도',value:number(entity.latitude_deg,4,'°')},

      {key:'longitude',label:'경도',value:number(entity.longitude_deg,4,'°')},

      {key:'altitude',label:'고도',value:satellite?number(finite(entity.altitude_m)?entity.altitude_m/1000:null,2,' km'):number(entity.altitude_m,0,' m')},

      {key:'speed',label:'지구고정계 속력 (ECEF)',value:satellite?number(finite(speed)?speed/1000:null,3,' km/s'):number(speed,1,' m/s')},

      {key:'heading',label:entity.orientation_source==='attitude'?'기수 방위':'지상 진행 방향',value:number(heading,1,'°')},

      {key:'source',label:'데이터 출처',value:entity.source || '정보 없음'},

      {key:'derivation',label:'상태 산출',value:({sgp4:'SGP4 궤도 전파',gp_propagated:'GP 궤도 전파 (계산)',estimated:'관측 기반 추정',observation:'관측값',observed:'관측값',simulated:'시뮬레이션 계산'})[entity.derivation] || entity.derivation || '정보 없음'},

      {key:'provenance',label:'입력 구분',value:({live:'외부 공급자 데이터',cached:'저장 데이터',fixture:'시험 입력 (LIVE 아님)',simulation:'시뮬레이션'})[entity.provenance] || entity.provenance || '정보 없음'},

      {key:'observation',label:'관측 시각',value:date(entity.observation_time)},

      {key:'received',label:'수신 시각',value:date(entity.received_time)},

      {key:'state_time',label:'상태 시각',value:date(entity.state_time)},

      ...(satellite?[{key:'epoch',label:'궤도 기준 시각',value:date(entity.orbit_epoch)}]:[

        {key:'age',label:'관측 경과',value:finite(entity.state_time) && finite(entity.observation_time)?number(Math.max(0,entity.state_time-entity.observation_time),0,' s'):'정보 없음'},

        {key:'validity',label:'추정 유효 한계',value:date(entity.valid_until)}])

    ]

  };

}



// Readouts use the selected snapshot, not the slower mission request. ECEF

// magnitude is not airspeed; an unavailable attitude is not a level aircraft.

export function describeFlightReadouts(entity) {

  const satellite=entity.kind==='satellite',uam=entity.kind==='uam';

  const velocity=entity.velocity_ecef_mps;

  const speed=entity.source==='replay'&&finite(entity.recorded_speed_mps)?entity.recorded_speed_mps:Array.isArray(velocity)&&velocity.length===3&&velocity.every(finite)?Math.hypot(...velocity):null;

  const attitude=entity.orientation_source==='attitude';

  const directional=attitude||entity.orientation_source==='ground_track';

  const heading=directional&&finite(entity.heading_deg)?((entity.heading_deg%360)+360)%360:null;

  const age=finite(entity.state_time)&&finite(entity.observation_time)?Math.max(0,entity.state_time-entity.observation_time):null;

  const epochAge=finite(entity.state_time)&&finite(entity.orbit_epoch)?(entity.state_time-entity.orbit_epoch)/3600:null;

  const metric=(key,label,value,digits,unit,sub)=>({key,label,value:finite(value)?number(value,digits):'—',unit:finite(value)?unit:'',sub});

  const cards=[

    metric('altitude',entity.estimation?'고도 · 보정 상태':'고도 · 원본 상태',finite(entity.altitude_m)?entity.altitude_m/(satellite?1000:1):null,satellite?1:0,satellite?'km':'m',

      satellite?'지표면 높이(AGL) 아님':finite(entity.altitude_m)?`${number(entity.altitude_m/0.3048,0)} ft · AGL 아님`:'고도 미수신'),

    metric('speed',entity.source==='replay'?'기록 속력':'속력 · ECEF',finite(speed)?speed*(satellite?0.001:3.6):null,satellite?2:0,satellite?'km/s':'km/h',

      satellite?'관성계 궤도 속력 아님':finite(speed)?`${number(speed,1)} m/s · ${number(speed/0.514444,0)} kt`:'속도 미수신'),

    {...metric('heading',attitude?'기수 방위':'지상 진행 방향',heading,0,'°',

      finite(heading)?['N · 북','NE · 북동','E · 동','SE · 남동','S · 남','SW · 남서','W · 서','NW · 북서'][Math.round(heading/45)%8]:'방위 미제공'),angle:heading},

    uam?metric('rotor','로터 회전수',finite(entity.rotor_radps)?entity.rotor_radps*60/(2*Math.PI):null,0,'rpm',entity.provenance==='physical_emulation'?'Physical 기체 보고':'시뮬레이션 상태값'):
      satellite?metric('epoch','궤도 기준 경과',epochAge,1,'h',finite(epochAge)&&epochAge<0?'기준 시각 이전의 계산':'현재 계산 시각 기준'):

        metric('age','관측 경과',age,0,'s','상태 시각 − 관측 시각'),

  ];

  const provenance=entity.provenance;

  const source=provenance==='physical_emulation'?'Physical 센서 · 모사':provenance==='fixture'?'시험 입력':provenance==='simulation'||entity.derivation==='simulated'?'시뮬레이션':
    satellite?'궤도 계산':entity.derivation==='estimated'?'관측 기반 추정':provenance==='cached'?'저장 데이터':

      ['observed','observation'].includes(entity.derivation)||provenance==='live'?'관측 데이터':'출처 확인 필요';

  // The battery the day's energy model carries for a scheduled UAM: a
  // representative estimate, said so, and absent for anything else.
  const battery=uam&&finite(entity.battery_pct)?{pct:entity.battery_pct,value:number(entity.battery_pct,0),state:entity.charge_state??null,
    sub:`${CHARGE_STATE_LABEL[entity.charge_state]??'충전기 미연결'} · 추정값`}:null;
  return {cards,source,battery,quality:entity.quality==='stale'?'오래된 상태':['valid','nominal'].includes(entity.quality)?'상태 수신':'상태 확인 필요',

    phase:entity.flight_phase?missionStage(entity.flight_phase):satellite?'궤도 전파':source,

    attitude:attitude?[

      {key:'pitch',label:'Pitch',value:number(entity.pitch_deg,1,'°')},

      {key:'roll',label:'Roll',value:number(entity.roll_deg,1,'°')},

    ]:[],

    tilt:uam&&finite(entity.tilt_deg)?entity.tilt_deg:null,

    mode:uam?flightMode(['parked','gate_out','gate_in','charge'].includes(entity.flight_phase)?{flight_mode:'ground'}:{tilt_deg:entity.tilt_deg}):null};

}



const MISSION_STEPS=['지상','이륙','상승','순항','접근','착륙','도착'];
export const CHARGE_STATE_LABEL={disconnected:'충전기 미연결',connecting:'주기장 연결 준비',charging:'충전 중',complete:'충전 완료',unavailable:'충전기 없음'};

const STEP_INDEX={parked:0,gate_out:0,takeoff:1,climb:2,cruise:3,descent:4,hold_exit:4,hold:4,hold_return:4,landing:5,gate_in:6,charge:6};



// A compact projection of the received mission, not a second flight state.

export function describeMissionOverview(detail) {

  const state=detail?.state;if(!state)return null;

  const plan=detail.flight,adherence=state.adherence,flow=state.passenger_flow;

  const index=STEP_INDEX[state.phase]??-1;

  const seats=finite(state.seats)?state.seats:null;

  const aboard=finite(state.on_board)?state.on_board:finite(state.passengers)?state.passengers:null;

  const sequence=detail.clearance?.sequence??state.sequence;

  const holding=describePilotDecision(detail).waiting;
  const phase=missionStage(state.phase);

  const seconds=adherence?.remaining_s;

  const active=Boolean(state.flight_id);

  return {

    from:state.flight_id?(plan?.origin_name||state.origin||'출발지 미제공'):(state.vertiport||'위치 미제공'),

    to:state.flight_id?(plan?.destination_name||state.destination||'도착지 미제공'):(state.stand||'주기 위치 미제공'),

    routeLabel:state.flight_id?'비행 구간':'주기 위치',

    phase,mode:flightMode(state),holding,

    steps:MISSION_STEPS.map((label,i)=>({label:holding&&i===index?'체공':label,state:i===index?'current':i<index?'past':'next'})),

    progress:!active?'다음 임무 대기':finite(adherence?.progress)?`${Math.round(Math.max(0,Math.min(1,adherence.progress))*100)}%`:'진행률 미제공',

    eta:!active?'':finite(seconds)?`착륙까지 ${seconds>0?Math.max(1,Math.round(seconds/60))+'분':'0분'}`:'잔여 시간 미제공',

    timing:!active?'':adherenceText(adherence)||'계획 시각 미제공',

    timingLevel:finite(adherence?.delay_s)&&adherence.delay_s>=30?'late':'neutral',

    planned:finite(adherence?.plan_share)?`│ 계획 ${Math.round(Math.max(0,Math.min(1,adherence.plan_share))*100)}%`:'',

    passengers:aboard===null?'미제공':seats===null?`${aboard}명`:`${aboard} / ${seats}명`,

    occupancy:seats>0&&aboard!==null?Math.max(0,Math.min(1,aboard/seats)):null,

    sequence:finite(sequence)&&sequence>0?`${sequence}번`:'미배정',

    remaining:finite(detail.remaining)?`${detail.remaining}편`:'미제공',

    flow:flow&&['boarding','alighting'].includes(flow.phase)?`${flow.phase==='boarding'?'탑승 중':'하기 중'} · ${finite(flow.moved)?flow.moved:'—'} / ${finite(flow.count)?flow.count:'—'}명`:'',

    warning:state.pilot_failed?'조종사 실행 오류 · 상태 확인 필요':holding?

      [describePilotDecision(detail).reason,finite(sequence)&&sequence>0?`착륙 ${sequence}순위`:null,
        state.hold_seconds>0?`${number(state.hold_seconds,0)}초 대기`:null].filter(Boolean).join(' · '):

      state.direct?'직항 회랑 사용 · 설계 항로 없음':'',

    failed:Boolean(state.pilot_failed),

  };

}

// "등속 외삽으로", "SGP4로": the instrumental particle follows the last letter of

// the name it is attached to, and a name ending in a Latin letter or a digit is

// read as its Korean sound, so the note reads as written Korean either way.

// A Latin letter or digit is read aloud in Korean, and only m (엠), n (엔) and

// the digits 3 (삼), 6 (육) and 0 (영) end in a consonant that calls for 으로.

const SPOKEN_CODA = new Set(['m', 'M', 'n', 'N', '3', '6', '0']);

// What a UAM is doing right now, in the words an operator uses for it. The

// phases are the plan's own, plus the three a hold is made of; a phase nobody

// named is shown as it came rather than hidden.

export const MISSION_PHASE = {

  parked: '주기', gate_out: '지상 이동 (출발)', takeoff: '이륙', climb: '상승 · 전환',

  cruise: '순항', descent: '강하 · 전환', hold_exit: '역천이 · 대기 이동', hold: 'PSU 대기',

  hold_return: '접근 복귀', landing: '착륙', gate_in: '지상 이동 (도착)', charge: '충전',

};

// The stage of the mission each phase belongs to, so the headline says what is

// happening rather than which leg of a plan is being flown.

export const MISSION_STAGE = {

  parked: '대기 중', gate_out: '출발 준비', takeoff: '이륙', climb: '상승',

  cruise: '순항', descent: '접근', hold_exit: '체공 진입', hold: '체공',

  hold_return: '접근 재개', landing: '착륙', gate_in: '도착', charge: '도착',

};

export function missionPhase(phase) {return MISSION_PHASE[phase] ?? phase ?? '정보 없음';}

export function missionStage(phase) {return MISSION_STAGE[phase] ?? missionPhase(phase);}



// How the rotors are pointing, in the words the operating figures use. The

// server decides the mode; this names it, and reads the tilt itself only when

// an older answer carries no mode at all.

export const FLIGHT_MODE = {

  ground: '지상', multirotor: '멀티로터', transition: '모드 전환 (천이)', fixed_wing: '고정익',

};

export function flightMode(state) {

  if (state?.flight_mode_label) return state.flight_mode_label;

  if (state?.flight_mode) return FLIGHT_MODE[state.flight_mode] ?? state.flight_mode;

  if (!finite(state?.tilt_deg)) return '정보 없음';

  return state.tilt_deg >= 75 ? FLIGHT_MODE.fixed_wing

    : state.tilt_deg <= 15 ? FLIGHT_MODE.multirotor : FLIGHT_MODE.transition;

}



// The flight against the plan it was given. Late is positive on the wire, and a

// flight nobody gave a time to says nothing rather than claiming to be on time.

export function adherenceText(adherence) {

  if (!adherence || !finite(adherence.delay_s)) return null;

  const late = Math.round(adherence.delay_s);

  if (Math.abs(late) < 30) return `계획대로 (${late >= 0 ? '+' : ''}${late}초)`;

  const minutes = Math.max(1, Math.round(Math.abs(late) / 60));

  return late > 0 ? `${minutes}분 늦음 (+${late}초)` : `${minutes}분 빠름 (${late}초)`;

}



export function describeMission(detail) {
  const state = detail?.state;

  if (!state) return null;

  const flight = detail.flight ?? null;

  const clearance = detail.clearance ?? null;

  const adherence = state.adherence ?? null;

  const flow = state.passenger_flow ?? null;

  const airborne = Boolean(state.airborne);
  const holding = describePilotDecision(detail).waiting;
  const fields = [

    {key: 'stage', label: '임무 상태', value: missionStage(state.phase)},

    {key: 'phase', label: '비행 단계', value: missionPhase(state.phase)},

    {key: 'mode', label: '비행 모드', value: flightMode(state)},

  ];

  if(state.energy){
    const e=state.energy;
    const charging={disconnected:'연결 안 됨',connecting:'주기장 연결 준비',charging:'충전 중',complete:'목표 충전 완료 · 연결 유지',unavailable:'충전기 없음'};
    const warning={normal:'정상',low:'잔량 낮음',critical:'잔량 매우 낮음',depleted:'잔량 소진 · 가상 비행 유지'};
    fields.push({key:'battery',label:'배터리 잔량 (추정)',value:`${number(e.soc_pct,1,'%')} · ${number(e.remaining_kwh,1,' kWh')} / ${number(e.capacity_kwh,0,' kWh')}`},
      {key:'energy_power',label:'소비 / 충전 전력',value:e.power_kw<0?`충전 ${number(e.charge_power_kw,1,' kW')}`:`소비 ${number(e.power_kw,1,' kW')}`},
      {key:'energy_charge',label:'충전 연결',value:charging[e.charge_state]??'—'},
      {key:'energy_used',label:'이번 비행 사용량',value:number(e.flight_used_kwh,2,' kWh')},
      {key:'energy_warning',label:'배터리 정책',value:`${warning[e.warning]??'—'} · 부족 시 기록만, 추락 미적용`},
      {key:'energy_deficit',label:'0% 이후 부족 에너지',value:number(e.deficit_kwh,2,' kWh')},
      {key:'energy_basis',label:'에너지 모델',value:'대표 기체 추정 · 온도/열화/실측 전력 미반영'});
  }

  if (state.flight_id) {

    fields.push({key: 'flight', label: '편명', value: state.flight_id});

    fields.push({key: 'route', label: '구간',

      value: `${flight?.origin_name || state.origin || '?'} → ${flight?.destination_name || state.destination || '?'}`});

  } else {

    fields.push({key: 'stand', label: '주기 위치',

      value: `${state.vertiport ?? '?'} ${state.stand ?? ''}`.trim()});

  }

  // How far through, and whether it is keeping to the plan. The bar is drawn

  // from `progress`; this row says the same thing for anyone reading the text.

  if (adherence && finite(adherence.progress)) {

    fields.push({key: 'progress', label: '비행 진행률',

      value: `${Math.round(adherence.progress * 100)}%` +

        (finite(adherence.remaining_s) && adherence.remaining_s > 0

          ? ` · 착륙까지 ${Math.max(1, Math.round(adherence.remaining_s / 60))}분` : '')});

    const said = adherenceText(adherence);

    if (said) fields.push({key: 'adherence', label: '계획 대비', value: said});

  }

  // Who is aboard, and who is still walking. A seat count on its own does not

  // say whether the walk has finished.

  const aboard = finite(state.on_board) ? state.on_board : state.passengers;

  fields.push({key: 'seats', label: '좌석 · 탑승', value: `${finite(state.seats)?state.seats+'석':'좌석 미제공'} · ${finite(aboard)?aboard+'명':'탑승 미제공'}`});

  if (flow && (flow.phase === 'boarding' || flow.phase === 'alighting')) {

    fields.push({key: 'flow', label: flow.phase === 'boarding' ? '탑승' : '하기',

      value: `${flow.moved ?? 0} / ${flow.count ?? 0}명` +

        (finite(flow.share) ? ` (${Math.round(flow.share * 100)}%)` : '')});

  }

  if (airborne || state.speed_mps) {

    fields.push({key: 'speed', label: '대지 속도',

      value: `${number(state.speed_mps, 1, ' m/s')}${finite(state.speed_mps) ? ` (${(state.speed_mps / 0.514444).toFixed(0)} kt)` : ''}`});

  }

  if (airborne && finite(state.tilt_deg)) {

    fields.push({key: 'tilt', label: '로터 Tilt', value: number(state.tilt_deg, 0, '°')});

  }

  if (state.engine) {

    fields.push({key:'engine',label:'실행 모델',value:({'native-fastphysics-simpleflight':'FastPhysics + SimpleFlight',

      'kinematic-ground':'지상 기동 모델','kinematic-rehearsal':'간이 운항 연습'})[state.engine]||state.engine});

  }

  // The service's own record when it kept one, otherwise the number the

  // aircraft is holding: a pilot given a landing number sees it either way.

  const sequence = clearance?.sequence ?? state.sequence ?? null;

  if (sequence) {

    fields.push({key: 'sequence', label: '착륙 순번', value: `${sequence}번`});

    if (clearance?.reason) fields.push({key: 'clearance', label: 'PSU 응답', value: clearance.reason});

  }

  if (state.hold_seconds > 0) {

    fields.push({key: 'hold', label: '대기 시간', value: number(state.hold_seconds, 0, ' s')});

  }

  if (state.direct) {

    fields.push({key: 'direct', label: '경로', value: '직항 회랑 (설계 항로 없음)'});

  }

  // What is drawn on the map for this aircraft, so the panel and the globe do

  // not disagree about whether a path is being shown.

  if (detail.paths) {

    fields.push({key: 'paths', label: '지도 표시', value: detail.paths});

  }

  if (Number.isFinite(detail.remaining)) {

    fields.push({key: 'remaining', label: '남은 편수', value: `${detail.remaining}편`});

  }

  return {

    title: '임무 상태',

    stage: missionStage(state.phase),

    mode: flightMode(state),

    holding,
    progress: adherence && finite(adherence.progress) ? adherence.progress : null,

    plannedShare: adherence && finite(adherence.plan_share) ? adherence.plan_share : null,

    fields,

    note: holding
      ? '체공 지시가 적용된 시뮬레이션 상태입니다. 현재 판단과 수신된 사유는 조종사 판단에서 확인할 수 있습니다.'
      : '재생 중인 비행계획의 현재 상태입니다. 관측값이 아니라 시뮬레이션 결과입니다.',

  };

}



export function withInstrumental(word) {

  const text = String(word ?? '').trim();

  if (!text) return text;

  const last = text[text.length - 1];

  const code = last.charCodeAt(0);

  if (code >= 0xac00 && code <= 0xd7a3) {

    const coda = (code - 0xac00) % 28;

    return `${text}${coda === 0 || coda === 8 ? '로' : '으로'}`;   // 8 is a final ㄹ

  }

  return `${text}${SPOKEN_CODA.has(last) ? '으로' : '로'}`;

}



// The next seconds under the estimation model the operator chose. Everything

// here is projected from one observed velocity, so the panel says which model

// drew it, how old the observation behind it is, and that it is not a route.

function describePrediction(path) {

  const s=path.summary;

  const turn=finite(s.turn_rate_dps) && Math.abs(s.turn_rate_dps)>=0.05

    ? `${number(Math.abs(s.turn_rate_dps),1,'°/s')} ${s.turn_rate_dps>0?'우선회':'좌선회'}` : '직진 (선회 없음)';

  return {

    title:'예상 경로',

    note:s.basis?path.note:`${withInstrumental(s.model_label || s.model || '추정 모델')} 앞으로 ${number(s.seconds,0,'초')}를 계산한 예상 경로입니다. `

      +'제출된 비행계획이나 측정된 궤적이 아니며, 관측된 속도가 그대로 이어진다고 본 결과입니다.'

      +(s.truncated?' 추정 유효 한계에서 잘렸습니다.':''),

    fields:[

      {key:'model',label:'추정 모델',value:s.model_label || s.model || '정보 없음'},

      {key:'span',label:'예상 구간',value:number(s.seconds,0,' s')},

      {key:'distance',label:'예상 이동 거리',value:number(finite(s.distance_m)?s.distance_m/1000:null,2,' km')},

      {key:'ground_speed',label:'지상 속력',value:number(s.ground_speed_mps,1,' m/s')},

      ...(s.basis==='mission_intent'?[{key:'phase',label:'반영한 비행 단계',value:missionPhase(s.flight_phase)},

        {key:'intent',label:'예측 기준',value:s.holding?'현재 대기 지점 유지':'남은 경유점 · 단계별 속도'}]:

        s.basis==='provider_corrected'?[]:[{key:'turn',label:'선회율',value:turn}]),
      {key:'climb',label:'상승률',value:number(s.climb_mps,1,' m/s')},

      {key:'age',label:'기준 관측 경과',value:number(s.observation_age_seconds,0,' s')},

    ]};

}



export function tooltipPosition(pointer,viewport,size) {

  const left=pointer.x+14+size.width>viewport.width-12?pointer.x-size.width-12:pointer.x+14;

  const top=pointer.y+14+size.height>viewport.height-12?pointer.y-size.height-12:pointer.y+14;

  return {left:Math.max(12,Math.min(left,viewport.width-size.width-12)),top:Math.max(12,Math.min(top,viewport.height-size.height-12))};

}



// Summary of the path the Live Twin computed for the selection. Values are

// projections of the stored model, never a recorded or measured track.

export function describeTrajectory(path) {
  if(path?.kind==='uam_prediction_comparison' && Array.isArray(path.predictions))return {
    title:'UAM 학습 예측 비교',
    note:'같은 기준 시각의 독립된 학습 예측입니다. 선의 끝 숫자는 현재부터 남은 시간이 아니라 예측 기준부터의 구간입니다. '
      +'이미 지난 구간만 표시 시각에 맞춰 잘라내며 예측 좌표는 옮기지 않습니다. '
      +'실제 비행 궤적이나 운항 지시가 아니며 현재 UAM에 대한 정확도를 보장하지 않습니다. '
      +(typeof path.input_quality==='string'?path.input_quality:path.predictions.find(p=>p.path?.summary?.note)?.path.summary.note??''),
    fields:[...path.predictions.map(entry=>({key:entry.model_id,label:`${entry.label} +${entry.horizon_seconds}초`,
      color:entry.color,pattern:entry.pattern,
      value:(entry.visible===false?'숨김 / ':'')+(entry.status==='warming_up'
        ? `이력 준비 중 (${number(entry.available_history_seconds,1,'')} / ${number(entry.history_seconds,1,'초')})`
        :entry.status==='ready'?(entry.expired?'유효 구간 경과':entry.visible===false?'준비 완료':'표시 중'):'사용 불가')
        +(entry.reason?` — ${entry.reason}`:''),
    })),{key:'generated_at',label:'공통 기준 시각',value:date(path.generated_at)},
    ...(path.display?[
      {key:'refresh',label:'예측 갱신',value:(path.display.delayed?'갱신 지연 · 남은 유효 구간만 표시':'갱신 정상')
        +(finite(path.display.response_ms)?` · 응답 ${number(path.display.response_ms,0,' ms')}`:'')},
      {key:'forecast_age',label:'예측 기준 경과',value:`${number(path.display.age_seconds,1,' s')} · 표시 시계 기준`},
    ]:[])],
  };
  if(!path || !path.summary)return null;
  if(path.kind==='aircraft')return describePrediction(path);

  if(path.kind!=='satellite')return null;

  const s=path.summary;

  return {

    title:'궤도',

    note:'저장된 궤도 요소를 SGP4로 전파한 계산 경로입니다. 실제 측정 궤적이 아닙니다.',

    fields:[

      {key:'period',label:'궤도 주기',value:number(s.period_minutes,1,' 분')},

      {key:'apogee',label:'원지점 고도',value:number(s.apogee_km,0,' km')},

      {key:'perigee',label:'근지점 고도',value:number(s.perigee_km,0,' km')},

      {key:'inclination',label:'궤도 경사각',value:number(s.inclination_deg,2,'°')},

      {key:'epoch_age',label:'궤도 기준 시각 경과',value:number(s.epoch_age_hours,1,' 시간')},

      {key:'span',label:'표시 구간',value:number(finite(path.span_seconds)?path.span_seconds/60:null,1,' 분')},

    ]};

}

