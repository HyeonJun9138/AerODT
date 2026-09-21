"""Replay one scripted aircraft through a LiveSynchronizer and report motion metrics.

Deterministic; no provider access. Truth is a slowly turning aircraft observed
every --poll seconds with --age seconds of provider latency, including one
missed poll and one long silence. Ticks are the runtime cadence. Use --module
and --catalog to compare another implementation on the same input.

    python project_support/tools/web_visualization/replay_live_twin.py --label after
"""
import argparse
import importlib.util
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from data.ingestion.source_records import SourceRecords  # noqa: E402
from foundation.geodesy import from_ecef, to_ecef  # noqa: E402

LAT, LON, ALT = 37.0, 127.0, 9000.0


def load_module(path):
    if not path:
        from digital_twin.live_twin import state_synchronization
        return state_synchronization
    spec = importlib.util.spec_from_file_location('replay_state_synchronization', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def local_frame():
    lat, lon = math.radians(LAT), math.radians(LON)
    east = (-math.sin(lon), math.cos(lon), 0.0)
    north = (-math.sin(lat) * math.cos(lon), -math.sin(lat) * math.sin(lon), math.cos(lat))
    return to_ecef(LAT, LON, ALT), east, north


def make_truth(speed, turn_rate, initial_track=90.0, step=0.1):
    """Position and track along a constant-rate turn in the local tangent plane."""
    origin, east, north = local_frame()
    samples = [(0.0, 0.0, 0.0)]
    e = n = 0.0
    for k in range(1, int(1200 / step) + 1):
        t = k * step
        heading = math.radians(initial_track + turn_rate * (t - step / 2))
        e += speed * math.sin(heading) * step
        n += speed * math.cos(heading) * step
        samples.append((t, e, n))

    def truth(t):
        index = min(len(samples) - 1, int(round(t / step)))
        _, e_at, n_at = samples[index]
        return tuple(origin[i] + e_at * east[i] + n_at * north[i] for i in range(3))

    def track(t):
        return (initial_track + turn_rate * t) % 360
    return truth, track


def run(module, catalog, *, duration, poll, age, tick, speed, turn_rate, missed, silence):
    truth, track = make_truth(speed, turn_rate)
    receipts = []
    k = 0
    while k * poll <= duration:
        observed = k * poll
        k += 1
        if any(abs(observed - m) < 1e-9 for m in missed) or silence[0] <= observed < silence[1]:
            continue
        lat, lon, alt = from_ecef(truth(observed))
        receipts.append((observed + age, [dict(id='replay', name='REPLAY', latitude=lat, longitude=lon,
            altitude_m=alt, track_deg=track(observed), speed_mps=speed, vertical_rate_mps=0, observed_at=observed)]))
    store = SourceRecords()
    sync = module.LiveSynchronizer(definitions=catalog)
    previous, rows, pending = (), [], list(receipts)
    steps = int(round(duration / tick))
    for i in range(steps + 1):
        t = round(i * tick, 6)
        while pending and pending[0][0] <= t:
            received, payload = pending.pop(0)
            store.register('replay', payload, received, format='aircraft_v1')
        previous = sync.synchronize(store.records(), t, previous=previous)
        if not previous:
            rows.append(dict(t=t, present=False))
            continue
        entity = previous[0]
        rows.append(dict(t=t, present=True, position=entity.position_ecef_m, quality=entity.quality,
            discontinuity=bool(entity.discontinuity), continuity_id=entity.continuity_id,
            error_m=math.dist(entity.position_ecef_m, truth(t)), heading=entity.heading_deg))
    return rows


def summarize(rows, tick, speed):
    present = [row for row in rows if row['present']]
    steps = []
    for a, b in zip(present, present[1:]):
        if b['t'] - a['t'] <= tick + 1e-9:
            steps.append(math.dist(a['position'], b['position']))
    expected = speed * tick
    errors = sorted(row['error_m'] for row in present)
    return dict(
        ticks=len(present), stale_ticks=sum(row['quality'] == 'stale' for row in present),
        stale_fraction=sum(row['quality'] == 'stale' for row in present) / max(1, len(present)),
        discontinuity_ticks=sum(row['discontinuity'] for row in present),
        continuity_generations=len({row['continuity_id'] for row in present}),
        hold_ticks=sum(step < 0.05 * expected for step in steps),
        jump_ticks=sum(step > 3 * expected for step in steps),
        max_step_m=max(steps) if steps else 0.0, expected_step_m=expected,
        error_median_m=errors[len(errors) // 2] if errors else None,
        error_p95_m=errors[int(len(errors) * .95)] if errors else None,
        error_max_m=errors[-1] if errors else None)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--module', help='state_synchronization.py to test (default: repository)')
    parser.add_argument('--catalog', help='motion model catalog.json (default: repository)')
    parser.add_argument('--label', default='current')
    parser.add_argument('--tick', type=float, default=1.0)
    parser.add_argument('--poll', type=float, default=25.0, help='observation cadence (measured ~25 s)')
    parser.add_argument('--age', type=float, default=12.0, help='observation age at receipt (measured minimum 12.7 s)')
    parser.add_argument('--duration', type=float, default=420.0)
    parser.add_argument('--speed', type=float, default=230.0)
    parser.add_argument('--turn-rate', type=float, default=0.15, help='deg/s')
    parser.add_argument('--out', default=str(ROOT / 'data/workspace/performance'))
    args = parser.parse_args(argv)
    catalog = json.loads(Path(args.catalog).read_text(encoding='utf-8')) if args.catalog else None
    if catalog is None:
        from digital_twin.live_twin.domains.aircraft.model_setup import load_definitions
        catalog = load_definitions()
    module = load_module(args.module)
    scenario = dict(duration=args.duration, poll=args.poll, age=args.age, tick=args.tick, speed=args.speed,
                    turn_rate=args.turn_rate, missed=(125.0,), silence=(200.0, 300.0))
    rows = run(module, catalog, **scenario)
    phases = {
        'regular_0_120': [row for row in rows if 12 <= row['t'] <= 120],
        'missed_poll_120_200': [row for row in rows if 120 < row['t'] <= 200],
        'silence_and_recovery_200_330': [row for row in rows if 200 < row['t'] <= 330],
        'regular_330_420': [row for row in rows if 330 < row['t'] <= 420],
    }
    report = dict(label=args.label, module=args.module or 'repository', scenario=scenario,
        aircraft_model={key: catalog['aircraft'][key] for key in catalog['aircraft'] if key != 'visual_asset_id'},
        overall=summarize(rows, args.tick, args.speed),
        phases={name: summarize(phase, args.tick, args.speed) for name, phase in phases.items()},
        note='Scripted straight/turning truth; metrics separate reproduction accuracy (error) from smoothness (holds, jumps).')
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    path = out / f'live_twin_replay_{args.label}.json'
    path.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(dict(label=args.label, overall=report['overall'], phases=report['phases']), indent=2))
    print(f'saved {path}')


if __name__ == '__main__':
    main()
