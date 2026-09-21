import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement, fakeDocument} from './fake_dom.mjs';
import {StakeholderPanel, DOMAINS, UAM_STAKEHOLDERS} from '../../../../user_application/web/domains/uam/operations/stakeholder_panel.js';
import {CATEGORIES} from '../../../../user_application/web/domains/uam/planning/simulation_panel.js';
import {RoleBadge, refusalFor, roleModeLabel, seatKey} from '../../../../user_application/web/domains/uam/operations/role_mode.js';

const web = new URL('../../../../user_application/web/', import.meta.url);
const html = readFileSync(new URL('index.html', web), 'utf8');
const app = readFileSync(new URL('app.js', web), 'utf8');
const css = readFileSync(new URL('styles.css', web), 'utf8');

test('the section offers the same domains as Simulation and, for UAM, the four parties', () => {
  assert.deepEqual(DOMAINS, CATEGORIES, 'one set of domains across the sections');
  assert.deepEqual(UAM_STAKEHOLDERS.map(([id, label]) => [id, label]),
    [['pilot', '조종사'], ['operator', '운항사'], ['vertiport', '버티포트'], ['psu', 'PSU']]);
  const changes = [];
  const panel = new StakeholderPanel({document: fakeDocument, onChange: (domain, role) => changes.push([domain, role])});
  const body = new FakeElement('div');
  panel.render(body);
  const domains = body.querySelectorAll('.sim-category');
  assert.deepEqual(domains.map(b => b.textContent), ['항공기', '위성', 'UAM']);
  assert.deepEqual(domains.map(b => b.getAttribute('aria-pressed')), ['false', 'false', 'true'], 'UAM is the domain to start in');
  const tabs = body.querySelectorAll('.sim-tab');
  assert.deepEqual(tabs.map(b => b.textContent), ['조종사', '운항사', '버티포트', 'PSU']);
  assert.deepEqual(tabs.map(b => b.getAttribute('aria-selected')), ['true', 'false', 'false', 'false']);
  assert.equal(body.querySelector('#stakeholder-title').textContent, '조종사 화면');
  assert.match(body.querySelector('#stakeholder-note').textContent, /조종사가 보는 화면/);
  assert.match(body.querySelector('#stakeholder-state').textContent, /준비 중/);
  // Another party: its tab is selected and its placeholder says what it will hold.
  body.querySelector('#stakeholder-tab-psu').click();
  assert.equal(panel.role, 'psu');
  assert.deepEqual(body.querySelectorAll('.sim-tab').map(b => b.getAttribute('aria-selected')), ['false', 'false', 'false', 'true']);
  assert.match(body.querySelector('#stakeholder-note').textContent, /PSU/);
  assert.deepEqual(changes, [['uam', 'psu']]);
  body.querySelector('#stakeholder-tab-psu').click();
  assert.equal(changes.length, 1, 'the same tab again changes nothing');
  // Another domain: no parties yet, and the section says so.
  body.querySelector('#stakeholder-domain-aircraft').click();
  assert.equal(panel.domain, 'aircraft');
  assert.equal(body.querySelectorAll('.sim-tab').length, 0);
  assert.match(body.querySelector('#stakeholder-empty').textContent, /항공기 이해관계자 화면은 준비 중/);
  body.querySelector('#stakeholder-domain-uam').click();
  assert.equal(body.querySelector('#stakeholder-tab-psu').getAttribute('aria-selected'), 'true', 'the party chosen before is kept');
});

test('the rail carries a Stakeholders button after Library that opens its own section', () => {
  const rail = html.match(/<nav\b[^>]*\bid="rail"[\s\S]*?<\/nav>/)?.[0] ?? '';
  const button = rail.match(/<button\b[^>]*\bid="mode-stakeholders"[\s\S]*?<\/button>/)?.[0];
  assert.ok(button, 'the rail has a Stakeholders button');
  assert.match(button, /<svg[\s\S]*<\/svg>/, 'with an icon like its neighbours');
  assert.match(button, /Stakeholders/);
  assert.ok(rail.indexOf('mode-library') < rail.indexOf('mode-stakeholders'), 'it follows Library');
  assert.match(app, /stakeholders:\{label:'Stakeholders',render:body=>stakeholderPanel\.render\(body\)\}/, 'and opens a section of its own');
  assert.match(app, /stakeholders:\$\('mode-stakeholders'\)/, 'the work panel marks it expanded');
  assert.match(app, /for\(const id of \['library','analysis','stakeholders','live','simulation'\]\)[\s\S]*?workWindows\.open\(id\)/, 'each rail press creates an independent window');
  assert.match(css, /\.stakeholder-preparing\{/);
});

// ---- holding a role ----------------------------------------------------
// Sitting in a party's chair changes what the whole screen answers as, so the
// other parties are closed until the seat is given up and the chair is named
// where the operator cannot miss it.
function fakeSession(member = null, facilities = {}) {
  const listeners = new Set();
  return {member, data: {facilities}, mutating: false,
    subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);},
    sit(next, names) {this.member = next; if (names) this.data.facilities = names; for (const fn of listeners) fn(this);}};
}

test('the badge names the chair, and only while one is being sat in', () => {
  assert.equal(roleModeLabel(null), null);
  assert.equal(roleModeLabel({role: 'psu', name: '홍길동'}), 'PSU 모드 : 홍길동');
  assert.equal(roleModeLabel({role: 'vertiport', name: '홍길동', facility_id: 'VP001'}, {VP001: '여의도'}),
    '버티포트 모드 : 홍길동 · 여의도');
  // A facility the roster has not named yet still says which mode it is.
  assert.equal(roleModeLabel({role: 'vertiport', name: '홍길동', facility_id: 'VP404'}), '버티포트 모드 : 홍길동');
  assert.equal(roleModeLabel({role: 'psu', name: ''}), 'PSU 모드 : 운영자');
  assert.equal(roleModeLabel({role: 'pilot', name: '홍길동'}), null, '연습 좌석이 있는 역할만');
  // The same chair through a shared refresh is the same chair.
  assert.equal(seatKey({role: 'psu', name: '홍길동'}), seatKey({role: 'psu', name: '홍길동'}));
  assert.notEqual(seatKey({role: 'psu', name: '홍길동'}), seatKey({role: 'psu', name: '김철수'}));
  assert.equal(seatKey(null), '');
  assert.match(refusalFor({role: 'psu'}), /PSU 모드입니다/);
  assert.match(refusalFor({role: 'vertiport'}), /버티포트 모드입니다/);
  assert.match(refusalFor(null), /접속을 해제/);

  const node = new FakeElement('div');
  const session = fakeSession();
  const badge = new RoleBadge({node, session, document: fakeDocument});
  assert.equal(node.hidden, true);
  session.sit({role: 'psu', name: '홍길동'});
  assert.equal(node.textContent, 'PSU 모드 : 홍길동');
  assert.equal(node.hidden, false);
  assert.equal(node.dataset.role, 'psu');
  session.sit({role: 'vertiport', name: '홍길동', facility_id: 'VP001'}, {VP001: '여의도'});
  assert.equal(node.textContent, '버티포트 모드 : 홍길동 · 여의도');
  assert.equal(node.dataset.role, 'vertiport');
  session.sit(null);
  assert.equal(node.hidden, true);
  assert.equal(node.textContent, '');
  badge.destroy();
});

test('while a seat is held the other parties are shut and say why', () => {
  const session = fakeSession();
  const changes = [];
  const panel = new StakeholderPanel({document: fakeDocument, session, onChange: (d, r) => changes.push([d, r])});
  const body = new FakeElement('div');
  panel.render(body);
  const tab = id => body.querySelector('#stakeholder-tab-' + id);
  assert.equal(tab('psu').getAttribute('data-locked'), null, 'nothing is shut while only watching');

  // Taking the PSU seat elsewhere brings this section to the PSU screen.
  session.sit({role: 'psu', name: '홍길동'});
  assert.equal(panel.role, 'psu');
  assert.equal(tab('psu').getAttribute('aria-selected'), 'true');
  assert.equal(tab('psu').getAttribute('data-locked'), null, 'the chair being sat in is not shut');
  assert.deepEqual(['pilot', 'operator', 'vertiport'].map(id => tab(id).getAttribute('data-locked')), ['true', 'true', 'true']);
  assert.equal(tab('vertiport').getAttribute('aria-disabled'), 'true');

  // Pressing one says why rather than doing nothing, and does not move.
  assert.equal(body.querySelector('#stakeholder-locked').textContent, '');
  tab('vertiport').click();
  assert.equal(panel.role, 'psu', 'the shut party does not open');
  assert.match(body.querySelector('#stakeholder-locked').textContent, /PSU 모드입니다/);
  assert.match(body.querySelector('#stakeholder-locked').textContent, /접속을 해제/, '나가는 길을 알려 줍니다');
  assert.deepEqual(changes, [], 'nothing downstream is told a party changed');

  // The other domains are shut too: leaving UAM abandons the chair just as surely.
  const domain = id => body.querySelector('#stakeholder-domain-' + id);
  assert.deepEqual(['aircraft', 'satellite'].map(id => domain(id).getAttribute('data-locked')), ['true', 'true']);
  assert.equal(domain('uam').getAttribute('data-locked'), null);
  domain('aircraft').click();
  assert.equal(panel.domain, 'uam');

  // Giving the seat up opens everything again.
  session.sit(null);
  assert.equal(tab('vertiport').getAttribute('data-locked'), null);
  assert.equal(body.querySelector('#stakeholder-locked').textContent, '');
  body.querySelector('#stakeholder-tab-vertiport').click();
  assert.equal(panel.role, 'vertiport');
  panel.destroy();
});

test('a shared refresh that changes nothing does not rebuild the open party view', () => {
  const session = fakeSession({role: 'psu', name: '홍길동'});
  let renders = 0;
  const panel = new StakeholderPanel({document: fakeDocument, session,
    psuPanel: {render: () => {renders += 1;}, deactivate: () => {}}});
  panel.render(new FakeElement('div'));
  assert.equal(renders, 1);
  // The session polls every few seconds; rebuilding then would throw away the
  // queue's scroll and the request being read.
  session.sit({role: 'psu', name: '홍길동'});
  session.sit({role: 'psu', name: '홍길동'});
  assert.equal(renders, 1);
  session.sit({role: 'psu', name: '김철수'});
  assert.equal(renders, 2, 'a different person in the chair is a different chair');
  panel.destroy();
});

test('the page carries the badge and the session can give a seat back', () => {
  assert.match(html, /id="role-badge"/);
  assert.match(app, /new RoleBadge\(/);
  assert.match(app, /session:operationsSession/);
  assert.match(css, /#role-badge\{/);
  assert.match(css, /\.sim-tab\[data-locked=true\]/);
  const sessionSource = readFileSync(new URL('domains/uam/operations/operations_session.js', web), 'utf8');
  assert.match(sessionSource, /async leave\(\)/);
  assert.match(sessionSource, /heldRow/);
  const routes = readFileSync(new URL('../../../../communication/web/operations_routes.py', import.meta.url), 'utf8');
  assert.match(routes, /router\.post\(.\/leave.\)/);
  const room = readFileSync(new URL('../../../../user_application/apps/web_dashboard/operations_rehearsal.py', import.meta.url), 'utf8');
  assert.match(room, /def leave\(self, token\)/);
});
