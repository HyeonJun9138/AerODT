"""Pre-approach FATO/stand bundles. Observations are read, never repositioned."""
import math

from digital_twin.model_library import flight_plan, scheduled_route
from digital_twin.model_library.ground_routes import route_geometry
from digital_twin.simulation import psu_sequencing

REVIEW_SECONDS = 5.0
SWITCH_GAIN_SECONDS = 15.0


def candidate_route(engine, aircraft, fato, stand, cache):
    """Preserve the existing entry and flown prefix, replace only its terminal branch."""
    from digital_twin.simulation.scenario_engine import Phase, Route
    old=aircraft.route;d=old.descent_index
    descent=old.phases[d]
    anchor=tuple(descent.detail.get('psu_rejoin',descent.points[0]))
    key=(fato,stand,anchor,tuple(descent.points[0]))
    if key in cache:return cache[key]
    cache[key]=None
    flight=dict(aircraft.flight,arrival_fato=fato,arrival_stand=stand)
    if flight.get('route_path') is not None:
        path=list(flight['route_path'])
        supplied=engine._supplied_routes.get(tuple(path))
        if not supplied:return None
        endpoint=f"fato:{flight['destination']}:{fato}"
        if (supplied['nodes'][-2],endpoint) not in {
                (link['from'],link['to']) for link in engine._network.get('links',())}:return None
        path[-1]=endpoint
        try:
            engine._supplied_routes[tuple(path)]=scheduled_route.resolve(engine._network,path,
                path[0],endpoint,engine._provisional_names)
        except ValueError:return None
        flight['route_path']=path
    try:base=engine.route(flight)
    except ValueError:return None
    if base.descent_index is None or tuple(base.phases[base.descent_index].points[0])!=anchor:return None
    tail=list(base.phases[base.descent_index:])
    if 'psu_rejoin' in descent.detail:
        first=tail[0];bay=descent.points[0]
        # The same shape the flown route has: through the entry, or - when the
        # day flies its approaches straight from the bay - to the descent
        # itself, so a candidate is not costed for a return the aircraft
        # would never fly.
        direct=bool(descent.detail.get('psu_direct')) and len(first.points)>1
        approach=first.points[1:] if direct else list(first.points)
        extra=flight_plan.haversine_m(bay[:2],approach[0][:2])/max(1.,engine.policy['pilot']['approach_horizontal_speed_mps'])
        extra+=abs(bay[2]-approach[0][2])/max(.1,engine.policy['pilot']['descent_rate_mps'])
        tail[0]=Phase(first.stage,first.label,[bay,*approach],first.duration_s+extra,first.speed_mps,
            dict(first.detail,psu_rejoin=anchor,psu_direct=direct,psu_inbound=descent.detail.get('psu_inbound',anchor)))
    result=Route(('arrival-choice',aircraft.flight['flight_id'],fato,stand,anchor),
        [*old.phases[:d],*tail],base.arrival,old.departure)
    result.boarding,result.alighting=old.boarding,base.alighting;result.direct=old.direct
    cache[key]=(flight,result)
    return cache[key]


def review(engine, aircraft, now, ground_observations=None):
    """Called on the serialized decision thread before submitting native work."""
    c=aircraft.clearance;owner=aircraft.flight['flight_id'] if aircraft.flight else None
    if (not c or not aircraft.airborne or aircraft.failed or not aircraft.pilot_active
            or not engine.policy['psu'].get('allocate_fatos',True)
            or c.approach_started_s is not None or c.used_s is not None or c.released_s is not None
            or c.state==psu_sequencing.REFUSED or engine._at_final_gate(aircraft)
            or (owner,'arrival') in engine._terminal.claims
            or owner in engine._active_pads.values()):return False
    route=aircraft.route
    if route.descent_index is None or not engine._near_queue_entry(aircraft):return False
    state=engine._arrival_reviews.setdefault(owner,{'next_s':-math.inf,'routes':{}})
    if now<state['next_s']:return False
    state['next_s']=now+REVIEW_SECONDS
    if not getattr(getattr(engine.pilots,'library',None),'arrival_reassignment_capable',False):
        engine._decision(now,aircraft.flight,'arrival_allocate','retained','착륙 자원 재평가에는 native ABI 6이 필요합니다')
        return False
    port=aircraft.flight['destination'];policy=engine.policy['pilot']
    observations=tuple(engine._ground_observations()) if ground_observations is None else ground_observations
    traffic=engine._queue_observations()
    geometry_cache=state.setdefault('ground_geometry',{})
    stands=[s for s in engine._stands_of(port) if engine.psu._stands.free(port,s,owner)
            and (engine.psu.tuning.reassign_stand or s==c.planned_stand)]
    candidates=[];report=[];current_score=math.inf
    current_remaining=engine._remaining_native(aircraft)
    old_tail=sum(p.duration_s for p in route.phases[route.descent_index:route.landing_index+1])
    for pad in engine._layout(port).get('fatos',()):
        fato=pad['id']
        if pad.get('role') not in ('both','landing'):continue
        row={'fato':fato,'available_gates':0,'reason':'연결 항로 또는 사용 가능한 주기장 없음'}
        report.append(row)
        if engine.psu.resource_monitor is not None:
            state=engine.psu.resource_monitor.resource(port,'fato',fato,now)
            if state is None or not state.usable:
                row['reason']='버티포트 보고상 FATO 사용 불가';continue
        if any(place==port and held!=owner and engine._nearby_pads(port,fato,other)
                for (place,other),held in engine._active_pads.items()):
            row['reason']='FATO 또는 인접 패드 실제 점유';continue
        pad_best=None;air_checked=False;air_reason=None
        for stand in stands:
            pair=candidate_route(engine,aircraft,fato,stand,state['routes'])
            if pair is None:continue
            f,r=pair
            ground=next((p for p in r.phases if p.stage=='gate_in'),None)
            if ground is None:continue
            if r.key not in geometry_cache:
                geometry_cache[r.key]=route_geometry(tuple(engine._ground_xy(port,p) for p in ground.points))
            if engine._gate_path_blockers(aircraft,ground,observations,geometry=geometry_cache[r.key]):
                row['reason']='착륙 후 게이트 이동 경로 점유';continue
            # Gates change taxi geometry, not this FATO's airborne branch.
            # Reuse only within this review: next review reads fresh traffic.
            if not air_checked:
                authority=engine._arrival_authority_route(r)
                if engine._terminal.blockers(f,authority,'arrival'):
                    air_reason='접근 경로 예약 충돌'
                elif any(not engine.psu.waiting.transfer_clear(owner,a,b,traffic,
                        policy['traffic_horizontal_m'],policy['traffic_vertical_m'],policy['traffic_lookahead_s'])
                        for phase in authority.phases if phase.stage in ('descent','landing')
                        for a,b in zip(phase.points,phase.points[1:])):
                    air_reason='접근 경로 관측 교통 충돌'
                air_checked=True
            if air_reason:
                row['reason']=air_reason;break
            # Geometry/speed estimate only: never launch a native rehearsal in a tick.
            new_tail=sum(p.duration_s for p in r.phases[r.descent_index:r.landing_index+1])
            eta=now+max(0.,current_remaining+new_tail-old_tail)+engine.policy['psu']['prediction_buffer_s']
            landing=engine.psu.pad(port,fato).earliest(eta,psu_sequencing.ARRIVAL,
                engine.psu.tuning.landing_separation_s,exclude=owner)
            score=landing+ground.duration_s
            row['available_gates']+=1
            item=(score,fato!=c.fato,stand!=c.stand,fato,stand,eta,f,r)
            candidates.append(item)
            if fato==c.fato and stand==c.stand:current_score=score
            pad_best=score if pad_best is None else min(pad_best,score)
        if pad_best is not None:
            # Keep repeated unchanged reviews deduplicable by _decision.
            # A continuously drifting ETA alone is not a resource decision.
            row['reason']='후보 사용 가능'
    if not candidates:
        engine._decision(now,aircraft.flight,'arrival_allocate','hold','사용 가능한 FATO·주기장·출구 조합 없음',candidates=report)
        return False
    best=min(candidates,key=lambda item:item[:5]);score,_,_,fato,stand,eta,f,replacement=best
    if (fato==c.fato and stand==c.stand) or score+SWITCH_GAIN_SECONDS>=current_score:
        engine._decision(now,aircraft.flight,'arrival_allocate','retained','현재 착륙 배정 유지 · 변경 이득 부족',candidates=report)
        return False
    if fato==c.fato:
        accepted=engine._retarget_arrival_gate(aircraft,stand)
        engine._decision(now,aircraft.flight,'arrival_allocate','selected' if accepted else 'retained',
            '같은 FATO의 주기장·출구 재평가',candidates=report,arrival_fato=fato,arrival_stand=stand)
        return accepted
    before=(c.fato,c.stand)
    try:
        accepted=engine.psu.reassign_arrival(owner,fato,stand,eta,now,
            lambda:engine.pilots.replace_arrival(aircraft.aircraft_id,replacement))
    except (RuntimeError,ValueError,OSError) as error:
        engine._decision(now,aircraft.flight,'arrival_allocate','retained','착륙 경로 갱신 실패 · 기존 배정 유지',error=str(error))
        return False
    if not accepted:
        engine._decision(now,aircraft.flight,'arrival_allocate','retained','현재 목표 이후의 접근 경로만 변경 가능',candidates=report)
        return False
    aircraft.flight,aircraft.route=f,replacement
    aircraft.gate_revision+=1
    engine._entry_forecasts.pop(owner,None)
    engine._record(now,'arrival_reassigned',f,previous_fato=before[0],previous_stand=before[1],
        fato=fato,stand=stand,reason=c.reason)
    engine._decision(now,f,'arrival_allocate','selected',c.reason,candidates=report,
        arrival_fato=fato,arrival_stand=stand,previous_fato=before[0],estimated_in_block_s=round(score,1))
    return True
