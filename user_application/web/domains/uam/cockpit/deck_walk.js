import {WalkCamera, doorStep, eastScale} from '/visualization/walk_camera.js';

// Being the person rather than the aircraft.
//
// The server owns whether the pilot is out: `ground_handling.crew_outside` is
// the one answer, and it is only true while a procedure is live and charging.
// This watches that flag and makes the view agree with it -- out of the seat
// and onto the deck, back into the seat when it clears -- rather than keeping a
// second idea of where the operator is. An aircraft that strays ends its
// procedure, so the flag drops and the camera comes back on its own; there is
// no case where the page is walking around beside an aircraft that has gone.
//
// Keys rather than a stick. A person is not flying, and the one thing a pilot
// already has their hands on is the keyboard.
const MOVE = {KeyW: ['forward', 1], KeyS: ['forward', -1], KeyA: ['strafe', -1], KeyD: ['strafe', 1],
  ArrowUp: ['pitch', 1], ArrowDown: ['pitch', -1], ArrowLeft: ['turn', -1], ArrowRight: ['turn', 1]};
const BOARD_KEY = 'KeyE';
export const BOARDING_RADIUS_M = 2;
const METRES_PER_DEGREE = 111320;
// How often the terminal asks the day what it is doing. The board is read
// by a person standing still, so a couple of seconds is as live as it needs
// to be -- and the answer carries the whole deck, so this is one request.
const LIFE_MS = 2500;

export class DeckWalk {
  constructor({globe, window: view = globalThis, readGround = () => null, readSample = () => null,
      readDecks = () => [], onBoard = () => {}, notify = () => {},
      showTerminal = () => false, readLife = null, showLife = () => 0} = {}) {
    Object.assign(this, {globe, window: view, readGround, readSample, readDecks, onBoard, notify,
      showTerminal, readLife, showLife});
    this.lifeAt = -Infinity; this.lifePending = false;
    this.camera = new WalkCamera({viewer: globe?.viewer, C: globe?.C});
    this.keys = new Set(); this.last = null; this.outside = false;
    // Which deck the operator is standing on, and which floor of it. The
    // interior is stood up while they are there rather than while they are in
    // it: the moment worth paying for geometry is the one they are standing
    // still in, not the one they are walking through a door in.
    this.port = null; this.level = 0;
    this.onKey = event => this.key(event, true);
    this.offKey = event => this.key(event, false);
    this.onBlur = () => this.keys.clear();
    view.addEventListener?.('keydown', this.onKey);
    view.addEventListener?.('keyup', this.offKey);
    view.addEventListener?.('blur', this.onBlur);
  }

  get walking() {return this.camera.active;}

  key(event, down) {
    if (!this.camera.active) return;
    const code = event?.code;
    if (down && code === BOARD_KEY) {event.preventDefault?.(); this.board(); return;}
    if (!MOVE[code] && code !== 'ShiftLeft' && code !== 'ShiftRight') return;
    event.preventDefault?.();
    if (down) this.keys.add(code); else this.keys.delete(code);
  }

  /** Board only from the aircraft door. Walking is presentation state, so the
   *  browser owns this small spatial interaction while the server remains the
   *  owner of whether the crew is actually outside and accepts crew_in. */
  board() {
    const pose = this.camera.pose;
    if (!this.camera.active || !pose) return false;
    const ground = this.readGround() ?? {};
    const door = doorStep(this.readSample(), ground.crew_door_m ?? {}, this.readDecks() ?? []);
    if (!door) {this.notify('기체 출입문 위치를 확인할 수 없습니다'); return false;}
    if ((pose.level ?? 0) !== (door.level ?? 0)) {
      this.notify('데크로 올라가 기체 출입문 가까이에서 E를 누르세요');
      return false;
    }
    const north = (pose.latitude - door.latitude) * METRES_PER_DEGREE;
    const east = (pose.longitude - door.longitude) * eastScale((pose.latitude + door.latitude) / 2);
    const distance = Math.hypot(north, east);
    if (distance > BOARDING_RADIUS_M) {
      this.notify(`기체 출입문까지 ${distance.toFixed(1)} m · 가까이 이동한 뒤 E를 누르세요`);
      return false;
    }
    this.onBoard();
    return true;
  }

  input() {
    const held = {forward: 0, strafe: 0, turn: 0, pitch: 0};
    for (const code of this.keys) {
      const move = MOVE[code];
      if (move) held[move[0]] += move[1];
    }
    return {...held, run: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')};
  }

  /** Called every frame. Answers whether the view is currently on foot. */
  sync(now) {
    const ground = this.readGround() ?? {};
    const outside = Boolean(ground.crew_outside);
    if (outside !== this.outside) {
      this.outside = outside;
      if (outside) this.stand(ground); else this.sit();
    }
    if (!this.camera.active) {this.last = null; return false;}
    const seconds = this.last == null ? 0 : (now - this.last) / 1000;
    this.last = now;
    const before = this.level;
    this.camera.step(seconds, this.input());
    this.life(now);
    this.level = this.camera.pose?.level ?? 0;
    if (this.level !== before) this.notify(this.level < 0
      ? '터미널 층입니다 · 계단으로 데크에 올라갑니다'
      : '데크로 올라왔습니다 · E 탑승');
    return true;
  }

  stand(ground) {
    const decks = this.readDecks() ?? [];
    const at = doorStep(this.readSample(), ground.crew_door_m ?? {}, decks);
    if (!at) {this.notify('내려설 데크를 찾지 못했습니다'); return false;}
    // The cockpit keeps the camera while it is active, so it has to let go
    // first -- and it is let go of without restoring its saved pose, because
    // the pose we want next is the one beside the door.
    this.globe?.cockpit?.exit?.(false, true);
    if (!this.camera.enter(at, decks)) {this.notify('내려설 데크를 찾지 못했습니다'); return false;}
    this.keys.clear(); this.last = null;
    this.port = at.deck ?? null; this.level = at.level ?? 0;
    this.showTerminal(this.port, true);
    this.lifeAt = -Infinity;
    this.notify('데크에 내렸습니다 · W A S D 이동 · 화살표 둘러보기 · E 탑승');
    return true;
  }

  sit() {
    if (!this.camera.active) return false;
    this.camera.exit();
    this.keys.clear(); this.last = null;
    if (this.port) this.showTerminal(this.port, false);
    this.port = null; this.level = 0; this.lifeAt = -Infinity;
    return true;
  }

  /** Ask the day what this deck is doing, no oftener than it can change usefully. */
  life(now) {
    if (!this.readLife || !this.port || this.lifePending) return false;
    if (now - this.lifeAt < LIFE_MS) return false;
    // Stamped before the answer, not after: a slow reply must not queue up
    // a second request behind it and then a third.
    this.lifeAt = now; this.lifePending = true;
    const port = this.port;
    Promise.resolve(this.readLife(port))
      .then(answer => {
        // The operator may have boarded while the answer was in flight.
        if (this.port === port) this.showLife(port, answer?.board ?? null, answer?.board?.waiting ?? {});
      })
      .catch(() => {})
      .finally(() => {this.lifePending = false;});
    return true;
  }

  destroy() {
    this.sit();
    this.window.removeEventListener?.('keydown', this.onKey);
    this.window.removeEventListener?.('keyup', this.offKey);
    this.window.removeEventListener?.('blur', this.onBlur);
  }
}
