// Presentation-only rehearsal. These projections never own actual occupancy,
// issue clearances or change saved flight plans / Runtime state.
export const RESOURCE_NAMES = {gate:'Gate',fato:'FATO',charger:'충전',taxiway:'유도로'};
export const STATUS = {free:'가용',occupied:'점유',reserved:'예정',closed:'폐쇄',conflict:'조정 필요',unknown:'미연결'};
export const MINUTE = 60000;
export const timeLabel = ms => new Date(ms).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false});
export function resourcesOf(record) {
  const l=record?.layout??{};
  return [['fato',l.fatos],['gate',l.gates],['charger',l.chargers],['taxiway',l.edges]].flatMap(([kind,items]) =>
    (items??[]).map(item=>({...item,kind,key:`${kind}:${item.id}`})));
}
// Split server ledgers are authoritative: an assigned/planned stand in another
// row cannot move or release the aircraft that is still physically on it.
export function observedStandState(id,stands={},reservations={}) {
  const occupant=stands?.[id],reservation=reservations?.[id];
  if(typeof occupant==='string'&&occupant.trim())return {state:'occupied',occupants:[occupant]};
  if(typeof reservation==='string'&&reservation.trim())return {state:'reserved',occupants:[reservation]};
  return {state:'free',occupants:[]};
}
// The taxiway runs a vehicle crosses going from one deck node to another, in
// order. The deck's own topology decides it, so closing or colouring a taxiway
// follows the layout rather than guessing at unrelated ones.
export function taxiRuns(resources,fromId,toId) {
  if(!fromId||!toId||fromId===toId)return [];
  const edges=resources.filter(x=>x.kind==='taxiway');
  const queue=[[fromId,[]]],seen=new Set([fromId]);
  while(queue.length){
    const [id,path]=queue.shift();
    if(id===toId)return path;
    for(const edge of edges){
      const next=edge.from===id?edge.to:edge.to===id?edge.from:null;
      if(next&&!seen.has(next)){seen.add(next);queue.push([next,[...path,edge]]);}
    }
  }
  return [];
}
export function rehearsalSchedule(record,records,now) {
  const r=resourcesOf(record),gates=r.filter(x=>x.kind==='gate'),fatos=r.filter(x=>x.kind==='fato');
  if(!gates.length||!fatos.length)return [];
  const hour=Math.floor(now/(60*MINUTE))*60*MINUTE,others=records.filter(x=>x.id!==record.id);
  return Array.from({length:18},(_,i)=>{
    const direction=i%2?'departure':'arrival',gate=gates[i%gates.length];
    const allowed=fatos.filter(f=>f.role==='both'||!f.role||f.role===(direction==='arrival'?'landing':'takeoff'));
    if(!allowed.length)return null;
    const fato=allowed[i%allowed.length],at=hour+(i*8-24)*MINUTE;
    const charger=r.find(x=>x.kind==='charger'&&x.gate===gate.id);
    // Follow this layout's topology instead of colouring unrelated taxiways.
    const taxi=taxiRuns(r,gate.id,fato.id);
    const bookings=[{key:fato.key,start:at-MINUTE,end:at+MINUTE}];
    const groundAt=direction==='arrival'?at+MINUTE:at-3*MINUTE;
    taxi.forEach((edge,n)=>bookings.push({key:edge.key,start:groundAt+n*2*MINUTE/Math.max(1,taxi.length),end:groundAt+(n+1)*2*MINUTE/Math.max(1,taxi.length)}));
    const start=direction==='arrival'?at+3*MINUTE:at-15*MINUTE,end=direction==='arrival'?at+15*MINUTE:at-3*MINUTE;
    bookings.push({key:gate.key,start,end});if(charger)bookings.push({key:charger.key,start:start+MINUTE,end:end-MINUTE});
    return {id:`DEMO-${Math.floor(hour/MINUTE)}-${i}`,callsign:`AD ${String(101+i).padStart(3,'0')}`,direction,
      counterpart:others[i%Math.max(1,others.length)]?.name??'연결 버티포트',at,gate:gate.id,fato:fato.id,bookings};
  }).filter(Boolean);
}
export function resourceState(resource,flights,closures,now,demo=true) {
  const active=flights.flatMap(f=>f.bookings.filter(b=>b.key===resource.key&&b.start<=now&&b.end>now).map(()=>f.callsign));
  const closed=Boolean(closures[resource.key]);
  const state=closed?(active.length?'conflict':'closed'):!demo?'unknown':active.length>1?'conflict':active.length?'occupied':
    flights.some(f=>f.bookings.some(b=>b.key===resource.key&&b.start>now&&b.start<now+5*MINUTE))?'reserved':'free';
  return {state,occupants:active,reason:closures[resource.key]?.reason};
}
export function flightStatus(flight,closures,now) {
  if(flight.bookings.some(b=>closures[b.key]&&b.end>now))return '조정 필요';
  if(flight.at<now-2*MINUTE)return flight.direction==='arrival'?'도착':'출발';
  if(flight.at<=now+3*MINUTE)return flight.direction==='arrival'?'접근 예정':'출발 준비';
  return '예정';
}
export function nearestWeather(record,weather,now) {
  const frame=record?.layout?.frame??record??{},rad=Math.PI/180;
  if(!Number.isFinite(frame.latitude)||!Number.isFinite(frame.longitude))return null;
  const points=(weather?.points??[]).filter(p=>Number.isFinite(p.latitude)&&Number.isFinite(p.longitude)).map(p=>{
    const a=Math.sin((p.latitude-frame.latitude)*rad/2)**2+Math.cos(p.latitude*rad)*Math.cos(frame.latitude*rad)*Math.sin((p.longitude-frame.longitude)*rad/2)**2;
    return {...p,distance_km:6371*2*Math.asin(Math.sqrt(Math.min(1,a)))};
  }).sort((a,b)=>a.distance_km-b.distance_km);
  const p=points[0];if(!p)return null;
  const raw=p.observed_time,observed=typeof raw==='string'?Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(raw)?raw:raw+'Z'):NaN;
  const received=Number.isFinite(weather.received_time)?weather.received_time*1000:NaN;
  return {...p,observed_ms:observed,stale:!Number.isFinite(observed)||now-observed>60*MINUTE||!Number.isFinite(received)||now-received>60*MINUTE};
}
export function weatherSymbol(point) {
  const c=point?.weather_code;
  if([95,96,99].includes(c))return ['storm','뇌우'];
  if([71,73,75,77,85,86].includes(c))return ['snow','눈'];
  if([51,53,55,56,57,61,63,65,66,67,80,81,82].includes(c))return ['rain','비'];
  if([45,48].includes(c))return ['fog','안개'];
  if(c===0)return ['sun','맑음'];if(c===1||c===2)return ['partly','구름 조금'];if(c===3)return ['cloud','흐림'];
  if(Number.isFinite(point?.cloud_cover_percent))return point.cloud_cover_percent<15?['sun','맑음 추정']:point.cloud_cover_percent<70?['partly','구름 추정']:['cloud','흐림 추정'];
  return ['unknown','정보 없음'];
}
export const PSU_REPORTS = [['availability','시설 가용 현황 보고'],['arrival_hold','도착 순서 조정 요청'],['restriction','시설 제한 통보'],['reopen','운영 재개 통보']];
export function reportDraft(record,kind,resource,reason,now) {
  if(!PSU_REPORTS.some(([id])=>id===kind))throw new Error('지원하지 않는 보고 종류');
  return {vertiport_id:record.id,recipient:'서울 PSU',kind,resource_id:resource?.key??null,reason:reason.slice(0,240),
    created_at:now,status:'local_draft',scope:'rehearsal',label:PSU_REPORTS.find(([id])=>id===kind)[1]};
}
