// User/Application: whether this browser is holding a stakeholder role right
// now, said in one line and shown where the operator cannot miss it.
//
// Holding a role is not a login and grants no authority — it is a seat in a
// shared rehearsal. But while it is held the screen answers as that party, so
// it has to be as visible as the clock, and the other parties' screens are
// closed until the seat is given up. Otherwise it is never clear which chair
// the person is sitting in.
import {buildElement} from '../../../dom_builder.js';

export const ROLE_NAMES = {psu: 'PSU', vertiport: '버티포트'};

// The badge line: "PSU 모드 : 홍길동", and for a vertiport the facility too,
// because which vertiport is the whole of that role.
export function roleModeLabel(member, facilities = {}) {
  if (!member || !ROLE_NAMES[member.role]) return null;
  const who = String(member.name || '운영자');
  if (member.role !== 'vertiport') return `${ROLE_NAMES[member.role]} 모드 : ${who}`;
  const where = facilities[member.facility_id];
  return `버티포트 모드 : ${who}${where ? ` · ${where}` : ''}`;
}

// What is said when another party's screen is asked for while a seat is held.
// It names the way out, because a mode with no visible exit reads as a fault.
export function refusalFor(member) {
  const name = ROLE_NAMES[member?.role] ?? '운영';
  return `${name} 모드입니다. 다른 이해관계자 화면을 보려면 먼저 접속을 해제하세요.`;
}

// A seat is the same seat while the role, the facility and the name are; the
// panel only rebuilds when one of those moves, not on every shared refresh.
export function seatKey(member) {
  return member ? `${member.role}:${member.facility_id ?? ''}:${member.name}` : '';
}

export class RoleBadge {
  constructor({node, session, document = globalThis.document}) {
    Object.assign(this, {node, session, document});
    this.unsubscribe = session?.subscribe(() => this.paint()) ?? (() => {});
    this.paint();
  }
  paint() {
    const node = this.node;
    if (!node) return null;
    const label = roleModeLabel(this.session?.member, this.session?.data?.facilities ?? {});
    node.textContent = label ?? '';
    node.hidden = !label;
    if (label) node.removeAttribute('hidden'); else node.setAttribute('hidden', '');
    node.dataset.role = this.session?.member?.role ?? '';
    return label;
  }
  destroy() {this.unsubscribe(); this.node = null;}
}

// The join card's connected half: who is sitting here, and the way out.
export function heldRow(document, session, {onLeave = () => {}} = {}) {
  const e = (tag, props = {}, ...children) => buildElement(document, tag, props, ...children);
  const who = e('strong', {class: 'ops-held-name'});
  const leave = e('button', {type: 'button', class: 'ops-leave', text: '접속 해제', onclick: () => onLeave()});
  const row = e('div', {class: 'ops-held'}, who, leave);
  const update = () => {
    const member = session.member;
    const label = roleModeLabel(member, session.data?.facilities ?? {});
    who.textContent = label ? `${label} · 접속 중` : '';
    leave.disabled = Boolean(session.mutating);
    row.hidden = !member;
    if (member) row.removeAttribute('hidden'); else row.setAttribute('hidden', '');
  };
  update();
  return {node: row, update};
}
