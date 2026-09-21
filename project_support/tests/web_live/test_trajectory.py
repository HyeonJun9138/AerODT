"""Bounded trajectory of one selected object, computed by the Live Twin.

The path is a computed projection of the same model that produces the current
state. It is never presented as a measured track.
"""
import math

import pytest
from fastapi.testclient import TestClient
from sgp4.api import Satrec
from sgp4.exporter import export_omm

from data.ingestion.source_records import SourceRecords
from digital_twin.live_twin.state_synchronization import LiveSynchronizer
from user_application.apps.web_dashboard.application import create_app, SourceBinding

ISS = ('1 25544U 98067A   19343.69339541  .00001764  00000-0  38792-4 0  9991',
       '2 25544  51.6439 211.2001 0007417  17.6667  85.6398 15.50103472202482')


def gp_store(name='ISS (ZARYA)', norad=25544, lines=ISS):
    sat = Satrec.twoline2rv(*lines)
    epoch = (sat.jdsatepoch + sat.jdsatepochF - 2440587.5) * 86400
    fields = export_omm(sat, name)
    fields.update(NORAD_CAT_ID=norad, OBJECT_NAME=name)
    store = SourceRecords()
    store.register('gp', [fields], epoch + 60, format='celestrak_gp')
    return store, epoch


def aircraft_store(observed=100, received=110):
    store = SourceRecords()
    store.register('test', [dict(id='abc123', name='TEST123', latitude=37.0, longitude=127.0,
                                 altitude_m=10000, track_deg=90, speed_mps=200,
                                 vertical_rate_mps=0, observed_at=observed)],
                   received, format='aircraft_v1')
    return store


def test_satellite_trajectory_covers_one_orbit_and_reports_its_shape():
    store, epoch = gp_store()
    sync = LiveSynchronizer()
    target = epoch + 3600
    entity = sync.synchronize(store.records(), target)[0]
    path = sync.trajectory(entity, target)
    assert path['schema_version'] == 1
    assert path['entity_id'] == entity.entity_id
    assert path['reference_frame'] == 'ecef_m'
    assert path['derivation'] == 'gp_propagated'
    points = path['points']
    assert 200 <= len(points) <= 600
    times = [point[0] for point in points]
    assert times == sorted(times)
    summary = path['summary']
    assert summary['period_minutes'] == pytest.approx(92.9, abs=1.0)
    assert summary['inclination_deg'] == pytest.approx(51.64, abs=0.05)
    assert summary['apogee_km'] == pytest.approx(410, abs=25)
    assert summary['perigee_km'] == pytest.approx(400, abs=25)
    assert times[-1] - times[0] == pytest.approx(summary['period_minutes'] * 60, rel=.02)
    radii = [math.dist((0, 0, 0), point[1:]) for point in points]
    assert min(radii) > 6.6e6 and max(radii) < 7.0e6
    # The path passes through the state the twin currently publishes.
    nearest = min(math.dist(entity.position_ecef_m, point[1:]) for point in points)
    assert nearest < 30000, 'one orbit sampled around now includes the current position'


def test_satellite_trajectory_stops_at_the_validity_edge_of_an_old_catalogue():
    store, epoch = gp_store()
    sync = LiveSynchronizer()
    valid_until = epoch + sync.definitions['satellite']['max_epoch_age_seconds']
    target = valid_until - 600
    entity = sync.synchronize(store.records(), target)[0]
    path = sync.trajectory(entity, target)
    assert path['points'], 'a path is still offered while the state is usable'
    assert max(point[0] for point in path['points']) <= valid_until + 1e-6
    assert path['valid_until'] == pytest.approx(valid_until)


def test_geostationary_period_is_sampled_without_unbounded_point_counts():
    geo = ('1 41866U 16071A   26250.50000000  .00000000  00000-0  00000-0 0  9990',
           '2 41866   0.0200  95.0000 0002000   0.0000   0.0000  1.00270000 10000')
    store, epoch = gp_store(name='GOES 16', norad=41866, lines=geo)
    sync = LiveSynchronizer()
    entity = sync.synchronize(store.records(), epoch + 60)[0]
    path = sync.trajectory(entity, epoch + 60)
    assert path['summary']['period_minutes'] == pytest.approx(1436, abs=5)
    assert len(path['points']) <= 600
    assert path['span_seconds'] <= 6 * 3600, 'a long period is truncated, not sampled coarsely for hours'


def test_aircraft_have_no_path_because_the_provider_carries_no_route():
    sync = LiveSynchronizer()
    store = aircraft_store(observed=100, received=110)
    entity = sync.synchronize(store.records(), 120)[0]
    assert entity.kind == 'aircraft'
    assert sync.trajectory(entity, 120) is None, 'a 60 s extrapolation is not a route'


def test_trajectory_of_an_unknown_or_uncompiled_object_is_absent_not_invented():
    sync = LiveSynchronizer()
    store, epoch = gp_store()
    entity = sync.synchronize(store.records(), epoch + 60)[0]
    import dataclasses
    assert sync.trajectory(dataclasses.replace(entity, entity_id='gp:999999'), epoch + 60) is None
    assert sync.trajectory(dataclasses.replace(entity, kind='unknown'), epoch + 60) is None


def test_trajectory_computation_does_not_disturb_the_current_state():
    sync = LiveSynchronizer()
    store, epoch = gp_store()
    before = sync.synchronize(store.records(), epoch + 60)
    sync.trajectory(before[0], epoch + 60)
    after = sync.synchronize(store.records(), epoch + 60)
    assert before[0].position_ecef_m == after[0].position_ecef_m


async def fetch_aircraft():
    import time
    return [dict(id='test', name='TEST', latitude=37, longitude=127, altitude_m=9000,
                 speed_mps=200, track_deg=90, vertical_rate_mps=0, observed_at=time.time())]


def test_the_drawn_line_follows_the_orbit_closely_around_the_current_time():
    """A chord between distant samples cuts the corner; near now that must not show."""
    store, epoch = gp_store()
    sync = LiveSynchronizer()
    target = epoch + 3600
    entity = sync.synchronize(store.records(), target)[0]
    points = sync.trajectory(entity, target)['points']
    radius = math.dist((0, 0, 0), points[0][1:])

    def sagitta(pair):
        return math.dist(pair[0][1:], pair[1][1:]) ** 2 / (8 * radius)

    near = [pair for pair in zip(points, points[1:]) if abs(pair[0][0] - target) <= 200]
    assert len(near) >= 40, 'the current position is sampled densely'
    assert max(sagitta(pair) for pair in near) < 20, 'the line stays within metres of the orbit near now'
    assert max(sagitta(pair) for pair in zip(points, points[1:])) < 1200, 'the far arc stays bounded too'
    assert len(points) <= 600

    # Against the propagated orbit itself, not just the chord geometry.
    from digital_twin.live_twin.trajectory import propagate_ecef
    sat = Satrec.twoline2rv(*ISS)

    def distance_to_path(position):
        best = math.inf
        for first, second in zip(points, points[1:]):
            a, b = first[1:], second[1:]
            span = [b[i] - a[i] for i in range(3)]
            length = sum(value * value for value in span)
            offset = [position[i] - a[i] for i in range(3)]
            ratio = max(0.0, min(1.0, sum(offset[i] * span[i] for i in range(3)) / length))
            best = min(best, math.dist(position, [a[i] + span[i] * ratio for i in range(3)]))
        return best

    errors = [distance_to_path(propagate_ecef(sat, target + step)[0]) for step in range(-60, 61, 3)]
    assert max(errors) < 20, f'displayed line deviates by {max(errors):.0f} m around the current time'


def test_trajectory_endpoint_serves_one_selected_object_and_rejects_unknown_ids(tmp_path):
    import time
    binding = SourceBinding('fixture', 'aircraft_v1', fetch_aircraft, 60, provenance='fixture')
    app = create_app({'cache_directory': str(tmp_path), 'workspace_directory': str(tmp_path),
                      'tick_seconds': .02}, sources=[binding])
    with TestClient(app) as client:
        for _ in range(100):
            snapshot = client.get('/api/live/snapshot').json()
            if snapshot['entities']:
                break
            time.sleep(.02)
        aircraft_id = snapshot['entities'][0]['entity_id']
        # An aircraft has no filed route to serve. What the twin can serve is
        # the next seconds of its own estimate, and only while that is asked for.
        served = client.get(f'/api/live/trajectory/{aircraft_id}').json()
        assert served['kind'] == 'aircraft' and served['derivation'] == 'estimated'
        assert '비행계획' in served['note'], 'the projection says what it is not'
        client.put('/api/library/sources', json={'sources': {'trajectory_prediction': {'enabled': False}}})
        assert client.get(f'/api/live/trajectory/{aircraft_id}').status_code == 404, 'no prediction asked for, none served'
        assert client.get('/api/live/trajectory/fixture:missing').status_code == 404
        assert client.get('/api/live/trajectory/' + 'x' * 300).status_code in (404, 422)
