import {buildElement} from '../../../dom_builder.js';
import {heldRow} from './role_mode.js';

// Session-local credentials and views; all shared rehearsal decisions live on
// the server. No vehicle state or browser playback clock is replicated here.
export class OperationsSession {
  constructor({fetch=globalThis.fetch?.bind(globalThis),now=()=>Date.now()}={}){
    Object.assign(this,{fetch,now});this.listeners=new Set();this.token=null;this.data=null;this.error='';this.online=false;this.dead=false;this.generation=0;
  }
  subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
  emit(){for(const fn of this.listeners)fn(this);}
  start(){if(this.timer)return;void this.refresh();this.timer=setInterval(()=>void this.refresh(),3000);this.timer?.unref?.();}
  async call(path='',body){
    const response=await this.fetch('/api/operations/rehearsal'+path,{method:body===undefined?'GET':'POST',cache:'no-store',
      headers:{'Content-Type':'application/json',...(this.token?{'X-AeroDT-Session':this.token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(7000)});
    if(!response.ok){let message='공유 연습 서버 연결 실패';try{message=(await response.json()).message||message;}catch{}
      if(response.status===401){this.token=null;this.member=null;}throw new Error(response.status===404?'공유 연습 API가 없습니다. 서버 재시작이 필요합니다.':message);}
    return response.json();
  }
  async refresh(){
    if(this.busy||this.dead)return;this.busy=true;const generation=this.generation??0;
    try{const data=await this.call();if(this.dead||generation!==(this.generation??0))return;
      if(!this.data||data.room_id!==this.data.room_id||data.revision>=this.data.revision)this.data=data;
      this.member=data.member;this.online=true;this.received=this.now();this.error=this.actionError||'';
    }catch(e){if(!this.dead){this.online=false;this.error=e.message;}}
    finally{this.busy=false;if(!this.dead)this.emit();}
  }
  async join(role,facility_id,name){
    if(this.mutating)return;this.mutating=true;this.actionError='';++this.generation;
    try{const result=await this.call('/join',{role,facility_id,name});if(this.dead)return;this.token=result.token;this.member=result.member;this.error='';}
    catch(e){this.actionError=this.error=e.message;}finally{this.mutating=false;this.emit();}
    await this.refresh();
  }
  // Giving the seat up. The token goes whatever the server says, so a browser
  // that cannot reach it still stops behaving as the PSU here.
  async leave(){
    if(this.mutating||!this.member)return;this.mutating=true;this.actionError='';++this.generation;
    try{await this.call('/leave',{});this.error='';}
    catch(e){this.actionError=this.error=e.message;}
    finally{this.token=null;this.member=null;this.mutating=false;this.emit();}
    await this.refresh();
  }
  async action(path,body={}){
    if(this.mutating||!this.online||!this.member)return false;this.mutating=true;this.actionError='';this.emit();let success=false;
    try{await this.call(path,body);success=true;this.error='';}catch(e){this.actionError=this.error=e.message;}
    finally{this.mutating=false;this.emit();}
    // Keep a conflict/error visible while refreshing the newer shared version.
    const error=this.error;await this.refresh();if(error){this.error=error;this.emit();}return success;
  }
  destroy(){this.dead=true;clearInterval(this.timer);this.timer=null;this.listeners.clear();this.token=null;}
}

export function roleCard(document,session,role,facility=()=>null){
  session.start?.();
  const e=(tag,props={},...children)=>buildElement(document,tag,props,...children);
  const status=e('p',{class:'ops-note',role:'status'}),roster=e('div',{class:'ops-roster'});
  const name=e('input',{'aria-label':'연습 운영자 이름',placeholder:'내 이름 / 호출명',maxlength:32});
  const button=e('button',{type:'button',text:role==='psu'?'PSU로 입장':'이 버티포트 담당으로 입장',onclick:()=>void session.join(role,facility(),name.value||'운영자')});
  const join=e('div',{class:'ops-join'},name,button);
  // Sitting down and standing up are the same card: one half is showing at a time.
  const held=heldRow(document,session,{onLeave:()=>void session.leave()});
  const node=e('section',{class:'ops-session'},e('div',{class:'ops-heading'},e('strong',{text:'공유 운영 연습'}),e('span',{class:'ops-tag',text:'같은 서버'})),
    join,held.node,status,roster);
  const update=()=>{
    const me=session.member;button.disabled=session.mutating;
    held.update();
    join.hidden=Boolean(me);
    if(me)join.setAttribute('hidden','');else join.removeAttribute('hidden');
    // Only what the card cannot show by itself: a failure, or a connection that
    // has not come up yet, or who you are once you are sitting down. What to do
    // next is the button above; saying it again underneath was noise. The room
    // is kept on the element for anyone diagnosing a shared session.
    status.textContent=session.error||(!session.online?'공유 서버 연결 중…'
      :me?`${me.name} / ${me.role==='psu'?'PSU':session.data?.facilities[me.facility_id]??'버티포트'}`:'');
    status.hidden=!status.textContent;
    if(session.data?.room_id)status.title=`ROOM ${session.data.room_id}`;
    status.dataset.state=session.error?'warning':'normal';
    roster.replaceChildren(...(session.data?.participants??[]).map(p=>e('span',{text:`${p.role==='psu'?'PSU':'VP'} · ${p.name}`,title:p.facility_id?session.data?.facilities[p.facility_id]: '전체 교통 조율'})));
  };update();return {node,update};
}
