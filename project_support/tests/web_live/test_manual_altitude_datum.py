"""A contact-world pose must enter the fleet exactly once in its own datum."""
import copy
import json
import subprocess
from pathlib import Path

import pytest

from digital_twin.simulation import manual_takeover
from digital_twin.simulation.manual_altitude import fleet_altitude, registered_altitude
from communication.web.domains.uam.manual_routes import _share
from data.simulation.proximity_records import ProximityRecords
from project_support.tests.web_live.test_scenario_engine import engine_of, row


def test_inverse_matches_actual_browser_registration_without_flattening_flight():
    # Use the production JS forward function, not a Python copy of its formula.
    script = """
      import {deckSurfaceOffset} from './digital_twin/visualization/web/vertiport_layer.js';
      const layout={frame:{latitude:37,longitude:127},platform:{corners_m:[[-100,-100],[100,-100],[100,100],[-100,100]]}};
      const out=[];
      for(const top of [-30,42.68,500])for(const east of [0,180,350,500])for(const h of [0,10,20,50,130,300,900]){
        const latitude=37,longitude=127+east/(111320*Math.cos(37*Math.PI/180));
        const position={latitude:latitude*Math.PI/180,longitude:longitude*Math.PI/180,height:h};
        out.push({layout,top,latitude,longitude,h,display:h+deckSurfaceOffset(layout,top,10,position)});
      }
      console.log(JSON.stringify(out));
    """
    root = Path(__file__).resolve().parents[3]
    values = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script], cwd=root, text=True))
    for v in values:
        assert fleet_altitude(v['layout'], 10, v['top'], v['latitude'], v['longitude'], v['display']) == pytest.approx(v['h'], abs=1e-7)


def test_shared_pose_and_track_have_fleet_datum_but_socket_sample_is_untouched(tmp_path):
    engine = engine_of(row('F1', 'A1', 'VP1', 'VP2', '06:30:00'),
                       row('F2', 'A2', 'VP1', 'VP2', '07:30:00', stand='G2'))
    manual_takeover.hand_over(engine, 'A1')
    a = engine.aircraft['A1']
    a.flight = engine.flights['F1']
    a.trail_flight = 'F1'
    deck = engine._deck_height('VP1')
    sample = {'position': {'latitude': a.latitude, 'longitude': a.longitude, 'altitude_m': deck+32.68},
              'airborne': False, 'speed_mps': 0, 'velocity_ned_mps': [0, 0, 0]}
    original = copy.deepcopy(sample)

    class Day:
        def place_manual(self, identifier, **pose):
            return manual_takeover.place(engine, identifier, **pose)

    assert _share(Day(), 'A1', sample, .1, {'VP1': deck+32.68})
    assert sample == original
    assert a.altitude == pytest.approx(deck-.03, abs=1e-6)
    assert engine.track('A1')['points'][-1][2] == pytest.approx(deck-.03, abs=.01)
    assert not a.airborne
    assert a.telemetry['velocity_ned_mps'][2] == pytest.approx(0, abs=1e-6)

    states = engine.states()
    # Both parked is intentionally excluded. Make one airborne to exercise the
    # recorder, without changing either observation's altitude.
    states[0]['airborne'] = True
    records = ProximityRecords(tmp_path, 'datum', {})
    try:
        records.observe(1, states)
        pair = next(iter(records.pairs.values()))
        assert pair['minimum_vertical']['distance_m'] == pytest.approx(.03, abs=1e-6)
    finally:
        records.close()


def test_no_contact_metadata_preserves_legacy_altitude_and_velocity():
    engine = engine_of(row('F1', 'A1', 'VP1', 'VP2', '06:30:00'))
    manual_takeover.hand_over(engine, 'A1')
    a = engine.aircraft['A1']
    manual_takeover.place(engine, 'A1', latitude=a.latitude, longitude=a.longitude, altitude=333,
                          airborne=True, telemetry={'velocity_ned_mps':[1,2,-3]})
    assert a.altitude == 333
    assert a.telemetry['velocity_ned_mps'] == (1,2,-3)


def test_destination_and_next_leg_use_their_own_contact_height_and_never_clamp_cruise():
    engine = engine_of(row('F1', 'A1', 'VP1', 'VP2', '06:30:00'))
    heights = {'VP1': 52.68, 'VP2': 80, 'unknown': 900}
    flight = engine.flights['F1']
    for port in ('VP1', 'VP2'):
        frame = engine._layout(port)['frame']
        lat, lon = frame['latitude'], frame['longitude']
        canonical = registered_altitude(engine, flight, lat, lon, heights[port], heights)
        assert canonical == pytest.approx(engine._deck_height(port)-.03, abs=1e-7)
        assert registered_altitude(engine, flight, lat, lon, 900, heights) == 900
        reverse = {'origin': 'VP2', 'destination': 'VP1'}
        assert registered_altitude(engine, reverse, lat, lon, heights[port], heights) == canonical
    assert registered_altitude(engine, flight, 0, 0, 80, heights) == 80


def test_vertical_prediction_velocity_is_transformed_with_the_position():
    engine = engine_of(row('F1', 'A1', 'VP1', 'VP2', '06:30:00'))
    manual_takeover.hand_over(engine, 'A1')
    a = engine.aircraft['A1']
    heights = {'VP1': 60}
    flight = engine.flights['F1']
    telemetry = {'velocity_ned_mps': [0, 0, -2]}
    manual_takeover.place(engine, 'A1', latitude=a.latitude, longitude=a.longitude, altitude=90,
                          contact_heights=heights, airborne=True, telemetry=telemetry)
    future = registered_altitude(engine, flight, a.latitude, a.longitude, 90.02, heights)
    assert a.telemetry['velocity_ned_mps'][2] == pytest.approx(-(future-a.altitude)/.01)
    assert telemetry['velocity_ned_mps'] == [0, 0, -2]
