// Leaving manual flight.
//
// Entering it takes the workspace apart -- the aircraft dashboard is minimised,
// the plan and Simulation windows are put away, the flight is picked and the
// cockpit is entered. Every one of those has to be undone on the way out, and
// the session has more than one way out: the 종료 button, the plan panel, and a
// socket that simply stops answering. What was reported was the mode "not
// ending": a strip still saying 종료됨 and offering a button, over a workspace
// whose windows were still put away.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fakeDocument, FakeElement} from './fake_dom.mjs';
import {ManualFlightSession} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_session.js';
import {ManualFlightPanel} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_panel.js';

const source = name => readFileSync(new URL(`../../../../user_application/web/${name}`, import.meta.url), 'utf8');

// A session with its collaborators replaced, so the ways out can be taken
// without a server, a globe or a page.
function session({readyState = 1} = {}) {
  const sent = [], exits = [], notices = [], closed = [];
  const instance = Object.create(ManualFlightSession.prototype);
  Object.assign(instance, {
    generation: 1, frame: null, transport: null,
    running: true,
    panel: {close: () => closed.push(1), input: {active: true}, setStatus: () => {}},
    socket: {readyState, send: s => sent.push(JSON.parse(s)), close() {this.readyState = 3;}},
    onExit: () => exits.push(1), notify: m => notices.push(m),
  });
  return {instance, sent, exits, notices, closed};
}

test('종료 ends the session once, whoever presses it and however often', () => {
  const {instance, sent, exits, closed} = session();
  instance.stop();
  assert.deepEqual(sent, [{type: 'stop'}], 'the server is told, not just dropped');
  assert.equal(closed.length, 1, 'the strip comes down');
  assert.equal(instance.socket, null);
  assert.equal(exits.length, 1, 'and the rest of the page is told exactly once');

  // Pressing it again, or the plan panel clearing afterwards, must not run the
  // teardown a second time -- that path puts windows back and clears the plan.
  instance.stop();
  assert.equal(exits.length, 1, '두 번 눌러도 한 번');

  // The plan panel stops it without a notification, because it is the thing
  // that would have been notified.
  const quiet = session();
  quiet.instance.stop(false);
  assert.equal(quiet.exits.length, 0);
  assert.equal(quiet.closed.length, 1, 'but the strip still comes down');

  // Stopping something that never started is a no-op announcement. The plan
  // panel calls it before every run, and it must not clear the flight it is
  // about to show.
  const idle = session();
  idle.instance.running = false;
  idle.instance.stop();
  assert.equal(idle.exits.length, 0, '시작한 적 없는 세션은 알릴 것이 없다');
});

test('a session that ends by itself ends the mode too, rather than leaving a dead strip', () => {
  // The reported state: the far end went away, the strip stayed up saying
  // 종료됨 with a button on it, and nothing else had been told.
  const {instance, exits, notices, closed} = session();
  const statuses = [];
  instance.panel.setStatus = (state, text) => statuses.push([state, text]);
  let ready = true;
  const generation = instance.generation;

  // The close handler as the session installs it, exercised directly.
  const onclose = () => {
    if (generation !== instance.generation) return;
    if (!ready) return;
    instance.panel.input.active = false;
    instance.panel.setStatus('closed', '종료됨', '연결 종료 · 계획에서 다시 실행하세요');
    instance.notify('수동 세션 연결이 종료되었습니다.');
    instance.stop();
  };
  onclose();
  assert.deepEqual(statuses.at(-1), ['closed', '종료됨'], 'it still says what happened');
  assert.equal(notices.length, 1, 'out loud, because nothing was pressed');
  assert.equal(closed.length, 1, '그리고 조작부가 남지 않는다');
  assert.equal(exits.length, 1, 'the mode ends with it');

  // And the close that our own stop caused is not mistaken for the far end
  // going away: the generation moved first, so it is ignored.
  const before = exits.length;
  onclose();
  assert.equal(exits.length, before, '스스로 닫은 것은 다시 처리하지 않는다');
});

test('the way out is wired to undo what the way in did', () => {
  const app = source('app.js');
  const entry = app.slice(app.indexOf('onReady:async()'), app.indexOf('notify:message=>notify(\'manual-flight\''));
  // Going in: only windows that were open are put away, so leaving cannot
  // reopen something the operator had minimised themselves.
  assert.match(entry, /manualStowed\.push\(entry\.node\);windowWorkspace\.minimize\(entry\)/);
  assert.match(entry, /&&!entry\.minimized\)/, 'an already-minimised window is not ours to restore');
  assert.match(entry, /manualDashboardWasOpen=aircraftDashboard\?\.minimised===false/);

  // Coming out: every one of them, and the flight itself.
  const exit = app.slice(app.indexOf('onExit:()=>{'), app.indexOf('notify:message=>notify(\'manual-flight\''));
  for (const [what, pattern] of [
    ['the cockpit', /liveGlobe\?\.cockpit\?\.exit\(\)/],
    ['the strip', /manualFlight\.panel\.close\(\)/],
    ['the stale sample', /manualFlight\.sample=null/],
    ['the windows', /for\(const node of manualStowed\)windowWorkspace\.reveal\(node\)/],
    ['the dashboard', /if\(manualDashboardWasOpen\)aircraftDashboard\?\.setMinimised\(false\)/],
    ['the single flight', /planPanel\.clearFlight\(\)/],
  ]) assert.match(exit, pattern, `${what} is put back`);

  // clearFlight stops the session in turn. That must not run the teardown
  // again, which is what the reentrancy guard is for.
  const flight = source('domains/uam/cockpit/manual_flight_session.js');
  assert.match(flight, /if\(this\.stopping\)return;this\.stopping=true/);
  assert.match(flight, /const live=this\.running;this\.running=false/, 'and it is announced once');
  assert.match(flight, /ready=true;this\.running=true/, 'from the moment the engine answers');
  assert.match(source('domains/uam/planning/plan_panel.js'), /clearFlight\(\)\s*\{\s*\n?\s*this\.onManualStop\(\)/);
});

test('the strip offers 재개 only when there is something to resume, and never a dead button', () => {
  const document = {...fakeDocument, body: new FakeElement('body')};
  const resumed = [];
  const panel = new ManualFlightPanel({document, target: null, onResume: () => resumed.push(1)});
  // Before a session, and after one has closed, the chip is a label. Pressing
  // it does nothing, which is why it must not look like a button either.
  for (const state of ['idle', 'closed', 'active', 'preparing', 'linking']) {
    panel.setStatus(state, '…', '');
    assert.equal(panel.stateChip.getAttribute('aria-disabled'), 'true', state);
    panel.stateChip.onclick();
  }
  assert.deepEqual(resumed, [], '누를 것이 없을 때는 아무 일도 없다');

  panel.setStatus('held', '대기', '입력 보호 중');
  assert.equal(panel.status.textContent, '재개');
  assert.equal(panel.stateChip.getAttribute('aria-disabled'), 'false');
  panel.stateChip.onclick();
  assert.deepEqual(resumed, [1]);

  // Closing the strip puts the toolbar back where it came from, so a dashboard
  // that outlives the session is not left holding it.
  const host = new FakeElement('div');
  panel.mountDashboard({setManualControls: node => {host.replaceChildren(...(node ? [node] : []));}});
  assert.equal(host.children.length, 1);
  panel.close();
  assert.equal(host.children.length, 0, '조작부가 대시보드에 남지 않는다');
  assert.equal(panel.root.hidden, true);
  panel.destroy();
});
