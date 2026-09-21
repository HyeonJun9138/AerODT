// One deck, opened from the PSU's list of them.
//
// The PSU is watching eighteen decks at once, so its list is one line each. The
// moment a line matters - a deck with three aircraft holding for it - one line
// is not enough, and the answer to "why" is on the deck itself: which stands
// are taken, which pad is booked when, and who is in the queue in what order.
//
// The drawing is the vertiport screen's own, given the day's occupancy instead
// of the invented rehearsal it uses when no day is loaded, so the PSU and the
// deck's operator are looking at the same picture of the same deck.
import {buildElement, buildSvg} from '../../../dom_builder.js';
import {layoutView} from '../../../vertiport_layout_view.js';
import {groundRouteLegend,routeMotionEnabled} from '../../../vertiport_ground_routes.js';
import {resourcesOf, RESOURCE_NAMES, STATUS} from '../../../vertiport_operations.js';
import {resourceStates, landingQueue, padWindows, deckSummary, expectedAt} from '../../../deck_state.js';
import {phaseLabel} from './scenario_stakeholders.js';

export const POLL_MS = 2000;
export const PAD_SPAN_S = 900;
const seconds = value => Number.isFinite(value) && value > 0
  ? value >= 60 ? `${Math.floor(value / 60)}분 ${Math.round(value % 60)}초` : `${Math.round(value)}초` : '';

export class DeckDetail {
  // `record` (the saved layout) and `deck` (what the day says) come from two
  // different places and arrive at different times. The layout is asked for
  // once per deck; the day is polled.
  constructor({document = globalThis.document, api = {}, poll = POLL_MS,
               onFocus = () => {}, onClose = () => {}} = {}) {
    Object.assign(this, {document, api, poll, onFocus, onClose});
    this.id = null; this.record = null; this.deck = null; this.error = '';
    this.selected = null; this.timer = null; this.generation = 0; this.readRevision = 0;
  }
  el(tag, props = {}, ...children) {return buildElement(this.document, tag, props, ...children);}
  svg(tag, props = {}, ...children) {return buildSvg(this.document, tag, props, ...children);}

  render(host) {
    this.host = host;
    this.root = this.el('section', {class: 'deck-detail', 'aria-label': '버티포트 상세'});
    host.append(this.root);
    this.paint();
    return this.root;
  }

  async open(id) {
    if (!id) return this.close();
    this.start();
    if (this.id !== id) {
      const generation = ++this.generation;
      this.id = id; this.record = null; this.deck = null; this.selected = null; this.error = '';
      this.paint();
      try {
        const record = await this.api.vertiport?.(id) ?? null;
        if (generation !== this.generation || id !== this.id) return;
        this.record = record;
      } catch (problem) {
        if (generation !== this.generation || id !== this.id) return;
        this.error = `버티포트 정보를 불러오지 못했습니다: ${problem.message}`;
      }
    }
    if (this.timer) await this.refresh();
  }

  close({notify = true} = {}) {
    this.generation++;
    this.stop();
    this.id = null; this.record = null; this.deck = null; this.selected = null;
    this.paint();
    if (notify) this.onClose();
  }

  start() {
    if (this.timer) return;
    this.timer = globalThis.setInterval(() => {
      if (!this.document.hidden) void this.refresh();
    }, this.poll);
    this.timer?.unref?.();
  }
  stop() {if (this.timer) globalThis.clearInterval(this.timer); this.timer = null;}
  destroy() {this.generation++; this.stop(); this.id = null; this.record = null; this.deck = null; this.root?.remove(); this.root = null; this.host = null;}

  async refresh() {
    if (!this.id) return;
    const id = this.id, generation = this.generation, revision = ++this.readRevision;
    let deck = null;
    try {
      deck = await this.api.occupancy?.(id) ?? null;
    } catch {}                       // the day may have been closed while open
    if (id !== this.id || generation !== this.generation || revision !== this.readRevision) return;
    this.deck = deck;
    this.paint();
  }

  // ---- drawing ------------------------------------------------------------
  paint() {
    const root = this.root;
    if (!root) return;
    const flowFocused = root.contains?.(this.document.activeElement) && this.document.activeElement?.matches?.('.vp-route-motion');
    root.hidden = !this.id;
    root.textContent = '';
    if (!this.id) return;
    const e = this.el.bind(this);
    const name = this.record?.name ?? this.id;
    root.append(e('header', {class: 'deck-head'},
      e('div', {}, e('strong', {text: name}),
        e('small', {text: this.deck?.clock ? `${this.deck.source==='physical'?'Physical':'재생 중'} · ${this.deck.clock}${this.deck.stale?' · 지연':''}` : '재생 대기'})),
      this.el('button', {type: 'button', class: 'ops-icon', text: '×',
        'aria-label': '버티포트 상세 닫기', onclick: () => this.close()})));
    if (this.error) {root.append(e('p', {class: 'ops-note', text: this.error})); return;}
    if (!this.deck) {
      root.append(e('p', {class: 'ops-note',
        text: '이 버티포트에 대한 재생 정보가 없습니다. Simulation에서 비행계획을 재생하면 여기에 실시간 상태가 뜹니다.'}));
      return;
    }
    root.append(this.figures(), this.layout(), this.queue(), this.pads());
    if (flowFocused) root.querySelector('.vp-route-motion')?.focus?.({preventScroll: true});
  }

  figures() {
    const e = this.el.bind(this), sum = deckSummary(this.deck);
    const rows = [['주기', sum.standing, false], ['접근', sum.inbound, false],
                  ['대기', sum.holding, sum.holding > 0], ['출발', sum.outbound, false],
                  ['지상 이동', sum.moving, false]];
    return e('div', {class: 'deck-figures'}, ...rows.map(([label, value, warn]) =>
      e('div', {class: 'deck-figure', 'data-warn': warn ? 'true' : undefined},
        e('strong', {text: String(value)}), e('span', {text: label}))));
  }

  // The deck as it stands: the saved geometry, coloured by the day.
  layout() {
    const e = this.el.bind(this);
    if (!this.record?.layout) return e('p', {class: 'ops-note', text: '저장된 지상 레이아웃이 없습니다.'});
    const resources = resourcesOf(this.record);
    const states = resourceStates(this.deck, resources);
    const view = layoutView(this.document, this.record, resources, [], {}, Date.now(), {
      demo: false, states, selected: this.selected, movements: this.deck.movements ?? [], motion: routeMotionEnabled(this.document, this.routeMotion),
      onSelect: key => {this.selected = this.selected === key ? null : key; this.paint();}});
    const chosen = this.selected && resources.find(item => item.key === this.selected);
    const state = chosen && states.get(chosen.key);
    return e('div', {class: 'deck-group'},
      e('h4', {class: 'deck-title', text: '지상 레이아웃 · 자원 상태'}),
      e('div', {class: 'deck-layout'}, view),
      groundRouteLegend(this.document, resources, this.deck.movements, {motion: routeMotionEnabled(this.document, this.routeMotion),
        onMotion: value => {this.routeMotion = value; this.paint();}}),
      this.legend(resources, states),
      e('p', {class: 'deck-picked', text: chosen
        ? `${RESOURCE_NAMES[chosen.kind]} ${chosen.id} · ${STATUS[state.state]}${state.occupants.length ? ` · ${state.occupants.join(', ')}` : ''}`
        : '도형을 누르면 그 자원의 상태와 점유편이 여기에 뜹니다.'}));
  }

  // How many of each kind are free, taken and spoken for. The drawing says
  // which one; this says how many, which is the question asked from across the
  // room.
  legend(resources, states) {
    const e = this.el.bind(this), kinds = ['gate', 'fato', 'charger'];
    return e('ul', {class: 'deck-legend'}, ...kinds.flatMap(kind => {
      const mine = resources.filter(item => item.kind === kind);
      if (!mine.length) return [];
      const count = state => mine.filter(item => (states.get(item.key)?.state ?? 'free') === state).length;
      return [e('li', {},
        e('strong', {text: RESOURCE_NAMES[kind]}),
        e('span', {class: 'deck-chip', 'data-state': 'occupied', text: `점유 ${count('occupied') + count('conflict')}`}),
        e('span', {class: 'deck-chip', 'data-state': 'reserved', text: `예정 ${count('reserved')}`}),
        e('span', {class: 'deck-chip', 'data-state': 'free', text: `가용 ${count('free')}`}))];
    }));
  }

  // The queue, as a queue. Order first, then how long each has been in it.
  queue() {
    const e = this.el.bind(this), rows = landingQueue(this.deck);
    const list = e('ol', {class: 'deck-queue'});
    if (!rows.length) list.append(e('li', {class: 'deck-empty', text: '이 버티포트로 오는 기체가 없습니다.'}));
    for (const row of rows) {
      const note = [phaseLabel(row.phase)];
      if (row.stand) note.push(row.stand);
      if (row.wait_s > 0) note.push(`대기 ${seconds(row.wait_s)}`);
      const item = e('li', {class: 'deck-queue-row', 'data-hold': row.holding ? 'true' : undefined,
        role: 'button', tabindex: '0', onclick: () => this.onFocus(row),
        onkeydown: event => {if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); this.onFocus(row);}}},
        e('b', {class: 'deck-place', text: row.sequence === null ? '—' : String(row.sequence)}),
        e('strong', {text: row.aircraft_id}),
        e('span', {class: 'deck-queue-flight', text: row.flight_id ?? ''}),
        e('small', {text: note.filter(Boolean).join(' · ')}));
      // The bar is the wait against the longest wait on this deck, so the shape
      // of the queue is read rather than worked out.
      item.append(this.svg('svg', {class: 'deck-bar', viewBox: '0 0 100 6', preserveAspectRatio: 'none'},
        this.svg('rect', {x: 0, y: 1.5, width: 100, height: 3, class: 'deck-bar-track'}),
        this.svg('rect', {x: 0, y: 1.5, width: Math.max(row.share > 0 ? 1.5 : 0, row.share * 100),
          height: 3, class: 'deck-bar-fill'})));
      list.append(item);
    }
    const waiting = rows.filter(row => row.holding).length;
    const later = expectedAt(this.deck);
    return e('div', {class: 'deck-group'},
      e('div', {class: 'deck-title-row'},
        e('h4', {class: 'deck-title', text: `착륙 대기열 (${rows.length})`}),
        waiting ? e('span', {class: 'deck-warn', text: `대기 ${waiting}`}) : null,
        // Bound here but not yet off the ground: it says whether the queue is
        // about to grow without pretending they have a place in it.
        later ? e('span', {class: 'ops-tag', text: `출발 전 ${later}`}) : null),
      list);
  }

  // What each pad has coming, laid out on the same fifteen minutes so two pads
  // can be compared by looking rather than by reading times.
  pads() {
    const e = this.el.bind(this), rows = padWindows(this.deck, {span_s: PAD_SPAN_S});
    if (!rows.length) return e('div', {class: 'deck-group'},
      e('h4', {class: 'deck-title', text: 'FATO 사용 예정'}),
      e('p', {class: 'deck-empty', text: '예약된 이착륙이 없습니다.'}));
    const list = e('ul', {class: 'deck-pads'});
    for (const row of rows) {
      const track = this.svg('svg', {class: 'deck-pad-track', viewBox: '0 0 100 10',
        preserveAspectRatio: 'none', role: 'img',
        'aria-label': `${row.pad} 앞으로 15분간 ${row.slots.length}건`});
      track.append(this.svg('rect', {x: 0, y: 0, width: 100, height: 10, class: 'deck-pad-bed'}));
      for (const slot of row.slots)
        track.append(this.svg('rect', {x: slot.from * 100, y: 0,
          width: Math.max(0.8, (slot.to - slot.from) * 100), height: 10,
          class: 'deck-pad-slot', 'data-kind': slot.kind,
          'data-running': slot.running ? 'true' : undefined}));
      list.append(e('li', {}, e('strong', {text: row.pad}), track,
        e('small', {text: row.slots.length ? `${row.slots.length}건` : '없음'})));
    }
    return e('div', {class: 'deck-group'},
      e('div', {class: 'deck-title-row'},
        e('h4', {class: 'deck-title', text: 'FATO 사용 예정'}),
        e('span', {class: 'ops-tag', text: `앞으로 ${Math.round(PAD_SPAN_S / 60)}분`})),
      list);
  }
}
