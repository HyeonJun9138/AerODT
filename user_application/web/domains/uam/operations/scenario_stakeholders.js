// User/Application: what a stakeholder screen shows while a scheduled day is
// being replayed. It answers "what is happening at my deck?" from the day
// itself: who is standing on it, who is coming, who is waiting for a landing
// slot and which pad is busy when.
//
// It owns nothing. It polls the server while it is on screen and stops when it
// is not, and it can neither command a flight nor clear an aircraft.
//
// It used to carry a banner as well, saying on every stakeholder screen that
// the day was a rehearsal. That is now said once, by the replay console the day
// is driven from: it sits across the top of the map with the date, the file and
// the clock on it, on whichever screen is open. Saying it twice made the panels
// shorter for nothing.
import {buildElement} from '../../../dom_builder.js';
import {describePilotDecision} from './pilot_decision.js';

export const POLL_MS = 2000;
const PHASE_LABEL = {
  parked: '주기', gate_out: '지상 이동', takeoff: '이륙', climb: '상승', cruise: '순항',
  descent: '강하', hold_exit: '역천이 · 대기 이동', hold: 'PSU 대기', hold_return: '접근 복귀',
  landing: '착륙', gate_in: '지상 이동',
};
const onGround=phase=>['parked','gate_out','gate_in','charge'].includes(phase);
export const phaseLabel = (phase,state={}) => {
  if(onGround(phase)){
    if(state.ground_waiting===true)return '지상 대기';
    if(state.instruction?.action==='ground_wait')return '지상 이동 · 감속';
  }
  return PHASE_LABEL[phase] ?? phase ?? '';
};
const seconds = value => Number.isFinite(value) ? `${Math.round(value)}초` : '';

export class ScenarioVertiportMonitor {
  // `selected` answers which deck the operator is looking at. The monitor
  // follows that rather than keeping its own idea of it, so choosing another
  // vertiport in the panel above changes what this shows on the next poll.
  constructor({api, document = globalThis.document, poll = POLL_MS, onFocus = () => {}, selected = null}) {
    Object.assign(this, {api, document, poll, onFocus, selected});
    this.host = null; this.timer = null; this.vertiportId = null; this.deck = null; this.status = null;
  }
  el(tag, props = {}, ...children) {return buildElement(this.document, tag, props, ...children);}

  render(host, vertiportId) {
    this.host = host;
    this.vertiportId = vertiportId ?? null;
    this.root = this.el('section', {class: 'scenario-deck', id: 'scenario-deck', hidden: ''});
    this.root.hidden = true;
    host.append(this.root);
    this.start();
    return this.root;
  }
  // The role console already reads this facility; reuse its snapshot instead of polling twice.
  renderSnapshot(host,deck){
    this.destroy();this.host=host;this.root=this.el('section',{class:'scenario-deck',id:'scenario-deck'});
    host.append(this.root);this.updateSnapshot(deck);return this.root;
  }
  updateSnapshot(deck){this.deck=deck;this.paint();}
  // The operator picked a different deck; the next poll is about that one.
  select(vertiportId) {
    if (this.vertiportId === vertiportId) return;
    this.vertiportId = vertiportId ?? null;
    this.deck = null;
    void this.refresh();
  }
  start() {
    if (this.timer) return;
    void this.refresh();
    this.timer = globalThis.setInterval(() => void this.refresh(), this.poll);
    this.timer?.unref?.();
  }
  stop() {
    if (this.timer) globalThis.clearInterval(this.timer);
    this.timer = null;
  }
  destroy() {this.stop(); this.root?.remove(); this.root = null; this.host = null;}

  async refresh() {
    if (!this.root) return;
    try {
      this.status = await this.api.status();
    } catch {
      this.status = null;
    }
    const on = Boolean(this.status?.loaded && this.status?.control_open);
    const wanted = this.selected?.() ?? this.vertiportId;
    if (wanted !== this.vertiportId) {this.vertiportId = wanted; this.deck = null;}
    if (!on || !wanted) {this.deck = null; this.paint(); return;}
    try {
      this.deck = await this.api.vertiport(wanted);
    } catch {
      this.deck = null;
    }
    this.paint();
  }

  paint() {
    const root = this.root;
    if (!root) return;
    const deck = this.deck;
    root.hidden = !deck;
    if (!deck) {root.textContent = ''; return;}
    root.textContent = '';
    root.append(this.el('header', {class: 'scenario-deck-head'},
      this.el('strong', {text: deck.source==='physical'?'Physical 실제 운항 · 이 버티포트':'비행계획 재생 · 이 버티포트'}),
      this.el('span', {class: 'scenario-deck-clock', text: deck.clock ?? ''})));
    root.append(this.el('div', {class: 'scenario-deck-figures'},
      this.figure('주기', deck.standing.length),
      this.figure('접근 중', deck.inbound.length),
      this.figure('대기', deck.holding.length, deck.holding.length > 0),
      this.figure('출발', deck.outbound.length)));
    // Waiting first: it is the thing an operator is looking for, and the reason
    // this rehearsal exists.
    root.append(this.list('대기 중', deck.holding, '대기 중인 기체가 없습니다.'));
    root.append(this.list('접근 중', deck.inbound, '접근 중인 기체가 없습니다.'));
    root.append(this.list('주기 중', deck.standing, '판 위에 기체가 없습니다.'));
    const pads = Object.entries(deck.pads ?? {});
    if (pads.length) root.append(this.pads(pads));
  }
  figure(label, value, warn = false) {
    return this.el('div', {class: 'scenario-deck-figure', 'data-warn': warn ? 'true' : undefined},
      this.el('span', {text: label}), this.el('strong', {text: String(value)}));
  }
  list(title, rows, empty) {
    const list = this.el('ul', {class: 'scenario-deck-rows'});
    if (!rows.length) list.append(this.el('li', {class: 'scenario-deck-empty', text: empty}));
    for (const row of rows) {
      const ground=onGround(row.phase),decision=describePilotDecision({state:row});
      const note = [phaseLabel(row.phase,row)];
      if (row.sequence) note.push(`착륙 ${row.sequence}번`);
      if (!ground&&row.hold_seconds > 0) note.push(`대기 ${seconds(row.hold_seconds)}`);
      if (row.stand) note.push(row.stand);
      if(ground&&decision.source==='버티포트 지상 통제')note.push(decision.reason);
      for(const field of decision.fields){
        if(['blocked_by','ground_wait','planned_stand','assigned_stand','gate_reason','guidance'].includes(field.key))
          note.push(`${field.label}: ${field.value}`);
      }
      list.append(this.el('li', {class: 'scenario-deck-row', 'data-hold': !ground&&row.holding ? 'true' : undefined,
        onclick: () => this.onFocus(row)},
        this.el('strong', {text: row.aircraft_id}),
        this.el('span', {class: 'scenario-deck-flight', text: row.flight_id ?? ''}),
        this.el('small', {text: note.filter(Boolean).join(' · ')})));
    }
    return this.el('div', {class: 'scenario-deck-group'},
      this.el('h4', {class: 'scenario-deck-title', text: `${title} (${rows.length})`}), list);
  }
  pads(pads) {
    const list = this.el('ul', {class: 'scenario-deck-pads'});
    for (const [pad, slots] of pads) {
      for (const slot of slots.slice(-4)) {
        list.append(this.el('li', {},
          this.el('strong', {text: pad}),
          this.el('span', {text: slot.kind === 'arrival' ? '착륙' : '출발'}),
          this.el('small', {text: `${slot.flight_id ?? ''}`})));
      }
    }
    return this.el('div', {class: 'scenario-deck-group'},
      this.el('h4', {class: 'scenario-deck-title', text: 'FATO 사용 예정'}), list);
  }
}
