// User/Application: a setting the operator drags rather than picks from a list.
//
// Some map settings have no natural steps. How see-through the buildings are is
// one: an operator wants "a bit less than that", not one of four numbers
// somebody chose. A slider says that in one gesture and shows the answer while
// the hand is still moving.
//
// Like the provider rows, the value belongs to the dashboard rather than to the
// browser: it is written to the Library on the server so every screen of the
// same dashboard draws the map the same way. Dragging repaints at once and the
// server hears about it when the drag ends, so a slow write is never in the way
// of the slider.
import {buildElement} from './dom_builder.js';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// The value as one of the slider's own steps, or the default. Anything out of
// range is pulled into it rather than refused: a bad stored value should not
// leave the map unreadable.
export function normalize(value, {min, max, step, fallback}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const stepped = Math.round((number - min) / step) * step + min;
  // Steps of 0.05 do not land on exact binary fractions; the rounding keeps the
  // value comparable to what was sent, so a redraw does not look like a change.
  return Number(clamp(stepped, min, max).toFixed(6));
}

export function sliderSetting({document, id, label, description = label,
  min = 0, max = 1, step = 0.05, fallback = max, format = value => String(value),
  apply = () => {}} = {}) {
  const el = (tag, props, ...children) => buildElement(document, tag, props, ...children);
  let current = fallback;
  const input = el('input', {type: 'range', id, min: String(min), max: String(max), step: String(step),
    value: String(current), 'aria-label': description, disabled: ''});
  input.disabled = true;
  const readout = el('b', {class: 'setting-value', text: format(current)});
  const row = el('div', {class: 'setting-row setting-row-range', title: description},
    el('span', {text: label}), input, readout);

  // What the row shows, without telling anybody: for the first value the server
  // describes, and for putting a refused change back.
  const show = value => {
    current = normalize(value, {min, max, step, fallback});
    input.value = String(current);
    readout.textContent = format(current);
    return current;
  };
  const setValue = value => {
    show(value);
    input.disabled = false;
    input.removeAttribute('disabled');
    return current;
  };
  // Dragging is a preview: it paints but does not write. Letting go is the
  // decision, and that is what the server is told.
  input.oninput = () => {const value = show(input.value); apply(value, {live: true});};
  input.onchange = () => {
    const previous = current;
    const value = show(input.value);
    Promise.resolve(apply(value, {live: false})).then(ok => {
      if (ok === false) show(previous);
    });
  };
  return {row, input, setValue, get value() {return current;}};
}
