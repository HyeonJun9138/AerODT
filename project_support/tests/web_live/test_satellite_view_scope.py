"""Satellites are propagated for the sky the operator can actually see.

The catalogue is 16,507 objects. Propagating and sending every one of them each
second cost about half a second of CPU and 12.5 MB of wire per tick, which is
what made every other request on this server wait. These tests fix the rule that
replaced it: carry what is above the horizon from the reported view, examine the
rest of the catalogue a slice at a time, and fall back to everything when no
view has been reported.
"""
import math
import time

import pytest

from digital_twin.live_twin.satellite_visibility import horizon_angle_deg, over_view, separation_deg
from digital_twin.live_twin.state_synchronization import LiveSynchronizer

SEOUL_SCREEN = {"lamin": 37.30, "lamax": 37.80, "lomin": 126.70, "lomax": 127.30}
GLOBE = {"lamin": -85.0, "lamax": 85.0, "lomin": -180.0, "lomax": 180.0}


def test_the_horizon_opens_with_height():
    # A satellite is above the horizon out to arccos(R / (R + h)) from its
    # sub-point: a low pass is nearly overhead, a geostationary one covers a
    # third of the globe, which is what each is actually visible from.
    assert horizon_angle_deg(550e3) == pytest.approx(22.7, abs=.3)
    assert horizon_angle_deg(800e3) == pytest.approx(27.1, abs=.3)
    assert horizon_angle_deg(35786e3) == pytest.approx(81.3, abs=.3)
    assert horizon_angle_deg(0) == 0 and horizon_angle_deg(-10) == 0
    assert horizon_angle_deg(float("nan")) == 0 and horizon_angle_deg(None) == 0


def test_distance_is_measured_to_the_view_not_to_its_centre():
    assert separation_deg(SEOUL_SCREEN, 37.5, 127.0) == 0.0, "inside the view"
    assert separation_deg(SEOUL_SCREEN, 37.8, 127.3) == pytest.approx(0, abs=1e-4), "a corner is still inside"
    # One degree of latitude north of the top edge is one degree away.
    assert separation_deg(SEOUL_SCREEN, 38.8, 127.0) == pytest.approx(1.0, abs=.01)
    # Longitude degrees are shorter at this latitude, so the same number of them
    # is a smaller angle; measuring on the sphere is the point.
    assert separation_deg(SEOUL_SCREEN, 37.5, 129.3) == pytest.approx(1.59, abs=.05)
    assert separation_deg(SEOUL_SCREEN, -37.5, -53.0) == pytest.approx(180, abs=1), "the far side of the world"


def test_the_shorter_way_round_the_antimeridian_is_the_distance():
    view = {"lamin": 0.0, "lamax": 1.0, "lomin": 179.0, "lomax": 179.5}
    assert separation_deg(view, 0.5, -179.5) == pytest.approx(1.0, abs=.01)


def test_what_is_carried_is_what_could_be_seen_from_the_view():
    overhead = dict(latitude_deg=37.5, longitude_deg=127.0, altitude_m=550e3)
    assert over_view(SEOUL_SCREEN, **overhead) is True
    # 20 degrees away a 550 km orbit is still up; a balloon at 20 km is not.
    assert over_view(SEOUL_SCREEN, 57.0, 127.0, 550e3) is True
    assert over_view(SEOUL_SCREEN, 57.0, 127.0, 20e3) is False
    # The margin is what makes a periodic sweep safe: one about to rise is held.
    assert over_view(SEOUL_SCREEN, 61.0, 127.0, 550e3) is False
    assert over_view(SEOUL_SCREEN, 61.0, 127.0, 550e3, margin_deg=3) is True
    assert over_view(None, 0, 0, 550e3) is True, "no view means no scoping"


class FakeRecord:
    """One GP record in the shape SourceRecords hands to the synchronizer."""
    format = "celestrak_gp"
    source = "celestrak_saved"
    provenance = "cached"
    received_time = 1_700_000_000.0

    def __init__(self, payload):
        self.payload = payload


def gp(norad, name, inclination_deg, raan_deg, mean_anomaly_deg, epoch_iso="2026-09-09T00:00:00.000000"):
    """A circular 550 km orbit, placed by its node and phase."""
    return {
        "OBJECT_NAME": name, "NORAD_CAT_ID": str(norad), "OBJECT_ID": f"2026-{norad:03d}A", "EPOCH": epoch_iso,
        "MEAN_MOTION": 15.2, "ECCENTRICITY": 0.0001, "INCLINATION": inclination_deg,
        "RA_OF_ASC_NODE": raan_deg, "ARG_OF_PERICENTER": 0.0, "MEAN_ANOMALY": mean_anomaly_deg,
        "BSTAR": 0.0, "MEAN_MOTION_DOT": 0.0, "MEAN_MOTION_DDOT": 0.0,
        "EPHEMERIS_TYPE": 0, "CLASSIFICATION_TYPE": "U", "ELEMENT_SET_NO": 999, "REV_AT_EPOCH": 1,
    }


def catalogue(count=60):
    """A spread of orbits so some pass over Korea and most do not."""
    return [gp(10_000 + index, f"TEST-{index}", 53.0, index * 6.0, index * 6.0) for index in range(count)]


def synchronizer(view=None, **kwargs):
    return LiveSynchronizer(retention_seconds=300, view=view, **kwargs)


def positions(entities):
    return {entity.entity_id: (entity.latitude_deg, entity.longitude_deg) for entity in entities}


def test_without_a_reported_view_the_whole_catalogue_is_carried():
    record = FakeRecord(catalogue())
    everything = synchronizer().synchronize([record], time.time())
    assert len(everything) == 60


def test_a_reported_view_carries_only_the_sky_above_it():
    record = FakeRecord(catalogue())
    target = time.time()
    everything = synchronizer().synchronize([record], target)
    scoped = synchronizer(view=lambda: SEOUL_SCREEN).synchronize([record], target)
    assert 0 < len(scoped) < len(everything)
    # Every object carried is one that could be seen from the view, and every
    # object dropped is one that could not: the same rule, both directions.
    margin = 3.0
    for entity in scoped:
        assert over_view(SEOUL_SCREEN, entity.latitude_deg, entity.longitude_deg,
                         entity.altitude_m, margin_deg=margin), entity.name
    carried = {entity.entity_id for entity in scoped}
    for entity in everything:
        if entity.entity_id not in carried:
            assert not over_view(SEOUL_SCREEN, entity.latitude_deg, entity.longitude_deg,
                                 entity.altitude_m, margin_deg=margin), entity.name


def test_the_states_carried_are_the_same_ones_the_full_run_produces():
    # Scoping decides what is sent, never what a state is.
    record = FakeRecord(catalogue())
    target = time.time()
    full = positions(synchronizer().synchronize([record], target))
    scoped = positions(synchronizer(view=lambda: SEOUL_SCREEN).synchronize([record], target))
    assert scoped, "the fixture must put something over Korea"
    for entity_id, position in scoped.items():
        assert full[entity_id] == pytest.approx(position, abs=1e-9)


def test_a_view_of_the_whole_globe_still_carries_the_whole_catalogue():
    record = FakeRecord(catalogue())
    scoped = synchronizer(view=lambda: GLOBE).synchronize([record], time.time())
    assert len(scoped) == 60, "everything really is above the horizon from somewhere down there"


def test_the_rest_of_the_catalogue_is_examined_a_slice_at_a_time():
    """The tick cost is what is on screen plus one slice, not the catalogue."""
    record = FakeRecord(catalogue())
    live = synchronizer(view=lambda: SEOUL_SCREEN, sweep_seconds=20.0)
    base = time.time()
    live.synchronize([record], base)  # the first tick sweeps everything
    examined = []
    original = live._due

    def counting(source, compiled, target, view):
        due = original(source, compiled, target, view)
        examined.append(len(due))
        return due

    live._due = counting
    for step in range(1, 5):
        live.synchronize([record], base + step)
    # A second of a twenty second sweep is a twentieth of the catalogue, plus
    # whatever is overhead and must stay current.
    overhead = len(live._overhead["celestrak_saved"])
    for count in examined:
        assert count <= overhead + math.ceil(60 / 20) + 1, examined
    assert sum(examined) < 60 * len(examined), "not the whole catalogue every tick"


def test_a_satellite_that_rises_into_view_is_picked_up_within_a_sweep():
    record = FakeRecord(catalogue())
    live = synchronizer(view=lambda: SEOUL_SCREEN, sweep_seconds=6.0)
    base = time.time()
    first = {entity.entity_id for entity in live.synchronize([record], base)}
    seen = set(first)
    entities = ()
    # Half an orbit later a different set is overhead; the sweep must find it
    # without the caller asking for a full pass.
    for step in range(1, 46):
        entities = live.synchronize([record], base + step * 60, previous=entities)
        seen |= {entity.entity_id for entity in entities}
    assert len(seen - first) > 0, "nothing new ever appeared"
    # And what is carried at the end is right for that moment, not a leftover.
    for entity in entities:
        assert over_view(SEOUL_SCREEN, entity.latitude_deg, entity.longitude_deg,
                         entity.altitude_m, margin_deg=3.0), entity.name


def test_one_that_leaves_the_view_stops_being_carried():
    record = FakeRecord(catalogue())
    live = synchronizer(view=lambda: SEOUL_SCREEN, sweep_seconds=6.0)
    base = time.time()
    first = {entity.entity_id for entity in live.synchronize([record], base)}
    entities = ()
    for step in range(1, 16):
        entities = live.synchronize([record], base + step * 60, previous=entities)
    later = {entity.entity_id for entity in entities}
    assert first - later, "a low orbit crosses the sky in minutes; some must have set"


def test_turning_the_setting_off_goes_back_to_the_whole_catalogue():
    record = FakeRecord(catalogue())
    following = {"on": True}
    live = synchronizer(view=lambda: SEOUL_SCREEN if following["on"] else None)
    target = time.time()
    assert len(live.synchronize([record], target)) < 60
    following["on"] = False
    assert len(live.synchronize([record], target + 1)) == 60


def test_a_new_catalogue_does_not_inherit_the_old_one_s_overhead_set():
    live = synchronizer(view=lambda: SEOUL_SCREEN)
    target = time.time()
    live.synchronize([FakeRecord(catalogue())], target)
    assert live._overhead["celestrak_saved"], "something was overhead in the first catalogue"
    # A record with no usable entries: the previous run's identifiers must not
    # keep being reported from a catalogue that no longer holds them.
    live.synchronize([FakeRecord([])], target + 1)
    assert live._overhead["celestrak_saved"] == set()
