// User/Application: the numbers behind the multi-flight setup, kept apart from
// the form that collects them. Nothing here touches the DOM or the map, so what
// the generator is asked for can be worked out — and tested — on its own.
//
// This module decides nothing about the flights themselves. It only says which
// vertiports are in scope, which pairs may carry demand, how much demand there
// is in a day, when the day runs, which seed draws it and what stands on the
// decks at the start. Turning that into schedules is the generator's work.

// 서울시 1일 총 통행량, 그 가운데 UAM으로 옮겨오는 비율.
export const SEOUL_DAILY_TRIPS = 13500000;
export const DEFAULT_CONVERSION_PCT = 0.5;
// 전환률을 쓰지 않을 때 직접 넣는 하루 이용객 수.
export const DEFAULT_DAILY_RIDERS = 10000;
export const DEFAULT_START = '06:30';
export const DEFAULT_END = '21:30';
// A deck holds a mix, not one kind of aircraft: a vertiport can start the day
// with two four-seaters and a six. These are the sizes a stand is planned for.
export const SEAT_CLASSES = [{id: 'seat4', label: '4인', seats: 4}, {id: 'seat6', label: '6인', seats: 6},
  {id: 'seat8', label: '8인', seats: 8}];
export const SEAT_IDS = SEAT_CLASSES.map(item => item.id);
// What fills the decks when the operator has not said otherwise. Spreading the
// sizes is the honest default: a fleet of one cabin size answers the day's
// demand with one shape of answer, and a rehearsal that only ever has four
// seats to offer cannot show what a six or an eight would have carried. One
// size is still there for anyone who wants it - it is a choice, not an
// oversight, and it should read as one.
export const EVEN_MIX = 'even';
export const DEFAULT_SEAT_CLASS = EVEN_MIX;
export const SEAT_CHOICES = [[EVEN_MIX, '고르게 섞기'],
                             ...SEAT_CLASSES.map(item => [item.id, `${item.label}승만`])];
export const EMPTY_MIX = Object.freeze(Object.fromEntries(SEAT_IDS.map(id => [id, 0])));
// 게이트에 어떻게 채울지: 전부 / 버티포트마다 같은 대수 / 배치 안 함.
export const FILL_MODES = [['all', '모든 게이트'], ['count', '버티포트당 지정'], ['none', '배치 안 함']];

// How much of the day's demand belongs to each deck. 100 is an average deck;
// the reference shares we were given are converted to this scale on the server
// and arrive as the defaults. Ten per cent steps, because the third significant
// figure of a demand forecast is not something anybody should be adjusting.
export const DEFAULT_WEIGHT = 100;
export const WEIGHT_STEP = 10;
export const WEIGHT_MIN = 0;
export const WEIGHT_MAX = 300;
export const DIRECTIONS = [['departure', '출발'], ['arrival', '도착']];
export const DIRECTION_IDS = DIRECTIONS.map(([id]) => id);

export function seatsOf(id) {return SEAT_CLASSES.find(item => item.id === id)?.seats ?? 0;}
export function seatLabel(id) {return SEAT_CLASSES.find(item => item.id === id)?.label ?? id;}

export function defaultState() {
  return {
    scope: [],
    excluded: [], broken: [],
    demand: {mode: 'baseline', baseline: SEOUL_DAILY_TRIPS, conversion_pct: DEFAULT_CONVERSION_PCT, riders: DEFAULT_DAILY_RIDERS},
    // Per-deck demand weights the operator has changed. A deck that is not in
    // here is at whatever the reference says, so a untouched setup carries the
    // forecast rather than a copy of it that has to be kept in step.
    weights: {},
    operating: {start: DEFAULT_START, end: DEFAULT_END},
    seed: {mode: 'random', value: 1},
    fleet: {fill: 'all', count: 2, seat_class: DEFAULT_SEAT_CLASS, overrides: {}},
  };
}

// ---- demand ------------------------------------------------------------
// The 24-hour potential UAM demand. Only the chosen mode counts: the other row
// stays on screen at its own value but says nothing. The generator later clips
// this total to the operating window using the hourly reference curve.
export function dailyTrips(demand = {}) {
  if (demand.mode === 'direct') {
    const riders = Number(demand.riders);
    return Number.isFinite(riders) && riders > 0 ? Math.round(riders) : 0;
  }
  const baseline = Number(demand.baseline), pct = Number(demand.conversion_pct);
  if (!Number.isFinite(baseline) || !Number.isFinite(pct) || baseline <= 0 || pct <= 0) return 0;
  return Math.round(baseline * pct / 100);
}
export function describeDemand(demand = {}) {
  const trips = dailyTrips(demand);
  if (demand.mode === 'direct') return `직접 입력 · ${trips.toLocaleString('ko-KR')}명/일`;
  return `${Number(demand.baseline ?? 0).toLocaleString('ko-KR')} × ${demand.conversion_pct}% = ${trips.toLocaleString('ko-KR')}명/일`;
}

// ---- how much belongs to each deck -------------------------------------
export function clampWeight(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_WEIGHT;
  const stepped = Math.round(number / WEIGHT_STEP) * WEIGHT_STEP;
  return Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, stepped));
}
// What one deck is set to: the operator's number if they moved it, the
// reference if they have not, and the average if we were given neither.
export function weightOf(state, id, direction, defaults = {}) {
  const changed = state?.weights?.[id]?.[direction];
  if (changed !== undefined && changed !== null && changed !== '') return clampWeight(changed);
  const reference = defaults?.[id]?.[direction];
  return reference === undefined || reference === null ? DEFAULT_WEIGHT : clampWeight(reference);
}
// One row per deck in scope, with the shares those weights come to. The shares
// are normalised over the scope, which is the right denominator: the reference
// covers the whole city, the day being built covers these decks.
export function weightRows(scope = [], state = {}, defaults = {}, known = new Map()) {
  const rows = scope.map(id => {
    const record = known.get ? known.get(id) : undefined;
    const reference = defaults?.[id] ?? {};
    const row = {id, name: record?.name ?? id, known: reference.known !== false,
      source: reference.source ?? ''};
    for (const direction of DIRECTION_IDS) {
      row[direction] = weightOf(state, id, direction, defaults);
      row[`${direction}_default`] = reference[direction] ?? DEFAULT_WEIGHT;
    }
    row.changed = DIRECTION_IDS.some(direction => row[direction] !== row[`${direction}_default`]);
    return row;
  });
  for (const direction of DIRECTION_IDS) {
    const total = rows.reduce((sum, row) => sum + Math.max(0, row[direction]), 0);
    for (const row of rows) row[`${direction}_share`] = total > 0 ? Math.max(0, row[direction]) / total : 0;
  }
  return rows;
}
export function describeWeights(rows = []) {
  if (!rows.length) return '먼저 버티포트를 선택하세요';
  const silent = rows.filter(row => row.departure === 0 && row.arrival === 0);
  const even = rows.every(row => row.departure === DEFAULT_WEIGHT && row.arrival === DEFAULT_WEIGHT);
  if (even) return '모든 버티포트 100%';
  const busiest = [...rows].sort((a, b) => (b.departure + b.arrival) - (a.departure + a.arrival))[0];
  const changed = rows.filter(row => row.changed).length;
  const parts = [`${busiest.name} 최다 · 출발 ${busiest.departure}%`];
  if (changed) parts.push(`${changed}곳 조정됨`);
  if (silent.length) parts.push(`${silent.length}곳 0%`);
  return parts.join(' · ');
}
// The demand each connected pair would carry, by the formula the schedule is
// built with: the trips a day, shared by the departing deck's weight and the
// arriving deck's, with the departing deck itself left out of the arrival
// denominator because nobody flies to where they took off from.
//
// It is an estimate for the summary to draw, not the schedule. Whoever builds
// the schedule is given the shares and does this again properly.
export function odEstimates(rows = [], pairs = [], trips = 0) {
  return odDemandPlan(rows, pairs, trips).legs;
}

export const OD_REDISTRIBUTION_RATE = 0.85;

function largestRemainder(total, shares) {
  const count = Math.max(0, Math.round(Number(total) || 0));
  const weight = shares.reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  if (!(count > 0) || !(weight > 0)) return shares.map(() => 0);
  const exact = shares.map(value => count * Math.max(0, Number(value) || 0) / weight);
  const out = exact.map(Math.floor);
  const order = exact.map((value, index) => ({index, rest: value - out[index]}))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (let left = count - out.reduce((sum, value) => sum + value, 0), i = 0; left > 0; left -= 1, i += 1) {
    out[order[i].index] += 1;
  }
  return out;
}

// The unconstrained OD market is formed before the operator's connected pairs
// are applied. A cut leg transfers only part of its demand: same-origin routes
// first, then same-destination routes, then routes touching either endpoint.
// The remainder leaves this UAM day instead of being silently manufactured on
// the routes that remain.
export function odDemandPlan(rows = [], pairs = [], trips = 0,
  redistributionRate = OD_REDISTRIBUTION_RATE) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const potential = [];
  for (const start of rows) {
    for (const end of rows) {
      const from = start.id, to = end.id;
      if (from === to) continue;
      const rest = rows.reduce((sum, row) => row.id === from ? sum : sum + row.arrival_share, 0);
      const share = rest > 0 ? start.departure_share * end.arrival_share / rest : 0;
      potential.push({from, to, from_name: start.name, to_name: end.name, share});
    }
  }
  const whole = potential.reduce((sum, leg) => sum + leg.share, 0);
  for (const leg of potential) leg.share = whole > 0 ? leg.share / whole : 0;
  const connected = new Set();
  for (const pair of pairs) {
    if (!byId.has(pair.from) || !byId.has(pair.to) || pair.from === pair.to) continue;
    connected.add(`${pair.from}\u0000${pair.to}`);
    connected.add(`${pair.to}\u0000${pair.from}`);
  }
  const rate = Math.max(0, Math.min(1, Number(redistributionRate) || 0));
  const legs = potential.filter(leg => connected.has(`${leg.from}\u0000${leg.to}`))
    .map(leg => ({...leg, direct_share: leg.share, redistributed_share: 0}));
  const missing = potential.filter(leg => !connected.has(`${leg.from}\u0000${leg.to}`));
  for (const cut of missing) {
    let alternatives = legs.filter(leg => leg.from === cut.from && leg.direct_share > 0);
    if (!alternatives.length) alternatives = legs.filter(leg => leg.to === cut.to && leg.direct_share > 0);
    if (!alternatives.length) alternatives = legs.filter(leg =>
      leg.direct_share > 0 && ([leg.from, leg.to].includes(cut.from) || [leg.from, leg.to].includes(cut.to)));
    if (!alternatives.length) alternatives = legs.filter(leg => leg.direct_share > 0);
    const weight = alternatives.reduce((sum, leg) => sum + Math.max(0, leg.direct_share), 0);
    for (const alternative of alternatives) {
      const portion = weight > 0 ? Math.max(0, alternative.direct_share) / weight : 1 / alternatives.length;
      alternative.redistributed_share += cut.share * rate * portion;
    }
  }
  for (const leg of legs) leg.share = leg.direct_share + leg.redistributed_share;
  legs.sort((a, b) => b.share - a.share);
  const directShare = legs.reduce((sum, leg) => sum + leg.direct_share, 0);
  const disconnectedShare = missing.reduce((sum, leg) => sum + leg.share, 0);
  const redistributedShare = legs.reduce((sum, leg) => sum + leg.redistributed_share, 0);
  const lostShare = Math.max(0, 1 - directShare - redistributedShare);
  const [directTrips, redistributedTrips, lostTrips] = largestRemainder(
    trips, [directShare, redistributedShare, lostShare]);
  const scheduledTrips = directTrips + redistributedTrips;
  const counts = largestRemainder(scheduledTrips, legs.map(leg => leg.share));
  legs.forEach((leg, index) => {leg.trips = counts[index];});
  return {legs, operating_trips: Math.max(0, Math.round(Number(trips) || 0)),
    direct_trips: directTrips, disconnected_trips: redistributedTrips + lostTrips,
    redistributed_trips: redistributedTrips, lost_trips: lostTrips,
    schedulable_trips: scheduledTrips, redistribution_rate: rate};
}

// ---- pairs -------------------------------------------------------------
// A pair is unordered: one line joins two vertiports and carries both
// directions. The key sorts its ends so the same pair is always the same key,
// whichever end the operator clicked.
export function pairKey(a, b) {return [String(a), String(b)].sort().join('|');}
export function pairEnds(key) {const cut = String(key).indexOf('|'); return [key.slice(0, cut), key.slice(cut + 1)];}

// Every pair the scope allows, each said to be kept or broken. Excluding a
// vertiport breaks all of its pairs at once without forgetting which single
// pairs the operator had already cut.
export function allPairs(scope = [], {excluded = [], broken = []} = {}) {
  const out = new Set(excluded.map(String)), cut = new Set(broken.map(String)), ids = scope.map(String);
  const pairs = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const key = pairKey(ids[i], ids[j]);
      const kept = !out.has(ids[i]) && !out.has(ids[j]) && !cut.has(key);
      pairs.push({key, from: ids[i], to: ids[j], kept});
    }
  }
  return pairs;
}
export function livePairs(scope, state) {return allPairs(scope, state).filter(pair => pair.kept);}
// How many pairs each vertiport still carries, so the list can say which one is
// about to be left on its own.
export function pairCounts(scope, state) {
  const counts = new Map(scope.map(id => [String(id), 0]));
  for (const pair of livePairs(scope, state)) {
    counts.set(pair.from, (counts.get(pair.from) ?? 0) + 1);
    counts.set(pair.to, (counts.get(pair.to) ?? 0) + 1);
  }
  return counts;
}
// Cutting or restoring one line. A pair whose end is excluded stays broken
// whatever this says, so restoring it brings the end back in as well.
export function togglePair(state, key) {
  const broken = new Set((state.broken ?? []).map(String));
  const excluded = new Set((state.excluded ?? []).map(String));
  if (broken.has(key)) broken.delete(key);
  else if (pairEnds(key).some(id => excluded.has(id))) for (const id of pairEnds(key)) excluded.delete(id);
  else broken.add(key);
  return {...state, broken: [...broken], excluded: [...excluded]};
}

// ---- the operating day -------------------------------------------------
export function clockMinutes(text) {
  const parts = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!parts) return null;
  const hours = Number(parts[1]), minutes = Number(parts[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}
// A day that ends before it starts runs past midnight rather than being empty.
export function operatingMinutes({start, end} = {}) {
  const from = clockMinutes(start), to = clockMinutes(end);
  if (from === null || to === null) return 0;
  return to > from ? to - from : (to === from ? 0 : 24 * 60 - from + to);
}
export function operatingTrips(daily, operating = {}, hourlyDeparturePct = []) {
  const from = clockMinutes(operating.start), to = clockMinutes(operating.end);
  const curve = Array.isArray(hourlyDeparturePct) ? hourlyDeparturePct.map(Number) : [];
  const whole = curve.length === 24 ? curve.reduce((sum, value) => sum + Math.max(0, value), 0) : 0;
  if (from === null || to === null || from === to || !(whole > 0) || !(daily > 0)) return 0;
  const span = (to - from + 24 * 60) % (24 * 60);
  let minute = from, weight = 0;
  while (minute < from + span) {
    const hour = Math.floor(minute / 60) % 24;
    const edge = Math.floor(minute / 60 + 1) * 60;
    const held = Math.min(edge, from + span) - minute;
    weight += Math.max(0, curve[hour]) * held / 60;
    minute = edge;
  }
  return Math.round(Number(daily) * weight / whole);
}
export function describeHours(operating = {}) {
  const minutes = operatingMinutes(operating);
  if (!minutes) return '운영 시간이 없습니다';
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return `${operating.start}–${operating.end} · ${hours}시간${rest ? ` ${rest}분` : ''}`;
}

// ---- the seed ----------------------------------------------------------
// A fixed seed is what makes a run repeatable; random means the server draws
// one and reports it back, so a run can still be reproduced afterwards.
export function resolveSeed(seed = {}) {
  if (seed.mode !== 'fixed') return null;
  const value = Number.parseInt(seed.value, 10);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

// ---- what stands on the decks -----------------------------------------
const whole = value => {const number = Math.round(Number(value)); return Number.isFinite(number) && number > 0 ? number : 0;};
export function mixTotal(mix = {}) {return SEAT_IDS.reduce((sum, id) => sum + whole(mix[id]), 0);}
export function mixSeats(mix = {}) {return SEAT_IDS.reduce((sum, id) => sum + whole(mix[id]) * seatsOf(id), 0);}
// Taking the excess off a deck one aircraft at a time, always from whichever
// class has the most, so the mix keeps its shape instead of one class being
// wiped out. `protect` is the class the operator just typed into.
function trim(mix, over, protect) {
  const next = {...mix};
  const others = SEAT_IDS.filter(id => id !== protect);
  while (over > 0) {
    const fullest = others.filter(id => next[id] > 0).sort((a, b) => next[b] - next[a])[0];
    if (!fullest) break;
    next[fullest] -= 1; over -= 1;
  }
  return next;
}
const readMix = mix => Object.fromEntries(SEAT_IDS.map(id => [id, whole(mix?.[id])]));
// `count` aircraft shared across the sizes as evenly as the number allows. What
// does not divide goes to the smaller cabins first: an odd aircraft added to
// the eight-seaters would quietly raise the seat count more than the operator
// asked for, and a deck of four gates reading 2·1·1 is what they would have
// written themselves.
export function spreadMix(count) {
  let left = Math.max(0, whole(count));
  const each = Math.floor(left / SEAT_IDS.length);
  let spare = left - each * SEAT_IDS.length;
  return Object.fromEntries(SEAT_IDS.map(id => {
    const take = each + (spare > 0 ? 1 : 0);
    if (spare > 0) spare -= 1;
    left -= take;
    return [id, take];
  }));
}
// A deck cannot hold more aircraft than it has gates.
export function clampMix(mix, gates) {
  const base = readMix(mix);
  return trim(base, mixTotal(base) - Math.max(0, gates), null);
}
// One class raised to `value`. It keeps what was asked for and the excess comes
// off the others, so raising one kind visibly trades against the rest instead
// of being silently refused.
export function fitMix(mix, key, value, gates) {
  const base = readMix(mix);
  if (!SEAT_IDS.includes(key)) return clampMix(base, gates);
  base[key] = Math.min(whole(value), Math.max(0, gates));
  return trim(base, mixTotal(base) - Math.max(0, gates), key);
}
// One row per vertiport in scope: the mix standing on it at the start. The bulk
// choice fills every deck with one class; an override replaces that deck's mix.
export function fleetRows(vertiports = [], fleet = {}) {
  const overrides = fleet.overrides ?? {};
  return vertiports.map(record => {
    const gates = Math.max(0, Number.isFinite(record.gates) ? record.gates : 0);
    const override = overrides[record.id];
    const bulkClass = SEAT_IDS.includes(fleet.seat_class) || fleet.seat_class === EVEN_MIX
      ? fleet.seat_class : DEFAULT_SEAT_CLASS;
    const bulk = fleet.fill === 'all' ? gates : fleet.fill === 'count' ? Math.min(gates, whole(fleet.count)) : 0;
    // Whatever it was set to, it is held to the gates the deck actually has:
    // a deck edited when it had six gates and since rebuilt with four cannot
    // go on holding six aircraft.
    const mix = override ? clampMix(override, gates)
      : bulkClass === EVEN_MIX ? spreadMix(bulk)
      : {...EMPTY_MIX, [bulkClass]: bulk};
    return {id: record.id, name: record.name, gates, mix, aircraft: mixTotal(mix), seats: mixSeats(mix),
      custom: Boolean(override)};
  });
}
export function fleetTotals(rows = []) {
  return rows.reduce((sum, row) => ({aircraft: sum.aircraft + row.aircraft, seats: sum.seats + row.seats,
    gates: sum.gates + row.gates}), {aircraft: 0, seats: 0, gates: 0});
}
// Seats in the air over a whole day if every aircraft flew back to back: not a
// forecast, only the ceiling the demand is being asked to fit under. It is the
// one number that says early whether the fleet is nowhere near the demand.
export function seatCapacity(rows, operating, {turnaroundMinutes = 30} = {}) {
  const minutes = operatingMinutes(operating);
  if (!minutes || turnaroundMinutes <= 0) return 0;
  return Math.round(fleetTotals(rows).seats * (minutes / turnaroundMinutes));
}

// ---- the request -------------------------------------------------------
// The document the generator is handed. It is written here rather than in the
// panel so its shape is one thing, testable, and the same whether it is sent or
// saved to a file.
export function buildRequest(state, vertiports = []) {
  const errors = [];
  const known = new Map(vertiports.map(record => [record.id, record]));
  const scope = (state.scope ?? []).map(String).filter(id => known.has(id));
  if (scope.length < 2) errors.push('버티포트를 2곳 이상 선택하세요.');
  const pairs = livePairs(scope, state);
  if (scope.length >= 2 && !pairs.length) errors.push('연결된 버티포트 쌍이 없습니다. 하나 이상 남겨 주세요.');
  const trips = dailyTrips(state.demand);
  if (trips <= 0) errors.push('하루 수요가 0입니다. 기준 교통량과 전환률, 또는 이용객 수를 확인하세요.');
  const minutes = operatingMinutes(state.operating);
  if (!minutes) errors.push('운영 시작과 종료 시각을 확인하세요.');
  if (state.seed?.mode === 'fixed' && resolveSeed(state.seed) === null) errors.push('시드는 1 이상의 정수여야 합니다.');
  const rows = fleetRows(scope.map(id => known.get(id)), state.fleet);
  if (scope.length >= 2 && !fleetTotals(rows).aircraft) errors.push('배치된 기체가 없습니다. 초기 상태에서 기체를 배치하세요.');
  const weights = weightRows(scope, state, state.weight_defaults ?? {}, known);
  // Every deck at zero leaves nothing to share out, which is a setting the
  // operator can reach by hand and never one they meant.
  if (scope.length >= 2 && weights.every(row => row.departure === 0)) errors.push('출발 수요 비율이 모두 0입니다. 한 곳 이상 올려 주세요.');
  if (scope.length >= 2 && weights.every(row => row.arrival === 0)) errors.push('도착 수요 비율이 모두 0입니다. 한 곳 이상 올려 주세요.');
  if (state.schedule_planning) {
    const p = state.schedule_planning;
    const labels = {fato_headway_s: '동일 FATO 사용 간격', turnaround_recovery_s: '다음 운항 전 회복여유',
      gate_out: '출발 지상이동', takeoff: '수직 이륙', climb: '상승·정천이',
      descent: '강하·역천이', landing: '수직 착륙', gate_in: '도착 지상이동'};
    for (const [key, value] of Object.entries({fato_headway_s: p.fato_headway_s,
      turnaround_recovery_s: p.turnaround_recovery_s, ...p.phase_floor_s})) {
      if (value === undefined) continue;
      if (value === null || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 3600)
        errors.push(`스케줄링 기준 ${labels[key] ?? key}: 0~3600초를 입력하세요.`);
    }
  }
  if (errors.length) return {errors};
  const demand = state.demand ?? {};
  return {request: {
    version: 1,
    ...(state.manual?.want ? {manual: {want: true, seats: state.manual.seats || null, vertiport: state.manual.vertiport || null}} : {}),
    vertiports: scope,
    pairs: pairs.map(pair => ({from: pair.from, to: pair.to})),
    ...(state.schedule_planning ? {planning: state.schedule_planning} : {}),
    demand: {mode: demand.mode === 'direct' ? 'direct' : 'baseline',
      baseline_trips: Number(demand.baseline), conversion_pct: Number(demand.conversion_pct),
      daily_riders: Number(demand.riders), daily_trips: trips,
      // How the day is shared out between the decks. `weight_pct` is what the
      // operator set (100 = an average deck) and `share` is that normalised
      // over the decks in scope — the p_dep and p_arr a scheduler consumes.
      distribution: {basis: 'weight_pct', reference: '평균 버티포트 = 100%',
        step: WEIGHT_STEP, vertiports: weights.map(row => ({
          vertiport: row.id, name: row.name,
          departure_weight_pct: row.departure, arrival_weight_pct: row.arrival,
          departure_share: Number(row.departure_share.toFixed(6)),
          arrival_share: Number(row.arrival_share.toFixed(6)),
          from_reference: !row.changed}))}},
    operating: {start: state.operating.start, end: state.operating.end, minutes},
    seed: {mode: state.seed?.mode === 'fixed' ? 'fixed' : 'random', value: resolveSeed(state.seed)},
    fleet: rows.map(row => ({vertiport: row.id, gates: row.gates, aircraft: row.aircraft, seats: row.seats,
      aircraft_by_class: {...row.mix}})),
  }};
}

// Everything the run started from, in one file: the request above plus the
// vertiports it names, so a saved setup can be read back without the server.
export function initialStateDocument(state, vertiports = [], {generatedAt = new Date().toISOString()} = {}) {
  const built = buildRequest(state, vertiports);
  const known = new Map(vertiports.map(record => [record.id, record]));
  const scope = (state.scope ?? []).filter(id => known.has(id));
  return {
    kind: 'aerodt.multi_flight_setup', version: 1, generated_at: generatedAt,
    request: built.request ?? null, incomplete: built.errors ?? null,
    vertiports: scope.map(id => {
      const record = known.get(id);
      return {id, name: record.name, latitude: record.latitude, longitude: record.longitude,
        gates: record.gates, fatos: (record.fatos ?? []).length, heading_deg: record.heading_deg};
    }),
    pairs: allPairs(scope, state).map(pair => ({from: pair.from, to: pair.to, connected: pair.kept})),
    fleet: fleetRows(scope.map(id => known.get(id)), state.fleet),
  };
}
