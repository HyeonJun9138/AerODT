// User/Application: edit intent -> prepare immutable plan -> execute -> replay.
// Playback consumes recorded states; it does not command a pilot or grant
// traffic clearance. In particular, player pause must never mean airborne hold.
import {buildElement} from '../../../dom_builder.js';
import {clock, metres, readRun, resolvePlan, sampleRun, totalSeconds} from '../../../flight_plan.js';
import {FlightControlBar} from '../../../flight_control_bar.js?v=20260914-single-cockpit';
export {MODE_LABEL, BATTERY_LOW_PCT, BATTERY_CAUTION_PCT, batteryLevel} from '../../../flight_control_bar.js?v=20260914-single-cockpit';

// The player advances on animation frames rather than on a timer: a flight
// stepped ten times a second reads as a stutter however smooth the path is,
// and at ×30 each step would be a jump of half a kilometre. A frame callback
// moves it every frame the map draws instead.
export const SPEEDS = [1, 2, 4, 10, 30];
export const DEFAULT_SPEED = 4;
const CLEAR_NOTE = '현재 계획 선택과 재생을 제거합니다. 저장된 계획·실행 기록은 유지됩니다.';
// The arrivals a departure can actually be flown to, as the server worked out.
export function arrivalsFor(options, departure) {
  const names = new Map((options?.vertiports ?? []).map(item => [item.id, item.name]));
  return (options?.reachable?.[departure] ?? []).map(id => ({id, name: names.get(id) ?? id}));
}

// The first pair the network joins, so the tab opens on something flyable
// instead of asking the operator to hunt for one.
export function firstFlyablePair(options) {
  for (const item of options?.vertiports ?? []) {
    const arrivals = arrivalsFor(options, item.id);
    if (arrivals.length) return {from: item.id, to: arrivals[0].id};
  }
  return null;
}

export class PlanPanel {
  constructor({api, notify = () => {}, document = globalThis.document, onPlan = () => {},
    onSample = () => {}, onFocus = () => {}, onFollow = () => {}, onFocusMode = () => {}, onCockpit = () => {}, onManual = null, onManualStop = () => {}, twinBusy = () => null, controlHost = document.body,
    groundHeights = async () => null, deckTop = () => null, demandPanel = null,
    setTimer = globalThis.requestAnimationFrame?.bind(globalThis),
    clearTimer = globalThis.cancelAnimationFrame?.bind(globalThis),
    now = () => (globalThis.performance?.now?.() ?? Date.now())}) {
    Object.assign(this, {api, notify, document, onPlan, onSample, onFocus, onFollow, onFocusMode, onCockpit, onManual, onManualStop, twinBusy, groundHeights, deckTop,
      demandPanel, setTimer, clearTimer, now});
    // Whether the camera rides with the aircraft, like tracking a live one.
    this.following = false;
    this.controls = new FlightControlBar({document, host: controlHost, actions: {
      toggle: () => this.toggle(), stop: () => this.stop(), dismiss: () => this.clearFlight(),
      seek: time => {this.pause(); this.seek(time);}, scrub: time => this.seek(time),
      skip: delta => this.seek(this.time + delta),
      rate: () => this.setSpeed(SPEEDS[(SPEEDS.indexOf(this.speed) + 1) % SPEEDS.length]),
      // One button steps up and wraps; the right one is the way back to real
      // time without stepping round the whole list to find it.
      resetRate: () => this.setSpeed(SPEEDS[0]),
      follow: () => this.setFollowing(!this.following),
      cockpit: () => {this.setFollowing(true);this.onCockpit();},
      focus: () => {const sample = sampleRun(this.recorded, this.time); if (sample) this.onFocus(sample);},
      // Focus mode is a view, not a camera command: it asks to follow first, so
      // that what is left on the empty screen is the aircraft and not the map.
      focusMode: () => {this.setFollowing(true); this.onFocusMode();},
    }});
    this.options = null; this.plan = null; this.body = null; this.ready = Promise.resolve();
    // What the simulation engine produced and the Data Layer kept: the states
    // this panel plays back. It computes nothing about the flight itself.
    this.run = null; this.recorded = null;
    this.time = 0; this.speed = DEFAULT_SPEED; this.timer = null; this.lastTick = null;
    this.requestEpoch = 0;
  }
  el(tag, props = {}, ...children) {return buildElement(this.document, tag, props, ...children);}

  render(body) {
    if (this.formSlot?.querySelector('[name=from_vertiport]')) this.draft = this.values();
    this.body = body;
    body.textContent = '';
    this.error = this.el('p', {class: 'sim-error', role: 'alert', id: 'plan-error'});
    this.formSlot = this.el('div', {id: 'plan-form-slot'});
    this.formSlot.oninput = this.formSlot.onchange = () => this.invalidatePrepared();
    this.reviewSlot = this.el('div', {id: 'plan-review-slot', 'aria-live': 'polite'});
    this.monitorSlot = this.el('div', {id: 'plan-monitor-slot'});
    this.clearButton = this.el('button', {type: 'button', id: 'plan-clear', class: 'plan-clear',
      text: '계획 취소 · 화면에서 제거', onclick: () => this.clearFlight(), disabled: true});
    this.clearNote = this.el('p', {id: 'plan-clear-note', class: 'route-note', role: 'status',
      text: this.clearMessage ?? CLEAR_NOTE});
    this.single = this.el('div', {id: 'plan-single', role: 'tabpanel', 'aria-labelledby': 'plan-tab-single'});
    // The multi-flight tab is a setup, not a form: which vertiports, how much
    // demand between which of them, when the day runs, which seed and what
    // stands on the decks. Generating the flights from it is asked for; this
    // page neither works them out nor plays them back.
    this.demandSlot = this.el('div', {id: 'demand-slot'});
    this.multi = this.el('div', {id: 'plan-multi', role: 'tabpanel', 'aria-labelledby': 'plan-tab-multi'},
      this.el('h3', {class: 'sim-heading', text: '다중 비행 초기 설정'}),
      this.demandPanel ? this.demandSlot : this.el('p', {class: 'sim-empty',
        text: '여러 기체의 배차와 동시 비행은 준비 중입니다. 지금은 단일 비행에서 한 편씩 생성해 주세요.'}));
    const tabs = this.el('div', {class: 'plan-tabs', role: 'tablist', 'aria-label': '비행 계획 유형'});
    this.tabs = ['single', 'multi'].map((id, i) => this.el('button', {type: 'button', role: 'tab',
      id: `plan-tab-${id}`, 'aria-controls': `plan-${id}`,
      text: i ? (this.demandPanel ? '다중 비행' : '다중 비행 · 준비 중') : '단일 비행',
      onclick: () => this.selectTab(id)}));
    tabs.append(...this.tabs);
    this.single.append(this.el('p', {class: 'sim-empty', id: 'plan-hint',
      text: '계획을 저장하고 검토한 뒤 별도로 실행합니다. Autopilot은 자동 비행 기록 재생, Manual은 실시간 수동 조작입니다.'}),
      this.formSlot, this.el('div', {class: 'plan-clear-actions'}, this.clearButton, this.clearNote),
      this.reviewSlot, this.error, this.monitorSlot);
    body.append(tabs, this.single, this.multi);
    this.selectTab(this.activeTab ?? 'single');
    this.ready = this.load(body);
    return this.ready;
  }
  selectTab(id) {
    this.activeTab = id;
    this.single.hidden = id !== 'single'; this.multi.hidden = id !== 'multi';
    this.tabs.forEach((tab, i) => tab.setAttribute('aria-selected', String((i === 0) === (id === 'single'))));
    // The multi-flight setup draws on the map while it is open; leaving it
    // takes that back rather than leaving a network hanging over the globe.
    if (this.demandPanel) {
      if (id === 'multi') this.demandPanel.render(this.demandSlot);
      else this.demandPanel.deactivate();
    }
    // The detached replay controls remain usable in other editing tabs.
  }
  async load(body) {
    try {
      this.options = await this.api.options();
    } catch {
      this.notify('error', '비행 계획 정보를 불러오지 못했습니다.');
      return;
    }
    if (this.body !== body) return;
    this.drawForm();
    // A plan already made survives a tab switch, so the monitor comes back with it.
    if (this.plan) this.drawMonitor();
  }
  // Closing an editor is not stopping the independent flight replay.
  deactivate() {
    if (this.formSlot?.querySelector('[name=from_vertiport]')) this.draft = this.values();
    this.demandPanel?.deactivate();
    this.body = null;
  }

  // ---- choosing the flight ---------------------------------------------
  drawForm() {
    const options = this.options;
    const places = options?.vertiports ?? [];
    const pair = firstFlyablePair(options);
    this.formSlot.textContent = '';
    if (!pair) {
      this.formSlot.append(this.el('p', {class: 'sim-empty', id: 'plan-no-pair',
        text: '항로로 이어진 버티포트 쌍이 아직 없습니다. 항로 탭에서 두 버티포트의 FATO를 구간으로 이어주세요.'}));
      return;
    }
    const select = (label, name, items, value, onchange) => {
      const node = this.el('select', {name, id: `plan-${name}`, onchange});
      for (const item of items) node.append(this.el('option', {value: item.id, text: item.name ?? item.id,
        selected: item.id === value ? '' : undefined}));
      node.value = value;
      return this.el('label', {for: `plan-${name}`}, this.el('span', {text: label}), node);
    };
    const departures = places.filter(item => arrivalsFor(options, item.id).length);
    this.fromField = select('출발 버티포트', 'from_vertiport', departures, pair.from, () => this.syncArrivals());
    this.toSlot = this.el('div', {id: 'plan-to-slot'});
    const number = (label, name, props) => this.el('label', {for: `plan-${name}`},
      this.el('span', {text: label}), this.el('input', {name, id: `plan-${name}`, type: 'number', ...props}));
    const defaults = options.defaults ?? {};
    const capacity = options.aircraft?.[0]?.passenger_capacity ?? 4;
    const models = options.visual_models ?? [{id: 'projectairsim_airtaxi', name: 'AirTaxi', note: '기준 기체'}];
    const selected = models.some(m => m.id === this.draft?.visual_asset_id) ? this.draft.visual_asset_id : models[0].id;
    this.modelPreview = this.el('div', {class: 'plan-model-preview', id: 'plan-model-preview'});
    const modelField = select('3D 기체 모델', 'visual_asset_id', models, selected, () => this.showModel());
    const section = (title, ...children) => this.el('section', {class: 'plan-section'}, this.el('h3', {text: title}), ...children);
    this.formSlot.append(
      section('01  기체 선택', modelField, this.modelPreview,
        this.el('p', {class: 'plan-dynamics-note', text: '모든 외형은 AirTaxi의 FastPhysics + SimpleFlight를 공통 사용합니다. 기종별 실제 성능이나 인증 모델이 아닙니다. 조종면은 비행 자세 기반의 시각적 추정이며 실제 조종면 계측값이 아닙니다.'})),
      section('02  비행 경로', this.el('div', {class: 'sim-row'}, this.fromField, this.toSlot)),
      section('03  탑승 및 에너지',
      this.el('div', {class: 'sim-row'},
        number(`탑승객 (최대 ${capacity}명)`, 'passengers', {min: '0', max: String(capacity), step: '1', value: String(this.draft?.passengers ?? defaults.passengers ?? 3)}),
        number('출발 배터리 (%)', 'battery_start_pct', {min: '0', max: '100', step: '1', value: String(this.draft?.battery_start_pct ?? defaults.battery_start_pct ?? 100)}))),
      section('04  조작 모드', select('비행 제어', 'control_mode', [{id:'autopilot',name:'Autopilot · 자동 비행'},{id:'manual',name:'Manual · 수동 비행'}], this.controlMode??'autopilot',()=>{this.controlMode=this.formSlot.querySelector('[name=control_mode]').value;this.invalidatePrepared();}),
        this.el('p',{class:'plan-dynamics-note',text:'수동: Z/X 고정익·멀티로터, W/S 출력 증가·감소, Q/E 요잉, 방향키 조종. 평면 지면 접촉만 지원하며 건물 충돌은 판정하지 않습니다.'})),
      this.el('div', {class: 'sim-actions'},
        this.el('button', {type: 'button', class: 'place-confirm', id: 'plan-prepare', text: '계획 저장 · 검토',
          onclick: () => void this.prepare()}),
        this.el('button', {type: 'button', id: 'plan-build', text: '저장된 계획 실행',
          onclick: () => void this.build()})));
    if (departures.some(p => p.id === this.draft?.from_vertiport)) this.fromField.querySelector('select').value = this.draft.from_vertiport;
    this.syncArrivals();
    const arrival = this.toSlot.querySelector('select');
    if (arrivalsFor(options, this.fromField.querySelector('select').value).some(p => p.id === this.draft?.to_vertiport)) arrival.value = this.draft.to_vertiport;
    this.showModel();
    this.invalidatePrepared();
  }
  setAssets(catalog) {
    this.visualAssets = new Map((catalog?.assets ?? []).map(asset => [asset.asset_id, asset]));
    if (this.modelPreview && this.options && this.formSlot) this.showModel();
  }
  showModel() {
    const id = this.formSlot.querySelector('[name=visual_asset_id]')?.value;
    const model = this.options.visual_models?.find(m => m.id === id) ?? {id: 'projectairsim_airtaxi', name: 'AirTaxi', note: '기준 기체'};
    this.modelPreview.textContent = '';
    // Share the library's versioned current-model portrait, never a guessed
    // legacy thumbnail filename. Late catalog arrival refreshes this preview.
    const thumbnail = this.visualAssets?.get(model.id)?.thumbnail;
    if (thumbnail) this.modelPreview.append(this.el('img', {src: thumbnail, alt: model.name, loading: 'lazy', decoding: 'async'}));
    this.modelPreview.append(this.el('div', {}, this.el('strong', {text: model.name}), this.el('p', {text: model.note})));
  }
  // The arrivals depend on the departure, so they are redrawn with it.
  syncArrivals() {
    const from = this.formSlot?.querySelector('[name=from_vertiport]')?.value;
    const arrivals = arrivalsFor(this.options, from);
    const previous = this.toSlot?.querySelector('[name=to_vertiport]')?.value;
    const chosen = arrivals.some(item => item.id === previous) ? previous : arrivals[0]?.id;
    this.toSlot.textContent = '';
    const node = this.el('select', {name: 'to_vertiport', id: 'plan-to_vertiport'});
    for (const item of arrivals) node.append(this.el('option', {value: item.id, text: item.name,
      selected: item.id === chosen ? '' : undefined}));
    node.value = chosen ?? '';
    this.toSlot.append(this.el('label', {}, this.el('span', {text: '도착 버티포트'}), node));
  }
  values() {
    const read = name => this.formSlot?.querySelector(`[name=${name}]`)?.value;
    return {...(this.controlMode==='manual'?{control_mode:'manual'}:{}),from_vertiport: read('from_vertiport'), to_vertiport: read('to_vertiport'),
      passengers: Number(read('passengers')), battery_start_pct: Number(read('battery_start_pct')),
      ...(this.options?.visual_models ? {visual_asset_id: read('visual_asset_id')} : {})};
  }
  invalidatePrepared() {
    if (this.prepared && this.preparedValues !== JSON.stringify(this.values())) this.prepared = null;
    this.showPreparation();
  }
  showPreparation() {
    const prepare = this.formSlot?.querySelector('#plan-prepare');
    const execute = this.formSlot?.querySelector('#plan-build');
    if (prepare) {prepare.disabled = Boolean(this.preparing || this.building); prepare.textContent = this.preparing ? '계획 저장 중…' : '계획 저장 · 검토';}
    if (execute) {execute.disabled = Boolean(!this.prepared || this.preparing || this.building); execute.textContent = this.building ? '실행 준비 중…' : this.controlMode==='manual'?'수동 비행 시작':'저장된 계획 실행';}
    if (this.clearButton) this.clearButton.disabled = !(this.prepared || this.plan || this.preparing || this.building);
    if (!this.reviewSlot) return;
    this.reviewSlot.textContent = '';
    if (!this.prepared) {
      this.reviewSlot.append(this.el('p', {class: 'route-note', text: '먼저 계획을 저장해 주세요. 입력을 수정하면 다시 저장해야 실행할 수 있습니다.'}));
      return;
    }
    const {plan, plan_id} = this.prepared, totals = plan.totals ?? {};
    if(plan.control_mode==='manual'){
      this.reviewSlot.append(this.el('section',{class:'plan-section plan-review'},this.el('h3',{text:'05  수동 비행 계획 검토'}),this.el('p',{text:`${plan.departure?.name??''} ${plan.departure?.gate??''}에서 배치 후 조종석으로 진입합니다. 항로는 참고용이며 자동으로 따라가지 않습니다.`}),this.el('p',{class:'plan-dynamics-note',text:'지상은 방향키 저속 이동(최대 1.5m/s), 공중은 완만한 자세 조종입니다. 수직 비행은 스로틀 10%에서 감속 후 고도 유지, 7~10%에서 하강, 10~13%에서 상승합니다. 0%는 모터 정지입니다. 고정익은 출발면 15m 위에서 가속 후 전환합니다. 창 전환 중에는 입력 보호, 복귀하면 자동 재개, 배터리 부족은 기록만 합니다.'}),this.el('small',{text:`계획 ID: ${plan_id}`})));
      return;
    }
    this.reviewSlot.append(this.el('section', {class: 'plan-section plan-review'},
      this.el('h3', {text: '05  저장된 계획 검토'}),
      this.el('strong', {text: `${plan.departure?.name} ${plan.departure?.gate ?? ''} → ${plan.arrival?.name} ${plan.arrival?.gate ?? ''}`}),
      this.el('p', {text: `탑승 ${plan.vehicle?.passengers ?? 0}명 · 예상 ${clock(totals.duration_s)} · 공중 ${metres(totals.air_distance_m)} · 소모 ${(totals.energy_kwh ?? 0).toFixed(1)} kWh`}),
      this.el('p', {class: 'route-note', text: (plan.legs ?? []).map(leg => leg.stage_label ?? leg.stage).join(' → ')}),
      this.el('small', {class: 'plan-source', text: `계획 ID: ${plan_id}`}),
      this.el('p', {class: 'plan-dynamics-note', text: '허가를 사전 가정한 단일 비행 시나리오입니다. PSU 허가·자원 경합·비행 중 대기 명령은 아직 처리하지 않습니다. 예상 시간과 실제 계산 결과는 다를 수 있습니다.'})));
  }
  async prepare() {
    if (this.destroyed || this.preparing || this.building) return;
    const epoch = this.requestEpoch;
    this.clearMessage = null;
    if (this.clearNote) this.clearNote.textContent = CLEAR_NOTE;
    const values = this.values(), signature = JSON.stringify(values);
    this.preparing = true; this.prepared = null; this.error.textContent = ''; this.showPreparation();
    try {
      const answer = await this.api.prepare(values);
      if (this.destroyed || epoch !== this.requestEpoch) return;
      if (!answer?.plan_id || !answer?.plan) throw new Error('invalid prepared plan');
      if (JSON.stringify(this.values()) !== signature) {
        this.error.textContent = '저장 중 입력이 변경되었습니다. 현재 입력으로 다시 저장해 주세요.';
        return;
      }
      this.prepared = answer; this.preparedValues = signature;
    } catch (failure) {
      if (this.destroyed || epoch !== this.requestEpoch) return;
      this.error.textContent = failure?.data?.message ?? '계획을 저장하지 못했습니다.';
    } finally {
      if (!this.destroyed && epoch === this.requestEpoch) {this.preparing = false; this.showPreparation();}
    }
  }
  async build() {
    if (this.destroyed || this.building || this.preparing) return;
    // One globe, one clock, one fleet. A whole day already driving them and a
    // single flight starting beside it is two sets of aircraft on one map --
    // refused by name here rather than allowed to start and then fight for the
    // screen. The manual side is refused by the server as well; this is so the
    // answer arrives before anything is built.
    const busy = this.twinBusy?.();
    if (busy) {this.error.textContent = busy; return;}
    this.invalidatePrepared();
    if (!this.prepared) {this.error.textContent = '계획을 먼저 저장하고 검토해 주세요.'; return;}
    if(this.controlMode==='manual'){
      this.pause();this.onManualStop();this.manualSample=null;this.building=true;this.showPreparation();
      const manualEpoch=this.requestEpoch;
      try{
        const resolved=await resolvePlan(this.prepared.plan,{groundHeights:this.groundHeights,deckTop:this.deckTop});
        if(this.destroyed||manualEpoch!==this.requestEpoch)return;
        if(!this.onManual)throw new Error('수동 실행 연결이 없습니다.');
        this.plan=resolved;this.recorded=null;if(this.controls.root)this.controls.root.hidden=true;this.onPlan(resolved);
        const result=await this.onManual({plan_id:this.prepared.plan_id,plan:resolved});
        if(this.destroyed||manualEpoch!==this.requestEpoch)return;
        this.run={run_id:result.run_id};
      }catch(error){if(!this.destroyed&&manualEpoch===this.requestEpoch){this.error.textContent=error.message;this.onManualStop();}}
      finally{if(!this.destroyed&&manualEpoch===this.requestEpoch){this.building=false;this.showPreparation();}}
      return;
    }
    this.onManualStop();
    const epoch = this.requestEpoch;
    const stale = () => this.destroyed || epoch !== this.requestEpoch;
    this.building = true;
    this.showPreparation();
    const release = () => {
      if (stale()) return;
      this.building = false;
      this.invalidatePrepared();
    };
    this.error.textContent = '';
    this.pause();
    let answer;
    try {
      // The engine flies it and the Data Layer keeps it; what comes back is a
      // recorded run, not a plan this panel then has to simulate.
      answer = await this.api.fly({plan_id: this.prepared.plan_id});
      if (stale()) return;
    } catch (failure) {
      if (stale()) return;
      this.error.textContent = failure?.data?.message ?? '비행을 생성하지 못했습니다.';
      release();
      return;
    }
    // The heights left the engine as they were designed — over the ground,
    // over a deck — so they are stood on the real terrain before anything is
    // drawn or read out. Otherwise the flight sits at sea level over a hill.
    let resolved;
    try {
      resolved = await resolvePlan(answer.plan, {groundHeights: this.groundHeights, deckTop: this.deckTop});
    } catch {
      if (stale()) return;
      this.error.textContent = '지형 높이를 확인하지 못했습니다. 다시 생성해 주세요.';
      return;
    } finally {
      release();
    }
    if (stale()) return;
    this.plan = resolved;
    this.run = answer.run ?? null;
    this.recorded = readRun(this.plan, answer.states);
    this.time = 0;
    this.onPlan(this.plan);
    this.drawMonitor();
    // Each new execution starts attached. Manual release survives subsequent
    // frames, seeking and editor reopen until another execution is accepted.
    this.setFollowing(true);
    const summary = this.run?.summary ?? {};
    this.notify('ready', `비행 생성: ${this.plan.departure?.name} → ${this.plan.arrival?.name}`
      + ` · 상태 ${summary.states ?? this.recorded.length}개 (${summary.rate_hz ?? '?'} Hz) · 저장 ${this.run?.run_id ?? ''}`);
  }

  clearFlight() {
    this.onManualStop();this.manualSample=null;
    if (this.destroyed) return;
    const pending = this.preparing || this.building;
    ++this.requestEpoch; // Discard every late save/run/terrain response.
    this.preparing = false; this.building = false;
    this.pause(); this.setFollowing(false);
    this.prepared = null; this.preparedValues = null;
    this.plan = null; this.run = null; this.recorded = null; this.time = 0;
    this.onPlan(null); this.drawMonitor();
    if (this.error) this.error.textContent = '';
    this.clearMessage = pending
      ? '결과 표시를 취소했습니다. 서버의 저장·계산은 계속될 수 있으며 결과가 도착해도 화면에 다시 표시하지 않습니다.'
      : '계획 선택과 재생을 화면에서 제거했습니다. 저장된 계획·실행 기록은 유지됩니다.';
    if (this.clearNote) this.clearNote.textContent = this.clearMessage;
    this.showPreparation();
    if (this.body) this.formSlot?.querySelector('#plan-prepare')?.focus?.();
    this.notify('ready', this.clearMessage);
  }

  // ---- playing it -------------------------------------------------------
  emit({resetCamera=false}={}) {
    const sample = this.recorded ? sampleRun(this.recorded, this.time) : null;
    if (sample) this.showSample(sample);
    this.onSample(sample);
    if (sample && this.following) this.onFollow(sample,{reset:resetCamera});
    return sample;
  }
  // The camera rides with the aircraft, as it does for a tracked live one.
  acceptManualSample(sample) {
    this.manualSample=sample;
    if(this.controlMode==='manual'&&this.following&&sample)this.onFollow(sample);
  }
  setFollowing(following) {
    this.following = Boolean(following);
    this.showTransport();
    // Letting go hands the camera back rather than leaving it locked.
    if (!this.following) {this.onFollow(null); return;}
    if(this.controlMode==='manual'){if(this.manualSample)this.onFollow(this.manualSample);}
    else if (this.recorded) this.onFollow(sampleRun(this.recorded, this.time));
  }
  play() {
    if (this.destroyed || !this.recorded?.length || this.timer !== null) return;
    if (this.time >= totalSeconds(this.plan)) this.time = 0;
    this.lastTick = this.now();
    this.timer = this.setTimer(() => this.tick());
    this.showTransport();
  }
  pause() {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null; this.lastTick = null;
    this.showTransport();
  }
  toggle() {if (this.timer === null) this.play(); else this.pause();}
  stop() {
    this.pause();
    this.seek(0);
  }
  tick() {
    const now = this.now();
    // A frame that arrives after a long stall (a tab in the background, a
    // terrain load) would jump the aircraft across the city; a frame's worth
    // of flight is the most any one step may advance.
    const elapsed = Math.min(0.25, Math.max(0, (now - (this.lastTick ?? now)) / 1000));
    this.lastTick = now;
    const total = totalSeconds(this.plan);
    this.time = Math.min(total, this.time + elapsed * this.speed);
    const sample = this.emit();
    // The flight ends where it ends; it does not loop on its own.
    if (sample?.done) {this.pause(); return;}
    if (this.timer !== null) this.timer = this.setTimer(() => this.tick());
  }
  seek(seconds) {
    this.time = Math.min(totalSeconds(this.plan), Math.max(0, Number(seconds) || 0));
    this.emit({resetCamera:true});
  }
  setSpeed(multiple) {
    this.speed = SPEEDS.includes(Number(multiple)) ? Number(multiple) : DEFAULT_SPEED;
    this.showTransport();
  }

  // ---- what it shows ----------------------------------------------------
  // The provenance of the numbers on screen: the stored run, how densely it
  // was recorded, and what produced it. A flight the C++ airframe and its
  // controller actually flew says so; one integrated from the plan's own
  // speeds says that instead, so the two are never read as the same evidence.
  sourceLine() {
    if (!this.run) return '';
    const summary = this.run.summary ?? {};
    const engines = {
      'native-fastphysics-simpleflight': '동역학·제어 비행 (FastPhysics + SimpleFlight)',
      'kinematic-plan-integrator': '계획 적분 (동역학 없음)',
    };
    const engine = engines[summary.engine] ?? summary.engine ?? '';
    const ground = summary.ground_engine && summary.ground_engine !== summary.engine
      ? ' · 지상 구간은 계획 적분' : '';
    return `${engine}${ground} · ${summary.states ?? 0}개 상태 @ ${summary.rate_hz ?? '?'} Hz`
      + ` · ${this.run.run_id}`;
  }

  drawMonitor() {
    this.controls.show(this.plan, this.run, this.recorded, this.sourceLine());
    if (this.monitorSlot) {
      this.monitorSlot.textContent = '';
      if (this.plan) this.monitorSlot.append(
        this.el('p', {class: 'route-note', text: '실행 정보와 재생 조작은 지도 하단의 비행 컨트롤 바에 표시됩니다.'}),
        this.el('button', {type: 'button', id: 'plan-open-controls', text: '하단 비행 컨트롤 펼치기',
          onclick: () => {this.controls.setCollapsed(false); this.controls.playButton?.focus?.();}}));
    }
    this.showTransport(); this.emit();
  }
  showSample(sample) {this.controls.update(sample);}
  showTransport() {
    this.controls.transport({playing: this.timer !== null, speed: this.speed, following: this.following});
  }
  destroy() {
    this.onManualStop();
    this.destroyed = true;
    ++this.requestEpoch;
    this.pause();
    if (this.following) this.setFollowing(false);
    this.controls.destroy();
    this.body = null;
  }
}
