import dataclasses
import math

import pytest

from data.ingestion.source_records import SourceRecords
from digital_twin.live_twin.state_synchronization import LiveSynchronizer
from digital_twin.live_twin.perception_track_fusion import process as fuse
from digital_twin.live_twin.situation_assessment import process as assess
from digital_twin.runtime.real_time_twin.world import TwinWorld


def aircraft(observed=100, **changes):
    item = dict(id="abc123", name="TEST123", latitude=37.0, longitude=127.0,
                altitude_m=1000, track_deg=90, speed_mps=100,
                vertical_rate_mps=0, observed_at=observed)
    item.update(changes)
    return [item]


def test_ingestion_copies_raw_input_and_rejects_older_receipts():
    store = SourceRecords()
    payload = aircraft()
    receipt = store.register("test", payload, 101, format="aircraft_v1", provenance="fixture")
    payload[0]["latitude"] = 0
    assert store.latest("test").payload[0]["latitude"] == 37
    with pytest.raises(TypeError):
        receipt.payload[0]["latitude"] = 0
    store.register("test", aircraft(), 99, format="aircraft_v1")
    assert store.latest("test").received_time == 101


def test_aircraft_extrapolation_is_bounded_and_source_is_preserved():
    store = SourceRecords()
    store.register("test", aircraft(), 101, format="aircraft_v1", provenance="fixture")
    sync = LiveSynchronizer()
    first = sync.synchronize(store.records(), 100)[0]
    moving = sync.synchronize(store.records(), 105)[0]
    stopped = sync.synchronize(store.records(), 170)[0]
    later = sync.synchronize(store.records(), 250)[0]
    assert math.dist(first.position_ecef_m, moving.position_ecef_m) == pytest.approx(500, abs=2)
    assert moving.derivation == "estimated"
    assert moving.source == "test" and moving.provenance == "fixture"
    assert stopped.quality == "stale"
    assert stopped.position_ecef_m == later.position_ecef_m
    assert first.observation_time == 100
    assert first.heading_deg == 90  # track-derived presentation, not observed attitude
    assert first.orientation_source == "ground_track"


def test_valid_observation_recovers_after_transient_sync_failure():
    store = SourceRecords()
    store.register("test", aircraft(), 101, format="aircraft_v1")
    sync = LiveSynchronizer()
    previous = sync.synchronize(store.records(), 101)[0]
    failed = dataclasses.replace(previous, quality="stale")
    recovered = sync.synchronize(store.records(), 102, previous=(failed,))[0]
    assert recovered.quality == "valid"
    assert recovered.valid_until == 160


@pytest.mark.parametrize("changes", [{"latitude":91},{"longitude":float('nan')},
    {"speed_mps":-1},{"observed_at":float('inf')},{"altitude_m":None}])
def test_invalid_observations_do_not_create_entities(changes):
    records = SourceRecords()
    records.register("test", aircraft(**changes), 101, format="aircraft_v1")
    assert LiveSynchronizer().synchronize(records.records(), 105) == ()


def test_late_packet_never_rewinds_accepted_observation():
    store = SourceRecords()
    store.register("test", aircraft(), 101, format="aircraft_v1")
    sync = LiveSynchronizer()
    accepted = sync.synchronize(store.records(), 105)
    store.register("test", aircraft(observed=90, longitude=120), 106, format="aircraft_v1")
    updated = sync.synchronize(store.records(), 106, previous=accepted)
    assert updated[0].observation_time == 100
    assert math.dist(updated[0].position_ecef_m, accepted[0].position_ecef_m) < 110


def test_runtime_is_immutable_and_time_is_monotonic():
    store = SourceRecords()
    store.register("test", aircraft(), 101, format="aircraft_v1")
    states = LiveSynchronizer().synchronize(store.records(), 105)
    world = TwinWorld()
    snapshot = world.replace(states, 105, ())
    assert snapshot.sequence == 1
    with pytest.raises(dataclasses.FrozenInstanceError):
        snapshot.entities[0].name = "overwrite"
    with pytest.raises(ValueError):
        world.replace(states, 104, ())
    assert world.snapshot() is snapshot


def test_extensions_do_not_claim_fusion_or_safety():
    for extension in (fuse, assess):
        result = extension(())
        assert result.enabled is False
        assert result.result is None


def test_expired_aircraft_leave_current_world_not_grow_forever():
    store = SourceRecords()
    store.register('test', aircraft(), 101, format='aircraft_v1')
    sync = LiveSynchronizer(retention_seconds=60)
    first = sync.synchronize(store.records(), 105)
    assert sync.synchronize(store.records(), 200, previous=first) == ()


def test_bad_opensky_row_does_not_discard_valid_rows():
    row = ['abc123', 'TEST', 'Country', 100, 100, 127, 37, 900, False, 100, 90, 0, None, 1000]
    store = SourceRecords()
    store.register('test', {'states': [None, 42, row]}, 101, format='opensky_states')
    assert len(LiveSynchronizer().synchronize(store.records(), 105)) == 1


def test_normal_observation_correction_is_continuous_in_live_twin():
    store = SourceRecords()
    store.register('test', aircraft(), 100, format='aircraft_v1')
    sync = LiveSynchronizer()
    first = sync.synchronize(store.records(), 100)
    store.register('test', aircraft(observed=100.1, longitude=127.001), 100.2, format='aircraft_v1')
    corrected = sync.synchronize(store.records(), 100.1, previous=first)
    assert math.dist(first[0].position_ecef_m, corrected[0].position_ecef_m) < 30


def test_continuity_generation_survives_skipped_jump_snapshot():
    store = SourceRecords()
    store.register('test', aircraft(), 100, format='aircraft_v1')
    sync = LiveSynchronizer()
    initial = sync.synchronize(store.records(), 100)
    store.register('test', aircraft(observed=101, longitude=128), 101, format='aircraft_v1')
    jump = sync.synchronize(store.records(), 101, previous=initial)
    later = sync.synchronize(store.records(), 102, previous=jump)
    assert jump[0].discontinuity
    assert later[0].continuity_id == jump[0].continuity_id != initial[0].continuity_id
