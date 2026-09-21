// Personal map choices live in this browser/origin. Acquisition, estimation and
// flight rules still use the shared Library API. Its field descriptions remain
// the authority for available providers and value limits.
const KEY = 'aerodt.map-display.v1';
const FIELDS = {
  terrain: ['enabled', 'provider'],
  imagery: ['provider'],
  buildings: ['enabled', 'provider', 'quality', 'distance', 'opacity', 'tint', 'brightness'],
  clouds: ['enabled', 'product', 'opacity', 'refresh_seconds'],
};
const TOGGLES = new Set(['sunlight', 'place-names']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const valid = (field, value) => {
  if (!field) return false;
  if (field.kind === 'toggle') return typeof value === 'boolean';
  if (field.kind === 'choice') return field.choices?.some(choice => choice.id === value) ?? false;
  return field.kind === 'number' && typeof value === 'number' && Number.isFinite(value)
    && (field.min == null || value >= field.min) && (field.max == null || value <= field.max);
};

export function browserDisplaySettings({api, storage, onStorageError = () => {}}) {
  let warned = false;
  const warn = () => {if (!warned) {warned = true; onStorageError();}};
  try {storage ??= globalThis.localStorage;} catch {warn();}
  let saved;
  try {saved = JSON.parse(storage?.getItem(KEY) || 'null');} catch { /* recover from old/corrupt data */ }
  const sources = object(saved?.sources) ? saved.sources : {};
  const toggles = {};
  for (const id of TOGGLES) if (typeof saved?.toggles?.[id] === 'boolean') toggles[id] = saved.toggles[id];
  let description = null;
  const persist = () => {
    try {
      if (!storage) throw new Error('Storage unavailable');
      storage.setItem(KEY, JSON.stringify({sources, toggles}));
    } catch {warn();} // still usable in memory; never fall back to a shared PUT
  };
  const fieldOf = (id, name) => description?.sources?.find(source => source.id === id)?.fields?.find(field => field.name === name);
  const overlay = raw => {
    description = raw;
    const result = structuredClone(raw);
    result.values ??= {};
    let seeded = false;
    for (const [id, names] of Object.entries(FIELDS)) {
      const values = result.values[id];
      if (!values) continue;
      if (!object(sources[id])) sources[id] = {};
      for (const name of names) {
        const field = fieldOf(id, name);
        if (!field) continue;
        // Adopt legacy server choices once, including untouched fields. A later
        // server read must never silently become this PC's new preferences.
        if (!valid(field, sources[id][name]) && valid(field, values[name])) {
          sources[id][name] = values[name]; seeded = true;
        }
        if (valid(field, sources[id][name])) values[name] = sources[id][name];
      }
      const source = result.sources?.find(source => source.id === id);
      if (source) {
        source.note = `이 브라우저에만 적용 · ${source.note ?? ''}`;
        const provider = fieldOf(id, 'provider')?.choices?.find(choice => choice.id === values.provider);
        if (provider) source.provider = provider.label;
      }
      // The server cannot report whether this browser has rendered a layer.
      const state = result.state?.find(state => state.id === id);
      if (state) {state.status = values.enabled === false ? 'disabled' : 'configured';
        state.message = values.enabled === false ? '이 브라우저에서 숨김' : '이 브라우저 표시 설정 · 지도 상태에서 연결 확인';}
    }
    if (seeded) persist();
    return result;
  };
  return {
    toggle(id, fallback) {return toggles[id] ?? fallback;},
    setToggle(id, value) {
      if (!TOGGLES.has(id) || typeof value !== 'boolean') return false;
      toggles[id] = value; persist(); return true;
    },
    api: {
      ...api,
      async describe() {return overlay(await api.describe());},
      async apply(patch) {
        if (!description) overlay(await api.describe());
        const local = {}, shared = {};
        for (const [id, fields] of Object.entries(patch.sources ?? {})) {
          for (const [name, value] of Object.entries(fields)) {
            const personal = FIELDS[id]?.includes(name);
            if (personal && !valid(fieldOf(id, name), value)) {
              throw Object.assign(new Error('Invalid display preference'), {data: {message: '화면 설정 값이 허용 범위를 벗어났습니다.'}});
            }
            const target = personal ? local : shared;
            (target[id] ??= {})[name] = value;
          }
        }
        // Mixed forms retain the existing shared validation/error contract.
        // Personal changes are committed only after any shared part succeeds.
        const answer = Object.keys(shared).length ? await api.apply({...patch, sources: shared}) : description;
        for (const [id, fields] of Object.entries(local)) sources[id] = {...sources[id], ...fields};
        if (Object.keys(local).length) persist();
        return overlay(answer);
      },
    },
  };
}
