// User/Application: the 3D model shelf inside the Library section.
//
// The library holds nearly ninety models, so showing them all at once would
// bury the data sources above. A closed group per kind keeps the panel short:
// open a kind to get its list, pick an item to see the picture the asset
// library already produced during review. No model is downloaded to browse
// them; only the thumbnail the catalogue publishes.
const GROUPS = [
  {id: 'aircraft', label: 'UAM · 항공기'},
  {id: 'satellite', label: '위성 · 우주'},
  {id: 'person', label: '사람 / 승객'},
];

const collator = new Intl.Collator('ko');

export function groupModels(catalog) {
  const groups = new Map(GROUPS.map(group => [group.id, []]));
  for (const asset of catalog?.assets ?? []) {
    // A picture is the whole point of this shelf; an entry without one would
    // open to an empty frame.
    if (!asset?.thumbnail || !groups.has(asset.kind)) continue;
    groups.get(asset.kind).push(asset);
  }
  for (const list of groups.values()) {
    list.sort((left, right) => collator.compare(left.title ?? left.asset_id, right.title ?? right.asset_id));
  }
  return groups;
}

// The projection joins credit, licence and URL with semicolons. The picture is
// what this shelf is for, so the caption carries only what a reader scans off
// one line -- how big the thing is, and on whose terms it may be used. The
// credit stays with the licence, because dropping it is not ours to do; it
// moves onto the licence link rather than taking a line of its own.
export function modelFacts(asset) {
  const fields = String(asset?.attribution ?? '').split(';').map(part => part.trim());
  const [credit = '', licence = ''] = fields;
  const url = fields.find(part => /^https?:\/\//.test(part)) ?? '';
  const size = Number(asset?.size_m);
  const text = asset?.kind === 'person' ? '인체 크기 미보정'
    : Number.isFinite(size) && size > 0 ? `${size.toFixed(1)} m` : '';
  return {text, url, credit, licence,
          // Both parts of the legal line, kept together wherever it is shown.
          rights: [credit, licence].filter(Boolean).join(' · ')};
}

export function describeModel(asset) {
  const facts = modelFacts(asset);
  return [facts.text, facts.rights].filter(Boolean).join(' · ');
}

export class ModelLibrary {
  // `load` lets the shelf fetch the catalogue itself. It is normally handed one
  // during start-up, but that happens on the map's boot path: when the map
  // fails, the shelf used to sit on "loading" for ever with no way back. The
  // inventory does not depend on the globe, so it no longer waits for it.
  constructor({el, document = globalThis.document, load = null, allowedKinds = null}) {
    Object.assign(this, {el, document, load, allowedKinds});
    this.catalog = null;
    this.state = 'loading';
    this.attempted = false;
    // Groups start closed and only one picture is open, so the section stays
    // the height of two rows until the operator asks for more.
    this.openGroups = new Set();
    this.openModel = null;
    this.container = null;
  }
  setCatalog(catalog) {
    const usable = catalog && Array.isArray(catalog.assets) ? catalog : null;
    this.catalog = usable;
    // Being told the list did not arrive is different from not having been told
    // anything yet, and the two need different words on screen.
    this.state = usable ? 'ready' : 'failed';
    if (usable) this.attempted = true;
    if (this.container) this.render(this.container);
  }
  // Fetch the inventory ourselves, once, when nobody has handed us one.
  async fetchCatalog() {
    if (!this.load || this.attempted) return;
    this.attempted = true;
    try {
      const catalog = await this.load();
      this.setCatalog(catalog);
    } catch {
      this.state = 'failed';
      if (this.container) this.render(this.container);
    }
  }
  retry() {
    this.attempted = false;
    this.state = 'loading';
    if (this.container) this.render(this.container);
    void this.fetchCatalog();
  }
  render(container) {
    this.container = container;
    container.textContent = '';
    container.append(this.el('h3', {class: 'model-shelf-title', text: '3D 모델'}));
    if (!this.catalog) {
      if (this.state === 'failed') {
        container.append(this.el('p', {class: 'library-note', text: '시각 자산 목록을 불러오지 못했습니다.'}));
        if (this.load) {
          container.append(this.el('button', {type: 'button', id: 'model-retry', class: 'model-retry',
            text: '다시 시도', onclick: () => this.retry()}));
        }
      } else {
        container.append(this.el('p', {class: 'library-note', text: '시각 자산 목록을 불러오는 중입니다.'}));
        void this.fetchCatalog();
      }
      return container;
    }
    const groups = groupModels(this.catalog);
    for (const group of GROUPS.filter(group=>!this.allowedKinds||this.allowedKinds.includes(group.id))) {
      const models = groups.get(group.id) ?? [];
      const opened = this.openGroups.has(group.id) && models.length > 0;
      const list = this.el('div', {class: 'library-body model-list', id: `model-group-${group.id}-body`});
      list.hidden = !opened;
      // A closed group builds nothing: the satellite list alone is dozens of
      // rows with an image each, and none of it is worth creating unopened.
      if (opened) {
        for (const asset of models) list.append(this.item(asset));
      } else if (models.length === 0) {
        list.append(this.el('p', {class: 'library-note', text: '표시할 모델이 없습니다.'}));
      }
      const head = this.el('button', {type: 'button', class: 'library-head model-head',
        id: `model-group-${group.id}-head`, 'aria-expanded': String(opened),
        'aria-controls': `model-group-${group.id}-body`,
        ...(models.length ? {} : {'aria-disabled': 'true'}),
        onclick: () => {if (models.length) this.toggleGroup(group.id);}},
        this.el('span', {class: 'library-title'},
          this.el('strong', {text: group.label}),
          this.el('span', {class: 'library-provider', text: `${models.length}개`})),
        models.length ? this.el('span', {class: 'library-chevron', 'aria-hidden': 'true', text: '⌄'}) : null);
      container.append(this.el('section', {class: 'library-card model-group',
        id: `model-group-${group.id}`, 'data-open': String(opened)}, head, list));
    }
    return container;
  }
  item(asset) {
    const opened = this.openModel === asset.asset_id;
    const button = this.el('button', {type: 'button', class: 'model-item',
      id: `model-item-${asset.asset_id}`, 'aria-expanded': String(opened),
      'aria-controls': `model-photo-${asset.asset_id}`,
      onclick: () => this.toggleModel(asset.asset_id)},
      this.el('span', {class: 'model-item-name', text: asset.title ?? asset.asset_id}));
    // The picture exists only while the model is open. A hidden image is not
    // fetched by the browser, so building every row's image up front left the
    // opened one blank until something else forced a load.
    const figure = opened ? this.photo(asset) : null;
    return this.el('div', {class: 'model-entry', 'data-open': String(opened)}, button, figure);
  }
  photo(asset) {
    const facts = modelFacts(asset);
    const image = this.el('img', {decoding: 'async', src: asset.thumbnail,
      alt: `${asset.title ?? asset.asset_id} 미리보기`});
    const caption = this.el('figcaption', {});
    if (facts.text) caption.append(this.el('span', {text: facts.text}));
    // One link says who made it and on what licence, and goes to the terms.
    // Without a URL the same words are plain text: the credit is still owed.
    if (facts.rights) {
      caption.append(facts.url
        ? this.el('a', {href: facts.url, target: '_blank', rel: 'noopener noreferrer',
            class: 'model-licence', text: facts.rights, title: facts.rights})
        : this.el('span', {class: 'model-rights', text: facts.rights, title: facts.rights}));
    }
    const figure = this.el('figure', {class: 'model-photo', id: `model-photo-${asset.asset_id}`},
      image, caption);
    // A thumbnail that will not load must say so rather than leave a gap that
    // reads as a broken panel.
    image.onerror = () => {
      image.hidden = true;
      figure.append(this.el('p', {class: 'library-note', text: '미리보기 이미지를 불러오지 못했습니다.'}));
    };
    return figure;
  }
  toggleGroup(id) {
    if (this.openGroups.has(id)) this.openGroups.delete(id); else this.openGroups.add(id);
    if (this.container) this.render(this.container);
  }
  toggleModel(assetId) {
    // One picture at a time: opening a second would push the list off screen.
    const opening = this.openModel !== assetId;
    this.openModel = opening ? assetId : null;
    if (this.container) this.render(this.container);
    // The list scrolls inside itself, so an item near the bottom opens its
    // picture out of sight unless the view is brought to it.
    if (opening) this.reveal(assetId);
  }
  reveal(assetId) {
    const entry = this.container?.querySelector?.(`#model-photo-${assetId}`);
    entry?.scrollIntoView?.({block: 'nearest', behavior: 'smooth'});
  }
}
