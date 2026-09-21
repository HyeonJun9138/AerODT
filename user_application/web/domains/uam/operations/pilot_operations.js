import {buildElement} from '../../../dom_builder.js';
import {describePilotDecision} from './pilot_decision.js';

const STAGES={gate_out:'출발 이동',takeoff:'이륙',climb:'상승',cruise:'순항',descent:'접근',
  landing:'착륙',gate_in:'도착 이동',charge:'정비',parked:'주기',hold:'대기'};
const finite=(value,unit='')=>Number.isFinite(value)?`${value.toLocaleString('ko-KR',{maximumFractionDigits:1})}${unit}`:'—';
const clock=value=>Number.isFinite(value)?`${String(Math.floor(value/3600)%24).padStart(2,'0')}:${String(Math.floor(value/60)%60).padStart(2,'0')}:${String(Math.floor(value)%60).padStart(2,'0')}`:'—';

export class PilotOperations {
  constructor({api,document=globalThis.document,onUpdate=()=>{}}) {Object.assign(this,{api,document,onUpdate});this.generation=0;this.views=new Map();}
  el(tag,props={},...children){return buildElement(this.document,tag,props,...children);}
  render(body){this.stop();this.mount(body);}
  mount(body,{summary=false}={}){
    const e=this.el.bind(this),view={body,summary,key:null};
    body.setAttribute('class',`pilot-operations${summary?' pilot-summary':''}`);
    view.status=e('span',{class:'po-clock',text:'연결 중'});
    view.select=e('select',{'aria-label':'조종할 기체 조회',onchange:()=>{this.selected=view.select.value;this.paint();}});
    view.content=e('div',{class:'po-flight'});
    body.replaceChildren(e('div',{class:'po-heading'},e('strong',{text:summary?'운항 요약':'기체별 운항 지시'}),view.status),
      e('label',{class:'po-selector'},e('span',{text:'관찰 기체'}),view.select),view.content);
    this.views.set(body,view);this.body=body;this.paint();
    if(!this.timer){const token=this.generation;void this.read(token);
      this.timer=setInterval(()=>{if(!this.document.hidden)void this.read(token);},1200);this.timer?.unref?.();}
  }
  unmount(body){this.views.delete(body);this.body=this.views.keys().next().value??null;if(!this.body)this.stop();}
  stop(){this.generation++;clearInterval(this.timer);this.timer=null;this.views.clear();this.body=null;this.busy=false;}
  async read(token){
    if(this.busy||!this.body||typeof this.api!=='function')return;
    this.busy=true;
    try{const data=await this.api();if(token!==this.generation||!this.body)return;this.data=data;this.error='';this.paint();}
    catch{if(token===this.generation&&this.body){this.data=null;this.error='연결 지연 · 최신 지시를 확인하지 못했습니다';this.paint();}}
    finally{if(token===this.generation)this.busy=false;}
  }
  paint(){for(const view of this.views.values())this.paintView(view);this.onUpdate(this.data,this.error);}
  paintView(view){
    const e=this.el.bind(this),rows=this.data?.aircraft??[];
    view.status.textContent=this.error||`${this.data?.source==='physical'?'Physical · ':''}${this.data?.clock??'—'}${this.data?.stale?' · 수신 지연':''} · ${this.data?.state==='playing'?'운용 중':'대기'}`;
    if(!this.error&&this.data&&!rows.some(row=>row.aircraft_id===this.selected))this.selected=rows[0]?.aircraft_id;
    const key=rows.map(row=>`${row.aircraft_id}:${row.flight_id}`).join('|');
    if(key!==view.key){view.key=key;view.select.replaceChildren(...rows.map(row=>e('option',{
      value:row.aircraft_id,text:`${row.aircraft_id} · ${row.flight_id}`})));}
    view.select.value=this.selected??'';
    const row=rows.find(row=>row.aircraft_id===this.selected);
    if(!row){view.content.replaceChildren(e('p',{class:'po-empty',text:this.error||'다중 비행을 시작하면 기체별 허가·교통·진행 상태가 표시됩니다.'}));return;}
    const c=row.clearance??{},instruction=row.instruction??{},decision=describePilotDecision({state:row});
    const ground=['parked','gate_out','gate_in','charge'].includes(row.phase);
    // The common projection filters historical ground/air instructions and
    // keeps actual traffic responses ahead of a general PSU permission.
    const permission=decision.fields.some(field=>field.key==='clearance')
      ?({hold:'대기 유지',approach:'접근 시작',land:'최종 착륙'}[instruction.clearance]):null;
    const usePsu=permission&&decision.source==='PSU';
    const diagnostics=decision.fields.filter(field=>
      ['blocked_by','traffic_id','planned_stand','assigned_stand','gate_reason','guidance'].includes(field.key)
      ||!view.summary&&['gate_revision','distance_m','stop_distance_m','route_id','updated_s'].includes(field.key));
    const metrics=[['고도',finite(row.altitude_m,' m')],['속력',finite(row.speed_mps,' m/s')],
      [ground?'지상 대기':'체공',finite(ground?instruction.wait_seconds:row.hold_seconds,' s')],['착륙 번호',c.sequence?`#${c.sequence}`:'—']];
    view.content.replaceChildren(...[
      e('div',{class:'po-route'},e('b',{text:row.origin??'—'}),e('span',{text:'→'}),e('b',{text:row.destination??'—'}),
        e('span',{class:'po-phase',text:ground?decision.title:STAGES[row.phase]??decision.title})),
      e('div',{class:'po-metrics'},...(view.summary?metrics.slice(0,2):metrics).map(([label,value])=>e('div',{},e('small',{text:label}),e('b',{text:value})))),
      e('section',{class:'po-clearance','data-state':ground?instruction.action??'ground':decision.waiting?'hold':instruction.clearance??'enroute','data-level':decision.level},
        e('small',{text:usePsu?'PSU 지시':decision.source}),e('strong',{text:usePsu?permission:decision.title}),
        e('p',{text:usePsu?(instruction.clearance_reason??c.reason??decision.reason):decision.reason}),
        ...(!usePsu&&permission?[e('p',{class:'po-permission',text:`PSU 지시: ${permission} · ${instruction.clearance_reason??c.reason??'상세 사유 미제공'}`})]:[]),
        ...diagnostics.map(field=>e('p',{class:'po-diagnostic',text:`${field.label}: ${field.value}`})),
        ...(!ground&&!view.summary?[e('div',{class:'po-times'},e('span',{text:`접근 가능 ${clock(c.approach_s)}`}),e('span',{text:`도착 ETA ${clock(c.eta_s)}`}),
          e('span',{text:`착륙 슬롯 ${clock(c.cleared_s)}`}))]:[])),
      view.summary||ground?null:e('section',{class:'po-traffic','data-alert':String(Boolean(instruction.traffic_id))},
        e('small',{text:'주변 교통 / 조종사 대응'}),e('strong',{text:instruction.reason??'예상 근접 없음'}),
        e('p',{text:instruction.traffic_id?`${instruction.traffic_id} · 최근접 ${finite(instruction.cpa_s,'초')} 후 · ${finite(instruction.miss_m,' m')}`:'현재 관측 속도로 짧은 구간을 예측합니다.'}),
        e('div',{class:'po-times'},e('span',{text:`우측 지시 ${finite(instruction.right_m??0,' m')}`}),
          e('span',{text:`속도 계수 ${finite(instruction.speed_factor??1)}`}))),
      view.summary?null:e('p',{class:'po-note',text:this.data?.source==='physical'?'Physical에서 실제 생성한 허가·회피·지상 지시입니다.':'허가·회피는 시뮬레이션 조종 의도입니다. 표시 수치는 관측 상태와 최근 지시를 사용합니다.'})].filter(Boolean));
  }
}
