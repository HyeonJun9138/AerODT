"""Model-based live synchronization, independent of HTTP, storage and Cesium.

Compiled GP models are cached, not current twin positions. The caller supplies
previous authoritative snapshots for late-packet handling.

Satellites are propagated for the area the display reports: an object above the
horizon from somewhere on screen, plus a margin, is carried at the full tick
rate, and the rest of the catalogue is examined a slice at a time so one rising
into view is picked up within a sweep. With no reported view the whole catalogue
is propagated, as before.

Aircraft motion between observations is a bounded estimate under the model the
operator selected: it continues for max_extrapolation_seconds after the
observation, then freezes and is reported stale. A new observation after a short
gap is absorbed gradually; a long gap or an implausible innovation re-acquires
the aircraft with a new continuity generation instead of inventing travel
between them. With estimation switched off nothing is carried forward at all:
each aircraft sits at its last observation until the next one arrives.

The turn rate a turning model needs is the estimator's own working state, like a
filter's, and is kept here keyed by entity: it is measured from consecutive
observations and rebuilt from the next two if it is ever lost. The twin's
authoritative state stays in the snapshots the caller passes back in.
"""
import math
from dataclasses import replace

from digital_twin.contracts.live import TwinEntity
from digital_twin.live_twin.domains.aircraft.model_setup import (aircraft_model, aircraft_models, estimation_policy,
                                                load_definitions, select_model)
from digital_twin.live_twin.kinematics.motion import advance_state, blend_turn_rate, turn_rate_between, up_at
from digital_twin.model_library.ai_models import SAME_AS_ESTIMATION
from digital_twin.live_twin.kinematics.observed_trajectory import aircraft_trajectory
from digital_twin.live_twin.domains.aircraft.state_estimation import aircraft_observations
from digital_twin.live_twin.domains.satellite.visibility import over_view
from digital_twin.live_twin.domains.satellite.trajectory import propagate_ecef, satellite_trajectory
from digital_twin.model_library.visual_matching import SatelliteModelMatcher
from foundation.geodesy import to_ecef, from_ecef, velocity_ecef


def carry_seconds(entity, target_time):
    """How long a prior state may be carried before it stops being valid."""
    if entity.valid_until is None:
        return 0.0
    return max(0.0, min(target_time, entity.valid_until) - min(entity.state_time, entity.valid_until))


def predicted_state(entity, target_time, turn_rate_dps=None, extrapolate=True):
    """Position and velocity of a prior state, frozen at its validity edge."""
    velocity = entity.velocity_ecef_mps
    dt = carry_seconds(entity, target_time) if extrapolate else 0.0
    if not dt or not velocity:
        return entity.position_ecef_m, velocity
    return advance_state(entity.position_ecef_m, velocity,
                         up_at(entity.latitude_deg, entity.longitude_deg), turn_rate_dps, dt)


def predicted_position(entity, target_time, turn_rate_dps=None, extrapolate=True):
    """Where a prior state is now under the estimation model."""
    return predicted_state(entity, target_time, turn_rate_dps, extrapolate)[0]


def advance_previous(entity, target_time, turn_rate_dps=None, extrapolate=True):
    position, velocity = predicted_state(entity, target_time, turn_rate_dps, extrapolate)
    lat, lon, height = from_ecef(position)
    turned = carry_seconds(entity, target_time) if extrapolate else 0.0
    # A discontinuity marks the single tick where continuity changed; carrying
    # an old prior forward is not a new discontinuity.
    return replace(entity, position_ecef_m=position, velocity_ecef_mps=velocity,
        latitude_deg=lat, longitude_deg=lon, altitude_m=height, state_time=target_time,
        heading_deg=_heading_after(entity, turn_rate_dps, turned), discontinuity=False,
        quality="stale" if entity.valid_until is None or target_time > entity.valid_until else entity.quality,
        # Carrying a state forward is what makes it an estimate. With the
        # estimator off nothing is carried, so the state is still the observation.
        derivation="estimated" if entity.kind == "aircraft" and extrapolate else entity.derivation)


def _heading_after(entity, turn_rate_dps, dt):
    if entity.kind != "aircraft" or not turn_rate_dps or not dt or entity.heading_deg is None:
        return entity.heading_deg
    return (entity.heading_deg + turn_rate_dps * dt) % 360


def blend_heading(previous, candidate, gain):
    """Move a ground track toward a new value along the shorter arc (359 -> 1 passes 0)."""
    if previous is None or candidate is None:
        return candidate
    delta = (candidate - previous + 180) % 360 - 180
    return (previous + gain * delta) % 360


def _speed(velocity):
    return math.hypot(*velocity) if velocity else 0.0


class LiveSynchronizer:
    def __init__(self, definitions=None, retention_seconds=300, matcher=None, view=None, sweep_seconds=20.0,
                 estimation=None, prediction_history=None):
        self.definitions = definitions if definitions is not None else load_definitions()
        self.retention_seconds = retention_seconds
        # What the operator decided about state estimation: a value or a
        # callable read each tick, so a change applies without a restart.
        self.estimation = estimation
        # Static model-library rules, not runtime state; the composition root
        # supplies the set of assets the library actually publishes.
        self.matcher = matcher if matcher is not None else SatelliteModelMatcher()
        # Where the display is looking, supplied by composition as a value or a
        # callable read each tick. None means no scoping: propagate everything.
        self.view = view
        # How long the catalogue may take to be examined once. A satellite that
        # rises into view is carried within this, covered by the model's margin.
        self.sweep_seconds = sweep_seconds
        self._compiled_gp = {}
        self._overhead = {}
        self._sweep = {}
        # A turning model's working state: the last ground track each aircraft was
        # observed on, and the turn rate measured from one observation to the next.
        self._turn = {}
        self._track = {}
        self._prediction_history = prediction_history
        self._prediction_clock = None
        self._provider_gru = None

    def policy(self):
        return estimation_policy(self.estimation)

    def aircraft_model(self, policy=None):
        return aircraft_model(self.definitions, (policy or self.policy())["model"])

    def prediction_model(self, policy=None):
        """The model that draws the path, or None when the chosen one cannot run
        on what this feed delivers.

        GRU accepts an explicitly corrected provider window through the injected
        raw-report history. Availability here describes weights, not whether a
        particular aircraft currently has a valid input window.
        """
        policy = policy or self.policy()
        chosen = policy.get("prediction_model")
        if not chosen or chosen == SAME_AS_ESTIMATION:
            return self.aircraft_model(policy)
        known = {model["model_id"] for model in aircraft_models(self.definitions)}
        if chosen in known:
            return aircraft_model(self.definitions, chosen)
        if chosen == 'gru_direct_v1_1':
            from digital_twin.model_library.prediction_catalog import find_model
            delivered = find_model(chosen)
            return delivered if delivered and delivered.get('ready') else None
        return None

    def uam_prediction_model(self, policy=None):
        """The model that draws a UAM's path, or None when it cannot run here.

        The delivered UAM networks need the aircraft's attitude, its rates, the
        wind and what its controller is aiming at, along with the route it has
        left. None of that is in a twin entity, so choosing one draws nothing
        until it is fed properly - which is better than a path from invented
        input.
        """
        policy = policy or self.policy()
        chosen = policy.get("uam_prediction_model")
        from digital_twin.model_library.uam_intent_model import MODEL
        if chosen == MODEL["model_id"]:
            return dict(MODEL)
        if not chosen:
            return None
        known = {model["model_id"] for model in aircraft_models(self.definitions)}
        return aircraft_model(self.definitions, chosen) if chosen in known else None

    def turn_rate(self, entity_id, model):
        """The turn rate this model would carry for that aircraft, or None."""
        return self._turn.get(entity_id) if model.get("turn") else None

    def synchronize(self, records, target_time, previous=()):
        if not math.isfinite(target_time):
            raise ValueError("Invalid synchronization time")
        if self._prediction_history is not None and self._prediction_clock is not None and target_time < self._prediction_clock:
            self._prediction_history.clear()
        self._prediction_clock = target_time
        old = {entity.entity_id: entity for entity in previous}
        policy = self.policy()
        model = self.aircraft_model(policy)
        result = {}
        for record in records:
            if record.format == "celestrak_gp":
                max_jump = self.definitions['satellite']['max_update_jump_m']
                for entity in self._satellites(record, target_time):
                    prior = old.get(entity.entity_id)
                    if prior:
                        jump = math.dist(predicted_position(prior, target_time), entity.position_ecef_m) > max_jump
                        if jump or prior.continuity_id:
                            entity = replace(entity, discontinuity=jump, continuity_id=prior.continuity_id + int(jump))
                    result[entity.entity_id] = entity
            else:
                for observation in aircraft_observations(record):
                    identifier = f"{record.source}:{observation['id']}"
                    prior = old.get(identifier)
                    latest_observation = max(observation['observed_at'], prior.observation_time if prior else -math.inf)
                    if target_time - latest_observation > self.retention_seconds:
                        continue
                    if prior and prior.observation_time is not None and observation["observed_at"] < prior.observation_time:
                        result[identifier] = self._carry(prior, target_time, model, policy)
                        continue
                    entity = self._aircraft(record, observation, target_time, model, policy)
                    if entity:
                        if prior:
                            entity = self._correct(prior, entity, target_time, model, policy)
                        if self._prediction_history is not None:
                            self._prediction_history.observe(identifier, observation['observed_at'],
                                to_ecef(observation['latitude'], observation['longitude'], observation['altitude_m']),
                                velocity_ecef(observation['latitude'], observation['longitude'], observation['track_deg'],
                                              observation['speed_mps'], observation['vertical_rate_mps']),
                                reset=entity.discontinuity)
                        result[identifier] = entity
        # Missing aircraft are retained as stale observations, not erased at every batch.
        for identifier, entity in old.items():
            if (identifier not in result and entity.kind == "aircraft"
                    and entity.observation_time is not None
                    and target_time - entity.observation_time <= self.retention_seconds):
                result[identifier] = self._carry(entity, target_time, model, policy)
        # A turn rate belongs to an aircraft that is still being tracked.
        self._turn = {identifier: rate for identifier, rate in self._turn.items() if identifier in result}
        self._track = {identifier: seen for identifier, seen in self._track.items() if identifier in result}
        if self._prediction_history is not None:
            self._prediction_history.keep(result)
        return tuple(result.values())

    def _carry(self, entity, target_time, model, policy):
        return advance_previous(entity, target_time, self.turn_rate(entity.entity_id, model),
                                extrapolate=policy["enabled"])

    def _correct(self, previous, candidate, target, model=None, policy=None):
        model = model or self.aircraft_model()
        policy = policy or self.policy()
        turn = self.turn_rate(previous.entity_id, model)
        predicted = predicted_position(previous, target, turn, extrapolate=policy["enabled"])
        earlier = candidate.observation_time if previous.observation_time is None else previous.observation_time
        gap = max(0.0, candidate.observation_time - earlier)
        error = math.dist(predicted, candidate.position_ecef_m)
        # Error grows with the time the prior had to bridge; only excess is implausible.
        speed = max(_speed(previous.velocity_ecef_mps), _speed(candidate.velocity_ecef_mps))
        allowed = model['max_innovation_m'] + model.get('innovation_gap_fraction', 0) * speed * gap
        if gap > model['max_bridge_gap_seconds'] or error > allowed:
            # After a long loss or an unrelated position, do not invent smooth
            # travel, and do not carry a turn measured before the break.
            self._turn.pop(previous.entity_id, None)
            return replace(candidate, discontinuity=True, continuity_id=previous.continuity_id + 1)
        if not policy["enabled"]:
            # Estimation off: the observation is the state, with nothing blended in.
            return replace(candidate, continuity_id=previous.continuity_id)
        dt = max(0.0, target - previous.state_time)
        gain = 1 - math.exp(-dt / model['correction_seconds'])
        position = tuple(a + gain * (b - a) for a, b in zip(predicted, candidate.position_ecef_m))
        old_velocity = previous.velocity_ecef_mps or candidate.velocity_ecef_mps
        velocity = tuple(a + gain * (b - a) for a, b in zip(old_velocity, candidate.velocity_ecef_mps))
        lat, lon, height = from_ecef(position)
        return replace(candidate, position_ecef_m=position, velocity_ecef_mps=velocity,
                       heading_deg=blend_heading(previous.heading_deg, candidate.heading_deg, gain),
                       latitude_deg=lat, longitude_deg=lon, altitude_m=height,
                       derivation='estimated', continuity_id=previous.continuity_id)

    # The turn a model carries is measured between two *observed* ground tracks.
    # The estimate itself must stay out of that: comparing a new report against a
    # heading the model has already turned would measure what is left over and
    # drive the estimate to zero rather than to the turn being flown. The same
    # observation arriving again on the next tick has no gap and changes nothing.
    def _measure_turn(self, identifier, observation, model):
        seen = self._track.get(identifier)
        self._track[identifier] = (observation["observed_at"], observation["track_deg"])
        if not model.get("turn") or seen is None:
            return
        measured = turn_rate_between(seen[1], observation["track_deg"],
                                     observation["observed_at"] - seen[0], model.get("max_turn_rate_dps", 3.0))
        blended = blend_turn_rate(self._turn.get(identifier), measured, model.get("turn_blend", 0.6))
        if blended is not None:
            self._turn[identifier] = blended

    def _aircraft(self, record, observation, target, model=None, policy=None):
        _, asset = select_model("aircraft", self.definitions)
        model = model or self.aircraft_model()
        policy = policy or self.policy()
        if (observation["speed_mps"] > model["max_speed_mps"]
                or abs(observation["vertical_rate_mps"]) > model["max_climb_mps"]
                or observation["observed_at"] > target + 2):
            return None
        observed = observation["observed_at"]
        valid_until = observed + model["max_extrapolation_seconds"]
        dt = max(0, min(target, valid_until) - observed) if policy["enabled"] else 0
        identifier = f"{record.source}:{observation['id']}"
        self._measure_turn(identifier, observation, model)
        position = to_ecef(observation["latitude"], observation["longitude"], observation["altitude_m"])
        velocity = velocity_ecef(observation["latitude"], observation["longitude"],
            observation["track_deg"], observation["speed_mps"], observation["vertical_rate_mps"])
        turn = self.turn_rate(identifier, model)
        position, velocity = advance_state(position, velocity,
            up_at(observation["latitude"], observation["longitude"]), turn, dt)
        lat, lon, height = from_ecef(position)
        return TwinEntity(entity_id=identifier, name=observation["name"],
            kind="aircraft", position_ecef_m=position, velocity_ecef_mps=velocity,
            latitude_deg=lat, longitude_deg=lon, altitude_m=height,
            heading_deg=(observation["track_deg"] + (turn or 0.0) * dt) % 360, state_time=target,
            observation_time=observed, received_time=record.received_time, orbit_epoch=None,
            derivation="observed" if dt == 0 else "estimated", quality="stale" if target > valid_until else "valid",
            source=record.source, model_id=model["model_id"], visual_asset_id=asset,
            provenance=record.provenance, orientation_source="ground_track", valid_until=valid_until,
            visual_match="representative")

    def trajectory(self, entity, target_time=None, *, intent=None):
        """Bounded path of one object; None when nothing can be projected for it."""
        target = entity.state_time if target_time is None else target_time
        if not math.isfinite(target):
            return None
        # A provider aircraft state carries no filed route. What can be offered
        # is where the estimation model says it is going next, for as long as
        # that model is still valid, and only when a display asked for it.
        if entity.kind == "aircraft":
            policy = self.policy()
            if not (policy["enabled"] and policy["prediction"]):
                return None
            model = self.prediction_model(policy)
            if model is None:
                return None
            if model['model_id'] == 'gru_direct_v1_1':
                if self._prediction_history is None:
                    return None
                from digital_twin.live_twin.domains.aircraft.gru_prediction import GruTrajectoryModel
                from digital_twin.live_twin.domains.aircraft.provider_gru import provider_trajectory
                if self._provider_gru is None:
                    self._provider_gru = GruTrajectoryModel.from_model(model)
                path = provider_trajectory(entity, self._prediction_history.read(entity.entity_id),
                    self._provider_gru, target, self.aircraft_model(policy)['max_extrapolation_seconds'],
                    policy['prediction_seconds'])
            else:
                path = aircraft_trajectory(entity, model, policy["prediction_seconds"],
                                           self.turn_rate(entity.entity_id, model), target)
        elif entity.kind == "uam":
            # A UAM the twin is flying has a route, but the route is the plan.
            # What is drawn here is where the *state* is going, so a model that
            # ignores the plan and one that uses it can be told apart on screen.
            policy = self.policy()
            if not policy.get("uam_prediction"):
                return None
            model = self.uam_prediction_model(policy)
            if model is None:
                return None
            from digital_twin.live_twin.domains.uam.trajectory import uam_trajectory
            from digital_twin.model_library.uam_intent_model import MODEL_ID
            path = (uam_trajectory(entity, policy.get("uam_prediction_seconds", 60), intent)
                    if model["model_id"] == MODEL_ID else
                    aircraft_trajectory(entity, model, policy.get("uam_prediction_seconds", 60),
                                        self.turn_rate(entity.entity_id, model), target))
        elif entity.kind == "satellite":
            source, _, identifier = entity.entity_id.partition(":")
            cached = self._compiled_gp.get(source)
            entry = cached[2].get(identifier) if cached else None
            if entry is None:
                return None
            sat, epoch = entry
            valid_until = epoch + self.definitions["satellite"]["max_epoch_age_seconds"]
            path = satellite_trajectory(sat, epoch, target, valid_until)
        else:
            return None
        if path is None:
            return None
        return dict(path, entity_id=entity.entity_id, name=entity.name, source=entity.source,
                    provenance=entity.provenance, model_id=entity.model_id,
                    continuity_id=entity.continuity_id, flight_phase=entity.flight_phase)

    def _due(self, source, compiled, target, view):
        """The models to propagate for this tick.

        Without a view every model is due, which is what a catalogue-wide
        display needs. With one, the tick propagates what was over the view last
        time - those must be current, they are on screen - plus a slice of the
        catalogue proportional to the time since the last tick, so every object
        is examined once per sweep_seconds however fast the caller ticks. The
        cost of a tick becomes what is on screen plus one slice, instead of the
        whole catalogue every time.
        """
        if view is None or not compiled:
            self._sweep.pop(source, None)
            return compiled
        overhead = self._overhead.setdefault(source, set())
        cursor, previous = self._sweep.get(source, (0, None))
        elapsed = self.sweep_seconds if previous is None else max(0.0, target - previous)
        share = 1.0 if self.sweep_seconds <= 0 else min(1.0, elapsed / self.sweep_seconds)
        count = min(len(compiled), math.ceil(len(compiled) * share))
        cursor %= len(compiled)
        slice_ = compiled[cursor:cursor + count]
        if len(slice_) < count:
            slice_ = slice_ + compiled[:count - len(slice_)]
        self._sweep[source] = ((cursor + count) % len(compiled), target)
        swept = {entry[0] for entry in slice_}
        return slice_ + [entry for entry in compiled if entry[0] in overhead and entry[0] not in swept]

    def _satellites(self, record, target):
        from sgp4.api import Satrec
        from sgp4 import omm

        model, asset = select_model("satellite", self.definitions)
        cached = self._compiled_gp.get(record.source)
        if cached is None or cached[0] is not record:
            compiled, index = [], {}
            fields_list = record.payload if isinstance(record.payload, (list, tuple)) else ()
            for fields in fields_list:
                try:
                    normalized = dict(CENTER_NAME="EARTH", REF_FRAME="TEME", TIME_SYSTEM="UTC", MEAN_ELEMENT_THEORY="SGP4")
                    normalized.update(fields)
                    external_id = int(fields['NORAD_CAT_ID'])
                    if not 0 < external_id < 1000000000:
                        continue
                    # SGP4's Alpha-5 bookkeeping field is narrower than OMM IDs.
                    # The number does not enter propagation; retain the real ID outside Satrec.
                    if external_id > 339999:
                        normalized['NORAD_CAT_ID'] = 0
                    sat = Satrec()
                    omm.initialize(sat, normalized)
                    epoch = (sat.jdsatepoch + sat.jdsatepochF - 2440587.5) * 86400
                    name = str(fields.get("OBJECT_NAME", fields["NORAD_CAT_ID"]))
                    # Model assignment depends on the catalogue entry, not on time.
                    match = self.matcher.resolve(name, norad=external_id, regime=fields.get("ORBIT_REGIME"))
                    compiled.append((str(fields["NORAD_CAT_ID"]), name, sat, epoch, match))
                    index[str(fields["NORAD_CAT_ID"])] = (sat, epoch)
                except (KeyError, ValueError, TypeError, OverflowError, AttributeError):
                    continue
            cached = (record, compiled, index)
            self._compiled_gp[record.source] = cached
            # A new catalogue invalidates which objects were overhead in the old one.
            self._overhead.pop(record.source, None)
            self._sweep.pop(record.source, None)
        view = self.view() if callable(self.view) else self.view
        overhead = self._overhead.setdefault(record.source, set())
        margin = model.get("view_margin_deg", 3.0)
        for identifier, name, sat, epoch, match in self._due(record.source, cached[1], target, view):
            if not math.isfinite(epoch) or epoch - target > model['max_future_epoch_seconds']:
                continue
            # Do not extrapolate an arbitrarily old GP forever. Freeze at validity edge.
            valid_until = epoch + model["max_epoch_age_seconds"]
            evaluation = min(target, valid_until)
            state = propagate_ecef(sat, evaluation)
            if state is None:
                continue
            fixed, fixed_velocity = state
            lat, lon, height = from_ecef(fixed)
            if view is not None:
                if over_view(view, lat, lon, height, margin_deg=margin):
                    overhead.add(identifier)
                else:
                    # Not over the display: remembered as gone, not carried.
                    overhead.discard(identifier)
                    continue
            yield TwinEntity(entity_id=f"{record.source}:{identifier}", name=name, kind="satellite",
                position_ecef_m=fixed, velocity_ecef_mps=fixed_velocity, latitude_deg=lat,
                longitude_deg=lon, altitude_m=height, heading_deg=None, state_time=target,
                observation_time=None, received_time=record.received_time, orbit_epoch=epoch,
                derivation="gp_propagated", quality="stale" if target > valid_until else "valid",
                source=record.source, model_id=model["model_id"],
                visual_asset_id=match.asset_id or "", visual_match=match.quality,
                provenance=record.provenance, valid_until=valid_until)
