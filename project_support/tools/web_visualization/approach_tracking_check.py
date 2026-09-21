"""Measure saved approaches with actual native snapshots, never the display.

Read-only with respect to the dashboard and its plans. Select an old/new DLL
with --library to compare the same route geometry; output includes input hashes.
"""
import argparse
import json
import math
from pathlib import Path
import statistics
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from communication.python.native_pilot import NativePilotLibrary
from digital_twin.simulation.scenario_engine import ScenarioEngine
from user_application.uam_mission.scenario_pilots import FlightPilot
from project_support.tools.web_visualization.shared_route_pilot_check import inputs


def measure(library, route):
    class Capture:
        def create(self, points, *args):
            self.points = points
            return library.create(points, *args)
    capture = Capture()
    pilot = FlightPilot(capture, route, 180)
    rows = []
    try:
        for _ in range(4200):
            row = pilot.native.advance(1)
            rows.append(row)
            if row[16]:
                break
    finally:
        pilot.close()
    segments = []
    for index in range(1, len(capture.points)):
        if route.phases[pilot.indices[index]].stage != 'descent':
            continue
        a, b = capture.points[index - 1], capture.points[index]
        n, e = b[0] - a[0], b[1] - a[1]
        length = math.hypot(n, e)
        samples = [r for r in rows if r[14] == index]
        if length < 1 or not samples:
            continue
        middle = [r for r in samples if a[2] + 20 < r[3] < b[2] - 20 and r[6] > .5]
        # A small correction over the final hover is not a return to the entry.
        before_final = [r for r in samples if math.hypot(b[0]-r[1], b[1]-r[2]) > 30]
        segments.append({'index': index, 'horizontal_m': length, 'drop_m': b[2]-a[2],
            'seconds': len(samples), 'steady_samples': len(middle),
            'median_horizontal_mps': statistics.median(math.hypot(r[4], r[5]) for r in middle) if middle else None,
            'median_down_mps': statistics.median(r[6] for r in middle) if middle else None,
            'max_down_mps': max(r[6] for r in samples),
            'reverse_course_samples': sum((r[4]*n+r[5]*e)/length < -.25 for r in before_final),
            'max_height_above_entry_m': max(0, max(a[2]-r[3] for r in samples))})
    return {'done': bool(rows[-1][16]), 'seconds': rows[-1][0], 'segments': segments,
            'targets': capture.points, 'samples': rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--library', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    places, graph, schedule, hashes = inputs(ROOT / 'data/workspace')
    engine = ScenarioEngine(schedule, vertiports=places, network=graph, provisional_names=('지점 20',))
    library = NativePilotLibrary(args.library)
    try:
        results = {fid: measure(library, engine.route(engine.flights[fid]))
                   for fid in ('FPL000001', 'FPL000005', 'FPL000012')}
    finally:
        engine.close()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({'input_sha256': hashes, 'abi': library.abi,
                                      'flights': results}, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({fid: {k: v for k, v in result.items() if k not in ('samples', 'targets')}
                      for fid, result in results.items()}))
    return int(any(not r['done'] for r in results.values()))


if __name__ == '__main__':
    raise SystemExit(main())
