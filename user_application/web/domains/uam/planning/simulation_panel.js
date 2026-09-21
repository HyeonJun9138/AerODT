// User/Application: the Simulation section of the work panel. The section is
// classified like the target chips (aircraft, satellite, UAM); the UAM class
// holds the vertiport tools, the route editor and, next, flight plans. It talks to the simulation
// API through an injected client and hands generated layouts to the map
// through callbacks; it keeps only the last fetched list and the server's form
// options, never a copy of map or twin state.
import {buildElement} from '../../../dom_builder.js';

export const FATO_ROLES = [['takeoff', '이륙'], ['landing', '착륙'], ['both', '이착륙']];
// Which edge of the deck a FATO stands off, in the vertiport's own frame: the
// front is the approach edge the name faces. Only the arrangements that line
// stands up along a taxiway offer it; the ones that put FATOs in the middle
// keep them there.
export const FATO_SIDES = [['front', '앞'], ['back', '뒤'], ['left', '왼쪽'], ['right', '오른쪽']];
// One choice that sets every FATO's side at once — the common decks — with the
// rows below for the odd one out.
export const FATO_PRESETS = [['custom', '직접 지정 (아래)'], ['front', '한쪽 (앞)'], ['ends', '앞뒤 반반'], ['sides', '좌우 반반'], ['around', '사방']];
export function presetSides(preset, count) {
  const pair = {ends: ['front', 'back'], sides: ['left', 'right']}[preset];
  if (preset === 'around') return Array.from({length: count}, (_, index) => ['front', 'back', 'left', 'right'][index % 4]);
  if (!pair) return Array.from({length: count}, () => 'front');
  const half = Math.ceil(count / 2);
  return Array.from({length: count}, (_, index) => pair[index < half ? 0 : 1]);
}
// The preset that produces these sides, or custom when none does.
export function presetFor(sides) {
  const found = FATO_PRESETS.map(([id]) => id).find(id => id !== 'custom' && presetSides(id, sides.length).every((side, index) => side === sides[index]));
  return found ?? 'custom';
}
export const CATEGORIES = [['aircraft', '항공기'], ['satellite', '위성'], ['uam', 'UAM']];
export const UAM_TABS = [['vertiports', '버티포트'], ['routes', '항로'], ['plans', '비행 계획']];
const PLANS_HINT = '비행 계획은 항로 위에 출발·도착 버티포트와 시각을 얹는 다음 단계입니다. 먼저 항로 탭에서 지점과 구간을 만드세요.';
const ROLE_LABEL = Object.fromEntries(FATO_ROLES);
const LIMITS = {gates: [1, 20], fatos: [1, 8], vehicle_d_m: [4, 30], platform_height_m: [0, 60], group: [1, 40]};
const PREVIEW_NAME = '새 버티포트';
const DIMENSION_HINT = '치수는 설계 기체 D값에서 자동 산출됩니다 (FATO 1.5 D · 게이트 1.2 D · 안전구역 0.25 D).';
// Offered until the server's options arrive, and kept if they never do.
const FALLBACK_OPTIONS = {
  patterns: [{id: 'row', label: '가로 일렬', description: '', fato_sides: true}, {id: 'column', label: '세로 일렬', description: '', fato_sides: true},
    {id: 'double', label: '양옆 이중', description: '', fato_sides: true}, {id: 'flank', label: 'FATO 중앙', description: '', fato_sides: false},
    {id: 'split', label: '좌우 분기', description: '', fato_sides: true}, {id: 'radial', label: '원형 배치', description: '', fato_sides: false},
    {id: 'court', label: '중정 사각', description: '', fato_sides: false}],
  fato_sides: FATO_SIDES.map(([id, label]) => ({id, label})),
  vehicle_classes: [{id: 'small', label: '소형 eVTOL (D 8 m)', d_m: 8}, {id: 'medium', label: '중형 eVTOL (D 12 m)', d_m: 12},
    {id: 'large', label: '대형 eVTOL (D 16 m)', d_m: 16}, {id: 'custom', label: '직접 입력', d_m: null}],
  ground_references: [{id: 'highest', label: '최고 지면 (기본)'}, {id: 'mean', label: '평균 지면'}, {id: 'lowest', label: '최저 지면'}, {id: 'manual', label: '직접 입력'}],
  defaults: {pattern: 'row', vehicle_class: 'medium', vehicle_d_m: 12, platform_height_m: 1, ground_reference: 'highest', gates: 4, fatos: 1, group: '미분류'},
  groups: [],
  limits: LIMITS,
};

// Form values -> definition the server accepts, or the reasons it would not.
export function definitionFromForm(values = {}, options = FALLBACK_OPTIONS) {
  const errors = [];
  const limits = {...LIMITS, ...(options.limits ?? {})};
  const name = String(values.name ?? '').trim();
  if (!name || name.length > 80) errors.push('이름을 1~80자로 입력하세요.');
  // What network this deck belongs to. Left blank it falls to the default
  // rather than refusing: a vertiport is worth placing before it is filed.
  const group = String(values.group ?? '').trim() || (options.defaults?.group ?? '미분류');
  const groupMax = (limits.group ?? [1, 40])[1];
  if (group.length > groupMax) errors.push(`분류를 1~${groupMax}자로 입력하세요.`);
  const number = (key, label, [low, high], {required = true, fallback = null} = {}) => {
    const raw = values[key];
    if (raw === '' || raw === undefined || raw === null) {
      if (required) errors.push(`${label}을(를) 입력하세요.`);
      return fallback;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < low || value > high) {
      errors.push(`${label}은(는) ${low}~${high} 사이 숫자여야 합니다.`);
      return null;
    }
    return value;
  };
  const latitude = number('latitude', '위도', [-90, 90]);
  const longitude = number('longitude', '경도', [-180, 180]);
  let heading = Number(values.heading_deg ?? 0);
  if (!Number.isFinite(heading)) heading = 0;
  heading = ((heading % 360) + 360) % 360;
  const gates = Number.parseInt(values.gates, 10);
  if (!Number.isInteger(gates) || gates < limits.gates[0] || gates > limits.gates[1]) errors.push(`게이트 수는 ${limits.gates[0]}~${limits.gates[1]} 사이 정수여야 합니다.`);
  const patterns = options.patterns ?? FALLBACK_OPTIONS.patterns;
  const pattern = patterns.some(p => p.id === values.pattern) ? values.pattern : (options.defaults?.pattern ?? 'row');
  // A FATO is a role, and on a lined-up deck a side; an older form gave the role alone.
  const entries = (Array.isArray(values.fatos) ? values.fatos : []).map(item => (typeof item === 'string' ? {role: item} : (item ?? {})));
  if (entries.length < limits.fatos[0] || entries.length > limits.fatos[1]) errors.push(`FATO는 ${limits.fatos[0]}~${limits.fatos[1]}개여야 합니다.`);
  const sided = patterns.find(p => p.id === pattern)?.fato_sides === true;
  const sides = (options.fato_sides ?? FALLBACK_OPTIONS.fato_sides).map(s => s.id);
  // The only FATO must serve arrivals and departures.
  const fatos = entries.map(item => ({role: entries.length === 1 || !ROLE_LABEL[item.role] ? 'both' : item.role,
    side: sided && sides.includes(item.side) ? item.side : 'front'}));
  const classes = options.vehicle_classes ?? FALLBACK_OPTIONS.vehicle_classes;
  const vehicleClass = classes.some(c => c.id === values.vehicle_class) ? values.vehicle_class : (options.defaults?.vehicle_class ?? 'medium');
  const custom = classes.find(c => c.id === vehicleClass)?.d_m == null;
  const vehicleD = custom ? number('vehicle_d_m', '기체 D값', limits.vehicle_d_m) : undefined;
  const platformHeight = number('platform_height_m', '판 높이', limits.platform_height_m, {required: false, fallback: options.defaults?.platform_height_m ?? 1});
  const references = (options.ground_references ?? FALLBACK_OPTIONS.ground_references).map(r => r.id);
  const groundReference = references.includes(values.ground_reference) ? values.ground_reference : (options.defaults?.ground_reference ?? 'highest');
  const altitude = groundReference === 'manual' ? number('altitude_m', '기준 고도', [-500, 10000]) : undefined;
  const takeoffHeight = number('takeoff_height_m', '이륙 상승 높이', [1,300], {required:false,fallback:30});
  const landingHeight = number('landing_height_m', '착륙 진입 높이', [1,300], {required:false,fallback:30});
  if (errors.length) return {errors};
  const definition = {name, group, latitude, longitude, heading_deg: heading, gates, pattern, vehicle_class: vehicleClass, platform_height_m: platformHeight,
    ground_reference: groundReference, fatos, takeoff_height_m:takeoffHeight, landing_height_m:landingHeight};
  if (custom) definition.vehicle_d_m = vehicleD;
  if (groundReference === 'manual') definition.altitude_m = altitude;
  return {definition};
}

export function describeVertiport(record) {
  const fatos = record.fatos ?? [];
  const takeoff = fatos.filter(f => f.role === 'takeoff' || f.role === 'both').length;
  const landing = fatos.filter(f => f.role === 'landing' || f.role === 'both').length;
  const edges = record.layout?.edges?.length;
  const where = Number.isFinite(record.latitude) && Number.isFinite(record.longitude)
    ? `${record.latitude.toFixed(4)}, ${record.longitude.toFixed(4)}` : '위치 미정';
  const network = Number.isFinite(edges) ? ` · 지상 경로 ${edges}` : '';
  const pattern = record.layout?.pattern_label ?? record.pattern ?? '';
  const size = Number.isFinite(record.vehicle_d_m) ? ` · D ${record.vehicle_d_m} m` : '';
  const head = pattern ? `${pattern}${size} · ` : size ? `${size.slice(3)} · ` : '';
  return `${head}게이트 ${record.gates} · FATO ${fatos.length} (이륙 ${takeoff} · 착륙 ${landing})${network} · ${where} · ${Math.round(record.heading_deg ?? 0)}°`;
}

export function describeDimensions(layout) {
  const d = layout?.dimensions, size = layout?.platform?.size_m;
  if (!d) return '';
  const metres = v => `${Math.round(v * 10) / 10}`;
  const parts = [`FATO Ø${metres(2 * d.fato_radius_m)} m`, `게이트 Ø${metres(2 * d.gate_radius_m)} m`, `유도로 폭 ${metres(d.taxiway_width_m)} m`];
  if (size) parts.push(`판 ${metres(size[0])} × ${metres(size[1])} m`);
  return parts.join(' · ');
}

export function roleLabel(role) {return ROLE_LABEL[role] ?? role;}

// Two definitions describe the same shape when only where it stands differs.
export function sameDesign(one, other) {
  const shape = ({latitude, longitude, name, ...rest}) => JSON.stringify(rest);
  return Boolean(one && other) && shape(one) === shape(other);
}

// How long after the last change the route-and-building check waits.
export const HEIGHT_CHECK_DELAY_MS = 450;
// How long after the last placement-tool tick the server is asked for the design.
export const TOOL_PREVIEW_DELAY_MS = 150;

export class SimulationPanel {
  constructor({api, notify = () => {}, onShow = () => {}, onPreview = () => {}, onFocus = () => {},
    onFollow = () => {}, onFollowMove = () => {}, onEditing = () => {}, rotateLayout = null,
    drawThumbnail = null, pickLocation = null, cancelPick = () => {}, document = globalThis.document,
    placeMenu = null, resumePick = () => {}, commitPick = () => {}, routePanel = null, planPanel = null,
    card = null, domainOnly = null, onVertiportEditor = () => {}, screenOf = () => null,
    setTimer = globalThis.setTimeout?.bind(globalThis), clearTimer = globalThis.clearTimeout?.bind(globalThis)}) {
    Object.assign(this, {api, notify, onShow, onPreview, onFocus, onFollow, onFollowMove, onEditing, rotateLayout, drawThumbnail, pickLocation, cancelPick, document, placeMenu, resumePick, commitPick, routePanel, planPanel, card, onVertiportEditor, screenOf, setTimer, clearTimer});
    // The last layout the server produced and the definition it answers, so a
    // heading edit can turn it locally before the server confirms.
    this.domainOnly=domainOnly;this.lastPreview = null;
    this.records = []; this.editingId = null; this.category = 'uam'; this.tab = 'vertiports'; this.previewTimer = null; this.body = null;
    this.options = FALLBACK_OPTIONS; this.optionsLoaded = false; this.picking = false; this.ready = Promise.resolve();
    // Design edits preview after a short pause; only the newest answer is shown.
    this.previewDelayMs = 60; this.previewSequence = 0;
    // The placement tools are dragged: a slider sends a change per pointer
    // event, and each one used to be a server round trip and a full preview
    // rebuild. Changes made with the tools wait for a short pause instead.
    this.toolPreviewDelayMs = TOOL_PREVIEW_DELAY_MS;
    // While picking, the preview follows the cursor: the pose moves every frame,
    // the layout is fetched once and again only when the design changes.
    this.followPose = null; this.followLayout = null; this.followPending = false;
    // Which situation the placement tools are open for: placing a new vertiport
    // at the cursor, or adjusting one that is already there.
    this.toolsMode = null;
    // The saved list is a summary the operator opens when they want it; the
    // form is what the tab is for, so the list starts closed.
    this.listOpen = false;
    // What the map measured under the preview deck, shown next to the dimensions.
    this.ground = null; this.dimensionText = '';
  }
  el(tag, props = {}, ...children) {return buildElement(this.document, tag, props, ...children);}
  // Whatever the current tab holds on the map is let go before another tab,
  // category or section takes the panel: an armed placement, route editing.
  leave() {
    this.editWatching=false;this.editGeneration=(this.editGeneration??0)+1;
    this.clearTimer?.(this.editPoll);this.editPoll=null;this.heightSequence=(this.heightSequence??0)+1;this.api.heightPreview?.(null,null);
    if (this.picking) this.cancelPick();
    this.routePanel?.deactivate();
    this.planPanel?.deactivate();
    this.card?.close({silent: true});
    if (this.toolsMode === 'edit') this.closeTools();
    this.onVertiportEditor(null);
  }
  // Escape closes the card this tab opened on the map, then whatever the route
  // tab has open. False when there was nothing to close.
  escape() {
    if (this.card?.isOpen) {this.card.close(); return true;}
    // The adjustment tools close on their own; the edit stays in the form so it
    // can still be saved or cancelled there.
    if (this.toolsMode === 'edit') {this.closeTools(); return true;}
    return this.routeEscape();
  }
  // The map answers to this tab while it is on screen: clicking or right
  // clicking a saved vertiport opens its card where the pointer is.
  armMap() {
    const active = this.category === 'uam' && this.tab === 'vertiports';
    this.onVertiportEditor(active
      ? {onSelect: hit => this.openVertiportCard(hit),
         onContextMenu: hit => this.openVertiportTools(this.records.find(item => item.id === hit?.id), hit?.screen)}
      : null);
  }
  // Two clicks to delete: the first only arms the button.
  dangerButton(remove) {
    const button = this.el('button', {type: 'button', text: '삭제', class: 'sim-danger'});
    button.onclick = () => {
      if (button.dataset.armed !== 'true') {
        button.dataset.armed = 'true'; button.textContent = '삭제 확인';
        this.setTimer?.(() => {button.dataset.armed = 'false'; button.textContent = '삭제';}, 4000);
        return;
      }
      void remove();
    };
    return button;
  }
  // A click on a saved vertiport opens the tools on it straight away, with a
  // look at it and its removal in the same card. There used to be a card in
  // between whose only real button was 편집, which made placing a vertiport
  // and adjusting one feel like two different features.
  openVertiportCard({id, screen} = {}) {
    const record = this.records.find(item => item.id === id);
    if (!record) return;
    this.openVertiportTools(record, screen);
  }
  // What else the tools offer on a saved vertiport: seeing it, and removing it.
  vertiportActions(record) {
    return [
      this.el('button', {type: 'button', class: 'place-look', text: '보기', onclick: () => this.onFocus(record)}),
      this.dangerButton(async () => {this.closeTools(); this.reset(); await this.remove(record);}),
    ];
  }
  // Escape while the route tab is open closes its card, then its adding mode.
  routeEscape() {return this.tab === 'routes' && this.category === 'uam' ? Boolean(this.routePanel?.escape()) : false;}
  async loadOptions() {
    if (this.optionsLoaded || typeof this.api?.options !== 'function') return;
    try {
      const options = await this.api.options();
      if (options?.patterns?.length && options?.vehicle_classes?.length) {this.options = {...FALLBACK_OPTIONS, ...options}; this.optionsLoaded = true;}
    } catch {/* the fallback options stay in force */}
  }
  render(body) {
    this.body = body;
    body.textContent = '';
    // The map answers to whichever tab is now on screen.
    this.armMap();
    const categories = this.el('div', {class: 'sim-categories', role: 'group', 'aria-label': '시뮬레이션 분류'});
    for (const [id, label] of CATEGORIES.filter(([id])=>!this.domainOnly||id===this.domainOnly)) {
      categories.append(this.el('button', {type: 'button', class: 'sim-category', id: `sim-category-${id}`,
        'aria-pressed': String(this.category === id), onclick: () => {this.leave(); this.category = id; this.render(body);}}, label));
    }
    body.append(categories);
    if (this.category !== 'uam') {
      const label = CATEGORIES.find(([id]) => id === this.category)?.[1] ?? this.category;
      body.append(this.el('p', {class: 'sim-empty', text: `${label} 시뮬레이션 도구는 준비 중입니다. 지금은 UAM 분류에서 버티포트를 만들 수 있습니다.`}));
      this.ready = Promise.resolve();
      return;
    }
    const tabs = this.el('div', {class: 'sim-tabs', role: 'tablist'});
    for (const [id, label] of UAM_TABS) {
      tabs.append(this.el('button', {type: 'button', class: 'sim-tab', role: 'tab', id: `sim-tab-${id}`,
        'aria-selected': String(this.tab === id), onclick: () => {if (this.tab === id) return; this.leave(); this.tab = id; this.render(body);}}, label));
    }
    body.append(tabs);
    if (this.tab === 'routes') {
      if (!this.routePanel) {
        body.append(this.el('p', {class: 'sim-empty', text: '항로 편집기가 준비되지 않았습니다.'}));
        this.ready = Promise.resolve();
        return;
      }
      const slot = this.el('div', {id: 'route-slot'});
      body.append(slot);
      this.routePanel.render(slot);
      this.routePanel.activate();
      this.ready = this.routePanel.ready;
      return;
    }
    if (this.tab === 'plans') {
      if (!this.planPanel) {
        body.append(this.el('p', {class: 'sim-empty', id: 'plans-hint', text: PLANS_HINT}));
        this.ready = Promise.resolve();
        return;
      }
      const slot = this.el('div', {id: 'plan-slot'});
      body.append(slot);
      this.ready = this.planPanel.render(slot);
      return;
    }
    // The form is what this tab is for, so it comes first; the saved list is a
    // summary under it that opens when the operator asks for it.
    body.append(this.el('h3', {class: 'sim-heading', id: 'vertiport-form-title', text: '새 버티포트'}));
    const formSlot = this.el('div', {id: 'vertiport-form-slot'});
    body.append(formSlot);
    this.listToggle = this.el('button', {type: 'button', class: 'sim-heading sim-toggle', id: 'vertiport-list-toggle',
      'aria-expanded': String(this.listOpen), 'aria-controls': 'vertiport-list',
      onclick: () => {this.listOpen = !this.listOpen; this.renderList();}});
    this.list = this.el('ul', {class: 'sim-list', id: 'vertiport-list'});
    body.append(this.listToggle, this.list);
    this.renderList();
    // Options first so the form offers the server's patterns and classes; once
    // they are known the form appears at once, so re-rendering never flickers.
    const mount = () => {
      if (this.body !== body) return;
      formSlot.textContent = ''; formSlot.append(this.form());
      this.editWatching=true;this.editGeneration=(this.editGeneration??0)+1;void this.pollEditState();
      // Coming back to the tab, the shape that was last worked out is drawn at
      // once, so the frame is never empty while the server answers again.
      if (this.lastPreview) this.showThumbnail(this.lastPreview.layout, this.lastPreview.definition.name);
      this.schedulePreview(0);   // the default design has a shape before anything is typed
      return this.refresh();
    };
    const needsOptions = !this.optionsLoaded && typeof this.api?.options === 'function';
    this.ready = needsOptions ? this.loadOptions().then(mount) : Promise.resolve(mount());
  }
  renderList() {
    if (!this.list) return;
    if (this.listToggle) {
      this.listToggle.textContent = `생성된 버티포트 ${this.records.length}`;
      this.listToggle.setAttribute('aria-expanded', String(this.listOpen));
    }
    this.list.hidden = !this.listOpen;
    if (this.list.hidden) this.list.setAttribute('hidden', ''); else this.list.removeAttribute('hidden');
    this.list.textContent = '';
    if (!this.listOpen) return;
    if (!this.records.length) {
      this.list.append(this.el('li', {class: 'sim-empty', text: '저장된 버티포트가 없습니다. 아래에서 새로 만드세요.'}));
      return;
    }
    for (const record of this.records) {
      const actions = this.el('div', {class: 'sim-item-actions'},
        this.el('button', {type: 'button', text: '보기', onclick: () => this.onFocus(record)}),
        this.el('button', {type: 'button', text: '편집', onclick: () => this.edit(record)}));
      actions.append(this.dangerButton(() => this.remove(record)));
      this.list.append(this.el('li', {class: 'sim-item', 'data-id': record.id},
        this.el('strong', {text: record.name}), this.el('span', {text: describeVertiport(record)}), actions));
    }
  }
  form() {
    const options = this.options, defaults = options.defaults ?? FALLBACK_OPTIONS.defaults;
    const form = this.form_ = this.el('form', {class: 'sim-form', id: 'vertiport-form', novalidate: ''});
    const field = (label, name, props = {}) => this.el('label', {}, this.el('span', {text: label}),
      this.el('input', {name, ...props, oninput: () => this.schedulePreview()}));
    const select = (label, name, items, value, onchange) => {
      const node = this.el('select', {name, onchange: () => {onchange?.(); this.schedulePreview();}});
      // The default carries the selected attribute so a form reset returns to it.
      for (const item of items) node.append(this.el('option', {value: item.id, text: item.label, title: item.description || undefined, selected: item.id === value ? '' : undefined}));
      node.value = value;
      return this.el('label', {}, this.el('span', {text: label}), node);
    };
    const row = (...children) => this.el('div', {class: 'sim-row'}, ...children);
    const group = (title, ...children) => this.el('fieldset', {class: 'sim-fieldset'}, this.el('legend', {text: title}), ...children);

    // The shape comes first: it answers what is being made before any of the
    // fields that change it, and it is the one part that needs no position.
    // Hidden until it has something on it: an empty canvas would stand in the
    // frame with the waiting line squashed beside it.
    this.thumb = this.el('canvas', {id: 'vertiport-thumb', width: '300', height: '186', role: 'img', hidden: '',
      'aria-label': '설계한 버티포트의 예상 형상'});
    this.thumbEmpty = this.el('p', {class: 'sim-thumb-empty', id: 'vertiport-thumb-empty',
      text: '예상 형상을 그리는 중입니다.'});
    this.dimensions = this.el('p', {class: 'sim-dimensions', id: 'vertiport-dimensions', text: DIMENSION_HINT});
    form.append(this.el('div', {class: 'sim-thumb', id: 'vertiport-preview'}, this.thumb, this.thumbEmpty), this.dimensions);

    this.pickButton = this.el('button', {type: 'button', text: '지도에서 선택', id: 'vertiport-pick', 'aria-pressed': 'false', onclick: () => void this.pick()});
    // A deck belongs to a network, and the network is what people select by.
    // The list offers what is already in use so the same one is not spelled two
    // ways; typing over it makes a new one, which is how the first 울산 deck
    // gets a 울산 to belong to.
    this.groupList = this.el('datalist', {id: 'vertiport-group-list'});
    const groupField = field('분류', 'group', {type: 'text', maxlength: String(LIMITS.group[1]),
      list: 'vertiport-group-list', placeholder: '예: 수도권 · 목록에 없으면 새로 입력'});
    groupField.append(this.groupList);
    this.paintGroupChoices();
    form.append(group('위치',
      row(field('이름', 'name', {type: 'text', maxlength: '80', placeholder: '예: 김포 버티허브'}), groupField),
      row(field('위도', 'latitude', {type: 'number', step: '0.000001', min: '-90', max: '90'}),
        field('경도', 'longitude', {type: 'number', step: '0.000001', min: '-180', max: '180'})),
      this.el('div', {class: 'sim-row sim-locate'}, this.pickButton)));

    const headingField = field('방향 (°)', 'heading_deg', {type: 'number', step: '1', min: '-360', max: '360', value: '0'});
    headingField.querySelector('input').oninput = () => {
      if (this.headingChanged()) {this.dropHeightConflicts(); if (this.lastPreview) this.scheduleHeightCheck(this.lastPreview.definition);}
      else this.schedulePreview();
    };
    form.append(group('배치',
      row(select('배치 형태', 'pattern', options.patterns, defaults.pattern, () => this.syncFatoRoles()), headingField),
      row(field('게이트 수', 'gates', {type: 'number', step: '1', min: '1', max: '20', value: String(defaults.gates)}),
        field('FATO 수', 'fato_count', {type: 'number', step: '1', min: '1', max: '8', value: String(defaults.fatos)}))));

    const classes = options.vehicle_classes;
    const sizeField = field('기체 D값 (m)', 'vehicle_d_m', {type: 'number', step: '0.1', min: String(LIMITS.vehicle_d_m[0]), max: String(LIMITS.vehicle_d_m[1]),
      value: String(defaults.vehicle_d_m)});
    const sizeInput = sizeField.querySelector('input');
    const applyClass = () => {
      const chosen = classes.find(c => c.id === this.form_.querySelector('[name=vehicle_class]').value);
      const fixed = chosen?.d_m != null;
      if (fixed) sizeInput.value = String(chosen.d_m);
      sizeInput.disabled = fixed;
      if (fixed) sizeInput.setAttribute('disabled', ''); else sizeInput.removeAttribute('disabled');
    };
    // Uneven ground: choose which ground the deck refers to, or type the altitude.
    const altitudeField = field('기준 고도 (m)', 'altitude_m', {type: 'number', step: '0.1', min: '-500', max: '10000', placeholder: '자동'});
    const altitudeInput = altitudeField.querySelector('input');
    const applyReference = () => {
      const manual = this.form_.querySelector('[name=ground_reference]').value === 'manual';
      altitudeInput.disabled = !manual;
      if (manual) altitudeInput.removeAttribute('disabled'); else altitudeInput.setAttribute('disabled', '');
      if (manual && altitudeInput.value === '' && this.ground) altitudeInput.value = String(Math.round(this.ground.max * 10) / 10);
    };
    form.append(group('기체와 판',
      row(select('설계 기체', 'vehicle_class', classes, defaults.vehicle_class, applyClass), sizeField),
      row(field('판 높이 (m)', 'platform_height_m', {type: 'number', step: '0.1', min: String(LIMITS.platform_height_m[0]), max: String(LIMITS.platform_height_m[1]), value: String(defaults.platform_height_m)}),
        select('판 기준', 'ground_reference', options.ground_references ?? FALLBACK_OPTIONS.ground_references, defaults.ground_reference ?? 'highest', applyReference)),
      row(altitudeField)));

    this.fatoBox = this.el('div', {class: 'sim-fatos', id: 'fato-roles'});
    // Where the FATOs stand, in one choice; the rows below hold each one's own.
    this.fatoPreset = this.el('select', {name: 'fato_preset', id: 'fato-preset', onchange: () => {this.applyPreset(); this.schedulePreview();}});
    for (const [value, label] of FATO_PRESETS) this.fatoPreset.append(this.el('option', {value, text: label}));
    form.append(group('FATO 속성 (F1부터)',
      this.el('label', {class: 'sim-fato-preset'}, this.el('span', {text: 'FATO 배치'}), this.fatoPreset), this.fatoBox));
    form.querySelector('[name=fato_count]').oninput = () => {this.syncFatoRoles(); this.schedulePreview();};

    form.append(group('이착륙 높이 (패드 상면 기준)',
      row(field('이륙 상승 높이 (m)', 'takeoff_height_m', {type:'number',min:'1',max:'300',step:'1',value:'30'}),
          field('착륙 진입 높이 (m)', 'landing_height_m', {type:'number',min:'1',max:'300',step:'1',value:'30'}))));
    this.editNotice=this.el('p',{class:'sim-error',role:'status'});
    this.heightReport=this.el('p',{class:'route-note',role:'status',text:'높이 변경 시 연결 경로의 건물 충돌을 검사합니다. 저장 후 다음 계획 생성에 반영됩니다.'});
    form.append(this.editNotice,this.heightReport);
    this.error = this.el('p', {class: 'sim-error' , role: 'alert', id: 'vertiport-error'});
    this.cancel = this.el('button', {type: 'button', text: '취소', hidden: '', id: 'vertiport-cancel', onclick: () => this.reset()});
    form.append(this.el('div', {class: 'sim-actions'}, this.el('button', {type: 'submit', text: '저장', id: 'vertiport-save'}), this.cancel));
    form.append(this.error);
    form.onsubmit = event => {event.preventDefault(); void this.save();};
    applyClass();
    applyReference();
    this.syncFatoRoles();
    return form;
  }
  // Whether the chosen arrangement lets a FATO stand off any edge of the deck.
  patternHasSides() {
    const chosen = this.form_?.querySelector('[name=pattern]')?.value;
    return (this.options.patterns ?? FALLBACK_OPTIONS.patterns).find(p => p.id === chosen)?.fato_sides === true;
  }
  // Each FATO's role and side, F1 first. `fatos` may give them; otherwise the
  // rows keep what they have while the count changes.
  syncFatoRoles(fatos = null) {
    const count = Math.max(1, Math.min(8, Number.parseInt(this.form_.querySelector('[name=fato_count]').value, 10) || 1));
    const current = (fatos ?? this.fatoRoles()).map(item => (typeof item === 'string' ? {role: item} : (item ?? {})));
    const sided = this.patternHasSides();
    const off = (select, why) => {select.disabled = true; select.setAttribute('disabled', ''); select.setAttribute('title', why);};
    this.fatoBox.textContent = '';
    const sides = [];
    for (let index = 0; index < count; index++) {
      const role = this.el('select', {name: `fato_role_${index}`, onchange: () => this.schedulePreview()});
      for (const [value, label] of FATO_ROLES) role.append(this.el('option', {value, text: label}));
      role.value = count === 1 ? 'both' : (current[index]?.role ?? 'both');
      // A single FATO has no choice: it takes off and lands.
      if (count === 1) off(role, 'FATO가 하나면 이착륙을 함께 맡습니다');
      const side = this.el('select', {name: `fato_side_${index}`, onchange: () => {this.fatoPreset.value = presetFor(this.fatoRoles().map(f => f.side)); this.schedulePreview();}});
      for (const item of this.options.fato_sides ?? FALLBACK_OPTIONS.fato_sides) side.append(this.el('option', {value: item.id, text: item.label}));
      side.value = sided ? (current[index]?.side ?? 'front') : 'front';
      if (!sided) off(side, '이 배치는 FATO를 가운데 둡니다');
      sides.push(side.value);
      this.fatoBox.append(this.el('label', {class: 'sim-fato'}, this.el('span', {text: `F${index + 1}`}), role, side));
    }
    if (this.fatoPreset) {
      this.fatoPreset.value = presetFor(sides);
      this.fatoPreset.disabled = !sided;
      if (sided) this.fatoPreset.removeAttribute('disabled'); else this.fatoPreset.setAttribute('disabled', '');
    }
  }
  applyPreset() {
    const preset = this.fatoPreset?.value;
    if (!preset || preset === 'custom') return;
    const sides = presetSides(preset, this.fatoRoles().length);
    this.syncFatoRoles(this.fatoRoles().map((fato, index) => ({...fato, side: sides[index]})));
  }
  fatoRoles() {
    return [...this.fatoBox.querySelectorAll('.sim-fato')].map(row => {
      const [role, side] = row.querySelectorAll('select');
      return {role: role.value, side: side?.value ?? 'front'};
    });
  }
  // Every group already in use, from the server's answer and from the decks on
  // screen, so one that was just made is offered before the options are re-read.
  groupChoices() {
    return [...new Set([...(this.options.groups ?? []),
      ...this.records.map(record => String(record.group ?? '').trim())].filter(Boolean))].sort();
  }
  paintGroupChoices() {
    if (!this.groupList) return;
    this.groupList.textContent = '';
    for (const name of this.groupChoices()) this.groupList.append(this.el('option', {value: name}));
  }
  values() {
    const read = name => this.form_.querySelector(`[name=${name}]`)?.value;
    return {group: read('group'), name: read('name'), latitude: read('latitude'), longitude: read('longitude'), heading_deg: read('heading_deg'),
      pattern: read('pattern'), vehicle_class: read('vehicle_class'), vehicle_d_m: read('vehicle_d_m'),
      takeoff_height_m:read('takeoff_height_m'), landing_height_m:read('landing_height_m'), platform_height_m: read('platform_height_m'), ground_reference: read('ground_reference'), altitude_m: read('altitude_m'),
      gates: read('gates'), fatos: this.fatoRoles()};
  }
  fill(record) {
    this.heightSequence=(this.heightSequence??0)+1;this.api.heightPreview?.(null,null);
    const set = (name, value) => {const input = this.form_.querySelector(`[name=${name}]`); if (input) input.value = value == null ? '' : String(value);};
    this.paintGroupChoices();
    set('name', record.name); set('group', record.group ?? this.options.defaults?.group ?? '미분류');
    set('latitude', record.latitude); set('longitude', record.longitude);
    set('heading_deg', record.heading_deg ?? 0); set('gates', record.gates); set('fato_count', (record.fatos ?? []).length || 1);
    set('pattern', record.pattern ?? this.options.defaults?.pattern ?? 'row');
    const classes = this.options.vehicle_classes;
    const vehicleClass = classes.some(c => c.id === record.vehicle_class) ? record.vehicle_class
      : (Number.isFinite(record.vehicle_d_m) ? 'custom' : (this.options.defaults?.vehicle_class ?? 'medium'));
    set('vehicle_class', vehicleClass);
    this.form_.querySelector('[name=vehicle_class]').onchange?.();
    if (classes.find(c => c.id === vehicleClass)?.d_m == null) set('vehicle_d_m', record.vehicle_d_m ?? this.options.defaults?.vehicle_d_m ?? 12);
    set('takeoff_height_m',record.takeoff_height_m ?? 30);set('landing_height_m',record.landing_height_m ?? 30);
    set('platform_height_m', record.platform_height_m ?? this.options.defaults?.platform_height_m ?? 1);
    set('ground_reference', record.ground_reference ?? this.options.defaults?.ground_reference ?? 'highest');
    set('altitude_m', record.ground_reference === 'manual' ? record.altitude_m : '');
    this.form_.querySelector('[name=ground_reference]').onchange?.();
    this.syncFatoRoles((record.fatos ?? []).map(f => ({role: f.role, side: f.side ?? 'front'})));
  }
  edit(record) {
    if (!this.form_) return;
    this.editingId = record.id; this.fill(record); this.cancel.hidden = false;
    // What is on the map now is the old shape; it goes faint so the preview of
    // the edit is the one that reads solid.
    this.onEditing(record.id);
    this.body.querySelector('#vertiport-form-title').textContent = `버티포트 편집 · ${record.name}`;
    this.schedulePreview(0);
  }
  reset() {
    this.heightSequence=(this.heightSequence??0)+1;this.api.heightPreview?.(null,null);
    this.editingId = null; this.lastPreview = null; this.form_.reset(); this.cancel.hidden = true; this.error.textContent = '';
    this.onEditing(null);
    this.body.querySelector('#vertiport-form-title').textContent = '새 버티포트';
    this.form_.querySelector('[name=vehicle_class]').onchange?.();
    this.form_.querySelector('[name=ground_reference]').onchange?.();
    this.ground = null; this.dimensionText = '';
    if (this.dimensions) this.dimensions.textContent = DIMENSION_HINT;
    this.syncFatoRoles([]); this.onPreview(null);
    this.schedulePreview(0);   // the empty form still has a shape to show
  }
  // The map reports where a deck ended up; only the preview's reading is shown.
  groundPlaced(id, info) {
    if (id !== '__preview__' || !info) return;
    this.ground = info;
    this.showDimensions();
    this.showGround();
  }
  // The measured ground, repeated on the parked tools so the deck height is
  // raised against a reading rather than a guess.
  showGround() {
    if (!this.placeMenu?.isOpen || !this.ground || !Number.isFinite(this.ground.min)) return;
    this.placeMenu.setNote(`지면 ${this.ground.min.toFixed(1)}~${this.ground.max.toFixed(1)} m · 상면 ${this.ground.top.toFixed(1)} m`);
  }
  showDimensions() {
    if (!this.dimensions) return;
    const ground = this.ground && Number.isFinite(this.ground.min)
      ? ` · 지면 ${this.ground.min.toFixed(1)}~${this.ground.max.toFixed(1)} m · 상면 ${this.ground.top.toFixed(1)} m` : '';
    this.dimensions.textContent = (this.dimensionText || DIMENSION_HINT) + ground;
  }
  // The expected shape, redrawn whenever the server answers with a layout. A
  // canvas the page cannot draw on simply says nothing.
  showThumbnail(layout, name = '') {
    if (!this.thumb) return;
    const drawn = typeof this.drawThumbnail === 'function' && Boolean(this.drawThumbnail(layout, name, this.thumb));
    this.thumb.hidden = !drawn;
    if (this.thumbEmpty) this.thumbEmpty.hidden = drawn;
  }
  setPosition({latitude, longitude}) {
    const set = (name, value) => {const input = this.form_.querySelector(`[name=${name}]`); if (input) input.value = value;};
    set('latitude', latitude.toFixed(6)); set('longitude', longitude.toFixed(6));
    this.error.textContent = '';
    this.schedulePreview(0);
  }
  // One click on the map answers with a position; a second press or Escape
  // cancels. Meanwhile the preview follows the cursor.
  async pick() {
    if (typeof this.pickLocation !== 'function') {this.error.textContent = '지도가 준비되면 지도에서 위치를 고를 수 있습니다.'; return;}
    if (this.picking) {this.cancelPick(); return;}
    this.picking = true;
    this.followPose = null; this.followLayout = null; this.followPending = false;
    this.pickButton.textContent = '지도를 클릭하세요 (Esc 취소)';
    this.pickButton.setAttribute('aria-pressed', 'true');
    this.error.textContent = '';
    let position = null;
    try {
      position = await this.pickLocation({onMove: pose => this.followCursor(pose),
        onTools: (pose, screen) => this.openTools(pose, screen), onRelease: () => this.closeTools()});
    } catch {position = null;}
    this.picking = false;
    this.closeTools();
    this.followPose = null; this.followLayout = null; this.followPending = false;
    this.pickButton.textContent = '지도에서 선택';
    this.pickButton.setAttribute('aria-pressed', 'false');
    if (position && Number.isFinite(position.latitude) && Number.isFinite(position.longitude)) this.setPosition(position);
    else {this.error.textContent = '위치 선택을 취소했습니다.'; this.schedulePreview(0);}
  }
  // The map parked the preview where the operator right-clicked: hold that pose
  // and offer the three tools there. Every change is written into the form, so
  // the tools and the panel always describe the same vertiport.
  openTools(pose, screen) {
    if (!this.placeMenu || !this.form_) return;
    this.toolsMode = 'place';
    this.followPose = pose;
    const count = this.form_.querySelector('[name=fato_count]')?.value;
    this.placeMenu.open({screen, values: {...this.values(), fato_count: count}, options: this.options,
      limits: {...LIMITS, ...(this.options.limits ?? {})}});
    this.showGround();
  }
  closeTools() {this.placeMenu?.close(); this.toolsMode = null;}
  // The same tools on a vertiport that is already there: the record goes into
  // the form and the card beside the pointer adjusts it, so a height or a
  // heading is changed where it stands instead of across the panel.
  openVertiportTools(record, screen) {
    if (!record || !this.placeMenu || !this.form_) return;
    this.card?.close({silent: true});
    this.edit(record);
    this.showVertiportTools(record, screen);
  }
  // The tools over whatever the form currently says, so reopening them after a
  // move keeps the new position instead of reading the record again.
  showVertiportTools(record, screen) {
    if (!record || !this.placeMenu || !this.form_) return;
    this.toolsMode = 'edit';
    const count = this.form_.querySelector('[name=fato_count]')?.value;
    this.placeMenu.open({screen: screen ?? this.screenFor(record), values: {...this.values(), fato_count: count},
      options: this.options, limits: {...LIMITS, ...(this.options.limits ?? {})},
      title: `수정 · ${record.name}`, confirmLabel: '저장', dismissLabel: '취소',
      note: `${describeVertiport(record)} · 바꾸면 지도에 바로 보이고, 저장해야 남습니다 · Esc 닫기`,
      actions: this.vertiportActions(record),
      onConfirm: () => {this.closeTools(); void this.save();},
      onDismiss: () => {this.closeTools(); this.reset();},
      onRelocate: typeof this.pickLocation === 'function' ? () => void this.relocateVertiport(record) : null});
    this.showGround();
  }
  // Pick the vertiport up: the map goes back to following the cursor, and when
  // a place is chosen the tools come back there so it can be saved.
  async relocateVertiport(record) {
    if (typeof this.pickLocation !== 'function') return;
    this.closeTools();
    await this.pick();
    if (this.editingId !== record.id) return;
    const values = this.values();
    const screen = this.screenOf({longitude: Number(values.longitude), latitude: Number(values.latitude), height: 0});
    this.showVertiportTools(record, screen ?? undefined);
  }
  // Where a saved vertiport is on screen, for tools opened from the list.
  screenFor(record) {
    const frame = record.layout?.frame ?? record;
    return this.screenOf({longitude: frame.longitude, latitude: frame.latitude, height: 0}) ?? {x: 120, y: 120};
  }
  get toolsOpen() {return Boolean(this.placeMenu?.isOpen);}
  // A tool moved: the form field it names is the one that changes, and the
  // preview follows from there exactly as a panel edit would.
  toolChanged(name, value) {
    if(this.editLocked){this.notify('error',this.editNotice?.textContent);return;}
    const input = this.form_?.querySelector(`[name=${name}]`);
    if (!input) return;
    input.value = String(value);
    if (name === 'fato_count') this.syncFatoRoles();
    // A turn is a rigid transform of the last answer, applied on the spot; the
    // server would only say the same and the map would rebuild the same deck
    // again. Only the building check has to look at the turned deck.
    if (name === 'heading_deg' && this.headingChanged()) {
      this.dropHeightConflicts();
      if (this.lastPreview) this.scheduleHeightCheck(this.lastPreview.definition);
      return;
    }
    this.schedulePreview(this.toolPreviewDelayMs);
  }
  // Finish the placement where the tools are, instead of asking for one more click.
  placeWithTools() {
    if (this.toolsMode !== 'place') return;
    const pose = this.followPose;
    this.closeTools();
    if (pose) this.commitPick(pose); else this.cancelPick();
  }
  // Back to following the cursor, leaving every adjustment in place.
  resumeTools() {
    const placing = this.toolsMode === 'place';
    this.closeTools();
    if (placing) this.resumePick();
  }
  followCursor(pose) {
    if (!this.picking || !pose) return;
    this.followPose = pose;
    if (this.followLayout) {this.onFollowMove(pose); return;}
    // A layout for this design is often already on screen: show it at the
    // cursor immediately, and let the server's answer replace it.
    const parsed = this.followDefinition(pose);
    if (!parsed.errors && this.lastPreview && sameDesign(parsed.definition, this.lastPreview.definition)) {
      this.followLayout = this.lastPreview.layout;
      this.onFollow(this.lastPreview.layout, parsed.definition.name, pose);
    }
    if (this.followPending) return;
    this.followPending = true;
    void this.preview().finally(() => {this.followPending = false;});
  }
  // Previews substitute a name so the model shows before one is typed; saving
  // still needs it. The shape does not depend on where the vertiport stands
  // either, so a position stands in as well and `positioned` says whether the
  // form gave a real one — only the map waits for that.
  previewValues() {
    const values = this.values();
    if (!String(values.name ?? '').trim()) values.name = PREVIEW_NAME;
    const given = key => String(values[key] ?? '').trim() !== '' && Number.isFinite(Number(values[key]));
    values.positioned = given('latitude') && given('longitude');
    if (!values.positioned) {values.latitude = '0'; values.longitude = '0';}
    return values;
  }
  followDefinition(pose) {
    const values = this.previewValues();
    values.latitude = String(pose.latitude); values.longitude = String(pose.longitude);
    return definitionFromForm(values, this.options);
  }
  // A heading edit turns the last layout at once when nothing else changed;
  // the server's answer, requested as usual, then replaces it with the same shape.
  // True when the turn was applied here, so no server answer is needed for it.
  headingChanged() {
    const last = this.lastPreview;
    if (!last || typeof this.rotateLayout !== 'function') return false;
    const following = this.picking && this.followPose ? this.followPose : null;
    const parsed = following ? this.followDefinition(following) : definitionFromForm(this.previewValues(), this.options);
    if (parsed.errors) return false;
    const same = key => key === 'heading_deg' || JSON.stringify(parsed.definition[key]) === JSON.stringify(last.definition[key]);
    if (!Object.keys(parsed.definition).every(same) || !Object.keys(last.definition).every(same)) return false;
    const layout = this.rotateLayout(last.layout, parsed.definition.heading_deg);
    this.lastPreview = {definition: parsed.definition, layout};
    this.showThumbnail(layout, parsed.definition.name);
    if (following) {this.followLayout = layout; this.onFollow(layout, parsed.definition.name, this.followPose);}
    else if (parsed.definition.latitude !== 0 || parsed.definition.longitude !== 0) this.onPreview(layout, parsed.definition.name);
    return true;
  }
  // A changed design makes every earlier building report an answer about a
  // deck that is no longer there.
  dropHeightConflicts() {this.heightSequence=(this.heightSequence??0)+1;this.api.heightConflicts?.({});}
  schedulePreview(delay = this.previewDelayMs) {
    this.dropHeightConflicts();
    if (this.previewTimer !== null) this.clearTimer?.(this.previewTimer);
    this.previewTimer = this.setTimer?.(() => {this.previewTimer = null; void this.preview();}, delay) ?? null;
  }
  async preview() {
    const following = this.picking && this.followPose ? this.followPose : null;
    const values = this.previewValues();
    const placed = Boolean(following) || values.positioned;
    const parsed = following ? this.followDefinition(following) : definitionFromForm(values, this.options);
    if (parsed.errors) {if (!following) {this.onPreview(null); this.showThumbnail(null);} return;}
    const sequence = ++this.previewSequence;
    try {
      const {layout} = await this.api.preview(parsed.definition);
      if (sequence !== this.previewSequence) return;
      this.scheduleHeightCheck(parsed.definition);
      this.lastPreview = {definition: parsed.definition, layout};
      this.dimensionText = describeDimensions(layout);
      this.showDimensions();
      this.showThumbnail(layout, parsed.definition.name);
      if (following && this.picking) {
        this.followLayout = layout;
        this.onFollow(layout, parsed.definition.name, this.followPose ?? following);
      } else {
        // Without a position there is nowhere on the map to put it; the form
        // still shows what it would be.
        this.onPreview(placed ? layout : null, placed ? parsed.definition.name : undefined);
      }
    } catch {if (sequence === this.previewSequence && !following) this.onPreview(null);}
  }
  async readEditState() {
    if(!this.api.editState)return {locked:false};
    const generation=this.editGeneration,read=this.editRead=(this.editRead??0)+1;
    let state;try{state=await this.api.editState();}catch(error){state={locked:true,message:error?.status===404||/HTTP 404/.test(error?.message??'')?'현재 서버에 편집 상태 API가 없습니다. AeroDT 서버를 재시작한 뒤 새로고침해 주세요.':'서버 상태를 확인할 수 없어 편집을 잠갔습니다. 연결을 확인해 주세요.'};}
    if(generation!==this.editGeneration||read!==this.editRead)return state;
    this.editLocked=Boolean(state.locked);this.editLockMessage=state.message;
    if(this.editNotice)this.editNotice.textContent=state.message??'';
    for(const field of this.form_?.querySelectorAll('fieldset')??[])field.disabled=this.editLocked;
    const save=this.form_?.querySelector('#vertiport-save');if(save)save.disabled=this.editLocked;
    if(this.editLocked){this.api.heightPreview?.(null,null);this.heightSequence=(this.heightSequence??0)+1;}
    return state;
  }
  async pollEditState(){
    this.clearTimer?.(this.editPoll);
    const generation=this.editGeneration;await this.readEditState();
    if(generation===this.editGeneration&&this.category==='uam'&&this.editWatching&&this.body?.isConnected&&this.tab==='vertiports')this.editPoll=this.setTimer?.(()=>void this.pollEditState(),1000);
  }
  // The route-and-building check for a changed height is the slow part of an
  // edit: seconds while the building cells under the routes are fetched, and
  // half a second a batch after. Fired from every slider tick it queued up
  // behind itself and answered "판정 불가" while the server was busy with the
  // previous one. So it waits for the operator to pause, runs one at a time,
  // and runs once more at the end if the value moved while it was running.
  scheduleHeightCheck(definition) {
    this.pendingHeightDefinition = definition;
    if (this.heightReport && this.editingId && !this.editLocked) this.heightReport.textContent = '변경 높이의 경로 및 건물 충돌 검사 대기 중…';
    if (this.heightCheckTimer !== null && this.heightCheckTimer !== undefined) this.clearTimer?.(this.heightCheckTimer);
    this.heightCheckTimer = this.setTimer?.(() => {this.heightCheckTimer = null; void this.runHeightCheck();}, HEIGHT_CHECK_DELAY_MS) ?? null;
  }
  async runHeightCheck() {
    if (this.heightCheckBusy) {this.heightCheckAgain = true; return;}
    const definition = this.pendingHeightDefinition;
    if (!definition) return;
    this.heightCheckBusy = true;
    try {await this.checkHeightPreview(definition);}
    finally {
      this.heightCheckBusy = false;
      if (this.heightCheckAgain) {
        this.heightCheckAgain = false;
        if (this.pendingHeightDefinition !== definition) void this.runHeightCheck();
      }
    }
  }
  async checkHeightPreview(definition){
    if(!this.api.checkHeights||!this.heightReport)return;
    const seq=this.heightSequence=(this.heightSequence??0)+1;
    if(!this.editingId||this.editLocked){this.api.heightPreview?.(null,null);this.heightReport.textContent=this.editLocked?(this.editLockMessage||'편집 상태 확인을 기다리고 있습니다.'):'버티포트를 저장하고 항로를 연결한 후 높이 검사가 가능합니다.';return;}
    const id=this.editingId;
    const saved=this.records.find(r=>r.id===id);
    if(saved&&(['latitude','longitude','heading_deg','platform_height_m','altitude_m'].some(k=>Number(saved[k]??0)!==Number(definition[k]??0))||['pattern','ground_reference','gates','vehicle_class'].some(k=>String(saved?.[k]??'')!==String(definition[k]??'')))){
      this.api.heightPreview?.(null,null);this.heightReport.textContent='판정 불가: 위치·데크 형상 변경을 먼저 저장한 후 이착륙 높이를 검사해 주세요.';return;
    }
    this.api.heightPreview?.(id,definition);
    this.heightReport.textContent='변경 높이의 경로 및 건물 충돌 검사 중…';
    try{
      const answer=await this.api.checkHeights(id,definition);
      if(seq!==this.heightSequence)return;
      this.api.heightConflicts?.(answer.links??{});
      const reports=Object.values(answer.links??{});
      const terrain=reports.reduce((n,r)=>n+(r.terrain_collisions??0),0);
      const terrainKnown=reports.length&&reports.every(r=>(r.terrain_checked??0)>0);
      const hits=reports.reduce((n,r)=>n+(r.collisions??0),0),tight=reports.reduce((n,r)=>n+(r.tight??0),0);
      const gaps=reports.flatMap(r=>r.buildings??[]).map(b=>b.clearance_m).filter(Number.isFinite);
      this.heightReport.textContent=!reports.length?'판정 불가: 연결 경로 또는 장애물 자료가 없습니다.':
        `건물 충돌 ${hits}건, 근접 ${tight}건 / ${terrainKnown?'지형 침범 '+terrain+'표본':'지형 판정 불가'}${gaps.length?' / 최소 여유 '+Math.min(...gaps).toFixed(1)+' m':''}. 연결 경로 중심선 표본 기준. 수직 이착륙 구간·미수신 장애물은 별도 확인이 필요합니다.`;
    }catch{if(seq===this.heightSequence)this.heightReport.textContent='판정 불가: 건물 자료 또는 경로 검사 응답을 받지 못했습니다.';}
  }
  async save() {
    const state=await this.readEditState();if(state.locked){this.error.textContent=state.message;return;}
    const parsed = definitionFromForm(this.values(), this.options);
    if (parsed.errors) {this.error.textContent = parsed.errors.join(' '); return;}
    this.error.textContent = '';
    try {
      const {vertiport} = this.editingId
        ? await this.api.update(this.editingId, parsed.definition)
        : await this.api.create(parsed.definition);
      this.notify('ready', `버티포트 저장: ${vertiport.name}. 비행계획을 다시 불러오면 변경 높이가 적용됩니다.`);
      this.reset();
      await this.refresh();
      this.onFocus(vertiport);
    } catch (error) {
      this.error.textContent = error?.data?.message ? `저장 실패: ${error.data.message}` : '저장하지 못했습니다. 서버 연결을 확인하세요.';
    }
  }
  async remove(record) {
    const state=await this.readEditState();if(state.locked){this.notify('error',state.message);return;}
    try {
      await this.api.remove(record.id);
      if (this.editingId === record.id) this.reset();
      this.notify('ready', `버티포트 삭제: ${record.name}`);
      await this.refresh();
    } catch {this.notify('error', '버티포트를 삭제하지 못했습니다.');}
  }
  async refresh() {
    try {
      const {vertiports} = await this.api.list();
      this.records = Array.isArray(vertiports) ? vertiports : [];
      this.paintGroupChoices();   // a group made a moment ago is offered next time
    } catch {
      this.notify('error', '버티포트 목록을 불러오지 못했습니다.');
      return;
    }
    this.renderList();
    this.onShow(this.records);
  }
}
