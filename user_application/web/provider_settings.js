// User/Application: which provider draws a map layer — the imagery over Korea,
// the buildings. The choice is kept in this browser's display preferences.
// The Library API describes the available choices. This row shows them and
// hands the pick back; it never decides what the choices are.
import {buildElement} from './dom_builder.js';

export function providerSetting({document, id, label, description = label, apply = () => {}} = {}) {
  const el = (tag, props, ...children) => buildElement(document, tag, props, ...children);
  const select = el('select', {id, 'aria-label': description, disabled: ''});
  select.disabled = true;
  const row = el('div', {class: 'setting-row setting-row-select', title: description}, el('span', {text: label}), select);
  let current = null;
  const setChoices = (choices = [], value = null) => {
    select.replaceChildren(...choices.map(choice => {
      const option = el('option', {value: choice.id, text: choice.label, title: choice.note || undefined});
      if (choice.id === value) option.setAttribute('selected', '');
      return option;
    }));
    current = choices.some(choice => choice.id === value) ? value : choices[0]?.id ?? null;
    if (current !== null) select.value = current;
    select.disabled = choices.length === 0;
    if (select.disabled) select.setAttribute('disabled', ''); else select.removeAttribute('disabled');
  };
  select.onchange = () => {
    if (select.value === current) return;
    const previous = current;
    current = select.value;
    Promise.resolve(apply(current)).then(ok => {
      // A refused change goes back to the last accepted preference.
      if (ok === false) {current = previous; if (previous !== null) select.value = previous;}
    });
  };
  return {row, select, setChoices, get value() {return current;}};
}
