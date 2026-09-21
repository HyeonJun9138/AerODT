// User/Application: what a day being built looks like while it is being built.
//
// Generating a schedule takes long enough that a screen with nothing on it
// reads as a screen that has crashed. So the whole thing goes behind one word —
// Scheduling — that fills from the bottom as the run goes, with the number and
// a line saying what is being done underneath it.
//
// The word is a picture, not a reading: it carries `aria-hidden` and the same
// information is in the live region below it, so a screen reader hears the
// percentage and the phase once rather than the word twice.
//
// It works nothing out. It is given a percentage and a sentence and it draws
// them; whoever is running the job decides what those are.
import {buildElement} from '../../../dom_builder.js';

export const WORD = 'Scheduling';
// A run that has just started still shows a sliver of colour, because a word
// with nothing in it looks like a word that is not going to fill.
export const FLOOR_PCT = 3;

export function fillPercent(percent) {
  const value = Number(percent);
  if (!Number.isFinite(value)) return FLOOR_PCT;
  return Math.max(FLOOR_PCT, Math.min(100, value));
}
// The number the operator reads is the number that arrived, floor or no floor:
// the fill has a minimum so it can be seen, the readout does not.
export function readPercent(percent) {
  const value = Number(percent);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
}

// What a stage chip says under its name: a count while it runs, its time once
// it is done, nothing while it waits.
export function stageMeta(stage) {
  const seconds = Number(stage?.seconds);
  const count = stage?.count;
  if (stage?.state === 'running') {
    const parts = [];
    if (count && Number.isFinite(count.done) && Number.isFinite(count.total)) parts.push(`${count.done}/${count.total}`);
    if (Number.isFinite(seconds)) parts.push(`${seconds.toFixed(seconds < 10 ? 1 : 0)}초`);
    return parts.join(' · ');
  }
  if (stage?.state === 'done' && Number.isFinite(seconds)) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}초`;
  if (stage?.state === 'error') return '중단';
  return '';
}

export class SchedulingProgress {
  constructor({document = globalThis.document, mount = null, word = WORD, onClose = () => {}} = {}) {
    Object.assign(this, {document, mount, word, onClose});
    this.root = null; this.shown = 0; this.state = 'idle';
  }
  el(tag, props = {}, ...children) {return buildElement(this.document, tag, props, ...children);}
  get isOpen() {return Boolean(this.root);}

  open(message = '비행계획을 준비하는 중입니다') {
    this.close();
    this.shown = 0; this.state = 'running';
    const fill = this.el('span', {class: 'sch-fill', 'aria-hidden': 'true'},
      this.el('span', {class: 'sch-fill-text', text: this.word}));
    this.word_ = this.el('div', {class: 'sch-word'},
      this.el('span', {class: 'sch-ghost', 'aria-hidden': 'true', text: this.word}),
      fill,
      this.el('span', {class: 'sch-line', 'aria-hidden': 'true'}));
    this.fill = fill;
    this.figure = this.el('b', {class: 'sch-figure', text: '0'});
    this.percentRow = this.el('p', {class: 'sch-percent'}, this.figure,
      this.el('span', {class: 'sch-unit', text: '%'}));
    this.message = this.el('p', {class: 'sch-message', text: message});
    this.note = this.el('p', {class: 'sch-note', text: ''});
    this.closeButton = this.el('button', {type: 'button', class: 'sch-close', id: 'scheduling-close',
      text: '닫기', hidden: 'hidden', onclick: () => {this.close(); this.onClose();}});
    // The process itself, along the bottom: every stage in order, what is
    // done, what is running, and how long each took. The word says how far;
    // this says what.
    this.stages = this.el('ol', {class: 'sch-stages', 'aria-label': '생성 단계'});
    this.stageNodes = new Map();
    this.root = this.el('section', {class: 'scheduling', id: 'scheduling', role: 'status',
      'aria-live': 'polite', 'aria-label': '비행계획 생성', 'data-state': 'running'},
      this.word_, this.percentRow, this.message, this.note, this.closeButton, this.stages);
    this.paint(0);
    (this.mount ?? this.document.body)?.append(this.root);
    return this.root;
  }

  paint(percent) {
    this.fill?.style?.setProperty('--fill', `${fillPercent(percent)}%`);
    this.root?.style?.setProperty('--fill', `${fillPercent(percent)}%`);
    if (this.figure) this.figure.textContent = String(readPercent(percent));
  }

  // The stages as the server lists them: {id, label, state, seconds, count}.
  // Drawn in place, so a stage's chip keeps its identity from run start to end.
  setStages(stages) {
    if (!this.root || !this.stages || !Array.isArray(stages)) return;
    for (const stage of stages) {
      let node = this.stageNodes.get(stage.id);
      if (!node) {
        node = this.el('li', {class: 'sch-stage', 'data-stage': stage.id},
          this.el('span', {class: 'sch-stage-label', text: stage.label ?? stage.id}),
          this.el('span', {class: 'sch-stage-meta', text: ''}));
        this.stageNodes.set(stage.id, node);
        this.stages.append(node);
      }
      node.setAttribute('data-state', stage.state ?? 'pending');
      node.querySelector('.sch-stage-meta').textContent = stageMeta(stage);
    }
  }

  // A status that arrives out of order must not pull the bar backwards: a bar
  // that goes down reads as work being lost.
  set({percent, message, note} = {}) {
    if (!this.root) return null;
    const value = Math.min(this.state === 'running' ? 99 : 100, readPercent(percent));
    if (value > this.shown) {this.shown = value; this.paint(value);}
    if (message && this.message) this.message.textContent = message;
    if (note !== undefined && this.note) this.note.textContent = note ?? '';
    return this.shown;
  }

  // Full, and gone a moment later: the finished plan is what the operator
  // should be looking at, not the bar that built it.
  done(message = '비행계획을 적용했습니다') {
    if (!this.root) return null;
    this.state = 'done';
    this.shown = 100; this.paint(100);
    this.root.setAttribute('data-state', 'done');
    if (this.message) this.message.textContent = message;
    return this.root;
  }

  // A failure stays on screen: it is the only place the reason is written.
  fail(message = '비행계획을 만들지 못했습니다', note = '') {
    if (!this.root) return null;
    this.state = 'error';
    this.root.setAttribute('data-state', 'error');
    if (this.message) this.message.textContent = message;
    if (this.note) this.note.textContent = note ?? '';
    this.closeButton?.removeAttribute('hidden');
    if (this.closeButton) this.closeButton.hidden = false;
    return this.root;
  }

  close() {
    this.root?.remove();
    this.root = null; this.state = 'idle'; this.shown = 0;
    this.fill = this.figure = this.message = this.note = this.closeButton = null;
    this.stages = null; this.stageNodes = null;
    return null;
  }
}
