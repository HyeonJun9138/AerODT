"""Isolated native-flight replay; never connects to or advances the live server."""
import json
import math
from pathlib import Path
import statistics
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from communication.python.native_pilot import NativePilotLibrary
from digital_twin.live_twin.trajectory import aircraft_trajectory, _at
from digital_twin.live_twin.uam_trajectory import uam_trajectory
from project_support.tests.web_live.test_scenario_session import make, CSV
from user_application.uam_mission.scenario_pilots import ScenarioPilots


def main():
    session, _ = make()
    session.load(CSV)
    session.open_control()
    session.engine.pilots = ScenarioPilots(NativePilotLibrary(), workers=1)
    history, forecasts, frames, durations = {}, [], [], []
    started = time.perf_counter()
    try:
        for step in range(1200):
            session.engine.advance(session.engine.time_s + 1)
            for e in session.entities():
                history.setdefault(e.entity_id, []).append([e.state_time, *e.position_ecef_m])
                if e.entity_id != "scenario:A1":
                    continue
                frames.append({"time": e.state_time, "phase": e.flight_phase,
                               "position": e.position_ecef_m, "velocity": e.velocity_ecef_mps,
                               "heading": e.heading_deg, "pitch": e.pitch_deg, "roll": e.roll_deg})
                if step % 10 or e.flight_phase in {"parked", "charge", "gate_in", "gate_out"}:
                    continue
                state, intent = session.prediction_input(e.entity_id)
                began = time.perf_counter()
                predicted = uam_trajectory(state, 60, intent)
                durations.append((time.perf_counter() - began) * 1000)
                baseline = aircraft_trajectory(state, {"model_id": "constant_velocity_v1"}, 60)
                if predicted and baseline:
                    forecasts.append({"entity_id": e.entity_id, "time": e.state_time, "phase": e.flight_phase,
                                      "mission": intent.mission_id, "new": predicted, "baseline": baseline})
            if step % 120 == 0:
                print(f"simulated {step+1}s; forecasts={len(forecasts)}", flush=True)
            if session.engine.summary()["flights_completed"] >= 2:
                break
        errors = {}
        for forecast in forecasts:
            actual = history[forecast["entity_id"]]
            for horizon in (10, 30, 60):
                if forecast["time"] + horizon > actual[-1][0]:
                    continue
                truth = _at(actual, forecast["time"] + horizon)
                key = f"{forecast['phase']}:{horizon}s"
                row = errors.setdefault(key, {"new": [], "baseline": []})
                for mode in ("new", "baseline"):
                    row[mode].append(math.dist(truth, _at(forecast[mode]["points"], forecast["time"] + horizon)))
        metrics = {key: {"samples": len(row["new"]),
                         "mean_error_m": statistics.mean(row["new"]),
                         "baseline_error_m": statistics.mean(row["baseline"])} for key, row in errors.items()}
        output = ROOT / "data/workspace/visualization_checks/2026_09_11_uam_prediction"
        output.mkdir(parents=True, exist_ok=True)
        report = {"scenario": "isolated two-flight test fixture; actual native runtime",
                  "summary": session.engine.summary(), "elapsed_s": time.perf_counter()-started,
                  "prediction_ms": {"median": statistics.median(durations), "max": max(durations)},
                  "metrics": metrics, "frames": frames, "forecasts": forecasts}
        (output / "native_replay.json").write_text(json.dumps(report), encoding="utf-8")
        print(json.dumps({k: v for k, v in report.items() if k not in {"frames", "forecasts"}}, indent=2))
    finally:
        session.engine.pilots.close()


if __name__ == "__main__":
    main()
