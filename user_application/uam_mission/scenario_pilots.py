"""Application pilot execution: one incremental native pilot per active flight.

The sequencer supplies permission; the pilot reads its own physical state and
flies its supplied route. This adapter never interpolates an airborne position.
All visual types use the same reference AirTaxi physics as single-flight mode.
"""
import math
import os
from concurrent.futures import Future, ThreadPoolExecutor, as_completed

from communication.python import native_pilot
from user_application.uam_mission.traffic_awareness import TrafficAwareness
from user_application.uam_mission import approach_separation
from digital_twin.contracts.prediction import PredictionWaypoint
from digital_twin.model_library.flight_plan import HOVER_CAPTURE_M, ROUTE_CAPTURE_M, waypoint_capture_m


class ScenarioPilots:
    mode = "native-fastphysics-simpleflight"

    def __init__(self, library, workers=None, policy=None):
        self.library = library
        # What the operator moved on the pilot's decision chart. The flat array
        # is built once: it is the same for every flight of the day, and an
        # aircraft already in the air keeps the numbers it launched with.
        self.policy = dict(policy or {})
        self.tuning = native_pilot.tuning_array(self.policy)
        self.tunable = bool(getattr(library, "tunable", False))
        self.flights = {}
        self.awareness = TrafficAwareness()
        self.workers = max(1, min(8, workers if workers is not None else max(1, (os.cpu_count() or 2)//2)))
        self._pool = None
        self._forecast_pool = None

    # What an entry forecast is keyed by: the airborne route and the heading it
    # is flown from.  The forecast stops as soon as the pilot selects the first
    # descent segment, so arrival geometry from that segment onward cannot
    # affect the answer.  Keeping that unused suffix in the key used to fly the
    # same cruise two or four times merely because the destination had several
    # FATOs.
    @staticmethod
    def _entry_key(route, heading):
        end = route.descent_index if route.descent_index is not None else len(route.phases)
        return (tuple((p.stage,tuple(p.points),p.speed_mps) for p in route.phases[:end]
                      if p.stage not in ('gate_out','gate_in','charge','parked')),round(heading or 0.,3))

    def _entry_cache(self):
        cache=getattr(self,'_entry_estimates',None)
        if cache is None:self._entry_estimates={};cache=self._entry_estimates
        return cache

    # The rehearsal itself: an independent native pilot flown from the stand
    # until it reaches the descent, in two-second steps, up to forty minutes.
    # It owns its own runtime, so several of these can fly at once on
    # different threads; the DLL releases the GIL while it works.
    def _forecast_entry(self, route, heading):
        try:
            forecast=FlightPilot(self.library,route,heading,self.policy,self.tuning)
        except (RuntimeError,ValueError,OSError):
            return None
        try:
            for elapsed in range(2,2401,2):
                sample=forecast.advance(2.)
                if sample['phase_index']>=route.descent_index:
                    return float(elapsed)
            return None
        except (RuntimeError,ValueError,OSError):
            return None
        finally:forecast.close()

    def cached_entry_estimate(self, route, heading):
        """Read an already prepared estimate without starting a native rehearsal."""
        return self._entry_cache().get(self._entry_key(route,heading))

    # An estimate the day did not prepare is rehearsed beside the day, not
    # inside it. A rehearsal is close to a second of native flight; done in the
    # step that wants it, under the session lock, a first departure wave of
    # sixty aircraft froze the whole twin - clock, status, every panel - for
    # forty seconds. Asked for here, it is flown on its own thread and the
    # aircraft waits at its stand for one more step instead.
    def prepare_entry_estimate(self, route, heading):
        """True when the estimate is in the cache; otherwise start it and say no."""
        cache=self._entry_cache()
        key=self._entry_key(route,heading)
        if key in cache:
            return True
        pending=getattr(self,'_entry_pending',None)
        if pending is None:self._entry_pending={};pending=self._entry_pending
        future=pending.get(key)
        if future is None:
            if self._forecast_pool is None:
                self._forecast_pool=ThreadPoolExecutor(max_workers=max(1,min(4,(os.cpu_count() or 2)//4)),
                                                       thread_name_prefix="uam-forecast")
            pending[key]=self._forecast_pool.submit(self._forecast_entry,route,heading)
            return False
        if not future.done():
            return False
        if len(cache)>=1024:cache.clear()
        cache[key]=future.result()
        pending.pop(key,None)
        return True

    def estimate_to_entry(self, route, heading):
        """Independent native forecast, never a mutation of an active pilot."""
        cache=self._entry_cache()
        key=self._entry_key(route,heading)
        if key not in cache:
            if len(cache)>=1024:cache.clear()
            cache[key]=self._forecast_entry(route,heading)
        return cache[key]

    def estimate_many(self, requests, on_progress=None):
        """Warm the entry cache for many (route, heading) pairs at once.

        A day of a hundred aircraft rehearsed one after another took several
        minutes before the first one could move; each rehearsal is a separate
        native runtime, so they are flown on the physics pool instead, and
        identical entry prefixes are flown once. `on_progress(done, total)`
        counts those real native rehearsals, not the request list containing
        duplicate arrival-FATO suffixes.  Completions are reported as they
        finish, so a slow early route cannot make a completed pool look stuck.
        Returns the estimates in request order.
        """
        requests=list(requests)
        total=len(requests)
        cache=self._entry_cache()
        if len(cache)+total>=1024:cache.clear()
        keys=[self._entry_key(route,heading) for route,heading in requests]
        pending={}
        for key,(route,heading) in zip(keys,requests):
            if key not in cache and key not in pending:pending[key]=(route,heading)
        unique_keys=list(dict.fromkeys(keys))
        total_unique=len(unique_keys)
        done=sum(key in cache for key in unique_keys)
        if on_progress and total_unique:on_progress(done,total_unique)
        if pending:
            # Before the day plays nothing else needs the cores, so the warm-up
            # may use all of them: on a 24-core machine 8 threads took 13.8 s
            # for a hundred aircraft and 24 took 8.8 s (one thread: ~95 s).
            # The physics pool that flies the day stays at `self.workers`.
            workers=max(1,min(len(pending),max(self.workers,os.cpu_count() or 1)))
            with ThreadPoolExecutor(max_workers=workers,thread_name_prefix="uam-forecast") as pool:
                futures={key:pool.submit(self._forecast_entry,route,heading) for key,(route,heading) in pending.items()}
                by_future={future:key for key,future in futures.items()}
                for future in as_completed(by_future):
                    cache[by_future[future]]=future.result()
                    done+=1
                    if on_progress:on_progress(done,total_unique)
        return [cache.get(key) for key in keys]

    def submit(self, aircraft_id, seconds, hold=None):
        # ctypes releases the GIL inside the DLL. Each task owns a different
        # runtime; shared PSU decisions and result commits stay on the caller.
        if self.workers == 1:
            answer = Future()
            try:
                answer.set_result(self.advance(aircraft_id, seconds, hold))
            except Exception as error:
                answer.set_exception(error)
            return answer
        if self._pool is None:
            self._pool = ThreadPoolExecutor(max_workers=self.workers, thread_name_prefix="uam-physics")
        return self._pool.submit(self.advance, aircraft_id, seconds, hold)

    def start(self, aircraft_id, route, heading):
        self.finish(aircraft_id)
        self.flights[aircraft_id] = FlightPilot(self.library, route, heading,
                                                self.policy, self.tuning)

    def advance(self, aircraft_id, seconds, hold=None):
        return self.flights[aircraft_id].advance(seconds, hold)

    def traffic_commands(self, observations, policy, now_s):
        return self.awareness.commands(observations, policy, now_s)

    def separation_candidates(self, own, observations, policy):
        return approach_separation.candidates(own, observations, policy)

    def separation_clear(self, own, target, observations, policy):
        return approach_separation.clear_transfer(own, target, observations, policy)

    def set_traffic(self, aircraft_id, command):
        pilot = self.flights.get(aircraft_id)
        if pilot:
            pilot.native.traffic(command.get('right_m', 0), command.get('speed_factor', 1))

    def set_landing_yaw(self, aircraft_id, degrees):
        pilot = self.flights.get(aircraft_id)
        if pilot is None:
            return False
        return pilot.native.set_landing_yaw(degrees)

    def replace_arrival(self, aircraft_id, route):
        pilot=self.flights.get(aircraft_id)
        return bool(pilot and pilot.replace_arrival(route))

    def finish(self, aircraft_id):
        pilot = self.flights.pop(aircraft_id, None)
        if pilot:
            pilot.close()

    def close(self):
        if self._pool is not None:
            self._pool.shutdown(wait=True)
            self._pool = None
        if self._forecast_pool is not None:
            self._forecast_pool.shutdown(wait=False, cancel_futures=True)
            self._forecast_pool = None
        for aircraft_id in list(self.flights):
            self.finish(aircraft_id)


# What the pilot flies to when nobody has said otherwise: the values the code
# was written with. Named here rather than left as literals because the chart
# offers them and the chart has to agree with what actually happens.
SPEED_CEILING_MPS = 60.0
PRECISION_CAPTURE_M = HOVER_CAPTURE_M
TURN_CAPTURE_M = ROUTE_CAPTURE_M
# The stages flown on the wing. Everything else is stopped at.
WINGED_STAGES = ("climb", "cruise")
# Only the departure/arrival columns use the close radius. Treating corridor
# turns as eight-metre targets made the wing circle missed points repeatedly.
PRECISE_STAGES = ("takeoff", "landing")


class FlightPilot:
    def __init__(self, library, route, heading, policy=None, tuning=None):
        rules = policy or {}
        ceiling = float(rules.get("max_speed_mps", SPEED_CEILING_MPS))
        precise = float(rules.get("precision_capture_m", PRECISION_CAPTURE_M))
        loose = float(rules.get("turn_capture_m", TURN_CAPTURE_M))
        air = [(i, p) for i, p in enumerate(route.phases)
               if p.stage not in ("gate_out", "gate_in", "charge", "parked")]
        if not air:
            raise ValueError("비행계획에 공중 구간이 없습니다")
        self.origin = air[0][1].points[0]
        self.cos_lat = math.cos(math.radians(self.origin[0]))
        self.indices, points = [], []
        prediction_points = []
        self.prediction_policy = dict(rules)
        for index, phase in air:
            for previous, point in zip(phase.points, phase.points[1:]):
                points.append((*self.ned(point), max(1.0, min(ceiling, phase.speed_mps)),
                               float(phase.stage in WINGED_STAGES),
                               waypoint_capture_m(phase.stage in PRECISE_STAGES,
                                                  point[2] - previous[2], precise, loose)))
                self.indices.append(index)
                prediction_points.append(PredictionWaypoint(tuple(previous), tuple(point),
                    max(1.0, min(ceiling, phase.speed_mps)), phase.stage))
        self.prediction_points = tuple(prediction_points)
        ground = next((p for p in route.phases if p.stage == "gate_in"), None)
        landing_yaw = heading or 0.0
        if ground:
            for first, second in zip(ground.points, ground.points[1:]):
                n, e, _ = self.ned(second)
                n0, e0, _ = self.ned(first)
                if math.hypot(n-n0, e-e0) > 0.05:
                    landing_yaw = math.degrees(math.atan2(e-e0, n-n0))
                    break
        self.native = library.create(points, heading or 0.0, landing_yaw, tuning)
        self.waypoints = tuple(points)
        self.last_index, self.phase_started = air[0][0], 0.0
        self.timeout = max(1800.0, route.duration_s * 6.0)
        self.hold_s = 0.0
        self.floor = min([self.origin[2], *(p[2] for _, phase in air for p in phase.points)]) - 30.0

    def replace_arrival(self, route):
        """Keep the flown/current prefix and the existing runtime; change intent only."""
        rules=self.prediction_policy
        precise=float(rules.get('precision_capture_m',PRECISION_CAPTURE_M))
        loose=float(rules.get('turn_capture_m',TURN_CAPTURE_M))
        ceiling=float(rules.get('max_speed_mps',SPEED_CEILING_MPS))
        points,indices,predictions=[],[],[]
        for index,phase in enumerate(route.phases):
            if phase.stage in ('gate_out','gate_in','charge','parked'):continue
            for previous,point in zip(phase.points,phase.points[1:]):
                speed=max(1.,min(ceiling,phase.speed_mps))
                points.append((*self.ned(point),speed,float(phase.stage in WINGED_STAGES),
                    waypoint_capture_m(phase.stage in PRECISE_STAGES,point[2]-previous[2],precise,loose)))
                indices.append(index)
                predictions.append(PredictionWaypoint(tuple(previous),tuple(point),speed,phase.stage))
        first=next((i for i,(old,new) in enumerate(zip(self.waypoints,points)) if old!=new),
                   min(len(self.waypoints),len(points)))
        status=self.native.guidance_status()
        current=status.get('waypoint_index')
        if current is None or first<=current or len(points)-first<2:
            return False
        ground=next(p for p in route.phases if p.stage=='gate_in')
        yaw=ground.at_fraction(0)[3]
        if yaw is None:return False
        if not self.native.replace_arrival(current,first,points[first:],yaw):return False
        self.waypoints=tuple(points);self.indices=indices;self.prediction_points=tuple(predictions)
        self.timeout=max(self.timeout,route.duration_s*6.)
        self.floor=min(self.floor,min(p[2] for phase in route.phases for p in phase.points)-30.)
        return True

    def ned(self, point):
        return ((point[0]-self.origin[0])*111320.0,
                (point[1]-self.origin[1])*111320.0*self.cos_lat,
                self.origin[2]-point[2])

    def advance(self, seconds, hold=None):
        if hold is not None:
            self.hold_s += seconds
        s = self.native.advance(seconds, None if hold is None else self.ned(hold))
        if s[0] - self.hold_s > self.timeout:
            raise RuntimeError("조종사가 제한 시간 내 경유점을 획득하지 못했습니다")
        if self.origin[2]-s[3] < self.floor:
            raise RuntimeError("물리 비행이 계획 고도 범위 아래로 이탈했습니다")
        index = self.indices[min(int(s[14]), len(self.indices)-1)]
        if index != self.last_index:
            self.phase_started, self.last_index = s[0], index
        return {"latitude_deg": self.origin[0]+s[1]/111320.0,
                "longitude_deg": self.origin[1]+s[2]/(111320.0*self.cos_lat),
                "altitude_m": self.origin[2]-s[3], "heading_deg": s[7] % 360,
                "pitch_deg": s[8], "roll_deg": s[9], "tilt_deg": s[10],
                # The physics reports its velocity in north-east-down, so the
                # climb is the down component turned the right way up and the
                # ground speed is the horizontal part of it. `s[12]` is the
                # whole speed including the vertical, which is not what a
                # ground track is made of.
                "climb_mps": -s[6], "ground_speed_mps": math.hypot(s[4], s[5]),
                "velocity_ned_mps": (s[4], s[5], s[6]),
                "route_target_index": min(int(s[14]), len(self.indices)-1),
                "control_surface_deg": self.native.control_surfaces() if hasattr(self.native,"control_surfaces") else None,
                "rotor_radps": s[15], "speed_mps": s[12], "grounded": bool(s[13]),
                "north_mps": s[4], "east_mps": s[5],
                "segment_index": self.indices[:int(s[14])].count(index),
                "phase_index": index, "phase_elapsed": s[0]-self.phase_started,
                "done": bool(s[16]), "physics_time_s": s[0],
                "guidance": self.native.guidance_status() if hasattr(self.native,'guidance_status') else
                    {'available':False,'reason':'unsupported','waypoint_index':None,'landing_yaw_mutable':None}}

    def close(self):
        self.native.close()
