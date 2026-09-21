import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement, fakeDocument} from './fake_dom.mjs';
import {ScenarioControl, SPEEDS, FIGURES, MAX_CLOCK_DRIFT_S, clockText, duration, elapsedText} from '../../../../user_application/web/domains/uam/operations/scenario_control.js';
import {DemandPanel} from '../../../../user_application/web/domains/uam/planning/demand_panel.js';

const web = new URL('../../../../user_application/web/', import.meta.url);
const app = readFileSync(new URL('app.js', web), 'utf8');
const css = readFileSync(new URL('scenario_control.css', web), 'utf8');
const globe = readFileSync(new URL('../../../../digital_twin/visualization/web/globe.js', import.meta.url), 'utf8');

const STATUS = {
  schema_version: 1, state: 'ready', loaded: true, control_open: true, scenario_id: 'x-1',
  name: 'FPL_all.csv', date: '2026-10-10', speeds: SPEEDS, speed: 1,
  clock: '06:30:00', time_s: 23400, opens_s: 23400, closes_s: 69036, progress: 0,
  aircraft: 84, airborne: 0, parked: 84, active: 0, holding: 0, finished: 0,
  flights: 947, flights_started: 0, flights_completed: 0, flights_remaining: 947,
  passengers_carried: 0, cancelled: 0, direct_flights: 0,
  psu: {requests: 0, held: 0, held_arrivals: 0, refused: 0, hold_seconds_total: 0,
    hold_seconds_mean: 0, hold_seconds_median: 0, hold_seconds_max: 0},
  problems: 0, recording: {rows: 0, events: 0, scenario_id: 'x-1'},
};

function harness(overrides = {}) {
  const sent = [], messages = [];
  let status = {...STATUS};
  const api = {
    status: async () => status,
    unload: async () => {sent.push({action: 'unload'}); status = {loaded: false, state: 'idle'}; return status;},
    control: async body => {
      sent.push(body);
      if (body.action === 'play') status = {...status, state: 'playing'};
      if (body.action === 'pause') status = {...status, state: 'paused'};
      if (body.action === 'stop') status = {...status, state: 'finished'};
      if (body.action === 'reset') status = {...status, state: 'ready', speed: 1};
      if (body.speed) status = {...status, speed: body.speed};
      return status;
    },
    ...overrides,
  };
  const mount = new FakeElement('body');
  const control = new ScenarioControl({api, document: fakeDocument, mount,
    notify: (state, message) => messages.push([state, message]),
    onCapture: () => {messages.push(['capture', 'png']); return true;},
    onRecord: (action) => {messages.push(['record', action]); return true;}});
  const settle = async () => {for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));};
  return {control, mount, sent, messages, settle, current: () => status};
}
test('manual assignment fixes both simulation speed controls while play and pause remain available',async()=>{
 const {control,sent}=harness();await control.open();
 control.status={...control.status,manual_aircraft:'UAM0001'};control.paint();
 assert.equal(control.miniSpeed.disabled,true);
 assert.ok([...control.speedButtons.values()].every(button=>button.disabled));
 const before=sent.length;await control.setSpeed(4);assert.equal(sent.length,before);
 await control.play();assert.equal(sent.at(-1).action,'play');
 await control.pause();assert.equal(sent.at(-1).action,'pause');control.stop();
});

test('opening the console hands the twin over before it draws anything', async () => {
  const {control, mount, sent, messages, settle} = harness();
  assert.equal(control.isOpen, false);
  await control.open();
  await settle();
  // The map is switched first, so the controls appear over the day rather than
  // over the live traffic.
  assert.deepEqual(sent[0], {action: 'open_control'});
  assert.ok(mount.querySelector('#scenario-console'), 'the console is on the page');
  assert.equal(control.isOpen, true);
  assert.match(messages[0][1], /전환하는 중/);
  control.stop();
});

test('the dashboard reads out what the day is doing', async () => {
  const {control, mount, settle} = harness();
  await control.open();
  await settle();
  const figures = mount.querySelectorAll('.sc-figure').map(node => node.getAttribute('data-id'));
  assert.deepEqual(figures, FIGURES.map(item => item.id));
  assert.equal(mount.querySelector('#scenario-clock').textContent, '06:30:00');
  assert.match(mount.querySelector('#scenario-console').textContent, /2026-10-10/);
  // Everything on the stand and nothing flying, which is what the file says.
  const held = mount.querySelectorAll('.sc-figure').find(node => node.getAttribute('data-id') === 'parked');
  assert.match(held.textContent, /84/);
  const flights = mount.querySelectorAll('.sc-figure').find(node => node.getAttribute('data-id') === 'completed');
  assert.match(flights.textContent, /947/, 'and how many there are altogether');
  control.stop();
});

test('play, pause, stop, reset and the speeds are asked of the server', async () => {
  const {control, mount, sent, settle} = harness();
  await control.open();
  await settle();
  await mount.querySelector('#scenario-play').click();
  await settle();
  assert.deepEqual(sent[1], {action: 'play'});
  assert.equal(mount.querySelector('#scenario-play').disabled, true, 'it is already playing');
  assert.equal(mount.querySelector('#scenario-pause').disabled, false);
  await mount.querySelector('#scenario-speed-10').click();
  await settle();
  assert.deepEqual(sent[2], {speed: 10});
  assert.equal(mount.querySelector('#scenario-speed-10').getAttribute('aria-pressed'), 'true');
  assert.equal(mount.querySelector('#scenario-speed-1').getAttribute('aria-pressed'), 'false');
  await mount.querySelector('#scenario-pause').click();
  await settle();
  assert.deepEqual(sent[3], {action: 'pause'});
  await mount.querySelector('#scenario-stop').click();
  await settle();
  assert.deepEqual(sent[4], {action: 'stop'});
  await mount.querySelector('#scenario-reset').click();
  await settle();
  assert.deepEqual(sent[5], {action: 'reset'});
  // Every speed the server offers has a button, and no others.
  const offered = mount.querySelectorAll('.sc-speed').map(node => node.textContent);
  assert.deepEqual(offered, SPEEDS.map(speed => `×${speed}`));
  control.stop();
});

test('two quick presses both reach the server, in the order they were given', async () => {
  // A speed and then play is one gesture to an operator. Dropping the second
  // because the first is still in flight reads as a button that did nothing.
  const order = [];
  let release;
  const held = new Promise(resolve => {release = resolve;});
  const {control, settle} = harness({
    control: async body => {
      if (body.speed) await held;
      order.push(body.speed ? `speed:${body.speed}` : body.action);
      return {...STATUS, state: body.action === 'play' ? 'playing' : STATUS.state,
        speed: body.speed ?? STATUS.speed};
    }});
  await control.open();
  await settle();
  const first = control.setSpeed(10);
  const second = control.play();
  release();
  await Promise.all([first, second]);
  await settle();
  assert.deepEqual(order.slice(-2), ['speed:10', 'play'], 'both, and the speed before the play');
  control.stop();
});

test('an older poll cannot revert a speed command and overlapping polls are skipped',async()=>{
  let release,calls=0;
  const {control}=harness({status:()=>{calls++;return new Promise(resolve=>release=resolve);}});
  await control.open();
  const poll=control.refresh();await control.refresh();assert.equal(calls,1);
  await control.setSpeed(10);
  release({...STATUS,speed:1});await poll;
  assert.equal(control.status.speed,10);
  control.destroy();
});

test('console clock uses the map interpolation clock and stops when closed',async()=>{
  const {control}=harness();await control.open();
  control.status={...STATUS,epoch_time:1000,time_s:23400};control.displayClock=()=>1000250;
  assert.equal(control.clockMillis(),1000250);
  control.paintClock();assert.equal(control.clock.textContent,'06:30:00');
  control.displayClock=()=>1001750;control.paintClock();assert.equal(control.clock.textContent,'06:30:02');
  control.destroy();assert.equal(control.clockMillis(),null);
});

test('closing waits for in-flight control and prevents queued play resurrecting simulation',async()=>{
  let release;const commands=[];
  const {control,settle}=harness({control:async body=>{
    commands.push(body);if(body.speed)await new Promise(resolve=>release=resolve);
    return {...STATUS,...body};
  }});
  await control.open();const speed=control.setSpeed(10);await settle();
  const play=control.play();const close=control.close();release();
  await Promise.all([speed,play,close]);
  assert.equal(commands.at(-1).action,'close_control');
  assert.ok(!commands.some(x=>x.action==='play'));assert.equal(control.isOpen,false);
});

test('the picture and the recording are of the screen, and the map takes them', async () => {
  const {control, mount, messages, settle} = harness();
  await control.open();
  await settle();
  mount.querySelector('#scenario-capture').click();
  assert.ok(messages.some(([kind]) => kind === 'capture'));
  const record = mount.querySelector('#scenario-record');
  record.click();
  assert.equal(control.recording, true);
  assert.equal(record.getAttribute('aria-pressed'), 'true');
  assert.match(record.textContent, /녹화 중/);
  record.click();
  assert.equal(control.recording, false);
  assert.deepEqual(messages.filter(([kind]) => kind === 'record').map(([, action]) => action),
    ['start', 'stop']);
  // Closing a console that is recording saves what it has rather than losing it.
  const second = harness();
  await second.control.open();
  await second.settle();
  second.mount.querySelector('#scenario-record').click();
  await second.control.close();
  assert.equal(second.control.recording, false);
  assert.ok(second.messages.some(([kind, action]) => kind === 'record' && action === 'stop'));
  control.stop();
});

test('closing gives the twin back to the live clock and throws the day away', async () => {
  const {control, mount, sent, settle} = harness();
  await control.open();
  await settle();
  await control.close();
  assert.equal(control.isOpen, false);
  assert.equal(mount.querySelectorAll('#scenario-console').length, 0);
  // The twin comes back first, then the day is thrown away: closing is done
  // with it, not a pause. Pausing is what keeps a day.
  assert.deepEqual(sent.slice(-2), [{action: 'close_control'}, {action: 'unload'}]);
  assert.equal(control.status.loaded, false);
});

test('a day that cannot be thrown away says so rather than holding the console open', async () => {
  const {control, mount, sent, messages, settle} = harness({
    unload: async () => {throw new Error('서버가 응답하지 않습니다');}});
  await control.open();
  await settle();
  await control.close();
  // The console has already gone and the twin is already back on the live
  // clock, so a failure here is reported, not raised at the operator.
  assert.equal(control.isOpen, false);
  assert.equal(mount.querySelectorAll('#scenario-console').length, 0);
  assert.deepEqual(sent.at(-1), {action: 'close_control'});
  assert.ok(messages.some(([state, message]) => state === 'warning' && /내리지 못했습니다/.test(message)));
});

test('the page forgets the plan and shuts the summary when the console closes', () => {
  // Nothing on screen may go on offering a replay that is over.
  assert.match(app, /onClose:\(\)=>\{[^}]*demandPanel\.forgetPlan\(\);demandSummary\.close\(\)/);
  assert.match(app, /unload:async\(\)=>\{const response=await fetch\('\/api\/simulation\/scenario',\{method:'DELETE'/);
});

test('a failure to open says so and leaves the map alone', async () => {
  const {control, mount, messages} = harness({control: async () => {throw new Error('서버가 응답하지 않습니다');}});
  const answer = await control.open();
  assert.equal(answer, null);
  assert.equal(mount.querySelectorAll('#scenario-console').length, 0);
  assert.ok(messages.some(([state, message]) => state === 'error' && /서버가/.test(message)));
});

test('the console says which instant the twin is actually at', async () => {
  // A page clock reading now while the map shows a day in October is the one
  // thing on screen that would be lying about what is being looked at.
  const epoch = 1791581400;
  const {control, settle} = harness({
    control: async () => ({...STATUS, epoch_time: epoch}),
    status: async () => ({...STATUS, epoch_time: epoch})});
  assert.equal(control.clockMillis(), null, 'nothing is being replayed yet');
  await control.open();
  await settle();
  assert.equal(control.clockMillis(), epoch * 1000);
  await control.close();
  assert.equal(control.clockMillis(), null, 'and the page goes back to now');
  // The page asks the console for it and marks the clock when it answers.
  assert.match(app, /let twinClockMillis=\(\)=>null;/);
  assert.match(app, /twinClockMillis=\(\)=>scenarioControl\.clockMillis\(\);/);
  assert.match(app, /element\.dataset\.source=replayed\?'scenario':'live';/);
});

test('clocks and durations read as an operator says them', () => {
  assert.equal(clockText(23400), '06:30:00');
  assert.equal(clockText(69036), '19:10:36');
  assert.equal(clockText(NaN), '--:--:--');
  assert.equal(duration(0), '0초');
  assert.equal(duration(150), '3분');
  assert.equal(duration(4000), '1시간 7분');
});

// ---- the loader in the multi-flight card ----------------------------------
const DESCRIPTION = {
  schema_version: 1, state: 'ready', loaded: true, scenario_id: 'x-1', name: 'FPL_all.csv',
  speeds: SPEEDS, speed: 1,
  schedule: {flights: 947, aircraft: 84, vertiports: 16, passengers: 1511, unresolved: 26,
    window: {start: '06:30:00', end: '19:10:36'},
    by_seat_class: [{seats: 2, label: '2인승', asset_id: 'joby_s4', span_m: 8, flights: 386},
      {seats: 8, label: '8인승', asset_id: 'amvlab_evtol', span_m: 15, flights: 61}],
    model_spans: {joby_s4: 8, amvlab_evtol: 15}},
  initial_state: {placements: new Array(84).fill({}), reassigned: []},
  problems: [],
};

function panelHarness(load, describe) {
  const loaded = [], opened = [];
  const panel = new DemandPanel({
    api: {list: async () => ({vertiports: []})},
    document: fakeDocument,
    plans: {example: load ?? (async () => DESCRIPTION),
      describe: describe ?? (async () => ({schema_version: 1, state: 'idle', loaded: false, speeds: SPEEDS}))},
    onPlanLoaded: answer => {loaded.push(answer);},
    onControlPanel: answer => {opened.push(answer); return Promise.resolve(true);},
  });
  const body = new FakeElement('div');
  const settle = async () => {for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));};
  return {panel, body, loaded, opened, settle};
}

const file = (name = 'FPL_all.csv', text = 'a,b\n1,2\n') => ({name, text: async () => text});

test('a flight plan is loaded from a file and the card says what is in it', async () => {
  const {panel, body, loaded, settle} = panelHarness();
  panel.render(body);
  await panel.ready;
  await settle();
  const button = body.querySelector('#demand-plan-load');
  assert.ok(button, 'the card offers to load one');
  assert.match(button.textContent, /예시 비행계획 적용/);
  assert.equal(button.getAttribute('disabled'), null, 'false must not become an HTML disabled attribute');
  assert.equal(body.querySelector('#demand-plan-file'), null, 'only the configured example can be applied');
  await panel.loadPlan(file());
  await settle();
  // What the day contains, before anything is flown.
  const summary = body.querySelector('#demand-plan-summary');
  assert.match(summary.textContent, /947편/);
  assert.match(summary.textContent, /84대/);
  assert.match(summary.textContent, /06:30:00~19:10:36/);
  // One badge per cabin size, naming the model each is drawn with.
  const models = body.querySelector('#demand-plan-models');
  assert.match(models.textContent, /joby_s4/);
  assert.match(models.textContent, /amvlab_evtol/);
  // The 26 the file could not resolve are said before they are flown.
  assert.match(body.querySelector('#demand-plan').textContent, /26편/);
  // And the map was told how big to draw each cabin.
  assert.deepEqual(loaded, [DESCRIPTION]);
});

test('loading says it is preparing, and a failure says what went wrong', async () => {
  let release;
  const waiting = new Promise(resolve => {release = resolve;});
  const {panel, body, settle} = panelHarness(async () => {await waiting; return DESCRIPTION;});
  panel.render(body);
  await panel.ready;
  await settle();
  const loading = panel.loadPlan(file());
  await settle();
  assert.match(body.querySelector('#demand-plan-busy').textContent, /비행을 준비중입니다/);
  release();
  await loading;
  await settle();
  assert.equal(body.querySelectorAll('#demand-plan-busy').length, 0, 'and it stops saying so');

  const broken = panelHarness(async () => {throw new Error('필요한 열이 없습니다: off_block_time');});
  broken.panel.render(broken.body);
  await broken.panel.ready;
  await broken.settle();
  await broken.panel.loadPlan(file());
  await broken.settle();
  assert.match(broken.body.querySelector('#demand-plan-error').textContent, /필요한 열이 없습니다/);
  assert.equal(broken.body.querySelectorAll('#demand-plan-open').length, 0, 'nothing to open');
});

test('a day loaded before this page was opened is already on the card', async () => {
  // The server holds the day, not the page. Reloading the browser must not make
  // the operator load the same file again.
  const {panel, body, loaded, settle} = panelHarness(null, async () => DESCRIPTION);
  panel.render(body);
  await panel.ready;
  await settle();
  assert.match(body.querySelector('#demand-plan-summary').textContent, /947편/);
  assert.ok(body.querySelector('#demand-plan-open'), 'and it can be opened straight away');
  assert.deepEqual(loaded, [DESCRIPTION], 'the map is told the drawing sizes too');
  // A server with no day loaded leaves the card offering to load one.
  const empty = panelHarness();
  empty.panel.render(empty.body);
  await empty.panel.ready;
  await empty.settle();
  assert.equal(empty.body.querySelectorAll('#demand-plan-summary').length, 0);
  assert.match(empty.body.querySelector('#demand-plan-load').textContent, /예시 비행계획 적용/);
});

test('the console is opened from the card once a day is loaded', async () => {
  const {panel, body, opened, settle} = panelHarness();
  panel.render(body);
  await panel.ready;
  await settle();
  assert.equal(body.querySelectorAll('#demand-plan-open').length, 0, 'not before a plan is loaded');
  await panel.loadPlan(file());
  await settle();
  const open = body.querySelector('#demand-plan-open');
  assert.match(open.textContent, /Control Panel 열기/);
  await panel.openControlPanel();
  await settle();
  assert.deepEqual(opened, [DESCRIPTION]);
});

test('the page wires the console to the map, and the styles exist', () => {
  assert.match(app, /new ScenarioControl\(\{api:scenarioApi/);
  assert.match(app, /onCapture:name=>liveGlobe\?\.captureImage\(name\)/);
  assert.match(app, /onRecord:\(action,name\)=>action==='start'/);
  assert.match(app, /plans:scenarioApi/);
  // Opening the console also carries the plan's answer about whether one of
  // its aircraft is to be flown by hand.
  // Opening the console carries the plan's answer about flying one of its
  // aircraft by hand, and refuses while a single flight already has the globe.
  assert.match(app, /onControlPanel:\(plan,manual\)=>\{/);
  assert.match(app, /manualAssignment\.setRequest\(manual\);return scenarioControl\.open\(\);/);
  assert.match(app, /if\(planPanel\.plan\)\{[\s\S]{0,240}?단일 비행이 화면에 있습니다/);
  assert.match(app, /setModelSpans\(answer\?\.schedule\?\.model_spans\)/);
  // The map takes the picture off its own canvas in the frame it draws.
  assert.match(globe, /captureImage\(name='aerodt\.png'\)/);
  assert.match(globe, /scene\.initializeFrame\(\);scene\.render\(\);/);
  assert.match(globe, /const RECORDING_FPS=30;/);
  assert.match(globe, /captureStream\?\.\(RECORDING_FPS\)/);
  // Both leave with the mark on them, so a picture that goes anywhere says
  // where it came from, and a recording is worth the pixels it is made of.
  assert.match(globe, /const framed=this\.brandedFrame\(scene\.canvas\);/);
  assert.match(globe, /videoBitsPerSecond:recordingBitrate\(source\.width,source\.height,RECORDING_FPS\)/);
  assert.match(globe, /enabled:!this\.transitioning&&!this\.recorder/,
    'and a recording is drawn at full resolution rather than the moving-camera budget');
  // A recording is taken straight off the scene's canvas and carries no mark.
  // Stamping one means copying every frame into a canvas of our own, and this
  // canvas does not preserve its drawing buffer, so any copy later than the
  // render that filled it gets a cleared one: the map comes out black under the
  // mark. A still is drawn and read in one block, so that one keeps its mark.
  assert.match(globe, /const stream=source\.captureStream\?\.\(RECORDING_FPS\)/);
  assert.doesNotMatch(globe, /postRender\.addEventListener\(\(\)=>this\.brandedFrame/);
  assert.doesNotMatch(globe, /paintRecording/);
  assert.match(css, /\.scenario-console\{/);
  assert.match(css, /\.sc-figure\[data-id=holding\]>strong\{/);
});

test('minimised, the console is one row under the clock and nothing else', async () => {
  // The map is what the operator came to watch. The readings are a click away.
  const {control, mount, settle} = harness();
  await control.open();
  await settle();
  const console_ = mount.querySelector('#scenario-console');
  assert.equal(console_.getAttribute('data-minimised'), 'false');
  mount.querySelector('#scenario-minimise').click();
  assert.equal(console_.getAttribute('data-minimised'), 'true');
  for (const id of ['#scenario-mini-play', '#scenario-mini-pause', '#scenario-mini-speed',
    '#scenario-mini-capture', '#scenario-mini-record', '#scenario-mini-close'])
    assert.ok(mount.querySelector(id), `${id} is on the small bar`);
  // The day's clock stays: it is the one reading that says where the day is.
  assert.equal(mount.querySelector('#scenario-mini-clock').textContent, '06:30:00');
  mount.querySelector('#scenario-restore').click();
  assert.equal(console_.getAttribute('data-minimised'), 'false');
  assert.ok(mount.querySelector('#scenario-figures'), 'the dashboard is back');
  control.stop();
});

test('the small bar drives the same day as the full one', async () => {
  const {control, mount, sent, settle} = harness();
  await control.open();
  await settle();
  control.setMinimised(true);
  mount.querySelector('#scenario-mini-play').click();
  await settle();
  assert.deepEqual(sent.at(-1), {action: 'play'});
  mount.querySelector('#scenario-mini-pause').click();
  await settle();
  assert.deepEqual(sent.at(-1), {action: 'pause'});
  control.stop();
});

test('one speed button steps up, wraps round, and the right button is the way back to real time', async () => {
  const {control, mount, sent, settle} = harness();
  await control.open();
  await settle();
  control.setMinimised(true);
  const button = mount.querySelector('#scenario-mini-speed');
  assert.equal(button.textContent, '×1');
  button.click();
  await settle();
  assert.deepEqual(sent.at(-1), {speed: SPEEDS[1]});
  assert.equal(button.textContent, `×${SPEEDS[1]}`);
  // From the fastest it comes round to the slowest rather than stopping dead.
  await control.setSpeed(SPEEDS.at(-1));
  await settle();
  button.click();
  await settle();
  assert.deepEqual(sent.at(-1), {speed: SPEEDS[0]});
  // The right button goes straight back, and does not leave a menu over the map.
  await control.setSpeed(SPEEDS[2]);
  await settle();
  let defaultPrevented = false;
  button.oncontextmenu({preventDefault: () => {defaultPrevented = true;}});
  await settle();
  assert.equal(defaultPrevented, true);
  assert.deepEqual(sent.at(-1), {speed: SPEEDS[0]});
  control.stop();
});

test('a recording says that it is running and for how long', async () => {
  const {control, mount, settle} = harness();
  await control.open();
  await settle();
  const badge = mount.querySelector('#scenario-recording');
  assert.equal(badge.hidden, true, 'nothing is claimed before anything is recorded');
  control.toggleRecording();
  control.recordingFrom = Date.now() - 72_000;
  control.paintRecording();
  assert.equal(badge.hidden, false);
  assert.match(badge.textContent, /녹화 중 01:12/);
  assert.match(mount.querySelector('#scenario-mini-recording').textContent, /01:12/,
    'the small bar says it too, so neither view has to be the trusted one');
  control.stopRecording();
  assert.equal(badge.hidden, true);
  assert.equal(mount.querySelector('#scenario-recording').textContent, '');
  control.stop();
});

test('how long a recording has run reads as a clock', () => {
  assert.equal(elapsedText(0), '00:00');
  assert.equal(elapsedText(9_400), '00:09');
  assert.equal(elapsedText(72_000), '01:12');
  assert.equal(elapsedText(3_723_000), '1:02:03');
  assert.equal(elapsedText(NaN), '00:00');
});

test('the clock says which mode this screen is in, in a word and not only in colour', () => {
  const html = readFileSync(new URL('index.html', web), 'utf8');
  const styles = readFileSync(new URL('styles.css', web), 'utf8');
  assert.match(html, /id="clock-mode"[^>]*hidden/, 'the tag starts hidden');
  // A replayed day, and the two stakeholder seats. Plain live needs no tag.
  assert.match(app, /CLOCK_MODES=\{scenario:'SIMULATION',psu:'PSU',vertiport:'버티포트'\}/);
  assert.match(app, /tag\.hidden=mode==='live'/);
  // A seat wins the ring over a replayed day: both change what the screen is,
  // but a seat changes what it answers as, and the time already says '· 재생'.
  assert.match(app, /const mode=CLOCK_MODES\[role\] \? role : replaying \? 'scenario' : 'live'/);
  // A single flight being scrubbed is a simulation on screen just as a day is,
  // and its console exists only while it is showing.
  assert.match(app, /const replaying=replayed \|\| Boolean\(document\.getElementById\('flight-console'\)\)/);
  // The time itself only claims to be a replay when the twin's clock has
  // actually moved: a recorded flight is drawn over the live sky.
  assert.match(app, /element\.textContent=formatUtcClock\(time\)\+\(replayed\?' · 재생':''\)/);
  assert.match(app, /const role=\$\('role-badge'\)\?\.dataset\.role \|\| ''/);
  // A light travelling round the edge, and a colour, so the difference is
  // visible from across the room without reading anything.
  assert.match(styles, /#clock\[data-mode\]:not\(\[data-mode=live\]\)::before\{[^}]*conic-gradient/);
  // Written out rather than the zero-stop shorthand: that masked nothing, and
  // the ring came out as a teal panel over the clock instead of a line round it.
  assert.match(styles, /mask:linear-gradient\(#000,#000\) content-box/);
  assert.doesNotMatch(styles, /#clock\[data-mode[^{]*\]::after/, 'no glow, just the line');
  assert.match(styles, /@keyframes clock-orbit/);
  // The angle of the gradient is what moves. Rotating the element instead spun
  // the whole rounded rectangle like a pinwheel.
  assert.match(styles, /@property --clock-orbit\{syntax:'<angle>'/);
  assert.match(styles, /@keyframes clock-orbit\{to\{--clock-orbit:360deg\}\}/);
  assert.doesNotMatch(styles, /@keyframes clock-orbit\{to\{transform/);
  assert.match(styles, /conic-gradient\(from var\(--clock-orbit\)/);
  // Turning is how the ring says it, so it still turns for somebody who asked
  // for less motion - at less than half the speed.
  assert.match(styles, /prefers-reduced-motion:reduce\)\{#clock\[data-mode\]:not\(\[data-mode=live\]\)::before\{animation-duration:4s\}/);
});

test('each mode rings the clock in the colour it is already known by', () => {
  const styles = readFileSync(new URL('styles.css', web), 'utf8');
  // The same colours the role badge uses, so the ring and the badge under it
  // are plainly the same statement rather than two.
  assert.match(styles, /#clock\[data-mode=scenario\]\{--clock-ring:#7be7ff/);
  assert.match(styles, /#clock\[data-mode=psu\]\{--clock-ring:#7fe9f5/);
  assert.match(styles, /#clock\[data-mode=vertiport\]\{--clock-ring:#7fe0a3/);
  assert.match(styles, /#role-badge\{[^}]*background:#7fe9f5/, 'PSU, the badge\'s own cyan');
  assert.match(styles, /#role-badge\[data-role=vertiport\]\{background:#7fe0a3/, 'and the vertiport green');
  // One ring, drawn from whichever colour the mode set.
  assert.match(styles, /conic-gradient\(from var\(--clock-orbit\),var\(--clock-ring-dim\)/);
  assert.match(styles, /#clock-mode\{[^}]*background:var\(--clock-ring,#7be7ff\)/, 'and the tag matches it');
});

test('the minimised bar and the recording mark are styled', () => {
  assert.match(css, /\.scenario-console\[data-minimised=true\] \.sc-figures/);
  assert.match(css, /\.scenario-console\[data-minimised=true\] \.sc-mini\{display:flex\}/);
  assert.match(css, /\.sc-rec\{[^}]*animation:sc-rec-pulse/);
});

test('a display clock anchored to another day cannot make the console read 702 hours', async () => {
  // A generated plan carries no date, so it is anchored to today; a day loaded
  // before it was anchored to its own. Ticking the console by the difference
  // between the two showed the clock a month into the future.
  const {control} = harness();
  await control.open();
  const midnight = 1789000000;
  control.status = {...STATUS, epoch_time: midnight + 23400, time_s: 23400};

  // The two agree: the clock ticks smoothly between polls, as it should.
  control.displayClock = () => (midnight + 23400 + 1.6) * 1000;
  control.paintClock();
  assert.equal(control.clock.textContent, '06:30:02', 'a second and a half past the poll');

  // Twenty-nine days apart, which is what the operator saw.
  control.displayClock = () => (midnight + 23400 + 29 * 86400) * 1000;
  control.paintClock();
  assert.equal(control.clock.textContent, '06:30:00', 'the status second, not 702:30:00');

  // And a day behind is no better than a day ahead.
  control.displayClock = () => (midnight + 23400 - 29 * 86400) * 1000;
  control.paintClock();
  assert.equal(control.clock.textContent, '06:30:00');

  // The bound is wide enough for any poll and far short of a day.
  assert.ok(MAX_CLOCK_DRIFT_S > 10 && MAX_CLOCK_DRIFT_S < 3600);
  control.stop();
});

test('repeated close sends one command and pauses polling until it finishes', async()=>{
  const releases=[];let calls=0,polls=0;
  const {control,settle}=harness({status:async()=>{polls++;return STATUS;},control:async body=>{
    if(body.action==='close_control'){calls++;await new Promise(resolve=>releases.push(resolve));}
    return STATUS;
  }});
  await control.open();
  const first=control.close(),second=control.close();await settle();
  await control.refresh();
  const count=calls,readCount=polls;
  releases.forEach(resolve=>resolve());await Promise.all([first,second]);
  assert.equal(count,1);assert.equal(readCount,0);
});

test('opening is shared and a close waits for the in-flight open',async()=>{
  const calls=[];let release;
  const {control,settle}=harness({control:async body=>{
    calls.push(body.action);
    if(body.action==='open_control')await new Promise(resolve=>release=resolve);
    return STATUS;
  }});
  const first=control.open(),second=control.open();await settle();
  assert.deepEqual(calls,['open_control']);
  const closed=control.close();await settle();
  assert.deepEqual(calls,['open_control']);
  release();await Promise.all([first,second,closed]);
  assert.deepEqual(calls,['open_control','close_control']);
  assert.equal(control.isOpen,false);
});
