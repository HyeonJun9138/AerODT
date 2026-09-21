// User/Application: the console for a scheduled day.
//
// It drives the clock and reads what the day is doing; it owns neither. Play,
// pause, stop, reset and the speed are asked of the server, and the numbers on
// it are the server's answer. Nothing here works out where an aircraft is, and
// pausing the day is not a hold instruction to anybody: it stops the clock.
//
// The picture and the recording are the exception, because they are of the
// screen rather than of the day: the map hands over its own canvas and this
// asks the browser to save what is on it.
import {buildElement} from '../../../dom_builder.js';

export const SPEEDS = [1, 2, 4, 6, 8, 10];
// How often the console asks what the day is doing. The map is already redrawn
// from the live wire many times a second; this is only the numbers.
export const POLL_MS = 1000;
const STATE_LABEL = {idle: '없음', ready: '준비됨', playing: '진행 중', paused: '일시정지', finished: '종료'};

// How far the display clock may run past the status before it is not the same
// clock at all. A poll is a second or two; anything beyond a few minutes is two
// different days being read as one.
export const MAX_CLOCK_DRIFT_S = 300;

export function clockText(seconds) {
  if (!Number.isFinite(seconds)) return '--:--:--';
  const whole = Math.max(0, Math.round(seconds));
  return [whole / 3600, whole % 3600 / 60, whole % 60]
    .map(part => String(Math.floor(part)).padStart(2, '0')).join(':');
}
// A recording's length as the operator reads it back: minutes and seconds
// while it is short, hours once it is not.
export function elapsedText(milliseconds) {
  const whole = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  const parts = [Math.floor(whole / 60) % 60, whole % 60].map(part => String(part).padStart(2, '0'));
  return whole >= 3600 ? [Math.floor(whole / 3600), ...parts].join(':') : parts.join(':');
}
export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0초';
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}분` : `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}
const count = value => Number(value ?? 0).toLocaleString('ko-KR');

// What the dashboard reads out, in the order an operator scans it. Each is a
// name, how to get the number, and what it is worth saying about it.
export const FIGURES = [
  {id: 'active', label: '운항 중', of: s => count(s.active), note: s => `공중 ${count(s.airborne)}`},
  {id: 'parked', label: '주기', of: s => count(s.parked), note: s => `전체 ${count(s.aircraft)}대`},
  {id: 'holding', label: 'PSU 대기', of: s => count(s.holding), note: s => `누적 ${count(s.psu?.held ?? 0)}건`},
  {id: 'completed', label: '완료', of: s => count(s.flights_completed), note: s => `전체 ${count(s.flights)}편`},
  {id: 'passengers', label: '탑승객', of: s => count(s.passengers_carried), note: () => '현재 기내'},
  {id: 'hold_mean', label: '평균 대기', of: s => duration(s.psu?.hold_seconds_mean), note: s => `최대 ${duration(s.psu?.hold_seconds_max)}`},
];

export class ScenarioControl {
  constructor({api, document = globalThis.document, mount = null, notify = () => {},
    onCapture = null, onRecord = null, onOpen = () => {}, onClose = () => {}, displayClock = () => null,
    onFocusMode = () => {}}) {
    Object.assign(this, {api, document, mount, notify, onCapture, onRecord, onOpen, onClose, onFocusMode});
    this.status = null; this.root = null; this.timer = null; this.busy = false;
    this.recording = false; this.figures = new Map();
    // Minimised, the console is one row under the clock: the map is what the
    // operator came to watch, and the dashboard can be asked for again.
    this.minimised = false; this.recordingFrom = null;
    this.displayClock=displayClock;this.revision=0;this.refreshing=false;
  }
  el(tag, props = {}, ...children) {return buildElement(this.document, tag, props, ...children);}
  button(id, text, onclick, props = {}) {
    return this.el('button', {type: 'button', id, class: 'sc-button', text, onclick, ...props});
  }

  // ---- opening and closing ------------------------------------------------
  open() {
    if(this.closePending)return this.closePending.then(()=>this.open());
    if(this.openPending)return this.openPending;
    if(this.isOpen)return Promise.resolve(this.status);
    const pending=this.openOnce();
    this.openPending=pending;
    const clear=()=>{if(this.openPending===pending)this.openPending=null;};
    pending.then(clear,clear);
    return pending;
  }
  async openOnce() {
    this.closing=false;
    // The twin is handed to the day before the console is drawn, so the map has
    // already switched by the time the operator sees the controls.
    this.notify('ok', '저장된 비행계획으로 전환하는 중입니다...');
    try {
      this.status = await this.api.control({action: 'open_control'});
    } catch (error) {
      this.notify('error', error?.message ?? '컨트롤 패널을 열지 못했습니다.');
      return null;
    }
    this.draw();
    this.start();
    this.onOpen(this.status);
    this.notify('ok', `${this.status.name ?? '비행계획'} · ${count(this.status.flights)}편을 재생할 준비가 되었습니다.`);
    return this.status;
  }
  close() {
    if(this.closePending)return this.closePending;
    const pending=this.closeOnce();
    this.closePending=pending;
    const clear=()=>{if(this.closePending===pending)this.closePending=null;};
    pending.then(clear,clear);
    return pending;
  }
  async closeOnce() {
    this.closing=true;
    this.revision++;
    this.notify('ok','시뮬레이션을 종료하고 운항 기록을 저장하는 중입니다...');
    try {
      await this.openPending;
      await this.pending;
      this.status = await this.api.control({action: 'close_control'});
    } catch (error) {
      this.closing=false;
      this.notify('error', error?.message ?? '시뮬레이션 종료에 실패했습니다. 연결 후 다시 닫아 주세요.');
      return null; // Do not hide a console while the shared simulation still runs.
    }
    this.stop();
    this.stopRecording();
    this.release();
    this.root?.remove(); this.root = null;
    // The day is finished with, not paused: it is thrown away so nothing goes
    // on offering a replay that is over. A failure here is not worth stopping
    // the operator - the console has already gone and the twin is already back
    // on the live clock - so it is reported and the rest carries on.
    if (typeof this.api.unload === 'function') {
      try {
        this.status = await this.api.unload();
      } catch {
        this.notify('warning', '비행계획을 서버에서 내리지 못했습니다. 다시 열면 이전 계획이 남아 있을 수 있습니다.');
      }
    }
    this.onClose(this.status);
    return this.status;
  }
  start() {
    if (this.timer) return;
    this.timer = globalThis.setInterval(() => void this.refresh(), POLL_MS);
    this.timer?.unref?.();
    this.clockTimer=globalThis.setInterval(()=>this.paintClock(),100);
    this.clockTimer?.unref?.();
  }
  stop() {
    if (this.timer) globalThis.clearInterval(this.timer);
    this.timer = null;
    globalThis.clearInterval(this.clockTimer);this.clockTimer=null;
  }
  get isOpen() {return Boolean(this.root);}
  // The instant the twin is actually at, in milliseconds, while a day is being
  // replayed. Null when the twin is on the live clock, so a caller that shows
  // the time can simply fall back to now.
  clockMillis() {
    const epoch = this.status?.epoch_time;
    return this.isOpen && Number.isFinite(epoch) ? (this.displayClock() ?? epoch * 1000) : null;
  }

  paintClock() {
    if(!this.root || !this.status)return;
    // Between polls the clock ticks by how far the twin's own display clock has
    // moved past the instant the status was taken at. That only means anything
    // while the two are anchored to the same day: a generated plan carries no
    // date and is anchored to today, so one left over from a day loaded before
    // it put the two a month apart and the console read 702:30:00. Past a drift
    // no poll could ever explain, the status's own second is the honest answer.
    const shown=this.clockMillis(),epoch=this.status.epoch_time;
    const drift=Number.isFinite(shown) && Number.isFinite(epoch)?shown/1000-epoch:null;
    const seconds=drift!==null && Math.abs(drift)<=MAX_CLOCK_DRIFT_S
      ?this.status.time_s+drift:this.status.time_s;
    const text=Number.isFinite(seconds)?clockText(seconds):(this.status.clock ?? '--:--:--');
    this.clock.textContent=text;
    if(this.miniClock)this.miniClock.textContent=text;
    this.paintRecording();
  }
  // The one thing on the console that is about the screen rather than the day,
  // so it says so plainly: that it is running, and for how long.
  paintRecording() {
    const running=this.recording && Number.isFinite(this.recordingFrom);
    const since=running?elapsedText(Date.now()-this.recordingFrom):'';
    // The badge is the indicator; the button stays a button. Both say the same
    // thing so neither view has to be the one that is trusted.
    if(this.recordBadge){this.recordBadge.hidden=!running;
      this.recordBadge.textContent=running?`● 녹화 중 ${since}`:'';}
    if(this.miniRecordBadge){this.miniRecordBadge.hidden=!running;
      this.miniRecordBadge.textContent=running?`● ${since}`:'';}
    if(this.recordButton){this.recordButton.setAttribute('aria-pressed',String(this.recording));
      this.recordButton.textContent=this.recording?'⏹ 녹화 중':'⏺ 녹화';}
    if(this.miniRecord){this.miniRecord.setAttribute('aria-pressed',String(this.recording));
      this.miniRecord.textContent=this.recording?'⏹':'⏺';}
  }

  async refresh() {
    if(this.closing || this.refreshing || this.busy || !this.root)return;
    this.refreshing=true;const revision=this.revision;
    try {
      const status = await this.api.status();
      if(revision!==this.revision || !this.root)return;
      this.status=status;
    } catch {
      return; // A missed poll is not worth a message; the next one is a second away.
    } finally {
      this.refreshing=false;
    }
    this.paint();
  }

  // ---- the controls -------------------------------------------------------
  // Requests are done one at a time and in the order they were asked for.
  // Dropping the second of two quick presses — a speed and then play — loses a
  // command the operator watched themselves give, which reads as a dead button;
  // sending both at once would let the answers arrive out of order and leave the
  // console showing a state the server has already left.
  async send(body, message) {
    if(this.closing)return null;
    this.revision++; // A late pre-command status response must never undo the command.
    const run = async () => {
      if(this.closing)return null;
      this.busy = true;
      try {
        this.status = await this.api.control(body);
        if (message) this.notify('ok', message);
        this.paint();
        return this.status;
      } catch (error) {
        this.notify('error', error?.message ?? '요청이 실패했습니다.');
        return null;
      } finally {
        this.busy = false;
      }
    };
    this.pending = (this.pending ?? Promise.resolve()).then(run, run);
    return this.pending;
  }
  play() {return this.send({action: 'play'}, '재생을 시작했습니다.');}
  pause() {return this.send({action: 'pause'}, '일시정지했습니다.');}
  // Stopping ends the day and writes what it produced, so it says where it went.
  async stopDay() {
    const answer = await this.send({action: 'stop'});
    if (answer) this.notify('ok', `기록을 저장했습니다 · Library의 다운로드에서 받을 수 있습니다.`);
    return answer;
  }
  async reset() {
    this.stopRecording();
    return this.send({action: 'reset'}, '처음 상태로 되돌렸습니다.');
  }
  setMinimised(minimised) {
    this.minimised = Boolean(minimised);
    this.root?.setAttribute('data-minimised', String(this.minimised));
    this.paint();
    this.measure();
    return this.minimised;
  }
  // One button instead of six. A press asks for the next speed up and the
  // fastest wraps to the slowest; the right button is the way back to real time
  // without hunting for it.
  stepSpeed() {
    const current = this.requestedSpeed ?? this.status?.speed ?? SPEEDS[0];
    const next = SPEEDS[(Math.max(0, SPEEDS.indexOf(current)) + 1) % SPEEDS.length];
    return this.setSpeed(next);
  }
  async setSpeed(speed) {
    if(this.status?.manual_aircraft){this.notify('warning','수동 배정 중에는 ×1 배속을 유지합니다.');return this.status;}
    this.requestedSpeed=speed;this.paint();
    const result=await this.send({speed}, `${speed}배속으로 재생합니다.`);
    if(this.requestedSpeed===speed)this.requestedSpeed=null;
    this.paint();return result;
  }

  // ---- the screen ---------------------------------------------------------
  capture() {
    if (typeof this.onCapture !== 'function') return this.notify('error', '화면을 저장할 수 없습니다.');
    const saved = this.onCapture(this.fileStem() + '.png');
    this.notify(saved === false ? 'error' : 'ok',
      saved === false ? '화면을 저장하지 못했습니다.' : '화면을 저장했습니다.');
  }
  toggleRecording() {
    if (typeof this.onRecord !== 'function') return this.notify('error', '녹화를 시작할 수 없습니다.');
    if (this.recording) return this.stopRecording();
    const started = this.onRecord('start', this.fileStem() + '.webm');
    if (started === false) return this.notify('error', '녹화를 시작하지 못했습니다.');
    this.recording = true; this.recordingFrom = Date.now(); this.paint();
    this.notify('ok', '녹화를 시작했습니다. 다시 누르면 저장됩니다.');
  }
  stopRecording() {
    if (!this.recording) return;
    const kept = Number.isFinite(this.recordingFrom) ? elapsedText(Date.now() - this.recordingFrom) : '';
    this.recording = false; this.recordingFrom = null;
    if (typeof this.onRecord === 'function') this.onRecord('stop', this.fileStem() + '.webm');
    this.paint();
    this.notify('ok', kept ? `녹화를 저장했습니다 · ${kept}` : '녹화를 저장했습니다.');
  }
  fileStem() {
    const clock = (this.status?.clock ?? '').replace(/:/g, '');
    return `aerodt_${this.status?.date ?? 'scenario'}_${clock || 'run'}`;
  }

  // The console draws nothing for this. It only has the one thing the watcher
  // needs -- a poll that says whether the day is loaded and running -- so it
  // passes that on, and the assignment happens without anything to press.
  setManualPanel(panel){this.manualPanel=panel;}

  // ---- drawing ------------------------------------------------------------
  draw() {
    this.root?.remove();
    this.figures = new Map();
    const surface = this.el('div', {class: 'sc-surface glass'},
      this.header(), this.dashboard(), this.transport(),
      this.engineNote=this.el('p',{class:'sc-engine-note',role:'status'}),
      this.compact());
    this.root = this.el('div', {class: 'scenario-console', id: 'scenario-console'}, surface);
    this.root.setAttribute('data-minimised', String(this.minimised));
    (this.mount ?? this.document.body)?.append(this.root);
    // The console holds the line under the target chips while it is open, so
    // whatever else wants that line is told to step down. Its measured height
    // is published for the same reason.
    this.document.body?.setAttribute?.('data-scenario-console', 'true');
    this.measure();
    const Observer = this.document.defaultView?.ResizeObserver;
    if (Observer) {this.observer?.disconnect(); this.observer = new Observer(() => this.measure()); this.observer.observe(surface);}
    this.paint();
    return this.root;
  }
  measure() {
    const height = this.root?.firstElementChild?.getBoundingClientRect?.().height;
    this.document.body?.style?.setProperty?.('--scenario-console-height', `${Math.round(height ?? 0)}px`);
  }
  // Nothing else may sit on that line once the console has gone.
  release() {
    this.observer?.disconnect(); this.observer = null;
    this.document.body?.removeAttribute?.('data-scenario-console');
    this.document.body?.style?.removeProperty?.('--scenario-console-height');
  }
  header() {
    this.clock = this.el('strong', {class: 'sc-clock', id: 'scenario-clock', text: '--:--:--'});
    this.stateChip = this.el('span', {class: 'sc-state', id: 'scenario-state', text: ''});
    this.progressBar = this.el('i', {class: 'sc-progress-fill'});
    this.dayLabel = this.el('span', {class: 'sc-day', text: ''});
    this.recordBadge = this.el('span', {class: 'sc-rec', id: 'scenario-recording', role: 'status'});
    this.recordBadge.hidden = true;
    return this.el('header', {class: 'sc-header'},
      this.el('div', {class: 'sc-identity'},
        this.el('span', {class: 'sc-eyebrow', text: '비행계획 재생'}),
        this.clock, this.dayLabel),
      this.el('div', {class: 'sc-progress'}, this.progressBar),
      this.recordBadge,
      this.stateChip,
      // Watching the day fly is a different job from operating it: this puts
      // every panel away and leaves the map. The round control by the clock
      // brings them back.
      this.button('scenario-focus-mode', '◎ 시야 집중', () => this.onFocusMode(),
        {class: 'sc-button sc-icon', title: '지도만 남기고 모든 창을 숨깁니다 (시계 옆 ◎ 로 해제)'}),
      this.button('scenario-minimise', '최소화', () => this.setMinimised(true),
        {class: 'sc-button sc-minimise', title: '시계 아래 한 줄로 줄입니다'}),
      this.button('scenario-close', '닫기', () => void this.close(), {class: 'sc-button sc-close'}));
  }
  // What is left when the console is minimised: the day's clock, the controls
  // an operator uses while actually watching, and whether it is recording.
  compact() {
    this.miniClock = this.el('strong', {class: 'sc-mini-clock', id: 'scenario-mini-clock', text: '--:--:--'});
    this.miniPlay = this.button('scenario-mini-play', '▶', () => void this.play(),
      {class: 'sc-button sc-icon', title: '재생'});
    this.miniPause = this.button('scenario-mini-pause', '⏸', () => void this.pause(),
      {class: 'sc-button sc-icon', title: '일시정지'});
    this.miniSpeed = this.button('scenario-mini-speed', '×1', () => void this.stepSpeed(),
      {class: 'sc-button sc-mini-speed', title: '누르면 한 단계 빠르게, 오른쪽 버튼은 ×1로'});
    // The right button is the way back to real time. Without swallowing the
    // menu the browser would open one over the map instead.
    this.miniSpeed.oncontextmenu = event => {event?.preventDefault?.(); void this.setSpeed(SPEEDS[0]); return false;};
    this.miniRecord = this.button('scenario-mini-record', '⏺', () => this.toggleRecording(),
      {class: 'sc-button sc-icon', title: '녹화'});
    this.miniRecordBadge = this.el('span', {class: 'sc-rec', id: 'scenario-mini-recording', role: 'status'});
    this.miniRecordBadge.hidden = true;
    return this.el('div', {class: 'sc-mini', id: 'scenario-mini'},
      this.el('span', {class: 'sc-mini-eyebrow', text: 'SIM'}),
      this.miniClock,
      this.miniPlay, this.miniPause, this.miniSpeed,
      this.button('scenario-mini-capture', '📷', () => this.capture(), {class: 'sc-button sc-icon', title: '캡쳐'}),
      this.button('scenario-mini-focus-mode', '◎', () => this.onFocusMode(),
        {class: 'sc-button sc-icon', title: '시야 집중 모드 — 지도만 남깁니다'}),
      this.miniRecord, this.miniRecordBadge,
      this.button('scenario-restore', '펼치기', () => this.setMinimised(false), {class: 'sc-button sc-minimise'}),
      this.button('scenario-mini-close', '닫기', () => void this.close(), {class: 'sc-button sc-close'}));
  }
  dashboard() {
    const list = this.el('div', {class: 'sc-figures', id: 'scenario-figures'});
    for (const figure of FIGURES) {
      const value = this.el('strong', {text: '-'});
      const note = this.el('small', {text: ''});
      list.append(this.el('div', {class: 'sc-figure', 'data-id': figure.id},
        this.el('span', {class: 'sc-figure-label', text: figure.label}), value, note));
      this.figures.set(figure.id, {value, note, figure});
    }
    return list;
  }
  transport() {
    this.playButton = this.button('scenario-play', '▶ 재생', () => void this.play());
    this.pauseButton = this.button('scenario-pause', '⏸ 일시정지', () => void this.pause());
    this.speedButtons = new Map();
    const speeds = this.el('div', {class: 'sc-speeds', role: 'group', 'aria-label': '배속'});
    for (const speed of SPEEDS) {
      const button = this.button(`scenario-speed-${speed}`, `×${speed}`, () => void this.setSpeed(speed),
        {class: 'sc-button sc-speed'});
      this.speedButtons.set(speed, button);
      speeds.append(button);
    }
    this.recordButton = this.button('scenario-record', '⏺ 녹화', () => this.toggleRecording(),
      {class: 'sc-button sc-icon'});
    return this.el('div', {class: 'sc-transport'},
      this.el('div', {class: 'sc-transport-group'}, this.playButton, this.pauseButton,
        this.button('scenario-stop', '⏹ 중지', () => void this.stopDay()),
        this.button('scenario-reset', '↺ 초기화', () => void this.reset())),
      speeds,
      this.el('div', {class: 'sc-transport-group'},
        this.button('scenario-capture', '📷 캡쳐', () => this.capture(), {class: 'sc-button sc-icon'}),
        this.recordButton));
  }

  paint() {
    // The day moves under the assignment panel: flights become due, and one
    // taken on another screen is taken here too.
    this.manualPanel?.tick(this.status);
    const status = this.status;
    if (!this.root || !status) return;
    this.paintClock();
    this.dayLabel.textContent = [status.date, status.name].filter(Boolean).join(' · ');
    this.stateChip.textContent = STATE_LABEL[status.state] ?? status.state ?? '';
    this.stateChip.setAttribute('data-state', status.state ?? 'idle');
    this.progressBar.style.width = `${Math.round((status.progress ?? 0) * 100)}%`;
    for (const [, held] of this.figures) {
      held.value.textContent = held.figure.of(status);
      held.note.textContent = held.figure.note(status);
    }
    const playing = status.state === 'playing';
    this.playButton.textContent = playing ? '▶ 재생 중' : '▶ 재생';
    this.playButton.disabled = playing || status.state === 'finished' || Boolean(status.pilot_failures);
    this.engineNote.textContent=status.pilot_failures?`물리 비행 오류 ${status.pilot_failures}대 · 일시정지됨. 초기화가 필요합니다.`:
      (status.flight_engine==='native-fastphysics-simpleflight'?'FastPhysics + SimpleFlight · 기체별 조종사 · 순항 우측 30 m (충돌 보장 아님)':'운동학 연습');
    this.pauseButton.disabled = !playing;
    for (const [speed, button] of this.speedButtons) {
      button.disabled=Boolean(status.manual_aircraft);
      button.setAttribute('aria-pressed', String(speed === status.speed));
      button.setAttribute('aria-busy',String(speed===this.requestedSpeed));
      button.textContent=`×${speed}${speed===this.requestedSpeed?' …':''}`;
    }
    if (this.miniPlay) {
      this.miniPlay.disabled = this.playButton.disabled;
      this.miniPause.disabled = this.pauseButton.disabled;
      const speed = this.requestedSpeed ?? status.speed ?? SPEEDS[0];
      this.miniSpeed.textContent = `×${speed}${this.requestedSpeed ? ' …' : ''}`;
      this.miniSpeed.disabled=Boolean(status.manual_aircraft);
      this.miniSpeed.title=status.manual_aircraft?'수동 배정 중 ×1 고정':'재생 배속 변경';
      this.miniSpeed.setAttribute('aria-busy', String(Boolean(this.requestedSpeed)));
    }
    this.paintRecording();
    this.root.setAttribute('data-state', status.state ?? 'idle');
    this.root.setAttribute('data-recording', String(this.recording));
    this.root.setAttribute('data-minimised', String(this.minimised));
  }
  destroy() {
    this.closing=true;
    this.revision++;
    this.stop();
    this.stopRecording();
    this.release();
    this.root?.remove();
    this.root = null;
  }
}
