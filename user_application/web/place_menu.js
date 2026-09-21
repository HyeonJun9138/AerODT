// The tools that appear where the operator right-clicks while placing a
// vertiport: deck height, layout and heading. They exist so a placement is
// adjusted at the cursor instead of across the screen in the work panel, and
// so the map keeps the preview under the pointer while it is adjusted.
//
// The menu owns no values. It is opened with what the form currently says and
// reports every change straight back to it under the form's own field names,
// so the form stays the single description of the vertiport being placed.
import {buildElement} from './dom_builder.js';

// Field names, shared with the vertiport form; the menu never invents one.
export const HEIGHT_FIELD = 'platform_height_m';
export const HEADING_FIELD = 'heading_deg';
export const PATTERN_FIELD = 'pattern';
export const GATES_FIELD = 'gates';
export const FATO_FIELD = 'fato_count';

const WIDTH_PX = 232;
const MARGIN_PX = 10;
// Enough for the card; the menu scrolls inside itself if a long pattern list
// makes it taller.
const HEIGHT_PX = 340;
const TURNS = [[-45, '−45°'], [-15, '−15°'], [15, '+15°'], [45, '+45°']];
// A deck goes up a storey at a time, not a hand-width at a time; the panel form
// still takes an exact figure for a height between these.
const HEIGHT_STEP_M = 5;

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const wrapHeading = value => ((Math.round(Number(value) || 0) % 360) + 360) % 360;

export class PlaceMenu {
  // `mount` is where the card is attached (the page body); `viewport` answers
  // the space it has to stay inside. `describeHeight(metres)` may add a word
  // about what a deck this tall becomes, and is optional.
  constructor({document = globalThis.document, mount = null, onChange = () => {}, onPlace = () => {},
    onResume = () => {}, describeHeight = null, viewport = null} = {}) {
    Object.assign(this, {document, mount, onChange, onPlace, onResume, describeHeight, viewport});
    this.root = null; this.isOpen = false;
  }
  el(tag, props = {}, ...children) {return buildElement(this.document, tag, props, ...children);}
  space() {
    if (typeof this.viewport === 'function') return this.viewport();
    const view = globalThis.window;
    return {width: view?.innerWidth ?? 1280, height: view?.innerHeight ?? 800};
  }
  // A tool: its name, the control that changes it and, where there is one, a
  // readout of where it stands.
  tool(label, readout, ...controls) {
    const value = readout === null ? null : this.el('b', {class: 'place-value', text: readout});
    return {node: this.el('section', {class: 'place-tool'},
      this.el('h4', {class: 'place-tool-head'}, this.el('span', {text: label}), value), ...controls), value};
  }
  slider(name, {min, max, step, value, onInput}) {
    const input = this.el('input', {type: 'range', name, min: String(min), max: String(max), step: String(step), value: String(value)});
    input.value = String(value);
    input.oninput = () => onInput(Number(input.value));
    return input;
  }
  number(label, name, {min, max, value, onInput}) {
    const input = this.el('input', {type: 'number', name, min: String(min), max: String(max), step: '1', value: String(value)});
    input.value = String(value);
    input.oninput = () => {
      const chosen = Number.parseInt(input.value, 10);
      if (Number.isInteger(chosen) && chosen >= min && chosen <= max) onInput(chosen);
    };
    return this.el('label', {class: 'place-count'}, this.el('span', {text: label}), input);
  }
  heightText(metres) {
    const said = this.describeHeight?.(metres);
    return `${(Math.round(metres * 10) / 10).toFixed(1)} m${said ? ` · ${said}` : ''}`;
  }
  // `values` are the form's current values; `options` and `limits` are what the
  // server allows, so the menu never offers a design the form would refuse.
  // The tools are the same whether a vertiport is being placed or one that is
  // already there is being adjusted; only the heading, the two buttons and the
  // note differ, so the caller names them. Placing is the default.
  open({screen = {x: 0, y: 0}, values = {}, options = {}, limits = {}, title = '배치 도구',
    confirmLabel = '여기에 배치', dismissLabel = '이동 계속',
    note = '왼쪽 클릭하면 다시 커서를 따라갑니다 · Esc 취소',
    onConfirm = null, onDismiss = null, onRelocate = null,
    relocateLabel = '지도에서 위치 조정', actions = []} = {}) {
    this.close();
    const heightRange = limits.platform_height_m ?? [0, 60];
    const gateRange = limits.gates ?? [1, 20];
    const fatoRange = limits.fatos ?? [1, 8];
    const height = clamp(Number(values[HEIGHT_FIELD]) || 0, heightRange[0], heightRange[1]);
    const heading = wrapHeading(values[HEADING_FIELD]);

    const heightTool = this.tool('높이 조정', this.heightText(height),
      this.slider(HEIGHT_FIELD, {min: heightRange[0], max: heightRange[1], step: HEIGHT_STEP_M, value: height,
        onInput: metres => {heightTool.value.textContent = this.heightText(metres); this.onChange(HEIGHT_FIELD, metres);}}));

    const headingSlider = this.slider(HEADING_FIELD, {min: 0, max: 359, step: 1, value: heading,
      onInput: degrees => turnTo(degrees)});
    const headingTool = this.tool('각도 조정', `${heading}°`, headingSlider);
    const turnTo = degrees => {
      const turned = wrapHeading(degrees);
      headingSlider.value = String(turned);
      headingTool.value.textContent = `${turned}°`;
      this.onChange(HEADING_FIELD, turned);
    };
    const turns = this.el('div', {class: 'place-turns'});
    for (const [step, label] of TURNS) {
      turns.append(this.el('button', {type: 'button', text: label,
        onclick: () => turnTo(Number(headingSlider.value) + step)}));
    }
    turns.append(this.el('button', {type: 'button', text: '북', title: '북쪽 정렬 (0°)', onclick: () => turnTo(0)}));
    headingTool.node.append(turns);

    const patterns = options.patterns ?? [];
    const pattern = this.el('select', {name: PATTERN_FIELD});
    for (const item of patterns) pattern.append(this.el('option', {value: item.id, text: item.label, title: item.description || undefined}));
    pattern.value = patterns.some(item => item.id === values[PATTERN_FIELD]) ? values[PATTERN_FIELD] : (patterns[0]?.id ?? '');
    pattern.onchange = () => this.onChange(PATTERN_FIELD, pattern.value);
    const counts = this.el('div', {class: 'place-counts'},
      this.number('게이트', GATES_FIELD, {min: gateRange[0], max: gateRange[1],
        value: Number.parseInt(values[GATES_FIELD], 10) || gateRange[0], onInput: count => this.onChange(GATES_FIELD, count)}),
      this.number('FATO', FATO_FIELD, {min: fatoRange[0], max: fatoRange[1],
        value: Number.parseInt(values[FATO_FIELD], 10) || fatoRange[0], onInput: count => this.onChange(FATO_FIELD, count)}));
    const layoutTool = this.tool('레이아웃 조정', null,
      this.el('label', {class: 'place-pattern'}, this.el('span', {text: '배치 형태'}), pattern), counts);

    const confirm = onConfirm ?? (() => this.onPlace());
    const dismiss = onDismiss ?? (() => this.onResume());
    // Placing already follows the cursor; adjusting one that is already there
    // offers to pick it up again.
    const relocate = onRelocate
      ? this.el('button', {type: 'button', class: 'place-relocate', text: relocateLabel, onclick: () => onRelocate()})
      : null;
    const place = this.el('button', {type: 'button', class: 'place-confirm', text: confirmLabel, onclick: () => confirm()});
    const resume = this.el('button', {type: 'button', text: dismissLabel, onclick: () => dismiss()});
    this.note = this.el('p', {class: 'place-note', text: note});
    const card = this.el('div', {class: 'place-menu glass', role: 'dialog', 'aria-label': '버티포트 배치 도구', id: 'place-menu'},
      this.el('header', {}, this.el('strong', {text: title}),
        this.el('button', {type: 'button', class: 'place-close', 'aria-label': '도구 닫기', text: '×', onclick: () => dismiss()})),
      heightTool.node, headingTool.node, layoutTool.node, relocate,
      this.el('div', {class: 'place-actions'}, place, resume),
      // Anything else the caller wants done to this vertiport from here - a
      // look at it, its removal - so one card is the whole of editing it.
      actions.length ? this.el('div', {class: 'place-extra'}, ...actions) : null,
      this.note);

    this.anchor = screen;
    this.fit(card, HEIGHT_PX);
    this.root = card; this.isOpen = true;
    (this.mount ?? this.document.body)?.append(card);
    // Now that it is in the page it has a real height, which is what has to
    // stay inside the window - the guess above was for a card with nothing
    // extra in it, and a taller one ran off the bottom of the screen.
    this.fit(card);
    const view = this.document.defaultView ?? globalThis.window;
    if (view?.addEventListener) {
      this.onResize = () => {if (this.root) this.fit(this.root);};
      view.addEventListener('resize', this.onResize);
    }
    return card;
  }
  // Put the card beside its anchor and inside the viewport, by its measured
  // size when it has one and by `assumed` pixels until it does.
  fit(card, assumed = null) {
    const {width, height: viewHeight} = this.space();
    const rect = assumed === null && typeof card.getBoundingClientRect === 'function' ? card.getBoundingClientRect() : null;
    const cardWidth = rect?.width > 0 ? rect.width : WIDTH_PX;
    const cardHeight = rect?.height > 0 ? rect.height : (assumed ?? HEIGHT_PX);
    const screen = this.anchor ?? {x: 0, y: 0};
    card.style.left = `${clamp(screen.x + MARGIN_PX, MARGIN_PX, Math.max(MARGIN_PX, width - cardWidth - MARGIN_PX))}px`;
    card.style.top = `${clamp(screen.y + MARGIN_PX, MARGIN_PX, Math.max(MARGIN_PX, viewHeight - cardHeight - MARGIN_PX))}px`;
  }
  // What the map measured under the parked preview, so the operator can raise
  // the deck against a reading instead of guessing.
  setNote(text) {if (this.note && text) this.note.textContent = text;}
  close() {
    const view = this.document.defaultView ?? globalThis.window;
    if (this.onResize && view?.removeEventListener) view.removeEventListener('resize', this.onResize);
    this.onResize = null;
    this.root?.remove();
    this.root = null; this.note = null; this.isOpen = false;
  }
}
