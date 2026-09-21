// One wide side panel next to the work-area rail. It owns which rail section is
// expanded and nothing else: no map, transport or twin state. Opening a section
// widens the shell (the owner's data attribute drives the layout offset), so the
// panels anchored to the left move aside instead of being covered.
const EMPTY = '표시할 내용이 아직 없습니다.';

export class WorkPanel {
  constructor({root, title, body, owner, buttons = {}, empty = EMPTY}) {
    Object.assign(this, {root, title, body, owner, buttons, empty});
    this.openId = null;
    this.apply();
  }
  // A section either renders its own content into the body or states that it
  // is empty; the panel never keeps section content of its own.
  open(id, {label, empty, render} = {}) {
    this.openId = id;
    this.title.textContent = label ?? id;
    if (typeof render === 'function') {
      this.body.textContent = '';
      render(this.body);
    } else {
      this.body.textContent = empty ?? this.empty;
    }
    this.apply();
    return true;
  }
  close() {
    this.openId = null;
    this.apply();
    return false;
  }
  toggle(id, view) {
    return this.openId === id ? this.close() : this.open(id, view);
  }
  apply() {
    const open = this.openId !== null;
    this.root.inert = !open;
    this.root.setAttribute('aria-hidden', String(!open));
    this.owner.dataset.drawer = open ? 'open' : 'closed';
    this.owner.dataset.drawerSection = this.openId ?? '';
    for (const [id, button] of Object.entries(this.buttons)) {
      button?.setAttribute('aria-expanded', String(open && id === this.openId));
    }
  }
}
