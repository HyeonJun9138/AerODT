"""Pilot readback/report workflow over the existing scenario PSU and observations.

This never drives the aircraft. A reservation is not a takeoff/landing clearance,
and a pilot pressing a report cannot manufacture an observed movement.
"""
import math
import time
from digital_twin.contracts.pilot_psu import (
    PsuPilotMessage, new_message_id, psu_message_kind,
)
from digital_twin.model_library import terminal_paths
from . import psu_sequencing as psu


def distance(a, point):
    return math.hypot((a.latitude-point[0])*111320,
                      (a.longitude-point[1])*111320*math.cos(math.radians(point[0])))


def pad_point(engine, flight, kind):
    port = flight['origin' if kind == 'departure' else 'destination']
    layout = engine._layout(port)
    pad = next((p for p in layout.get('fatos', []) if p['id'] == flight[kind+'_fato']), None)
    if pad is None:
        return None
    east, north = pad['center_m']; frame = layout['frame']
    return (frame['latitude']+north/111320,
            frame['longitude']+east/(111320*math.cos(math.radians(frame['latitude']))),
            engine._deck_height(port))


def at_pad(engine, a, flight, kind):
    point = pad_point(engine, flight, kind)
    # The manual Runtime reports ellipsoid altitude from the rendered contact
    # deck, while ScenarioEngine's generated layout keeps a local platform
    # height.  They are different vertical datums (for example 99 m versus
    # 35 m at VP012), so comparing them rejects an aircraft that is visibly and
    # physically grounded on the FATO.  Ground contact is already authoritative
    # in ``a.airborne``; this helper only answers the horizontal pad question.
    return bool(point and distance(a, point) <= 7)


def departure_stop_reason(engine, a, flight):
    """Explain the exact unmet condition instead of one ambiguous FATO hint."""
    point = pad_point(engine, flight, 'departure')
    if point is None:
        return '출발 FATO 위치를 확인할 수 없습니다'
    if a.airborne:
        return '출발 FATO 접지 상태를 확인하세요'
    away = distance(a, point)
    if away > 7:
        return f'출발 FATO 중심까지 {away:.1f} m 이동하세요'
    if a.speed_mps > .5:
        return f'출발 FATO에서 완전히 정지하세요 · 현재 {a.speed_mps:.1f} m/s'
    return ''


def arrival_gate_stop_reason(engine, a, flight, clearance):
    """Explain whether the observed aircraft can report arrival at its gate.

    As with a FATO, the native manual Runtime's rendered contact altitude and
    the generated layout's local deck height are different vertical datums.
    Ground contact is therefore authoritative; gate inclusion is horizontal.
    """
    if clearance is None or not clearance.stand:
        return '착륙 보고와 도착 GATE 배정이 필요합니다'
    spot = engine._stand_place(flight['destination'], clearance.stand)
    if spot is None:
        return f'도착 {clearance.stand} 위치를 확인할 수 없습니다'
    if a.airborne:
        return f'도착 {clearance.stand} 접지 상태를 확인하세요'
    away = distance(a, spot)
    if away > 3:
        return f'도착 {clearance.stand} 중심까지 {away:.1f} m 이동하세요'
    if a.speed_mps > .15:
        return f'도착 {clearance.stand}에서 완전히 정지하세요 · 현재 {a.speed_mps:.1f} m/s'
    return ''


def fresh(a):
    received = a.external.get('pose_received')
    return received is not None and time.monotonic()-received < 3


def earliest_departure(engine, a, flight):
    booked = getattr(engine, '_entry_forecasts', {}).get(flight['flight_id']) or {}
    return max(float(flight.get('off_block_s') or 0), float(a.ready_s or 0),
               float(booked.get('departure_s') or 0))


def arrival_request_readiness(engine, a, flight, now, decision=None):
    """The hand-flying pilot's own trigger; PSU is not consulted yet."""
    decision = decision or engine._pilot_arrival_request_decision(a)
    if decision['due'] and not a.external.get('arrival_request_ready'):
        a.external['arrival_request_ready'] = True
        engine._record(now, 'pilot_arrival_request_ready', flight, role='pilot',
                       request_mode='manual', trigger_reason=decision['reason'],
                       remaining_s=round(decision['remaining_s'], 1),
                       lead_s=decision['lead_s'])
    return decision


def exchange(engine, a, flight, kind, answer, now, request_message=None):
    """Both directions enter the normal operational event stream, once per click."""
    if request_message is not None:
        a.external.setdefault('active_psu_requests', {})[kind] = request_message
    engine._record(now, 'pilot_report' if kind.startswith('report_') else 'pilot_request',
                   flight, role='pilot', request_kind=kind, direction='pilot_to_psu',
                   message=None if request_message is None else request_message.as_dict())
    return response(engine, a, flight, kind, answer, now, request_message=request_message)


def response(engine, a, flight, kind, answer, now, *, record=True, request_message=None):
    """Keep the current answer fresh; log only changed automatic decisions."""
    request_message = request_message or a.external.get('active_psu_requests', {}).get(kind)
    psu_message = None
    if request_message is not None:
        previous = a.external.get('last_psu_message') or {}
        same = (previous.get('request_message_id') == request_message.message_id
                and previous.get('outcome') == answer.get('state')
                and previous.get('reason') == answer.get('reason', ''))
        if same and not record:
            psu_wire = previous
        else:
            sequence = int(a.external.get('psu_message_sequence', 0)) + 1
            a.external['psu_message_sequence'] = sequence
            psu_message = PsuPilotMessage(
                message_id=new_message_id('psu'), request_message_id=request_message.message_id,
                flight_id=flight['flight_id'], aircraft_id=a.aircraft_id,
                psu_id=request_message.psu_id, pilot_id=request_message.pilot_id,
                kind=psu_message_kind(kind, answer.get('state')),
                outcome=answer.get('state'), reason=answer.get('reason', ''),
                issued_at_s=now, expires_at_s=now+30.0, sequence=sequence,
                vertiport_id=answer.get('vertiport'), fato_id=answer.get('fato'),
                stand_id=answer.get('stand'))
            psu_wire = psu_message.as_dict()
            a.external['last_psu_message'] = psu_wire
        answer = dict(answer, psu_message=psu_wire)
    a.external['last_answer'] = dict(answer, kind=kind, time_s=now)
    if not record:
        return answer
    entry = {'time_s': now, 'kind': kind, 'state': answer.get('state'),
             'reason': answer.get('reason', ''), 'flight_id': flight['flight_id']}
    history = a.external.setdefault('communications', [])
    history.append(entry); del history[:-30]
    engine._record(now, 'psu_response', flight, role='psu', request_kind=kind,
                   direction='psu_to_pilot', outcome=answer.get('state'),
                   reason=answer.get('reason', ''), response=dict(answer),
                   message=None if psu_message is None else psu_message.as_dict())
    return answer


def observe(engine, a, flight, was_airborne, now):
    """Reuse observed resource release rules; pilot reports acknowledge these facts."""
    ext = a.external
    ext['pose_received'] = time.monotonic()
    if not flight or ext.get('completed'):
        return
    if a.flight and not a.airborne and not ext.get('observed_takeoff_s'):
        engine._observe_ground_departure(a, now)
    if a.airborne and not was_airborne and 'observed_takeoff_s' not in ext:
        ext['observed_takeoff_s'] = now
        if a.flight:
            engine.psu.mark_used(flight['flight_id'], psu.DEPARTURE, now)
            engine._record(now, 'takeoff', flight, source='manual_observation')
    if a.flight and a.route and a.airborne:
        point = pad_point(engine, flight, 'departure')
        if point and distance(a, point) >= engine.policy['pilot']['traffic_horizontal_m']:
            pad = (flight['origin'], flight['departure_fato'])
            if engine._active_pads.get(pad) == flight['flight_id']:
                engine._active_pads.pop(pad)
                engine.psu.complete(flight['flight_id'], psu.DEPARTURE, now)
        if terminal_paths.clear_of(a.route, 'departure', (a.latitude,a.longitude,a.altitude),
                                   engine._terminal.horizontal_m, engine._terminal.vertical_m):
            engine._terminal_release(a, 'departure', now)
    if (was_airborne and not a.airborne and ext.get('observed_takeoff_s') is not None
            and at_pad(engine,a,flight,'arrival') and 'observed_landing_s' not in ext):
        ext['observed_landing_s'] = now
        engine.psu.mark_used(flight['flight_id'], psu.ARRIVAL, now)
        engine._assign_landed_gates(now)
        engine._record(now,'touchdown',flight,source='manual_observation')


def arrival_wait(engine, a, flight, now, *, final=False):
    """Shared request/display guard. Touchdown ETA is never a wait-until clock."""
    c=a.clearance
    if not fresh(a):
        return '기체 위치 수신 지연 · 재확인 필요'
    if (not a.airborne or not c or c.released_s is not None or c.state==psu.REFUSED
            or not c.stand and not c.deferred_stand):
        return '접근 순번과 착륙 자원 확인 필요'
    if 'report_airborne' not in a.external.get('reports',{}):
        return '이륙 완료 보고를 먼저 보내세요'
    if not a.route or a.route.landing_index is None:
        return '도착 경로 확인 필요'
    if final and c.approach_started_s is None:
        return '접근 허가를 먼저 요청하세요 · 최종 하강 금지'
    if not final and c.approach_started_s is None:
        when=c.approach_s
        if when is None and not engine.policy['psu']['predictive_arrivals']:
            # Non-predictive scenarios still distinguish entry from touchdown.
            when=c.cleared_s-sum(p.duration_s for p in a.route.phases if p.stage in ('descent','landing'))
        if when is None:
            return c.reason or '접근 가능 여부 재계산 대기'
        if when>now+.5:
            return f'접근 검토까지 {math.ceil(when-now)}초 · 허가 전 접근 금지'
        if not engine._queue_return_clear(a):
            return '대기점 복귀 경로 확보 대기'
        preceding=[p for p in engine.psu._clearances.values() if p is not c and p.kind==psu.ARRIVAL
                   and p.vertiport==c.vertiport and p.fato==c.fato and p.released_s is None]
        committed=[p for p in preceding if p.approach_started_s is not None]
        rules=engine.policy['psu']
        if len(committed)>=rules['approach_capacity'] or any(now-p.approach_started_s<rules['approach_headway_s'] for p in committed):
            return '선행 접근 간격 대기'
        if any(p.state!=psu.REFUSED and p.stand and p.approach_s is not None
               and p.approach_started_s is None and p.cleared_s<c.cleared_s for p in preceding):
            return '선행편 접근 개시 대기'
    if a.instruction.get('action') in ('yield','wait_clear') and flight['flight_id'] not in engine.psu.waiting.reservations:
        return a.instruction.get('reason') or '선행 기체 분리 대기'
    prepared=dict(flight,arrival_fato=c.fato,
                  arrival_stand=c.stand or c.planned_stand or flight.get('arrival_stand'))
    blockers=engine._terminal.blockers(prepared,engine._arrival_authority_route(a.route),'arrival')
    if blockers:
        return '접근 경로 점유 · '+', '.join(str(b.get('flight_id','미확인')) for b in blockers)
    capacity=engine._arrival_departure_capacity(c.vertiport,c.fato,flight['flight_id'],now)
    if not capacity.granted:
        return capacity.reason+' · 접근 또는 최종 하강 대기'
    if not c.deferred_stand and not engine.psu._stands.free(c.vertiport,c.stand,flight['flight_id']):
        return f'도착 {c.stand} 점유 또는 예약 충돌 · 최종 하강 금지'
    if engine.ground_control and not c.deferred_stand:
        phase=next((p for p in a.route.phases if p.stage=='gate_in'),None)
        if phase is None:
            return '착륙 후 지상 이동 경로 확인 필요'
        occupied=engine._gate_path_blockers(a,phase)
        if occupied:
            return '착륙 출구 확보 대기 · '+', '.join(occupied)
    if final:
        if engine._compute_remaining_native(a,include_queue=False)>engine.policy['psu']['final_guard_s']:
            return '허가된 도착 경로로 접근하세요 · 최종 접근 구간에서 착륙 요청'
        occupied=sorted((pad,owner) for (port,pad),owner in engine._active_pads.items()
            if port==c.vertiport and owner!=flight['flight_id']
            and engine._same_fato(port,c.fato,pad))
        if occupied:
            pad,owner=occupied[0]
            blocking=engine.flights.get(owner,{})
            aircraft_id=blocking.get('aircraft_id') or owner
            operation='출발편' if blocking.get('origin')==c.vertiport else '도착편'
            return (f'{pad} {operation} {aircraft_id} 점유 대기 · '
                    '최종 하강 금지')
        if any(p is not c and p.kind==psu.ARRIVAL and p.vertiport==c.vertiport and p.fato==c.fato
               and p.released_s is None and p.approach_started_s is not None
               and (p.approach_started_s,p.requested_s,p.flight_id)<(c.approach_started_s,c.requested_s,c.flight_id)
               for p in engine.psu._clearances.values()):
            return '선행 기체 착륙 완료 대기 · 최종 하강 금지'
        pad=engine.psu.pad(c.vertiport,c.fato)
        if pad.earliest(now,psu.ARRIVAL,engine.psu.tuning.landing_separation_s,exclude=flight['flight_id'])>now+.5:
            return '패드 예약 또는 실제 이착륙 분리 간격 대기 · 최종 하강 금지'
    return ''


def act(engine, a, flight, kind, now):
    ext = a.external
    reports = ext.setdefault('reports', {})
    if kind in reports:
        return {'state':'accepted','reason':'이미 접수된 보고입니다'}
    if not fresh(a):
        return {'state':'hold','reason':'기체 위치 수신을 기다리세요'}
    if kind == 'takeoff':
        if not ext['departed'] or not a.flight:
            return {'state':'refused','reason':'지상 이동 허가를 먼저 받으세요'}
        stop_reason=departure_stop_reason(engine,a,flight)
        if stop_reason:
            return {'state':'hold','reason':stop_reason}
        c = engine.psu.request_departure(flight_id=flight['flight_id'],vertiport=flight['origin'],
            fato=flight['departure_fato'],earliest_s=now,now_s=now)
        blockers = engine._departure_blockers(flight,a.route)
        if blockers or now < c.cleared_s:
            ext.pop('takeoff_cleared_s',None)
            return {'state':'hold','reason':'이륙 경로 점유' if blockers else '이륙 슬롯 시각 대기',
                    'cleared_s':c.cleared_s,'blocked_by':[b['flight_id'] for b in blockers]}
        ext['takeoff_cleared_s'] = now
        return {'state':'granted','reason':f"{flight['departure_fato']} 이륙 허가 · 이륙 후 보고하세요"}
    if kind == 'approach':
        reason=arrival_wait(engine,a,flight,now)
        if reason:return {'state':'hold','reason':reason}
        c=a.clearance
        if c.approach_s is None:
            c.approach_s=now  # non-predictive entry eligibility checked above
        rules=engine.policy['psu']
        if not engine.psu.begin_approach(flight['flight_id'],now,
                headway_s=rules['approach_headway_s'],capacity=rules['approach_capacity']):
            return {'state':'hold','reason':c.reason or '선행 접근 순번 대기'}
        engine._terminal.acquire(dict(flight,arrival_fato=c.fato,arrival_stand=c.stand),
                                 engine._arrival_authority_route(a.route),'arrival')
        c.state=psu.GRANTED
        a.external['approach_cleared_s']=now
        return {'state':'granted','reason':'접근 허가 · 도착 경로로 접근하세요 · 최종 하강은 별도 착륙 허가 필요'}
    if kind == 'landing':
        c = a.clearance
        reason=arrival_wait(engine,a,flight,now,final=True)
        if reason:
            ext.pop('landing_cleared_s',None)
            return {'state':'hold','reason':reason}
        prepared = dict(flight,arrival_fato=c.fato,
                        arrival_stand=c.stand or c.planned_stand or flight.get('arrival_stand'))
        engine._terminal.acquire(prepared,engine._arrival_authority_route(a.route),'arrival')
        engine._active_pads[(c.vertiport,c.fato)] = flight['flight_id']
        c.state=psu.GRANTED
        c.reason='최종 착륙 허가'
        ext['landing_cleared_s'] = now
        return {'state':'granted','reason':f"{c.vertiport} {c.fato} 착륙 허가 · 접지 후 보고하세요"}
    if kind == 'report_airborne':
        if not a.airborne or ext.get('observed_takeoff_s') is None:
            return {'state':'refused','reason':'이륙 관측이 없습니다. 지상에서 이륙 보고할 수 없습니다'}
        reports[kind] = now
        return {'state':'accepted','reason':'이륙 보고 접수 · 항로 비행 후 접근 순번을 요청하세요'}
    if kind == 'report_landed':
        if a.airborne or ext.get('observed_landing_s') is None:
            return {'state':'refused','reason':'도착 FATO 접지 관측 후 보고하세요'}
        reports[kind] = now
        engine._assign_landed_gates(now)
        c=a.clearance
        return {'state':'accepted','reason':(
            f'착륙 보고 접수 · {c.stand}까지 지정 지상경로로 이동하세요'
            if c and c.stand else '착륙 보고 접수 · FATO 정지 유지 · 접지 순서 GATE 배정 대기')}
    if kind == 'report_gate':
        c = a.clearance
        if not c or not c.stand or 'report_landed' not in reports:
            return {'state':'refused','reason':'착륙 보고와 도착 GATE 배정이 필요합니다'}
        reason=arrival_gate_stop_reason(engine,a,flight,c)
        if reason:
            return {'state':'refused','reason':reason}
        if not engine.psu._stands.free(flight['destination'],c.stand,flight['flight_id']):
            return {'state':'hold','reason':'도착 GATE 점유 · PSU 재확인 필요'}
        # Normal completion accounting, preserving the actual manual pose.
        pose=(a.latitude,a.longitude,a.altitude,a.heading)
        engine._arrive(a,now)
        a.place(*pose)
        ext['completed'] = True; reports[kind] = now
        return {'state':'accepted','reason':'GATE 도착 보고 접수 · TURNAROUND에서 하차·충전을 요청하세요'}
    raise ValueError(f'{kind}: 알 수 없는 조종사 요청입니다')


def ground_chart(engine, a, flight):
    """Assigned route geometry and actual ground occupancy, not a new clearance."""
    ext=a.external
    arriving=a.airborne or ext.get('reports',{}).get('report_landed') is not None
    port=flight['destination' if arriving else 'origin']
    stage='gate_in' if arriving else 'gate_out'
    phase=next((p for p in (a.route.phases if a.route else []) if p.stage==stage),None)
    points=[{'latitude_deg':p[0],'longitude_deg':p[1]} for p in phase.points] if phase else []
    # Never draw a cached arrival route toward a previously assigned gate.
    if points:
        layout=engine._layout(port)
        target_id=(a.clearance.stand if a.clearance else flight.get('arrival_stand')) if arriving else flight.get('departure_fato')
        target=next((x for x in layout.get('gates' if arriving else 'fatos',[]) if x['id']==target_id),None)
        if target:
            east,north=target['center_m'];frame=layout['frame'];last=points[-1]
            delta=math.hypot((last['latitude_deg']-frame['latitude'])*111320-north,
                (last['longitude_deg']-frame['longitude'])*111320*math.cos(math.radians(frame['latitude']))-east)
            if delta>max(5,target.get('radius_m',5)):points=[]
        else:points=[]
    occupied=[]
    for observation in engine._ground_observations():
        if observation.vertiport_id!=port or observation.aircraft_id==a.aircraft_id:continue
        other=engine.aircraft.get(observation.aircraft_id)
        if other:occupied.append({'aircraft_id':other.aircraft_id,'latitude_deg':other.latitude,
                                  'longitude_deg':other.longitude,'radius_m':observation.radius_m})
    return {'vertiport':port,'points':points,'occupied':occupied,
            'taxi_granted':bool(not a.airborne and fresh(a) and
                (ext.get('reports',{}).get('report_landed') is not None if arriving else ext.get('departed')))}


def guidance(engine,a,flight,now):
    ext=a.external;reports=ext.get('reports',{});c=a.clearance
    # Completion releases the aircraft's active clearance, not the historical
    # assignment. Never fall back to the original planned gate after reporting.
    if ext.get('completed'):
        c=engine.psu.clearance(flight['flight_id'],psu.ARRIVAL)
    arrival_gate=c.stand if c else (a.stand if ext.get('completed') else flight.get('arrival_stand'))
    if (ext.get('takeoff_cleared_s') is not None and not a.airborne and a.flight
            and engine._departure_blockers(flight,a.route)):
        ext.pop('takeoff_cleared_s',None)
        ext['last_answer']={'kind':'takeoff','state':'hold','reason':'이륙 경로 점유 변경 · 허가 재확인 필요'}
    departure=engine.psu.clearance(flight['flight_id'],psu.DEPARTURE)
    ready=earliest_departure(engine,a,flight)
    reason='';tone='hold';stage='준비';text='GATE 대기 · 출발 준비 후 허가 요청'
    arrival_timing=None
    kind,label,enabled='departure','출발 준비 · 이동 요청',now>=ready
    if not enabled: reason='계획 출발·회항 준비·도착 진입 순서 시각 대기'
    if not ext['departed'] and now<ext.get('initial_priority_until_s',-1):
        text='초기 우선 출발편 · GATE에서 출발 준비 · 이동 요청'
        if not reason:reason='초기 2분 출발 요청 우선 · 지상 이동 허가는 별도입니다'
    if not ext['departed'] and not enabled:
        remaining=max(0,math.ceil(ready-now))
        stage='출발 시각 대기'
        text=f'출발 요청까지 {remaining//60}분 {remaining%60}초 · GATE 대기'
        label=f'출발 요청 대기 · {remaining//60}분 {remaining%60}초'
        seconds=math.ceil(ready)
        at=f'{seconds//3600:02d}:{seconds//60%60:02d}:{seconds%60:02d}'
        reason=f'요청 가능 시각 {at} · 시각 도달은 이동 허가가 아닙니다'
    if ext.get('departure_pending') and not ext['departed']:
        stage,text='출발 배정 대기','출발 요청 접수 · PSU 자동 재검토 중 · GATE 대기 유지'
        label,enabled='요청 접수됨 · 자동 배정 대기',False
    if ext.get('completed'):
        stage,text,tone='도착 완료','하차·충전은 TURNAROUND에서 요청','info'
        reason=f"{flight['destination']} {arrival_gate or 'GATE 미확인'} 도착 보고 완료 · 추가 이동 지시 없음"
        kind,label,enabled=None,'운항 보고 완료',False
    elif not a.airborne and 'report_landed' in reports:
        if c and c.stand:
            stage,text='도착 지상 이동',f"{flight['destination']} · {c.stand}로 이동 후 정차 보고"
            reason=arrival_gate_stop_reason(engine,a,flight,c)
            kind,label,enabled='report_gate','GATE 도착 보고',not bool(reason)
        else:
            stage,text,tone='GATE 배정 대기','FATO 정지 유지 · 접지 순서대로 GATE 배정 중','hold'
            kind,label,enabled=None,'GATE 배정 대기',False
            reason='사용 가능한 GATE와 지상경로를 재확인하고 있습니다'
    elif not a.airborne and ext.get('observed_landing_s') is not None:
        stage,text='접지 관측','착륙 보고를 보내세요'
        kind,label,enabled='report_landed','착륙 완료 보고',True
    elif a.airborne:
        stage,text,tone='항로 비행','항로 유지 · 접근 순번 요청 기준을 기다리세요','info'
        kind,label,enabled='arrival','접근 순번 요청',False
        if 'report_airborne' not in reports:
            text='이륙 관측 · PSU에 이륙 보고를 보내세요'
            kind,label='report_airborne','이륙 완료 보고'
            enabled=True
        else:
            # This is the same remaining-route ETA used by the pilot's request
            # trigger. Publish it with the advisory so NAV never shows a
            # different countdown based only on instantaneous ground speed.
            arrival_timing=engine._pilot_arrival_request_decision(a)
        if 'report_airborne' in reports and not c:
            decision=arrival_request_readiness(engine,a,flight,now,arrival_timing)
            enabled=bool(decision['due'])
            reason=decision['reason']
            if enabled:
                stage='접근 순번 요청 가능'
                text='조종사 요청 기준 도달 · PSU에 접근 순번을 요청하세요'
        elif c and c.state!=psu.REFUSED and c.released_s is None:
            approached=c.approach_started_s is not None
            reason=arrival_wait(engine,a,flight,now,final=approached)
            kind,label='landing','최종 착륙 허가 요청' if approached else '접근 허가 요청'
            if not approached:kind='approach'
            enabled=not bool(reason)
            if not approached:
                stage='접근 대기' if reason else '접근 요청 가능'
                bay=a.hold if isinstance(a.hold,dict) else {}
                where=(bay.get('slot') or '').rsplit('/',1)[-1]
                text=(f'{where} 대기점에서 대기' if where else '현재 허가된 경로·고도 유지')+' · 접근 허가 전 접근 금지'
                if not reason:reason='지금 접근 허가를 요청하세요 · 예상 접지 시각까지 기다리지 않습니다'
            else:
                stage,text,tone='접근 허가','도착 경로로 접근하세요 · 착륙 허가 전 최종 하강 금지','info'
                if enabled:
                    stage='착륙 요청 가능'
                    reason='최종 접근 구간 · 지금 최종 착륙 허가를 요청하세요'
                elif reason and '허가된 도착 경로로 접근' not in reason:
                    stage,text,tone='접근 보류','추가 접근·최종 하강 금지 · 아래 대기 사유를 확인하세요','hold'
            if ext.get('landing_cleared_s') is not None:
                if not arrival_wait(engine,a,flight,now,final=True):
                    stage,text,tone='착륙 허가',f"{c.vertiport} {c.fato} 최종 하강·착륙 허가 · 접지 후 보고",'go'
                    kind,label,enabled='report_landed','착륙 완료 보고',False
                    reason='아직 공중 · 접지 관측 후 보고 가능'
                else:
                    ext.pop('landing_cleared_s',None)
                    stage,text,tone='착륙 허가 보류','최종 하강 중단 · 허가 재확인 필요','hold'
    elif ext['departed']:
        stage,text,tone='지상 이동 허가',f"{flight['origin']} {flight['departure_fato']}로 지상 이동 · 이륙은 별도 허가",'info'
        reason=departure_stop_reason(engine,a,flight)
        kind,label,enabled='takeoff','FATO 도착 · 이륙 요청',not bool(reason)
        if ext.get('takeoff_cleared_s') is not None:
            stage,text,tone='이륙 허가',f"{flight['departure_fato']}에서 이륙하세요 · 이륙 후 보고",'go'
            kind,label,enabled='report_airborne','이륙 완료 보고',False
            reason='아직 지상 · 이륙 관측 후 보고 가능'
    if not a.airborne and not ext.get('completed') and a.instruction.get('action')=='ground_wait':
        stage,text,tone='지상 대기','정지 유지 · 지상 이동 지시를 재확인하세요','hold'
        reason=a.instruction.get('reason') or '지상 경로 점유'
        enabled=False
    last=ext.get('last_answer') or {}
    if kind not in ('approach','landing') and last.get('state') in ('hold','refused') and last.get('kind')==kind:
        reason=last.get('reason') or reason
    if kind not in (None,'departure') and not fresh(a):
        enabled=False;reason='기체 위치 수신 지연 · 재확인 필요';tone='hold'
        stage='위치 수신 대기';text='새 관측으로 현재 운항 지시를 재확인하세요'
    return {'version':2,'stage':stage,'text':text,'tone':tone,'reason':reason,
            'next':{'kind':kind,'label':label,'enabled':enabled},
            'timeline':{'now_s':now,'off_block_s':flight.get('off_block_s'),'ready_s':ready,
                        'takeoff_s':departure.cleared_s if departure else None,
                        'landing_s':c.cleared_s if c else None,
                        'remaining_route_eta_s':None if arrival_timing is None else arrival_timing['remaining_s'],
                        'arrival_request_lead_s':None if arrival_timing is None else arrival_timing['lead_s'],
                        'arrival_request_due':None if arrival_timing is None else arrival_timing['due']},
            'ground_chart':ground_chart(engine,a,flight),
            'origin':flight['origin'],'destination':flight['destination'],
            'departure_fato':flight.get('departure_fato'),'departure_gate':flight.get('departure_stand'),
            'arrival_fato':c.fato if c else flight.get('arrival_fato'),
            'arrival_gate':arrival_gate,
            'reports':dict(reports),'communications':list(ext.get('communications',[]))}
