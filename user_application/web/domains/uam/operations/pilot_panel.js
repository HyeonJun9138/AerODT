// User/Application: pilot clearances, traffic advisories and operating speeds.
// Route geometry and actual motion remain owned by the assigned mission and physics.
//
// The numbers are in knots and feet per minute because that is what they mean
// to whoever sets them. The panel shows what each one comes to in metres a
// second underneath, so the same value can be read in the units the rest of the
// twin works in without anybody converting in their head.
//
// It owns nothing. The server holds the profile, this draws it and sends back
// what changed.
import {buildElement} from '../../../dom_builder.js';
import {PilotOperations} from './pilot_operations.js?v=20260911-workspace';

const number = value => Number(value ?? 0).toLocaleString('ko-KR',
  {minimumFractionDigits: 0, maximumFractionDigits: 2});

export class PilotPanel {
  constructor({api, document = globalThis.document, notify = () => {}, onOpen = () => {}, onDecisions = null, onRisk = () => {}}) {
    Object.assign(this, {api, document, notify, onOpen, onDecisions, onRisk});
    this.operations = new PilotOperations({api:api.operations,document,onUpdate:(data,error)=>{if(this.consoleClock)this.consoleClock.textContent=error?'수신 지연':data?.clock?`${data.source==='physical'?'Physical':'시뮬레이션'} ${data.clock}${data.stale?' · 지연':''}`:'재생 대기';}});
    this.described = null; this.body = null; this.draft = {}; this.busy = false; this.ready = Promise.resolve();
  }
  el(tag, props = {}, ...children) {return buildElement(this.document, tag, props, ...children);}

  render(body) {
    this.deactivate();this.body=body;
    const e=this.el.bind(this);
    this.launch=e('button',{type:'button',class:'stakeholder-launch',text:'조종사 Control Panel 열기 ↗',onclick:()=>this.open()});
    this.sideOperations=e('section',{'aria-label':'조종사 운항 요약'});
    body.replaceChildren(e('div',{class:'stakeholder-summary'},this.launch,this.sideOperations,
      e('button',{type:'button',class:'stakeholder-launch',text:'주변 교통 레이더 ↗',onclick:()=>this.onRisk(this.operations.selected)}),
      e('p',{class:'ops-note',text:'상세 허가·교통 정보와 운항 파라미터는 Control Panel에서 확인합니다.'})));
    if(this.api.operations)this.operations.mount(this.sideOperations,{summary:true});
    this.ready=this.described?Promise.resolve(this.described):(this.loading??this.load());
    return this.ready;
  }
  deactivate() {if(this.sideOperations)this.operations.unmount(this.sideOperations);this.sideOperations=null;this.body=null;}
  destroy() {this.dead=true;this.deactivate();this.close();this.described=null;}
  async load() {
    const pending=(async()=>{
      try {const described=await this.api.read();if(this.dead)return null;
        this.described=described;this.error='';this.draw();return described;
      } catch {if(!this.dead){this.error='운항 속도를 불러오지 못했습니다.';this.draw();}return null;}
      finally{this.loading=null;}
    })();this.loading=pending;return pending;
  }
  open(){
    this.onOpen();if(this.console){if(this.collapsed)this.fold();return;}
    const e=this.el.bind(this);this.collapsed=false;
    this.console=e('section',{class:'stakeholder-console pilot-console','aria-label':'조종사 운영 컨트롤','data-expanded':String(Boolean(this.expanded))});
    this.consoleClock=e('span',{class:'stakeholder-clock',text:'기체별 실시간 관측'});
    this.expandButton=e('button',{type:'button',class:'stakeholder-size-button','aria-label':'조종사 화면 크기 전환',text:this.expanded?'기본 크기':'넓게 보기',onclick:()=>{this.expanded=!this.expanded;this.console.setAttribute('data-expanded',String(this.expanded));this.expandButton.textContent=this.expanded?'기본 크기':'넓게 보기';}});
    this.foldButton=e('button',{type:'button',class:'ops-icon','aria-label':'조종사 컨트롤 접기','aria-expanded':'true',onclick:()=>this.fold()},e('span',{class:'ops-chevron','aria-hidden':'true'}));
    const close=e('button',{type:'button',class:'ops-icon',text:'×','aria-label':'조종사 컨트롤 닫기',onclick:()=>this.close()});
    this.console.append(e('header',{class:'stakeholder-console-header'},e('div',{},e('small',{text:'PILOT OPERATIONS'}),e('h2',{text:'조종사 Control Panel'})),this.consoleClock,e('button',{type:'button',class:'stakeholder-size-button',text:'주변 레이더',onclick:()=>this.onRisk(this.operations.selected)}),this.expandButton,this.foldButton,close));
    this.detailOperations=e('section',{'aria-label':'기체별 운항 지시'});this.settingsHost=e('section',{class:'pilot-profile'});
    this.consoleBody=e('div',{class:'pilot-console-body'},this.detailOperations,this.settingsHost);
    this.console.append(this.consoleBody);this.document.body.append(this.console);this.document.body.setAttribute('data-pilot-console','true');
    this.console.onkeydown=event=>{if(event.key==='Escape'){event.stopPropagation();if(!this.collapsed)this.fold();else this.close();}};
    if(this.api.operations)this.operations.mount(this.detailOperations);this.draw();this.foldButton.focus?.();
  }
  fold(){this.collapsed=!this.collapsed;this.consoleBody.hidden=this.collapsed;this.consoleBody.inert=this.collapsed;
    this.console.setAttribute('data-collapsed',String(this.collapsed));this.foldButton.setAttribute('aria-expanded',String(!this.collapsed));
    this.foldButton.setAttribute('aria-label',this.collapsed?'조종사 컨트롤 펼치기':'조종사 컨트롤 접기');}
  close(){if(this.detailOperations)this.operations.unmount(this.detailOperations);this.detailOperations=null;
    this.console?.remove();this.console=null;this.settingsHost=null;this.document.body.removeAttribute('data-pilot-console');this.launch?.focus?.();}

  // What is on screen now: the stored value unless the operator has typed over it.
  valueOf(name) {
    const typed = this.described?.read_only ? undefined : this.draft[name];
    if (typed !== undefined && typed !== '') return Number(typed);
    return Number(this.described?.values?.[name] ?? 0);
  }
  get changed() {
    return Object.keys(this.draft).some(name =>
      Number(this.draft[name]) !== Number(this.described?.values?.[name]));
  }

  set(name, value) {
    this.draft = {...this.draft, [name]: value};
    this.paintDerived();
    this.paintActions();
  }

  async save() {
    if (this.busy || !this.changed || this.described?.read_only) return null;
    this.busy = true; this.paintActions();
    const values = {};
    for (const name of Object.keys(this.draft)) values[name] = Number(this.draft[name]);
    try {
      this.described = await this.api.write(values);
      this.draft = {};
      this.notify('ok', '운항 속도를 적용했습니다. 이후 만드는 비행 계획에 적용됩니다.');
      this.draw();
      return this.described;
    } catch (error) {
      this.notify('error', error?.message ?? '운항 속도를 저장하지 못했습니다.');
      return null;
    } finally {
      this.busy = false; this.paintActions();
    }
  }
  async reset() {
    if (this.busy || this.described?.read_only) return null;
    this.busy = true; this.paintActions();
    try {
      this.described = await this.api.reset();
      this.draft = {};
      this.notify('ok', '기본값으로 되돌렸습니다.');
      this.draw();
      return this.described;
    } catch (error) {
      this.notify('error', error?.message ?? '되돌리지 못했습니다.');
      return null;
    } finally {
      this.busy = false; this.paintActions();
    }
  }

  // ---- drawing -----------------------------------------------------------
  draw() {
    const body = this.settingsHost;
    if (!body) return;
    body.textContent = '';
    if(this.onDecisions)body.append(this.el('button',{type:'button',class:'stakeholder-chart',text:'의사결정 차트 ↗',onclick:()=>this.onDecisions()}));
    const settings=this.el('details',{class:'pilot-settings',open:'open'},this.el('summary',{text:'운항 파라미터 · 계획 속도'}));
    body.append(settings);
    const fieldsBody=this.el('div',{});settings.append(fieldsBody);
    fieldsBody.append(this.el('h3', {class: 'sim-heading', id: 'pilot-title', text: '운항 속도'}));
    if (this.error) {
      fieldsBody.append(this.el('p', {class: 'sim-error', id: 'pilot-error', text: this.error}));
      return;
    }
    if (!this.described) {
      fieldsBody.append(this.el('p', {class: 'sim-empty', id: 'pilot-loading', text: '불러오는 중입니다...'}));
      return;
    }
    fieldsBody.append(this.el('p', {class: 'pilot-source', id: 'pilot-source', text: this.described.source}));
    fieldsBody.append(this.el('p', {class: 'pilot-note', id: 'pilot-not-taken', text: this.described.not_taken}));
    fieldsBody.append(this.fields());
    fieldsBody.append(this.phases());
    fieldsBody.append(this.actions());
  }

  fields() {
    const list = this.el('div', {class: 'pilot-fields', id: 'pilot-fields'});
    this.inputs = new Map();
    const groups=new Map();
    for (const field of this.described.fields ?? []) {
      const title=field.name.startsWith('taxi_')?'지상 이동':field.name.includes('vertical')?'이륙 · 착륙':'순항 · 천이';
      if(!groups.has(title)){const group=this.el('fieldset',{class:'pilot-group'},this.el('legend',{text:title}));groups.set(title,group);list.append(group);}
      const input = this.el('input', {type: 'number', id: `pilot-${field.name}`,
        value: String(this.valueOf(field.name)), min: String(field.min), max: String(field.max),
        step: String(field.step), oninput: event => this.set(field.name, event.target.value)});
      input.disabled=Boolean(this.described?.read_only);this.inputs.set(field.name, input);
      const label = this.el('div', {class: 'pilot-label'},
        this.el('strong', {text: field.label}),
        this.el('span', {class: 'pilot-unit', text: field.unit}),
        // The one number that is ours rather than the operating figures'.
        field.ours ? this.el('span', {class: 'pilot-ours', text: '기체 값'}) : null);
      groups.get(title).append(this.el('label', {class: 'pilot-field', 'data-name': field.name},
        label, input,
        field.note ? this.el('small', {class: 'pilot-hint', text: field.note}) : null));
    }
    return list;
  }

  // The same numbers, read as the twin reads them, so nobody converts in their head.
  phases() {
    this.phaseList = this.el('ul', {class: 'pilot-phases', id: 'pilot-phases'});
    this.paintPhases();
    return this.el('div', {class: 'pilot-block'},
      this.el('h4', {class: 'pilot-subheading', text: '비행 단계별 속도'}),
      this.phaseList);
  }
  paintPhases() {
    if (!this.phaseList) return;
    this.phaseList.textContent = '';
    for (const row of this.described?.phases ?? []) {
      this.phaseList.append(this.el('li', {class: 'pilot-phase', 'data-phase': row.phase},
        this.el('span', {text: row.label}),
        this.el('b', {text: row.phase === 'takeoff' || row.phase === 'landing'
          ? `${number(row.fpm)} ft/min` : `${number(row.knots)} kt`}),
        this.el('small', {text: `${number(row.mps)} m/s`})));
    }
  }
  // What the two numbers above come to, updated as they are typed rather than
  // only after they are applied: the transition speed is a multiple of a value
  // the pilot is editing, so it should move with it.
  paintDerived() {
    if (!this.derivedNode) return;
    const stall = this.valueOf('stall_kt'), factor = this.valueOf('transition_factor');
    this.derivedNode.textContent =
      `천이 속도 ${number(stall * factor)} kt · 순항 ${number(this.valueOf('cruise_kt') * 0.514444)} m/s`;
  }

  actions() {
    this.derivedNode = this.el('span', {class: 'pilot-derived', id: 'pilot-derived'});
    this.paintDerived();
    this.applyButton = this.el('button', {type: 'button', class: 'pilot-apply', id: 'pilot-apply',
      text: '적용', onclick: () => void this.save()});
    this.resetButton = this.el('button', {type: 'button', id: 'pilot-reset',
      text: '기본값', onclick: () => void this.reset()});
    this.paintActions();
    return this.el('div', {class: 'pilot-actions'}, this.derivedNode,
      this.el('div', {class: 'pilot-buttons'}, this.applyButton, this.resetButton));
  }
  paintActions() {
    if (!this.applyButton) return;
    const blocked = this.busy || !this.changed;
    this.applyButton.disabled = blocked || Boolean(this.described?.read_only);
    this.applyButton.textContent = this.busy ? '적용 중...' : '적용';
    if (this.resetButton) this.resetButton.disabled = this.busy || Boolean(this.described?.read_only);
  }
}
