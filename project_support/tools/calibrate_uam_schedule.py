"""Measure timetable phase times over the saved UAM infrastructure.

This is deliberately an offline, read-only experiment.  It enumerates every
local gate/FATO taxi combination and every routable ordered FATO-to-FATO OD
combination using the same `flight_plan` builder as plan generation.  It does
not run the live scenario or mutate the source records.
"""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import itertools
import json
import math
from pathlib import Path
import statistics

from digital_twin.model_library import flight_plan, route_network, schedule_planning, uam_operating_profile
from digital_twin.model_library.ground_motion import prepare as prepare_ground_motion
from digital_twin.model_library.vertiport_layout import generate_layout, validate_definition


def _read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def _sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _percentile(values, fraction):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round((len(ordered) - 1) * fraction))]


def _stats(values):
    return {"samples": len(values), "mean_s": round(statistics.mean(values), 1),
            "median_s": round(statistics.median(values), 1),
            "p80_s": round(_percentile(values, .80), 1),
            "p90_s": round(_percentile(values, .90), 1),
            "p95_s": round(_percentile(values, .95), 1),
            "min_s": round(min(values), 1), "max_s": round(max(values), 1)}


def calibrate(vertiports_path, routes_path, profile=None):
    vertiport_document, route_document = _read(vertiports_path), _read(routes_path)
    records = []
    for raw in vertiport_document.get("vertiports") or ():
        definition = validate_definition(raw)
        records.append(dict(definition, layout=generate_layout(definition)))
    network = route_network.network(route_document.get("nodes") or (),
                                    route_document.get("links") or (), records)
    profile = uam_operating_profile.validate(profile)
    flown = uam_operating_profile.speeds(profile)
    phases, counts = defaultdict(list), defaultdict(int)

    # Terminal assignment experiment: every gate against every role-compatible
    # and route-connected FATO.  Ground motion is the same function the flight
    # builder uses, including its 30 s gate hold.
    for record in records:
        layout = record["layout"]
        takeoff = flight_plan.linked_fatos(network, record["id"], "takeoff")
        landing = flight_plan.linked_fatos(network, record["id"], "landing")
        for gate in layout.get("gates") or ():
            for fato in layout.get("fatos") or ():
                identifier, role = str(fato["id"]), str(fato.get("role") or "both")
                if identifier in takeoff and role in ("takeoff", "both"):
                    taxi = flight_plan.taxi_path(layout, gate["id"], identifier)
                    _path, _motion, _distance, duration = prepare_ground_motion(
                        taxi["points"], flown["taxi_out_mps"], flight_plan.GATE_HOLD_SECONDS)
                    phases["gate_out"].append(duration)
                if identifier in landing and role in ("landing", "both"):
                    taxi = flight_plan.taxi_path(layout, identifier, gate["id"])
                    _path, _motion, _distance, duration = prepare_ground_motion(
                        taxi["points"], flown["taxi_in_mps"], flight_plan.GATE_HOLD_SECONDS)
                    phases["gate_in"].append(duration)

    # Air and charge experiment: every ordered OD and every connected FATO pair.
    # The first gate is immaterial here because terminal taxi has already been
    # enumerated separately.
    for origin, destination in itertools.permutations(records, 2):
        from_fatos = flight_plan.linked_fatos(network, origin["id"], "takeoff")
        to_fatos = flight_plan.linked_fatos(network, destination["id"], "landing")
        for from_fato in origin["layout"].get("fatos") or ():
            if from_fato["id"] not in from_fatos or from_fato.get("role") not in ("takeoff", "both"):
                continue
            for to_fato in destination["layout"].get("fatos") or ():
                if to_fato["id"] not in to_fatos or to_fato.get("role") not in ("landing", "both"):
                    continue
                request = {"from_vertiport": origin["id"], "to_vertiport": destination["id"],
                           "from_gate": origin["layout"]["gates"][0]["id"],
                           "to_gate": destination["layout"]["gates"][0]["id"],
                           "from_fato": from_fato["id"], "to_fato": to_fato["id"],
                           "seat_capacity": 4, "passengers": 4,
                           "battery_start_pct": 100, "charge_target_pct": 100}
                try:
                    plan = flight_plan.build_plan(request, records, network, profile=profile)
                except (ValueError, KeyError):
                    counts["blocked_fato_od"] += 1
                    continue
                counts["routable_fato_od"] += 1
                for leg in plan["legs"]:
                    if leg["stage"] not in ("gate_out", "gate_in"):
                        phases[leg["stage"]].append(float(leg["duration_s"]))

    phase_stats = {phase: _stats(values) for phase, values in sorted(phases.items()) if values}
    floor = {}
    for phase in ("gate_out", "takeoff", "climb", "descent", "landing", "gate_in"):
        row = phase_stats[phase]
        floor[phase] = max(row["mean_s"], row["p80_s"])
    pad_motion_p95 = max(phase_stats["takeoff"]["p95_s"], phase_stats["landing"]["p95_s"])
    charge_tail = phase_stats["charge"]["p80_s"] - phase_stats["charge"]["mean_s"]
    proposed = {"phase_mean_s": {phase: row["mean_s"] for phase, row in phase_stats.items()},
                "phase_floor_s": floor,
                "fato_headway_s": math.ceil(pad_motion_p95 / 30.0) * 30.0,
                "turnaround_recovery_s": math.ceil(max(0.0, charge_tail) / 30.0) * 30.0}
    return {
        "schema_version": 1,
        "kind": "aerodt.uam_schedule_calibration",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "inputs": {"vertiports": Path(vertiports_path).as_posix(),
                   "vertiports_sha256": _sha256(vertiports_path),
                   "routes": Path(routes_path).as_posix(),
                   "routes_sha256": _sha256(routes_path),
                   "operating_profile": profile},
        "scope": {"vertiports": len(records), "route_nodes": len(network.get("nodes") or ()),
                  "route_links": len(network.get("links") or ()), **counts},
        "method": {"ground": "all gate/FATO combinations with authored taxi graph",
                   "air": "all ordered routable FATO-to-FATO OD combinations",
                   "aircraft": flight_plan.AIRCRAFT["id"], "passengers": 4,
                   "battery": "100% departure, charge back to 100%"},
        "phases": phase_stats,
        "proposed_profile": proposed,
        "implemented_profile": schedule_planning.defaults(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vertiports", default="data/workspace/simulation/vertiports.json")
    parser.add_argument("--routes", default="data/workspace/simulation/routes.json")
    parser.add_argument("--profile", help="optional operating profile JSON")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    profile = _read(args.profile) if args.profile else None
    report = calibrate(args.vertiports, args.routes, profile)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(output), "scope": report["scope"],
                      "proposed_profile": report["proposed_profile"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
