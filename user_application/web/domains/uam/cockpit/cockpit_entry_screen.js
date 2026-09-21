import {buildElement} from '../../../dom_builder.js';

// The screen between asking to fly and sitting in the seat.
//
// Getting into a cockpit is not instant: the airframe has to be fetched and its
// shaders built, and until that is done there is no seat to sit in. What the
// operator used to be shown during that wait was their own map being flown
// across -- a glide of 1.4-3.4 s, then an approach animation -- and the model
// only began loading once the camera had landed, so the journey was pure
// addition to a wait that was already there.
//
// This covers it instead. It says what is being flown and what is being
// prepared, and the camera is put at the aircraft in one frame behind it. The
// wait that remains is real work rather than travel, which is the only reason
// it is honest to cover it at all.
//
// Unlike `DestinationLoading`, which is a card over a map the operator is still
// using, this one has to be opaque and cover everything: hiding the camera being
// moved is half of what it is for.
const PHASES = ['배정 기체 수신 대기', '3D 시점 준비 중', '기체 모델 준비 중', '조종석 준비 완료'];
const NOTE = '준비가 끝나면 바로 조종석에 앉습니다';
const FADE_MS = 260;
const FAIL_MS = 2200;

export class CockpitEntryScreen {
  constructor({document = globalThis.document, host = document.body, window: view = null} = {}) {
    const el = (tag, props, ...children) => buildElement(document, tag, props, ...children);
    this.window = view;
    this.callsign = el('h2', {class: 'cockpit-entry-callsign'});
    this.route = el('p', {class: 'cockpit-entry-route'});
    this.fill = el('i', {class: 'cockpit-entry-fill'});
    this.step = el('p', {class: 'cockpit-entry-step'});
    this.note = el('p', {class: 'cockpit-entry-note', text: NOTE});
    this.root = el('section', {id: 'cockpit-entry', hidden: '', 'data-phase': 'preparing',
      'aria-label': '조종석 준비', 'aria-live': 'polite', 'aria-busy': 'false'},
      el('div', {class: 'cockpit-entry-frame'},
        el('p', {class: 'cockpit-entry-eyebrow', text: 'MANUAL FLIGHT'}),
        this.callsign, this.route,
        el('div', {class: 'cockpit-entry-rule'}, this.fill),
        this.step, this.note));
    host.append(this.root);
    this.fraction = 0;
  }

  // `assignment` is the answer the day gave when it handed the aircraft over.
  // The pair and the airframe are the only things worth reading here: they are
  // what the wait is for.
  show(assignment = {}) {
    const flight = assignment.flight ?? {};
    const pair = [flight.origin, flight.destination].filter(Boolean);
    this.callsign.textContent = assignment.aircraft_id ?? '';
    this.route.textContent = [pair.length === 2 ? `${pair[0]} → ${pair[1]}` : '', assignment.label ?? '']
      .filter(Boolean).join(' · ');
    this.fraction = 0;
    this.fill.style.width = '0%';
    this.step.textContent = PHASES[0];
    this.note.textContent = NOTE;
    this.root.setAttribute('data-phase', 'preparing');
    this.root.setAttribute('aria-busy', 'true');
    this.root.hidden = false;
    this.clearFade();
    return this.root;
  }

  // The phases are the ones the arrival reports. Text it does not know is still
  // shown -- the operator should read whatever the code wanted to say -- but the
  // rule only moves forward, because a bar that goes backwards is worse than one
  // that pauses.
  advance(text) {
    if (this.root.hidden) return this.fraction;
    if (text) this.step.textContent = text;
    const index = PHASES.indexOf(text);
    if (index >= 0) this.fraction = Math.max(this.fraction, (index + 1) / PHASES.length);
    this.fill.style.width = `${Math.round(this.fraction * 100)}%`;
    return this.fraction;
  }

  // Says what went wrong and then leaves on its own. The message also reaches
  // the operator as a notice, so this is a courtesy for someone who has been
  // watching this screen rather than the only place it is said -- and clearing
  // itself is what guarantees no failure can leave the map covered.
  fail(message) {
    if (this.root.hidden) return;
    this.clearFade();
    this.root.setAttribute('data-phase', 'error');
    this.root.setAttribute('aria-busy', 'false');
    this.step.textContent = message || '조종석 준비에 실패했습니다';
    this.note.textContent = '수동 비행을 다시 시작해 주세요';
    const later = this.timer();
    if (!later) {this.root.hidden = true; return;}
    this.fadeTimer = later(() => {this.fadeTimer = null; this.hide();}, FAIL_MS);
  }

  // A fade rather than a cut, because what is behind it is already the cockpit:
  // one dark surface into another, with nothing to flinch at. Somewhere without
  // a timer to hang the fade on it simply goes, so a stripped page or a test can
  // never be left with the screen up.
  hide() {
    if (this.root.hidden) return;
    this.fraction = 1;
    this.fill.style.width = '100%';
    this.root.setAttribute('aria-busy', 'false');
    const finish = () => {
      this.fadeTimer = null;
      this.root.hidden = true;
      this.root.setAttribute('data-phase', 'preparing');
    };
    const later = this.timer();
    if (!later) return finish();
    this.clearFade();
    this.root.setAttribute('data-phase', 'leaving');
    this.fadeTimer = later(finish, FADE_MS);
  }

  timer() {
    return this.window?.setTimeout?.bind(this.window)
      ?? (typeof setTimeout === 'function' ? setTimeout : null);
  }

  clearFade() {
    if (this.fadeTimer == null) return;
    const cancel = this.window?.clearTimeout?.bind(this.window)
      ?? (typeof clearTimeout === 'function' ? clearTimeout : null);
    cancel?.(this.fadeTimer);
    this.fadeTimer = null;
  }

  get visible() {
    return !this.root.hidden;
  }

  destroy() {
    this.clearFade();
    this.root.remove();
  }
}
