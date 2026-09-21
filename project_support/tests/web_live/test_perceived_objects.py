"""A viewer's camera perceptions reach the risk picture as sightings, not state.

The browser places what its detector saw and reports it. The server keeps it
briefly, lists it beside known traffic for the risk predictor, and enters each
report into the predictor's observation history with the estimate's own error.
The twin's authoritative snapshot is never changed by any of it.
"""
import math

from fastapi import FastAPI
from fastapi.testclient import TestClient

from communication.web.perception_routes import create_perception_router
from data.simulation.perceived_objects import PerceivedObjects, TTL_S
from data.simulation.risk_history import RiskHistory, STEP


def ecef(lat, lon, alt):
    a, f = 6378137.0, 1 / 298.257223563
    e2 = f * (2 - f)
    la, lo = math.radians(lat), math.radians(lon)
    n = a / math.sqrt(1 - e2 * math.sin(la) ** 2)
    return [(n + alt) * math.cos(la) * math.cos(lo), (n + alt) * math.cos(la) * math.sin(lo), ((1 - e2) * n + alt) * math.sin(la)]


def sighting(track='7', kind='drone', lat=37.55, lon=127.0, alt=300., **extra):
    return {'track_id': track, 'class_name': 'Drone', 'kind': kind, 'confidence': .8,
            'latitude_deg': lat, 'longitude_deg': lon, 'altitude_m': alt,
            'position_ecef_m': ecef(lat, lon, alt), 'sigma_m': 12., 'heading_deg': 90., **extra}


def test_a_report_is_kept_as_twin_entities_that_say_what_they_are():
    clock = [100.]
    store = PerceivedObjects(clock=lambda: clock[0])
    kept = store.report({'ownship_id': 'scenario:UAM0001', 'state_time': 5000., 'objects': [sighting()]}, wall_time=1.)
    assert kept[0]['entity_id'] == 'perceived:scenario:UAM0001:7'
    [entity] = store.entities()
    assert entity.kind == 'drone' and entity.provenance == 'camera_ai' and entity.source == 'perception'
    assert entity.derivation == 'observed' and entity.quality == 'nominal'
    assert entity.valid_until == 5000. + TTL_S
    assert entity.visual_asset_id == 'amvlab_drone'
    assert '인식 #7' in entity.name
    # Gone once the camera stops reporting it.
    clock[0] += TTL_S + .1
    assert store.entities() == []


def test_a_track_keeps_its_continuity_while_reported_and_is_new_when_it_comes_back():
    clock = [0.]
    store = PerceivedObjects(clock=lambda: clock[0])
    body = {'ownship_id': 'A', 'state_time': 1., 'objects': [sighting()]}
    first = store.report(body)[0]['continuity_id']
    clock[0] += 1.
    assert store.report(dict(body, state_time=2.))[0]['continuity_id'] == first
    clock[0] += TTL_S + 1
    assert store.report(dict(body, state_time=9.))[0]['continuity_id'] == first + 1


def test_bad_reports_are_refused_whole():
    store = PerceivedObjects()
    for body in [None, {}, {'ownship_id': 'A', 'state_time': 1., 'objects': 'x'},
                 {'ownship_id': 'A', 'state_time': 1., 'objects': [sighting(position_ecef_m=[1, 2, 3])]},
                 {'ownship_id': 'A', 'state_time': 1., 'objects': [sighting(latitude_deg=95.)]},
                 {'ownship_id': 'A', 'state_time': float('nan'), 'objects': []},
                 {'ownship_id': 'A', 'state_time': 1., 'objects': [sighting()] * 40}]:
        try:
            store.report(body)
        except ValueError:
            continue
        raise AssertionError(f'accepted {body!r}')
    assert store.current() == []
    # An unknown kind is kept as unknown, a wild sigma is clamped, a fast velocity dropped.
    [item] = store.report({'ownship_id': 'A', 'state_time': 1., 'objects': [
        sighting(kind='cat', sigma_m=1e9, velocity_ecef_mps=[900, 0, 0])]})
    assert item['kind'] == 'unknown' and item['sigma_m'] == 500. and item['velocity_ecef_mps'] is None


class Entity:
    def __init__(self, entity_id, t):
        self.entity_id, self.kind, self.state_time = entity_id, 'uam', t
        self.continuity_id, self.source, self.provenance = 0, 'scenario', 'live'
        self.display_observation = None
        self.quality, self.valid_until, self.discontinuity = 'nominal', None, False
        self.observation_time, self.position_ecef_m = t, (1., 2., 3.)
        self.derivation, self.estimation = 'simulated', None


class Snapshot:
    def __init__(self, t, epoch=1):
        self.state_time, self.epoch, self.entities = t, epoch, [Entity('own', t)]


def test_a_sighting_enters_the_history_with_its_own_error_and_never_moves_the_clock():
    history = RiskHistory(clock=lambda: 0.)
    history.observe(Snapshot(100.))
    assert history.observe_perceived('perceived:own:7', 100.2, (4., 5., 6.), 12., epoch=1) is True
    assert history.last_time == 100., 'a report is not a tick of the twin'
    window = history.window('perceived:own:7', 100.5)
    rows = [r for r in window if r is not None]
    assert len(rows) == 1
    assert rows[0].basis == 'camera_detection_estimate'
    assert rows[0].covariance_basis == 'camera_range_from_apparent_size'
    assert rows[0].sigma_m == 12.
    # Another epoch, the future, or a repeat of the same instant: not a sighting.
    assert history.observe_perceived('perceived:own:7', 100.4, (4., 5., 6.), 12., epoch=2) is False
    assert history.observe_perceived('perceived:own:7', 200., (4., 5., 6.), 12., epoch=1) is False
    assert history.observe_perceived('perceived:own:7', 100.2, (4., 5., 6.), 12., epoch=1) is False
    # Sightings half a second apart fill successive slots, which is what the
    # model needs to see motion.
    for k in range(1, 4):
        assert history.observe_perceived('perceived:own:7', 100.2 + k * STEP, (4. + k, 5., 6.), 12., epoch=1)
    history.observe(Snapshot(102.))
    filled = [r for r in history.window('perceived:own:7', 102.) if r is not None]
    assert len(filled) == 4


def test_the_route_accepts_a_same_origin_report_and_refuses_junk():
    store = PerceivedObjects()
    fed = []
    def report(body):
        kept = store.report(body)
        fed.extend(kept)
        return kept
    app = FastAPI()
    app.include_router(create_perception_router(report, store.current))
    client = TestClient(app, base_url='http://testserver')
    headers = {'origin': 'http://testserver', 'host': 'testserver'}
    ok = client.post('/api/perception/observations', json={'ownship_id': 'scenario:UAM0001', 'state_time': 10., 'objects': [sighting()]}, headers=headers)
    assert ok.status_code == 200 and ok.json() == {'accepted': 1}
    assert len(fed) == 1
    bad = client.post('/api/perception/observations', json={'ownship_id': 'A', 'state_time': 1., 'objects': [sighting(latitude_deg=99.)]}, headers=headers)
    assert bad.status_code == 422
    listing = client.get('/api/perception/observations')
    assert listing.status_code == 200 and listing.json()['objects'][0]['entity_id'] == 'perceived:scenario:UAM0001:7'
    assert 'seen_at' not in listing.json()['objects'][0]
    foreign = client.post('/api/perception/observations', json={'ownship_id': 'A', 'state_time': 1., 'objects': []},
                          headers={'origin': 'http://elsewhere.example', 'host': 'testserver'})
    assert foreign.status_code == 403


def test_a_camera_track_is_predicted_from_three_sightings_while_other_tracks_wait_a_full_window():
    """PRISM is asked about a perceived object as soon as it has three slots.

    A crossing bird is in view for a few seconds; a track that had to be twenty
    slots old before the model looked at it would never be predicted at all.
    """
    from types import SimpleNamespace
    from ai_pnp.risk_prediction import RiskPredictionRunner
    calls = []
    class Model:
        def __init__(self, package):
            pass
        def predict_batch(self, samples):
            calls.append(len(samples))
            return [{'mu': [[[0., 0.]] * 20] * 3, 'covariance': [[[[1., 0.], [0., 1.]]] * 20] * 3, 'weights': [.5, .3, .2]}] * len(samples)
    runner = RiskPredictionRunner(model_factory=Model, availability=lambda: True)
    runner._prediction = staticmethod(lambda out, frame, horizon: {'branches': [{'weight': w, 'points': []} for w in out['weights']], 'type_probabilities': []})
    def entity(entity_id, lat, lon, alt, source='scenario', provenance='live', derivation='simulated', valid_until=None):
        return SimpleNamespace(entity_id=entity_id, kind='uam' if source == 'scenario' else 'drone', continuity_id=1, quality='nominal',
            valid_until=valid_until, latitude_deg=lat, longitude_deg=lon, altitude_m=alt, position_ecef_m=tuple(ecef(lat, lon, alt)),
            heading_deg=0., name=entity_id, source=source, provenance=provenance, derivation=derivation, state_time=0.,
            observation_time=0., display_observation=None, discontinuity=False, estimation=None)
    own = entity('own', 37.55, 127.0, 300.)
    other = entity('other', 37.551, 127.0, 300.)
    # Twenty slots of simulated history for the ownship and a neighbour.
    for k in range(20):
        t = 100. + k * STEP
        own.state_time = other.state_time = t
        runner.observe(SimpleNamespace(state_time=t, epoch=1, sequence=k, entities=[own, other]))
    # Three camera sightings of a drone, over the last 1.5 s only.
    seen = entity('perceived:own:9', 37.5502, 127.0, 300., source='perception', provenance='camera_ai', derivation='observed', valid_until=200.)
    for k in range(3):
        runner.history.observe_perceived('perceived:own:9', 108.5 + k * STEP, tuple(ecef(37.5502, 127.0 + k * 1e-5, 300.)), 8., epoch=1, context=(1, 'perception', 'camera_ai', None))
    snapshot = SimpleNamespace(state_time=109.5, epoch=1, sequence=99, entities=[own, other, seen])
    result = runner.predict(snapshot, 'own', radius_m=3000, horizon_s=10, altitude_band_m=None)
    by_id = {t['entity_id']: t for t in result['tracks']}
    assert by_id['perceived:own:9']['status'] == 'ready' and by_id['perceived:own:9']['prediction'] is not None
    assert by_id['other']['status'] == 'ready', 'the twenty-slot neighbour is predicted as before'
    assert 'camera_detection_estimate' in result['provenance']['input_basis']
    # And one sighting alone is still too little.
    runner.history.observe_perceived('perceived:own:10', 109.5, tuple(ecef(37.5503, 127.0, 300.)), 8., epoch=1, context=(1, 'perception', 'camera_ai', None))
    lone = entity('perceived:own:10', 37.5503, 127.0, 300., source='perception', provenance='camera_ai', derivation='observed', valid_until=200.)
    result = runner.predict(SimpleNamespace(state_time=109.5, epoch=1, sequence=100, entities=[own, other, seen, lone]), 'own', radius_m=3000, horizon_s=10, altitude_band_m=None)
    assert {t['entity_id']: t['status'] for t in result['tracks']}['perceived:own:10'] == 'warming_up'
