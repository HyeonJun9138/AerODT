"""Model Library: conservative parameters for building a publishable UAM day.

These are timetable-planning values, not live-control limits.  The phase floors
come from the current 19-vertiport Seoul/Ulsan network and AeroDT quad
tiltrotor profile. FATO spacing turns facility contention into scheduled
departure delay before the PSU has to intervene. Air-route occupancy is
deliberately outside this planning model; runtime PSU rules still own actual
airspace separation and may delay a flight further.

The reproducible measurement is `project_support/tools/calibrate_uam_schedule.py`.
Its 2026-09-21 report is kept under `data/workspace/analysis/` and the decision
to use these values is recorded in ADR 0109.
"""
from bisect import bisect_left, insort
import math

SCHEMA_VERSION = 1
CALIBRATION_ID = "seoul_uam_20260921"

# Mean values are evidence the UI/report can show.  The timetable uses the
# P80-derived floors below: an ordinary variation in terminal assignment should
# not make the day late before it starts.
PHASE_MEAN_SECONDS = {
    "gate_out": 146.3,
    "takeoff": 13.7,
    "climb": 30.7,
    "cruise": 266.1,
    "descent": 30.3,
    "landing": 22.8,
    "gate_in": 134.6,
    "charge": 401.8,
}
PHASE_FLOOR_SECONDS = {
    "gate_out": 177.5,
    "takeoff": 13.7,
    "climb": 46.1,
    "descent": 45.1,
    "landing": 22.8,
    "gate_in": 160.7,
}

DEFAULTS = {
    "schema_version": SCHEMA_VERSION,
    "calibration_id": CALIBRATION_ID,
    "phase_mean_s": PHASE_MEAN_SECONDS,
    "phase_floor_s": PHASE_FLOOR_SECONDS,
    # 60 s is the measured P95 landing-pad motion (45.9 s) rounded up to
    # include clearing margin.
    "fato_headway_s": 60.0,
    # P80 charge minus mean charge is 117.1 s; rounded to a usable two minutes.
    # It is added after the cabin-class minimum turnaround.
    "turnaround_recovery_s": 120.0,
}


def defaults():
    """A detached copy safe for a caller to include in a result."""
    return {**DEFAULTS, "phase_mean_s": dict(PHASE_MEAN_SECONDS),
            "phase_floor_s": dict(PHASE_FLOOR_SECONDS)}


def validate(raw=None):
    """Validated planning parameters; partial mappings may override defaults."""
    values = defaults()
    if raw is None:
        return values
    if not isinstance(raw, dict):
        raise ValueError("planning: JSON 객체가 필요합니다")
    for name in ("fato_headway_s", "turnaround_recovery_s"):
        if name not in raw:
            continue
        try:
            number = float(raw[name])
        except (TypeError, ValueError):
            raise ValueError(f"{name}: 숫자가 필요합니다") from None
        if not 0.0 <= number <= 3600.0:
            raise ValueError(f"{name}: 0~3600초 범위입니다")
        values[name] = number
    if "phase_floor_s" in raw:
        if not isinstance(raw["phase_floor_s"], dict):
            raise ValueError("phase_floor_s: JSON 객체가 필요합니다")
        floors = dict(values["phase_floor_s"])
        for phase, given in raw["phase_floor_s"].items():
            if phase not in floors:
                raise ValueError(f"phase_floor_s.{phase}: 모르는 단계입니다")
            try:
                number = float(given)
            except (TypeError, ValueError):
                raise ValueError(f"phase_floor_s.{phase}: 숫자가 필요합니다") from None
            if not 0.0 <= number <= 3600.0:
                raise ValueError(f"phase_floor_s.{phase}: 0~3600초 범위입니다")
            floors[phase] = number
        values["phase_floor_s"] = floors
    return values


def apply_phase_floors(timing, planning=None):
    """Apply calibrated terminal floors while keeping route cruise time exact."""
    values = validate(planning)
    result = dict(timing)
    floors = values["phase_floor_s"]
    for phase in ("gate_out", "takeoff", "climb", "descent", "landing", "gate_in"):
        key = f"{phase}_s"
        result[key] = max(float(result.get(key) or 0.0), float(floors[phase]))
    result["air_s"] = result["climb_s"] + float(result.get("cruise_s") or 0.0) + result["descent_s"]
    result["planning_calibration_id"] = values["calibration_id"]
    return result


def event_specs(origin, destination, timing, planning=None):
    """Capacity events and their offsets from off-block for one planned leg."""
    values = validate(planning)
    gate_out = float(timing["gate_out_s"])
    takeoff = float(timing["takeoff_s"])
    air = float(timing["air_s"])
    landing = float(timing["landing_s"])
    events = []
    from_fato, to_fato = timing.get("from_fato"), timing.get("to_fato")
    if from_fato:
        events.append((f"fato:{origin}:{from_fato}", gate_out,
                       values["fato_headway_s"], "fato"))
    if to_fato:
        events.append((f"fato:{destination}:{to_fato}", gate_out + takeoff + air + landing,
                       values["fato_headway_s"], "fato"))
    return events


class PlanningSlotBook:
    """Sorted capacity-event reservations used only while a timetable is built."""
    def __init__(self):
        self._events = {}
        self.reservations = {"fato": 0}

    @staticmethod
    def _next_allowed(when, booked, headway):
        if headway <= 0 or not booked:
            return when
        position = bisect_left(booked, when)
        if position and when - booked[position - 1] < headway:
            return booked[position - 1] + headway
        if position < len(booked) and booked[position] - when < headway:
            return booked[position] + headway
        return when

    def earliest_start(self, start_s, specs):
        start = float(start_s)
        # Moving one event may create a later conflict on another resource.
        # Monotonic shifts make this converge; the bound protects malformed
        # input without silently booking an unsafe slot.
        for _ in range(10000):
            shifted = start
            for key, offset, headway, _kind in specs:
                allowed = self._next_allowed(start + float(offset),
                                             self._events.get(key, ()), float(headway))
                shifted = max(shifted, allowed - float(offset))
            if math.isclose(shifted, start, abs_tol=1e-7):
                return start
            start = shifted
        raise ValueError("planning capacity slots did not converge")

    def reserve(self, start_s, specs):
        for key, offset, _headway, kind in specs:
            insort(self._events.setdefault(key, []), float(start_s) + float(offset))
            self.reservations[kind] = self.reservations.get(kind, 0) + 1
