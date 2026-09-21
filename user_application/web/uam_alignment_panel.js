const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const n=(x,d=1)=>Number.isFinite(x)?x.toFixed(d):'—';
export const modeNames={filtered:'보정 중',aligned:'정렬 적용',coasting:'관측 사이 예측',outlier_rejected:'이상치 제외',reacquired:'관측 재확보',frozen:'현재 추정 한도'};

export function mountAlignment(parent){
  const box=el('section',undefined,'uam-alignment');box.setAttribute('aria-label','데이터 정렬 및 상태 추정');
  const title=el('div',undefined,'alignment-title');title.append(el('strong','데이터 정렬 · 상태 추정'),el('small','분석 모델 · AI 미사용'));
  const flow=el('p','시각 정렬 → 이상치 검사 → 공분산 보정 → Twin 반영','alignment-flow');
  const stats=el('div',undefined,'alignment-stats'),note=el('p','현재 상태의 불확실성을 함께 계산합니다.','physical-note');
  const details=el('details'),summary=el('summary','정렬·안정화 설정');details.append(summary);
  const form=el('div',undefined,'alignment-form');let settings=null,dirty=false,pending=false;
  const enabled=el('input');enabled.type='checkbox';enabled.setAttribute('aria-label','센서 안정화 적용');
  const enableLabel=el('label');enableLabel.append(enabled,el('span','센서 안정화 적용'));form.append(enableLabel);
  const fields={};
  const definitions=[['coast_seconds','누락 예측 한도 (초)',0,5,.5],['gate_sigma','이상치 판정 (σ)',3,8,.5],
    ['attitude_seconds','자세 안정화 시간 (초)',.02,.5,.02],['max_sigma_m','위치 불확실성 한도 (m)',3,100,1]];
  for(const [key,label,min,max,step] of definitions){const row=el('label',label),input=el('input');input.type='number';input.min=min;input.max=max;input.step=step;input.setAttribute('aria-label',label);row.append(input);fields[key]=input;form.append(row);}
  const presets=el('div',undefined,'alignment-presets');
  for(const [label,values] of [['빠른 반응',{attitude_seconds:.06,coast_seconds:1}],['균형',{attitude_seconds:.12,coast_seconds:2}],['부드럽게',{attitude_seconds:.25,coast_seconds:3}]]){
    const b=el('button',label);b.type='button';b.onclick=()=>{for(const [k,v] of Object.entries(values))fields[k].value=v;dirty=true;feedback.textContent='변경값을 적용해 주세요.';};presets.append(b);
  }
  const feedback=el('p','원본 관측을 바꾸지 않습니다. 설정 변경 시 새 관측으로 필터를 시작합니다.','physical-note');feedback.setAttribute('role','status');
  const apply=el('button','정렬 설정 적용');apply.type='button';apply.disabled=true;
  apply.onclick=async()=>{
    if(!settings||pending)return;pending=true;apply.disabled=true;
    try{
      const value={...settings,enabled:enabled.checked};for(const [key,input] of Object.entries(fields))value[key]=Number(input.value);
      const response=await fetch('/api/live/uam/alignment',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(value),signal:AbortSignal.timeout(5000)});
      const body=await response.json();if(!response.ok)throw Error(body.message||'설정 저장 실패');
      dirty=false;update(body);feedback.textContent='저장·적용했습니다. 다음 상태 갱신부터 반영됩니다.';
    }catch(e){feedback.textContent=e.message;}finally{pending=false;apply.disabled=false;}
  };
  for(const input of [enabled,...Object.values(fields)])input.oninput=()=>{dirty=true;feedback.textContent='변경값을 적용해 주세요.';};
  details.append(presets,form,apply,feedback);box.append(title,flow,stats,note,details);parent.append(box);
  function update(value){
    box.hidden=!value;if(!value)return;
    settings=value.settings;const modes=value.modes||{};
    stats.replaceChildren(...[['보정', (modes.filtered||0)+(modes.aligned||0)+(modes.reacquired||0)],['예측 보완',modes.coasting||0],
      ['확인 필요',(modes.frozen||0)+(modes.outlier_rejected||0)],['이상치 누적',(value.gnss_outliers||0)+(value.attitude_outliers||0)]].map(([label,count])=>{const e=el('div');e.append(el('small',label),el('strong',String(count)));return e;}));
    note.textContent=`최대 수평 불확실성 ${n(value.max_horizontal_sigma_m)} m · 미수신 값을 실제 관측으로 저장하지 않습니다.`;
    if(!dirty&&!pending){enabled.checked=settings.enabled;for(const [key,input] of Object.entries(fields))input.value=settings[key];}
    if(!pending)apply.disabled=false;
  }
  return update;
}

export function paintAlignment(detail){
  const value=detail.estimation;if(!value)return null;
  const box=el('section',undefined,'alignment-detail');box.dataset.mode=value.mode;
  const title=el('div',undefined,'alignment-title');title.append(el('h4','현재 시점의 Twin 추정'),el('strong',modeNames[value.mode]||value.mode));
  const grid=el('div',undefined,'alignment-values');
  for(const [label,text] of [['수평 / 수직 불확실성',`${n(value.horizontal_sigma_m)} / ${n(value.vertical_sigma_m)} m`],
    ['관측 시점 보정량',`${n(value.correction_m)} m`],['마지막 채택 관측',`${n(value.observation_age_s,2)}초 전`],
    ['예측 보완 길이',`${n(value.prediction_seconds,2)}초`],['제외한 위치 / 자세',`${value.gnss_outliers} / ${value.attitude_outliers}`],
    ['기압 고도',value.barometer_used?'시각 정렬 후 결합':'정렬 / 이상치 검사로 제외'],
    ['지상 안정화',value.stationary?'정지 관측 확인 · 위치/자세 유지':value.surface_constrained?'접지 관측 · 데크 고도 적용':'이동 관측 추종'],
    ['자세 관측 경과',`${n(value.attitude_age_s,2)}초${value.attitude_age_s>2?' · 마지막 자세 유지':''}`]]){
      const cell=el('div');cell.append(el('small',label),el('strong',text));grid.append(cell);
  }
  const raw=detail.raw_sensors?.gnss||detail.sensors.gnss;
  const comparison=el('div',undefined,'alignment-comparison');
  if(raw)comparison.append(el('p',`원본 GNSS · ${n(raw.values.latitude_deg,6)}°, ${n(raw.values.longitude_deg,6)}° / ${n(raw.values.altitude_ellipsoid_m)} m`));
  comparison.append(el('p',`현재 Twin · ${n(value.latitude_deg,6)}°, ${n(value.longitude_deg,6)}° / ${n(value.altitude_m)} m`));
  const meter=el('meter');meter.min=0;meter.max=detail.alignment_settings?.max_sigma_m||20;meter.value=value.horizontal_sigma_m;meter.setAttribute('aria-label','수평 위치 불확실성');
  const flags=detail.sensor_alignment||{},excluded=[...(flags.late||[]),...(flags.held||[])];
  const note=el('p',value.mode==='frozen'?(detail.display_mode==='buffered_observations'?'현재 시점 추정은 한도에 도달했습니다. 지도는 수신한 관측까지 재생하고 새 관측을 기다립니다.':'추정 한도를 넘어 마지막 유효 위치에서 정지했습니다. 새 관측을 기다립니다.'):
    value.mode==='coasting'?'관측 시점에서 현재까지 짧게 예측한 상태입니다. 센서 주기와 전송 지연도 포함되며, 이 표시만으로 통신 누락을 뜻하지는 않습니다.':
    value.mode==='outlier_rejected'?'예측과 크게 다른 관측을 제외했습니다. 마지막 정상 관측을 기준으로 유지합니다.':
    'GNSS·기압은 관측 시각으로 정렬하고 현재 시각까지 전파합니다. 원본과 현재 Twin의 기준 시각은 다릅니다.','physical-note');
  if(excluded.length)comparison.append(el('p','이전 관측 유지: '+[...new Set(excluded)].join(' · ')));
  const uncertaintyNote=el('p','불확실성은 모델이 계산한 추정치이며 실제 위치 오차의 보증 범위는 아닙니다.','physical-note');
  box.append(title,grid,meter,comparison,note,uncertaintyNote);return box;
}
