// The strip along the bottom of the map that says what the selected aircraft
// is doing right now: name and phase, the handful of numbers an operator
// reads at a glance - height, speed, heading, battery, rotors - and the leg it
// is flying with how far along it is. The full inspection drawer with every
// field, fold and model credit is one press away ('상세'); so is the same
// card as its own window ('창').
//
// It reads what the selection drawer reads - the snapshot entity and the
// slower mission poll - and never asks the server itself. Nothing here is a
// second flight state: every number is the one the drawer would show.
import {describeFlightReadouts, describeMissionOverview} from './entity_details.js';

export const KIND_LABEL = {uam: 'UAM', aircraft: '항공기', helicopter: '헬기', drone: '드론', satellite: '위성', bird: '조류'};
export const CHARGE_LABEL = {disconnected: '충전기 미연결', connecting: '연결 준비', charging: '충전 중', complete: '충전 완료', unavailable: '충전기 없음'};
export const BATTERY_LOW_PCT = 20, BATTERY_CAUTION_PCT = 40;

export function batteryLevel(pct) {
  if (!Number.isFinite(pct)) return 'unknown';
  return pct <= BATTERY_LOW_PCT ? 'low' : pct <= BATTERY_CAUTION_PCT ? 'caution' : 'ok';
}

function make(document, tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node[key] = value;
    else node.setAttribute(key, String(value));
  }
  node.append(...children.filter(Boolean));
  return node;
}

export class AircraftDashboard {
  constructor({document = globalThis.document, host = document.body, actions = {}, supportsCamera = () => false,
      following = () => false, cockpitReady = () => false} = {}) {
    Object.assign(this, {document, host, actions, supportsCamera, following, cockpitReady});
    this.entity = null; this.mission = null; this.root = null; this.minimised = false;
    this.tiles = new Map();
  }

  el(tag, attrs, ...children) {return make(this.document, tag, attrs, ...children);}

  // Build once; every later show() only rewrites text and attributes, so the
  // strip does not flicker and its buttons keep focus across snapshots.
  build() {
    const e = this.el.bind(this);
    this.name = e('strong', {class: 'adb-name'});
    this.kind = e('span', {class: 'adb-kind'});
    this.phase = e('span', {class: 'adb-phase'});
    this.mode = e('span', {class: 'adb-mode'});
    this.quality = e('span', {class: 'adb-quality'});
    this.tileRow = e('div', {class: 'adb-tiles', role: 'list'});
    this.routeFrom = e('strong', {class: 'adb-from'});
    this.routeTo = e('strong', {class: 'adb-to'});
    this.progressDone = e('span', {class: 'adb-progress-done'});
    this.progressPlanned = e('span', {class: 'adb-progress-planned'});
    this.progress = e('div', {class: 'adb-progress', role: 'progressbar', 'aria-label': '비행 진행률', 'aria-valuemin': 0, 'aria-valuemax': 100},
      this.progressDone, this.progressPlanned);
    this.eta = e('span', {class: 'adb-eta'});
    this.timing = e('span', {class: 'adb-timing'});
    this.warning = e('span', {class: 'adb-warning', role: 'status'});
    this.route = e('div', {class: 'adb-route'},
      e('div', {class: 'adb-route-ends'}, this.routeFrom, e('span', {class: 'adb-arrow', 'aria-hidden': 'true', text: '→'}), this.routeTo),
      this.progress, e('div', {class: 'adb-route-meta'}, this.eta, this.timing), this.warning);
    const button = (id, text, title, handler, extra = {}) =>
      e('button', {class: 'adb-button', 'data-action': id, text, title, onclick: () => this.actions[handler ?? id]?.(this.entity), ...extra});
    this.buttons = {
      expand: button('expand', '상세', '모든 정보 · 왼쪽 정보창을 엽니다'),
      window: button('window', '창', '이 정보를 별도 창으로 띄웁니다'),
      focus: button('focus', '대상 보기', '카메라를 이 대상으로 옮깁니다'),
      follow: button('follow', '외부 추적', '카메라가 이 대상을 따라갑니다', 'follow', {'aria-pressed': 'false'}),
      cockpit: button('cockpit', '조종석', '조종석 시야로 전환합니다'),
      camera: button('camera', '기체 영상', '이 기체에 달린 카메라의 실시간 영상을 엽니다'),
      radar: button('radar', '레이더', '이 기체 주변의 교통 레이더를 엽니다'),
    };
    const menu=(title,items)=>e('details',{class:'adb-menu'},e('summary',{text:title}),e('div',{class:'adb-menu-items'},...items));
    this.viewExtra=e('div',{class:'adb-cockpit-extra'});this.displayExtra=e('div',{class:'adb-cockpit-extra'});
    this.actionGroups=[menu('시점',[this.buttons.focus,this.buttons.follow,this.buttons.cockpit,this.viewExtra]),menu('보기',[this.buttons.camera,this.buttons.radar,this.displayExtra]),menu('정보',[this.buttons.expand,this.buttons.window])];
    for(const group of this.actionGroups)group.ontoggle=()=>{if(group.open){this.closeMenus(group);this.onMenuOpen?.();}};
    this.manualHost=e('div',{class:'adb-manual',hidden:''});
    this.controlsHost = e('div', {class: 'adb-controls'});
    this.minimise = e('button', {class: 'adb-icon', 'data-action': 'minimise', 'aria-label': '요약 접기', 'aria-expanded': 'true', title: '요약 접기',
      onclick: () => this.setMinimised(!this.minimised)}, e('span', {class: 'adb-chevron', 'aria-hidden': 'true'}));
    this.close = e('button', {class: 'adb-icon adb-close', 'data-action': 'close', 'aria-label': '선택 해제', title: '선택 해제', text: '×',
      onclick: () => this.actions.close?.(this.entity)});
    // The handle is a tab for the panel's top edge: rounded at the top, open
    // at the bottom, shadow cast upward. The panel is docked to the bottom of
    // the screen, so in focus mode the column runs handle first -- collapsed,
    // it sits alone on the screen's bottom edge to be pulled up; expanded, it
    // rides on the panel's top edge. Appended last it came out underneath the
    // panel instead, a tab attached to nothing, hanging off the bottom.
    this.focusHandle=e('button',{class:'adb-focus-handle',type:'button','aria-label':'조작부 펼치기','aria-expanded':'false',onclick:()=>this.setFocusExpanded(!this.focusExpanded)},e('span',{class:'adb-focus-triangle','aria-hidden':'true'}));
    this.root = e('section', {id: 'aircraft-dashboard', class: 'aircraft-dashboard', role: 'region', 'aria-label': '선택한 대상 요약', 'data-minimised': 'false'},
      this.focusHandle,
      e('div', {class: 'adb-surface'},
        e('div', {class: 'adb-identity'},
          e('div', {class: 'adb-title'}, this.kind, this.name, this.quality),
          e('div', {class: 'adb-state'}, this.phase, this.mode)),
        this.tileRow, this.route,
        // Manual control sits in the action row, not under it: it is four tight
        // controls, and a row of its own made the strip taller for no more
        // information. It wraps with the rest when the window is narrow.
        e('div', {class: 'adb-actions'}, ...this.actionGroups, this.controlsHost, this.manualHost,
          e('div', {class: 'adb-window-controls'}, this.minimise, this.close))));
    this.host.append(this.root);
    this.setFocusMode(this.focusActive??Boolean(this.document.body.getAttribute?.('data-focus')));
    // Keep the workspace shelf and attribution clear of either strip height.
    if (globalThis.ResizeObserver) {
      this.resizeObserver = new ResizeObserver(entries => {
        const height = entries[0]?.borderBoxSize?.[0]?.blockSize ?? this.root?.getBoundingClientRect().height ?? 0;
        this.document.body.style.setProperty('--aircraft-dashboard-height', `${Math.ceil(height)}px`);
      });
      this.resizeObserver.observe(this.root);
    }
  }

  setFocusMode(active) {
    this.focusActive=Boolean(active);
    this.setFocusExpanded(false);
  }
  setFocusExpanded(expanded) {
    this.focusExpanded=this.focusActive&&Boolean(expanded);
    if(!this.root)return;
    this.root.setAttribute('data-focus-expanded',String(this.focusExpanded));
    this.root.querySelector('.adb-surface').inert=this.focusActive&&!this.focusExpanded;
    this.focusHandle.setAttribute('aria-expanded',String(this.focusExpanded));
    this.focusHandle.setAttribute('aria-label',this.focusExpanded?'조작부 접기':'조작부 펼치기');
  }

  setManualControls(toolbar) {
    if(!this.root)this.build();
    this.root.setAttribute('data-manual',String(Boolean(toolbar)));
    this.manualHost.hidden=!toolbar;
    if(toolbar)this.manualHost.append(toolbar);
    else this.manualHost.replaceChildren();
  }

  closeMenus(except=null){for(const menu of this.actionGroups??[])if(menu!==except)menu.open=false;}
  setControls(toolbar,{view,display,onMenuOpen}={}) {
    this.controls=toolbar;this.cockpitViewControls=view;this.cockpitDisplayControls=display;this.onMenuOpen=onMenuOpen;
    if(this.entity&&this.controlsHost)this.controlsHost.append(toolbar);
    this.mountCockpitMenus();
  }
  mountCockpitMenus(){
    if(this.viewExtra&&this.cockpitViewControls&&this.cockpitViewControls.parentNode!==this.viewExtra)this.viewExtra.append(this.cockpitViewControls);
    if(this.displayExtra&&this.cockpitDisplayControls&&this.cockpitDisplayControls.parentNode!==this.displayExtra)this.displayExtra.append(this.cockpitDisplayControls);
  }

  tile(key, label) {
    let held = this.tiles.get(key);
    if (held) return held;
    const e = this.el.bind(this);
    held = {value: e('strong', {class: 'adb-value'}), unit: e('span', {class: 'adb-unit'}), sub: e('small', {class: 'adb-sub'}),
      label: e('span', {class: 'adb-label', text: label}), gauge: e('i', {class: 'adb-gauge-fill'}), arrow: e('i', {class: 'adb-arrow-mark', 'aria-hidden': 'true', text: '➤'})};
    held.node = e('div', {class: 'adb-tile', role: 'listitem', 'data-key': key}, held.label,
      e('div', {class: 'adb-reading'}, held.value, held.unit, held.arrow), e('span', {class: 'adb-gauge'}, held.gauge), held.sub);
    held.arrow.hidden = true;
    this.tiles.set(key, held);
    this.tileRow.append(held.node);
    return held;
  }

  paintTile(key, {label, value, unit = '', sub = '', angle = null, fill = null, level = null}) {
    const held = this.tile(key, label);
    held.node.hidden = false;
    held.label.textContent = label;
    held.value.textContent = value ?? '—';
    held.unit.textContent = unit;
    held.sub.textContent = sub;
    held.arrow.hidden = !Number.isFinite(angle);
    if (Number.isFinite(angle)) held.arrow.style.transform = `rotate(${angle - 90}deg)`;
    held.node.setAttribute('data-gauge', String(Number.isFinite(fill)));
    if (Number.isFinite(fill)) held.gauge.style.width = `${Math.round(Math.max(0, Math.min(1, fill)) * 100)}%`;
    held.node.setAttribute('data-level', level ?? 'none');
  }

  show(entity) {
    if (!entity) {this.hide(); return;}
    if (!this.root) this.build();
    const changed = entity.entity_id !== this.entity?.entity_id;
    this.entity = entity;
    if (this.controls && this.controls.parentNode !== this.controlsHost) this.controlsHost.append(this.controls);
    this.mountCockpitMenus();
    if (changed) {this.mission = null; this.paintMission();}
    const view = describeFlightReadouts(entity);
    this.kind.textContent = KIND_LABEL[entity.kind] ?? entity.kind ?? '';
    this.name.textContent = String(entity.name ?? entity.entity_id ?? '').split(' · ')[0];
    this.quality.textContent = view.quality;
    this.quality.setAttribute('data-quality', entity.quality ?? '');
    this.phase.textContent = view.phase;
    this.phase.setAttribute('data-phase', entity.flight_phase ?? '');
    this.mode.textContent = view.mode ?? view.source;
    for (const held of this.tiles.values()) held.node.hidden = true;
    for (const card of view.cards) {
      if (card.key === 'battery') continue;
      this.paintTile(card.key, {label: card.label, value: card.value, unit: card.unit, sub: card.sub, angle: card.angle});
    }
    if (view.battery) {
      this.paintTile('battery', {label: '배터리', value: view.battery.value, unit: '%', sub: view.battery.sub,
        fill: view.battery.pct / 100, level: batteryLevel(view.battery.pct)});
    }
    if (Number.isFinite(view.tilt)) {
      this.paintTile('tilt', {label: '로터 틸트', value: String(Math.round(view.tilt)), unit: '°',
        sub: view.tilt >= 80 ? '고정익' : view.tilt <= 10 ? '수직' : '전환 중', fill: view.tilt / 90});
    }
    // The leg's own tile (who is aboard) comes from the mission poll, not the
    // snapshot: repainted here so a telemetry tick does not blink it away.
    if (this.mission) this.paintMission();
    this.buttons.camera.hidden = !this.supportsCamera(entity);
    this.buttons.cockpit.hidden = entity.kind !== 'uam';
    this.buttons.cockpit.disabled = entity.kind === 'uam' && !this.cockpitReady(entity);
    this.buttons.radar.hidden = !['uam', 'aircraft', 'helicopter', 'drone'].includes(entity.kind);
    this.buttons.follow.setAttribute('aria-pressed', String(Boolean(this.following(entity))));
    this.root.hidden = false;
    this.root.setAttribute('data-kind', entity.kind ?? '');
    this.root.setAttribute('data-open', 'true');
  }

  setMission(detail) {
    if (!this.root) return;
    if (detail && this.entity && detail.state?.aircraft_id && !String(this.entity.entity_id).endsWith(detail.state.aircraft_id)) return;
    this.mission = detail ?? null;
    this.paintMission();
  }

  paintMission() {
    if (!this.root) return;
    const overview = describeMissionOverview(this.mission);
    this.route.hidden = !overview;
    if (!overview) return;
    this.routeFrom.textContent = overview.from;
    this.routeTo.textContent = overview.to;
    const percent = parseInt(overview.progress, 10);
    this.progress.hidden = !Number.isFinite(percent);
    if (Number.isFinite(percent)) {
      this.progress.setAttribute('aria-valuenow', String(percent));
      this.progressDone.style.width = `${percent}%`;
      const planned = parseInt(String(overview.planned).replace(/[^\d]/g, ''), 10);
      this.progressPlanned.hidden = !Number.isFinite(planned);
      if (Number.isFinite(planned)) this.progressPlanned.style.left = `${planned}%`;
    }
    this.eta.textContent = [overview.progress, overview.eta].filter(Boolean).join(' · ');
    this.timing.textContent = overview.timing;
    this.timing.setAttribute('data-level', overview.timingLevel ?? 'neutral');
    this.warning.textContent = overview.warning ?? '';
    this.warning.hidden = !overview.warning;
    const seats = this.tile('passengers', '탑승');
    this.paintTile('passengers', {label: '탑승', value: overview.passengers, sub: overview.flow || (overview.sequence !== '미배정' ? `착륙 ${overview.sequence}` : ''),
      fill: Number.isFinite(overview.occupancy) ? overview.occupancy : null});
    seats.node.hidden = false;
  }

  setMinimised(minimised) {
    this.minimised = Boolean(minimised);
    if (!this.root) return;
    this.root.setAttribute('data-minimised', String(this.minimised));
    this.minimise.setAttribute('aria-label', this.minimised ? '요약 펼치기' : '요약 접기');
    this.minimise.setAttribute('title', this.minimised ? '요약 펼치기' : '요약 접기');
    this.minimise.setAttribute('aria-expanded', String(!this.minimised));
  }

  hide() {
    this.entity = null; this.mission = null;
    if (this.controls && this.controls.parentNode === this.controlsHost) this.document.body.append(this.controls);
    if (!this.root) return;
    this.root.hidden = true;
    this.root.setAttribute('data-open', 'false');
  }

  destroy() {this.hide(); this.resizeObserver?.disconnect(); this.document.body.style.removeProperty('--aircraft-dashboard-height'); this.root?.remove(); this.root = null; this.tiles.clear();}
}
