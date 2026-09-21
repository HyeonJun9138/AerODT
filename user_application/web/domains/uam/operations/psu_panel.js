import {buildElement} from '../../../dom_builder.js';
import {roleCard} from './operations_session.js';
import {PsuOperations,operationTotals,rankedDecks} from './psu_operations.js?v=20260911-workspace';
export const REQUEST_NAMES={arrival:'접근 요청',departure:'출발 요청',facility_report:'시설 보고'};
export const DECISIONS={pending:'검토 대기',hold:'대기 요청',proceed:'진행 응답',resequence:'순서 조정',rejected:'보류 종료',acknowledged:'보고 확인'};
const terminal=r=>['proceed','rejected','acknowledged'].includes(r.state);
const time=s=>new Date(s*1000).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false});

export class PsuPanel {
  constructor({document=globalThis.document,session,api={},onOpen=()=>{},onFocus=()=>{},onFocusDeck=()=>{},onDecisions=null,deckView=null}={}){
    Object.assign(this,{document,session,api,onOpen,onFocus,onFocusDeck,onDecisions,deckView});
    this.deckId=null;this.filter='active';this.facility='';this.selected=null;this.collapsed=false;
    // Every deck at once, from the day being flown. The PSU is the one party
    // watching all of them, and this is the same server answer each vertiport
    // operator is reading for their own deck - so the two are never looking at
    // different pictures of the same landing.
    this.decks=null;this.decksBusy=false;this.decksError='';this.receivedAt=0;this.workspace='live';this.expanded=false;
    this.unsubscribe=session.subscribe(()=>this.update());
  }
  async readDecks(){
    if(this.disposed||this.decksBusy||typeof this.api.scenarioVertiports!=='function')return;
    this.decksBusy=true;
    try{const data=await this.api.scenarioVertiports();if(this.disposed)return;this.decks=data;this.decksError='';this.receivedAt=Date.now();}
    catch{if(!this.disposed)this.decksError='수신 지연';}
    finally{this.decksBusy=false;if(!this.disposed)this.update();}
  }
  startDecks(){
    if(this.deckTimer)return;
    void this.readDecks();
    this.deckTimer=setInterval(()=>{if(!this.document.hidden&&(this.side||this.console))void this.readDecks();},3000);
    this.deckTimer?.unref?.();
  }
  el(tag,props={},...children){return buildElement(this.document,tag,props,...children);}
  button(text,onclick,props={}){return this.el('button',{type:'button',text,onclick,...props});}
  get requests(){return this.session.data?.requests??[];}
  get request(){return this.requests.find(r=>r.id===this.selected);}
  get canAct(){return this.session.online&&this.session.member?.role==='psu'&&!this.session.mutating;}
  render(body){
    this.side=body;body.textContent='';const e=this.el.bind(this);
    this.summary=e('div',{class:'psu-side-metrics'});
    this.deckTag=e('span',{class:'ops-tag'});this.decksNode=e('div',{class:'psu-side-hotspots'});
    this.liveNode=e('p',{class:'ops-note'});this.sideNote=e('p',{class:'ops-note'});
    this.practiceCount=e('span',{class:'ops-tag'});
    body.append(e('div',{class:'ops-workspace psu-summary'},
      this.button('PSU Control Panel 열기 ↗',()=>this.open(),{class:'stakeholder-launch'}),
      e('div',{class:'psu-side-heading'},e('strong',{text:'운항 요약'}),this.deckTag),this.summary,
      e('section',{class:'psu-side-priority'},e('div',{class:'ops-heading'},e('strong',{text:'먼저 확인할 버티포트'}),e('span',{class:'ops-tag',text:'상위 3곳'})),this.decksNode),
      this.sideNote,
      this.button('전체 흐름 · 데크 · 기체 지시 보기',()=>this.open(),{class:'psu-side-link'}),
      e('div',{class:'psu-side-footer'},this.liveNode,this.button('공유 운영 연습',()=>this.open('practice'),{class:'psu-side-link'}),this.practiceCount)));
    this.startDecks();this.update();
  }
  deactivate(){this.side=null;if(!this.console)this.deckView?.stop();}
  observe(snapshot){this.live={at:snapshot.state_time,count:snapshot.entities.filter(r=>r.kind==='aircraft').length};this.liveReceived=Date.now();if(this.liveNode)this.drawLive();}
  drawLive(){if(!this.liveNode)return;this.liveNode.textContent=this.live?`공유 Live 표본 ${time(this.live.at)} KST · 항공기 ${this.live.count}대${Date.now()-this.liveReceived>15000?' · 수신 지연':''}`:'Live 표본 수신 대기 · 예시 요청과 실제 항적은 별개';}
  drawDecks(){
    if(!this.side||!this.decksNode)return;
    const e=this.el.bind(this),facilities=this.decks?.facilities??this.session.data?.facilities??{},sum=operationTotals(this.decks);
    this.deckTag.textContent=this.decksError?'수신 지연':this.decks?`${this.decks.source==='physical'?'Physical':'시뮬레이션'} ${this.decks.clock}${this.decks.stale?' · 지연':''}`:'재생 대기';
    this.summary.replaceChildren(...[['착륙 대기',sum.holding],['접근 진행',sum.approach],['최종 착륙',sum.final]].map(([text,n])=>
      e('div',{},e('strong',{text:this.decks?n:'—'}),e('span',{text}))));
    const rows=rankedDecks(this.decks).slice(0,3);
    this.decksNode.replaceChildren(...(rows.length?rows.map(row=>
      this.button('',()=>this.openDeck(row.vertiport_id),{class:'psu-side-port','aria-pressed':String(this.deckId===row.vertiport_id),
        onclick:()=>this.openDeck(row.vertiport_id)})).map((button,index)=>{
          const row=rows[index];button.append(e('strong',{text:facilities[row.vertiport_id]??row.vertiport_id}),
            e('span',{text:row.holding?`대기 ${row.holding}대`:`도착편 ${row.inbound??0}대`,'data-waiting':String(row.holding>0)}));return button;
        }):[e('p',{class:'ops-note',text:'비행계획을 열면 운항 요약이 표시됩니다.'})]));
    this.sideNote.textContent=this.decksError?'연결 지연으로 최근 확인한 상태를 표시합니다.':this.decks
      ?`운용 ${sum.decks}곳 · 대기 발생 ${sum.attention}곳 · 주기 ${sum.standing}대`:'Control Panel에서 실제 비행과 공유 운영 연습을 볼 수 있습니다.';
    this.practiceCount.textContent=`미처리 ${this.requests.filter(r=>!terminal(r)).length}건`;
  }
  openDeck(id){
    if(id)this.onFocusDeck(id);
    const next=this.deckId===id?null:id;
    this.deckId=next;
    if(this.side&&!this.console)this.open();
    if(this.operations)this.setWorkspace('live');
    else if(this.deckView&&this.deckHost){if(next)void this.deckView.open(next);else this.deckView.close();}
    this.drawDecks();
  }
  update(){
    this.role?.update();this.drawLive();this.drawDecks();const e=this.el.bind(this),data=this.session.data,facilities=data?.facilities??{};
    if(this.console){
      this.clock.textContent=this.workspace==='live'?(this.decksError?'수신 지연':this.decks?`${this.decks.source==='physical'?'Physical':'시뮬레이션'} ${this.decks.clock}${this.decks.stale?' · 지연':''}`:'재생 대기'):(data?`${time(data.server_time)} KST · ${this.session.online?'연결':'연결 끊김'}`:'연결 대기');
      if(this.workspace==='live'&&!this.collapsed)this.operations.update(this.decks,this.decks?.facilities??facilities,{deckId:this.deckId,error:this.decksError,receivedAt:this.receivedAt});
      this.seed.disabled=!this.canAct;
      const facilityKey=JSON.stringify(facilities);if(facilityKey!==this.facilityKey){this.facilityKey=facilityKey;
        this.facilitySelect.replaceChildren(e('option',{value:'',text:'전체 시설'}),...Object.entries(facilities).map(([value,text])=>e('option',{value,text})));this.facilitySelect.value=this.facility;}
      const queueKey=JSON.stringify([this.requests,this.selected,facilities,this.filter,this.facility]);if(queueKey!==this.consoleQueueKey){this.consoleQueueKey=queueKey;
        const rows=this.requests.filter(r=>(this.filter==='all'||(this.filter==='active'?!terminal(r):r.state===this.filter))&&(!this.facility||r.facility_id===this.facility));
        const scroll=this.consoleQueue.scrollTop;this.consoleQueue.replaceChildren(...(rows.length?rows.map(r=>this.row(r)):[e('p',{class:'ops-note',text:'조건에 맞는 연습 요청이 없습니다.'})]));this.consoleQueue.scrollTop=scroll;}
      const signature=JSON.stringify([this.request,this.canAct,this.session.error]);if(signature!==this.detailKey){this.detailKey=signature;this.drawDetail();}
      this.history.replaceChildren(...(data?.history??[]).slice(0,20).map(h=>e('div',{class:'ops-history-row'},e('time',{text:time(h.at)}),e('strong',{text:h.callsign}),e('span',{text:`${DECISIONS[h.action]} / ${h.author}`}))));
    }
  }
  row(r){const e=this.el.bind(this),button=this.button('',()=>this.choose(r.id),{class:'ops-request','aria-pressed':String(this.selected===r.id),'data-state':r.state});
    button.append(e('time',{text:time(r.created_at)}),e('strong',{text:r.callsign}),e('span',{text:this.session.data?.facilities[r.facility_id]??r.facility_id}),e('small',{text:DECISIONS[r.state]}));return button;}
  choose(id){this.selected=id;this.detailKey=null;if(!this.console)this.open('practice');else{this.setWorkspace('practice');this.update();}}
  open(workspace='live'){
    this.onOpen();this.workspace=workspace;if(this.console){this.collapsed=false;this.setWorkspace(workspace);this.foldState();this.update();return;}
    if(!this.selected)this.selected=this.requests.find(r=>!terminal(r))?.id??this.requests[0]?.id;
    const e=this.el.bind(this);this.clock=e('span',{class:'ops-note'});
    this.foldButton=this.button('',()=>{this.collapsed=!this.collapsed;this.foldState();},{class:'ops-icon','aria-label':'PSU 컨트롤 접기','aria-expanded':'true'});
    this.foldButton.append(e('span',{class:'ops-chevron','aria-hidden':'true'}));
    this.seed=this.button('공유 예시 요청 추가',()=>void this.session.action('/examples'),{class:'ops-secondary'});
    this.consoleQueue=e('div',{class:'ops-console-queue'});this.detail=e('section',{class:'ops-detail'});this.history=e('div',{class:'ops-history'});
    this.facilityKey=null;
    this.facilitySelect=e('select',{'aria-label':'연습 요청 시설',onchange:event=>{this.facility=event.target.value;this.update();}});
    this.requestFilter=e('select',{'aria-label':'연습 요청 상태',onchange:event=>{this.filter=event.target.value;this.update();}},
      ...[['active','미처리'],['all','전체 요청'],['pending','검토 대기'],['hold','대기 요청']].map(([value,text])=>e('option',{value,text})));
    this.requestFilter.value=this.filter;
    this.rehearsalGrid=e('div',{class:'ops-console-body'},e('section',{},e('div',{class:'ops-heading'},e('strong',{text:'01 요청 선택'}),this.seed),
      e('div',{class:'psu-practice-filters'},this.facilitySelect,this.requestFilter),this.consoleQueue),
      this.detail,e('section',{class:'ops-history-section'},e('div',{class:'ops-heading'},e('strong',{text:'03 공유 처리 이력'})),this.history,
      e('p',{class:'ops-note',text:'모든 응답은 연습 기록입니다. 실제 조종사·기체로 전달되지 않습니다.'})));
    this.role=roleCard(this.document,this.session,'psu');
    this.practice=e('div',{class:'psu-practice',role:'tabpanel','aria-label':'공유 운영 연습'},this.role.node,this.rehearsalGrid);
    this.liveHost=e('div',{class:'psu-live-workspace',role:'tabpanel','aria-label':'실제 운항 관제'});
    this.operations=new PsuOperations({document:this.document,deckView:this.deckView,onDeck:id=>this.openDeck(id),onFlight:row=>this.onFocus(row)});
    this.operations.render(this.liveHost);
    this.liveTab=this.button('운항 관제',()=>this.setWorkspace('live'),{role:'tab'});
    this.practiceTab=this.button('공유 운영 연습',()=>this.setWorkspace('practice'),{role:'tab'});
    this.body=e('div',{class:'psu-console-content'},e('div',{class:'psu-workspace-nav'},
      e('div',{class:'psu-workspace-tabs',role:'tablist','aria-label':'PSU 운영 영역'},this.liveTab,this.practiceTab),
      this.onDecisions?this.button('의사결정 차트 ↗',()=>this.onDecisions(),{class:'psu-chart-link'}):null),this.liveHost,this.practice);
    this.expandButton=this.button('넓게 보기',()=>{this.expanded=!this.expanded;this.console.setAttribute('data-expanded',String(this.expanded));this.expandButton.textContent=this.expanded?'기본 크기':'넓게 보기';this.measure();},{class:'psu-size-button','aria-label':'PSU 화면 크기 전환'});
    this.console=e('section',{class:'ops-console psu-control','aria-label':'PSU 운영 컨트롤','data-expanded':String(this.expanded)},
      e('header',{class:'ops-console-header stakeholder-console-header'},e('div',{},e('small',{text:'NETWORK OPERATIONS'}),e('h2',{text:'PSU Control Panel'})),this.clock,this.expandButton,this.foldButton,
        this.button('×',()=>this.close(),{class:'ops-icon','aria-label':'PSU 컨트롤 닫기'})),this.body);
    this.console.onkeydown=event=>{if(event.key==='Escape'){event.stopPropagation();this.collapsed=true;this.foldState();}};
    this.document.body.append(this.console);this.document.body.setAttribute('data-psu-console','true');this.detailKey=null;this.consoleQueueKey=null;
    const Observer=this.document.defaultView?.ResizeObserver;if(Observer){this.observer=new Observer(()=>this.measure());this.observer.observe(this.console);}
    this.startDecks();this.setWorkspace(workspace);this.update();this.foldState();
  }
  setWorkspace(workspace){
    this.workspace=workspace;if(!this.console)return;const live=workspace==='live';
    this.liveHost.hidden=!live;this.practice.hidden=live;this.liveHost.inert=!live;this.practice.inert=live;
    this.liveTab.setAttribute('aria-selected',String(live));this.practiceTab.setAttribute('aria-selected',String(!live));
    if(!live)this.deckView?.stop();this.update();this.measure();
  }
  drawDetail(){
    const e=this.el.bind(this),r=this.request,oldNote=this.note?.value??'';this.detail.textContent='';
    if(!r){this.detail.append(e('h3',{text:'02 요청 검토'}),e('p',{class:'ops-note',text:'요청을 선택해 검토를 시작하세요.'}));return;}
    this.detail.append(e('div',{class:'ops-heading'},e('strong',{text:'02 요청 검토'}),e('span',{class:'ops-tag',text:DECISIONS[r.state]})),
      e('h3',{text:r.callsign}),e('p',{class:'ops-route',text:`${this.session.data.facilities[r.facility_id]??'삭제된 시설'} / ${REQUEST_NAMES[r.kind]}`}),
      e('p',{class:'ops-note',text:`요청자 ${r.author} · ${time(r.created_at)} KST · v${r.version}`}),e('p',{class:'ops-request-note',text:r.note}),
      e('div',{class:'ops-checks'},...['교통 분리 검증: 미연결','FATO / Gate 수용 검증: 미연결','비행계획 연결: 미연결'].map(text=>e('span',{text}))));
    this.note=e('textarea',{'aria-label':'PSU 응답 사유',maxlength:240,rows:2,placeholder:'대기 사유, 순서 조정 또는 협조 사항'});this.note.value=this.noteFor===r.id?oldNote:'';this.noteFor=r.id;
    this.detail.append(this.note);
    const actions=r.kind==='facility_report'?['acknowledged']:['hold','proceed','resequence','rejected'];
    this.detail.append(e('div',{class:'ops-decisions'},...actions.map(action=>{
      const b=this.button(`${DECISIONS[action]} (연습)`,()=>void this.session.action(`/requests/${r.id}/decision`,{version:r.version,action,note:this.note.value||''}),{'data-action':action});b.disabled=!this.canAct||terminal(r);return b;})));
    if(r.response||r.responder)this.detail.append(e('p',{class:'ops-note',text:`${r.responder}: ${r.response||DECISIONS[r.state]}`}));
    this.detail.append(e('p',{class:'ops-note',role:'status',text:this.session.error||(!this.canAct?'PSU 역할로 입장해야 응답할 수 있습니다.':'다른 운영자의 변경과 충돌하면 최신 요청을 다시 확인합니다.')}));
  }
  foldState(){this.body.hidden=this.collapsed;this.body.inert=this.collapsed;this.foldButton.setAttribute('aria-expanded',String(!this.collapsed));this.foldButton.setAttribute('aria-label',this.collapsed?'PSU 컨트롤 펼치기':'PSU 컨트롤 접기');if(this.collapsed)this.deckView?.stop();else this.update();this.measure();}
  measure(){this.document.body.style?.setProperty?.('--psu-console-height',`${(this.console?.getBoundingClientRect?.().height??0)+10}px`);}
  close(){this.observer?.disconnect();this.operations?.destroy();this.operations=null;this.console?.remove();this.console=null;this.role=null;this.document.body.removeAttribute('data-psu-console');this.document.body.style?.removeProperty?.('--psu-console-height');}
  destroy(){this.disposed=true;this.unsubscribe();clearInterval(this.deckTimer);this.deckTimer=null;this.deckView?.destroy();this.close();this.side=null;}
}
