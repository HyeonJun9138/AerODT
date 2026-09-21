// User/Application: how large the map draws its own names — the vertiports and
// the route's waypoints and segments. A wall screen is read from across a room
// and a desk screen from an arm's length, so the size is the operator's to set
// rather than a constant in a layer. The choice belongs to the browser it was
// made in: it is kept in localStorage and applied to the layers, never sent to
// the server, so two people on the same dashboard can each read it their way.
import {buildElement} from './dom_builder.js';

export const STORAGE_KEY = 'aerodt.label-scale';
// Percent of the size the layers were drawn at. The step is small on purpose:
// the request is names that grow a little, not a different map.
export const SCALE_RANGE = {min: 80, max: 200, step: 10, default: 100};

// A stored or typed value as a usable percent, or the default. Anything out of
// range is pulled back into it rather than refused: a bad value in storage
// should not leave the map unreadable.
export function normalizeScale(value, range = SCALE_RANGE) {
  const percent = Math.round(Number(value) / range.step) * range.step;
  if (!Number.isFinite(percent)) return range.default;
  return Math.min(range.max, Math.max(range.min, percent));
}

export function readScale(storage, range = SCALE_RANGE) {
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    return stored === null || stored === undefined ? range.default : normalizeScale(stored, range);
  } catch {return range.default;}   // a browser with site data blocked still shows a map
}

export function writeScale(storage, percent) {
  try {storage?.setItem(STORAGE_KEY, String(percent)); return true;} catch {return false;}
}

// The settings row. `apply(scale)` receives the multiplier the layers take (1
// is the size they were drawn at), once on build and on every change.
export function labelSizeSetting({document, storage, apply = () => {},
  range = SCALE_RANGE, label = '글자 크기', description = '버티포트와 항로 지점 이름의 글자 크기'} = {}) {
  try {storage??=globalThis.localStorage;} catch {}
  const el = (tag, props, ...children) => buildElement(document, tag, props, ...children);
  let percent = readScale(storage, range);
  let manual=false;
  try {manual=storage?.getItem(STORAGE_KEY)!=null;} catch {}
  const readout = el('b', {class: 'setting-value', text: `${percent}%`});
  const input = el('input', {id: 'label-scale', type: 'range', min: String(range.min), max: String(range.max),
    step: String(range.step), value: String(percent), 'aria-label': description});
  input.value = String(percent);
  // The row names the size shortly and says what it is for on hover: the map's
  // own names, not the place names, which are painted into the map tiles.
  const row = el('div', {class: 'setting-row setting-row-range', title: description},
    el('span', {text: label}), input, readout);
  const show = next => {
    percent = normalizeScale(next, range);
    input.value = String(percent);
    readout.textContent = `${percent}%`;
    apply(percent / 100);
  };
  // Dragging shows the size at once; the stored value waits for the drag to end,
  // so a slow write is never in the way of the slider.
  input.oninput = () => {manual=true;show(input.value);};
  input.onchange = () => {manual=true;show(input.value); writeScale(storage, percent);};
  show(percent);
  return {row, input, get percent() {return percent;}, set: show,
    // An automatic screen recommendation is not a saved operator preference.
    // A manual choice, including a drag in progress, always wins on resize.
    recommend(value){if(!manual&&normalizeScale(value,range)!==percent)show(value);}};
}
