"""Select an executable terminal plan before native flight starts.

Alternatives must have a compatible FATO role, a taxi path, and a real directed
network connection for every changed terminal leg. Supplied en-route waypoint
order is preserved. Once departure permission is issued, the engine retains
the selected plan; this module never changes an airborne native route.
"""
from itertools import product
from digital_twin.model_library import scheduled_route
from digital_twin.simulation.psu_sequencing import PadTimeline, ARRIVAL, DEPARTURE


def options(engine, flight):
    supplied = engine._supplied_routes.get(tuple(flight.get('route_path') or ()))
    links = {(r['from'],r['to']) for r in (engine._network or {}).get('links', ())}
    choices = []
    for place,role,key in [(flight['origin'],'takeoff','departure_fato'),(flight['destination'],'landing','arrival_fato')]:
        pads = [p['id'] for p in engine._layout(place).get('fatos', ()) if p.get('role') in (role,'both')]
        choices.append(sorted(pads, key=lambda pad:(pad!=flight.get(key),pad)))
    if not engine.policy['psu'].get('allocate_fatos',True):
        choices = [[flight['departure_fato']],[flight['arrival_fato']]]
    available, rejected = [], []
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
                    resolved = scheduled_route.resolve(engine._network,path,first,last,engine._provisional_names)
                    engine._supplied_routes[tuple(path)] = resolved
                    candidate['route_path'] = path
            route = engine.route(candidate)
            available.append((candidate,route))
        except ValueError as error:
            rejected.append({'departure_fato':departure,'arrival_fato':arrival,'reason':str(error)})
    if not available:
        raise ValueError(rejected[0]['reason'] if rejected else '사용 가능한 FATO가 없습니다')
    return available,rejected


def choose(available, psu, now, arrival_forecasts, blocked, *, entry_wait=None):
    scored = []
    for flight,route in available:
        taxi = route.phases[0].duration_s if route.phases[0].stage=='gate_out' else 0
        departure = psu.pad(flight['origin'],flight['departure_fato'])
        departure_wait = max(0,departure.earliest(now+taxi,DEPARTURE,psu.tuning.departure_separation_s)-(now+taxi))
        # Admission slots also belong to aircraft still parked at their gates.
        # Compare their cost without reserving any candidate or changing a route.
        admission_wait = max(0, entry_wait(flight, route, now+departure_wait)) if entry_wait else 0
        eta = now+departure_wait+admission_wait+route.remaining_to_touchdown(0,0)
        actual = psu.pad(flight['destination'],flight['arrival_fato'])
        forecast = PadTimeline('candidate',psu.tuning);forecast.slots=list(actual.slots);forecast.observed=list(actual.observed)
        booked = {row[2] for row in forecast.slots}
        for other in arrival_forecasts:
            if (other['flight_id'] not in booked and other['vertiport']==flight['destination']
                    and other['fato']==flight['arrival_fato']):
                forecast.hold(max(now,other['eta_s']),psu.tuning.landing_separation_s,other['flight_id'],ARRIVAL)
        landing = forecast.earliest(eta,ARRIVAL,psu.tuning.landing_separation_s)
        blockers = blocked(flight,route)
        # Earliest feasible completion first, then queue pressure and stable IDs.
        score = (bool(blockers),landing,len(forecast.slots),departure_wait,
                 flight['departure_fato'],flight['arrival_fato'])
        scored.append((score,flight,route,{'departure_wait_s':round(departure_wait,1),
            'entry_wait_s':round(admission_wait,1), 'arrival_wait_s':round(max(0,landing-eta),1),'forecast_touchdown_s':round(landing,1),
            'blockers':blockers}))
    _,flight,route,assessment = min(scored,key=lambda item:item[0])
    return flight,route,assessment
