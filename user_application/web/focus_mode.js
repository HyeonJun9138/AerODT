// 시야 집중 모드. Watching one aircraft fly is a different job from operating
// the dashboard, and the panels that make the second job possible are exactly
// what covers the first. This puts every panel away and leaves the map, the
// clock, and the map's own attribution, which is not chrome and may not be
// hidden. One round control beside the clock is always on screen, in both
// directions, because a view with no way out of it is a trap.
export class FocusMode {
  constructor({document = globalThis.document, onChange = () => {}} = {}) {
    Object.assign(this, {document, onChange});
    this.active = false;
  }
  // The same control is the way in and the way out; the console buttons call
  // toggle() as well, so there is never more than one truth about the state.
  toggle() {return this.set(!this.active);}
  set(active) {
    this.active = Boolean(active);
    const body = this.document.body;
    if (this.active) body?.setAttribute?.('data-focus', 'on');
    else body?.removeAttribute?.('data-focus');
    this.paint();
    this.onChange(this.active);
    return this.active;
  }
  paint() {
    const button = this.document.getElementById?.('focus-exit');
    if (!button) return;
    button.setAttribute('aria-pressed', String(this.active));
    button.setAttribute('aria-label', this.active ? '시야 집중 모드 해제' : '시야 집중 모드');
    button.setAttribute('title', this.active
      ? '집중 모드 해제 — 패널을 다시 표시합니다 (Esc)'
      : '시야 집중 모드 — 지도·시계·조종석 계기를 유지하고 작업 패널을 숨깁니다');
    if (button.textContent !== (this.active ? '◉' : '◎')) button.textContent = this.active ? '◉' : '◎';
  }
  // Wire the round control and Escape. Escape leaves focus mode before anything
  // else can read it, or the key would deselect the aircraft being watched and
  // the operator would have lost the thing they were watching to get a panel back.
  attach() {
    const button = this.document.getElementById?.('focus-exit');
    if (button) button.onclick = () => this.toggle();
    this.paint();
    this.escape = event => {if (event.key === 'Escape' && this.active) {event.stopPropagation(); this.set(false);}};
    this.document.addEventListener?.('keydown', this.escape, true);
    return this;
  }
  destroy() {
    if (this.escape) this.document.removeEventListener?.('keydown', this.escape, true);
    this.escape = null;
    this.set(false);
  }
}
