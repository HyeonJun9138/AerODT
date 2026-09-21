import {buildElement} from './dom_builder.js';
import {sliderSetting} from './slider_setting.js';

const KEY='aerodt.performance.v1';
const presets=[['balanced','균형 · 권장'],['quality','고화질 · 여유 있는 PC'],['fleet','다수 비행체 · 부드러운 이동'],['custom','사용자 지정']];
const rows=[
  ['maxModels','상세 비행체 수',v=>`${v}대`,'가까운 비행체부터 상세 모델로 표시합니다. 선택한 비행체는 우선하며 나머지도 위치와 기호를 계속 표시합니다.'],
  ['modelLoads','동시 모델 준비',v=>`${v}개`,'모델을 동시에 준비하는 수. 높이면 처음 로딩이 빨라지지만 순간 부하가 늘 수 있습니다.'],
  ['detailDistance','버티포트 상세 거리',v=>`${v/1000} km`,'이 거리 안에서는 데크 상세를, 밖에서는 단순 건물과 위치 기호를 표시합니다.'],
  ['terrainError','지형 상세 기준',v=>`${v} px`,'작을수록 세밀합니다. 이동 중에는 일시적으로 먼 지형의 상세도를 낮춥니다.'],
  ['terrainCache','지형 타일 보관',v=>`${v}개`,'크게 설정하면 다시 방문할 때 빨라지고 메모리를 더 사용합니다.'],
  ['buildingFetches','동시 건물 요청',v=>`${v}개`,'브이월드 건물 셀 요청 수. 과도한 요청으로 화면 생성 작업이 몰리지 않도록 별도 처리합니다.'],
  ['hybridDistance','혼합 모드 실사 거리',v=>`${v/1000} km`,'혼합 건물 모드에서 시점 주변을 실사로 표시할 최대 반경. 실사 데이터가 없거나 준비 중이면 일반 건물을 유지합니다.'],
  ['fog','시야 안개 · 건물 범위',v=>v===0?'끔':`${Math.round(v*100)}%`,'가까운 기체를 추적할 때 안개를 강화하고 먼 건물 요청을 줄입니다. 끄면 설정한 건물 최대 거리를 사용합니다.'],
  ['motionFloor','이동 중 최소 해상도',v=>`${Math.round(v*100)}%`,'부하가 클 때만 지도 해상도를 잠시 조절하며 멈추면 원래 해상도로 돌아옵니다. 100%는 항상 선명하게 유지합니다.'],
  ['annotationHz','부가 표시 갱신',v=>`${v}회/초`,'이름과 항로의 투명도 갱신 주기. 비행체의 움직임과 시뮬레이션 속도에는 영향이 없습니다.'],
];
export function performanceSettings({document,storage,profile,limits,apply=()=>{}}={}) {
  try{storage??=globalThis.localStorage;}catch{}
  let value;try{value=JSON.parse(storage?.getItem(KEY)||'null');}catch{}
  value=profile(value);value.targetFps=value.targetFps<45?30:60;
  const el=(tag,props,...children)=>buildElement(document,tag,props,...children);
  const select=el('select',{id:'performance-preset','aria-label':'이 PC 시각화 성능 프리셋'},
    ...presets.map(([value,text])=>el('option',{value,text})));
  const frameSelect=el('select',{id:'performance-frame-rate','aria-label':'화면 프레임 목표'},el('option',{value:'60',text:'60 FPS · 부드러움 우선'}),el('option',{value:'30',text:'30 FPS · 부하 감소'}));
  const status=el('output',{class:'performance-readout',id:'performance-readout',text:'화면 준비 중'});
  const detail=el('details',{class:'performance-detail'},el('summary',{text:'세부 성능 조정'}));
  const controls=new Map();
  const update=()=>{frameSelect.value=String(value.targetFps);select.value=value.preset;for(const [key,control] of controls)control.setValue(value[key]);};
  const commit=()=>{try{storage?.setItem(KEY,JSON.stringify(value));}catch{}apply({...value});};
  for(const [key,label,format,description] of rows){
    const [min,max,step]=limits[key];
    const control=sliderSetting({document,id:`performance-${key}`,label,description,min,max,step,
      fallback:value[key],format,apply:(next,{live})=>{
        value=profile({...value,preset:'custom',[key]:next});select.value='custom';
        if(!live)commit();
      }});
    controls.set(key,control);detail.append(control.row);
  }
  frameSelect.onchange=()=>{value=profile({...value,targetFps:frameSelect.value==='30'?30:60});update();commit();};
  select.onchange=()=>{if(select.value==='custom')value={...value,preset:'custom'};
    else value=profile({preset:select.value,targetFps:value.targetFps});update();commit();};
  const row=el('section',{class:'performance-settings','aria-label':'시각화 성능'},
    el('div',{class:'setting-row setting-row-select'},el('span',{text:'화면 프레임 목표'}),frameSelect),
    el('p',{class:'performance-note',text:'기본 60 FPS. 버벅임·발열이 크면 30 FPS로 낮추세요. 목표값이며 실제 FPS는 PC 성능과 화면 부하에 따라 낮아질 수 있습니다. 비행 계산 속도는 바뀌지 않습니다.'}),
    el('div',{class:'setting-row setting-row-select'},el('span',{text:'시각화 프리셋'}),select),
    el('p',{class:'performance-note',text:'이 브라우저에만 적용 · 가까운 대상 우선 · 비행 계산은 그대로'}),status,detail);
  update();
  return {row,select,frameSelect,controls,status,get value(){return {...value};},attach(next){apply=next;apply({...value});},
    report(stats){
      const fps=Number(stats?.fps),p95=Number(stats?.p95Ms);
      status.textContent=Number.isFinite(fps)&&fps>0?`현재 ${Math.round(fps)} FPS · 지연 95% ${Math.round(p95||0)} ms`+
        (Number.isFinite(stats.models)?` · 상세 모델 ${stats.models}개`:'')+
        (Number.isFinite(stats?.environment?.range)?` · 건물 반경 ${(stats.environment.range/1000).toFixed(1)} km`:''):'프레임 측정 대기';
    }};
}
