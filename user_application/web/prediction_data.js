// Read-only presentation of served future trajectories. Coordinates and clocks
// remain those of the forecast; no new aircraft motion is extrapolated here.
export const ROLES={psu:{label:'PSU',title:'운항 지역 전체',description:'전체 교통 흐름과 예측 경로를 한눈에'},
  vertiport:{label:'버티포트',title:'버티포트 주변 3 km',description:'접근하는 교통과 주변 공역의 변화'},
  pilot:{label:'조종사',title:'내 기체 중심',description:'예상 진로와 먼저 확인할 주변 교통'}};
export const MODEL_STYLES={uam_route_mlp_short:{label:'단기',color:'#65e5d2',seconds:10},
  uam_route_mlp_mid:{label:'중기',color:'#f4bb75',seconds:90},
  uam_route_mlp_long:{label:'장기',color:'#b9a0ff',seconds:240}};
export const MAX_FORECASTS=8;
export const PHASES={parked:'주기',charge:'충전',gate_out:'지상 출발',takeoff:'이륙',climb:'상승',cruise:'순항',hold:'대기',approach:'접근',landing:'착륙',gate_in:'지상 도착'};
export const finite=Number.isFinite;
export const located=e=>e&&finite(e.latitude_deg??e.latitude)&&finite(e.longitude_deg??e.longitude)&&Math.abs(e.latitude_deg??e.latitude)<=90&&Math.abs(e.longitude_deg??e.longitude)<=180;
export const latitude=e=>e.latitude_deg??e.latitude;
export const longitude=e=>e.longitude_deg??e.longitude;
// Not on the ground and not on the vertical off the pad: a forecast starts
// with the climb-out.
export const airborne=e=>!['parked','charge','gate_in','gate_out','takeoff','landed','complete'].includes(e.flight_phase);
export const uams=snapshot=>(snapshot?.entities??[]).filter(e=>e.kind==='uam'&&located(e));
export function distance(a,b){const rad=Math.PI/180,dy=(latitude(b)-latitude(a))*rad,dx=(longitude(b)-longitude(a))*rad;
  const h=Math.sin(dy/2)**2+Math.cos(latitude(a)*rad)*Math.cos(latitude(b)*rad)*Math.sin(dx/2)**2;
  return 6371000*2*Math.asin(Math.sqrt(Math.min(1,h)));}
export function localProjection(center){const sy=111320,sx=sy*Math.cos(latitude(center)*Math.PI/180);
  return {point:p=>[(longitude(p)-longitude(center))*sx,-(latitude(p)-latitude(center))*sy],
    geo:([x,y])=>({latitude:latitude(center)-y/sy,longitude:longitude(center)+x/sx})};}
export function ecefToGeo([x,y,z]){
  const a=6378137,e2=6.69437999014e-3,p=Math.hypot(x,y);if(![x,y,z].every(finite)||Math.hypot(p,z)<6e6)return null;
  let lat=Math.atan2(z,p*(1-e2)),height=0;
  for(let i=0;i<8;i++){const n=a/Math.sqrt(1-e2*Math.sin(lat)**2);height=p/Math.max(1e-12,Math.cos(lat))-n;lat=Math.atan2(z,p*(1-e2*n/(n+height)));}
  return {latitude:lat*180/Math.PI,longitude:Math.atan2(y,x)*180/Math.PI,altitude_m:height};
}
export function geoToEcef(latitude,longitude,height=0){const lat=latitude*Math.PI/180,lon=longitude*Math.PI/180,n=6378137/Math.sqrt(1-6.69437999014e-3*Math.sin(lat)**2);
  return [(n+height)*Math.cos(lat)*Math.cos(lon),(n+height)*Math.cos(lat)*Math.sin(lon),(n*(1-6.69437999014e-3)+height)*Math.sin(lat)];}

export function checkedForecast(value,entity,epoch){
  const invalid=reason=>({entityId:entity.entity_id,status:'unavailable',reason,paths:[]});
  if(!value||value.entity_id!==entity.entity_id||value.epoch!==epoch)return invalid('예측 기준이 현재 상태와 다릅니다.');
  if(value.continuity_id!=null&&value.continuity_id!==entity.continuity_id)return invalid('운항 구간이 변경되어 다시 계산합니다.');
  if(value.flight_phase&&value.flight_phase!==entity.flight_phase)return invalid('운항 단계가 변경되어 다시 계산합니다.');
  const comparison=value.schema_version===2&&value.kind==='uam_prediction_comparison';
  if(!comparison&&!(value.schema_version===1&&value.kind==='aircraft'))return invalid('지원하지 않는 예측 응답입니다.');
  const entries=comparison?value.predictions:[{model_id:value.summary?.model??'served',status:'ready',path:value}];
  if(!Array.isArray(entries)||entries.length>3)return invalid('예측 결과를 확인할 수 없습니다.');
  if(comparison&&(!finite(value.generated_at)||value.continuity_id==null||typeof value.flight_phase!=='string'||
    new Set(entries.map(e=>e.model_id)).size!==entries.length||entries.some(e=>!MODEL_STYLES[e.model_id])))return invalid('비교 모델의 기준 정보가 맞지 않습니다.');
  const paths=[];let warming=false;
  for(const entry of entries){
    if(entry.status==='warming_up')warming=true;
    const p=entry.path;
    if(entry.status!=='ready'||!p||p.entity_id!==entity.entity_id||p.reference_frame!=='ecef_m'||
      (p.epoch!=null&&p.epoch!==epoch)||(p.continuity_id!=null&&p.continuity_id!==entity.continuity_id)||
      (p.flight_phase&&p.flight_phase!==entity.flight_phase)||!Array.isArray(p.points)||p.points.length<2||p.points.length>1200)continue;
    if(!p.points.every((point,i)=>Array.isArray(point)&&point.length===4&&point.every(finite)&&(!i||point[0]>p.points[i-1][0])))continue;
    const points=p.points.map(([time,...xyz])=>({time,...ecefToGeo(xyz)}));
    if(points.some(point=>!located(point)))continue;
    const start=points[0].time,end=points.at(-1).time;
    if(end-start>600||end<=start||start>entity.state_time+2)continue;
    if(comparison&&(entry.horizon_seconds!==MODEL_STYLES[entry.model_id].seconds||Math.abs(start-value.generated_at)>.001||
      Math.abs(end-value.generated_at-entry.horizon_seconds)>.001))continue;
    const style=MODEL_STYLES[entry.model_id]??{label:p.summary?.basis==='mission_intent'?'임무 기반':'서버 예측',color:'#65e5d2'};
    paths.push({model:entry.model_id,label:style.label,color:style.color,seconds:Math.round(end-start),points,start,end,note:p.note??value.note??'',basis:p.summary?.basis});
  }
  return {entityId:entity.entity_id,epoch,continuity:entity.continuity_id,phase:entity.flight_phase,
    status:paths.length?'ready':warming?'warming_up':'unavailable',reason:paths.length?'':warming?'모델 입력 이력을 모으고 있습니다.':entries.find(e=>e.reason)?.reason??'예측 경로를 받지 못했습니다.',paths};
}
export function pathAt(path,time){
  if(!path||!finite(time)||time<path.start||time>path.end)return null;
  const points=path.points;let i=0;while(i<points.length-2&&points[i+1].time<time)i++;
  const a=points[i],b=points[i+1],u=(time-a.time)/(b.time-a.time);
  return {time,latitude:a.latitude+(b.latitude-a.latitude)*u,longitude:a.longitude+(b.longitude-a.longitude)*u,altitude_m:a.altitude_m+(b.altitude_m-a.altitude_m)*u};
}
export function pathFor(record,horizon,now){const paths=(record?.paths??[]).filter(p=>p.end>now).sort((a,b)=>a.seconds-b.seconds);
  return paths.find(p=>p.seconds>=horizon)??paths.at(-1)??null;}
export function clippedPath(path,now,horizon){if(!path)return [];const from=Math.max(now,path.start),to=Math.min(now+horizon,path.end);
  if(to<=from)return [];return [pathAt(path,from),...path.points.filter(p=>p.time>from&&p.time<to),pathAt(path,to)];}
export function matchingForecast(record,entity,epoch){return record&&entity.quality!=='stale'&&!entity.discontinuity&&
  (!finite(entity.valid_until)||entity.valid_until>=entity.state_time)&&record.epoch===epoch&&record.continuity===entity.continuity_id&&record.phase===entity.flight_phase;}
export function scopeFor(role,entities,ports,selected){
  const target=role==='vertiport'?ports.find(p=>p.id===selected):entities.find(e=>e.entity_id===selected);
  if(role!=='psu'&&target)return {center:target,radius:role==='vertiport'?3000:6000,target};
  const points=[...ports,...entities.filter(airborne)].filter(located);
  const center=points.length?{latitude:(Math.min(...points.map(latitude))+Math.max(...points.map(latitude)))/2,
    longitude:(Math.min(...points.map(longitude))+Math.max(...points.map(longitude)))/2}:{latitude:37.54,longitude:126.98};
  const projected=points.map(localProjection(center).point);
  return {center,radius:Math.max(6000,...points.map(p=>distance(p,center)))*1.1,target:null,
    extent:{x:Math.max(3000,...projected.map(p=>Math.abs(p[0])))*1.15,y:Math.max(3000,...projected.map(p=>Math.abs(p[1])))*1.15}};
}
export function candidates(entities,role,target,previous=[]){
  const moving=entities.filter(airborne),previousIds=new Set(previous);
  return moving.sort((a,b)=>{
    if(role==='pilot'){if(a.entity_id===target?.entity_id)return -1;if(b.entity_id===target?.entity_id)return 1;}
    if(target)return distance(a,target)-distance(b,target);
    return Number(previousIds.has(b.entity_id))-Number(previousIds.has(a.entity_id))||a.entity_id.localeCompare(b.entity_id);
  }).slice(0,MAX_FORECASTS);
}
// Advisory comparisons of served future samples, never operational clearances.
// Fixed visual thresholds are disclosed alongside the result, not safety claims.
export function predictionEvents({entities,forecasts,now,horizon,role,target,epoch}){
  const valid=entities.flatMap(e=>{const r=forecasts.get(e.entity_id),path=matchingForecast(r,e,epoch)&&pathFor(r,horizon,now);return path?[{e,path}]:[];}),events=[];
  for(let i=0;i<valid.length;i++)for(let j=i+1;j<valid.length;j++){
    const a=valid[i],b=valid[j];if(role==='pilot'&&a.e.entity_id!==target?.entity_id&&b.e.entity_id!==target?.entity_id)continue;
    let best=null;const start=Math.max(now,a.path.start,b.path.start),end=Math.min(now+horizon,a.path.end,b.path.end);
    for(let time=start;time<=end;time+=2){const pa=pathAt(a.path,time),pb=pathAt(b.path,time),gap=distance(pa,pb),vertical=Math.abs(pa.altitude_m-pb.altitude_m);
      if(gap<200&&vertical<60&&(!best||gap<best.gap)&&!(role==='vertiport'&&target&&distance(pa,target)>3000))best={gap,vertical,time,point:pa};}
    if(best)events.push({id:`near:${a.e.entity_id}:${b.e.entity_id}`,kind:'near',priority:0,title:'예측 경로 근접',
      detail:`${a.e.name} · ${b.e.name}`,metric:`+${Math.round(best.time-now)}초 · 수평 ${Math.round(best.gap)} m / 고도차 ${Math.round(best.vertical)} m`,
      note:'시각화 참고 기준: 수평 200 m · 고도차 60 m. 관제 분리 기준이 아닙니다.',action:'두 기체의 진로 확인',ids:[a.e.entity_id,b.e.entity_id],...best});
  }
  if(role==='vertiport'&&target)for(const {e,path} of valid){
    const samples=clippedPath(path,now,horizon);if(!samples.length||distance(samples[0],target)<=3000)continue;
    const first=samples.find(p=>distance(p,target)<=3000);if(first)events.push({id:`entry:${e.entity_id}`,kind:'entry',priority:1,title:'3 km 관측권 진입 예상',detail:e.name,
      metric:`약 ${Math.round(first.time-now)}초 후`,note:'현재 제공된 예측 경로의 관측권 경계 통과 시점입니다.',action:'접근 방향 확인',ids:[e.entity_id],point:first,time:first.time});
  }
  return events.sort((a,b)=>a.priority-b.priority||a.time-b.time).slice(0,3);
}
