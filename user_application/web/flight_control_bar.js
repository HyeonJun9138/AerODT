// A view of recorded flight data. Owns only presentation (collapse/profile),
// never the playback clock, physics, pilot commands or authoritative state.
import {buildElement, buildSvg} from './dom_builder.js';
import {STAGE_COLORS, clock, metres, totalSeconds} from './flight_plan.js';

// How a vehicle's own readings are worded and banded. The replay console no
// longer shows them - the vehicle answers for itself when it is selected - but
// the wording is the same wherever they are read out, so it lives here and is
// re-exported by the panel that shows them.
export const MODE_LABEL = {multirotor: '멀티로터', transition: '전환 중', fixed_wing: '고정익'};
export const BATTERY_LOW_PCT = 30;
export const BATTERY_CAUTION_PCT = 50;
export function batteryLevel(percent) {
  return percent <= BATTERY_LOW_PCT ? 'low' : percent <= BATTERY_CAUTION_PCT ? 'caution' : 'ready';
}
const STAGE_TITLE = {gate_out: '출발 지상이동', takeoff: '수직 이륙', climb: '상승 · 전환',
  cruise: '순항', descent: '강하 · 전환', landing: '수직 착륙', gate_in: '도착 지상이동', charge: '충전'};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const text = (node, value) => {if (node && node.textContent !== value) node.textContent = value;};
const attribute = (node, name, value) => {if (node?.getAttribute(name) !== String(value)) node?.setAttribute(name, String(value));};

// Draw once per recorded run, at most 161 points regardless of flight length.
export function altitudeProfile(recorded, limit = 160) {
  const valid = (recorded ?? []).filter(s => Number.isFinite(s.time_s) && Number.isFinite(s.position?.altitude_m));
  if (!valid.length) return null;
  let low = Infinity, high = -Infinity;
  for (const s of valid) {low = Math.min(low, s.position.altitude_m); high = Math.max(high, s.position.altitude_m);}
  const start = valid[0].time_s, end = valid.at(-1).time_s;
  const span = Math.max(10, high - low), floor = low - span * .08, range = span * 1.16;
  const x = t => 4 + clamp((t - start) / Math.max(1, end - start), 0, 1) * 312;
  const y = h => 60 - clamp((h - floor) / range, 0, 1) * 52;
  const stride = Math.max(1, Math.ceil(valid.length / limit));
  const points = valid.filter((_, i) => i % stride === 0 || i === valid.length - 1);
  const path = points.map((s, i) => `${i ? 'L' : 'M'}${x(s.time_s).toFixed(2)},${y(s.position.altitude_m).toFixed(2)}`).join(' ');
  return {path, area: `${path} L316,64 L4,64 Z`, low, high, x, y, count: points.length};
}

// Every console mounted right now. There is one place on screen for it, and
// more than one plan panel can exist -- the editor's own and the copy inside
// the simulation window -- each mounting its own bar with the same id in the
// same spot. Stacked, they read as one: dismissing the top one uncovers the
// next and looks like a button that does nothing.
const mounted = new Set();

export class FlightControlBar {
  constructor({document = globalThis.document, host = document.body, actions = {}} = {}) {
    Object.assign(this, {document, host, actions});
    this.collapsed = false; this.phaseIndex = -1;
  }
  el(tag, props = {}, ...children) {return buildElement(this.document, tag, props, ...children);}
  svg(tag, props = {}, ...children) {return buildSvg(this.document, tag, props, ...children);}

  show(plan, run, recorded, source) {
    if (!plan?.legs?.length) {this.destroy(); return;}
    if (this.root && this.plan === plan && this.run === run) return;
    // The panel showing a plan now is the one driving the map, so it takes the
    // spot; any other console sharing this host steps down rather than hiding
    // underneath. Its own panel keeps its plan and can show it again.
    for (const other of [...mounted]) if (other !== this && other.host === this.host) other.destroy();
    this.resizeObserver?.disconnect();
    this.root?.remove();
    this.plan = plan; this.run = run; this.duration = totalSeconds(plan); this.phaseIndex = -1;
    const el = this.el.bind(this);
    const button = (id, label, action, props = {}) => el('button', {type: 'button', id, text: label, onclick: action, ...props});
    this.root = el('section', {id: 'flight-console', class: 'flight-console', 'aria-label': '비행 기록 컨트롤'});
    this.surface = el('div', {class: 'flight-console-surface'});
    this.stageTag = el('span', {id: 'plan-stage', class: 'flight-phase-badge'});
    this.clockText = el('span', {id: 'plan-clock', class: 'flight-console-clock'});
    this.playButton = button('plan-play', '재생', () => this.actions.toggle?.(), {class: 'flight-play', 'aria-pressed': 'false'});
    this.collapseButton = button('flight-console-toggle', '최소화', () => this.setCollapsed(!this.collapsed),
      {'aria-label': '컨트롤 바 최소화', 'aria-expanded': 'true', 'aria-controls': 'flight-console-content', class: 'flight-collapse'});
    this.dismissButton = button('flight-console-dismiss', '×', () => this.actions.dismiss?.(),
      {class: 'flight-dismiss', 'aria-label': '계획 취소하고 화면에서 제거',
        title: '계획 취소 · 화면에서 제거 (저장 기록 유지)'});
    this.vehicle = el('div', {id: 'plan-vehicle', class: 'flight-console-identity'},
      el('span', {class: 'flight-console-eyebrow', text: 'FLIGHT REPLAY'}),
      el('strong', {text: plan.vehicle?.id ?? 'UAM'}),
      el('span', {class: 'flight-console-route', text: `${plan.departure?.name ?? ''} → ${plan.arrival?.name ?? ''}`}));
    const header = el('header', {class: 'flight-console-header'}, this.vehicle,
      el('div', {class: 'flight-console-live'}, this.stageTag, this.clockText),
      el('div', {class: 'flight-console-primary'}, this.playButton, this.collapseButton, this.dismissButton));

    // Height, speed, battery, tilt and the altitude trace were read out here.
    // They are the vehicle's own state, and the vehicle answers for it when it
    // is selected. Repeating them on the replay console made this the widest
    // thing on the screen for readings that were already available elsewhere.
    // altitudeProfile() stays exported for whatever draws them next.

    this.legName = el('span', {id: 'plan-leg-name'});
    this.phaseCount = el('span', {id: 'flight-phase-count'});
    this.timeline = el('ol', {class: 'flight-phase-flow', id: 'plan-legs', 'aria-label': '운항 단계, 선택하면 해당 시각으로 이동'});
    this.phaseButtons = []; this.phaseProgress = [];
    // A rounded plan boundary can precede the first recorded sample of a leg.
    // Seek the recording, so selecting a phase cannot highlight its predecessor.
    const firstSamples = new Map();
    for (const state of recorded ?? []) if (Number.isInteger(state.leg_index) && Number.isFinite(state.time_s)
      && !firstSamples.has(state.leg_index)) firstSamples.set(state.leg_index, state.time_s);
    for (const [index, leg] of plan.legs.entries()) {
      const seekTime = firstSamples.get(index) ?? leg.start_s;
      const progress = el('i', {class: 'flight-phase-progress'});
      const phase = button(`plan-leg-${index}`, '', () => this.actions.seek?.(seekTime),
        {class: 'flight-phase', 'data-state': 'next', 'data-stage': leg.stage,
          style: `--stage:${STAGE_COLORS[leg.stage] ?? '#a9d7e8'}`,
          'aria-label': `${index + 1}. ${leg.stage_label ?? leg.stage}, ${clock(seekTime)}로 이동`, title: leg.name});
      phase.append(el('span', {class: 'flight-phase-number', text: String(index + 1).padStart(2, '0')}),
        el('strong', {text: STAGE_TITLE[leg.stage] ?? leg.stage_label ?? leg.stage}),
        el('small', {text: clock(leg.duration_s)}), progress);
      this.timeline.append(el('li', {}, phase)); this.phaseButtons.push(phase); this.phaseProgress.push(progress);
    }
    this.scrub = el('input', {type: 'range', id: 'plan-scrub', min: 0, max: Math.max(.1, this.duration), step: .1, value: 0,
      'aria-label': '비행 시각', oninput: () => this.actions.scrub?.(Number(this.scrub.value))});
    this.speedButton = button('plan-rate', '×4', () => this.actions.rate?.(),
      {'aria-label': '재생 속도 변경', title: '누르면 한 단계 빠르게, 오른쪽 버튼은 ×1로'});
    this.speedButton.oncontextmenu = this.resetRate.bind(this);
    this.followButton = button('plan-follow', '기체 추적', () => this.actions.follow?.(), {'aria-pressed': 'false'});
    const transport = el('div', {class: 'flight-console-transport'},
      button('plan-stop', '처음으로', () => this.actions.stop?.(), {title: '처음으로 되감고 일시정지'}),
      button('flight-back', '−10초', () => this.actions.skip?.(-10)), button('flight-forward', '+10초', () => this.actions.skip?.(10)),
      this.speedButton, el('div', {class: 'flight-scrubber'}, this.scrub),
      button('flight-focus', '기체 보기', () => this.actions.focus?.()), this.followButton,
      button('flight-cockpit', '조종석', () => this.actions.cockpit?.(), {title:'조종사 시야 · 드래그로 둘러보기 · 휠로 화각 조절 · ESC 외부 추적'}),
      // Watch the flight and nothing else: the camera rides with the aircraft
      // and every panel steps aside. The round control by the clock comes back.
      button('flight-focus-mode', '시야 집중', () => this.actions.focusMode?.(),
        {class: 'flight-focus-mode', title: '기체를 따라가며 다른 창을 모두 숨깁니다 (시계 옆 ◎ 로 해제)'}));
    const totals = plan.totals ?? {};
    const details = el('details', {class: 'flight-console-details'},
      el('summary', {text: '실행 정보 · 기록 재생'}),
      el('div', {},
        el('p', {id: 'plan-source', text: source}),
        el('p', {id: 'plan-summary', text: `${plan.vehicle?.label ?? ''} · 탑승 ${plan.vehicle?.passengers ?? 0}/${plan.vehicle?.capacity ?? 0}명`
          + ` · ${plan.departure?.name} ${plan.departure?.gate} → ${plan.arrival?.name} ${plan.arrival?.gate}`
          + ` · 비행 ${clock(totals.flight_duration_s)} · 충전 포함 ${clock(totals.duration_s)}`
          + ` · 공중 ${metres(totals.air_distance_m)} · 소모 ${(totals.energy_kwh ?? 0).toFixed(1)} kWh`}),
        el('p', {text: '기록된 실행의 재생 화면입니다. 재생·일시정지는 실제 조종사에게 내리는 대기·재개 명령이 아닙니다.'})));
    const body = el('div', {class: 'flight-console-body'},
      el('div', {class: 'flight-phase-caption'}, el('span', {text: '운항 흐름'}), this.legName, this.phaseCount),
      this.timeline, transport, details);
    this.content = el('div', {id: 'flight-console-content', class: 'flight-console-content'}, el('div', {class: 'flight-console-clip'}, body));
    // Minimised, this is one row under the clock, the same shape the scheduled
    // day's console takes: what an operator presses while watching, and nothing
    // that has to be read.
    this.miniClock = el('span', {id: 'flight-mini-clock', class: 'flight-mini-clock', text: '0:00'});
    this.miniPlay = button('flight-mini-play', '▶', () => this.actions.toggle?.(), {class: 'flight-mini-icon', title: '재생'});
    this.miniRate = button('flight-mini-rate', '×4', () => this.actions.rate?.(),
      {class: 'flight-mini-rate', title: '누르면 한 단계 빠르게, 오른쪽 버튼은 ×1로'});
    this.miniRate.oncontextmenu = this.resetRate.bind(this);
    this.miniFollow = button('flight-mini-follow', '추적', () => this.actions.follow?.(),
      {'aria-pressed': 'false', title: '기체 추적'});
    this.mini = el('div', {id: 'flight-mini', class: 'flight-mini'},
      el('span', {class: 'flight-mini-eyebrow', text: 'FLT'}), this.miniClock,
      button('flight-mini-stop', '⏮', () => this.actions.stop?.(), {class: 'flight-mini-icon', title: '처음으로'}),
      this.miniPlay,
      button('flight-mini-back', '−10초', () => this.actions.skip?.(-10)),
      button('flight-mini-forward', '+10초', () => this.actions.skip?.(10)),
      this.miniRate, this.miniFollow,
      button('flight-mini-focus-mode', '집중', () => this.actions.focusMode?.(),
        {class: 'flight-focus-mode', title: '기체를 따라가며 다른 창을 모두 숨깁니다'}),
      button('flight-mini-expand', '펼치기', () => this.setCollapsed(false), {class: 'flight-collapse'}),
      button('flight-mini-dismiss', '닫기', () => this.actions.dismiss?.(), {class: 'flight-mini-close'}));
    this.surface.append(header, this.content, this.mini); this.root.append(this.surface); this.host.append(this.root);
    mounted.add(this);
    this.root.onkeydown = event => {if (event.key === 'Escape' && !this.collapsed) {event.stopPropagation(); this.setCollapsed(true);}};
    // Keep the active phase in view when the drawer or viewport changes width,
    // including while paused. No polling or additional animation frame loop.
    const Observer = this.document.defaultView?.ResizeObserver;
    if (Observer) {
      this.resizeObserver = new Observer(() => this.revealPhase());
      this.resizeObserver.observe(this.timeline);
    }
    this.setCollapsed(false);
  }

  // The right button on either speed button goes straight back to real time.
  // The browser's own menu is swallowed, or it would open over the map instead.
  resetRate(event) {
    event?.preventDefault?.();
    this.actions.resetRate?.();
    return false;
  }
  setCollapsed(collapsed) {
    this.collapsed = Boolean(collapsed);
    attribute(this.root, 'data-collapsed', this.collapsed);
    attribute(this.collapseButton, 'aria-expanded', !this.collapsed);
    attribute(this.collapseButton, 'aria-label', this.collapsed ? '비행 컨트롤 바 펼치기' : '컨트롤 바 최소화');
    if (this.content) {this.content.inert = this.collapsed; attribute(this.content, 'aria-hidden', this.collapsed);}
    // Move focus out of the collapsed body; no hidden keyboard-focus targets.
    if (this.collapsed && this.content?.contains?.(this.document.activeElement)) this.collapseButton.focus?.();
    if (!this.collapsed) this.revealPhase();
  }
  revealPhase() {
    if (this.collapsed) return;
    const item = this.phaseButtons?.[this.phaseIndex];
    if (!item?.getBoundingClientRect || !this.timeline?.scrollTo) return;
    if (this.timeline.scrollWidth <= this.timeline.clientWidth) return;
    const at = item.getBoundingClientRect(), rail = this.timeline.getBoundingClientRect();
    if (at.left < rail.left || at.right > rail.right)
      this.timeline.scrollTo({left: this.timeline.scrollLeft + at.left - rail.left - (rail.width - at.width) / 2, behavior: 'auto'});
  }
  update(sample) {
    if (!this.root || !sample) return;
    const plan = this.plan, charge = plan.legs.find(leg => leg.stage === 'charge');
    const arriving = plan.alighting && charge && sample.time_s >= charge.start_s;
    const boarding = arriving ? plan.alighting : plan.boarding;
    const local = sample.time_s - (arriving ? charge.start_s : 0);
    const completed = boarding?.release_s?.filter(t => local >= t + boarding.walk_s + boarding.enter_s).length ?? 0;
    text(this.stageTag, boarding && local >= 0 && local < boarding.duration_s
      ? `승객 ${arriving ? '하차' : '탑승'} ${completed}/${boarding.count}명` : sample.done ? '운항 완료' : sample.stage_label);
    attribute(this.stageTag, 'style', `--stage:${sample.color}`);
    text(this.clockText, `${clock(sample.time_s)} / ${clock(this.duration)}`);
    text(this.miniClock, `${clock(sample.time_s)} / ${clock(this.duration)}`);
    text(this.legName, sample.leg_name ?? '');
    text(this.phaseCount, `${sample.leg_index + 1} / ${plan.legs.length}`);
    this.scrub.value = String(sample.time_s);
    attribute(this.scrub, 'aria-valuetext', `${clock(sample.time_s)}, ${sample.stage_label ?? ''}`);
    attribute(this.scrub, 'style', `--progress:${clamp(sample.time_s / Math.max(.1, this.duration), 0, 1) * 100}%`);
    const index = sample.leg_index;
    if (this.phaseIndex !== index || this.done !== sample.done) {
      this.phaseIndex = index; this.done = sample.done;
      this.phaseButtons.forEach((button, i) => {
        attribute(button, 'data-state', i < index || sample.done ? 'done' : i === index ? 'now' : 'next');
        if (i === index && !sample.done) attribute(button, 'aria-current', 'step'); else button.removeAttribute('aria-current');
        attribute(this.phaseProgress[i], 'style', `width:${i < index || sample.done ? 100 : 0}%`);
      });
      this.revealPhase();
    }
    const leg = plan.legs[index];
    // Time progress, not path fraction (a vertical leg can have zero distance).
    if (leg) attribute(this.phaseProgress[index], 'style', `width:${clamp((sample.time_s - leg.start_s) / Math.max(.001, leg.duration_s), 0, 1) * 100}%`);
  }
  transport({playing, speed, following}) {
    text(this.playButton, playing ? '일시정지' : '재생'); attribute(this.playButton, 'aria-pressed', playing);
    text(this.speedButton, `×${speed}`);
    text(this.followButton, following ? '추적 중' : '기체 추적'); attribute(this.followButton, 'aria-pressed', following);
    text(this.miniPlay, playing ? '⏸' : '▶'); attribute(this.miniPlay, 'aria-pressed', playing);
    text(this.miniRate, `×${speed}`);
    attribute(this.miniFollow, 'aria-pressed', following);
  }
  destroy() {
    mounted.delete(this);
    this.resizeObserver?.disconnect(); this.resizeObserver = null;
    this.root?.remove(); this.root = null; this.plan = null; this.run = null; this.profile = null;
  }
}
