"""Check route connectivity and native traversal using captured dashboard inputs.

Read-only with respect to the dashboard and original plan. --repair-output
writes a new CSV, filling only absent routes; existing waypoint order and all
other schedule columns are retained. It never starts or restarts a server.
"""
import argparse
import csv
import hashlib
import io
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from communication.python.native_pilot import NativePilotLibrary
from digital_twin.model_library import flight_plan, flight_schedule, scheduled_route
from digital_twin.simulation.scenario_engine import ScenarioEngine
from user_application.uam_mission.plan_generation import build_timings
from user_application.uam_mission.scenario_pilots import FlightPilot


def fill_missing_routes(text, graph):
    reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")))
    fields, rows = reader.fieldnames, list(reader)
    for field in ("route_waypoint_count", "route_path"):
        if field not in fields:
            fields.append(field)
    cache, filled, preserved = {}, 0, 0
    for row in rows:
        start = f"fato:{row['origin_vertiport_id']}:{row['departure_fato_id']}"
        end = f"fato:{row['destination_vertiport_id']}:{row['arrival_fato_id']}"
        if row.get("route_path", "").strip():
            scheduled_route.resolve(graph, json.loads(row["route_path"]), start, end)
            preserved += 1
            continue
        if (start, end) not in cache:
            cache[start, end] = flight_plan.air_path(graph, start, end)
        route = cache[start, end]
        if route is None:
            raise ValueError(f"{row['flight_plan_id']}: disconnected route, not repaired")
        row["route_path"] = json.dumps(route["nodes"], ensure_ascii=False)
        row["route_waypoint_count"] = str(len(route["nodes"]))
        filled += 1
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=fields)
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue(), {"flights": len(rows), "filled": filled, "preserved": preserved}


def route_ids(route):
    result = []
    for phase in route.phases:
        for identifier in phase.detail.get("supplied_waypoints", ()):
            if not result or result[-1] != identifier:
                result.append(identifier)
    return result


class ObservedLibrary:
    def __init__(self, library):
        self.library = library

    def create(self, points, *args):
        self.points = points
        return self.library.create(points, *args)


def native_traversal(library, flight, route):
    observed = ObservedLibrary(library)
    pilot = FlightPilot(observed, route, 55)
    changes, previous, maximum_cross, samples = [], 0, 0.0, []
    try:
        for _ in range(21000):
            raw = list(pilot.native.advance(0.2))
            samples.append(raw)
            index = int(raw[14])
            if index != previous:
                changes.append({"time_s": raw[0], "from": previous, "to": index})
                previous = index
            if raw[16]:
                break
            target = observed.points[index]
            start = observed.points[index-1] if index else (0, 0, 0)
            dx, dy = target[0]-start[0], target[1]-start[1]
            length = math.hypot(dx, dy)
            if length > 1:
                share = max(0, min(1, ((raw[1]-start[0])*dx+(raw[2]-start[1])*dy)/length**2))
                maximum_cross = max(maximum_cross, math.hypot(
                    raw[1]-start[0]-share*dx, raw[2]-start[1]-share*dy))
    finally:
        pilot.close()
    return {"flight_id": flight["flight_id"], "origin": flight["origin"],
            "destination": flight["destination"], "source_waypoints": flight["route_path"],
            "phase_waypoint_ids": route_ids(route), "native_targets": observed.points,
            "done": bool(samples[-1][16]), "seconds": samples[-1][0],
            "index_changes": changes, "max_lateral_distance_to_active_leg_m": maximum_cross,
            "rows": samples}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--captures", type=Path, required=True)
    parser.add_argument("--repair-output", type=Path, required=True)
    parser.add_argument("--example", type=Path, default=ROOT / "data/workspace/simulation/examples/fpl_all.csv")
    args = parser.parse_args()
    if args.repair_output.exists():
        parser.error("repair output already exists; original files are never overwritten")
    graph_path = args.captures / "live_network.json"
    places_path = args.captures / "live_vertiports.json"
    schedule_path = args.captures / "live_generated_plan.csv"
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    places = json.loads(places_path.read_text(encoding="utf-8"))["vertiports"]
    pairs = [{"from": a["id"], "to": b["id"]}
             for i, a in enumerate(places) for b in places[i+1:]]
    timings, notes, blocked = build_timings(pairs, places, graph, None)
    fixed, summary = fill_missing_routes(schedule_path.read_text(encoding="utf-8-sig"), graph)
    schedule = flight_schedule.read_schedule(fixed, vertiports=places)
    engine = ScenarioEngine(schedule, vertiports=places, network=graph)
    verified = 0
    for flight in schedule["flights"]:
        assert flight["route_path"] and not flight.get("route_error")
        route = engine.route(flight)
        assert not route.direct and route_ids(route) == flight["route_path"]
        verified += 1
    example = flight_schedule.read_schedule(args.example.read_bytes(), vertiports=places)
    other = ScenarioEngine(example, vertiports=places, network=graph, provisional_names=("지점 20",))
    library = NativePilotLibrary()
    checks = []
    for prefix, chosen, host in (("example", example["flights"][0], other),
                                 ("generated", schedule["flights"][0], engine),
                                 ("generated", schedule["flights"][1], engine)):
        result = native_traversal(library, chosen, host.route(chosen))
        path = args.captures / f"{prefix}_{chosen['flight_id']}_native.json"
        path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        del result["rows"]
        checks.append(result)
    engine.close()
    other.close()
    assert all(item["done"] for item in checks)
    assert not blocked, notes
    args.repair_output.parent.mkdir(parents=True, exist_ok=True)
    args.repair_output.write_text(fixed, encoding="utf-8-sig")
    report = {"connected_ordered_pairs": len(timings), "blocked_pairs": len(blocked),
              "original_links": len(graph["links"]), "repair": summary,
              "verified_phase_routes": verified, "native": checks,
              "hashes": {str(p): hashlib.sha256(p.read_bytes()).hexdigest()
                         for p in (graph_path, places_path, schedule_path, args.example, args.repair_output)},
              "limits": "Native order/completion checked; not certified corridor containment. "
                        "Lateral excursions are reported, not hidden. Existing timetable retained, "
                        "not rescheduled for the longer network routes. No Unreal validation."}
    (args.captures / "route_check.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k not in ("native", "hashes")}, ensure_ascii=False))
    for result in checks:
        print(result["flight_id"], result["done"], result["seconds"],
              round(result["max_lateral_distance_to_active_leg_m"], 1))


if __name__ == "__main__":
    main()
