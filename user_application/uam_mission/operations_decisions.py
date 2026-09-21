"""Read-only FATO and decision rollups from recorded facts, never forecast slots."""
from collections import Counter


def summarize(source, sorties):
    pads = {}
    def pad(place, identifier):
        if not place or not identifier:
            return None
        key = (place, identifier)
        if key not in pads:
            pads[key] = dict(vertiport=place, fato=identifier, role='unknown',
                planned_departures=0, planned_arrivals=0, takeoffs=0, landings=0,
                assigned_departures=0, assigned_arrivals=0, terminal_wait_s=0.0,
                protected_s=0.0, hold_decisions=0)
        return pads[key]
    for port, items in (source.get('fatos') or {}).items():
        for item in items:
            pad(port, item['id'])['role'] = item.get('role', 'unknown')
    now = source['meta'].get('observed_s') or 0
    decisions, reasons, changes = [], Counter(), 0
    for sortie in sorties:
        for kind, place in [('departure', sortie['origin']), ('arrival', sortie['destination'])]:
            planned = pad(place, sortie.get('planned_' + kind + '_fato'))
            assigned = pad(place, sortie.get(kind + '_fato'))
            if planned:
                planned['planned_' + kind + 's'] += 1
            if assigned and sortie['actual_departure_s'] is not None:
                assigned['assigned_' + kind + 's'] += 1
                if sortie.get(kind + '_fato') != sortie.get('planned_' + kind + '_fato'):
                    changes += 1
        open_wait, open_claim = {}, {}
        for event in sortie['events']:
            if event['kind'] in ('takeoff', 'touchdown'):
                arrival = event['kind'] == 'touchdown'
                target = pad(sortie['destination' if arrival else 'origin'],
                             event.get('arrival_fato' if arrival else 'departure_fato'))
                if target:
                    target['landings' if arrival else 'takeoffs'] += 1
            if event['kind'] != 'psu_decision':
                continue
            decisions.append(event)
            target = pad(event.get('vertiport'), event.get('fato'))
            if not target:
                continue
            node, at = event.get('node', ''), event['time_s']
            if event.get('outcome') == 'hold':
                reasons[event.get('reason') or '기타'] += 1
                target['hold_decisions'] += 1
            if not node.startswith('terminal_'):
                continue
            if node in open_wait and event.get('outcome') != 'hold':
                beginning, previous = open_wait.pop(node)
                previous['terminal_wait_s'] += max(0, at-beginning)
            if event.get('outcome') == 'hold':
                open_wait.setdefault(node, (at, target))
            if event.get('outcome') == 'granted':
                open_claim.setdefault(node, (at, target))
            if event.get('outcome') == 'released' and node in open_claim:
                beginning, previous = open_claim.pop(node)
                previous['protected_s'] += max(0, at-beginning)
        for beginning, target in open_wait.values():
            target['terminal_wait_s'] += max(0, now-beginning)
        for beginning, target in open_claim.values():
            target['protected_s'] += max(0, now-beginning)
    for target in pads.values():
        target['terminal_wait_s'] = round(target['terminal_wait_s'], 1)
        target['protected_s'] = round(target['protected_s'], 1)
    return dict(fatos=list(pads.values()), decisions={
        'total': len(decisions), 'fato_reassignments': changes,
        'hold_reasons': [dict(reason=k, count=v) for k,v in reasons.most_common()],
        'recent': sorted(decisions, key=lambda e:(e['time_s'], e.get('event_sequence',0)), reverse=True)[:150],
        'coverage': 'recorded_events_only',
        'notes': '보호 시간은 상승·접근 경로 예약 시간이며 패드 점유율이 아닙니다. 대기 판단 횟수는 대기 기체 수와 다릅니다.'})
