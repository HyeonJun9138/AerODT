from digital_twin.simulation import manual_takeover as manual
from test_manual_takeover import day
from test_scenario_engine import row, engine_of, build_network, VERTIPORTS, NODES, LINKS

def opening():
    reverse=[dict(LINKS[0],id='R1',**{'from':'fato:VP2:F1','to':'WP2'}),
             dict(LINKS[1],id='R2',**{'from':'WP2','to':'WP1'}),
             dict(LINKS[2],id='R3',**{'from':'WP1','to':'fato:VP1:F2'})]
    return engine_of(row('F1','A1','VP1','VP2','06:30:00',stand='G1'),
               row('F2','A2','VP1','VP2','06:30:00',stand='G2'),
               row('F3','A3','VP2','VP1','06:30:00',stand='G3'),
               network=build_network(NODES,LINKS+reverse,VERTIPORTS))

def test_last_aircraft_selected_before_play_owns_first_slot_and_departure():
    e=opening()
    try:
        manual.hand_over(e,'A2')
        assert next(iter(e._entry_forecasts))=='F2'
        a=e.aircraft['A2'];pose=(a.latitude,a.longitude,a.altitude)
        e.advance(e.time_s+1)
        assert e.aircraft['A1'].flight is None
        assert e.aircraft['A3'].flight is not None, 'other ports keep operating'
        assert a.flight is None and not a.external['departed'], 'reservation is not permission'
        assert manual.request(e,'A2','departure')['state']=='granted'
        assert a.flight['flight_id']=='F2' and pose==(a.latitude,a.longitude,a.altitude)
    finally:e.close()

def test_opening_priority_expires_without_unlimited_automatic_ground_stop():
    e=opening()
    try:
        manual.hand_over(e,'A2')
        due=e.aircraft['A2'].external['initial_priority_until_s']
        assert manual.initial_departure_owner(e,'VP1',due-1)=='A2'
        assert manual.initial_departure_owner(e,'VP1',due) is None
        manual.prepare_initial_departure(e,e.aircraft['A2'],due)
        assert 'F2' not in e._entry_forecasts
        e._maybe_depart(e.aircraft['A1'],due)
        assert e.aircraft['A1'].flight is not None
    finally:e.close()

def test_running_day_handover_prioritises_only_new_departures_and_never_overrides_occupied_pad():
    e=opening()
    try:
        e._maybe_depart(e.aircraft['A1'],e.time_s)
        active=e.aircraft['A1'].flight
        manual.hand_over(e,'A2')
        assert e.aircraft['A1'].flight is active, 'already-started traffic is never pre-empted'
        assert manual.initial_departure_owner(e,'VP1',e.time_s)=='A2'
        e._departure_blockers=lambda *args:[{'flight_id':'F1'}]
        assert manual.request(e,'A2','departure')['state']=='hold'
    finally:e.close()

def test_submitted_opening_request_keeps_priority_after_the_two_minute_offer_expires():
    e=opening()
    try:
        manual.hand_over(e,'A2')
        e._departure_blockers=lambda *args:[{'flight_id':'F1'}]
        assert manual.request(e,'A2','departure')['state']=='hold'
        due=e.aircraft['A2'].external['initial_priority_until_s']
        manual.prepare_initial_departure(e,e.aircraft['A2'],due+300)
        assert manual.initial_departure_owner(e,'VP1',due+300)=='A2'
        manual.request_hold(e,'A2',now=due+301)
        assert manual.initial_departure_owner(e,'VP1',due+301) is None
    finally:e.close()

def test_request_cancel_keeps_the_remaining_opening_offer_but_release_removes_it():
    e=opening()
    try:
        manual.hand_over(e,'A2')
        e._departure_blockers=lambda *args:[{'flight_id':'F1'}]
        manual.request(e,'A2','departure')
        manual.request(e,'A2','hold')
        assert manual.initial_departure_owner(e,'VP1',e.time_s)=='A2', (
            '출발 요청 취소는 아직 남은 2분 우선 기회까지 포기하는 조작이 아니다')
        manual.release(e,'A2')
        assert manual.initial_departure_owner(e,'VP1',e.time_s) is None
    finally:e.close()

def test_native_forecast_preparation_cannot_lose_first_arrival_place():
    from types import SimpleNamespace
    e=opening()
    try:
        e.pilots=SimpleNamespace(prepare_entry_estimate=lambda *args:False,close=lambda:None)
        f=e.flights['F2'];route=e.route(f)
        e._select_fatos=lambda flight,now:(flight,route)
        manual.hand_over(e,'A2')
        assert 'F2' not in e._entry_forecasts
        assert manual.initial_departure_owner(e,'VP3',e.time_s,destination='VP2',arrival_fato='F2')=='A2'
        assert manual.initial_departure_owner(e,'VP3',e.time_s,destination='VP2',arrival_fato='F4') is None
        e.pilots.prepare_entry_estimate=lambda *args:True
        manual.prepare_initial_departure(e,e.aircraft['A2'],e.time_s+1)
        assert next(iter(e._entry_forecasts))=='F2'
        assert manual.initial_departure_owner(e,'VP3',e.time_s+1,destination='VP2',arrival_fato='F2') is None
    finally:e.close()
