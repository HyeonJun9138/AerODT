"""Construct executable terminal-plan alternatives before native flight starts.

Alternatives must have a compatible FATO role, a taxi path, and a real directed
network connection for every changed terminal leg. Supplied en-route waypoint
order is preserved. The PSU compares and selects the alternatives; this module
does not make an operational decision or change an airborne native route.
"""
from itertools import product
from digital_twin.model_library import scheduled_route


def options(engine, flight):
    supplied = engine._supplied_routes.get(tuple(flight.get('route_path') or ()))
    # The network is the engine's for its whole life; its link set is built once,
    # not once per review of every waiting flight's pads on every tick.
    links = getattr(engine, '_network_link_pairs', None)
    if links is None:
        links = {(r['from'],r['to']) for r in (engine._network or {}).get('links', ())}
        try:
            engine._network_link_pairs = links
        except AttributeError:
            pass
    choices = []
    for place,role,key in [(flight['origin'],'takeoff','departure_fato'),(flight['destination'],'landing','arrival_fato')]:
        pads = [p['id'] for p in engine._layout(place).get('fatos', ()) if p.get('role') in (role,'both')]
        choices.append(sorted(pads, key=lambda pad:(pad!=flight.get(key),pad)))
    if not engine.policy['psu'].get('allocate_fatos',True):
        choices = [[flight['departure_fato']],[flight['arrival_fato']]]
    available, rejected = [], []
    # Arrival-pad alternatives share the same stand-to-departure-pad review.
    # Keep this local: the NEXT review must observe new traffic and claims.
    departure_proposals = {}
    for departure,arrival in product(*choices):
        candidate = dict(flight, departure_fato=departure, arrival_fato=arrival)
        try:
            if flight.get('route_path') is not None:
                path = list(flight['route_path'])
                if supplied is None:
                    raise ValueError('기존 지정 항로를 해석할 수 없습니다')
                first,last = f"fato:{flight['origin']}:{departure}",f"fato:{flight['destination']}:{arrival}"
                resolved_nodes = list(supplied['nodes'])
                resolved_nodes[0], resolved_nodes[-1] = first, last
                if departure != flight['departure_fato']:
                    if (first,resolved_nodes[1]) not in links:
                        raise ValueError('대체 출발 FATO의 연결 항로가 없습니다')
                    path[0] = first
                if arrival != flight['arrival_fato']:
                    if (resolved_nodes[-2],last) not in links:
                        raise ValueError('대체 도착 FATO의 연결 항로가 없습니다')
                    path[-1] = last
                if path != flight['route_path']:
                    # The engine owns a fixed network and already stores resolved
                    # geometry. Do not rebuild its whole air graph every tick.
                    if tuple(path) not in engine._supplied_routes:
                        engine._supplied_routes[tuple(path)] = scheduled_route.resolve(
                            engine._network,path,first,last,engine._provisional_names)
                    candidate['route_path'] = path
            if departure not in departure_proposals:
                departure_proposals[departure] = (engine._departure_ground_proposals(candidate)
                    if hasattr(engine, '_departure_ground_proposals') else ())
            ground_routes = departure_proposals[departure]
            if engine.ground_control and hasattr(engine.ground_control, 'propose_routes') and not ground_routes:
                raise ValueError('선택한 주기장에서 FATO로 연결되는 지상 경로가 없습니다')
            for ground_route in ground_routes or (None,):
                routed = (dict(candidate, _departure_ground_route=ground_route)
                          if ground_route is not None else candidate)
                route = engine.route(routed)
                available.append((routed,route))
        except ValueError as error:
            rejected.append({'departure_fato':departure,'arrival_fato':arrival,'reason':str(error)})
    if not available:
        raise ValueError(rejected[0]['reason'] if rejected else '사용 가능한 FATO가 없습니다')
    return available,rejected


def choose(available, psu, now, arrival_forecasts, blocked, *, entry_wait=None):
    """Compatibility wrapper; the PSU owns candidate ordering and selection."""
    return psu.select_departure_plan(available, now, arrival_forecasts, blocked,
                                     entry_wait=entry_wait)
