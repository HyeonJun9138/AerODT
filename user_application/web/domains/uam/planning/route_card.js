// A small card that opens on the map where the operator clicked: a waypoint's
// details, the form for a new one, or the steps of a new link. It owns no
// route data; the route panel builds the content and hears every change. One
// card at a time, kept inside the viewport, closed with its own button or by
// whatever the panel decides.
import {buildElement} from '../../../dom_builder.js';

const WIDTH_PX = 248;
const MARGIN_PX = 10;
const HEIGHT_PX = 320;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
// Card kinds, by the tab that opens them: the route editor's waypoints and
// links, and the vertiport a click on the map landed on.
export const TAGS = {'node-new': '지점 추가', 'node-info': '지점', 'node-edit': '지점 수정',
  'link-new': '구간 연결', 'link-edit': '구간 수정', 'vertiport': '버티포트'};

export class RouteCard {
  constructor({document = globalThis.document, mount = null, viewport = null, onClose = () => {}} = {}) {
    Object.assign(this, {document, mount, viewport, onClose});
    this.root = null; this.isOpen = false; this.body = null;
  }
  el(tag, props = {}, ...children) {return buildElement(this.document, tag, props, ...children);}
  space() {
    if (typeof this.viewport === 'function') return this.viewport();
    const view = globalThis.window;
    return {width: view?.innerWidth ?? 1280, height: view?.innerHeight ?? 800};
  }
  // `screen` is where the click was; the card opens beside it. `title` heads
  // the card and `content` is the panel's own nodes.
  // `mode` names what the card is for (node-new, node-info, node-edit,
  // link-new, link-edit); it colours the header tag so a waypoint step and a
  // link step never look alike.
  open({screen = {x: 0, y: 0}, title = '', label = title, id = 'route-card', mode = 'node-info'} = {}, ...content) {
    this.close({silent: true});
    this.body = this.el('div', {class: 'route-card-body'}, ...content);
    const card = this.el('div', {class: 'route-card glass', role: 'dialog', 'aria-label': label, id, 'data-mode': mode},
      this.el('header', {}, this.el('b', {class: 'route-tag', text: TAGS[mode] ?? mode}), this.el('strong', {text: title}),
        this.el('button', {type: 'button', class: 'place-close', 'aria-label': '카드 닫기', text: '×', onclick: () => this.close()})),
      this.body);
    this.anchor = screen;
    this.fit(card, HEIGHT_PX);
    this.root = card; this.isOpen = true;
    (this.mount ?? this.document.body)?.append(card);
    // In the page it has its real height; a card with a long form in it was
    // placed by the guess and ran off the bottom of the screen.
    this.fit(card);
    const view = this.document.defaultView ?? globalThis.window;
    if (view?.addEventListener) {
      this.onResize = () => {if (this.root) this.fit(this.root);};
      view.addEventListener('resize', this.onResize);
    }
    return card;
  }
  // Beside its anchor and inside the viewport, by measured size when the card
  // is in the page and by `assumed` pixels until it is.
  fit(card, assumed = null) {
    const {width, height} = this.space();
    const rect = assumed === null && typeof card.getBoundingClientRect === 'function' ? card.getBoundingClientRect() : null;
    const cardWidth = rect?.width > 0 ? rect.width : WIDTH_PX;
    const cardHeight = rect?.height > 0 ? rect.height : (assumed ?? HEIGHT_PX);
    const screen = this.anchor ?? {x: 0, y: 0};
    card.style.left = `${clamp(screen.x + MARGIN_PX, MARGIN_PX, Math.max(MARGIN_PX, width - cardWidth - MARGIN_PX))}px`;
    card.style.top = `${clamp(screen.y + MARGIN_PX, MARGIN_PX, Math.max(MARGIN_PX, height - cardHeight - MARGIN_PX))}px`;
  }
  // Replace the content in place, for a card that moves to its next step.
  replace(...content) {
    if (!this.body) return;
    this.body.textContent = '';
    this.body.append(...content);
  }
  close({silent = false} = {}) {
    const wasOpen = this.isOpen;
    const view = this.document.defaultView ?? globalThis.window;
    if (this.onResize && view?.removeEventListener) view.removeEventListener('resize', this.onResize);
    this.onResize = null;
    this.root?.remove();
    this.root = null; this.body = null; this.isOpen = false;
    if (wasOpen && !silent) this.onClose();
  }
}
