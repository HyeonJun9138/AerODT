// The reported movement owns the lifetime of a route. Its full saved-topology
// path stays visible throughout taxiing and disappears with the next phase.
// Flowing light indicates direction, not a measured position or speed.
import {taxiRuns} from './vertiport_operations.js';
import {buildElement} from './dom_builder.js';

export const FLOW_PERIOD_MS = 1600;
const point = p => Array.isArray(p) && p.length >= 2 && p.slice(0, 2).every(Number.isFinite);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const taxiing = moves => (Array.isArray(moves) ? moves : []).filter(m =>
  m?.on_ground === true && m.phase !== 'charge' && m.from && m.to && m.from !== m.to);

export function routeMovements(movements, flights = [], now = 0, demo = false) {
  if (movements !== null && movements !== undefined) return taxiing(movements);
  if (!demo) return [];
  return flights.filter(f => f.bookings?.some(b => b.key.startsWith('taxiway:') && b.start <= now && now < b.end))
    .map(f => ({aircraft_id: f.callsign, flight_id: f.id, direction: f.direction, on_ground: true,
      phase: f.direction === 'arrival' ? 'gate_in' : 'gate_out', example: true,
      from: f.direction === 'arrival' ? f.fato : f.gate, to: f.direction === 'arrival' ? f.gate : f.fato}));
}

export function groundRoutes(resources, movements) {
  return taxiing(movements).flatMap(move => {
    const runs = taxiRuns(resources, move.from, move.to);
    if (!runs.length) return [];
    let at = move.from;
    const points = [];
    for (const run of runs) {
      if (!Array.isArray(run.points_m) || run.points_m.length < 2 || !run.points_m.every(point)) return [];
      const forward = run.from === at;
      const section = forward ? run.points_m : [...run.points_m].reverse();
      // Reject broken geometry instead of drawing a shortcut over the apron.
      if (points.length && distance(points.at(-1), section[0]) > .02) return [];
      for (const p of section) if (!points.length || distance(points.at(-1), p) > .001) points.push([...p]);
      at = forward ? run.to : run.from;
    }
    if (at !== move.to || points.length < 2) return [];
    const id = [move.aircraft_id ?? move.flight_id ?? '', move.flight_id ?? '', move.from, move.to].join(':');
    const direction = move.direction === 'arrival' || move.phase === 'gate_in' ? 'arrival' : 'departure';
    return [{...move, id, direction, points, edges: runs.map(r => r.id)}];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

// Redrawing on a poll joins the current light cycle instead of starting again.
export function flowDelay(id, now) {
  const seed = [...id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % FLOW_PERIOD_MS, 0);
  return -(((Number.isFinite(now) ? now : 0) + seed) % FLOW_PERIOD_MS);
}

export const routeMotionEnabled = (document, preference) => preference ?? !document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function groundRouteLegend(document, resources, movements, {demo = false, motion = true, onMotion = null} = {}) {
  const e = (tag, props, ...children) => buildElement(document, tag, props, ...children);
  const routes = groundRoutes(resources, movements), missing = taxiing(movements).length - routes.length;
  return e('section', {class: 'vp-route-monitor', 'aria-label': '지상 이동 경로'},
    e('div', {class: 'vp-route-heading'},
      e('strong', {text: 'GROUND FLOW'}),
      e('span', {class: 'vp-route-count', text: `${demo ? '예시 · ' : ''}${routes.length}대 경로 표시`}),
      onMotion ? e('button', {type: 'button', class: 'vp-route-motion', 'aria-label': '경로 흐름 효과',
        'aria-pressed': String(motion), title: '이동 방향을 따라 흐르는 빛 켜기 / 끄기',
        text: motion ? '흐름 ON' : '흐름 OFF', onclick: () => onMotion(!motion)}) : null),
    e('div', {class: 'vp-route-key'},
      e('span', {'data-direction': 'departure', text: '↗ 출발'}),
      e('span', {'data-direction': 'arrival', text: '↘ 도착'}),
      e('small', {text: '빛의 흐름 = 이동 방향'})),
    routes.length ? e('div', {class: 'vp-route-list'}, ...routes.map(route =>
      e('div', {class: 'vp-route-row', 'data-direction': route.direction,
        title: `${route.aircraft_id ?? ''} · ${route.flight_id ?? ''} · ${route.edges.join(' → ')}`},
        e('strong', {text: route.aircraft_id ?? route.flight_id ?? '기체'}),
        e('span', {text: `${route.from} → ${route.to}`})))) :
      e('p', {class: 'vp-route-empty', text: missing ? '이동 경로 연결을 확인해 주세요.' : '현재 유도로 이동 없음'}),
    e('p', {class: 'vp-route-note', text: missing ? `경로 연결 없음 ${missing}대 · 시설 연결 정보 확인 필요` :
      `${demo ? '예시 일정' : '보고된 출발·도착 자원'} + 저장 유도로 기준 · 이동 완료 시 해제`}));
}
