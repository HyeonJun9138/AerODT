"""Read-only evaluation of a scheduled day. Forecast slots are never actuals."""
import copy
import math
import json
from user_application.uam_mission.operations_decisions import summarize as decision_summary
from collections import defaultdict

SCHEMA_VERSION = 1
ON_TIME_SECONDS = 300
PLAN_FIELDS = ('flight_id', 'aircraft_id', 'seats', 'passengers', 'origin', 'destination',
               'origin_name', 'destination_name', 'off_block_s', 'touchdown_s', 'in_block_s',
               'departure_stand', 'arrival_stand', 'departure_fato', 'arrival_fato', 'status')


def capture(engine, schedule, scenario_id, name='', state='finished', events=None):
    """Copy while the caller holds the session lock; no tick or shared cache."""
    return {'schema_version': 1, 'meta': {
        'scenario_id': scenario_id, 'schedule_id': schedule.get('schedule_id'),
        'name': name or schedule.get('name') or '비행계획', 'date': schedule.get('date', ''),
        'state': state, 'observed_s': engine.time_s, 'start_s': engine.opens_s,
        'planned_end_s': engine.closes_s, 'engine': 'native' if engine.pilots else 'rehearsal',
        'problem_count': schedule.get('problem_count', 0), 'legacy': False},
        'plans': [{key: row.get(key) for key in PLAN_FIELDS} for row in schedule['flights']],
        'events': copy.deepcopy(engine.events if events is None else events),
        'energy_models': copy.deepcopy({str(a.seat_class): a.energy.profile
                          for a in engine.aircraft.values() if hasattr(a, 'energy')}),
        'energy_current': {a.energy.flight_id: a.energy.snapshot() for a in engine.aircraft.values()
                           if hasattr(a, 'energy') and a.energy.flight_id},
        'active': {a.flight['flight_id']: {'hold_s': a.hold_seconds, 'phase': a.phase,
                    'failed': a.failed} for a in engine.aircraft.values() if a.flight},
        'fatos': {key: [{'id': p['id'], 'role': p.get('role')} for p in engine._layout(key).get('fatos', ())] for key in engine._vertiports},
        'facilities': {key: value.get('name') or key for key, value in engine._vertiports.items()}}


def number(value):
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def ratio(numerator, denominator):
    return round(100 * numerator / denominator, 1) if denominator else None


def percentile(values, share):
    if not values:
        return None
    values = sorted(values)
    index = (len(values) - 1) * share
    lo = int(index)
    return round(values[lo] + (values[min(lo + 1, len(values) - 1)] - values[lo]) * (index - lo), 1)


def _stats(values):
    return {'count': len(values), 'mean_s': round(sum(values) / len(values), 1) if values else None,
            'p50_s': percentile(values, .5), 'p95_s': percentile(values, .95),
            'max_s': round(max(values), 1) if values else None}


def _sum_known(rows, key):
    values = [row[key] for row in rows if row[key] is not None]
    return sum(values) if len(values) == len(rows) else None


def _aggregate(rows, now):
    departed = [r for r in rows if r['actual_departure_s'] is not None]
    arrived = [r for r in rows if r['actual_arrival_s'] is not None]
    due = [r for r in rows if r['planned_departure_s'] is not None and r['planned_departure_s'] <= now]
    arrival_due = [r for r in rows if r['planned_arrival_s'] is not None and r['planned_arrival_s'] <= now]
    comparable = [r for r in arrived if r['arrival_delta_s'] is not None]
    observed = [r for r in rows if r['actual_departure_s'] is not None or r['actual_arrival_s'] is not None]
    held = [r for r in observed if r['hold_s'] > 0]
    return {
        'planned': len(rows), 'departed': len(departed), 'completed': len(arrived),
        'in_progress': sum(r['status'] == 'active' for r in rows),
        'cancelled': sum(r['status'] == 'cancelled' for r in rows),
        'failed': sum(r['status'] == 'failed' for r in rows),
        'future': sum(r['status'] == 'scheduled' for r in rows),
        'overdue': sum(r['status'] == 'overdue' for r in rows),
        'due_departures': len(due), 'due_arrivals': len(arrival_due),
        'completion_pct': ratio(len(arrived), len(rows)),
        'due_departure_pct': ratio(sum(r['actual_departure_s'] is not None for r in due), len(due)),
        'due_arrival_pct': ratio(sum(r['actual_arrival_s'] is not None for r in arrival_due), len(arrival_due)),
        'on_time_count': sum(r['arrival_delta_s'] <= ON_TIME_SECONDS for r in comparable),
        'on_time_denominator': len(comparable),
        'on_time_pct': ratio(sum(r['arrival_delta_s'] <= ON_TIME_SECONDS for r in comparable), len(comparable)),
        'planned_passengers': _sum_known(rows, 'passengers'),
        'transported_passengers': _sum_known(arrived, 'passengers'),
        'departed_passengers': _sum_known(departed, 'passengers'),
        'load_factor_pct': ratio(_sum_known(arrived, 'passengers'), sum(r['seats'] or 0 for r in arrived))
            if _sum_known(arrived, 'passengers') is not None else None,
        'hold_total_s': round(sum(r['hold_s'] for r in rows), 1), 'held_sorties': len(held),
        'hold': _stats([r['hold_s'] for r in held]),
        'departure_delay': _stats([max(0, r['departure_delta_s']) for r in departed if r['departure_delta_s'] is not None]),
        'arrival_delay': _stats([max(0, r['arrival_delta_s']) for r in comparable]),
        'observed_sorties': len(observed),
        'affected_sorties': sum(r['hold_s'] > 0 or (r['departure_delta_s'] or 0) > ON_TIME_SECONDS
                                or (r['arrival_delta_s'] or 0) > ON_TIME_SECONDS for r in observed),
    }


def build_report(source):
    meta = dict(source['meta'])
    now = number(meta.get('observed_s')) or 0.0
    meta.update(on_time_seconds=ON_TIME_SECONDS, scope='recorded' if meta.get('recorded') else 'current')
    events = defaultdict(list)
    seen = set()
    for event in source.get('events', ()):
        at = number(event.get('time_s'))
        key = (event.get('flight_id'), event.get('kind'), at, event.get('event_sequence') or json.dumps(event, sort_keys=True))
        if at is not None and at <= now and key not in seen:
            events[key[0]].append(dict(event))
            seen.add(key)
    facilities = dict(source.get('facilities') or {})
    rows = []
    intervals = []
    for plan in source['plans']:
        flight = plan['flight_id']
        timeline = sorted(events[flight], key=lambda e: e['time_s'])
        by_kind = {}
        for event in timeline:
            by_kind.setdefault(event['kind'], event)
        off, touch, block = (by_kind.get(kind, {}) for kind in ('off_block', 'touchdown', 'in_block'))
        actual_off = number(off.get('time_s'))
        actual_touch = number(touch.get('time_s'))
        actual_block = number(block.get('time_s'))
        # An in-block report is not a touchdown timestamp; keep a missing
        # touchdown unknown rather than inventing one from the later milestone.
        planned_off, planned_touch = number(plan.get('off_block_s')), number(plan.get('touchdown_s'))
        active = (source.get('active') or {}).get(flight, {})
        failed = by_kind.get('pilot_failed')
        cancelled = by_kind.get('cancelled')
        status = ('completed' if actual_touch is not None else 'failed' if failed or active.get('failed')
                  else 'cancelled' if cancelled else 'active' if actual_off is not None
                  else 'overdue' if planned_off is not None and planned_off <= now else 'scheduled')
        recorded_holds = [number(e.get('hold_s')) for e in timeline if e['kind'] in ('touchdown', 'in_block') and number(e.get('hold_s')) is not None]
        recorded_hold = max(recorded_holds, default=0)
        hold = max(recorded_hold, number(active.get('hold_s')) or 0)
        opened = None
        local_intervals = []
        for event in timeline:
            if event['kind'] == 'hold' and opened is None:
                opened = event['time_s']
                duration = number(event.get('seconds'))
                if duration is not None:  # Simplified rehearsal has assigned intervals.
                    local_intervals.append((opened, min(now, opened + max(0, duration))))
                    opened = None
            elif event['kind'] in ('hold_released', 'touchdown', 'in_block', 'pilot_failed', 'cancelled') and opened is not None:
                local_intervals.append((opened, event['time_s']))
                opened = None
        if opened is not None:
            local_intervals.append((opened, now))
        # Exact native accumulator wins; old records may only have hold events.
        if not recorded_holds and not active:
            hold = sum(max(0, b-a) for a, b in local_intervals)
        for a, b in local_intervals:
            if b > a:
                intervals.append((plan['destination'], a, b))
        for role in ('origin', 'destination'):
            facilities.setdefault(plan[role], plan.get(role + '_name') or plan[role])
        energy_events = [e for e in timeline if isinstance(e.get('energy'), dict)]
        latest_energy = source.get('energy_current', {}).get(flight) or (energy_events[-1]['energy'] if energy_events else {})
        rows.append({
            'flight_id': flight, 'aircraft_id': plan['aircraft_id'], 'origin': plan['origin'],
            'destination': plan['destination'], 'seats': plan.get('seats'), 'passengers': plan.get('passengers'),
            'planned_departure_s': planned_off, 'actual_departure_s': actual_off,
            'planned_arrival_s': planned_touch, 'actual_arrival_s': actual_touch,
            'planned_in_block_s': number(plan.get('in_block_s')), 'actual_in_block_s': actual_block,
            'departure_delta_s': round(actual_off-planned_off, 1) if actual_off is not None and planned_off is not None else None,
            'arrival_delta_s': round(actual_touch-planned_touch, 1) if actual_touch is not None and planned_touch is not None else None,
            'hold_s': round(max(0, hold), 1), 'status': status, 'phase': active.get('phase'),
            'reason': (failed or cancelled or {}).get('reason', ''),
            'departure_stand': plan.get('departure_stand'), 'arrival_stand': block.get('stand') or plan.get('arrival_stand'),
            'planned_departure_fato': plan.get('departure_fato'), 'planned_arrival_fato': plan.get('arrival_fato'),
            'departure_fato': off.get('departure_fato') or plan.get('departure_fato'),
            'arrival_fato': touch.get('arrival_fato') or off.get('arrival_fato') or plan.get('arrival_fato'),
            'sequence': by_kind.get('arrival_request', {}).get('sequence'), 'events': timeline,
            'hold_intervals': local_intervals,
            'energy_used_kwh': latest_energy.get('flight_used_kwh'),
            'energy_deficit_kwh': latest_energy.get('flight_deficit_kwh'),
            'charge_grid_kwh': latest_energy.get('flight_grid_kwh'),
            'battery_min_pct': min([e['energy']['soc_pct'] for e in energy_events]
                                   + ([latest_energy['soc_pct']] if latest_energy else []), default=None),
            'battery_warnings': [e['kind'] for e in energy_events if e['kind'] in
                                 ('battery_low', 'battery_critical', 'battery_depleted')],
        })
    rows.sort(key=lambda r: (r['planned_departure_s'] if r['planned_departure_s'] is not None else math.inf, r['flight_id']))
    totals = _aggregate(rows, now)
    totals['congestion_pct'] = ratio(totals['affected_sorties'], totals['observed_sorties'])
    ports = []
    for identifier, name in sorted(facilities.items()):
        outgoing = [r for r in rows if r['origin'] == identifier]
        incoming = [r for r in rows if r['destination'] == identifier]
        if not outgoing and not incoming:
            continue
        dep, arr = _aggregate(outgoing, now), _aggregate(incoming, now)
        observed_out = [r for r in outgoing if r['actual_departure_s'] is not None]
        observed_in = [r for r in incoming if r['actual_departure_s'] is not None or r['actual_arrival_s'] is not None]
        affected = sum((r['departure_delta_s'] or 0) > ON_TIME_SECONDS for r in observed_out)
        affected += sum(r['hold_s'] > 0 or (r['arrival_delta_s'] or 0) > ON_TIME_SECONDS for r in observed_in)
        markers = [(at, change) for port, a, b in intervals if port == identifier for at, change in ((a, 1), (b, -1))]
        count = peak = 0
        for _, change in sorted(markers):
            count += change
            peak = max(peak, count)
        ports.append({'id': identifier, 'name': name, 'departure': dep, 'arrival': arr,
                      'movements': dep['departed'] + arr['completed'],
                      'passenger_movements': dep['departed_passengers'] + arr['transported_passengers']
                          if dep['departed_passengers'] is not None and arr['transported_passengers'] is not None else None,
                      'congestion_pct': ratio(affected, len(observed_out) + len(observed_in)),
                      'affected_movements': affected, 'observed_movements': len(observed_out) + len(observed_in),
                      'peak_holding': peak if meta.get('engine') == 'native' else None})
    fleet = []
    for identifier in sorted({r['aircraft_id'] for r in rows}):
        selected = [r for r in rows if r['aircraft_id'] == identifier]
        item = _aggregate(selected, now)
        duration = sum(max(0, (r['actual_in_block_s'] if r['actual_in_block_s'] is not None else
                              r['actual_arrival_s'] if r['actual_arrival_s'] is not None else now)-r['actual_departure_s'])
                       for r in selected if r['actual_departure_s'] is not None and r['status'] != 'failed')
        fleet.append(dict(item, id=identifier, operation_s=round(duration, 1)))
    start = number(meta.get('start_s')) or min((r['planned_departure_s'] or 0 for r in rows), default=0)
    end = max(now, number(meta.get('planned_end_s')) or now)
    buckets = {hour: {'hour_s': hour*3600, 'planned_departures': 0, 'actual_departures': 0,
                     'planned_arrivals': 0, 'actual_arrivals': 0, 'hold_aircraft_minutes': 0.0}
               for hour in range(int(start//3600), min(int(end//3600)+1, int(start//3600)+168))}
    for row in rows:
        for field, count_key in [('planned_departure_s', 'planned_departures'), ('actual_departure_s', 'actual_departures'),
                                 ('planned_arrival_s', 'planned_arrivals'), ('actual_arrival_s', 'actual_arrivals')]:
            at = row[field]
            if at is not None and int(at//3600) in buckets:
                buckets[int(at//3600)][count_key] += 1
    for _, a, b in intervals:
        for hour in range(int(a//3600), int(b//3600)+1):
            if hour in buckets:
                buckets[hour]['hold_aircraft_minutes'] += max(0, min(b, (hour+1)*3600)-max(a, hour*3600))/60
    for bucket in buckets.values():
        bucket['hold_aircraft_minutes'] = round(bucket['hold_aircraft_minutes'], 2)
    delay_bins = [{'label': label, 'count': 0} for label in ('조기·정시', '0–5분', '5–15분', '15–30분', '30분 이상')]
    for row in rows:
        delay = row['arrival_delta_s']
        if delay is not None:
            index = 0 if delay <= 0 else 1 if delay <= 300 else 2 if delay <= 900 else 3 if delay <= 1800 else 4
            delay_bins[index]['count'] += 1
    return {'schema_version': SCHEMA_VERSION, 'meta': meta, 'totals': totals, 'vertiports': ports,
            **decision_summary(source, rows),
            'aircraft': fleet, 'sorties': rows, 'hourly': list(buckets.values()), 'delay_bins': delay_bins,
            'definitions': {
                'source': ('Physical이 보고한 운항 이벤트입니다. 시작 시점 이전 구간은 현재 규칙으로 재구성한 기록입니다.'
                    if meta.get('reconstructed_through_s') is not None else '실행 엔진에서 관측한 운항 이벤트를 집계합니다.'),
                'completed': '착륙(touchdown) 기록이 있는 비행편. 출발은 주기장 출발(off-block) 기준입니다.',
                'passengers': '완료편의 계획 탑승객 합계(인회). 실측 승객 수나 중복 없는 실인원이 아닙니다.',
                'congestion': '출발 지연 5분 초과 또는 도착 대기·도착 지연 5분 초과 비율. 시설 수용능력의 점유율이 아닙니다.',
                'punctuality': '계획 착륙시각이 있는 실제 착륙편 중 지연 5분 이하 비율. 조기 도착을 포함합니다.',
                'hold': 'native 누적 대기/기록 기준. 시간대별 대기는 hold 시작·해제 이벤트의 기체·분입니다.'
                    if meta.get('engine') == 'native' else '간이 실행 또는 이전 기록의 대기 값. 실제 체공시간과 다를 수 있습니다.',
            }}


def select_sorties(report, *, vertiport='', aircraft='', status='', query='', fato='', decision_reason='', hour=-1, hold_hour=-1, delay_bin=-1, page=1, page_size=25):
    rows = report['sorties']
    if fato:
        rows = [r for r in rows if (r['departure_fato'] == fato and (not vertiport or r['origin'] == vertiport))
                or (r['arrival_fato'] == fato and (not vertiport or r['destination'] == vertiport))]
    if decision_reason:
        rows = [r for r in rows if any(e.get('kind') == 'psu_decision' and e.get('reason') == decision_reason for e in r['events'])]
    query = query.strip().casefold()
    if vertiport:
        rows = [r for r in rows if vertiport in (r['origin'], r['destination'])]
    if aircraft:
        rows = [r for r in rows if r['aircraft_id'] == aircraft]
    if status:
        rows = [r for r in rows if (r['hold_s'] > 0 if status == 'held' else r['status'] == status)]
    if hour >= 0:
        rows = [r for r in rows if any(r[k] is not None and int(r[k]//3600) == hour
                                     for k in ('planned_arrival_s', 'actual_arrival_s'))]
    if hold_hour >= 0:
        rows = [r for r in rows if any(a < (hold_hour+1)*3600 and b > hold_hour*3600 for a, b in r['hold_intervals'])]
    if delay_bin >= 0:
        def matches(row):
            delay = row['arrival_delta_s']
            if delay is None:
                return False
            return (0 if delay <= 0 else 1 if delay <= 300 else 2 if delay <= 900 else 3 if delay <= 1800 else 4) == delay_bin
        rows = [r for r in rows if matches(r)]
    if query:
        names = {r['id']: r['name'] for r in report['vertiports']}
        rows = [r for r in rows if query in ' '.join(str(r.get(k) or '') for k in
                ('flight_id', 'aircraft_id', 'origin', 'destination')).casefold()
                or query in names.get(r['origin'], '').casefold() or query in names.get(r['destination'], '').casefold()]
    page_size = max(1, min(100, page_size))
    pages = max(1, math.ceil(len(rows)/page_size))
    page = max(1, min(page, pages))
    return {'schema_version': 1, 'meta': report['meta'], 'total': len(rows), 'page': page,
            'pages': pages, 'page_size': page_size,
            'rows': [{k: v for k, v in row.items() if k != 'events'} for row in rows[(page-1)*page_size:page*page_size]]}
