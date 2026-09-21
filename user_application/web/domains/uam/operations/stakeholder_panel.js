// User/Application: role selection and compact stakeholder summaries.
// Detailed Control Panels own their own visibility and remain independent of the drawer.
import {buildElement} from '../../../dom_builder.js';
import {refusalFor, seatKey} from './role_mode.js';

export const DOMAINS = [['aircraft', '항공기'], ['satellite', '위성'], ['uam', 'UAM']];
export const UAM_STAKEHOLDERS = [
  ['pilot', '조종사', '조종사가 보는 화면: 배정된 비행 계획, 항로와 회랑, 이착륙 버티포트, 기상과 공역.'],
  ['operator', '운항사', '운항사가 보는 화면: 보유 기체와 승무원, 운항 일정, 항로별 운영 현황.'],
  ['vertiport', '버티포트', '버티포트 운영자가 보는 화면: FATO·게이트 사용, 도착·출발 대기, 지상 처리.'],
  ['psu', 'PSU', 'PSU(UAM 교통관리 서비스 제공자)가 보는 화면: 회랑 점유, 분리, 비행 계획 승인과 조정.'],
];
const PREPARING = '준비 중';

export class StakeholderPanel {
  constructor({document = globalThis.document, onChange = () => {}, vertiportPanel = null, psuPanel = null,
    session = null, pilotPanel = null, onDecisions = null, domainOnly = null} = {}) {
    Object.assign(this, {document, onChange, vertiportPanel, psuPanel, session, pilotPanel, onDecisions});
    this.domainOnly=domainOnly; this.domain = 'uam'; this.role = UAM_STAKEHOLDERS[0][0]; this.body = null;
    // While a seat is held this section answers as that party and the others
    // are closed. The seat is watched rather than polled: the shared session
    // refreshes every few seconds and rebuilding the open view that often
    // would throw away its scroll and its selection.
    this.seat = seatKey(session?.member ?? null);
    this.unsubscribe = session?.subscribe(() => this.seatChanged()) ?? (() => {});
  }
  el(tag, props = {}, ...children) {return buildElement(this.document, tag, props, ...children);}
  // The role this browser is sitting in, or null when it is only watching.
  held() {return this.session?.member ?? null;}
  seatChanged() {
    const seat = seatKey(this.held());
    if (seat === this.seat) return;
    this.seat = seat;
    // Taking a seat is also arriving at that party's screen.
    if (this.held()) {this.domain = 'uam'; this.role = this.held().role;}
    this.refusal = '';
    if (this.body) this.render(this.body);
  }
  // Another party asked for while a seat is held: refused with the way out
  // named, so the mode reads as a mode rather than as a broken button.
  refuse() {
    this.refusal = refusalFor(this.held());
    if (this.locked) this.locked.textContent = this.refusal;
    return this.refusal;
  }
  destroy() {this.unsubscribe();this.deactivate();}
  // Detach the summary; an independently opened Control Panel stays alive.
  deactivate() {this.stopScenario();this.vertiportPanel?.deactivate();this.psuPanel?.deactivate();this.body=null;}
  stopScenario() {this.pilotPanel?.deactivate();}
  render(body) {
    this.vertiportPanel?.deactivate();
    this.psuPanel?.deactivate();
    this.body = body;
    this.stopScenario();
    body.textContent = '';
    // Before anything else: whether what follows is the world or a rehearsal.
    const held = this.held();
    // A seat taken in another tab, or before this section was opened, still
    // decides which screen this is.
    if (held) {this.domain = 'uam'; this.role = held.role;}
    // The domain first, as in Simulation, so the two sections read the same way.
    const domains = this.el('div', {class: 'sim-categories', role: 'group', 'aria-label': '이해관계자 분야'});
    for (const [id, label] of DOMAINS.filter(([id])=>!this.domainOnly||id===this.domainOnly)) {
      const shut = Boolean(held) && id !== 'uam';
      domains.append(this.el('button', {type: 'button', class: 'sim-category', id: `stakeholder-domain-${id}`,
        'aria-pressed': String(this.domain === id), 'aria-disabled': shut ? 'true' : undefined,
        'data-locked': shut ? 'true' : undefined,
        onclick: () => {
          if (shut) {this.refuse(); return;}
          this.domain = id; this.onChange(this.domain, this.role); this.render(body);
        }}, label));
    }
    body.append(domains);
    this.locked = this.el('p', {class: 'sim-error stakeholder-locked', id: 'stakeholder-locked', role: 'alert',
      text: this.refusal ?? ''});
    body.append(this.locked);
    if (this.domain !== 'uam') {
      const label = DOMAINS.find(([id]) => id === this.domain)?.[1] ?? this.domain;
      body.append(this.el('p', {class: 'sim-empty', id: 'stakeholder-empty', text: `${label} 이해관계자 화면은 ${PREPARING}입니다. 지금은 UAM에서 조종사·운항사·버티포트·PSU를 고를 수 있습니다.`}));
      return;
    }
    const tabs = this.el('div', {class: 'sim-tabs', role: 'tablist', 'aria-label': 'UAM 이해관계자'});
    for (const [id, label] of UAM_STAKEHOLDERS) {
      const shut = Boolean(held) && id !== held.role;
      tabs.append(this.el('button', {type: 'button', class: 'sim-tab', role: 'tab', id: `stakeholder-tab-${id}`,
        'aria-selected': String(this.role === id), 'aria-disabled': shut ? 'true' : undefined,
        'data-locked': shut ? 'true' : undefined,
        onclick: () => {
          if (shut) {this.refuse(); return;}
          if (this.role === id) return;
          this.role = id; this.refusal = ''; this.onChange(this.domain, this.role); this.render(body);
        }}, label));
    }
    body.append(tabs);
    // Every party decides something, and each one's rules are its own. The
    // button sits above the party's screen rather than inside it so it reads
    // the same on all four, including the two whose screens are still to come.
    if (this.onDecisions) {
      const [, label] = UAM_STAKEHOLDERS.find(([id]) => id === this.role) ?? UAM_STAKEHOLDERS[0];
      body.append(this.el('button', {type: 'button', class: 'sim-decisions',
        id: 'stakeholder-decisions', onclick: () => this.onDecisions(this.role)},
        `${label} 의사결정 로직 열기`));
    }
    if(this.role==='psu' && this.psuPanel){
      const view=this.el('div',{role:'tabpanel','aria-label':'PSU 교통관리'});body.append(view);this.psuPanel.render(view);return;
    }
    if(this.role==='pilot' && this.pilotPanel){
      const view=this.el('div',{role:'tabpanel','aria-label':'조종사'});body.append(view);
      this.pilotPanel.render(view);return;
    }
    if(this.role==='vertiport' && this.vertiportPanel){
      const view=this.el('div',{role:'tabpanel','aria-label':'버티포트 운영자'});
      body.append(view);
      this.vertiportPanel.render(view);
      return;
    }
    const [, label, description] = UAM_STAKEHOLDERS.find(([id]) => id === this.role) ?? UAM_STAKEHOLDERS[0];
    body.append(this.el('h3', {class: 'sim-heading', id: 'stakeholder-title', text: `${label} 화면`}),
      this.el('p', {class: 'sim-empty', id: 'stakeholder-note', text: description}),
      this.el('p', {class: 'sim-empty stakeholder-preparing', id: 'stakeholder-state', text: `${PREPARING} · 이 자리에 ${label} 전용 화면이 들어옵니다.`}));
  }
}
