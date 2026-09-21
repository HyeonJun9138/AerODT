// User/Application: the setup a multi-flight day starts from. Five steps —
// which vertiports, how much demand and between which of them, when the day
// runs, which seed draws it, and what stands on the decks at the start — then
// one request to the generator.
//
// The panel collects and shows; it works nothing out itself. Every number it
// derives comes from demand_setup.js, and everything it draws on the map goes
// through the callbacks it was given. It does not generate the flights: that is
// asked for and the answer is reported.
import {buildElement} from '../../../dom_builder.js';
import {DEFAULT_WEIGHT, DIRECTIONS, FILL_MODES, SEAT_CHOICES, SEAT_CLASSES, WEIGHT_MAX, WEIGHT_MIN, WEIGHT_STEP,
  allPairs, buildRequest, clampWeight, defaultState, describeDemand, describeHours, describeWeights,
  dailyTrips, fitMix, fleetRows, fleetTotals, initialStateDocument, livePairs, pairCounts,
  resolveSeed, seatCapacity, togglePair, weightRows} from '../../../demand_setup.js';

const SCRAP_HINT = '지도에서 드래그하면 사각형 안의 버티포트가 모두 선택됩니다. 하나만 누르면 그것만 넣거나 뺍니다.';
const PAIR_HINT = '목록에서 버티포트를 누르면 그 연결만 지도에 진하게 표시됩니다. 지도의 선을 누르면 그 쌍만 끊거나 다시 잇습니다.';
const SEED_HINT = '같은 시드는 같은 수요를 다시 만듭니다. 랜덤이면 서버가 뽑은 시드를 결과에 적어 줍니다.';
const FLEET_HINT = '일괄로 채운 뒤 버티포트마다 인승별 대수를 고치면 됩니다. 합계가 게이트 수를 넘으면 다른 인승이 그만큼 줄어듭니다.';
const WEIGHT_HINT = '100%가 평균 버티포트입니다. 받은 서울시 통행 비율을 평균 대비로 환산한 값이 기본값이고, 10% 단위로 올리거나 내리면 됩니다. 0%로 두면 그 버티포트는 출발(또는 도착)하지 않습니다.';
const STEPS = [['scope', '버티포트 범위'], ['demand', '수요'], ['hours', '이용 시간'], ['seed', '수요 생성 시드'],
  ['fleet', '초기 상태'], ['manual', '수동 비행']];
// Nobody is assigned an aircraft until the day is running, so what can be asked
// for here is a cabin size and a place to leave from -- the two things that are
// true of the plan rather than of a flight that does not exist yet.
const MANUAL_SEATS = [['', '아무 기체'], ['4', '4인'], ['6', '6인'], ['8', '8인']];

const count = value => Number(value ?? 0).toLocaleString('ko-KR');

// The browser saves the file itself; nothing is sent anywhere. False when the
// page cannot make one, so the panel can say so rather than claim it saved.
export function saveFile(document, name, text) {
  try {
    const url = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
    const link = document.createElement('a');
    link.href = url; link.download = name;
    document.body.append(link); link.click(); link.remove();
    globalThis.setTimeout?.(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch {
    return false;
  }
}

export class DemandPanel {
  constructor({api, notify = () => {}, document = globalThis.document, onPairs = () => {},
    onScrap = () => {}, onDemandEditor = () => {}, onFocus = () => {}, onQuiet = () => {},
    plans = null, onPlanLoaded = () => {}, onControlPanel = () => {}, onManualRequest = () => {}, onSummary = null,
    download = null, now = () => new Date()}) {
    Object.assign(this, {api, notify, document, onPairs, onScrap, onDemandEditor, onFocus, onQuiet, now});
    // A day somebody else planned, read from a file instead of generated here.
    // The panel does not parse it: the file is handed over whole and the server
    // answers with what the day contains and where the aircraft start.
    Object.assign(this, {plans, onPlanLoaded, onControlPanel, onManualRequest, onSummary});
    this.plan = null; this.planBusy = ''; this.planError = '';
    this.download = download ?? ((name, text) => saveFile(document, name, text));
    this.state = defaultState();
    this.records = []; this.root = null; this.open = 'scope'; this.scrapping = false;
    // Which vertiport's own connections are drawn strongly; null draws them all alike.
    this.focused = null;
    this.result = null; this.ready = Promise.resolve();
  }
  el(tag, props = {}, ...children) {return buildElement(this.document, tag, props, ...children);}
  known(id) {return this.records.find(record => record.id === id) ?? null;}
  scopeRecords() {return this.state.scope.map(id => this.known(id)).filter(Boolean);}

  render(root) {
    this.root = root;
    this.ready = this.load(root);
    this.draw();
    return this.ready;
  }
  async load(root) {
    let answer = null;
    try {
      answer = await this.api.list();
    } catch {
      this.notify('error', '버티포트 목록을 불러오지 못했습니다.');
      return;
    }
    if (this.root !== root) return;
    // The server answers {vertiports: [...]}; a plain list is accepted too so a
    // test can hand one over without wrapping it.
    const records = Array.isArray(answer) ? answer : (answer?.vertiports ?? []);
    // Only what the map has actually placed can be scrapped or joined.
    this.records = records.filter(record => record?.layout);
    // A vertiport deleted elsewhere leaves the scope with it.
    const live = new Set(this.records.map(record => record.id));
    this.state = {...this.state, scope: this.state.scope.filter(id => live.has(id))};
    await this.readWeightDefaults();
    await this.readPlan();
    this.draw();
  }
  // How much of a day each deck carries, before the operator changes anything.
  // Held on the state rather than merged into the weights, so a setup nobody has
  // touched carries the forecast itself instead of a copy that has to be kept in
  // step with it.
  async readWeightDefaults() {
    if (typeof this.api?.demandDefaults !== 'function') return null;
    try {
      const answer = await this.api.demandDefaults();
      const defaults = {};
      for (const row of answer?.vertiports ?? []) {
        defaults[row.vertiport] = {departure: row.departure, arrival: row.arrival,
          known: row.known !== false, source: row.source ?? ''};
      }
      this.weightSource = answer?.source ?? '';
      this.state = {...this.state, weight_defaults: defaults};
      return defaults;
    } catch {
      return null; // Every deck simply starts at the average.
    }
  }
  weightRows() {
    return weightRows(this.state.scope ?? [], this.state, this.state.weight_defaults ?? {},
      new Map(this.records.map(record => [record.id, record])));
  }
  setWeight(id, direction, value) {
    const weights = {...(this.state.weights ?? {})};
    weights[id] = {...(weights[id] ?? {}), [direction]: clampWeight(value)};
    this.state = {...this.state, weights};
    this.paintWeightRow(id);
    this.paintFigures();
  }
  // Back to the forecast, or flat. Two buttons because they are two different
  // intentions: "undo what I did" and "I do not want this shaping the day".
  resetWeights(mode) {
    if (mode === 'reference') {
      this.state = {...this.state, weights: {}};
    } else {
      const weights = {};
      for (const id of this.state.scope ?? []) {
        weights[id] = Object.fromEntries(DIRECTIONS.map(([direction]) => [direction, DEFAULT_WEIGHT]));
      }
      this.state = {...this.state, weights};
    }
    this.repaint();
  }
  paintWeightRow(id) {
    const held = this.weightInputs?.get(id);
    if (!held) return;
    const row = this.weightRows().find(item => item.id === id);
    if (!row) return;
    for (const [direction] of DIRECTIONS) {
      const input = held.inputs[direction];
      const next = String(row[direction]);
      if (input && input.value !== next) input.value = next;
      const bar = held.bars[direction];
      if (bar) bar.style.width = `${Math.round(row[`${direction}_share`] * 100)}%`;
    }
    held.item.setAttribute('data-state', row.departure === 0 && row.arrival === 0 ? 'off' : 'on');
    held.item.setAttribute('data-changed', String(row.changed));
    held.share.textContent = this.weightShareText(row);
  }
  weightShareText(row) {
    return `출발 ${(row.departure_share * 100).toFixed(1)}% · 도착 ${(row.arrival_share * 100).toFixed(1)}%`;
  }

  // A day loaded before this page was opened is still loaded on the server, and
  // a card that says otherwise would have the operator load it again.
  async readPlan() {
    if (typeof this.plans?.describe !== 'function') return null;
    try {
      const answer = await this.plans.describe();
      this.plan = answer?.loaded ? answer : null;
      if (this.plan) await this.onPlanLoaded(this.plan, this.manualRequest());
      return this.plan;
    } catch {
      return null; // The card simply offers to load one.
    }
  }
  // The map lets go of everything this panel put on it. The root goes first so
  // nothing tries to draw into a panel that is on its way off screen.
  deactivate() {
    this.root = null;
    this.setScrapping(false);
    this.onDemandEditor(null);
    this.onPairs([], {focus: null});
    this.onQuiet(false);
  }

  // ---- steps -------------------------------------------------------------
  goto(id) {
    if (this.open === id) id = null;
    this.open = id;
    if (id !== 'scope') this.setScrapping(false);
    this.repaint();
  }
  setScrapping(active) {
    const wanted = Boolean(active) && this.open === 'scope';
    if (wanted === this.scrapping) return;
    this.scrapping = wanted;
    this.onScrap(wanted ? {records: () => this.records, onScrap: ids => this.addScope(ids), onToggle: id => this.toggleScope(id)} : null);
    // The button is the only thing that says whether the map is armed. Without
    // this it goes on claiming whatever it last said and cannot be switched off.
    this.repaint();
  }
  addScope(ids = []) {
    const scope = new Set(this.state.scope);
    const before = scope.size;
    for (const id of ids) if (this.known(id)) scope.add(id);
    this.state = {...this.state, scope: [...scope]};
    // An empty box is a miss, not a selection of nothing.
    this.notify('ok', scope.size > before ? `버티포트 ${scope.size - before}곳을 선택했습니다.`
      : '사각형 안에 새로 선택할 버티포트가 없습니다.');
    this.repaint();
  }
  toggleScope(id) {
    if (!this.known(id)) return;
    const scope = new Set(this.state.scope);
    if (scope.has(id)) scope.delete(id); else scope.add(id);
    this.state = {...this.state, scope: [...scope]};
    this.repaint();
  }
  setScope(ids) {this.state = {...this.state, scope: [...ids]}; this.repaint();}

  // ---- the map -----------------------------------------------------------
  // The pairs are drawn only while the step that edits them is open, so the
  // network does not hang over the map through the rest of the setup.
  paintMap() {
    // The route network joins the same decks with the same kind of line. While
    // this setup owns the map it drops to background for the whole tab, not
    // only while the pairs are on screen, because the vertiports are being
    // picked out of it in the first step too.
    this.onQuiet(true);
    const showing = this.open === 'demand' && this.state.scope.length >= 2;
    this.onDemandEditor(showing ? {onPair: pair => this.cutPair(pair.key)} : null);
    this.onPairs(showing ? allPairs(this.state.scope, this.state) : [], {focus: showing ? this.focused : null});
  }
  cutPair(key) {
    this.state = togglePair(this.state, key);
    this.repaint();
  }
  toggleParticipant(id) {
    const excluded = new Set(this.state.excluded);
    if (excluded.has(id)) excluded.delete(id); else excluded.add(id);
    this.state = {...this.state, excluded: [...excluded]};
    this.repaint();
  }

  // ---- drawing -----------------------------------------------------------
  repaint() {
    const root = this.root;
    if (!root) return;
    // Re-drawing a step must not throw the operator back to the top of a list
    // they were part way down.
    const tops = new Map();
    for (const node of root.querySelectorAll?.('.dm-table') ?? []) if (node.id) tops.set(node.id, node.scrollTop);
    this.draw();
    for (const node of root.querySelectorAll?.('.dm-table') ?? []) if (tops.has(node.id)) node.scrollTop = tops.get(node.id);
  }
  draw() {
    const root = this.root;
    if (!root) return;
    root.textContent = '';
    const bodies = {scope: () => this.scopeStep(), demand: () => this.demandStep(), hours: () => this.hoursStep(),
      seed: () => this.seedStep(), fleet: () => this.fleetStep(), manual: () => this.manualStep()};
    const summaries = {scope: () => this.scopeSummary(), demand: () => describeDemand(this.state.demand),
      hours: () => describeHours(this.state.operating), seed: () => this.seedSummary(), fleet: () => this.fleetSummary(),
      manual: () => this.manualSummary()};
    const shell = this.el('div', {class: 'dm'});
    // The headers are kept so a figure typed into an open step can refresh the
    // one above it: a header still saying 400 seats over a total saying 416 is
    // the panel disagreeing with itself.
    this.summaries = summaries; this.summaryNodes = new Map();
    STEPS.forEach(([id, title], index) => {
      const next = STEPS[index + 1]?.[0] ?? null;
      shell.append(this.step(id, index + 1, title, summaries[id](), bodies[id](), next));
    });
    this.error = this.el('p', {class: 'sim-error', role: 'alert', id: 'demand-error'});
    this.status = this.el('p', {class: 'dm-note', role: 'status', id: 'demand-status', text: this.result ?? ''});
    // The summary comes before the request. Five steps of settings are a lot to
    // hold in the head, and the thing being asked for takes minutes to build:
    // it is worth one screen that says what is about to be generated.
    const actions = this.el('div', {class: 'dm-actions'},
      this.el('button', {type: 'button', class: 'dm-run', id: 'demand-summary', text: '생성 요약',
        onclick: () => this.openSummary()}),
      this.el('button', {type: 'button', id: 'demand-reset', text: '초기화', onclick: () => this.reset()}));
    // The file is offered from the summary window instead of here: it is the
    // same document, and it reads better beside the description of what is in
    // it than as a button under a form.
    root.append(shell, this.error, actions, this.planSection(), this.status);
    this.paintMap();
  }

  // ---- a day read from a file --------------------------------------------
  // Loading is two steps and they are different questions. The first reads the
  // plan and stands the fleet on the decks, which is a picture of the morning
  // before anything has happened. The second hands the twin over to that day,
  // which stops the live traffic being drawn — so it is asked for separately.
  planSection() {
    const section = this.el('div', {class: 'dm-plan', id: 'demand-plan'});
    section.append(this.el('button', {type: 'button', class: 'dm-save', id: 'demand-plan-load',
      text: '예시 비행계획 적용', disabled: this.planBusy ? '' : undefined,
      onclick: () => void this.loadPlan()}));
    if (this.planBusy) {
      section.append(this.el('p', {class: 'dm-plan-busy', role: 'status', id: 'demand-plan-busy'},
        this.el('i', {'aria-hidden': 'true'}), this.el('span', {text: this.planBusy})));
    }
    if (this.planError) {
      section.append(this.el('p', {class: 'sim-error', role: 'alert', id: 'demand-plan-error', text: this.planError}));
    }
    const summary = this.plan?.schedule;
    if (summary) {
      const cell = (label, value) => this.el('div', {class: 'dm-plan-cell'},
        this.el('span', {text: label}), this.el('strong', {text: value}));
      section.append(this.el('div', {class: 'dm-plan-summary', id: 'demand-plan-summary'},
        cell('비행', `${count(summary.flights)}편`),
        cell('기체', `${count(summary.aircraft)}대`),
        cell('버티포트', `${count(summary.vertiports)}곳`),
        cell('탑승객', `${count(summary.passengers)}명`),
        cell('운항 시간', `${summary.window?.start ?? ''}~${summary.window?.end ?? ''}`),
        cell('미해결 도착', `${count(summary.unresolved)}편`)));
      const models = this.el('div', {class: 'dm-plan-models', id: 'demand-plan-models'});
      for (const item of summary.by_seat_class ?? []) {
        models.append(this.el('span', {class: 'dm-plan-model',
          text: `${item.label} · ${count(item.flights)}편 · ${item.asset_id}`}));
      }
      section.append(models);
      // A flight the file itself could not resolve an arrival for is the case
      // this whole rehearsal is about, so it is said before anything is flown.
      if (summary.unresolved) {
        section.append(this.el('p', {class: 'dm-plan-warn',
          text: `도착이 정해지지 않은 비행 ${count(summary.unresolved)}편이 있습니다. 재생하면 PSU가 순서를 정합니다.`}));
      }
      if(summary.provisional_routes) section.append(this.el('p',{class:'dm-plan-warn',
        text:`${count(summary.provisional_routes)}편: 지점 20은 앞뒤 경유점 임시 연결입니다. 수정 계획 적용 시 다시 확인합니다.`}));
      if(summary.invalid_routes) section.append(this.el('p',{class:'sim-error',
        text:`경로 확인 필요 ${count(summary.invalid_routes)}편: 직항으로 대체하지 않습니다.`}));
      if (this.plan.initial_state?.reassigned?.length) {
        section.append(this.el('p', {class: 'dm-plan-warn',
          text: `주기장이 겹쳐 ${count(this.plan.initial_state.reassigned.length)}대를 빈 자리로 옮겼습니다.`}));
      }
      section.append(this.el('button', {type: 'button', class: 'dm-run', id: 'demand-plan-open',
        text: 'Control Panel 열기', onclick: () => void this.openControlPanel()}));
    }
    return section;
  }
  async loadPlan() {
    if(this.planBusy)return null;
    if (typeof this.plans?.example !== 'function') {
      this.planError = '비행계획 불러오기가 연결되지 않았습니다.';
      this.repaint();
      return null;
    }
    this.plan = null; this.planError = '';
    this.planBusy = '비행을 준비중입니다 · 계획을 읽는 중';
    this.repaint();
    try {
      const answer = await this.plans.example();
      this.plan = answer;
      this.planBusy = '비행을 준비중입니다 · 기체를 버티포트에 배치하는 중';
      this.repaint();
      // Preparation alone does not activate simulation or put aircraft on the map.
      await this.onPlanLoaded(answer, this.manualRequest());
      this.planBusy = '';
      this.repaint();
      this.notify('ok', `비행계획 ${count(answer.schedule?.flights ?? 0)}편을 불러왔습니다.`);
      return answer;
    } catch (error) {
      this.plan = null;
      this.planBusy = '';
      this.planError = error?.message ?? '비행계획을 불러오지 못했습니다.';
      this.repaint();
      this.notify('error', this.planError);
      return null;
    }
  }
  // A day this panel asked for, already read and set out by the server. There is
  // one place a loaded day is shown, so a generated one arrives here rather than
  // growing a second version of the same panel.
  async adoptPlan(description) {
    if (!description) return null;
    this.plan = description; this.planError = ''; this.planBusy = '';
    this.repaint();
    await this.onPlanLoaded(description, this.manualRequest());
    return description;
  }
  // The day was thrown away elsewhere - the console closed. Whatever this panel
  // is showing about a loaded plan is no longer true, so it stops showing it.
  forgetPlan() {
    if (!this.plan) return false;
    this.plan = null; this.planError = ''; this.planBusy = '';
    if (this.root) this.repaint();
    return true;
  }
  async openControlPanel() {
    if (!this.plan) return null;
    this.planBusy = '저장 정보 재생으로 전환하는 중입니다';
    this.repaint();
    try {
      return await this.onControlPanel(this.plan, this.manualRequest());
    } finally {
      this.planBusy = '';
      this.repaint();
    }
  }
  step(id, index, title, summary, children, next) {
    const open = this.open === id;
    const said = this.el('span', {class: 'dm-sum', text: summary});
    this.summaryNodes?.set(id, said);
    const head = this.el('button', {type: 'button', class: 'dm-head', id: `dm-head-${id}`,
      'aria-expanded': String(open), 'aria-controls': `dm-body-${id}`, onclick: () => this.goto(id)},
      this.el('span', {class: 'dm-num', text: String(index)}),
      this.el('span', {class: 'dm-title', text: title}),
      said);
    const body = this.el('div', {class: 'dm-body', id: `dm-body-${id}`, hidden: open ? undefined : ''});
    body.hidden = !open;
    for (const child of children) body.append(child);
    body.append(this.el('button', {type: 'button', class: 'dm-confirm', text: '확인',
      onclick: () => {this.open = next; this.setScrapping(false); this.repaint();}}));
    return this.el('section', {class: 'dm-step'}, head, body);
  }
  tools(...buttons) {return this.el('div', {class: 'dm-tools'}, ...buttons);}
  button(id, label, onclick, pressed) {
    return this.el('button', {type: 'button', id, text: label, onclick,
      'aria-pressed': pressed === undefined ? undefined : String(pressed)});
  }
  table(id, rows, empty) {
    const list = this.el('ul', {class: 'dm-rows'});
    if (!rows.length) list.append(this.el('li', {class: 'dm-row dm-row-empty', text: empty}));
    for (const row of rows) list.append(row);
    return this.el('div', {class: 'dm-table', id}, list);
  }
  field(label, input) {return this.el('label', {class: 'dm-field'}, this.el('span', {text: label}), input);}
  number(id, value, {min, max, step = '1', oninput}) {
    return this.el('input', {type: 'number', id, value: String(value), min: String(min), max: max === undefined ? undefined : String(max),
      step, oninput: event => oninput(event.target.value)});
  }
  radio(name, id, label, checked, onchange) {
    const input = this.el('input', {type: 'radio', name, id, checked: checked ? '' : undefined, onchange: () => onchange()});
    input.checked = checked;
    return this.el('label', {class: 'dm-choice'}, input, this.el('span', {text: label}));
  }

  // ---- 1. which vertiports ----------------------------------------------
  scopeSummary() {return `${this.state.scope.length} / ${this.records.length}곳`;}
  // The decks a study covers are a network, not nineteen separate choices: once
  // there is a 울산 beside a 수도권, picking one of them is the usual request
  // and ticking eleven boxes to get it is the wrong way to ask.
  scopeGroups() {
    const groups = new Map();
    for (const record of this.records) {
      const name = String(record.group ?? '').trim() || '미분류';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(record);
    }
    // Alphabetical, but anything still unfiled sinks: it is a to-do, not a place.
    return [...groups].sort(([a], [b]) =>
      (a === '미분류') - (b === '미분류') || a.localeCompare(b, 'ko'));
  }
  setGroupScope(records, on) {
    const ids = new Set(this.state.scope);
    for (const record of records) on ? ids.add(record.id) : ids.delete(record.id);
    this.setScope([...ids]);
  }
  scopeStep() {
    const chosen = new Set(this.state.scope);
    const groups = this.scopeGroups();
    const rows = [];
    for (const [name, members] of groups) {
      const on = members.filter(record => chosen.has(record.id)).length;
      // One header per group, saying how much of it is in and turning the whole
      // group on or off. Only worth drawing when there is more than one group:
      // a single-network study should not have to read a heading to find its decks.
      if (groups.length > 1) {
        rows.push(this.el('li', {class: 'dm-row dm-row-group', 'data-group': name, 'data-state': on === members.length ? 'all' : on ? 'some' : 'none'},
          this.el('div', {class: 'dm-row-name'}, this.el('strong', {text: name}),
            this.el('small', {text: `${on} / ${members.length}곳`})),
          this.el('button', {type: 'button', class: 'dm-mini', id: `dm-group-${name}`,
            text: on === members.length ? '이 분류 해제' : '이 분류 선택',
            onclick: () => this.setGroupScope(members, on !== members.length)})));
      }
      for (const record of members) {
        const picked = chosen.has(record.id);
        const box = this.el('input', {type: 'checkbox', id: `dm-scope-${record.id}`, checked: picked ? '' : undefined,
          onchange: () => this.toggleScope(record.id)});
        box.checked = picked;
        rows.push(this.el('li', {class: 'dm-row', 'data-id': record.id, 'data-group': name, 'aria-selected': String(picked)},
          box,
          this.el('div', {class: 'dm-row-name'}, this.el('strong', {text: record.name}),
            this.el('small', {text: `게이트 ${record.gates} · FATO ${(record.fatos ?? []).length}`})),
          this.el('button', {type: 'button', class: 'dm-mini', text: '보기', onclick: () => this.onFocus(record)})));
      }
    }
    return [
      this.tools(
        this.button('demand-scrap', this.scrapping ? '스크랩 중 · 끄기' : '지도에서 스크랩', () => this.setScrapping(!this.scrapping), this.scrapping),
        this.button('demand-scope-all', '전체 선택', () => this.setScope(this.records.map(record => record.id))),
        this.button('demand-scope-none', '모두 해제', () => this.setScope([]))),
      this.el('p', {class: 'dm-note', text: SCRAP_HINT}),
      this.table('demand-scope-table', rows, '저장된 버티포트가 없습니다. 버티포트 탭에서 먼저 만들어 주세요.'),
    ];
  }

  // ---- 2. demand and the pairs it may use --------------------------------
  demandStep() {
    const demand = this.state.demand;
    const setDemand = patch => {this.state = {...this.state, demand: {...this.state.demand, ...patch}}; this.paintFigures();};
    const baseline = this.el('div', {class: 'dm-inline dm-indent'},
      this.field('기준 교통량 (명/일)', this.number('demand-baseline', demand.baseline, {min: 0, step: '1000', oninput: value => setDemand({baseline: Number(value)})})),
      this.field('UAM 전환률 (%)', this.number('demand-conversion', demand.conversion_pct, {min: 0, max: 100, step: '0.1', oninput: value => setDemand({conversion_pct: Number(value)})})));
    const direct = this.el('div', {class: 'dm-inline dm-indent'},
      this.field('1일 이용객 (명)', this.number('demand-riders', demand.riders, {min: 0, step: '100', oninput: value => setDemand({riders: Number(value)})})));
    const mode = value => {this.state = {...this.state, demand: {...this.state.demand, mode: value}}; this.repaint();};
    this.demandFigure = this.el('strong', {id: 'demand-trips', text: `${count(dailyTrips(demand))}명`});
    const scope = this.state.scope;
    const counts = pairCounts(scope, this.state);
    const excluded = new Set(this.state.excluded);
    const rows = this.scopeRecords().map(record => {
      const on = !excluded.has(record.id);
      const box = this.el('input', {type: 'checkbox', id: `dm-pair-${record.id}`, checked: on ? '' : undefined,
        onchange: () => this.toggleParticipant(record.id)});
      box.checked = on;
      const links = counts.get(record.id) ?? 0;
      // The row wears the same two colours the map does, so the list and the
      // network say the same thing about the same facility.
      return this.el('li', {class: 'dm-row', 'data-id': record.id, 'data-state': on && links ? 'on' : 'off',
        'aria-selected': String(this.focused === record.id)},
        box,
        this.el('button', {type: 'button', class: 'dm-row-name dm-row-pick',
          onclick: () => {this.focused = this.focused === record.id ? null : record.id; this.repaint();}},
          this.el('strong', {text: record.name}), this.el('small', {text: `연결 ${links}개`})),
        this.el('span', {class: 'dm-row-note', text: on ? (links ? '' : '고립') : '제외'}));
    });
    const live = livePairs(scope, this.state).length, total = allPairs(scope, this.state).length;
    const linkTools = this.tools(
      this.button('demand-link-all', '모두 연결', () => {this.state = {...this.state, broken: [], excluded: []}; this.repaint();}),
      this.button('demand-link-none', '모두 끊기', () => {this.state = {...this.state, broken: allPairs(this.state.scope, {}).map(pair => pair.key)}; this.repaint();}));
    return [
      this.radio('demand-mode', 'demand-mode-baseline', '기준 교통량 × 전환률', demand.mode !== 'direct', () => mode('baseline')),
      baseline,
      this.radio('demand-mode', 'demand-mode-direct', '1일 이용객 직접 입력', demand.mode === 'direct', () => mode('direct')),
      direct,
      this.el('div', {class: 'dm-figure'}, this.el('span', {text: '하루 수요'}), this.demandFigure),
      this.el('h4', {class: 'dm-sub', text: `버티포트 연결 · ${live} / ${total}쌍`}),
      linkTools,
      this.el('p', {class: 'dm-key'},
        this.el('span', {class: 'dm-key-item dm-key-on', text: '연결'}),
        this.el('span', {class: 'dm-key-item dm-key-off', text: '끊김'}),
        this.el('span', {class: 'dm-key-note', text: '항로는 이 설정 중 옅게'})),
      this.el('p', {class: 'dm-note', text: PAIR_HINT}),
      this.table('demand-pair-table', rows, '먼저 버티포트를 2곳 이상 선택하세요.'),
      ...this.weightSection(),
    ];
  }

  // ---- how much of the day each deck carries -----------------------------
  weightSection() {
    const rows = this.weightRows();
    this.weightInputs = new Map();
    const head = this.el('li', {class: 'dm-row dm-row-weight dm-row-head'},
      this.el('span', {text: '버티포트'}),
      ...DIRECTIONS.map(([, label]) => this.el('span', {text: label})));
    const items = rows.map(row => {
      const bars = {}, inputs = {};
      const share = this.el('small', {class: 'dm-weight-share', text: this.weightShareText(row)});
      const name = this.el('div', {class: 'dm-row-name'},
        this.el('strong', {text: row.name}), share);
      const item = this.el('li', {class: 'dm-row dm-row-weight', 'data-id': row.id,
        'data-state': row.departure === 0 && row.arrival === 0 ? 'off' : 'on',
        'data-changed': String(row.changed)}, name);
      for (const [direction] of DIRECTIONS) {
        bars[direction] = this.el('i', {class: 'dm-weight-fill'});
        bars[direction].style.width = `${Math.round(row[`${direction}_share`] * 100)}%`;
        inputs[direction] = this.number(`dm-weight-${row.id}-${direction}`, row[direction],
          {min: WEIGHT_MIN, max: WEIGHT_MAX, step: String(WEIGHT_STEP),
           oninput: value => this.setWeight(row.id, direction, value)});
        item.append(this.el('div', {class: 'dm-weight-cell'}, inputs[direction],
          this.el('span', {class: 'dm-weight-bar'}, bars[direction])));
      }
      this.weightInputs.set(row.id, {item, inputs, bars, share});
      return item;
    });
    this.weightFigure = this.el('strong', {id: 'demand-weight-summary', text: describeWeights(rows)});
    return [
      this.el('h4', {class: 'dm-sub', text: '버티포트별 수요 비율'}),
      this.tools(
        this.button('demand-weight-reference', '기본값 (받은 자료)', () => this.resetWeights('reference')),
        this.button('demand-weight-flat', '모두 100%', () => this.resetWeights('flat'))),
      this.el('p', {class: 'dm-note', text: WEIGHT_HINT}),
      this.el('div', {class: 'dm-figure'}, this.el('span', {text: '분배'}), this.weightFigure),
      this.table('demand-weight-table', [head, ...items], '먼저 버티포트를 선택하세요.'),
    ];
  }

  // ---- 3. the operating day ---------------------------------------------
  hoursStep() {
    const set = patch => {this.state = {...this.state, operating: {...this.state.operating, ...patch}}; this.paintFigures();};
    this.hoursFigure = this.el('strong', {id: 'demand-hours', text: describeHours(this.state.operating)});
    return [
      this.el('div', {class: 'dm-inline'},
        this.field('운영 시작', this.el('input', {type: 'time', id: 'demand-start', value: this.state.operating.start,
          oninput: event => set({start: event.target.value})})),
        this.field('운영 종료', this.el('input', {type: 'time', id: 'demand-end', value: this.state.operating.end,
          oninput: event => set({end: event.target.value})}))),
      this.el('div', {class: 'dm-figure'}, this.el('span', {text: '운영 시간'}), this.hoursFigure),
    ];
  }

  // ---- 4. the seed -------------------------------------------------------
  seedSummary() {
    const value = resolveSeed(this.state.seed);
    return this.state.seed.mode === 'fixed' ? (value === null ? '시드 값을 확인하세요' : `고정 ${value}`) : '매번 랜덤';
  }
  seedStep() {
    const seed = this.state.seed;
    const mode = value => {this.state = {...this.state, seed: {...this.state.seed, mode: value}}; this.repaint();};
    const input = this.number('demand-seed', seed.value, {min: 1, step: '1',
      oninput: value => {this.state = {...this.state, seed: {...this.state.seed, value}};}});
    if (seed.mode !== 'fixed') {input.setAttribute('disabled', ''); input.disabled = true;}
    return [
      this.radio('demand-seed-mode', 'demand-seed-random', '항상 랜덤', seed.mode !== 'fixed', () => mode('random')),
      this.radio('demand-seed-mode', 'demand-seed-fixed', '시드 고정', seed.mode === 'fixed', () => mode('fixed')),
      this.el('div', {class: 'dm-inline dm-indent'}, this.field('시드 (1 이상 정수)', input)),
      this.el('p', {class: 'dm-note', text: SEED_HINT}),
    ];
  }

  // ---- 5. what stands on the decks --------------------------------------
  fleetSummary() {
    const totals = fleetTotals(fleetRows(this.scopeRecords(), this.state.fleet));
    return `기체 ${totals.aircraft}대 · ${count(totals.seats)}석`;
  }
  // What the operator wants to fly themselves, decided with the plan rather
  // than bolted onto the console that runs it. Nothing is assigned here: the
  // day picks a matching flight when it is opened and running.
  manualRequest() {
    const asked = this.state.manual ?? {};
    return {want: Boolean(asked.want), seats: asked.seats || null, vertiport: asked.vertiport || null};
  }
  manualSummary() {
    const asked = this.manualRequest();
    if (!asked.want) return '수동 비행 없음 · 전부 자동 비행';
    const seats = asked.seats ? `${asked.seats}인` : '아무 기체';
    const port = asked.vertiport ? (this.known(asked.vertiport)?.name ?? asked.vertiport) : '아무 출발지';
    return `${seats} · ${port}에서 한 대 배정 요청`;
  }
  manualStep() {
    const asked = this.manualRequest();
    const set = patch => {
      this.state = {...this.state, manual: {...this.manualRequest(), ...patch}};
      this.onManualRequest(this.manualRequest());
      this.repaint();
    };
    const want = this.el('input', {type: 'checkbox', id: 'demand-manual-want',
      onchange: event => set({want: Boolean(event.target.checked)})});
    want.checked = asked.want;
    if (asked.want) want.setAttribute('checked', '');
    const seats = this.el('select', {id: 'demand-manual-seats',
      onchange: event => set({seats: event.target.value || null})});
    for (const [value, label] of MANUAL_SEATS) seats.append(this.el('option', {value, text: label}));
    seats.value = asked.seats ?? '';
    const port = this.el('select', {id: 'demand-manual-port',
      onchange: event => set({vertiport: event.target.value || null})});
    port.append(this.el('option', {value: '', text: '아무 출발지'}));
    for (const record of this.scopeRecords()) port.append(this.el('option', {value: record.id, text: record.name ?? record.id}));
    port.value = asked.vertiport ?? '';
    if (!asked.want) {
      for (const node of [seats, port]) {node.setAttribute('disabled', ''); node.disabled = true;}
    }
    // A step body is the list of things in it, the way every other step's is.
    return [
      this.el('label', {class: 'dm-manual-want'}, want,
        this.el('span', {text: '이 하루에서 한 대를 직접 조종'})),
      this.el('p', {class: 'dm-note',
        text: '조건에 맞는 곧 출발할 편 한 대를 넘겨받습니다. 그 기체는 하루 안에서 날아가므로 다른 기체가 실제로 피하고 기다립니다. 수동 조종 중에는 배속이 ×1로 내려갑니다.'}),
      this.el('div', {class: 'dm-manual-row'},
        this.el('label', {class: 'dm-manual-field'}, this.el('span', {text: '기체'}), seats),
        this.el('label', {class: 'dm-manual-field'}, this.el('span', {text: '출발지'}), port))];
  }
  fleetStep() {
    const fleet = this.state.fleet;
    const setFleet = patch => {this.state = {...this.state, fleet: {...this.state.fleet, ...patch}}; this.repaint();};
    const fill = this.el('select', {id: 'demand-fill', onchange: event => setFleet({fill: event.target.value})});
    for (const [id, label] of FILL_MODES) fill.append(this.el('option', {value: id, text: label, selected: id === fleet.fill ? '' : undefined}));
    fill.value = fleet.fill;
    const per = this.number('demand-fill-count', fleet.count, {min: 0, step: '1',
      oninput: value => {this.state = {...this.state, fleet: {...this.state.fleet, count: Number(value)}}; this.paintFigures();}});
    if (fleet.fill !== 'count') {per.setAttribute('disabled', ''); per.disabled = true;}
    const seat = this.el('select', {id: 'demand-seat', onchange: event => setFleet({seat_class: event.target.value})});
    for (const [id, label] of SEAT_CHOICES) seat.append(this.el('option', {value: id, text: label, selected: id === fleet.seat_class ? '' : undefined}));
    seat.value = fleet.seat_class;
    // One column per size, so a deck can start the day with a mix rather than
    // with one kind of aircraft repeated.
    const head = this.el('li', {class: 'dm-row dm-row-fleet dm-row-head'},
      this.el('span', {text: '시설'}), ...SEAT_CLASSES.map(item => this.el('span', {text: item.label})));
    // The rows are held onto so a spinner can update its own row in place. A
    // full redraw would replace the arrow under the cursor between clicks.
    this.fleetInputs = new Map();
    const rows = fleetRows(this.scopeRecords(), fleet).map(row => {
      const summary = this.el('small', {text: this.fleetLine(row)});
      const item = this.el('li', {class: 'dm-row dm-row-fleet', 'data-id': row.id,
        'data-state': this.fleetState(row), 'aria-selected': String(row.custom)},
        this.el('div', {class: 'dm-row-name'}, this.el('strong', {text: row.name}), summary));
      const inputs = {};
      for (const seatClass of SEAT_CLASSES) {
        inputs[seatClass.id] = this.number(`dm-fleet-${row.id}-${seatClass.id}`, row.mix[seatClass.id],
          {min: 0, max: row.gates, step: '1', oninput: value => this.setMix(row.id, seatClass.id, value)});
        item.append(inputs[seatClass.id]);
      }
      this.fleetInputs.set(row.id, {item, summary, inputs});
      return item;
    });
    const totals = fleetTotals(fleetRows(this.scopeRecords(), fleet));
    this.fleetFigure = this.el('strong', {id: 'demand-fleet-total', text: `${totals.aircraft}대 · ${count(totals.seats)}석`});
    return [
      this.el('div', {class: 'dm-inline'}, this.field('채우기', fill), this.field('버티포트당 대수', per), this.field('일괄 기종', seat)),
      this.tools(this.button('demand-fleet-apply', '일괄 적용 (개별 수정 초기화)', () => setFleet({overrides: {}}))),
      this.el('p', {class: 'dm-note', text: FLEET_HINT}),
      this.el('div', {class: 'dm-figure'}, this.el('span', {text: '배치 합계'}), this.fleetFigure),
      this.table('demand-fleet-table', [head, ...rows], '먼저 버티포트를 선택하세요.'),
    ];
  }
  fleetLine(row) {return `게이트 ${row.gates} · ${row.aircraft}대 · ${count(row.seats)}석`;}
  fleetState(row) {return row.gates && row.aircraft >= row.gates ? 'full' : row.aircraft ? 'on' : 'off';}
  // Editing one size makes that deck's whole mix its own, so the bulk choice no
  // longer writes over it. The other sizes give way when the gates run out, and
  // the row is corrected on screen so the operator sees the trade rather than
  // being quietly refused.
  setMix(id, seatClass, value) {
    const current = fleetRows(this.scopeRecords(), this.state.fleet).find(item => item.id === id);
    if (!current) return;
    const overrides = {...this.state.fleet.overrides, [id]: fitMix(current.mix, seatClass, value, current.gates)};
    this.state = {...this.state, fleet: {...this.state.fleet, overrides}};
    this.paintFleetRow(id);
    this.paintFigures();
  }
  paintFleetRow(id) {
    const held = this.fleetInputs?.get(id);
    const row = held && fleetRows(this.scopeRecords(), this.state.fleet).find(item => item.id === id);
    if (!row) return;
    for (const [seatClass, input] of Object.entries(held.inputs)) {
      const next = String(row.mix[seatClass]);
      if (input.value !== next) input.value = next;
    }
    held.summary.textContent = this.fleetLine(row);
    held.item.setAttribute('data-state', this.fleetState(row));
    held.item.setAttribute('aria-selected', String(row.custom));
  }
  // Only the derived readouts, so typing a number does not rebuild the form
  // under the cursor.
  paintFigures() {
    if (this.demandFigure) this.demandFigure.textContent = `${count(dailyTrips(this.state.demand))}명`;
    if (this.weightFigure) this.weightFigure.textContent = describeWeights(this.weightRows());
    if (this.hoursFigure) this.hoursFigure.textContent = describeHours(this.state.operating);
    if (this.fleetFigure) {
      const totals = fleetTotals(fleetRows(this.scopeRecords(), this.state.fleet));
      this.fleetFigure.textContent = `${totals.aircraft}대 · ${count(totals.seats)}석`;
    }
    for (const [id, node] of this.summaryNodes ?? []) node.textContent = this.summaries[id]();
  }

  // ---- what comes of it --------------------------------------------------
  say(message, {error = false} = {}) {
    this.result = error ? '' : message;
    if (this.error) this.error.textContent = error ? message : '';
    if (this.status) this.status.textContent = error ? '' : message;
  }
  // A run started before is not cleared here: pressing 생성 요청 again simply
  // asks for another one, which is how a changed setting is tried.
  async generate() {
    const {request, errors} = buildRequest(this.state, this.records);
    if (errors) {this.say(errors.join(' '), {error: true}); return null;}
    const supply = seatCapacity(fleetRows(this.scopeRecords(), this.state.fleet), this.state.operating);
    const short = supply > 0 && supply < request.demand.daily_trips;
    if (typeof this.api?.generate !== 'function') {
      this.say('생성기가 아직 연결되지 않았습니다. 아래 내려받기로 설정을 저장해 두세요.');
      return request;
    }
    this.say('수요를 생성하는 중입니다...');
    try {
      const answer = await this.api.generate(request);
      if(answer?.applied)await this.adoptPlan(answer.applied);
      const flights = answer?.flights ?? answer?.count;
      const blocked = Number(answer?.summary?.blocked_pairs ?? 0);
      const routeNote = blocked > 0 ? ` · 항로 미연결 ${count(blocked)}개 방향 제외 (직항 대체 없음)` : '';
      this.say(`생성 완료 · 비행 ${count(flights ?? 0)}편${routeNote}${short ? ' · 좌석 공급이 수요보다 적습니다' : ''}`);
      this.notify(blocked ? 'warn' : 'ok', blocked ? `항로 미연결 ${count(blocked)}개 방향을 제외했습니다.` : '다중 비행 계획을 생성했습니다.');
      // A day was asked for and a day arrived: the next thing anybody does with
      // it is play it, so the controls come up rather than waiting to be asked
      // for. Only when the generator actually handed one over - a request that
      // was accepted but produced no day leaves the setup panel where it is.
      if (this.plan) await this.openControlPanel();
      return answer;
    } catch (error) {
      // The generator is being written elsewhere; until it answers, the setup
      // is still worth keeping, so this says so instead of losing it.
      const missing = error?.status === 404 || error?.status === 501;
      this.say(missing ? '생성기가 아직 연결되지 않았습니다. 아래 내려받기로 설정을 저장해 두세요.'
        : (error?.message ?? '생성 요청이 실패했습니다.'), {error: !missing});
      return null;
    }
  }
  // What the summary window is given: everything it needs to draw, worked out
  // here so the window itself decides nothing.
  summaryView() {
    const {request, errors} = buildRequest(this.state, this.records);
    const rows = this.weightRows();
    const scope = this.scopeRecords();
    const fleet = fleetRows(scope, this.state.fleet);
    return {
      request: request ?? null, errors: errors ?? null,
      trips: dailyTrips(this.state.demand),
      demand: describeDemand(this.state.demand),
      hours: describeHours(this.state.operating),
      seed: this.seedSummary(),
      scope: {count: scope.length, pairs: livePairs(this.state.scope, this.state).length,
        total_pairs: allPairs(this.state.scope, this.state).length},
      weights: rows,
      fleet: {rows: fleet, totals: fleetTotals(fleet),
        capacity: seatCapacity(fleet, this.state.operating)},
      pairs: livePairs(this.state.scope, this.state).map(pair => ({from: pair.from, to: pair.to})),
      source: this.weightSource ?? '',
      document: initialStateDocument(this.state, this.records, {generatedAt: this.now().toISOString()}),
    };
  }
  openSummary() {
    const view = this.summaryView();
    if (typeof this.onSummary !== 'function') {
      // Without the window there is still an answer to give.
      this.say(view.errors ? view.errors.join(' ') : '설정을 확인했습니다.', {error: Boolean(view.errors)});
      return view;
    }
    this.onSummary(view, {generate: () => this.generate(), download: () => this.save()});
    return view;
  }
  reset() {
    this.state = defaultState();
    this.focused = null; this.result = null; this.open = 'scope';
    this.setScrapping(false);
    this.repaint();
    this.say('설정을 처음 상태로 되돌렸습니다.');
  }
  save() {
    const document_ = initialStateDocument(this.state, this.records, {generatedAt: this.now().toISOString()});
    const stamp = document_.generated_at.slice(0, 19).replace(/[-:T]/g, '');
    const saved = this.download(`aerodt_multi_setup_${stamp}.json`, JSON.stringify(document_, null, 2));
    this.say(saved === false ? '파일을 저장하지 못했습니다.' : '초기 상태를 내려받았습니다.', {error: saved === false});
    return document_;
  }
}
