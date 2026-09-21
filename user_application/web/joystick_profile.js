// What a stick's raw numbers mean, kept apart from the panel that shows them
// and the input that polls them. A gamepad reports bare axis and button
// indices; which one is roll and which is the throttle is the operator's
// decision, so it is data here rather than a constant anywhere else.
const KEY = 'aerodt.joystick.v1';
export const VERSION = 1;

// The four the flight command needs. `throttle` is a lever, not a stick: it
// reports where it is rather than which way it was pushed, so it is shaped
// differently from the three that spring back to centre.
export const AXIS_FUNCTIONS = [
  ['roll', '롤 · 좌우 기울기'],
  ['pitch', '피치 · 앞뒤 기울기'],
  ['yaw', '요 · 기수 회전'],
  ['throttle', '스로틀 · 출력'],
];

// What a button may be made to do. `precision` is held rather than pressed --
// it is the stick's equivalent of leaning on Shift.
export const BUTTON_ACTIONS = [
  ['none', '없음'],
  ['mode_multirotor', '멀티로터 모드'],
  ['mode_fixed_wing', '고정익 모드'],
  ['mode_toggle', '비행 모드 전환'],
  ['view_up', '시야 위 (누르는 동안)'],
  ['view_down', '시야 아래 (누르는 동안)'],
  ['view_left', '시야 왼쪽 (누르는 동안)'],
  ['view_right', '시야 오른쪽 (누르는 동안)'],
  ['view_reset', '시야 초기화'],
  ['view_zoom_in', '시야 확대'],
  ['view_zoom_out', '시야 축소'],
  ['precision', '미세 조종 (누르는 동안)'],
  ['hold_altitude', '고도 유지 켜기 · 끄기'],
  ['hold_position', '위치 유지 켜기 · 끄기'],
  ['hold_off', '유지 해제'],
  ['pause', '일시정지 · 재개'],
];
export const HELD_ACTIONS = new Set(['view_up','view_down','view_left','view_right','precision', 'view_zoom_in', 'view_zoom_out']);

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);

export function defaultProfile(deviceId = '') {
  return {
    version: VERSION,
    deviceId,
    axes: {
      roll: {axis: 0, invert: false, deadzone: 0.06, expo: 0.3, stability: 0.25},
      pitch: {axis: 1, invert: false, deadzone: 0.06, expo: 0.3, stability: 0.25},
      // Yaw is the twitchy one on most sticks: it is usually a twist or a
      // rocker with a short throw and a noisier sensor than the main gimbal,
      // so the same dither is a larger fraction of its travel. It starts with
      // more help than the other two and can be turned down.
      yaw: {axis: 2, invert: false, deadzone: 0.1, expo: 0.3, stability: 0.55},
      // A lever usually reports -1 pushed forward, so full travel reads as
      // zero output until it is inverted. Ends trimmed by the deadzone so a
      // stick that stops short of its stops can still reach 0% and 100%.
      throttle: {axis: 3, invert: true, deadzone: 0.04, expo: 0, absolute: true, stability: 0.2},
    },
    // The thumb switch on the head of the stick. Chrome reports it either as
    // the four standard d-pad buttons or, when it is a small analogue stick,
    // as a pair of axes. Both are here because both exist on real hardware,
    // and 자동 감지 in the setup window picks whichever the operator moves.
    view: {kind: 'buttons', buttons: [12, 13, 14, 15], axes: [4, 5], speed: 1, invertY: false, deadzone: 0.2},
    buttons: {0: 'mode_multirotor', 1: 'mode_fixed_wing', 2: 'view_reset', 5: 'precision'},
  };
}

// A stored profile is whatever was in the browser last time, which may predate
// any field added since. Every value is taken back through its own bounds so a
// half-written or hand-edited entry cannot produce an axis that never centres.
export function normaliseProfile(value, deviceId = '') {
  const base = defaultProfile(deviceId);
  if (!value || typeof value !== 'object') return base;
  const axes = {};
  for (const [name] of AXIS_FUNCTIONS) {
    const stored = value.axes?.[name] ?? {};
    const fallback = base.axes[name];
    const index = Number.isInteger(stored.axis) && stored.axis >= 0 && stored.axis < 32 ? stored.axis : fallback.axis;
    axes[name] = {
      axis: stored.axis === null ? null : index,
      invert: Boolean(stored.invert ?? fallback.invert),
      deadzone: clamp(finite(stored.deadzone, fallback.deadzone), 0, 0.5),
      expo: clamp(finite(stored.expo, fallback.expo), 0, 1),
      stability: clamp(finite(stored.stability, fallback.stability), 0, 1),
    };
    if (name === 'throttle') axes[name].absolute = stored.absolute === undefined ? true : Boolean(stored.absolute);
  }
  const view = value.view ?? {};
  const kind = ['buttons', 'axes', 'hat', 'none'].includes(view.kind) ? view.kind : base.view.kind;
  const indices = (list, fallbackList) =>
    Array.isArray(list) && list.length === fallbackList.length && list.every(i => Number.isInteger(i) && i >= 0 && i < 32)
      ? [...list] : [...fallbackList];
  const buttons = {};
  for (const [index, action] of Object.entries(value.buttons ?? {})) {
    const slot = Number(index);
    if (!Number.isInteger(slot) || slot < 0 || slot >= 32) continue;
    if (BUTTON_ACTIONS.some(([id]) => id === action) && action !== 'none') buttons[slot] = action;
  }
  return {
    version: VERSION,
    deviceId: typeof value.deviceId === 'string' ? value.deviceId : deviceId,
    axes,
    view: {
      kind,
      hat: {axis:Number.isInteger(view.hat?.axis)?clamp(view.hat.axis,0,31):9,neutral:finite(view.hat?.neutral,3.285714),values:Array.isArray(view.hat?.values)&&view.hat.values.length===4&&view.hat.values.every(Number.isFinite)?[...view.hat.values]:[-1,1/7,5/7,-3/7]},
      buttons: indices(view.buttons, base.view.buttons),
      axes: indices(view.axes, base.view.axes),
      speed: clamp(finite(view.speed, base.view.speed), 0.1, 4),
      invertY: Boolean(view.invertY),
      deadzone: clamp(finite(view.deadzone, base.view.deadzone), 0, 0.8),
    },
    buttons: Object.keys(buttons).length || value.buttons ? buttons : {...base.buttons},
  };
}

// A device is remembered by the name the browser gives it, so two sticks on
// one machine keep their own tuning and plugging the same one back in finds it.
const slot = deviceId => (deviceId ? String(deviceId).slice(0, 120) : 'default');

export function loadProfile(deviceId = '', storage) {
  try {storage ??= globalThis.localStorage;} catch {}
  let stored;
  try {stored = JSON.parse(storage?.getItem(KEY) || 'null');} catch {}
  return normaliseProfile(stored?.[slot(deviceId)], deviceId);
}

export function saveProfile(profile, storage) {
  try {storage ??= globalThis.localStorage;} catch {}
  const clean = normaliseProfile(profile, profile?.deviceId ?? '');
  let stored;
  try {stored = JSON.parse(storage?.getItem(KEY) || 'null');} catch {}
  const next = stored && typeof stored === 'object' ? stored : {};
  next[slot(clean.deviceId)] = clean;
  try {storage?.setItem(KEY, JSON.stringify(next));} catch {}
  return clean;
}

export function forgetProfile(deviceId = '', storage) {
  try {storage ??= globalThis.localStorage;} catch {}
  let stored;
  try {stored = JSON.parse(storage?.getItem(KEY) || 'null');} catch {}
  if (!stored || typeof stored !== 'object') return;
  delete stored[slot(deviceId)];
  try {storage?.setItem(KEY, JSON.stringify(stored));} catch {}
}

// Centre-springing axis: nothing inside the deadzone, and a soft middle so
// small corrections are small. Full travel still reaches the full range --
// expo bends the curve, it does not shorten it.
export function shapeCentred(raw, {deadzone = 0, expo = 0, invert = false} = {}) {
  let value = clamp(finite(raw), -1, 1) * (invert ? -1 : 1);
  const magnitude = Math.abs(value);
  if (magnitude <= deadzone) return 0;
  const scaled = (magnitude - deadzone) / Math.max(1e-6, 1 - deadzone);
  return Math.sign(value) * clamp((1 - expo) * scaled + expo * scaled ** 3, 0, 1);
}

// Lever: where it sits, as 0 to 1. The deadzone trims both ends instead of the
// middle, because a lever that stops short of its stop should still command
// idle and full rather than 3% and 97%.
export function shapeLever(raw, {deadzone = 0, expo = 0, invert = false} = {}) {
  const value = clamp(finite(raw), -1, 1) * (invert ? -1 : 1);
  const span = Math.max(1e-6, 1 - deadzone * 2);
  const travel = clamp((value + 1) / 2, 0, 1);
  const trimmed = clamp((travel - deadzone) / span, 0, 1);
  return expo ? clamp((1 - expo) * trimmed + expo * trimmed ** 2, 0, 1) : trimmed;
}

// One knob, because an operator has one complaint: it is shaky.
//
// It drives a speed-adaptive low-pass -- the "one euro" filter. At rest it
// filters hard, so sensor dither disappears; the faster the stick is actually
// moving, the less it filters, so a real push is not delayed. Both halves are
// needed. A plain low-pass slows the shaking down instead of removing it, and
// a dead band buys stillness with resolution: measured, a band wide enough to
// sit still against a +-3% sensor also swallowed every change smaller than 6%
// of travel, and, compared against its own output, swallowed the last few
// percent of a real push so the stick topped out short of its own stop.
export function stabilityBand(stability) {
  const amount = clamp(finite(stability, 0), 0, 1);
  // Swept against dithering sensors rather than chosen by taste. The cutoff
  // runs geometrically from 5.5 Hz (barely filtered) down to 0.4 Hz, because
  // the useful range is all at the quiet end; beta is what buys the response
  // time back, and it costs almost no stillness to raise it.
  return amount ? {minCutoff: 5.5 * (0.4 / 5.5) ** amount, beta: 0.1 + 1.1 * amount} : {minCutoff: 0, beta: 0};
}

const lowpass = (previous, value, alpha) => previous + alpha * (value - previous);
const alphaOf = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

// Where an axis settles, given its state and what the stick now reads. Pure:
// the caller keeps the state and passes the time since, because the send tick
// stretches on a busy frame and a fixed step would steady it unevenly.
export function settle(state, target, {minCutoff = 0, beta = 0} = {}, dt = 1 / 60) {
  const previous = state && typeof state === 'object' ? state : null;
  if (!Number.isFinite(target)) return previous ?? {x: 0, dx: 0, value: 0};
  // Exactly zero means the deadzone has already decided there is no input.
  // Filtering that would leave the aircraft turning after the stick was let go.
  if (target === 0) return {x: 0, dx: 0, value: 0};
  if (!previous || !(minCutoff > 0)) return {x: target, dx: 0, value: target};
  const step = Math.max(1e-4, finite(dt, 1 / 60));
  // Speed first: how fast it is really moving decides how much the position is
  // allowed to be filtered.
  const dx = lowpass(previous.dx, (target - previous.x) / step, alphaOf(1, step));
  const value = lowpass(previous.value, target, alphaOf(minCutoff + beta * Math.abs(dx), step));
  // A filter approaches without arriving. Close enough is arrival: a stop has
  // to be a stop, and the remainder is arithmetic rather than a command.
  return {x: target, dx, value: Math.abs(target - value) < 1e-3 ? target : value};
}

const axisValue = (pad, index) => (Number.isInteger(index) && index >= 0 ? finite(pad?.axes?.[index]) : 0);
const buttonValue = (pad, index) => {
  const button = Number.isInteger(index) && index >= 0 ? pad?.buttons?.[index] : undefined;
  if (button === undefined || button === null) return 0;
  return typeof button === 'object' ? (button.pressed ? 1 : finite(button.value)) : finite(button);
};

// Which way the head switch is pushed, as -1..1 on each axis regardless of
// whether the hardware calls it four buttons or two axes.
export function readView(pad, view) {
  if (!view || view.kind === 'none') return {x: 0, y: 0};
  if(view.kind==='hat'){
    const h=view.hat;if(!h||!Array.isArray(h.values)||!Number.isFinite(pad?.axes?.[h.axis]))return {x:0,y:0};
    const raw=axisValue(pad,h.axis),[up,down,left,right]=h.values;
    if(Math.abs(raw-h.neutral)<.06||Math.abs(right-up)<.01)return {x:0,y:0};
    const angle=(raw-up)/(right-up)*Math.PI/2;
    return {x:Math.abs(Math.sin(angle))<.05?0:Math.sin(angle),y:(Math.abs(Math.cos(angle))<.05?0:-Math.cos(angle))*(view.invertY?-1:1)};
  }
  if (view.kind === 'axes') {
    const shape = {deadzone: view.deadzone ?? 0.2, expo: 0};
    return {x: shapeCentred(axisValue(pad, view.axes?.[0]), shape),
      y: shapeCentred(axisValue(pad, view.axes?.[1]), shape) * (view.invertY ? -1 : 1)};
  }
  const [up, down, left, right] = view.buttons ?? [];
  const pressed = index => (buttonValue(pad, index) > 0.5 ? 1 : 0);
  return {x: pressed(right) - pressed(left),
    y: (pressed(down) - pressed(up)) * (view.invertY ? -1 : 1)};
}

// One reading of the device against one profile. Pure: the caller keeps the
// previous reading and gets told what changed, so nothing here has to remember
// anything between frames.
export function mapPad(pad, profile, previous = null, dt = 1 / 60) {
  const axes = {}, settled = {};
  for (const [name] of AXIS_FUNCTIONS) {
    const binding = profile?.axes?.[name];
    const raw = axisValue(pad, binding?.axis);
    const shaped = name === 'throttle' && binding?.absolute !== false
      ? shapeLever(raw, binding) : shapeCentred(raw, binding);
    // Steadying comes after shaping, so the deadzone and the curve are what is
    // being steadied -- filtering the raw axis first would smear the deadzone
    // edge and let dither leak back through it.
    const state = settle(previous?.settled?.[name], shaped, stabilityBand(binding?.stability), dt);
    settled[name] = state;
    axes[name] = state.value;
  }
  const down = new Set();
  const entries = Object.entries(profile?.buttons ?? {});
  for (const [index] of entries) if (buttonValue(pad, Number(index)) > 0.5) down.add(Number(index));
  const held = new Set();
  const pressed = [];
  for (const [index, action] of entries) {
    const slotIndex = Number(index);
    if (!down.has(slotIndex)) continue;
    if (HELD_ACTIONS.has(action)) {held.add(action); continue;}
    // Edge only: a mode button leant on must not re-fire every frame.
    if (!previous?.down?.has(slotIndex)) pressed.push(action);
  }
  return {axes, settled, view: readView(pad, profile?.view), down, held, pressed,
    connected: Boolean(pad?.connected ?? pad)};
}

// The live picture the setup window draws, and the source of 자동 감지: the
// index that moved furthest from where it started, or the button now down.
export function movedAxis(pad, rest, threshold = 0.45) {
  let best = null;
  const list = pad?.axes ?? [];
  for (let index = 0; index < list.length; index += 1) {
    const change = Math.abs(finite(list[index]) - finite(rest?.[index]));
    if (change >= threshold && (!best || change > best.change)) best = {index, change};
  }
  return best?.index ?? null;
}

export function pressedButton(pad) {
  const list = pad?.buttons ?? [];
  for (let index = 0; index < list.length; index += 1) if (buttonValue(pad, index) > 0.5) return index;
  return null;
}
