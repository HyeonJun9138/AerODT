// A small stand-in for the DOM the panels build into: enough of Element for
// buildElement, querySelector by tag/id/class/attribute, forms and clicks.
// Real elements carry custom properties through setProperty; a bare object
// would make a panel that sets one look like it set nothing.
function styleObject() {
  const style = {};
  style.setProperty = (name, value) => {style[name] = String(value);};
  style.getPropertyValue = name => style[name] ?? '';
  style.removeProperty = name => {delete style[name];};
  return style;
}

export class FakeElement {
  constructor(tag) {this.tagName = tag.toUpperCase(); this.attributes = {}; this.children = []; this.dataset = {}; this.style = styleObject(); this._text = ''; this.value = ''; this.hidden = false; this.disabled = false; this.checked = false; this.parent = null;}
  get textContent() {return this.children.length ? this.children.map(c => c.textContent).join('') + this._text : this._text;}
  set textContent(v) {this.children = []; this._text = String(v);}
  get className() {return this.attributes.class ?? '';}
  set className(v) {this.attributes.class = v;}
  get placeholder() {return this.attributes.placeholder ?? '';}
  set placeholder(v) {this.attributes.placeholder = String(v);}
  setAttribute(k, v) {this.attributes[k] = String(v); if (k === 'value') this.value = String(v); if (k === 'hidden') this.hidden = true; if (k === 'disabled') this.disabled = true; if (k === 'checked') this.checked = true;}
  getAttribute(k) {return this.attributes[k] ?? null;}
  removeAttribute(k) {delete this.attributes[k]; if (k === 'disabled') this.disabled = false;}
  append(...nodes) {for (const n of nodes) {if (n === null || n === undefined) continue; if (typeof n === 'string') {this._text += n; continue;} n.parent = this; this.children.push(n);}}
  replaceChildren(...nodes) {this.children = []; this._text = ''; this.append(...nodes);}
  remove() {if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);}
  // Insert siblings ahead of this node, the way the DOM does: a panel that
  // builds a section and places it before an existing one needs somewhere to
  // put it, and without a parent there is nowhere, so the call is a no-op.
  before(...nodes) {
    if (!this.parent) return;
    const at = this.parent.children.indexOf(this);
    const fresh = nodes.filter(node => node !== null && node !== undefined && typeof node !== 'string');
    for (const node of fresh) node.parent = this.parent;
    this.parent.children.splice(at < 0 ? this.parent.children.length : at, 0, ...fresh);
  }
  *walk() {for (const c of this.children) {yield c; yield* c.walk();}}
  matches(selector) {
    const [tag, rest] = selector.match(/^([a-z]*)(.*)$/).slice(1);
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (!rest) return true;
    if (rest.startsWith('#')) return this.attributes.id === rest.slice(1);
    if (rest.startsWith('.')) return (this.attributes.class ?? '').split(/\s+/).includes(rest.slice(1));
    const attribute = rest.match(/^\[([a-z_-]+)=(.+)\]$/);
    return attribute ? this.attributes[attribute[1]] === attribute[2] : false;
  }
  querySelector(selector) {for (const n of this.walk()) if (n.matches(selector)) return n; return null;}
  querySelectorAll(selector) {return [...this.walk()].filter(n => n.matches(selector));}
  reset() {for (const n of this.walk()) if (n.tagName === 'INPUT') n.value = n.attributes.value ?? ''; else if (n.tagName === 'SELECT') n.value = (n.children.find(o => 'selected' in o.attributes) ?? n.children[0])?.attributes.value ?? '';}
  click() {this.onclick?.({preventDefault() {}});}
  submit() {this.onsubmit?.({preventDefault() {}});}
}
export const fakeDocument = {createElement: tag => new FakeElement(tag),
  createElementNS: (_namespace, tag) => new FakeElement(tag), body: new FakeElement('body')};
