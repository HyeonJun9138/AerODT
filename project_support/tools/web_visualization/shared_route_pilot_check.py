"""Headless check of saved routes and optional concurrent native fleet execution.

Does not connect to, restart, or modify the dashboard. Writes numerical QA
evidence, not replacement runtime state. Use --fleet-seconds 3600 for one hour.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from communication.python.native_pilot import NativePilotLibrary
from digital_twin.model_library.flight_schedule import read_schedule
from digital_twin.model_library.route_network import network
from digital_twin.model_library.vertiport_layout import generate_layout
from digital_twin.simulation.scenario_engine import ScenarioEngine
from user_application.uam_mission.scenario_pilots import FlightPilot, ScenarioPilots


def inputs(workspace):
    folder = workspace / "simulation"
    paths = [folder / "vertiports.json", folder / "routes.json", folder / "examples/fpl_all.csv"]
    places = json.loads(paths[0].read_text(encoding="utf-8"))["vertiports"]
    places = [dict(p, layout=generate_layout(p)) for p in places]
    graph = json.loads(paths[1].read_text(encoding="utf-8"))
    graph = network(graph["nodes"], graph["links"], places)
    schedule = read_schedule(paths[2].read_bytes(), vertiports=places)
    hashes = {str(p.relative_to(workspace)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    return places, graph, schedule, hashes


def check_route(library, flight, route):
    pilot = FlightPilot(library, route, 180)
    modes, seconds, done, problem = [], 0, False, None
    try:
        for seconds in range(1, 4201):
            sample = pilot.advance(1)
            tilt = sample["tilt_deg"]
            mode = "rotor" if tilt <= 15 else "wing" if tilt >= 75 else "transition"
            if not modes or modes[-1] != mode:
                modes.append(mode)
            if sample["done"]:
                done = True
                break
    except (RuntimeError, ValueError) as error:
        problem = str(error)
    finally:
        pilot.close()
    return {"flight_id": flight["flight_id"], "origin": flight["origin"],
            "destination": flight["destination"], "done": done, "seconds": seconds,
            "mode_sequence": modes, "error": problem}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=ROOT / "data/workspace")
    parser.add_argument("--library", type=Path)
    parser.add_argument("--routes", type=int, default=24)
    parser.add_argument("--fleet-seconds", type=int, default=0)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--output", type=Path, default=ROOT / "data/workspace/visualization_checks/shared_route_pilot.json")
    args = parser.parse_args()
    if not 1 <= args.routes <= 256 or not 0 <= args.fleet_seconds <= 7200 or not 1 <= args.workers <= 8:
        parser.error("routes 1..256, fleet-seconds 0..7200, workers 1..8 required")
    places, graph, schedule, hashes = inputs(args.workspace)
    library = NativePilotLibrary(args.library)
    # Match the existing scheduled-day provisional waypoint policy. Its use is
    # reported by the route resolver, not added to the saved network.
    options = dict(vertiports=places, network=graph, provisional_names=("지점 20",))
    engine = ScenarioEngine(schedule, **options)
    cases, seen = [], set()
    try:
        for flight in engine.flights.values():
            key = tuple(flight.get("route_path") or (flight["origin"], flight["destination"]))
            if key in seen or flight.get("route_error"):
                continue
            seen.add(key)
            cases.append((flight, engine.route(flight)))
            if len(cases) >= args.routes:
                break
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            results = list(pool.map(lambda case: check_route(library, *case), cases))
    finally:
        engine.close()
    report = {"input_sha256": hashes, "routes": results, "fleet": None,
              "limits": "headless reference AirTaxi physics; no collision/terrain/Unreal validation"}
    if args.fleet_seconds:
        engine = ScenarioEngine(schedule, pilots=ScenarioPilots(library, workers=args.workers), **options)
        start = engine.time_s
        try:
            for second in range(args.fleet_seconds):
                engine.advance(engine.time_s + 1)
                if engine.problems:
                    break
            report["fleet"] = {"seconds": engine.time_s - start,
                               "summary": engine.summary(), "problems": engine.problems}
        finally:
            engine.close()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    failures = sum(not r["done"] for r in results)
    print(f"routes completed {len(results)-failures}/{len(results)}; evidence: {args.output}")
    return int(bool(failures or (report["fleet"] and report["fleet"]["problems"])))


if __name__ == "__main__":
    raise SystemExit(main())
