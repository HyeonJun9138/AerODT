"""The day's per-step hot paths answer exactly as they did before they were
cut: a transfer screen with a broad phase, a taxi step that stops scanning
knots, terminal blockers and vertiport occupants remembered between claims
and reports. Each test compares the current code with a plain re-statement
of the old one across many random cases, bit for bit."""
import math
import random

import pytest

from digital_twin.model_library import ground_motion
from digital_twin.model_library.ground_motion import ACCEL_MPS2
from digital_twin.model_library.terminal_paths import segment_distance
from digital_twin.simulation import holding_queue
from digital_twin.simulation.holding_queue import HoldingQueue, relative, clip_height, paused_return_yields
from digital_twin.simulation.psu_sequencing import VertiportResourceMonitor
from digital_twin.simulation.terminal_reservations import TerminalReservations
from digital_twin.contracts.vertiport_resources import VertiportResourceReport, VertiportResourceState


# ---- holding_queue.transfer_clear -------------------------------------------

def transfer_clear_before(queue, owner, position, target, observations, horizontal, vertical, lookahead):
    """The screen as it was written before the broad phase, line for line."""
    delta = relative(position, target)
    own = queue.reservations.get(owner)
    own_observation = next((o for o in observations if o['owner'] == owner), None)
    for other in observations:
        if other['owner'] == owner:
            continue
        p = relative(position, other['position'])
        velocity = other.get('velocity', (0., 0., 0.))
        claim = queue.reservations.get(other['owner'])
        moving = claim and claim['state'] in ('moving', 'returning')
        paused = moving and claim.get('return_hold') is not None
        observed_end = tuple(p[i] + velocity[i] * lookahead for i in range(3))
        if paused:
            ends = (relative(position, claim['return_hold']), observed_end)
            if not paused_return_yields(own, own_observation, claim, other, horizontal, vertical):
                ends += (relative(position, claim['rejoin']),)
        elif moving:
            ends = (relative(position, claim.get('movement_target', claim['rejoin'] if claim['state'] == 'returning' else claim['target'])),)
        else:
            ends = (observed_end,)
        for end in ends:
            if min(p[2], end[2]) - max(0., delta[2]) >= vertical or min(0., delta[2]) - max(p[2], end[2]) >= vertical:
                continue
            portion = clip_height((0., 0., 0.), delta, min(p[2], end[2]) - vertical, max(p[2], end[2]) + vertical)
            if portion is None:
                continue
            closest = segment_distance(portion[0][:2], portion[1][:2], p[:2], end[:2])
            distance = math.hypot(*p[:2])
            if distance < horizontal and abs(p[2]) < vertical:
                if (math.hypot(*velocity[:2]) > 1 or abs(velocity[2]) > .3 or moving or
                        closest < distance - .05 or math.dist(delta[:2], p[:2]) < horizontal + 10 or
                        abs(delta[2]) > 1):
                    return False
            elif closest < horizontal:
                return False
    for key, r in queue.reservations.items():
        if key == owner:
            continue
        p = relative(position, r['target'])
        portion = clip_height((0., 0., 0.), delta, p[2] - vertical, p[2] + vertical)
        if portion:
            closest = segment_distance(portion[0][:2], portion[1][:2], p[:2], p[:2])
            initial = math.hypot(*p[:2])
            if closest < horizontal and not (initial < horizontal and closest >= initial - .05 and
                                             math.dist(delta[:2], p[:2]) >= horizontal + 10):
                return False
    return True


ORIGIN = (37.50, 127.00, 330.)


def point_near(rng, spread_m, base=ORIGIN):
    north = rng.uniform(-spread_m, spread_m)
    east = rng.uniform(-spread_m, spread_m)
    up = rng.uniform(-80., 80.)
    return (base[0] + north / 111320., base[1] + east / (111320. * math.cos(math.radians(base[0]))), base[2] + up)


def random_world(rng):
    """A queue with claims in every state, and observations near and far."""
    queue = HoldingQueue()
    owners = ['own'] + ['f%d' % i for i in range(rng.randint(2, 9))]
    for name in owners:
        if rng.random() < .75:
            state = rng.choice(['assigned', 'moving', 'returning', 'settled'])
            claim = {'owner': name, 'port': 'VP', 'slot': name, 'state': state,
                     'target': point_near(rng, 400.), 'rejoin': point_near(rng, 400.),
                     'assigned_s': rng.uniform(0, 600)}
            if state in ('moving', 'returning') and rng.random() < .5:
                claim['return_hold'] = point_near(rng, 300.)
            if rng.random() < .3:
                claim['movement_target'] = point_near(rng, 300.)
            queue.reservations[name] = claim
    observations = []
    for name in owners:
        if rng.random() < .85:
            # Most of a fleet is at other vertiports, kilometres away; some is close.
            spread = rng.choice([150., 400., 3000., 20000.])
            velocity = tuple(rng.uniform(-30, 30) for _ in range(2)) + (rng.uniform(-3, 3),)
            if rng.random() < .3:
                velocity = (0., 0., 0.)
            observations.append({'owner': name, 'position': point_near(rng, spread), 'velocity': velocity})
    return queue, observations


def test_transfer_screen_answers_exactly_as_before_the_broad_phase():
    rng = random.Random(2026_09_22)
    answers = {True: 0, False: 0}
    for _ in range(4000):
        queue, observations = random_world(rng)
        position = point_near(rng, 200.)
        target = point_near(rng, rng.choice([60., 300., 1200.]))
        horizontal, vertical, lookahead = rng.choice([120., 150.]), rng.choice([30., 45.]), rng.choice([10., 30.])
        expected = transfer_clear_before(queue, 'own', position, target, observations, horizontal, vertical, lookahead)
        actual = queue.transfer_clear('own', position, target, observations, horizontal, vertical, lookahead)
        assert actual is expected
        answers[actual] += 1
    assert answers[True] > 200 and answers[False] > 200, 'both answers were exercised: %r' % answers


def test_transfer_screen_at_the_separation_boundary_is_handed_to_the_exact_test():
    """An other segment whose nearest point is within the margin of the
    separation is not skipped by the broad phase, whatever its rounding."""
    queue = HoldingQueue()
    horizontal, vertical = 120., 45.
    position = ORIGIN
    # The transfer runs 100 m north; the other aircraft sits east of the far end.
    target = (ORIGIN[0] + 100. / 111320., ORIGIN[1], ORIGIN[2])
    east_scale = 111320. * math.cos(math.radians(ORIGIN[0]))
    for offset in (horizontal - 1e-4, horizontal - 1e-6, horizontal, horizontal + 1e-6, horizontal + 5e-4, horizontal + 2e-3):
        other = {'owner': 'x', 'position': (target[0], ORIGIN[1] + offset / east_scale, ORIGIN[2]), 'velocity': (0., 0., 0.)}
        before = transfer_clear_before(queue, 'own', position, target, [other], horizontal, vertical, 30.)
        assert queue.transfer_clear('own', position, target, [other], horizontal, vertical, 30.) is before
    assert holding_queue.BROAD_PHASE_MARGIN_M >= 1e-4


# ---- ground_motion.advance ----------------------------------------------------

def advance_before(profile, distance, speed, stop_distance, speed_limit, seconds):
    """The taxi step as it was, with the full scan of every knot ahead."""
    import bisect
    values = (distance, speed, stop_distance, speed_limit, seconds)
    if not all(math.isfinite(v) and v >= 0 for v in values):
        raise ValueError('finite nonnegative ground motion values required')
    marks, speeds = profile['distances_m'], profile['speeds_mps']
    end = min(marks[-1], stop_distance)
    if distance > end + 1e-6 or speed * speed > 2 * ACCEL_MPS2 * (end - distance) + 1e-5:
        raise ValueError('movement permission is inside the braking distance')
    remaining_time = seconds
    while remaining_time > 1e-9:
        dt = min(.05, remaining_time)
        remaining_time -= dt
        remaining = max(0.0, end - distance)
        if remaining < 1e-8 and speed < 1e-5:
            return end, 0.0
        if speed > 0 and speed / ACCEL_MPS2 <= dt and remaining <= speed * speed / (2 * ACCEL_MPS2) + 1e-7:
            return end, 0.0
        i = min(len(marks) - 2, max(0, bisect.bisect_right(marks, distance) - 1))
        cap = min(speed_limit, max(speeds[i], speeds[i + 1]))
        bound = 2 * ACCEL_MPS2 * remaining
        for j in range(i + 1, len(marks)):
            if marks[j] > end:
                break
            bound = min(bound, speeds[j] ** 2 + 2 * ACCEL_MPS2 * (marks[j] - distance))
        a_dt = ACCEL_MPS2 * dt
        safe = max(0.0, (-a_dt + math.sqrt(max(0.0, a_dt * a_dt + 4 * (bound - a_dt * speed)))) / 2)
        next_speed = min(speed + a_dt, cap, safe)
        next_speed = max(speed - a_dt, next_speed, 0.0)
        moved = (speed + next_speed) * dt / 2
        if moved > remaining + 1e-6:
            raise ValueError('braking envelope failed to contain ground movement')
        distance += min(moved, remaining)
        speed = next_speed
    return distance, speed


def random_profile(rng):
    """A taxi profile like a prepared path: dense marks, plateaus included,
    speeds that dip at corners and reach zero at stops."""
    marks = [0.0]
    for _ in range(rng.randint(3, 400)):
        marks.append(marks[-1] + rng.choice([0.0, rng.uniform(.2, 3.), rng.uniform(3., 12.)]))
    speeds = []
    for k in range(len(marks)):
        speeds.append(rng.choice([0.0, rng.uniform(.5, 2.5), rng.uniform(2.5, 9.)]) if rng.random() < .25 else rng.uniform(4., 9.))
    speeds[0] = 0.0 if rng.random() < .5 else speeds[0]
    speeds[-1] = 0.0
    return {'distances_m': marks, 'speeds_mps': speeds}


def test_taxi_step_answers_exactly_as_before_it_stopped_scanning():
    rng = random.Random(9138)
    compared = errors = 0
    for _ in range(3000):
        profile = random_profile(rng)
        total = profile['distances_m'][-1]
        distance = rng.uniform(0., total)
        stop = rng.choice([total, rng.uniform(distance, total), rng.uniform(0., total)])
        speed = rng.uniform(0., 9.) if rng.random() < .8 else 0.
        limit = rng.choice([9., 6., 3., rng.uniform(.5, 9.)])
        seconds = rng.choice([.5, .1, 1.0, rng.uniform(.02, 2.)])
        args = (profile, distance, speed, stop, limit, seconds)
        try:
            expected = advance_before(*args)
        except ValueError as error:
            with pytest.raises(ValueError, match=str(error).split(' ')[0]):
                ground_motion.advance(*args)
            errors += 1
            continue
        actual = ground_motion.advance(*args)
        assert actual == expected, (actual, expected)
        compared += 1
    assert compared > 1500 and errors > 50


def test_taxi_step_scans_far_fewer_knots():
    """The saving the cut exists for: a long dense path is no longer walked to
    its end every 50 ms."""
    marks = [i * 1.0 for i in range(600)]
    speeds = [8.0] * 600
    speeds[-1] = 0.0
    profile = {'distances_m': marks, 'speeds_mps': speeds}
    counting = []
    class Speeds(list):
        def __getitem__(self, index):
            counting.append(index)
            return list.__getitem__(self, index)
    profile['speeds_mps'] = Speeds(speeds)
    ground_motion.advance(profile, 10.0, 8.0, 599.0, 8.0, .5)
    reads = len(counting)
    assert reads < 600, 'a 0.5 s step over a 600-knot path read %d speed knots' % reads
    assert ground_motion.advance(profile, 10.0, 8.0, 599.0, 8.0, .5) == advance_before(profile, 10.0, 8.0, 599.0, 8.0, .5)


# ---- terminal_reservations.blockers -------------------------------------------

class Route:
    def __init__(self, key):
        self.key = key


def test_terminal_blockers_are_remembered_until_a_claim_changes(monkeypatch):
    asked = []
    def overlap(self, route, kind, other, other_kind):
        asked.append((route.key, kind, other.key, other_kind))
        return {'where': route.key + '/' + other.key} if route.key[0] == other.key[0] else None
    monkeypatch.setattr(TerminalReservations, 'overlap', overlap)
    terminal = TerminalReservations(50., 20.)
    a = {'flight_id': 'A', 'origin': 'VP1', 'destination': 'VP2', 'departure_fato': 'F1', 'arrival_fato': 'F2'}
    b = {'flight_id': 'B', 'origin': 'VP1', 'destination': 'VP2', 'departure_fato': 'F1', 'arrival_fato': 'F2'}
    assert terminal.acquire(a, Route('x1'), 'departure') == []
    first = terminal.blockers(b, Route('x2'), 'departure')
    assert first == [{'where': 'x2/x1', 'flight_id': 'A', 'operation': 'departure', 'vertiport': 'VP1', 'fato': 'F1'}]
    asked.clear()
    second = terminal.blockers(b, Route('x2'), 'departure')
    assert second == first and asked == [], 'the same question is answered from memory'
    second[0]['fato'] = 'edited'
    assert terminal.blockers(b, Route('x2'), 'departure')[0]['fato'] == 'F1', 'a caller editing an answer edits nothing kept'
    assert terminal.blockers(b, Route('y2'), 'departure') == [] and asked, 'another route is another question'
    asked.clear()
    assert terminal.release('A', 'departure') is True
    assert terminal.blockers(b, Route('x2'), 'departure') == [], 'a released claim no longer blocks: the remembered answer went with it'
    assert terminal.release('A', 'departure') is False
    terminal.acquire(a, Route('x1'), 'departure')
    assert terminal.blockers(b, Route('x2'), 'departure') == first and asked, 'a new claim is asked about again'
    terminal.enabled = False
    assert terminal.blockers(b, Route('x2'), 'departure') == []


# ---- psu_sequencing.VertiportResourceMonitor ----------------------------------

def report(vertiport, sequence, observed, valid_for, stands):
    resources = tuple(VertiportResourceState(resource_id=name, resource_type='stand', occupant_id=occupant, reservation_id=reserved)
                      for name, occupant, reserved in stands)
    return VertiportResourceReport(vertiport_id=vertiport, sequence=sequence, observed_s=observed, valid_until_s=observed + valid_for,
                                   resources=resources, operator_id='op-' + vertiport)


def test_monitor_occupants_are_remembered_per_moment_and_forgotten_on_report_or_time():
    monitor = VertiportResourceMonitor()
    assert monitor.occupants('stand') == {}
    monitor.ingest(report('VP1', 1, 100., 30., [('G1', 'A', None), ('G2', None, 'B')]))
    monitor.ingest(report('VP2', 1, 100., 30., [('G1', None, None), ('G3', 'C', 'C')]))
    expected = {('VP1', 'G1'): 'A', ('VP2', 'G3'): 'C'}
    first = monitor.occupants('stand')
    assert first == expected and monitor.reservations('stand') == {('VP1', 'G2'): 'B', ('VP2', 'G3'): 'C'}
    first[('VP1', 'G1')] = 'edited'
    assert monitor.occupants('stand') == expected, 'answers are copies'
    assert monitor.occupants('stand') is not monitor.occupants('stand')
    # A newer report replaces what is remembered; an older one changes nothing.
    monitor.ingest(report('VP1', 2, 110., 30., [('G1', None, None), ('G2', 'B', None)]))
    assert monitor.occupants('stand') == {('VP1', 'G2'): 'B', ('VP2', 'G3'): 'C'}
    assert monitor.ingest(report('VP1', 1, 120., 30., [('G1', 'Z', None)])) is False
    assert monitor.occupants('stand') == {('VP1', 'G2'): 'B', ('VP2', 'G3'): 'C'}
    # Time moving past a report's validity drops it, with or without a new report.
    monitor.advance(131.)
    assert monitor.occupants('stand') == {('VP1', 'G2'): 'B'}
    assert monitor.occupants('stand', now_s=105.) == {('VP1', 'G2'): 'B', ('VP2', 'G3'): 'C'}, 'an explicit moment is its own answer'
    assert monitor.occupants('stand', now_s=141.) == {}
    monitor.clear()
    assert monitor.occupants('stand') == {} and monitor.now_s == 0.0
