"""The twin's clock: rising within a run, and moved between runs on purpose.

Monotonic state time is a guarantee about drift — a source arriving late or an
estimate corrected backwards must never show up as the world going back. It was
never a claim that the twin only looks at now, and once an operator can replay a
scheduled day it plainly is not one. These tests fix the difference: inside a
run the clock only rises, and a deliberate move to another instant is a new
epoch that everything downstream re-anchors on.
"""
import math

import pytest

from digital_twin.contracts.live import Snapshot, SourceStatus, TwinEntity
from digital_twin.runtime.real_time_twin.world import TwinWorld


def entity(identifier="a", position=(1.0, 2.0, 3.0)):
    return TwinEntity(entity_id=identifier, name=identifier, kind="uam",
                      position_ecef_m=position, velocity_ecef_mps=None,
                      latitude_deg=37.0, longitude_deg=127.0, altitude_m=100.0,
                      heading_deg=0.0, state_time=0.0, observation_time=None,
                      received_time=0.0, orbit_epoch=None, derivation="simulated",
                      quality="nominal", source="scenario", model_id="asset_states",
                      visual_asset_id="joby_s4")


def test_a_new_world_starts_at_the_beginning_of_its_first_run():
    world = TwinWorld()
    snapshot = world.snapshot()
    assert snapshot.epoch == 0 and snapshot.sequence == 0 and snapshot.state_time == 0.0


def test_inside_one_run_the_clock_only_rises():
    world = TwinWorld()
    world.replace([entity()], 100.0, ())
    world.replace([entity()], 101.0, ())
    assert world.snapshot().state_time == 101.0 and world.snapshot().epoch == 0
    # A step backwards inside the run is drift, and drift is refused.
    with pytest.raises(ValueError):
        world.replace([entity()], 100.5, ())
    for bad in (float("nan"), float("inf")):
        with pytest.raises(ValueError):
            world.replace([entity()], bad, ())
    assert world.snapshot().state_time == 101.0, "and the world is left as it was"


def test_moving_to_another_instant_on_purpose_is_allowed_and_is_said():
    """Replaying a day in October from a morning in September, and coming back."""
    world = TwinWorld()
    live = world.replace([entity()], 1_757_000_000.0, ())
    assert live.epoch == 0
    scheduled = world.rebase([entity()], 1_791_581_400.0, ())
    assert scheduled.epoch == 1 and scheduled.state_time == 1_791_581_400.0
    # The clock rises again from there, inside the new run.
    world.replace([entity()], 1_791_581_460.0, ())
    assert world.snapshot().epoch == 1
    # And coming back to now is a move too, not a slip.
    back = world.rebase([entity()], 1_757_000_100.0, ())
    assert back.epoch == 2 and back.state_time == 1_757_000_100.0
    with pytest.raises(ValueError):
        world.replace([entity()], 1_757_000_099.0, ()), "still monotonic inside the run"
    # The sequence keeps counting across the whole life of the world, so nothing
    # downstream mistakes a rebase for a restart.
    assert world.snapshot().sequence == 4


def test_a_rebase_checks_everything_a_replace_does():
    world = TwinWorld()
    with pytest.raises(ValueError):
        world.rebase([entity("a"), entity("a")], 100.0, ())
    with pytest.raises(ValueError):
        world.rebase([entity(position=(1.0, float("nan"), 3.0))], 100.0, ())
    with pytest.raises(ValueError):
        world.rebase([entity()], float("nan"), ())
    assert world.snapshot().sequence == 0, "nothing was committed"


def test_the_sources_ride_along_with_either_kind_of_commit():
    world = TwinWorld()
    status = SourceStatus("scenario", "ready", None, "재생 중")
    assert world.replace([], 10.0, (status,)).sources == (status,)
    assert world.rebase([], 5.0, (status,)).sources == (status,)


def test_the_snapshot_carries_the_epoch_for_anything_that_reads_it():
    # A default-constructed snapshot is epoch zero, so code that predates the
    # field reads the same value it always did.
    assert Snapshot(1, 0, 0.0, (), ()).epoch == 0
    assert Snapshot(1, 0, 0.0, (), (), 7).epoch == 7
