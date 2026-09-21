// User/Application: the window that says what is about to be generated.
//
// The multi-flight setup is five steps, and by the time an operator reaches the
// end of it the first step is out of sight. What comes of pressing the button is
// a day of flights that takes minutes to build. So the button opens this first:
// one screen with the whole request on it, and the request itself at the bottom.
//
// It stands beside the settings rather than across the map, so changing a step
// and reading what it did to the day is one short look rather than two.
//
// It works nothing out. Everything on it is handed over already computed, and
// the two buttons at the bottom call back into the panel that opened it.
import {buildElement} from '../../../dom_builder.js';
import {DIRECTIONS, odEstimates} from '../../../demand_setup.js';

// How many origin-destination pairs are worth listing. Enough to see the shape,
// few enough to read without scrolling; the whole matrix is in the file.
export const TOP_PAIRS = 8;
const count = value => Number(value ?? 0).toLocaleString('ko-KR');
const percent = value => `${(Number(value ?? 0) * 100).toFixed(1)}%`;

// A share drawn against the biggest one rather than against 100%: with
// seventeen decks every bar would otherwise be a sliver, and what the operator
// is reading is which deck is bigger than which.
export function barWidth(share, largest) {
  if (!(largest > 0)) return 0;
  return Math.max(2, Math.round(share / largest * 100));
}

export class DemandSummary {
  constructor({document = globalThis.document, mount = null, notify = () => {}}) {
    Object.assign(this, {document, mount, notify});
    this.root = null; this.view = null; this.actions = null; this.busy = false;
  }
  el(tag, props = {}, ...children) {return buildElement(this.document, tag, props, ...children);}
  get isOpen() {return Boolean(this.root);}

  open(view, actions = {}) {
    this.close();
    this.view = view; this.actions = actions;
    const panel = this.el('section', {class: 'demand-summary glass', id: 'demand-summary',
      role: 'dialog', 'aria-modal': 'false', 'aria-label': '다중 비행 생성 요약'},
      this.header(), this.body(), this.footer());
    this.root = panel;
    (this.mount ?? this.document.body)?.append(panel);
    return panel;
  }
  close() {
    this.root?.remove();
    this.root = null;
    return this;
  }
  destroy() {this.close(); this.view = null; this.actions = null;}

  header() {
    return this.el('header', {class: 'ds-header'},
      this.el('div', {},
        this.el('span', {class: 'ds-eyebrow', text: '다중 비행'}),
        this.el('strong', {text: '생성 요약'})),
      this.el('button', {type: 'button', class: 'place-close', 'aria-label': '닫기', text: '×',
        onclick: () => this.close()}));
  }

  body() {
    const view = this.view ?? {};
    const body = this.el('div', {class: 'ds-body'});
    if (view.errors?.length) body.append(this.problems(view.errors));
    body.append(this.figures(view));
    body.append(this.distribution(view));
    body.append(this.pairs(view));
    body.append(this.fleet(view));
    return body;
  }

  problems(errors) {
    const list = this.el('ul', {class: 'ds-problems', id: 'demand-summary-problems'});
    for (const problem of errors) list.append(this.el('li', {text: problem}));
    return this.el('div', {class: 'ds-block ds-block-problem'},
      this.el('h3', {text: '아직 요청할 수 없습니다'}), list);
  }

  figures(view) {
    // A long value gets a smaller type rather than a second line: "15시간"
    // broken across two of them reads as two words, not one number.
    const cell = (label, value, note) => this.el('div',
      {class: 'ds-figure', 'data-wide': String(value).length > 9 ? 'true' : undefined},
      this.el('span', {text: label}), this.el('strong', {text: value}),
      note ? this.el('small', {text: note}) : null);
    return this.el('div', {class: 'ds-figures', id: 'demand-summary-figures'},
      cell('하루 수요', `${count(view.trips)}명`, view.demand),
      cell('버티포트', `${count(view.scope?.count)}곳`,
        `연결 ${count(view.scope?.pairs)} / ${count(view.scope?.total_pairs)}쌍`),
      cell('운영 시간', view.hours ?? '', view.seed ?? ''),
      cell('배치 기체', `${count(view.fleet?.totals?.aircraft)}대`,
        `${count(view.fleet?.totals?.seats)}석`));
  }

  // The shape of the day: which decks carry it, drawn rather than listed. Both
  // directions on one row, because "sends a lot but receives little" is the
  // thing worth seeing and two separate lists hide it.
  distribution(view) {
    const rows = [...(view.weights ?? [])].sort((a, b) =>
      (b.departure_share + b.arrival_share) - (a.departure_share + a.arrival_share));
    const largest = rows.reduce((most, row) =>
      Math.max(most, row.departure_share, row.arrival_share), 0);
    const list = this.el('ul', {class: 'ds-bars', id: 'demand-summary-bars'});
    for (const row of rows) {
      const item = this.el('li', {class: 'ds-bar-row', 'data-id': row.id,
        'data-changed': String(Boolean(row.changed)),
        'data-off': row.departure === 0 && row.arrival === 0 ? 'true' : undefined},
        this.el('span', {class: 'ds-bar-name', text: row.name}));
      for (const [direction, label] of DIRECTIONS) {
        const fill = this.el('i', {class: `ds-bar-fill ds-bar-${direction}`});
        fill.style.width = `${barWidth(row[`${direction}_share`], largest)}%`;
        item.append(this.el('div', {class: 'ds-bar', title: `${label} ${percent(row[`${direction}_share`])}`},
          fill, this.el('b', {text: `${row[direction]}%`})));
      }
      list.append(item);
    }
    const note = view.source
      ? `기본값 출처: ${view.source}. 조정한 곳은 표시됩니다.`
      : '100%가 평균 버티포트입니다. 조정한 곳은 표시됩니다.';
    return this.el('div', {class: 'ds-block'},
      this.el('h3', {text: '버티포트별 수요 분배'}),
      this.el('p', {class: 'ds-note'},
        this.el('span', {class: 'ds-key ds-key-departure', text: '출발'}),
        this.el('span', {class: 'ds-key ds-key-arrival', text: '도착'}),
        this.el('span', {text: note})),
      rows.length ? list : this.el('p', {class: 'ds-empty', text: '선택된 버티포트가 없습니다.'}));
  }

  // What the two sets of weights come to, pair by pair. This is an estimate for
  // reading, not the schedule: it says which routes the day is mostly about.
  pairs(view) {
    const legs = odEstimates(view.weights ?? [], view.pairs ?? [], view.trips ?? 0).slice(0, TOP_PAIRS);
    const list = this.el('ul', {class: 'ds-pairs', id: 'demand-summary-pairs'});
    const largest = legs[0]?.share ?? 0;
    for (const leg of legs) {
      const fill = this.el('i', {class: 'ds-bar-fill ds-bar-pair'});
      fill.style.width = `${barWidth(leg.share, largest)}%`;
      list.append(this.el('li', {class: 'ds-pair-row'},
        this.el('span', {class: 'ds-pair-name', text: `${leg.from_name} → ${leg.to_name}`}),
        this.el('div', {class: 'ds-bar'}, fill),
        this.el('b', {text: `${count(leg.trips)}명`})));
    }
    return this.el('div', {class: 'ds-block'},
      this.el('h3', {text: `수요가 많은 구간 (상위 ${TOP_PAIRS})`}),
      this.el('p', {class: 'ds-note',
        text: '출발·도착 비율로 계산한 참고 추정입니다. 실제 편성은 생성 쪽에서 정합니다.'}),
      legs.length ? list : this.el('p', {class: 'ds-empty', text: '연결된 쌍이 없습니다.'}));
  }

  fleet(view) {
    const totals = view.fleet?.totals ?? {};
    const capacity = view.fleet?.capacity ?? 0;
    const trips = view.trips ?? 0;
    const short = capacity > 0 && capacity < trips;
    const rows = (view.fleet?.rows ?? []).filter(row => row.aircraft > 0);
    const list = this.el('ul', {class: 'ds-fleet', id: 'demand-summary-fleet'});
    for (const row of rows.slice(0, 6)) {
      list.append(this.el('li', {},
        this.el('span', {text: row.name}),
        this.el('b', {text: `${row.aircraft}대 · ${count(row.seats)}석`})));
    }
    if (rows.length > 6) list.append(this.el('li', {class: 'ds-fleet-more',
      text: `외 ${rows.length - 6}곳`}));
    return this.el('div', {class: 'ds-block'},
      this.el('h3', {text: '초기 배치와 좌석 공급'}),
      this.el('p', {class: short ? 'ds-warn' : 'ds-note', id: 'demand-summary-capacity',
        text: capacity > 0
          ? `운영 시간 동안 실을 수 있는 좌석 ${count(capacity)}석 · 하루 수요 ${count(trips)}명`
            + (short ? ' · 공급이 수요보다 적습니다' : '')
          : '배치된 기체가 없어 좌석 공급을 계산할 수 없습니다.'}),
      rows.length ? list : this.el('p', {class: 'ds-empty', text: '배치된 기체가 없습니다.'}));
  }

  footer() {
    const blocked = Boolean(this.view?.errors?.length);
    this.runButton = this.el('button', {type: 'button', class: 'ds-run', id: 'demand-summary-run',
      text: '생성 요청', onclick: () => void this.run()});
    if (blocked) this.runButton.disabled = true;
    return this.el('footer', {class: 'ds-footer'},
      this.el('button', {type: 'button', class: 'ds-save', id: 'demand-summary-download',
        text: 'JSON 내려받기', onclick: () => this.actions?.download?.()}),
      this.el('div', {class: 'ds-footer-end'},
        this.runButton,
        this.el('button', {type: 'button', id: 'demand-summary-close', text: '닫기',
          onclick: () => this.close()})));
  }

  async run() {
    if (this.busy || typeof this.actions?.generate !== 'function') return null;
    this.busy = true;
    this.runButton.disabled = true;
    this.runButton.textContent = '생성 요청 중...';
    try {
      const answer = await this.actions.generate();
      // The panel says what came of it; this closes so the answer is not read
      // through a window describing what was asked for.
      if (answer) this.close();
      return answer;
    } finally {
      this.busy = false;
      if (this.runButton) {
        this.runButton.disabled = Boolean(this.view?.errors?.length);
        this.runButton.textContent = '생성 요청';
      }
    }
  }
}
