// User/Application: the 항로 (route) tab of the Simulation section. The
// network is managed on the map, not in a list: waypoints are placed by
// clicking, named after where they are, given an altitude; clicking one
// waypoint and then another makes a link, which takes a flight-profile
// segment and, for a cruise corridor, a width. The vertiports' FATOs are
// endpoints a route starts from (take-off) or ends at (landing). The panel
// shows what mode the map is in and how much exists; the cards that open
// beside the click carry the same mode tag so a waypoint step never looks
// like a link step. The panel keeps the last network the server sent and the
// server's options, nothing else.
import {buildElement, buildSvg} from '../../../dom_builder.js';

export const FEET_PER_METRE = 1 / 0.3048;
export const CORRIDOR_SEGMENT = 'F';
export const FALLBACK_OPTIONS = {
  segments: [
    {id: 'C', label: 'Climb-out', korean: '상승', color: '#ffb457', covers: 'C–E',
      parts: ['C 전환 상승', 'D 출발 터미널 절차', 'E 가속 상승']},
    {id: 'F', label: 'Cruise', korean: '순항', color: '#7fe9f5', covers: 'F', parts: ['F 순항']},
    {id: 'G', label: 'Descent', korean: '강하', color: '#a5c8ff', covers: 'G–I',
      parts: ['G 감속 강하', 'H 도착 터미널 절차', 'I 전환 강하']},
  ],
  next_segment: {C: 'F', F: 'F', G: 'G'},
  altitude_references: [{id: 'agl', label: '지면 기준 (AGL)'}, {id: 'msl', label: '절대 고도'}],
  defaults: {altitude_m: 304.8, altitude_ft: 1000, altitude_reference: 'agl', width_m: 300, fato_hover_m: 30, segment: 'F', corridor_segment: 'F'},
  limits: {width_m: [20, 5000], altitude_m: [0, 10000], name: 80},
};
// The letters that were once chosen on their own, folded into the run that
// flies them, so a link saved before the profile was joined up still reads.
export const MERGED_SEGMENTS = {D: 'C', E: 'C', H: 'G', I: 'G'};
export const foldSegment = id => MERGED_SEGMENTS[id] ?? id;
// The mission profile, drawn at the size of a card: a vertiport deck at either
// end, the vertical hover over its FATO, and between them the three runs a link
// can be. Climb-out and descent are one diagonal each because the terminal
// procedures and the acceleration are flown inside them.
export const PROFILE_VIEW = {width: 224, height: 112};
export const PROFILE_SHAPE = {
  C: {line: [[34, 80], [86, 26]], label: [66, 68], letters: 'C·D·E'},
  F: {line: [[86, 26], [138, 26]], label: [112, 13], letters: 'F'},
  G: {line: [[138, 26], [190, 80]], label: [158, 68], letters: 'G·H·I'},
};
const path = ([[x1, y1], [x2, y2]]) => `M${x1} ${y1}L${x2} ${y2}`;
const ROLE_LABEL = {takeoff: '이륙', landing: '착륙', both: '이착륙'};
// What the map is doing, as shown on the panel strip and the card tags.
export const MODES = {
  idle: {label: '보기', hint: '지점을 클릭하면 정보 · 지점을 고른 뒤 다른 지점을 클릭하면 구간 · 구간을 클릭하면 수정'},
  adding: {label: '지점 추가', hint: '지도를 클릭하면 그 자리에 지점이 생깁니다 · 다시 누르거나 Esc로 끝'},
  moving: {label: '위치 변경', hint: '지도를 클릭하면 그 자리로 옮깁니다 · 원래 자리는 흐리게 남습니다 · Esc로 취소'},
  selected: {label: '구간 연결 대기', hint: '다른 지점을 클릭하면 구간이 이어집니다 · 흐린 지점은 이미 이어져 있습니다 · 같은 지점을 다시 클릭하면 해제'},
  linking: {label: '구간 연결', hint: '카드에서 종류를 고르면 구간이 그려집니다'},
};
export const isFato = id => typeof id === 'string' && id.startsWith('fato:');
// A FATO decides the segment, as the server also reasons: a route leaves one
// climbing and meets one descending. Null between two waypoints.
export function fixedSegment(from, to, options = FALLBACK_OPTIONS) {
  const fixed = options.fato_segments ?? {departure: 'C', arrival: 'G'};
  if (isFato(from)) return fixed.departure ?? 'C';
  if (isFato(to)) return fixed.arrival ?? 'G';
  return null;
}
// What the server says about a stored link that no longer fits its FATO, in words.
export function problemText(problem) {
  if (!problem) return '';
  if (problem.startsWith('from:')) return '이륙용이 아닌 FATO에서 출발합니다. 버티포트의 FATO 속성을 바꾸거나 이 구간을 지우세요.';
  if (problem.startsWith('to:')) return '착륙용이 아닌 FATO로 들어옵니다. 버티포트의 FATO 속성을 바꾸거나 이 구간을 지우세요.';
  if (problem.includes('climbing')) return 'FATO에서 출발하는 구간은 상승(C·D·E)이어야 합니다. 저장하면 상승으로 고쳐집니다.';
  if (problem.includes('descending')) return 'FATO로 들어오는 구간은 강하(G·H·I)여야 합니다. 저장하면 강하로 고쳐집니다.';
  return problem;
}
// How many links to send the building check at once, and the words for what it found.
export const CONFLICT_BATCH = 8;
export function conflictText(report) {
  if (!report) return '';
  const worst = report.buildings?.[0];
  if (!worst) return '건물 여유 충분 (30 m 이상)';
  const head = report.collisions > 0 ? `⚠ 건물 충돌 ${report.collisions}동` : `△ 건물 근접 ${report.tight}동`;
  return `${head} · 가장 가까운 ${worst.name || '건물'} ${Math.round(worst.height_m)} m (지붕 ${Math.round(worst.top_m)} m) · 경로 ${Math.round(worst.path_m)} m · 여유 ${Math.round(worst.clearance_m)} m`;
}
// Why a link is not drawn in its segment's colour.
//
// The map paints a building collision red and a close pass amber, over the top
// of the segment colour, because a route that clips a roof is worth more than
// knowing it is a descent. That is right, but with nothing said about it the
// operator sets a segment, sees the wrong colour, and reasonably concludes the
// setting did not take. So the card says which colour is on the map and why.
export function drawnColourNote(report, segment, segments = FALLBACK_OPTIONS.segments) {
  const own = segments.find(s => s.id === foldSegment(segment))?.korean ?? '구간';
  if (report?.collisions > 0) return `지도에서는 건물 충돌 경고색(진한 빨강)으로 그립니다 · 경고가 사라지면 ${own} 색으로 돌아옵니다`;
  if (report?.tight > 0) return `지도에서는 건물 근접 경고색(연한 빨강)으로 그립니다 · 경고가 사라지면 ${own} 색으로 돌아옵니다`;
  return '';
}
// A locality name holds over about half a kilometre; one lookup a second at most.
export const PLACE_GRID_DEGREES = 0.005;
export const PLACE_ASK_INTERVAL_MS = 1000;

export const metresToFeet = metres => metres * FEET_PER_METRE;
export const feetToMetres = feet => feet / FEET_PER_METRE;

// Altitude form values -> metres, or the reason they are not usable.
export function altitudeFromForm({altitude, unit = 'ft'}, limits = FALLBACK_OPTIONS.limits) {
  const value = Number(altitude);
  if (altitude === '' || altitude === undefined || altitude === null || !Number.isFinite(value)) return {error: '고도를 숫자로 입력하세요.'};
  const metres = unit === 'm' ? value : feetToMetres(value);
  const [low, high] = limits.altitude_m ?? [0, 10000];
  if (metres < low || metres > high) return {error: `고도는 ${Math.round(low)}~${Math.round(high)} m (${Math.round(metresToFeet(low))}~${Math.round(metresToFeet(high)).toLocaleString()} ft) 사이여야 합니다.`};
  return {metres: Math.round(metres * 1000) / 1000};
}

// Node form values -> the definition the server accepts, or the reasons it would not.
export function nodeFromForm(values, options = FALLBACK_OPTIONS) {
  const errors = [];
  const name = String(values.name ?? '').trim();
  if (name.length > (options.limits?.name ?? 80)) errors.push('이름은 80자 이내여야 합니다.');
  const altitude = altitudeFromForm(values, options.limits);
  if (altitude.error) errors.push(altitude.error);
  const references = (options.altitude_references ?? FALLBACK_OPTIONS.altitude_references).map(r => r.id);
  const reference = references.includes(values.altitude_reference) ? values.altitude_reference : 'agl';
  const latitude = Number(values.latitude), longitude = Number(values.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) errors.push('위치가 없습니다. 지도를 클릭해 지점을 놓으세요.');
  if (errors.length) return {errors};
  const definition = {name, latitude, longitude, altitude_m: altitude.metres, altitude_reference: reference};
  if (!name && values.place_name) definition.place_name = String(values.place_name).trim();
  return {definition};
}

// Link form values -> definition, or the reasons. Only a cruise link carries a width.
export function linkFromForm(values, options = FALLBACK_OPTIONS) {
  const errors = [];
  const segments = (options.segments ?? FALLBACK_OPTIONS.segments).map(s => s.id);
  const chosen = foldSegment(values.segment);
  if (!segments.includes(chosen)) errors.push('구간 종류를 고르세요.');
  const corridor = chosen === (options.defaults?.corridor_segment ?? CORRIDOR_SEGMENT);
  const width = Number(values.width_m);
  const [low, high] = options.limits?.width_m ?? [20, 5000];
  if (corridor && (!Number.isFinite(width) || width < low || width > high)) errors.push(`폭은 ${low}~${high} m 사이 숫자여야 합니다.`);
  if (!values.from || !values.to) errors.push('연결할 두 지점이 필요합니다.');
  const fixed = fixedSegment(values.from, values.to, options);
  if (fixed && segments.includes(chosen) && chosen !== fixed) errors.push(fixed === 'C' ? 'FATO에서 출발하는 구간은 상승(C)만 됩니다.' : 'FATO로 들어오는 구간은 강하(G)만 됩니다.');
  if (errors.length) return {errors};
  const definition = {from: values.from, to: values.to, segment: chosen};
  if (corridor) definition.width_m = Math.round(width * 1000) / 1000;
  const name = String(values.name ?? '').trim();
  if (name) definition.name = name;
  return {definition};
}

// The segment a new link most likely is, as the server also reasons: a climb
// from a FATO, a descent into one, otherwise what follows the segment that
// arrives at the start, and cruise when nothing does.
export function suggestSegment(from, to, links, next = FALLBACK_OPTIONS.next_segment) {
  if (isFato(from)) return 'C';
  if (isFato(to)) return 'G';
  const arriving = links.filter(link => link.to === from);
  return arriving.length ? (next[foldSegment(arriving[arriving.length - 1].segment)] ?? 'F') : 'F';
}

// How a FATO may be used in a link between `a` and `b`, clicked in that order:
// each usable direction with the FATO's role. A FATO that only takes off can
// only start the link, one that only lands can only end it, one that does both
// offers the choice; two FATOs cannot be joined.
// How two endpoints compare for "already joined", as the server also reasons:
// between two waypoints a route flies one way, so drawing the reverse as well
// is the same pair twice. A FATO is the exception — one direction is the
// vertiport's departure and the other its arrival.
export const pairKey = (a, b) => (isFato(a) || isFato(b)) ? `${a}→${b}` : [a, b].sort().join('↔');
export const linkBetween = (a, b, links) => (links ?? []).find(link => pairKey(link.from, link.to) === pairKey(a, b)) ?? null;

// The ways these two could still be joined: the directions the FATOs allow,
// less the ones that already exist. Empty means the pair is done.
export function openDirections(a, b, fatos, links) {
  return fatoDirections(a, b, fatos).filter(direction => !linkBetween(direction.from, direction.to, links));
}

export function fatoDirections(a, b, fatos) {
  const roleOf = id => fatos.find(f => f.id === id)?.role ?? 'both';
  const fatoA = isFato(a), fatoB = isFato(b);
  if (fatoA && fatoB) return [];
  if (!fatoA && !fatoB) return [{from: a, to: b, use: null}];
  const id = fatoA ? a : b, other = fatoA ? b : a, role = roleOf(id);
  const options = [];
  if (role === 'takeoff' || role === 'both') options.push({from: id, to: other, use: 'takeoff'});
  if (role === 'landing' || role === 'both') options.push({from: other, to: id, use: 'landing'});
  return options;
}

export function altitudeText(node) {
  const metres = Number(node.altitude_m) || 0;
  return `${Math.round(metresToFeet(metres)).toLocaleString()} ft (${Math.round(metres)} m) · ${node.altitude_reference === 'msl' ? '절대 고도' : '지면 기준'}`;
}

export function describeLink(link, names, segments = FALLBACK_OPTIONS.segments) {
  const segment = segments.find(s => s.id === foldSegment(link.segment));
  const label = segment ? `${segment.id} ${segment.label}` : link.segment;
  const width = Number.isFinite(Number(link.width_m)) && link.width_m ? ` · 폭 ${Math.round(link.width_m)} m` : '';
  return `${names[link.from] ?? link.from} → ${names[link.to] ?? link.to} · ${label}${width}`;
}

export class RoutePanel {
  constructor({api, notify = () => {}, document = globalThis.document, card = null, onNetwork = () => {}, onSelect = () => {},
    onEditing = () => {}, onFocus = () => {}, onMoveNode = () => {}, onPreviewLink = () => {}, groundAt = async () => null,
    positionOf = () => null, screenOf = () => null, conflictRequest = async () => null, onConflicts = () => {},
    setTimer = globalThis.setTimeout?.bind(globalThis), clearTimer = globalThis.clearTimeout?.bind(globalThis)}) {
    Object.assign(this, {api, notify, document, card, onNetwork, onSelect, onEditing, onFocus, onMoveNode, onPreviewLink,
      groundAt, positionOf, screenOf, conflictRequest, onConflicts, setTimer, clearTimer});
    // What the building check last said about each link, by id, and whether one is running.
    this.conflicts = new Map(); this.checking = null;
    this.network = {nodes: [], fatos: [], links: []};
    this.options = FALLBACK_OPTIONS; this.optionsLoaded = false;
    this.selected = null; this.adding = false; this.active = false; this.body = null; this.linking = null;
    // The waypoint whose position is being changed, while the map answers to it,
    // and the place one has been dropped at but not yet saved.
    this.moving = null; this.moved = null;
    this.ready = Promise.resolve(); this.placeSequence = 0;
    // Locality names by grid cell, asked for ahead of the click while the cursor
    // moves in adding mode. The server keeps the same grid, so a miss here is
    // still often a hit there.
    this.places = new Map(); this.lastPlaceAsk = -Infinity;
    if (this.card) this.card.onClose = () => this.cardClosed();
  }
  el(tag, props = {}, ...children) {return buildElement(this.document, tag, props, ...children);}
  svg(tag, props = {}, ...children) {return buildSvg(this.document, tag, props, ...children);}
  async loadOptions() {
    if (this.optionsLoaded || typeof this.api?.options !== 'function') return;
    try {
      const options = await this.api.options();
      if (options?.segments?.length) {this.options = {...FALLBACK_OPTIONS, ...options}; this.optionsLoaded = true;}
    } catch {/* the fallback options stay in force */}
  }
  get segments() {return this.options.segments ?? FALLBACK_OPTIONS.segments;}
  get corridorSegment() {return this.options.defaults?.corridor_segment ?? CORRIDOR_SEGMENT;}
  endpoints() {return [...(this.network.nodes ?? []), ...(this.network.fatos ?? [])];}
  endpoint(id) {return this.endpoints().find(item => item.id === id) ?? null;}
  names() {return Object.fromEntries(this.endpoints().map(item => [item.id, item.name]));}
  // ---- rendering -------------------------------------------------------
  render(body) {
    this.body = body;
    body.textContent = '';
    this.status = this.el('div', {class: 'route-status', id: 'route-status', role: 'status'},
      this.el('b', {class: 'route-tag', id: 'route-mode'}), this.el('span', {id: 'route-mode-text'}));
    body.append(this.status);
    this.addButton = this.el('button', {type: 'button', id: 'route-add', 'aria-pressed': String(this.adding),
      text: '＋ 지점 추가', onclick: () => this.setAdding(!this.adding)});
    this.clearButton = this.el('button', {type: 'button', id: 'route-clear', text: '선택 해제', onclick: () => {this.select(null); this.card?.close({silent: true}); this.showMode();}});
    // Every link against the buildings under it; a single link is checked on
    // its own the moment it is drawn or changed.
    this.checkButton = this.el('button', {type: 'button', id: 'route-check', text: '건물 충돌 검사',
      title: '모든 구간을 브이월드 건물 도형·높이와 대조합니다', onclick: () => void this.checkConflicts()});
    body.append(this.el('div', {class: 'sim-row route-tools'}, this.addButton, this.clearButton),
      this.el('div', {class: 'sim-row route-tools route-tools-check'}, this.checkButton));
    this.summary = this.el('p', {class: 'route-summary', id: 'route-summary'});
    body.append(this.summary);
    body.append(this.el('p', {class: 'route-hint', text: '지점과 구간은 지도에서 직접 다룹니다. 지점·구간에 마우스를 올리면 밝아지고, 클릭하면 카드가 열립니다. 버티포트 FATO도 지점입니다. 순항(F) 구간만 회랑 폭을 갖습니다.'}));
    this.error = this.el('p', {class: 'sim-error', role: 'alert', id: 'route-error'});
    body.append(this.error);
    this.showMode(); this.showSummary();
    this.ready = this.loadOptions().then(() => this.refresh());
  }
  mode() {
    if (this.moving) return 'moving';
    if (this.linking) return 'linking';
    if (this.adding) return 'adding';
    if (this.selected) return 'selected';
    return 'idle';
  }
  showMode() {
    if (!this.status) return;
    const mode = this.mode();
    this.status.dataset.mode = mode;
    this.status.querySelector('#route-mode').textContent = MODES[mode].label;
    let text = MODES[mode].hint;
    if (mode === 'selected') text = `${this.endpoint(this.selected)?.name ?? '지점'} 선택됨 · ${text}`;
    if (mode === 'moving') text = `${this.moving.node.name} · ${text}`;
    if (mode === 'linking') text = `${this.names()[this.linking.from] ?? ''} → ${this.names()[this.linking.to] ?? ''} · ${text}`;
    this.status.querySelector('#route-mode-text').textContent = text;
    this.addButton?.setAttribute('aria-pressed', String(this.adding));
    if (this.addButton) this.addButton.textContent = this.adding ? '지점 추가 끝내기' : '＋ 지점 추가';
    if (this.clearButton) this.clearButton.hidden = !this.selected;
  }
  showSummary() {
    if (!this.summary) return;
    const corridors = (this.network.links ?? []).filter(link => link.segment === this.corridorSegment).length;
    let text = `지점 ${this.network.nodes?.length ?? 0} · FATO ${this.network.fatos?.length ?? 0} · 구간 ${this.network.links?.length ?? 0} (순항 회랑 ${corridors})`;
    const problems = (this.network.links ?? []).filter(link => link.problem).length;
    if (problems) text += ` · FATO 불일치 ${problems}`;
    if (this.checking) text += this.checking.total === null ? ' · 건물 충돌 검사 준비 중 (지형 측정)' : ` · 건물 충돌 검사 중 ${this.checking.done}/${this.checking.total}`;
    else if (this.conflicts.size) {
      const reports = [...this.conflicts.values()];
      const collisions = reports.filter(report => report?.collisions > 0).length;
      const tight = reports.filter(report => !(report?.collisions > 0) && report?.tight > 0).length;
      text += ` · 건물 충돌 ${collisions}구간 · 근접 ${tight}구간 (검사 ${this.conflicts.size})`;
    }
    this.summary.textContent = text;
    if (this.checkButton) {this.checkButton.disabled = Boolean(this.checking); this.checkButton.textContent = this.checking ? '검사 중…' : '건물 충돌 검사';}
  }
  // ---- buildings ----------------------------------------------------------
  // The buildings under the routes have changed - a vertiport was moved, put
  // down or taken away - so every report is an answer about a city that is no
  // longer there. They go, rather than standing as warnings about a building
  // the operator can see is gone.
  dropConflicts() {
    if (!this.conflicts.size) return false;
    this.conflicts.clear();
    this.showSummary();
    // A card left open would go on showing the warning it was given. Build it
    // again from what is known now, which is nothing about buildings.
    if (this.editingLink && this.card?.isOpen) this.openLinkEdit(this.editingLink);
    return true;
  }
  // Every link, or the ones named, against the buildings under them. The map
  // supplies where the links stand and the ground along them; the server
  // measures them against the V-World footprints, a few links at a time, and
  // the map is told after each batch so the first results show early.
  async checkConflicts(ids = null) {
    if (this.checking || typeof this.api?.conflicts !== 'function') return false;
    // Measuring the ground along every link takes a moment of its own, so the
    // panel says it is busy from the click, not from the first batch.
    this.checking = {done: 0, total: null};
    this.showSummary();
    let request;
    try {request = await this.conflictRequest(ids);} catch {request = null;}
    const links = request?.links ?? [];
    if (!links.length) {this.checking = null; this.showSummary(); if (!ids) this.notify('ready', '검사할 구간이 없습니다.'); return false;}
    this.checking = {done: 0, total: links.length};
    this.showSummary();
    let failed = null;
    try {
      for (let start = 0; start < links.length; start += CONFLICT_BATCH) {
        const batch = links.slice(start, start + CONFLICT_BATCH);
        let answer;
        // The deck outlines go with every batch: the server measures each one
        // against the same city the map is drawing, without keeping any state.
        try {answer = await this.api.conflicts({links: batch, cleared: request.cleared ?? []});} catch (failure) {failed = failure; break;}
        for (const [id, report] of Object.entries(answer?.links ?? {})) this.conflicts.set(id, report);
        this.onConflicts(answer?.links ?? {});
        this.checking.done = Math.min(links.length, start + batch.length);
        this.showSummary();
      }
    } finally {this.checking = null;}
    this.showSummary();
    if (failed) {
      const missing = failed?.data?.error === 'buildings_not_configured' || failed?.status === 404;
      this.notify('error', missing ? '건물 충돌 검사에는 브이월드 건물 자료가 필요합니다 (vworld.json).' : '건물 충돌 검사를 마치지 못했습니다. 서버 연결을 확인하세요.');
      return false;
    }
    const checked = links.map(link => this.conflicts.get(link.id)).filter(Boolean);
    const collisions = checked.filter(report => report.collisions > 0).length;
    const tight = checked.filter(report => !(report.collisions > 0) && report.tight > 0).length;
    if (ids) {
      if (collisions || tight) this.notify(collisions ? 'error' : 'stale', `${collisions ? `건물 충돌 ${collisions}구간` : ''}${collisions && tight ? ' · ' : ''}${tight ? `건물 근접 ${tight}구간` : ''} · 지도에 표시했습니다.`);
    } else {
      this.notify(collisions ? 'error' : 'ready', collisions || tight
        ? `건물 충돌 검사: 충돌 ${collisions}구간, 근접 ${tight}구간 (${links.length}구간 검사) · 지도의 빨간·노란 구간을 보세요.`
        : `건물 충돌 검사: ${links.length}구간 모두 건물과 30 m 이상 떨어져 있습니다.`);
    }
    return true;
  }
  // The links that touch a waypoint: what to check again when it moves.
  linksTouching(id) {return (this.network.links ?? []).filter(link => link.from === id || link.to === id).map(link => link.id);}
  dangerButton(remove) {
    const button = this.el('button', {type: 'button', text: '삭제', class: 'sim-danger'});
    button.onclick = () => {
      if (button.dataset.armed !== 'true') {
        button.dataset.armed = 'true'; button.textContent = '삭제 확인';
        this.setTimer?.(() => {button.dataset.armed = 'false'; button.textContent = '삭제';}, 4000);
        return;
      }
      void remove();
    };
    return button;
  }
  // ---- editing state ---------------------------------------------------
  // The tab is on screen: the map's clicks are ours until it is left.
  activate() {this.active = true; this.arm();}
  deactivate() {
    this.stopMove({keepCard: true});
    this.active = false; this.adding = false; this.showLinking(null);
    this.card?.close({silent: true});
    this.select(null);
    this.onEditing(null);
  }
  arm() {
    if (!this.active) {this.onEditing(null); return;}
    if (this.moving) {
      // Every move of the cursor is where the waypoint would land, so the map
      // reports them all; the click is what fixes it.
      this.onEditing({crosshair: true, moveInterval: 0, onClick: event => this.mapClick(event), onMove: ground => this.moveTo(ground)});
      return;
    }
    this.onEditing({crosshair: this.adding, onClick: event => this.mapClick(event),
      onMove: this.adding ? ground => this.prefetchPlace(ground) : null});
  }
  // "위치 변경": the map answers to the cursor until a click fixes the new
  // place. The card stays open so its position line moves with the cursor.
  startMove(node, card) {
    if (!this.active) return;
    this.moving = {node, card, pose: null};
    this.adding = false; this.showLinking(null);
    this.onMoveNode(node.id, null);
    this.showMode(); this.arm();
  }
  stopMove({keepCard = false, landed = false} = {}) {
    if (!this.moving) return false;
    const {node, card} = this.moving;
    this.moving = null;
    this.onMoveNode(node.id, null);
    if (!landed) card?.resetPosition();
    if (!keepCard) {this.showMode(); this.arm();}
    return true;
  }
  // Where a waypoint is drawn now, which is the dropped place when it has one.
  shownPlace(id) {
    if (this.moved?.id === id) return {latitude: this.moved.latitude, longitude: this.moved.longitude};
    const node = this.endpoint(id);
    return node ? {latitude: node.latitude, longitude: node.longitude} : null;
  }
  // The cursor moved while a waypoint is being carried.
  moveTo(ground) {
    if (!this.moving || !ground) return false;
    this.moving.pose = ground;
    this.onMoveNode(this.moving.node.id, ground);
    this.moving.card?.showPosition(ground, {pending: true});
    return true;
  }
  // The click that puts it down. The waypoint moves on the map at once so the
  // click reads as done; the server hears about it when the card is saved.
  dropMove(ground) {
    const carried = this.moving;
    if (!carried) return;
    const place = ground ?? carried.pose;
    this.stopMove({landed: Boolean(place)});
    if (!place) return;
    carried.card?.setPosition(place);
    this.showMoved(carried.node.id, place);
    this.notify('ready', `${carried.node.name} 위치를 옮겼습니다. 저장을 눌러야 남습니다.`);
  }
  // The map showing a waypoint where it was dropped rather than where it is
  // saved. Everything drawn from the network — its label, its height, the
  // segments that touch it — follows, because the network is what is redrawn.
  showMoved(id, place) {
    this.moved = place ? {id, latitude: place.latitude, longitude: place.longitude} : null;
    this.onNetwork(this.shownNetwork(), this.segments);
  }
  shownNetwork() {
    if (!this.moved) return this.network;
    return {...this.network,
      nodes: (this.network.nodes ?? []).map(node => node.id === this.moved.id
        ? {...node, latitude: this.moved.latitude, longitude: this.moved.longitude} : node)};
  }
  // Given up or saved: the map goes back to what the server holds.
  clearMoved() {
    if (!this.moved) return false;
    this.moved = null;
    this.onNetwork(this.network, this.segments);
    return true;
  }
  placeKey({latitude, longitude}) {return `${Math.round(latitude / PLACE_GRID_DEGREES)},${Math.round(longitude / PLACE_GRID_DEGREES)}`;}
  // The locality name for a position: from memory, or one request, shared by
  // everything that asks for the same cell meanwhile.
  placeFor(ground) {
    const key = this.placeKey(ground);
    if (!this.places.has(key)) {
      if (typeof this.api?.place !== 'function') return Promise.resolve(null);
      const asked = Promise.resolve(this.api.place(ground.latitude, ground.longitude)).then(answer => answer?.name ?? null).catch(() => null);
      this.places.set(key, asked);
      // A failure is not remembered: the next ask tries again.
      asked.then(name => {if (name === null) this.places.delete(key);});
    }
    return this.places.get(key);
  }
  // The cursor moved while adding: ask for that cell's name now, at most one
  // request a second, so it is ready when the click comes.
  prefetchPlace(ground) {
    if (!this.adding || !ground) return false;
    const key = this.placeKey(ground);
    if (this.places.has(key)) return false;
    const now = globalThis.performance?.now?.() ?? Date.now();
    if (now - this.lastPlaceAsk < PLACE_ASK_INTERVAL_MS) return false;
    this.lastPlaceAsk = now;
    void this.placeFor(ground);
    return true;
  }
  setAdding(on) {
    this.adding = Boolean(on);
    if (this.adding) {this.select(null); this.showLinking(null); this.card?.close({silent: true});}
    this.showMode();
    this.arm();
  }
  // Escape: a move in progress first, then the card, the adding mode and the
  // selection; false when nothing was open.
  escape() {
    if (this.moving) {this.stopMove(); return true;}
    if (this.card?.isOpen) {this.card.close(); return true;}
    if (this.adding) {this.setAdding(false); return true;}
    if (this.selected) {this.select(null); return true;}
    return false;
  }
  cardClosed() {this.editingLink = null; this.stopMove(); this.clearMoved(); this.showLinking(null); this.showMode(); this.arm();}
  select(id) {
    this.selected = id ?? null;
    this.onSelect(this.selected, this.blockedFrom(this.selected));
    this.showMode();
  }
  // The endpoints the selected one can no longer be joined to, because every
  // direction between them already exists (and two FATOs never can be). The
  // map draws them faint so a click that would only be refused is not made.
  blockedFrom(id) {
    if (!id) return [];
    const fatos = this.network.fatos ?? [], links = this.network.links ?? [];
    return this.endpoints().filter(other => other.id !== id && !openDirections(id, other.id, fatos, links).length)
      .map(other => other.id);
  }
  // The pair a card is asking about, drawn on the map between the two points
  // until the card is answered or given up.
  showLinking(state) {
    this.linking = state ?? null;
    this.onPreviewLink(this.linking?.from ?? null, this.linking?.to ?? null);
  }
  screenFor(id) {const place = this.positionOf(id); return (place && this.screenOf(place)) ?? {x: 120, y: 120};}
  // What a click on the map means while this tab is active.
  mapClick({hit = null, ground = null, screen = {x: 0, y: 0}} = {}) {
    this.error.textContent = '';
    // While a waypoint is being carried the click is where it lands, whatever
    // it happens to land on.
    if (this.moving) {this.dropMove(ground); return;}
    if (hit?.kind === 'node') {
      if (this.selected === hit.id) {this.select(null); this.card?.close({silent: true}); this.showMode(); return;}   // the same again: let go
      if (this.selected) {this.openLinkCard(this.selected, hit.id, screen); return;}
      this.select(hit.id);
      this.openNodeCard(hit.id, screen);
      return;
    }
    if (hit?.kind === 'link') {
      const link = (this.network.links ?? []).find(item => item.id === hit.id);
      if (link) this.openLinkEdit(link, screen);
      return;
    }
    if (ground && this.adding) {this.openNewNodeCard(ground, screen); return;}
    this.select(null);
    this.card?.close({silent: true});
    this.showMode();
  }
  // ---- cards -------------------------------------------------------------
  open(mode, title, screen, ...content) {
    return this.card?.open({screen, title, label: title, mode}, ...content);
  }
  altitudeFields(metres, reference, groundHeight) {
    const unit = this.el('select', {name: 'unit'}, this.el('option', {value: 'ft', text: 'ft'}), this.el('option', {value: 'm', text: 'm'}));
    unit.value = 'ft';
    const altitude = this.el('input', {name: 'altitude', type: 'number', step: '1', min: '0', value: String(Math.round(metresToFeet(metres)))});
    altitude.value = String(Math.round(metresToFeet(metres)));
    const referenceSelect = this.el('select', {name: 'altitude_reference'});
    for (const item of this.options.altitude_references ?? FALLBACK_OPTIONS.altitude_references) referenceSelect.append(this.el('option', {value: item.id, text: item.label}));
    referenceSelect.value = reference;
    const note = this.el('small', {class: 'route-note', id: 'route-altitude-note'});
    let ground = Number.isFinite(groundHeight) ? groundHeight : null;
    const update = () => {
      const parsed = altitudeFromForm({altitude: altitude.value, unit: unit.value}, this.options.limits);
      if (parsed.error) {note.textContent = parsed.error; return;}
      const other = unit.value === 'm' ? `${Math.round(metresToFeet(parsed.metres)).toLocaleString()} ft` : `${Math.round(parsed.metres)} m`;
      const absolute = referenceSelect.value === 'msl' ? parsed.metres : (ground === null ? null : ground + parsed.metres);
      const where = referenceSelect.value === 'msl'
        ? `절대 고도 (타원체 기준)${ground === null ? '' : ` · 지면 ${Math.round(ground)} m 위 ${Math.round(parsed.metres - ground)} m`}`
        : `지면 기준 (AGL)${ground === null ? ' · 지면 고도 측정 중' : ` · 지면 ${Math.round(ground)} m → 절대 ${Math.round(absolute)} m`}`;
      note.textContent = `= ${other} · ${where}`;
    };
    unit.onchange = () => {
      const parsed = altitudeFromForm({altitude: altitude.value, unit: unit.value === 'm' ? 'ft' : 'm'}, this.options.limits);
      if (!parsed.error) altitude.value = String(unit.value === 'm' ? Math.round(parsed.metres) : Math.round(metresToFeet(parsed.metres)));
      update();
    };
    altitude.oninput = update; referenceSelect.onchange = update;
    update();
    return {rows: [this.el('div', {class: 'sim-row'}, this.el('label', {}, this.el('span', {text: '고도'}), altitude), this.el('label', {class: 'route-unit'}, this.el('span', {text: '단위'}), unit)),
      this.el('label', {}, this.el('span', {text: '기준'}), referenceSelect), note], update,
      setGround: height => {ground = Number.isFinite(height) ? height : null; update();}};
  }
  nodeForm({mode, title, values, screen, submit, ground = null, move = null}) {
    const form = this.el('form', {class: 'sim-form route-form', novalidate: ''});
    const name = this.el('input', {name: 'name', type: 'text', maxlength: '80', placeholder: values.placeholder ?? '이름 (비우면 주변 지명)', value: values.name ?? ''});
    name.value = values.name ?? '';
    form.append(this.el('label', {}, this.el('span', {text: '이름'}), name));
    const altitude = this.altitudeFields(values.altitude_m ?? this.options.defaults?.altitude_m ?? 304.8, values.altitude_reference ?? 'agl', ground);
    form.append(...altitude.rows);
    const position = this.el('small', {class: 'route-note'});
    const showPosition = (place, {pending = false} = {}) => {
      position.textContent = `위치 ${Number(place.latitude).toFixed(5)}, ${Number(place.longitude).toFixed(5)}`
        + (pending ? ' · 클릭하면 여기로' : '');
      position.dataset.pending = String(pending);
    };
    showPosition(values);
    form.append(position);
    const error = this.el('p', {class: 'sim-error', role: 'alert'});
    if (move) {
      form.append(this.el('div', {class: 'sim-actions'},
        this.el('button', {type: 'button', class: 'route-move', text: '위치 변경', onclick: () => move()})));
    }
    form.append(this.el('div', {class: 'sim-actions'}, this.el('button', {type: 'submit', class: 'place-confirm', text: '저장'}),
      this.el('button', {type: 'button', text: '취소', onclick: () => this.card?.close()})), error);
    form.onsubmit = event => {
      event.preventDefault();
      const read = key => form.querySelector(`[name=${key}]`)?.value;
      const parsed = nodeFromForm({name: read('name'), altitude: read('altitude'), unit: read('unit'), altitude_reference: read('altitude_reference'),
        latitude: values.latitude, longitude: values.longitude, place_name: values.place_name}, this.options);
      if (parsed.errors) {error.textContent = parsed.errors.join(' '); return;}
      void submit(parsed.definition, error);
    };
    this.open(mode, title, screen, form);
    // A card that can move its own point: the panel hands it the cursor while
    // the map is being clicked, then the place it settled on.
    const card = {form, name, altitude, showPosition,
      // Giving up a move puts the line back to the place the card is holding.
      resetPosition: () => showPosition(values),
      setPosition: place => {
        values.latitude = place.latitude; values.longitude = place.longitude;
        showPosition(place);
        altitude.setGround(Number.isFinite(place.height) ? place.height : null);
        void this.measureGround(place, ++this.placeSequence, card);
      }};
    return card;
  }
  // A click on empty ground while adding: the form for a waypoint there. The
  // ground height and the nearby place name arrive while it is open.
  openNewNodeCard(ground, screen) {
    const sequence = ++this.placeSequence;
    const values = {latitude: ground.latitude, longitude: ground.longitude, altitude_m: this.options.defaults?.altitude_m ?? 304.8,
      altitude_reference: this.options.defaults?.altitude_reference ?? 'agl', placeholder: '주변 지명 찾는 중…'};
    const built = this.nodeForm({mode: 'node-new', title: '새 지점', values, screen, ground: Number.isFinite(ground.height) ? ground.height : null,
      submit: async (definition, error) => {
        try {
          const {node} = await this.api.createNode(definition);
          this.card?.close({silent: true});
          this.notify('ready', `지점 추가: ${node.name}`);
          await this.refresh();
          this.select(node.id);
        } catch (failure) {error.textContent = this.failureText(failure, '지점을 저장하지 못했습니다.');}
      }});
    void this.lookupPlace(ground, sequence, built, values);
    void this.measureGround(ground, sequence, built);
  }
  async lookupPlace(ground, sequence, built, values) {
    let name = null;
    try {name = await this.placeFor(ground);} catch {name = null;}
    if (sequence !== this.placeSequence || !this.card?.isOpen) return;
    values.place_name = name;
    built.name.setAttribute('placeholder', name ? `${name} (자동)` : '이름 (비우면 "지점")');
    built.name.placeholder = name ? `${name} (자동)` : '이름 (비우면 "지점")';
  }
  async measureGround(ground, sequence, built) {
    let height = null;
    try {height = await this.groundAt({latitude: ground.latitude, longitude: ground.longitude});} catch {height = null;}
    if (sequence !== this.placeSequence || !this.card?.isOpen || !Number.isFinite(height)) return;
    built.altitude.setGround(height);
  }
  openNodeCard(id, screen) {
    const node = this.endpoint(id);
    if (!node) return;
    if (node.kind === 'fato') {
      const role = ROLE_LABEL[node.role] ?? node.role;
      this.open('node-info', node.name, screen,
        this.el('p', {class: 'route-info', text: `${node.vertiport_name} · FATO ${node.fato} · ${role}`}),
        this.el('p', {class: 'route-note', text: node.role === 'takeoff' ? '이륙 B 구간의 끝: 다른 지점을 클릭하면 상승(C·D·E) 구간이 시작됩니다.'
          : node.role === 'landing' ? '착륙 J 구간의 시작: 다른 지점을 클릭하면 그 지점에서 강하(G·H·I) 구간이 이어집니다.'
          : '이착륙 FATO: 다른 지점을 클릭한 뒤 이 FATO를 이륙으로 쓸지 착륙으로 쓸지 고릅니다.'}),
        this.el('div', {class: 'sim-actions'}, this.el('button', {type: 'button', text: '보기', onclick: () => this.onFocus(node.id)})));
      return;
    }
    const place = this.positionOf(id);
    const absolute = place && Number.isFinite(place.height) ? ` · 절대 ${Math.round(place.height)} m` : '';
    const links = (this.network.links ?? []).filter(link => link.from === id || link.to === id).length;
    this.open('node-info', node.name, screen,
      this.el('p', {class: 'route-info', text: altitudeText(node) + absolute}),
      this.el('p', {class: 'route-note', text: `${node.latitude.toFixed(5)}, ${node.longitude.toFixed(5)} · 구간 ${links}개 · 다른 지점을 클릭하면 여기서 구간이 이어집니다.`}),
      this.el('div', {class: 'sim-actions'},
        this.el('button', {type: 'button', class: 'place-confirm', text: '수정', onclick: () => this.openNodeEdit(node, screen)}),
        this.el('button', {type: 'button', text: '보기', onclick: () => this.onFocus(node.id)}),
        this.dangerButton(() => this.removeNode(node))));
  }
  openNodeEdit(node, screen) {
    const place = this.positionOf(node.id);
    const card = this.nodeForm({mode: 'node-edit', title: `지점 수정 · ${node.name}`, screen, ground: place ? place.ground : null,
      move: () => this.startMove(node, card),
      values: {name: node.name, latitude: node.latitude, longitude: node.longitude, altitude_m: node.altitude_m, altitude_reference: node.altitude_reference},
      submit: async (definition, error) => {
        try {
          const {node: saved} = await this.api.updateNode(node.id, {...definition, name: definition.name || node.name});
          this.card?.close({silent: true});
          this.notify('ready', `지점 수정: ${saved.name}`);
          await this.refresh();
          const touching = this.linksTouching(node.id);
          if (touching.length) void this.checkConflicts(touching);
        } catch (failure) {error.textContent = this.failureText(failure, '지점을 수정하지 못했습니다.');}
      }});
    return card;
  }
  // The picker is the mission profile itself: the whole flight is drawn, and the
  // run that this link flies is clicked on the drawing. What the vertiport owns
  // — the deck taxi and the vertical hover over a FATO — is drawn but not
  // offered, because a route neither starts nor ends in the middle of it.
  profilePicker(chosen, onPick, {allowed = null} = {}) {
    const drawing = this.svg('svg', {class: 'route-profile', viewBox: `0 0 ${PROFILE_VIEW.width} ${PROFILE_VIEW.height}`,
      role: 'radiogroup', 'aria-label': '구간 종류'});
    const fixed = this.svg('g', {class: 'route-profile-fixed'});
    for (const x of [6, 190]) fixed.append(this.svg('rect', {x, y: 88, width: 28, height: 4, rx: 1.5}));
    fixed.append(this.svg('path', {class: 'route-profile-ground', d: 'M4 92H220'}),
      this.svg('path', {d: 'M34 88V80'}), this.svg('path', {d: 'M190 80V88'}),
      this.svg('text', {x: 20, y: 105, text: 'A·B 이륙'}), this.svg('text', {x: 204, y: 105, text: 'J·K 착륙'}));
    for (const [x, y] of [[34, 80], [86, 26], [138, 26], [190, 80]]) fixed.append(this.svg('circle', {cx: x, cy: y, r: 2.4}));
    drawing.append(fixed);
    for (const segment of this.segments) {
      const shape = PROFILE_SHAPE[segment.id];
      if (!shape) continue;
      const picked = segment.id === chosen;
      const corridor = segment.id === this.corridorSegment;
      // A run a FATO rules out is still drawn, so the flight reads whole, but it
      // cannot be chosen: the link leaves a FATO climbing or meets one descending.
      const locked = Array.isArray(allowed) && !allowed.includes(segment.id);
      const part = this.svg('g', {class: `route-part${picked ? ' route-picked' : ''}${locked ? ' route-locked' : ''}`, 'data-segment': segment.id,
        style: `--segment:${segment.color}`, role: 'radio', tabindex: locked ? '-1' : '0', 'aria-checked': picked ? 'true' : 'false',
        ...(locked ? {'aria-disabled': 'true'} : {}),
        'aria-label': `${segment.id} ${segment.label} · ${(segment.parts ?? []).join(', ') || segment.korean}${corridor ? ' · 회랑 폭 입력' : ''}${locked ? ' · FATO 구간이라 고를 수 없음' : ''}`});
      const d = path(shape.line);
      part.append(this.svg('path', {class: 'route-part-hit', d}), this.svg('path', {class: 'route-part-line', d}),
        this.svg('text', {class: 'route-part-name', x: shape.label[0], y: shape.label[1], text: segment.korean ?? segment.label}),
        this.svg('text', {class: 'route-part-letters', x: shape.label[0], y: shape.label[1] + 9, text: shape.letters}));
      if (!locked) {
        part.onclick = () => onPick(segment.id);
        part.onkeydown = event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault?.();
          onPick(segment.id);
        };
      }
      drawing.append(part);
    }
    return drawing;
  }
  // Two waypoints clicked: the segment first; a cruise corridor then asks its
  // width, every other segment is saved at once.
  openLinkCard(a, b, screen) {
    const names = this.names();
    const links = this.network.links ?? [];
    const directions = openDirections(a, b, this.network.fatos ?? [], links);
    if (!directions.length) {
      // Nothing left to draw between these two: either they are two FATOs, or
      // every direction between them is already a segment.
      const joined = linkBetween(a, b, links);
      this.error.textContent = joined
        ? `${names[a] ?? a} · ${names[b] ?? b}: 이미 이어져 있습니다. 구간을 클릭하면 수정할 수 있습니다.`
        : 'FATO끼리는 바로 이을 수 없습니다. 사이에 지점을 두세요.';
      if (!joined) this.select(b);
      return;
    }
    const state = {from: directions[0].from, to: directions[0].to, width_m: this.options.defaults?.width_m ?? 300, segment: null, name: ''};
    this.showLinking(state);
    const error = this.el('p', {class: 'sim-error', role: 'alert'});
    const heading = this.el('p', {class: 'route-note', text: `${names[state.from]} → ${names[state.to]} · 프로파일에서 이 구간을 클릭하면 그려집니다.`});
    const content = [heading];
    // The run this link can be: a FATO fixes it, otherwise the picker is open
    // with the likely run marked. The drawing is rebuilt when the direction changes.
    const picker = this.el('div', {class: 'route-picker'});
    const note = this.el('p', {class: 'route-note'});
    const drawPicker = () => {
      const fixed = fixedSegment(state.from, state.to, this.options);
      const suggested = fixed ?? suggestSegment(state.from, state.to, this.network.links ?? [], this.options.next_segment ?? FALLBACK_OPTIONS.next_segment);
      picker.replaceChildren(this.profilePicker(suggested, segment => {
        state.segment = segment;
        if (segment === this.corridorSegment) this.widthStep(state, error); else void this.createLink(state, error);
      }, {allowed: fixed ? [fixed] : null}));
      note.textContent = fixed
        ? (fixed === 'C' ? 'FATO에서 출발하는 구간은 상승(C·D·E)만 그릴 수 있습니다 · 상승을 클릭하면 그려집니다.'
          : 'FATO로 들어오는 구간은 강하(G·H·I)만 그릴 수 있습니다 · 강하를 클릭하면 그려집니다.')
        : '상승은 C·D·E, 강하는 G·H·I를 한 대각선으로 봅니다 · 순항(F)만 회랑 폭을 묻습니다.';
    };
    if (directions.length > 1) {
      const choice = this.el('div', {class: 'route-choice', role: 'radiogroup', 'aria-label': 'FATO 사용'});
      for (const [index, direction] of directions.entries()) {
        const input = this.el('input', {type: 'radio', name: 'use', value: direction.use, checked: index === 0 ? '' : undefined});
        input.onchange = () => {if (input.checked) {state.from = direction.from; state.to = direction.to; heading.textContent = `${names[state.from]} → ${names[state.to]} · 종류를 고르면 구간이 그려집니다.`; drawPicker(); this.showLinking(state); this.showMode();}};
        choice.append(this.el('label', {}, input, this.el('span', {text: direction.use === 'takeoff' ? `이륙 (B → 상승): ${names[direction.from]} → ${names[direction.to]}` : `착륙 (강하 → J): ${names[direction.from]} → ${names[direction.to]}`})));
      }
      content.push(this.el('span', {class: 'route-label', text: 'FATO 사용'}), choice);
    }
    drawPicker();
    content.push(picker, note, error);
    this.open('link-new', '새 구간', screen, ...content);
    this.showMode();
  }
  widthStep(state, error) {
    const names = this.names();
    const form = this.el('form', {class: 'sim-form route-form', novalidate: ''});
    const width = this.el('input', {name: 'width_m', type: 'number', step: '10', min: String(this.options.limits?.width_m?.[0] ?? 20),
      max: String(this.options.limits?.width_m?.[1] ?? 5000), value: String(state.width_m)});
    width.value = String(state.width_m);
    const nameInput = this.el('input', {name: 'name', type: 'text', maxlength: '80', placeholder: `${names[state.from]} → ${names[state.to]}`});
    form.append(this.el('p', {class: 'route-note', text: `${names[state.from]} → ${names[state.to]} · F 순항 회랑`}),
      this.el('label', {}, this.el('span', {text: '회랑 폭 (m)'}), width),
      this.el('label', {}, this.el('span', {text: '구간 이름 (비우면 자동)'}), nameInput),
      this.el('div', {class: 'sim-actions'}, this.el('button', {type: 'submit', class: 'place-confirm', text: '확인'}),
        this.el('button', {type: 'button', text: '취소', onclick: () => this.card?.close()})), error);
    form.onsubmit = event => {
      event.preventDefault();
      state.width_m = width.value; state.name = nameInput.value.trim();
      void this.createLink(state, error);
    };
    this.card?.replace(form);
  }
  async createLink(state, error) {
    const parsed = linkFromForm(state, this.options);
    if (parsed.errors) {error.textContent = parsed.errors.join(' '); return;}
    try {
      const {link} = await this.api.createLink(parsed.definition);
      this.showLinking(null);
      this.card?.close({silent: true});
      this.notify('ready', `구간 추가: ${link.name}`);
      await this.refresh();
      // The route continues from where it arrived.
      this.select(link.to);
      void this.checkConflicts([link.id]);
    } catch (failure) {error.textContent = this.failureText(failure, '구간을 저장하지 못했습니다.');}
  }
  openLinkEdit(link, screen = null) {
    this.editingLink = link;
    const names = this.names();
    const form = this.el('form', {class: 'sim-form route-form', novalidate: ''});
    const name = this.el('input', {name: 'name', type: 'text', maxlength: '80', value: link.name});
    name.value = link.name;
    const fixed = fixedSegment(link.from, link.to, this.options);
    const segment = this.el('input', {name: 'segment', type: 'hidden', value: fixed ?? foldSegment(link.segment)});
    segment.value = fixed ?? foldSegment(link.segment);
    const width = this.el('input', {name: 'width_m', type: 'number', step: '10', value: String(link.width_m ?? this.options.defaults?.width_m ?? 300)});
    width.value = String(link.width_m ?? this.options.defaults?.width_m ?? 300);
    const widthField = this.el('label', {id: 'route-width-field'}, this.el('span', {text: '회랑 폭 (m)'}), width);
    const picker = this.el('div', {class: 'route-picker'});
    // Choosing on the drawing only changes what this link is; it is saved with
    // the rest of the form, so the width can be set in the same step.
    const applySegment = () => {
      widthField.hidden = segment.value !== this.corridorSegment;
      picker.replaceChildren(this.profilePicker(segment.value, chosen => {segment.value = chosen; applySegment();}, {allowed: fixed ? [fixed] : null}));
    };
    applySegment();
    const error = this.el('p', {class: 'sim-error', role: 'alert'});
    const report = this.conflicts.get(link.id);
    const drawn = drawnColourNote(report, segment.value, this.options.segments);
    // `append` turns anything that is not a node into text, so a `null` for a
    // line this link does not need printed the word "null" into the card.
    form.append(...[this.el('p', {class: 'route-note', text: `${names[link.from] ?? link.from} → ${names[link.to] ?? link.to}`}),
      link.problem ? this.el('p', {class: 'route-note route-problem', text: `⚠ ${problemText(link.problem)}`}) : null,
      report ? this.el('p', {class: `route-note ${report.collisions > 0 ? 'route-conflict' : report.tight > 0 ? 'route-tight' : ''}`, text: conflictText(report)}) : null,
      drawn ? this.el('p', {class: 'route-note route-drawn', text: drawn}) : null,
      this.el('label', {}, this.el('span', {text: '이름'}), name),
      this.el('span', {class: 'route-label', text: '구간 종류'}), picker, segment,
      fixed ? this.el('p', {class: 'route-note', text: fixed === 'C' ? 'FATO에서 출발: 상승(C·D·E)으로 고정' : 'FATO로 도착: 강하(G·H·I)로 고정'}) : null,
      widthField,
      this.el('div', {class: 'sim-actions'}, this.el('button', {type: 'submit', class: 'place-confirm', text: '저장'}),
        this.el('button', {type: 'button', text: '취소', onclick: () => this.card?.close()}), this.dangerButton(() => this.removeLink(link))), error].filter(Boolean));
    form.onsubmit = event => {
      event.preventDefault();
      const parsed = linkFromForm({from: link.from, to: link.to, width_m: width.value, segment: segment.value, name: name.value}, this.options);
      if (parsed.errors) {error.textContent = parsed.errors.join(' '); return;}
      void (async () => {
        try {
          await this.api.updateLink(link.id, parsed.definition);
          this.card?.close({silent: true});
          this.notify('ready', `구간 수정: ${parsed.definition.name ?? link.name}`);
          await this.refresh();
          void this.checkConflicts([link.id]);
        } catch (failure) {error.textContent = this.failureText(failure, '구간을 수정하지 못했습니다.');}
      })();
    };
    const at = screen ?? this.screenFor(link.to);
    this.open('link-edit', `구간 · ${link.segment} ${link.name}`, at, form);
  }
  failureText(failure, fallback) {return failure?.data?.message ? `${fallback} ${failure.data.message}` : fallback;}
  // ---- server ------------------------------------------------------------
  async removeNode(node) {
    try {
      await this.api.removeNode(node.id);
      if (this.selected === node.id) this.select(null);
      this.card?.close({silent: true});
      this.notify('ready', `지점 삭제: ${node.name}`);
      await this.refresh();
    } catch {this.notify('error', '지점을 삭제하지 못했습니다.');}
  }
  async removeLink(link) {
    try {
      await this.api.removeLink(link.id);
      this.conflicts.delete(link.id);
      this.card?.close({silent: true});
      this.notify('ready', `구간 삭제: ${link.name}`);
      await this.refresh();
    } catch {this.notify('error', '구간을 삭제하지 못했습니다.');}
  }
  async refresh() {
    this.moved = null;   // whatever the server answers is where things really are
    try {
      const network = await this.api.network();
      this.network = {nodes: network.nodes ?? [], fatos: network.fatos ?? [], links: network.links ?? []};
    } catch {
      this.notify('error', '항로 목록을 불러오지 못했습니다.');
      return;
    }
    const ids = new Set(this.network.links.map(link => link.id));
    for (const id of [...this.conflicts.keys()]) if (!ids.has(id)) this.conflicts.delete(id);
    // A link added anywhere — here or on someone else's screen — changes what
    // the selected waypoint can still be joined to.
    this.select(this.endpoint(this.selected) ? this.selected : null);
    this.showSummary(); this.showMode();
    this.onNetwork(this.network, this.segments);
  }
}
