// The decision window: what each party decides, drawn, with the numbers it
// turns on sitting beside the branch that uses them.
//
// The point of drawing a decision rather than listing its settings is that a
// setting on its own does not say what it does. "착륙 간격 90초" means nothing
// until you can see that it is the gap the next approach is pushed back by, and
// that the branch under it is where an aircraft is told to wait. So the chart
// is the navigation: a box is clicked, and its numbers appear.
//
// The charts come from the server with the values, because a drawing kept in
// the browser and a decision kept in the engine drift apart within a week, and
// it is always the drawing that starts lying.
import {buildElement, buildSvg} from '../../../dom_builder.js';
import {layout, parametersOf, readValue, isChanged, changedCount,
        WRAP, WRAP_DECISION} from '../../../decision_flow.js';

const KIND_LABEL = {start: '시작', decision: '판단', action: '동작', end: '결과'};
const SCOPE_NOTE = {
  live: '저장하면 다음 재생부터 적용됩니다.',
  native: '물리 라이브러리로 전달됩니다. 이미 떠 있는 기체는 출발할 때의 값으로 계속 납니다.',
};

export class DecisionPanel {
  constructor({document = globalThis.document, api = {}} = {}) {
    Object.assign(this, {document, api});
    this.data = null;
    this.chartId = 'psu';
    this.selected = null;
    this.pending = {};      // what has been moved but not saved
    this.busy = false;
    this.error = '';
  }

  el(tag, props = {}, ...children) { return buildElement(this.document, tag, props, ...children); }
  svg(tag, props = {}, ...children) { return buildSvg(this.document, tag, props, ...children); }
  button(text, onclick, props = {}) { return this.el('button', {type: 'button', text, onclick, ...props}); }

  get chart() { return this.data?.charts?.find(chart => chart.id === this.chartId) ?? null; }
  // What is on screen: what was saved, with anything moved since laid over it.
  get values() {
    const saved = this.data?.values?.[this.chartId] ?? {};
    return this.data?.read_only?{...saved}:{...saved, ...(this.pending[this.chartId] ?? {})};
  }
  get dirty() { return Object.values(this.pending).some(chart => Object.keys(chart).length > 0); }

  // ---- opening and closing ------------------------------------------------
  // Opened from a party's own screen, at that party's own chart. The other
  // three are still there as tabs, because a rule is rarely read alone - a pad
  // let go earlier is the same change seen from the deck and from the service,
  // and hiding the other side of it would let the two disagree.
  async open(role = null) {
    this.wanted = role ?? this.wanted ?? null;
    if (this.root) { this.root.hidden = false; this.selectRole(); this.draw(); return; }
    const e = this.el.bind(this);
    this.tabs = e('div', {class: 'dc-tabs', role: 'tablist'});
    this.flow = e('div', {class: 'dc-flow'});
    this.detail = e('div', {class: 'dc-detail'});
    this.status = e('p', {class: 'dc-status', role: 'status'});
    this.saveButton = this.button('저장', () => void this.save(), {class: 'dc-primary'});
    this.resetButton = this.button('초기 상태로', () => void this.reset(), {class: 'dc-secondary'});
    this.root = e('section', {class: 'dc-window', role: 'dialog', 'aria-label': '의사결정 로직',
                              'aria-modal': 'false'},
      e('header', {class: 'dc-head'},
        e('div', {}, e('small', {text: 'DECISION LOGIC'}), e('h2', {text: '의사결정 로직'})),
        this.appliesTo = e('span', {class: 'dc-tag'}),
        this.button('×', () => this.close(), {class: 'dc-icon', 'aria-label': '의사결정 로직 닫기'})),
      this.tabs,
      e('div', {class: 'dc-body'}, this.flow, this.detail),
      e('footer', {class: 'dc-foot'}, this.status, this.resetButton, this.saveButton));
    this.root.onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); this.close(); } };
    this.document.body.append(this.root);
    await this.load();
  }

  close() { this.root?.remove(); this.root = null; }
  destroy() { this.close(); }

  async load() {
    try {
      this.data = await this.api.read();
      this.error = '';
    } catch (problem) {
      this.error = `의사결정 로직을 불러오지 못했습니다: ${problem.message}`;
    }
    this.selectRole();
    this.selected = null;
    this.draw();
  }

  // The chart the party that opened this window decides by, or the first one if
  // they have no chart of their own.
  selectRole() {
    const charts = this.data?.charts ?? [];
    if (!charts.length) return;
    const wanted = this.wanted && charts.find(chart => chart.role === this.wanted);
    if (wanted) this.chartId = wanted.id;
    else if (!charts.some(chart => chart.id === this.chartId)) this.chartId = charts[0].id;
  }

  // ---- drawing ------------------------------------------------------------
  draw() {
    if (!this.root) return;
    const e = this.el.bind(this);
    this.appliesTo.textContent = this.data?.applies_to ? `적용 시점 · ${this.data.applies_to}` : '';
    this.tabs.replaceChildren(...(this.data?.charts ?? []).map(chart => {
      const moved = changedCount(chart, {...this.data.values?.[chart.id], ...(this.pending[chart.id] ?? {})});
      const tab = this.button('', () => { this.chartId = chart.id; this.wanted = chart.role;
                                          this.selected = null; this.draw(); },
        {class: 'dc-tab', role: 'tab', 'aria-selected': String(chart.id === this.chartId)});
      tab.append(e('strong', {text: chart.name}));
      if (moved) tab.append(e('b', {class: 'dc-moved', title: '기본값에서 바뀐 항목', text: String(moved)}));
      return tab;
    }));
    this.drawFlow();
    this.drawDetail();
    this.drawStatus();
  }

  drawFlow() {
    const chart = this.chart;
    if (!chart) { this.flow.replaceChildren(this.el('p', {class: 'dc-note', text: this.error || '불러오는 중…'})); return; }
    const drawn = layout(chart);
    const values = this.values;
    const svg = this.svg('svg', {class: 'dc-svg', viewBox: `0 0 ${drawn.width} ${drawn.height}`,
                                 width: drawn.width, height: drawn.height, role: 'presentation'});
    svg.append(this.svg('defs', {},
      this.svg('marker', {id: 'dc-arrow', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7,
                          markerHeight: 7, orient: 'auto-start-reverse'},
        this.svg('path', {d: 'M0,0 L8,4 L0,8 z', class: 'dc-arrowhead'}))));
    for (const edge of drawn.edges) svg.append(...this.edge(edge));
    for (const place of drawn.places.values()) svg.append(this.box(place, chart, values));
    this.flow.replaceChildren(svg,
      this.el('p', {class: 'dc-note', text: chart.summary}));
    if (this.flow.clientWidth > 0) this.flow.scrollLeft = Math.max(0, (drawn.width-this.flow.clientWidth)/2);
  }

  // The path the routing worked out, with its corners rounded so a turn reads
  // as a turn rather than as two lines meeting. A branch that goes back up is
  // drawn differently because it means something different, and a reader must
  // not have to trace a line to find out which kind it is.
  edge(edge) {
    const parts = [this.svg('path', {
      class: `dc-edge${edge.back ? ' dc-edge-back' : edge.long ? ' dc-edge-long' : ''}`,
      'marker-end': 'url(#dc-arrow)', d: rounded(edge.points)})];
    if (edge.label) parts.push(this.svg('text', {class: 'dc-edge-label',
      x: edge.labelAt[0], y: edge.labelAt[1], text: edge.label}));
    return parts;
  }

  box(place, chart, values) {
    const {node} = place;
    const owned = parametersOf(chart, node.id);
    const moved = owned.filter(parameter => isChanged(parameter, values[parameter.id])).length;
    const group = this.svg('g', {class: 'dc-node', 'data-kind': node.kind,
      'data-selected': String(this.selected === node.id), tabindex: '0', role: 'button',
      'aria-label': `${KIND_LABEL[node.kind] ?? ''} ${node.text}`});
    group.onclick = () => { this.selected = node.id; this.draw(); };
    group.onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.selected = node.id; this.draw(); }
    };
    // A judgement is drawn as a judgement: the shape says what kind of step it
    // is before a word of it is read.
    group.append(node.kind === 'decision'
      ? this.svg('path', {class: 'dc-shape', d: diamond(place)})
      : this.svg('rect', {class: 'dc-shape', x: place.x, y: place.y, width: place.width,
          height: place.height, rx: node.kind === 'start' || node.kind === 'end' ? 24 : 7}));
    for (const [index, line] of lines(node).entries())
      group.append(this.svg('text', {class: 'dc-text', x: place.x + place.width / 2,
        y: place.y + place.height / 2 + 4 + (index - (lines(node).length - 1) / 2) * 13,
        'text-anchor': 'middle', text: line}));
    if (owned.length) group.append(this.svg('circle', {class: 'dc-pin', 'data-moved': String(moved > 0),
      cx: place.x + place.width - 9, cy: place.y + 9, r: 6}));
    if (owned.length) group.append(this.svg('text', {class: 'dc-pin-count',
      x: place.x + place.width - 9, y: place.y + 12.5, 'text-anchor': 'middle', text: String(owned.length)}));
    return group;
  }

  // ---- the numbers --------------------------------------------------------
  drawDetail() {
    const e = this.el.bind(this), chart = this.chart;
    if (!chart) { this.detail.replaceChildren(); return; }
    const node = chart.nodes.find(item => item.id === this.selected);
    const owned = node ? parametersOf(chart, node.id) : chart.parameters;
    const values = this.values;
    this.live = {};
    const head = node
      ? [e('span', {class: 'dc-kind', text: KIND_LABEL[node.kind] ?? ''}), e('h3', {text: node.text}),
         node.detail ? e('p', {class: 'dc-note', text: node.detail}) : null,
         this.button('전체 보기', () => { this.selected = null; this.draw(); }, {class: 'dc-link'})]
      : [e('h3', {text: '이 차트의 모든 값'}),
         e('p', {class: 'dc-note', text: '위 도형을 누르면 그 판단이 쓰는 값만 봅니다.'})];
    this.detail.replaceChildren(...head.filter(Boolean),
      ...(owned.length ? owned.map(parameter => this.row(parameter, values))
                       : [e('p', {class: 'dc-note', text: '이 단계는 조정할 값이 없습니다. 규칙 자체입니다.'})]));
  }

  row(parameter, values) {
    const e = this.el.bind(this);
    const value = values[parameter.id];
    const moved = isChanged(parameter, value);
    const id = `dc-${this.chartId}-${parameter.id}`;
    const row = e('div', {class: 'dc-row', 'data-moved': String(moved), 'data-scope': parameter.scope ?? 'live'});
    const held = parameter.source ? ` · ${parameter.source.toUpperCase()} 차트와 공유` : '';
    const readout = e('span', {class: 'dc-value', text: readValue(parameter, value)});
    row.append(e('label', {class: 'dc-label', for: id},
      e('strong', {text: parameter.label}), readout,
      moved ? e('em', {class: 'dc-was', text: `기본 ${readValue(parameter, parameter.default)}`}) : null));
    if (parameter.kind === 'toggle') {
      const box = e('input', {type: 'checkbox', id, class: 'dc-toggle',
        onchange: event => this.set(parameter, event.target.checked)});
      box.disabled=Boolean(this.data?.read_only);box.checked = Boolean(value);
      row.append(box);
    } else {
      const slider = e('input', {type: 'range', id, class: 'dc-slider', min: parameter.min,
        max: parameter.max, step: parameter.step,
        oninput: event => this.set(parameter, Number(event.target.value), {quiet: true}),
        onchange: event => this.set(parameter, Number(event.target.value))});
      slider.disabled=Boolean(this.data?.read_only);slider.value = String(Number.isFinite(Number(value)) ? value : parameter.default);
      const number = e('input', {type: 'number', class: 'dc-number', min: parameter.min,
        max: parameter.max, step: parameter.step, 'aria-label': `${parameter.label} 값`,
        onchange: event => this.set(parameter, Number(event.target.value))});
      number.disabled=Boolean(this.data?.read_only);number.value = String(Number.isFinite(Number(value)) ? value : parameter.default);
      row.append(e('div', {class: 'dc-controls'}, slider, number));
      this.live[parameter.id] = {row, readout, number};
    }
    if (parameter.note) row.append(e('p', {class: 'dc-note', text: parameter.note}));
    row.append(e('p', {class: 'dc-scope',
      text: `${parameter.scope === 'native' ? '물리' : '즉시'}${held} · ${SCOPE_NOTE[parameter.scope ?? 'live']}`}));
    return row;
  }

  // A move is held here until it is saved, so the window can say what has
  // changed and putting it back is a matter of dropping it rather than writing
  // the old value over the new one.
  set(parameter, value, {quiet = false} = {}) {
    const target = parameter.source ?? this.chartId;
    const chart = this.pending[target] ?? (this.pending[target] = {});
    chart[parameter.id] = value;
    if (target !== this.chartId) {
      // A shared value is kept once; the other chart shows the same number.
      const mine = this.pending[this.chartId] ?? (this.pending[this.chartId] = {});
      mine[parameter.id] = value;
    }
    if (quiet) { this.drawValue(parameter, value); return; }
    this.draw();
  }

  // While a slider is being dragged only its own readout moves. Redrawing the
  // chart under the operator's finger would take the slider out from under it,
  // so the row keeps a handle on the two things that have to follow the drag.
  drawValue(parameter, value) {
    const live = this.live?.[parameter.id];
    if (!live) return;
    live.readout.textContent = readValue(parameter, value);
    if (live.number) live.number.value = String(value);
    live.row.setAttribute('data-moved', String(isChanged(parameter, value)));
  }

  drawStatus() {
    const moved = (this.data?.charts ?? []).reduce((total, chart) =>
      total + changedCount(chart, {...this.data.values?.[chart.id], ...(this.pending[chart.id] ?? {})}), 0);
    this.status.textContent = (this.data?.read_only?"Physical에서 적용 중인 값입니다. 설정 변경은 송신 PC에서 합니다.":null) || this.error
      || (this.busy ? '저장 중…'
        : this.dirty ? '저장하지 않은 변경이 있습니다.'
        : moved ? `기본값에서 ${moved}개 항목이 바뀐 상태로 저장되어 있습니다.`
        : '모두 기본값입니다.');
    this.saveButton.disabled = Boolean(this.data?.read_only) || this.busy || !this.dirty;
    this.resetButton.disabled = Boolean(this.data?.read_only) || this.busy || (!moved && !this.dirty);
  }

  async save() {
    if (!this.dirty || this.busy || this.data?.read_only) return;
    const values = {};
    for (const chart of this.data.charts)
      values[chart.id] = {...this.data.values?.[chart.id], ...(this.pending[chart.id] ?? {})};
    this.busy = true; this.drawStatus();
    try {
      this.data = await this.api.write(values);
      this.pending = {};
      this.error = '';
    } catch (problem) {
      this.error = `저장하지 못했습니다: ${problem.message}`;
    } finally {
      this.busy = false; this.draw();
    }
  }

  async reset() {
    if (this.busy || this.data?.read_only) return;
    this.busy = true; this.drawStatus();
    try {
      this.data = await this.api.reset();
      this.pending = {};
      this.error = '';
    } catch (problem) {
      this.error = `초기화하지 못했습니다: ${problem.message}`;
    } finally {
      this.busy = false; this.draw();
    }
  }
}

// ---- small drawing helpers -------------------------------------------------
// A right-angled path with its corners taken off. The radius shrinks to fit
// whichever of the two legs is shorter, so a short jog stays a jog instead of
// bulging past the corner it was meant to soften.
export function rounded(points, radius = 7) {
  if (points.length < 2) return '';
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const [px, py] = points[i - 1], [x, y] = points[i], [nx, ny] = points[i + 1];
    const into = Math.min(radius, Math.hypot(x - px, y - py) / 2);
    const outOf = Math.min(radius, Math.hypot(nx - x, ny - y) / 2);
    const r = Math.min(into, outOf);
    if (r < 1) { d += ` L${x},${y}`; continue; }
    d += ` L${x - Math.sign(x - px) * r},${y - Math.sign(y - py) * r}`;
    d += ` Q${x},${y} ${x + Math.sign(nx - x) * r},${y + Math.sign(ny - y) * r}`;
  }
  const [ex, ey] = points[points.length - 1];
  return `${d} L${ex},${ey}`;
}

function diamond(place) {
  const {x, y, width: w, height: h} = place;
  return `M${x + w / 2},${y} L${x + w},${y + h / 2} L${x + w / 2},${y + h} L${x},${y + h / 2} Z`;
}

export function wrap(text, perLine) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && (line + ' ' + word).length > perLine) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.length ? lines.slice(0, 3) : [''];
}

// One place decides how a box's text is broken, so the drawing and the
// arithmetic that sized the box cannot disagree about how many lines it takes.
const lines = node => wrap(node.text, node.kind === 'decision' ? WRAP_DECISION : WRAP);
