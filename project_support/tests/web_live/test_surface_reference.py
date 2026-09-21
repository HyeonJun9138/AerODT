"""The terrain datum is exported, not silently substituted into physics."""
from dataclasses import FrozenInstanceError, asdict
import json

import pytest

from communication.web.wire_snapshot import encode_snapshot
from digital_twin.contracts.live import Snapshot, SurfaceReference
from user_application.uam_mission.scenario_session import ScenarioSession
from project_support.tests.web_live.test_scenario_session import CSV, NETWORK, VERTIPORTS


def session_of(elevation=None, ports=VERTIPORTS):
    session = ScenarioSession(vertiports=lambda: ports, network=lambda: NETWORK, elevation=elevation)
    session.load(CSV)
    return session


@pytest.mark.parametrize('ground', [-10.0, 0.0, 58.97, 250.0])
def test_the_exported_datum_is_the_actual_simulation_deck_not_sea_level(ground):
    session = session_of(lambda lon, lat: (ground, 1))
    before = session.engine.states()
    entity = session._entity(before[0], 1)
    ref = entity.surface_reference
    assert ref.vertiport_id == 'VP1'
    assert ref.altitude_m == ground + 20
    assert entity.altitude_m == before[0]['altitude_m'] == ref.altitude_m
    assert session.engine.states() == before
    with pytest.raises(FrozenInstanceError):
        ref.altitude_m = 123


def test_manual_deck_height_does_not_gain_a_second_terrain_offset():
    ports = [dict(p, layout=dict(p['layout'], ground_reference='manual',
                    frame=dict(p['layout']['frame'], altitude_m=150))) for p in VERTIPORTS]
    session = session_of(lambda lon, lat: 500, ports)
    entity = session._entity(session.engine.states()[0], 1)
    assert entity.surface_reference.altitude_m == 170
    assert entity.altitude_m == 170


def test_arriving_and_joining_mid_flight_use_the_destination_datum_not_the_departure():
    session = session_of(lambda lon, lat: 40 if lat > 37.5 else 90)
    state = dict(session.engine.states()[0], origin='VP1', destination='VP2',
                 latitude_deg=VERTIPORTS[1]['latitude'], longitude_deg=VERTIPORTS[1]['longitude'],
                 altitude_m=180, phase='descent')
    assert session._entity(state, 1).surface_reference == SurfaceReference('VP2', 110)
    for phase in ['landing', 'gate_in', 'cruise', 'holding']:
        assert session._entity(dict(state, phase=phase), 1).surface_reference == SurfaceReference('VP2', 110)
    assert session._surface_reference(dict(state, origin=None, destination=None)) is None


def test_optional_reference_is_serialized_without_rewriting_position():
    session = session_of()
    entity = session._entity(session.engine.states()[0], 1)
    snapshot = Snapshot(1, 1, 1, (entity,), ())
    encoded = json.loads(encode_snapshot(snapshot, {}))['entities'][0]
    assert encoded['surface_reference'] == asdict(entity.surface_reference)
    assert encoded['altitude_m'] == entity.altitude_m
    assert encoded['position_ecef_m'] == list(entity.position_ecef_m)
