"""Scenario energy accounting. Does not grant clearance or modify native flight."""
from digital_twin.model_library import flight_plan
from digital_twin.simulation.uam_energy import demand_kw


def record(engine, aircraft, now, kind):
    e = aircraft.energy
    flight = aircraft.flight or engine.flights.get(e.flight_id)
    if flight:
        engine._record(now, kind, flight, phase=aircraft.phase, energy=e.snapshot(),
                       vertiport=aircraft.vertiport, stand=aircraft.stand,
                       charger_id=(e.connection or {}).get('charger_id'))


def depart(engine, aircraft, flight, now):
    e = aircraft.energy
    if e.connection:
        record(engine, aircraft, now, 'charging_disconnected')
    e.connection, e.parked_at = None, None
    e.charge_state = 'disconnected'
    e.charge_power_kw = 0.0
    e.flight_id = flight['flight_id']
    e.flight_start_used, e.flight_start_deficit = e.used_kwh, e.deficit_kwh
    e.flight_start_charged, e.flight_start_grid = e.charged_kwh, e.grid_kwh
    e.warned.clear()
    e.last_sample_s, e.last_phase = now, None
    record(engine, aircraft, now, 'battery_flight_start')


def arrive(engine, aircraft, now):
    e = aircraft.energy
    # Manual ground handling owns explicit door/charging requests. A gate report
    # is not consent to start the fleet's automatic turnaround timer.
    e.parked_at, e.charge_state = (None, 'disconnected') if aircraft.external else (now, 'connecting')
    e.power_kw = e.charge_power_kw = 0.0
    record(engine, aircraft, now, 'battery_flight_end')


def _connection(engine, aircraft):
    layout = engine._layout(aircraft.vertiport)
    charger = next((c for c in layout.get('chargers', ()) if c.get('gate') == aircraft.stand), None)
    gate = next((g for g in layout.get('gates', ()) if g['id'] == aircraft.stand), None)
    if not charger or not gate:
        return None
    # The socket is on the cabinet face toward this stand, not in its centre.
    x, y = charger['center_m']
    dx, dy = gate['center_m'][0]-x, gate['center_m'][1]-y
    side = layout.get('dimensions', {}).get('charger_size_m', 2)
    t = side/2/max(abs(dx), abs(dy), .01)
    lat, lon = flight_plan._local_to_global(layout['frame'], x+dx*t, y+dy*t)
    p = aircraft.energy.profile
    return {'charger_id': charger['id'], 'vertiport_id': aircraft.vertiport,
            'longitude_deg': lon, 'latitude_deg': lat,
            'altitude_m': engine._deck_height(aircraft.vertiport)+1.1,
            'port_right_m': p['connector_right_m'], 'port_height_m': p['connector_height_m']}


def advance(engine, aircraft, now, seconds):
    e, p = aircraft.energy, aircraft.energy.profile
    prior = e.charge_state
    if aircraft.phase == 'parked' and e.parked_at is not None and not aircraft.external:
        eligible = e.parked_at+p['connect_delay_s']
        if aircraft.unloading:
            eligible = max(eligible, aircraft.unloading['from_s']+aircraft.unloading['duration_s'])
        still = aircraft.speed_mps <= .05
        # Do not call _stand_place here: it also plans a taxi route/heading.
        # A battery tick only needs the authored centre, not another A* search.
        layout = engine._layout(aircraft.vertiport)
        gate = next((g for g in layout.get('gates', ()) if g['id'] == aircraft.stand), None)
        point = flight_plan._local_to_global(layout['frame'], *gate['center_m']) if gate else None
        still = still and point is not None and flight_plan.haversine_m(point, (aircraft.latitude, aircraft.longitude)) <= 1
        still = still and abs(aircraft.altitude-engine._deck_height(aircraft.vertiport)) <= .5
        still = still and engine.psu._stands.occupant(aircraft.vertiport, aircraft.stand) == aircraft.aircraft_id
        if still and now >= eligible:
            if e.connection is None:
                e.connection = _connection(engine, aircraft)
                if e.connection:
                    e.charge_state = 'charging'
                    record(engine, aircraft, now, 'charging_connected')
            if e.connection:
                e.charge(min(seconds, max(0, now-eligible)))
                e.charge_state = 'complete' if e.soc_pct >= p['charge_target_pct']-1e-8 else 'charging'
                if prior != 'complete' and e.charge_state == 'complete':
                    record(engine, aircraft, now, 'charging_complete')
            else:
                e.charge_state = 'unavailable'
                if prior != 'unavailable':
                    record(engine, aircraft, now, 'charging_unavailable')
        else:
            e.connection = None
            e.charge_state = 'connecting'
            e.power_kw = e.charge_power_kw = 0.0
    else:
        e.power_kw = e.charge_power_kw = 0.0
        if aircraft.flight and not aircraft.failed:
            power = demand_kw(p, aircraft.phase, aircraft.speed_mps, aircraft.climb_mps,
                              engine._tilt(aircraft), aircraft.passengers)
            e.discharge(power, seconds)
    if aircraft.flight:
        for name, threshold in (('low', p['low_pct']), ('critical', p['critical_pct']), ('depleted', 0)):
            if e.soc_pct <= threshold and name not in e.warned:
                e.warned.add(name)
                record(engine, aircraft, now, 'battery_'+name)
    # Bounded telemetry, never per physics step; retained by OperationsHistory.
    if e.flight_id and (aircraft.phase != e.last_phase or
            (aircraft.flight or e.charge_state == 'charging') and now-e.last_sample_s >= p['sample_interval_s']):
        record(engine, aircraft, now, 'battery_sample')
        e.last_sample_s, e.last_phase = now, aircraft.phase
