// This row is deliberately separate from provider settings, which are shared.
// Only the operator's preference is stored, not display/device measurements.
import {buildElement} from './dom_builder.js';
const KEY='aerodt.display-quality';
const choices=[['auto','자동 맞춤'],['sharp','선명도 우선'],['efficient','성능 우선']];
export function displayQualitySetting({document,storage,applyLabels=()=>{}}={}) {
  try {storage??=globalThis.localStorage;} catch {}
  let mode='auto';try {mode=storage?.getItem(KEY)||mode;} catch {}
  if(!choices.some(([id])=>id===mode))mode='auto';
  const el=(tag,props,...children)=>buildElement(document,tag,props,...children);
  const select=el('select',{id:'display-quality','aria-label':'이 PC의 지도 렌더링 품질'},
    ...choices.map(([value,text])=>el('option',{value,text})));
  select.value=mode;
  const status=el('output',{class:'display-profile',id:'display-profile','aria-live':'polite',text:'화면 해상도 확인 대기',
    title:'화면은 브라우저 표시 영역(CSS 픽셀), 배율은 운영체제와 브라우저의 픽셀 배율입니다. 지도는 정지 상태의 렌더링 해상도입니다.'});
  const retry=el('button',{type:'button',text:'다시 맞추기',disabled:'','aria-label':'이 PC의 화면 해상도와 렌더링 부하 다시 확인'});
  const row=el('section',{class:'display-calibration','aria-label':'이 PC 화면 최적화'},
    el('div',{class:'setting-row setting-row-select'},el('span',{text:'이 PC 화면'}),select),status,
    el('div',{class:'display-calibration-foot'},el('span',{text:'이 브라우저에만 적용'}),retry));
  let resolution;
  const update=(profile,result)=>{
    const note=result.status==='sampling'?'현재 화면 렌더링 확인 중…':
      result.status==='measured'?'프레임 확인 완료':result.status==='pending'?'해상도 우선 적용': '해상도 기준 적용 (프레임 표본 부족)';
    status.textContent=`화면 ${profile.width} × ${profile.height} · 배율 ${Math.round(profile.dpr*100)}%\n`+
      `지도 ${profile.renderWidth} × ${profile.renderHeight} · ${note}`;
    status.dataset.status=result.status;
    retry.disabled=result.status==='sampling';
    const root=document.documentElement;
    root?.style.setProperty('--display-text-scale',String(profile.textScale));
    root?.style.setProperty('--display-panel-blur',profile.mode==='efficient'||profile.tier==='constrained'?'6px':'14px');
    applyLabels(profile.labelPercent);
  };
  const calibrate=async options=>{
    if(!resolution)return;
    try {return await resolution.calibrate(options);}
    finally {retry.disabled=false;}
  };
  select.onchange=()=>{
    mode=choices.some(([id])=>id===select.value)?select.value:'auto';select.value=mode;
    try {storage?.setItem(KEY,mode);} catch {}
    resolution?.setMode(mode);
  };
  retry.onclick=()=>void calibrate();
  return {row,select,status,retry,calibrate,attach(value){
    resolution=value;resolution.onChange=update;resolution.setMode(mode);retry.disabled=false;
  }};
}
