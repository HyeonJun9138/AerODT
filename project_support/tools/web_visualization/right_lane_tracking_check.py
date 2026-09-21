"""Measure native right-lane tracking, bends and crossing-route progress.

No dashboard connection or state changes. JSON output includes the physical
observations; a plotted/smoothed replacement trajectory is never used.
"""
import argparse
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from communication.python.native_pilot import NativePilotLibrary
from digital_twin.model_library.scheduled_route import right_cruise
from digital_twin.model_library.flight_plan import ROUTE_CAPTURE_M


def cases():
    return {
        "right": [(1500, 0), (4000, 0), (4000, 3000), (7500, 3000)],
        "left": [(1500, 0), (4000, 0), (4000, -3000), (7500, -3000)],
        "s_bend": [(1500, 0), (4000, 0), (5000, 1500), (7000, 1500), (8000, 0), (10000, 0)],
        "crossing": [(1500, 0), (6000, 0), (6000, 3000), (3000, 3000), (3000, -3000), (9000, -3000)],
        "sharp_143": [(1500, 0), (5500, 0), (5500, 3000), (2500, -1000), (7500, -1000)],
    }


def targets_of(centreline):
    cosine = math.cos(math.radians(37))
    geographic = [(37+n/111320, 127+e/(111320*cosine), 300) for n, e in centreline]
    lane = right_cruise(geographic)
    points = [(0, 0, -30, 2, 0, 8), (*centreline[0], -300, 47, 1, ROUTE_CAPTURE_M)]
    points += [((p[0]-37)*111320, (p[1]-127)*111320*cosine, -p[2], 60, 1, ROUTE_CAPTURE_M) for p in lane[1:]]
    last = centreline[-1]
    points += [(last[0]+1500, last[1], -30, 25, 0, 60),
               (last[0]+1500, last[1], 0, 2, 0, 8)]
    return points


def projection(point, a, b):
    dx, dy = b[0]-a[0], b[1]-a[1]
    length = math.hypot(dx, dy)
    along = ((point[0]-a[0])*dx+(point[1]-a[1])*dy)/length
    signed_right = (dx*(point[1]-a[1])-dy*(point[0]-a[0]))/length
    part = max(0, min(length, along))
    gap = math.hypot(point[0]-a[0]-part*dx/length, point[1]-a[1]-part*dy/length)
    return along, signed_right, gap, length


def measure(rows, targets, centreline):
    mappings = {}
    source_index = 0
    for index in range(2, len(targets)-2):
        midpoint = [(targets[index-1][k]+targets[index][k])/2 for k in (0, 1)]
        direction = [targets[index][k]-targets[index-1][k] for k in (0, 1)]
        def score(j):
            a, b = centreline[j:j+2]
            tangent = [b[k]-a[k] for k in (0, 1)]
            cosine = sum(x*y for x, y in zip(direction, tangent)) / (
                math.hypot(*direction)*math.hypot(*tangent))
            return projection(midpoint, a, b)[2] + 10000 * (1-cosine)
        # Progress and direction disambiguate a midpoint right on a crossing.
        # Never pick the globally nearest unrelated branch, even in this QA.
        source_index = min(range(source_index, min(source_index+2, len(centreline)-1)), key=score)
        mappings[index] = source_index
    errors, steady, margins, modes = [], [], {100: [], 200: [], 300: [], 500: [], 750: []}, []
    changes, last = [], 0
    for row in rows:
        index = int(row[14])
        if index != last:
            changes.append((row[0], last, index))
            last = index
        mode = "rotor" if row[10] < 15 else "wing" if row[10] > 75 else "transition"
        if not modes or modes[-1] != mode:
            modes.append(mode)
        if index not in mappings:
            continue
        segment = mappings[index]
        a, b = centreline[segment:segment+2]
        along, right, _, length = projection(row[1:3], a, b)
        lane_gap = projection(row[1:3], targets[index-1], targets[index])[2]
        errors.append(lane_gap)
        for margin, bucket in margins.items():
            if margin < along < length-margin:
                bucket.append(right)
        if 500 < along < length-500:
            steady.append({"time_s": row[0], "right_m": right, "segment": segment,
                           "speed_mps": row[12], "tilt_deg": row[10]})
    nearest = [min((math.dist(row[1:3], target[:2]) for row in rows
                    if abs(int(row[14])-index) <= 1), default=None)
               for index, target in enumerate(targets) if 1 <= index < len(targets)-2]
    return {"done": bool(rows[-1][16]), "seconds": rows[-1][0], "mode_sequence": modes,
            "waypoint_nearest_m": nearest,
            "max_lane_error_m": max(errors, default=0), "index_changes": changes,
            "steady": steady, "margins": {str(k): {"samples": len(v),
                "minimum_right_m": min(v, default=0), "maximum_right_m": max(v, default=0),
                "wrong_side_samples": sum(x < 0 for x in v)} for k, v in margins.items()}}


def fly(library, targets, step_s=0.2):
    pilot = library.create(targets, 0, 0)
    rows = []
    try:
        for _ in range(int(2400/step_s)):
            row = list(pilot.advance(step_s))
            rows.append(row)
            if row[16]:
                break
    finally:
        pilot.close()
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    library = NativePilotLibrary(args.library)
    report = {}
    for name, centres in cases().items():
        targets = targets_of(centres)
        rows = fly(library, targets)
        measured = measure(rows, targets, centres)
        print(name, measured["done"], round(measured["max_lane_error_m"], 2),
              measured["margins"]["300"], flush=True)
        report[name] = {"targets": targets, "centreline": centres, "rows": rows, **measured}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report), encoding="utf-8")


if __name__ == "__main__":
    main()
