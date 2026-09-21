"""Observed traffic -> bounded pilot intent. Never writes aircraft positions.

Constant-velocity closest approach is a short-horizon warning, not a route or
terrain clearance. Every proposed lateral manoeuvre is checked against all the
nearby traffic again; unavailable lateral room leaves a warning and speed control.
"""
import math


def relative(a, b):
    return ((b['latitude_deg']-a['latitude_deg'])*111320,
            (b['longitude_deg']-a['longitude_deg'])*111320*math.cos(math.radians(a['latitude_deg'])),
            b['altitude_m']-a['altitude_m'])


def velocity(a):
    heading = math.radians(a.get('heading_deg') or 0)
    speed = max(0, a.get('ground_speed_mps', a.get('speed_mps', 0)))
    return (a.get('north_mps', speed*math.cos(heading)),
            a.get('east_mps', speed*math.sin(heading)), a.get('climb_mps', 0))


def closest(a, b, horizon, own_velocity=None):
    p = relative(a, b)
    av, bv = own_velocity or velocity(a), velocity(b)
    v = tuple(y-x for x, y in zip(av, bv))
    vv = v[0]**2+v[1]**2
    t = max(0.0, min(horizon, -(p[0]*v[0]+p[1]*v[1])/vv)) if vv > 1e-6 else 0.0
    return t, math.hypot(p[0]+v[0]*t, p[1]+v[1]*t), abs(p[2]+v[2]*t)


def arrival_priority(row):
    """One strict order for merging/paused arrivals, independent of heading.

    A stopped aircraft has no forward velocity. Retaining the old nearest
    neighbour there can form A -> B -> A forever. PSU commitments precede
    uncommitted requests; identity breaks ties without fleet iteration order.
    """
    started = row.get('approach_started_s')
    return (0 if row.get('route_phase') == 'landing' else 1,
            started is None, started if started is not None else float('inf'),
            row.get('requested_s') or 0, row.get('sequence') or float('inf'), row['aircraft_id'])


def arriving(row):
    return row.get('sequence') is not None and row.get('route_phase', row['phase']) in ('descent', 'landing')


def resumed_approach(row, policy, horizon):
    """Test the actual next approach segment, not the velocity of a stopped hold.

    The bounded straight segment is a release check only. Native guidance still
    owns acceleration, descent, rotor readiness and the resulting trajectory.
    """
    target = row.get('resume_target')
    if not isinstance(target, (tuple, list)) or len(target) != 3:
        return None
    if not all(isinstance(x, (int, float)) and math.isfinite(x) for x in target):
        return None
    n, e, z = relative(row, dict(latitude_deg=target[0], longitude_deg=target[1], altitude_m=target[2]))
    distance = math.hypot(n, e)
    if distance < 1:
        return None
    speed = min(policy.get('approach_horizontal_speed_mps', 10.0),
                policy.get('approach_gain', .35)*distance)
    if speed <= 0:
        return None
    duration = min(horizon, distance/speed)
    climb = max(-policy.get('descent_rate_mps', 2.54), min(0.0, z/distance*speed))
    return (n/distance*speed, e/distance*speed, climb), duration


class TrafficAwareness:
    def __init__(self):
        self.previous = {}

    def commands(self, observations, policy, now_s):
        result = {}
        if not policy.get('traffic_avoidance', True):
            self.previous.clear()
            return result
        horizon = policy.get('traffic_lookahead_s', 35.0)
        horizontal = policy.get('traffic_horizontal_m', 120.0)
        vertical = policy.get('traffic_vertical_m', 45.0)
        release = policy.get('traffic_clear_s', 8.0)
        self_hold = policy.get('pilot_self_hold', True)
        rows = sorted(observations, key=lambda row: row['aircraft_id'])
        for own in rows:
            conflicts = []
            old = self.previous.get(own['aircraft_id'], {})
            resume = resumed_approach(own, policy, horizon) if (
                arriving(own) and own['phase'] == 'hold' and old.get('action') == 'yield') else None
            for other in rows:
                if other is own:
                    continue
                # Broad phase also bounds the effect of distant unrelated traffic.
                if math.hypot(*relative(own, other)[:2]) > horizontal + horizon * (
                        max(own.get('speed_mps', 0), math.hypot(*resume[0][:2]) if resume else 0) + other.get('speed_mps', 0)):
                    continue
                t, h, v = closest(own, other, horizon)
                if h < horizontal and v < vertical:
                    conflicts.append((t, h, other))
                elif resume:
                    # A stopped follower must not be released just because its
                    # present velocity is zero. Check its intended re-entry,
                    # both descending and while waiting for rotor readiness.
                    candidate, duration = resume
                    for intended in (candidate, (candidate[0], candidate[1], 0.0)):
                        rt, rh, rv = closest(own, other, duration, intended)
                        if rh < horizontal and rv < vertical:
                            conflicts.append((rt, rh, other))
                            break
            identifier = own['aircraft_id']
            if not conflicts:
                old = self.previous.get(identifier)
                if old and now_s - old['observed_s'] < release and own['phase'] in ('cruise', 'descent', 'hold'):
                    result[identifier] = dict(old, action='yield' if old['action']=='yield' else 'recover',
                                              reason='교통 해소 확인 후 항로 복귀')
                continue
            arrival_conflicts = [item for item in conflicts if arriving(own) and arriving(item[2])]
            predecessors = [item for item in arrival_conflicts if arrival_priority(item[2]) < arrival_priority(own)]
            # A follower leaves the common approach; the leader temporarily
            # brakes until that separation is observed, rather than following
            # the follower to another holding position.
            relevant = predecessors or conflicts
            t, h, threat = min(relevant, key=lambda row: (row[0], row[1], row[2]['aircraft_id']))
            command = {'action': 'monitor', 'right_m': 0.0, 'speed_factor': 1.0,
                       'traffic_id': threat['aircraft_id'], 'cpa_s': round(t, 1),
                       'miss_m': round(h, 1), 'observed_s': now_s,
                       'reason': '예상 근접 · 진로 확인'}
            if arrival_conflicts and len(arrival_conflicts) == len(conflicts):
                if predecessors:
                    command.update(action='yield', reason='PSU 선행편 우선 · 분리 대기 지점 이동')
                else:
                    command.update(action='wait_clear', reason='후속기 분리 이동 확인 · 접근 일시 정지')
            elif own['phase'] == 'cruise':
                offset = min(policy.get('traffic_right_m', 35.0), max(0, own.get('right_room_m', 0)))
                retained=min(offset,self.previous.get(identifier,{}).get('right_m',0.0))
                # Do not return through a conflict just because its bearing or
                # classification changed. Returning is a manoeuvre too.
                command['right_m']=retained
                n, e, z = velocity(own)
                speed = math.hypot(n, e)
                # A commanded offset develops gradually, through native guidance.
                response_s = max(8.0, min(horizon, max(t, 8.0)))
                remaining_offset=offset-own.get('right_offset_m',0.0)
                candidate = (n-e/max(speed, 1)*remaining_offset/response_s,
                             e+n/max(speed, 1)*remaining_offset/response_s, z)
                baseline = closest(own, threat, horizon)[1]
                p=relative(own,threat);vn,ve,_=velocity(threat)
                same_heading=(n*vn+e*ve)>0.98*max(1,speed*math.hypot(vn,ve))
                ahead=(p[0]*(n+vn)+p[1]*(e+ve))>0
                # Same-lane followers open a gap. The symmetric mean heading
                # prevents both aircraft calling each other the leader in a turn.
                factor=max(.75,min(1.0,(policy.get('wing_recover_mps',26)+3)/max(speed,1)))
                slower=(n*factor,e*factor,z)
                if same_heading:
                    safe=all(other is threat or
                        closest(own,other,horizon,slower)[1]>=min(horizontal,closest(own,other,horizon)[1]) or
                        closest(own,other,horizon,slower)[2]>=vertical
                        for other in rows if other is not own)
                    # A predecessor may be reversing for approach while the
                    # follower still needs wing speed. Slowing alone cannot
                    # follow it indefinitely; retain a checked right-hand gap.
                    lateral_rate=max(0.0,min(2.0,remaining_offset/max(horizon,1.0)))
                    separated=(slower[0]-e/max(speed,1)*lateral_rate,
                               slower[1]+n/max(speed,1)*lateral_rate,z)
                    sh,sv=closest(own,threat,horizon,slower)[1:]
                    rh,rv=closest(own,threat,horizon,separated)[1:]
                    lateral_clear=offset>0 and all(
                        closest(own,other,horizon,separated)[1]>=min(horizontal,closest(own,other,horizon)[1])
                        or closest(own,other,horizon,separated)[2]>=vertical
                        for other in rows if other is not own and other is not threat)
                    if (ahead and speed>policy.get('wing_recover_mps',26) and
                            sh<horizontal and sv<vertical and rh>sh+1 and lateral_clear):
                        command.update(action='avoid_right',right_m=offset,speed_factor=factor,
                            reason='선행편 접근 감속 · 우측 간격 확보와 감속 병행')
                    elif ahead and factor<1 and safe:
                        command.update(action='slow',speed_factor=factor,reason='동일 항로 선행편 · 추종 간격 확보')
                    else:
                        command['reason']='후속편 감속 확인 · 항로 유지' if not ahead else '추종 감속 여유 부족 · 근접 경보 유지'
                    result[identifier]=command
                    continue
                improved = closest(own, threat, horizon, candidate)[1] > baseline + 1
                clear = all(closest(own, other, horizon, candidate)[1] >= min(horizontal, closest(own, other, horizon)[1])
                            or closest(own, other, horizon, candidate)[2] >= vertical
                            for other in rows if other is not own and other is not threat)
                if offset > 0 and speed > policy.get('wing_recover_mps', 26) and improved and clear:
                    command.update(action='avoid_right', right_m=offset, reason='예상 조우 · 우측 여유 내 회피')
                else:
                    # Speed reduction is also checked; do not blindly slow into
                    # traffic following behind or below the wing recovery speed.
                    factor = max(.75, min(1.0, (policy.get('wing_recover_mps', 26)+3)/max(speed, 1)))
                    slower = (n*factor, e*factor, z)
                    if closest(own, threat, horizon, slower)[1] > baseline + 1 and all(
                        closest(own, other, horizon, slower)[1] >= min(horizontal, closest(own, other, horizon)[1])
                        or closest(own, other, horizon, slower)[2] >= vertical
                        for other in rows if other is not own and other is not threat):
                        command.update(action='slow', speed_factor=factor, reason='진로 여유 부족 · 속도 조정')
                    else:
                        command['reason'] = '회피 여유 부족 · 근접 경보 유지'
            elif self_hold and own['phase'] == 'hold' and self.previous.get(identifier, {}).get('action') == 'yield':
                # Braking removes the forward velocity used below. Keep the
                # established follower yielding until the conflict clears.
                command.update(action='yield', reason='접근 전방 교통 · 감속 대기')
            elif own['phase'] == 'descent':
                p = relative(own, threat)
                n, e, _ = velocity(own)
                # Following aircraft yields; the leader must keep vacating its path.
                if p[0]*n+p[1]*e > 0:
                    command.update(action='yield', reason='접근 전방 교통 · 감속 대기')
            if resume and command['action'] == 'yield':
                command['reason'] = '접근 재개 경로의 선행 교통 확인 · 분리 대기 유지'
            if not self_hold and command['action'] in ('yield', 'wait_clear'):
                # The pilot may still see the traffic and say so; what it may
                # not do is stop for it. Every pilot-side wait in the engine is
                # reached through one of these two actions, so downgrading them
                # here leaves PSU's own holds as the only thing left standing -
                # which is the whole point of turning this off. The warning
                # survives in the record so the manoeuvre that did not happen
                # is still visible.
                command.update(action='monitor',
                               reason=f"{command['reason']} · 조종사 자율 대기 꺼짐")
            result[identifier] = command
        self.previous = {key: value for key, value in result.items()
                         if value['action'] != 'recover' or now_s-value['observed_s'] < release}
        return result
