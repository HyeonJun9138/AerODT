// User/Application: the Library section of the work panel. One card per data
// source with what it is doing now and what the operator may decide about it:
// whether it runs, how often it is asked, how much is kept and how wide a
// window is requested. The server describes the fields and their limits, so
// this panel renders whatever the library declares and never invents a rule.
// Display-only sources (terrain, buildings) are also applied to the map.
//
// The cards are folded into groups the server names — what is coming in from
// outside, what the map draws with, what this workspace made — so the panel
// opens on a handful of lines instead of a dozen cards, and the operator opens
// the one they came for. Two groups hold no sources: the downloads, which hand
// the design work in this workspace to whichever computer asked for it, and
// the model shelf.
const STATE_LABEL = {
  configured: '화면 설정 켜짐',
  ready: '수신 중', cached: '저장 자료 사용', stale: '이전 자료 유지', connecting: '연결 중',
  paused: '수집 중지', disabled: '비활성', error: '연결 실패', unavailable: '설정 필요', pending: '연동 준비 중',
  // Not asking on purpose: the shared schedule says it is not this source's
  // turn yet, or an answer arrived that will not change by asking again.
  waiting: '다음 수집 대기', stopped: '자동 수집 정지',
};
// Drawn by the map rather than collected by the server: the panel stores the
// choice and hands the whole set of values to the map, not just a switch.
const DISPLAY_SOURCES = new Set(['terrain', 'buildings', 'clouds', 'imagery',
  'trajectory_prediction', 'uam_prediction', 'risk_prediction']);
const BOUND_FIELDS = [['lamin', '남'], ['lamax', '북'], ['lomin', '서'], ['lomax', '동']];

export function describeState(state) {
  if (!state) return '상태 없음';
  const label = STATE_LABEL[state.status] ?? state.status;
  if (!state.message || state.message === label) return label;
  return `${label} · ${state.message}`;
}

// Field name in the form: one flat namespace, so reading it back needs no tree walk.
const key = (source, field, part) => `${source}__${field}${part ? `__${part}` : ''}`;

export function formValues(root, description) {
  const values = {};
  for (const source of description.sources ?? []) {
    const current = {};
    for (const field of source.fields ?? []) {
      if (field.kind === 'toggle') {
        current[field.name] = Boolean(root.querySelector(`[name=${key(source.id, field.name)}]`)?.checked);
      } else if (field.kind === 'choice' || field.kind === 'model') {
        current[field.name] = root.querySelector(`[name=${key(source.id, field.name)}]`)?.value;
      } else if (field.kind === 'bounds') {
        const bounds = {};
        for (const [part] of BOUND_FIELDS) bounds[part] = Number(root.querySelector(`[name=${key(source.id, field.name, part)}]`)?.value);
        current[field.name] = bounds;
      } else {
        current[field.name] = Number(root.querySelector(`[name=${key(source.id, field.name)}]`)?.value);
      }
    }
    values[source.id] = current;
  }
  return values;
}

// Only what the operator actually changed, so an untouched source is never rewritten.
export function patchFrom(values, baseline) {
  const sources = {};
  for (const [id, fields] of Object.entries(values)) {
    const before = baseline?.[id] ?? {};
    const changed = {};
    for (const [name, value] of Object.entries(fields)) {
      if (JSON.stringify(value) !== JSON.stringify(before[name])) changed[name] = value;
    }
    if (Object.keys(changed).length) sources[id] = changed;
  }
  return Object.keys(sources).length ? {sources} : null;
}

export class LibraryPanel {
  // `section` is which panel this instance is: the Live Twinning side shows the
  // real-time models the twin keeps, the Library side what this workspace holds.
  // One implementation serves both, so the form, the apply and the status
  // refresh are written once and a source moves between panels by being grouped
  // differently on the server rather than by being re-implemented here.
  constructor({api, notify = () => {}, onDisplay = () => {}, onDescribed = () => {}, models = null,
    section = 'library', counts = () => null, aiLibrary = null, document = globalThis.document}) {
    Object.assign(this, {api, notify, onDisplay, onDescribed, models, section, counts, aiLibrary, document});
    this.description = null; this.values = {}; this.body = null; this.ready = Promise.resolve();
    // Which layers and which groups the operator opened. Everything starts
    // closed, so the list reads as a list, and a redraw after applying keeps
    // what was open open.
    this.open = new Set(); this.openGroups = new Set();
    // The download catalogue, asked for when its group is first opened: the
    // counts in it are of what is stored right now, so they are worth nothing
    // fetched at start-up and kept.
    this.exports = null; this.exportsError = null; this.exportsBody = null;
  }
  el(tag, props = {}, ...children) {
    const node = this.document.createElement(tag);
    for (const [name, value] of Object.entries(props)) {
      if (name === 'class') node.className = value;
      else if (name === 'text') node.textContent = value;
      else if (name.startsWith('on')) node[name] = value;
      else if (name === 'checked') node.checked = Boolean(value);
      else if (value !== undefined && value !== null) node.setAttribute(name, value);
    }
    for (const child of children) if (child) node.append(child);
    return node;
  }
  render(body) {
    this.body = body;
    body.textContent = '';
    body.append(this.el('p', {class: 'sim-empty', text: '자료 공급자 상태와 수집 설정을 확인하고 있습니다.'}));
    this.ready = this.load(body);
  }
  async load(body) {
    let description;
    try {
      description = await this.api.describe();
    } catch {
      this.notify('error', '자료 설정을 불러오지 못했습니다.');
      return;
    }
    if (this.body !== body) return;
    this.take(description);
    this.draw();
    this.applyDisplay();
  }
  // The stored settings without the form: at start-up the map is told what was
  // chosen before anyone opens the Library.
  async sync() {
    let description;
    try {description = await this.api.describe();} catch {return false;}
    this.take(description);
    if (this.body) this.draw();
    this.applyDisplay();
    return true;
  }
  take(description) {
    this.description = description;
    this.values = structuredClone(description.values ?? {});
    this.onDescribed(description, this.values);
  }
  // What was stored for the map is what the map should be showing.
  applyDisplay(ids = null) {
    for (const source of this.ownSources()) {
      if (ids && !ids.includes(source.id)) continue;
      const fields = this.values[source.id];
      if (DISPLAY_SOURCES.has(source.id) && fields) this.onDisplay(source.id, {...fields});
    }
  }
  // The groups to draw, as the server named them. A library that names none
  // still reads: everything it has becomes one group of sources.
  groups() {
    const declared = (this.description?.groups ?? []).filter(group => (group.section ?? 'library') === this.section);
    if (declared.length) return declared.map(group => ({kind: 'sources', ...group}));
    return [{id: 'sources', kind: 'sources', label: '자료', note: ''}];
  }
  // The sources this panel shows: the ones grouped into its own groups. A source
  // grouped somewhere this panel has never heard of belongs to the other panel
  // and is left there, rather than being swept into this one's first group.
  ownSources() {
    const known = new Set(this.groups().map(item => item.id));
    const fallback = this.section === 'library' ? this.groups()[0]?.id : null;
    return (this.description?.sources ?? [])
      .filter(source => known.has(source.group) || (fallback && !this.everyGroup().has(source.group)));
  }
  everyGroup() {return new Set((this.description?.groups ?? []).map(group => group.id));}
  sourcesOf(group) {
    const known = new Set(this.groups().map(item => item.id));
    return this.ownSources().filter(source => (known.has(source.group) ? source.group : this.groups()[0].id) === group.id);
  }
  draw() {
    const body = this.body, description = this.description;
    this.modelFields = new Map();
    body.textContent = '';
    this.exportsBody = null;
    const states = new Map((description.state ?? []).map(state => [state.id, state]));
    let form = null;
    for (const group of this.groups()) {
      const sources = group.kind === 'sources' ? this.sourcesOf(group) : [];
      // A group with nothing in it is not drawn, unless it is a model the twin
      // is meant to keep: an operator looking for the mission picture should be
      // told it is not built yet, not left to wonder which panel it is on.
      if (group.kind === 'sources' && !sources.length && !group.always) continue;
      const opened = this.openGroups.has(group.id);
      const inside = this.el('div', {class: 'library-group-body', id: `library-group-${group.id}-body`});
      inside.hidden = !opened;
      if (group.note) inside.append(this.el('p', {class: 'library-note library-group-note', text: group.note}));
      if (group.kind === 'sources') {
        // What this model is still waiting on, said whether or not anything
        // fills it: an empty model has nothing arriving, and a full one may
        // still have nobody drawing conclusions from what arrives. Those are
        // different sentences and the group carries whichever applies.
        if (group.waiting) inside.append(this.el('p', {class: 'library-note library-waiting', text: group.waiting}));
        for (const source of sources) inside.append(this.card(source, states.get(source.id)));
        // The apply buttons belong to the source form as a whole, so they sit
        // after the last group that holds any of it.
        form = inside;
      } else if (group.kind === 'exports') {
        this.exportsBody = this.el('div', {class: 'library-exports', id: 'library-exports'});
        inside.append(this.exportsBody);
        this.drawExports();
      } else if (group.kind === 'models' && this.models) {
        const shelf = this.el('section', {class: 'model-shelf', id: 'library-models'});
        inside.append(shelf);
        this.models.render(shelf);
      }
      body.append(this.el('section', {class: 'library-group', id: `library-group-${group.id}`, 'data-open': String(opened)},
        this.el('button', {type: 'button', class: 'library-group-head', id: `library-group-${group.id}-head`,
          'aria-expanded': String(opened), 'aria-controls': `library-group-${group.id}-body`,
          onclick: () => this.toggleGroup(group.id)},
          this.el('strong', {text: group.label}),
          this.groupState(group, sources, states),
          this.el('span', {class: 'library-chevron', 'aria-hidden': 'true', text: '⌄'})),
        inside));
    }
    this.error = this.el('p', {class: 'sim-error', role: 'alert', id: 'library-error'});
    (form ?? body).append(this.el('div', {class: 'sim-actions'},
      this.el('button', {type: 'button', text: '적용', id: 'library-save', onclick: () => void this.save()}),
      this.el('button', {type: 'button', text: '되돌리기', id: 'library-reset', onclick: () => this.draw()})), this.error);
  }
  // What a closed group says about itself: how much it holds, and — because a
  // failing source must not hide inside a fold — the worst state within it.
  groupState(group, sources, states) {
    const worst = sources.map(source => states.get(source.id))
      .find(state => state && (state.status === 'error' || state.status === 'unavailable'));
    if (worst) return this.el('span', {class: 'library-state', 'data-status': worst.status,
      id: `library-group-${group.id}-state`, text: describeState(worst)});
    // A twin model says what it is holding right now, which is not the same as
    // how many feeds were configured for it: a model with two feeds and nothing
    // arriving is not a model with anything in it.
    const held = this.counts()?.[group.id];
    if (held) return this.el('span', {class: 'library-state', 'data-status': 'ready',
      id: `library-group-${group.id}-state`, text: held});
    // No card does not mean nothing arrives. A model can be filled by a feed
    // that has no collection policy to set — the airspace is drawn from a
    // display switch, not a poll — so only a model the server says nothing
    // fills is called pending.
    if (group.kind === 'sources' && !sources.length) {
      return this.el('span', {class: 'library-state', 'data-status': group.filled === false ? 'pending' : 'unknown',
        id: `library-group-${group.id}-state`, text: group.filled === false ? '준비 중' : ''});
    }
    const count = group.kind === 'sources' ? `${sources.length}개` : '';
    return this.el('span', {class: 'library-state', 'data-status': 'unknown',
      id: `library-group-${group.id}-state`, text: count});
  }
  // New counts arrived with a snapshot: only the group heads change, so the
  // panel is not redrawn under an operator who is part way through a form.
  refreshCounts() {
    if (!this.body || !this.description) return false;
    const states = new Map((this.description.state ?? []).map(state => [state.id, state]));
    let written = false;
    for (const group of this.groups()) {
      const node = this.body.querySelector(`#library-group-${group.id}-state`);
      if (!node) continue;
      const fresh = this.groupState(group, this.sourcesOf(group), states);
      if (node.textContent === fresh.textContent) continue;
      node.textContent = fresh.textContent;
      node.setAttribute('data-status', fresh.getAttribute('data-status'));
      written = true;
    }
    return written;
  }
  card(source, state) {
    const settable = (source.fields ?? []).length > 0;
    const opened = settable && this.open.has(source.id);
    const details = this.el('div', {class: 'library-body', id: `library-${source.id}-body`});
    details.hidden = !opened;
    if (source.note) details.append(this.el('p', {class: 'library-note', text: source.note}));
    const values = this.values[source.id] ?? {};
    for (const field of source.fields ?? []) details.append(this.field(source, field, values[field.name]));
    // Where this feed's state comes from. An API today and an aircraft
    // reporting itself tomorrow fill the same model, so the card says which,
    // rather than leaving the operator to infer it from the provider's name.
    if (source.origin) {
      details.insertBefore(this.el('p', {class: 'library-note library-origin',
        text: `${source.origin.label} · ${source.origin.note}`}), details.firstChild);
    }
    const head = this.el('button', {type: 'button', class: 'library-head', id: `library-${source.id}-head`,
      'aria-expanded': String(opened), 'aria-controls': `library-${source.id}-body`,
      ...(settable ? {} : {'aria-disabled': 'true'}),
      onclick: () => {if (settable) this.toggle(source.id);}},
      this.el('span', {class: 'library-title'},
        this.el('strong', {text: source.label}),
        this.el('span', {class: 'library-provider', text: source.provider ?? ''})),
      this.el('span', {class: 'library-state', 'data-status': state?.status ?? 'unknown', text: describeState(state)}),
      settable ? this.el('span', {class: 'library-chevron', 'aria-hidden': 'true', text: '⌄'}) : null);
    return this.el('section', {class: 'library-card', id: `library-${source.id}`, 'data-open': String(opened)}, head, details);
  }

  // ---- downloads --------------------------------------------------------
  // The catalogue is asked for when the group opens, and again on every open,
  // so the counts are of what is stored at that moment.
  async loadExports() {
    if (typeof this.api?.exports !== 'function') return;
    try {
      const answer = await this.api.exports();
      this.exports = answer?.exports ?? [];
      this.exportsError = null;
    } catch {
      this.exports = null;
      this.exportsError = '내려받을 수 있는 자료를 확인하지 못했습니다.';
    }
    this.drawExports();
  }
  drawExports() {
    const host = this.exportsBody;
    if (!host) return;
    host.textContent = '';
    if (this.exportsError) {host.append(this.el('p', {class: 'sim-error', text: this.exportsError})); return;}
    if (this.exports === null) {host.append(this.el('p', {class: 'library-note', text: '확인하는 중입니다.'})); return;}
    if (!this.exports.length) {host.append(this.el('p', {class: 'library-note', text: '내려받을 자료가 없습니다.'})); return;}
    for (const item of this.exports) host.append(this.exportCard(item));
  }
  exportCard(item) {
    const opened = this.open.has(`export:${item.id}`);
    const details = this.el('div', {class: 'library-body', id: `library-export-${item.id}-body`});
    details.hidden = !opened;
    if (item.note) details.append(this.el('p', {class: 'library-note', text: item.note}));
    // A plain link, so the browser saves the file on the computer that asked —
    // which is the point when the dashboard is reached from another machine.
    // The server names the file; `download` only repeats that name.
    details.append(this.el('div', {class: 'library-download-row'},
      item.available === false
        ? this.el('span', {class: 'library-download library-download-off', 'aria-disabled': 'true', text: '내려받을 수 없음'})
        : this.el('a', {class: 'library-download', id: `library-export-${item.id}-link`,
            href: `/api/library/exports/${item.id}`, download: item.filename ?? '', text: '내려받기'}),
      this.el('span', {class: 'library-filename', text: item.filename ?? ''})));
    const head = this.el('button', {type: 'button', class: 'library-head', id: `library-export-${item.id}-head`,
      'aria-expanded': String(opened), 'aria-controls': `library-export-${item.id}-body`,
      onclick: () => this.toggle(`export:${item.id}`)},
      this.el('span', {class: 'library-title'},
        this.el('strong', {text: item.label}),
        this.el('span', {class: 'library-provider', text: (item.format ?? '').toUpperCase()})),
      this.el('span', {class: 'library-state', 'data-status': item.available === false ? 'disabled' : 'ready',
        text: item.summary ?? ''}),
      this.el('span', {class: 'library-chevron', 'aria-hidden': 'true', text: '⌄'}));
    return this.el('section', {class: 'library-card library-export', id: `library-export-${item.id}`,
      'data-open': String(opened)}, head, details);
  }

  // The catalogue arrives once during start-up, after this panel is built.
  setModels(catalog) {
    this.models?.setCatalog(catalog);
  }
  toggle(id) {
    if (this.open.has(id)) this.open.delete(id); else this.open.add(id);
    this.fold(id.startsWith('export:') ? `library-export-${id.slice(7)}` : `library-${id}`, this.open.has(id));
  }
  toggleGroup(id) {
    if (this.openGroups.has(id)) this.openGroups.delete(id); else this.openGroups.add(id);
    const opened = this.openGroups.has(id);
    this.fold(`library-group-${id}`, opened);
    // What is downloadable is answered when it is asked to be shown.
    if (opened && this.exportsBody && this.groups().some(group => group.id === id && group.kind === 'exports')) {
      void this.loadExports();
    }
  }
  fold(prefix, opened) {
    const card = this.body?.querySelector(`#${prefix}`);
    const head = this.body?.querySelector(`#${prefix}-head`);
    const details = this.body?.querySelector(`#${prefix}-body`);
    if (!head || !details) return;
    head.setAttribute('aria-expanded', String(opened));
    details.hidden = !opened;
    card?.setAttribute('data-open', String(opened));
  }
  // A switch flipped somewhere else (the map settings) is stored the same way.
  async setEnabled(id, enabled) {
    if (!this.values[id] || Boolean(this.values[id].enabled) === Boolean(enabled)) return;
    return this.setField(id, 'enabled', Boolean(enabled), {display: false});
  }
  // One field of one source changed outside the form; the map follows unless
  // the caller already moved it.
  async setField(id, name, value, {display = true} = {}) {
    if (!this.values[id] || JSON.stringify(this.values[id][name]) === JSON.stringify(value)) return true;
    try {
      const answer = await this.api.apply({sources: {[id]: {[name]: value}}});
      this.take(answer);
      if (this.body && this.description) this.draw();
      if (display) this.applyDisplay([id]);
      return true;
    } catch {this.notify('error', '자료 설정을 적용하지 못했습니다.'); return false;}
  }
  // Which model does a job is chosen in the AI library, not from a list of
  // names: the window shows what each model is for and what it needs. The
  // choice is held in a hidden input so it is saved with the rest of the form.
  modelField(source, field, value) {
    const library = this.description?.ai_models ?? {};
    const models = (library.models ?? []).filter(model => (model.jobs ?? []).includes(field.job));
    const offered = field.job === 'prediction' && library.same_as_estimation
      ? [{model_id: library.same_as_estimation, label: '추정 모델과 동일', family: 'follow',
          function: '궤적 예측', application: '기체', scope: '추정과 같음', ready: true,
          note: '상태 추정이 쓰는 모델을 그대로 씁니다.', requires: '추가 조건 없음'}, ...models]
      : models;
    const held = this.el('input', {type: 'hidden', name: key(source.id, field.name), value: String(value ?? '')});
    held.value = String(value ?? '');
    const name = this.el('b', {class: 'library-model-name'});
    const state = this.el('span', {class: 'library-model-state'});
    const show = () => {
      const chosen = offered.find(model => model.model_id === held.value);
      name.textContent = chosen?.label ?? held.value ?? '고르지 않음';
      state.textContent = chosen?.ready === false ? '사용 불가' : chosen?.scope ?? '';
    };
    show();
    const button = this.el('button', {type: 'button', class: 'library-model', id: `library-${source.id}-model`,
      'aria-haspopup': 'dialog',
      onclick: () => this.aiLibrary?.open({source: source.id, field: field.name, job: field.job,
        jobs: library.jobs ?? [], models: offered, chosen: held.value,
        title: 'AI 모델 라이브러리'})},
      name, state, this.el('span', {class: 'library-model-more', 'aria-hidden': 'true', text: '⋯'}));
    // The panel is told when the window answers, so the button and the hidden
    // value move together without redrawing the whole form.
    this.modelFields ??= new Map();
    this.modelFields.set(`${source.id}__${field.name}`, {held, show});
    return this.el('div', {class: 'library-field'},
      this.el('span', {class: 'library-label', text: field.label}), button, held);
  }
  // The library answered: keep the choice in the form the operator is filling.
  chooseModel({source, field, model}) {
    const entry = this.modelFields?.get(`${source}__${field}`);
    if (!entry) return false;
    entry.held.value = String(model);
    entry.show();
    return true;
  }
  field(source, field, value) {
    if (field.kind === 'model') return this.modelField(source, field, value);
    if (field.kind === 'choice') {
      const select = this.el('select', {name: key(source.id, field.name)});
      for (const choice of field.choices ?? []) {
        select.append(this.el('option', {value: choice.id, text: choice.label, title: choice.note || undefined,
          selected: choice.id === value ? '' : undefined}));
      }
      select.value = value ?? field.choices?.[0]?.id ?? '';
      return this.el('label', {class: 'library-field'}, this.el('span', {class: 'library-label', text: field.label}), select);
    }
    if (field.kind === 'toggle') {
      return this.el('label', {class: 'library-field library-toggle'},
        this.el('input', {type: 'checkbox', name: key(source.id, field.name), checked: Boolean(value)}),
        this.el('span', {text: field.label}));
    }
    if (field.kind === 'bounds') {
      const grid = this.el('div', {class: 'library-bounds'});
      for (const [part, label] of BOUND_FIELDS) {
        grid.append(this.el('label', {},
          this.el('span', {text: label}),
          this.el('input', {type: 'number', step: '0.1', name: key(source.id, field.name, part), value: String(value?.[part] ?? '')})));
      }
      return this.el('div', {class: 'library-field'},
        this.el('span', {class: 'library-label', text: `${field.label} (위경도)`}), grid);
    }
    return this.el('label', {class: 'library-field'},
      this.el('span', {class: 'library-label', text: `${field.label}${field.unit ? ` (${field.unit})` : ''}`}),
      this.el('input', {type: 'number', name: key(source.id, field.name), value: String(value ?? ''),
        min: field.min, max: field.max, step: field.step ?? 1}));
  }
  async save() {
    if (!this.description || !this.body) return;
    // Only this panel's own sources are read back: the other panel's inputs are
    // not in this DOM, so reading them would answer undefined for every field
    // and then send that difference as a change nobody made.
    const patch = patchFrom(formValues(this.body, {...this.description, sources: this.ownSources()}), this.values);
    if (!patch) {this.error.textContent = ''; return;}
    try {
      const answer = await this.api.apply(patch);
      this.take(answer);
      this.error.textContent = '';
      this.applyDisplay(Object.keys(patch.sources));
      this.notify('ready', '자료 설정을 적용했습니다.');
      this.draw();
    } catch (error) {
      this.error.textContent = error?.data?.message ?? '설정을 적용하지 못했습니다. 서버 연결을 확인하세요.';
    }
  }
  // The live state changes without the operator touching anything.
  async refreshState() {
    if (!this.description || !this.body) return;
    try {
      const answer = await this.api.describe();
      if (!this.body) return;
      this.description = {...this.description, state: answer.state};
      const states = new Map((answer.state ?? []).map(state => [state.id, state]));
      for (const [id, state] of states) {
        const node = this.body.querySelector(`#library-${id}-head`)?.querySelector('.library-state');
        if (node) {node.textContent = describeState(state); node.setAttribute('data-status', state.status);}
      }
      // A source that started failing inside a closed group must show on the
      // fold as well, or the panel looks calm while nothing is arriving.
      for (const group of this.groups()) {
        const head = this.body.querySelector(`#library-group-${group.id}-head`);
        const node = head?.querySelector('.library-state');
        if (!node) continue;
        const fresh = this.groupState(group, group.kind === 'sources' ? this.sourcesOf(group) : [], states);
        node.textContent = fresh.textContent;
        node.setAttribute('data-status', fresh.getAttribute('data-status'));
      }
    } catch {/* the panel keeps what it last knew */}
  }
}
