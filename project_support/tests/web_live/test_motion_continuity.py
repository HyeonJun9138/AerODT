"""Aircraft motion continuity across the real 25-30 s receipt cadence.

Truth is a straight constant-velocity track. Each synchronize call is one
runtime tick; observations arrive late and irregularly, as with OpenSky.
"""
import math

from data.ingestion.source_records import SourceRecords
from digital_twin.live_twin.state_synchronization import LiveSynchronizer, advance_previous
from digital_twin.live_twin.model_setup import load_definitions
from foundation.geodesy import to_ecef, from_ecef, velocity_ecef

LAT, LON, ALT, SPEED = 37.0, 127.0, 9000.0, 100.0


def truth(t, track=90.0):
    origin = to_ecef(LAT, LON, ALT)
    velocity = velocity_ecef(LAT, LON, track, SPEED, 0)
    return tuple(p + v * t for p, v in zip(origin, velocity))


def observation(t, track=90.0, **changes):
    lat, lon, alt = from_ecef(truth(t, track))
    item = dict(id="abc123", name="TEST123", latitude=lat, longitude=lon, altitude_m=alt,
                track_deg=track, speed_mps=SPEED, vertical_rate_mps=0, observed_at=t)
    item.update(changes)
    return [item]


class Flight:
    def __init__(self, **kwargs):
        self.store = SourceRecords()
        self.sync = LiveSynchronizer(**kwargs)
        self.previous = ()
        self.states = {}

    def observe(self, observed, received, **changes):
        self.store.register("test", observation(observed, **changes), received, format="aircraft_v1")

    def tick(self, t, records=None):
        self.previous = self.sync.synchronize(self.store.records() if records is None else records, t, previous=self.previous)
        self.states[t] = self.previous[0] if self.previous else None
        return self.states[t]

    def run(self, start, end):
        return [self.tick(t) for t in range(start, end + 1)]

    def step(self, t):
        return math.dist(self.states[t - 1].position_ecef_m, self.states[t].position_ecef_m)

    def error(self, t):
        return math.dist(self.states[t].position_ecef_m, truth(t))


def test_regular_25s_observations_neither_stall_nor_jump():
    flight = Flight()
    flight.observe(0, 10)
    flight.run(10, 34)
    flight.observe(25, 35)
    flight.run(35, 59)
    flight.observe(50, 60)
    flight.run(60, 85)
    states = [flight.states[t] for t in range(11, 86)]
    assert all(state.quality == "valid" for state in states)
    assert not any(state.discontinuity for state in states)
    assert len({state.continuity_id for state in states}) == 1
    steps = [flight.step(t) for t in range(11, 86)]
    assert min(steps) > 60 and max(steps) < 160, "constant 100 m/s truth must neither freeze nor teleport"
    assert max(flight.error(t) for t in range(11, 86)) < 60


def test_estimate_expires_into_a_frozen_stale_state_with_distinct_times():
    flight = Flight()
    flight.observe(0, 10)
    flight.run(10, 79)
    horizon = load_definitions()["aircraft"]["max_extrapolation_seconds"]
    assert 45 <= horizon <= 90, "bounded horizon covering the measured ~25 s cadence plus one missed poll"
    moving = flight.states[horizon]
    assert moving.quality == "valid" and moving.derivation == "estimated" and moving.valid_until == horizon
    frozen = [flight.states[t] for t in range(horizon + 1, 80)]
    assert all(state.quality == "stale" and state.derivation == "estimated" for state in frozen)
    assert all(state.position_ecef_m == frozen[0].position_ecef_m for state in frozen)
    assert math.dist(frozen[0].position_ecef_m, truth(horizon)) < 60
    assert frozen[-1].observation_time == 0 and frozen[-1].received_time == 10 and frozen[-1].state_time == 79


def test_short_outage_is_bridged_gradually_without_discontinuity():
    flight = Flight()
    flight.observe(0, 10)
    flight.run(10, 79)
    assert flight.states[79].quality == "stale"
    flight.observe(70, 80)
    flight.run(80, 100)
    recovered = [flight.states[t] for t in range(80, 101)]
    assert not any(state.discontinuity for state in recovered)
    assert all(state.continuity_id == flight.states[79].continuity_id for state in recovered)
    assert all(state.quality == "valid" for state in recovered)
    assert recovered[0].observation_time == 70 and recovered[0].received_time == 80 and recovered[0].state_time == 80
    first = flight.step(80)
    assert 200 < first < 1500, "a 2 km innovation is absorbed gradually, not teleported"
    assert flight.error(80) > flight.error(85) > flight.error(90)
    assert flight.error(95) < 30


def test_long_outage_is_one_discontinuity_and_the_flag_does_not_linger():
    flight = Flight()
    flight.observe(0, 10)
    flight.run(10, 109)
    flight.observe(100, 110)
    jump = flight.tick(110)
    assert jump.discontinuity and jump.continuity_id == flight.states[109].continuity_id + 1
    assert flight.error(110) < 5, "re-acquisition shows the observation, not a blend across the gap"
    following = flight.tick(111)
    assert following.discontinuity is False and following.continuity_id == jump.continuity_id
    retained = flight.tick(112, records=())
    assert retained.discontinuity is False and retained.continuity_id == jump.continuity_id
    assert retained.quality == "valid"
    assert advance_previous(jump, 113).discontinuity is False


def test_large_position_error_is_a_discontinuity_even_after_a_short_gap():
    flight = Flight()
    flight.observe(0, 10)
    flight.run(10, 34)
    lat = from_ecef(truth(25))[0]
    flight.observe(25, 35, latitude=lat + 0.45)
    jump = flight.tick(35)
    assert jump.discontinuity and jump.continuity_id == flight.states[34].continuity_id + 1
    assert flight.tick(36).discontinuity is False


def test_re_received_old_observation_updates_receipt_time_only():
    flight = Flight()
    flight.observe(0, 10)
    flight.run(10, 34)
    flight.store.register("test", observation(0), 35, format="aircraft_v1")
    state = flight.tick(35)
    assert state.discontinuity is False and state.continuity_id == flight.states[34].continuity_id
    assert state.observation_time == 0 and state.received_time == 35 and state.state_time == 35
    assert flight.error(35) < 60 and 60 < flight.step(35) < 160


def test_heading_correction_crosses_north_the_short_way():
    flight = Flight()
    flight.observe(0, 10, track=359)
    flight.run(10, 34)
    flight.observe(25, 35, track=1)
    state = flight.tick(35)
    assert state.orientation_source == "ground_track"
    assert min(state.heading_deg, 360 - state.heading_deg) < 1.0, "must not rotate through 180"
    flight.run(36, 50)
    assert abs(flight.states[50].heading_deg - 1) < 0.05


def test_late_packet_keeps_continuity_and_clears_no_flags():
    flight = Flight()
    flight.observe(0, 10)
    flight.run(10, 34)
    flight.observe(25, 35)
    flight.tick(35)
    flight.store.register("test", observation(20), 36, format="aircraft_v1")
    state = flight.tick(36)
    assert state.observation_time == 25 and state.discontinuity is False
    assert 60 < flight.step(36) < 160
