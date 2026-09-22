"""Running a whole scheduled day, and letting an operator drive it.

The single-flight tool prepares intent, executes it and plays the recording
back. A day of 947 flights cannot work that way: precomputing it would settle
every hold before anybody watched, and the holds are the point. So this runs the
day forward on a clock the operator controls — play, pause, faster, stop — and
the twin reads whatever the day is doing at that moment.

Three things are kept apart on purpose. The schedule is a document somebody else
wrote and this never edits it. The engine owns positions and phases and is the
only thing that moves an aircraft. This session owns the *clock*: how scenario
time relates to wall time, what happens when the speed changes, and when the day
is being recorded. Nothing here decides where an aircraft is.

While the day is playing the twin follows the scenario's clock rather than the
wall clock, so the satellites overhead are the ones that were overhead on the
day being flown, and the aircraft on the map are the day's, not the ones flying
outside the window right now. That is what "저장 정보 재생" means here: not a
recording being replayed, but the twin's own clock moved to the day in question.
"""
import csv
import io
import json
import math
from copy import deepcopy
from digital_twin.simulation import manual_takeover
from user_application.uam_mission import twin_custody
from user_application.uam_mission.scenario_observation import ScenarioObservation
from functools import wraps
import inspect
import threading
import queue
import copy
import gc
import logging
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ai_pnp.domains.uam.uam_features import feature_sample
from data.simulation.prediction_history import PredictionHistory
from digital_twin.contracts.live import SurfaceReference, TwinEntity, ChargingConnection
from digital_twin.contracts.prediction import PredictionWaypoint, UamPredictionIntent
from digital_twin.model_library import flight_schedule
from digital_twin.simulation import psu_sequencing
from digital_twin.simulation.scenario_engine import ScenarioEngine
from user_application.uam_mission.ground_control import VertiportGroundControl
from user_application.uam_mission.vertiport_operator import VertiportOperators

SCHEMA_VERSION = 1

# The speeds the control panel offers. One is the day at its own pace.
SPEEDS = (1, 2, 4, 6, 8, 10)
DEFAULT_SPEED = 1
# The day is flown in Korean local time and that is what the file's clock
# columns mean. Korea keeps no summer time, so a fixed offset is exact.
LOCAL_OFFSET = timezone(timedelta(hours=9))

IDLE, READY, PLAYING, PAUSED, FINISHED = "idle", "ready", "playing", "paused", "finished"
# How much scenario time one advance may cover. A tab left in the background
# stops being ticked; when it comes back the gap must not be flown in one step,
# because every hold in it would resolve at once.
MAX_ADVANCE_S = 120.0
# Tracks are written this often in scenario time. Fine enough to draw a path
# from, coarse enough that a day is a file somebody can download.
RECORD_INTERVAL_S = 1.0
# How often the tick sweeps what the day has allocated since the last sweep
# and freezes what survived (cheap: only that much is walked), and how often
# it thaws the whole day and collects it (the one long pass, so frozen
# objects that have since become garbage are given back).
GC_SWEEP_S = 30.0
GC_FULL_S = 900.0
# Only aircraft on a flight are recorded, taxi included. 84 airframes standing
# on decks for twelve hours is not a track, it is the same row two million times.
RECORD_FLYING_ONLY = True
# How often a watched cockpit's clearance is recomputed. Wall time rather than
# scenario time, because a paused day still has somebody holding the stick and
# their clearances still have to arrive.
MANUAL_ADVICE_INTERVAL_S = 1.0


def epoch_of(date_text, seconds):
    """The real instant a scenario second falls on, so satellites can be placed.

    Without a date the day is anchored to today, which keeps everything else
    working and only means the sky above it is today's.
    """
    try:
        year, month, day = (int(part) for part in str(date_text).split("-"))
        midnight = datetime(year, month, day, tzinfo=LOCAL_OFFSET)
    except (TypeError, ValueError):
        now = datetime.now(LOCAL_OFFSET)
        midnight = datetime(now.year, now.month, now.day, tzinfo=LOCAL_OFFSET)
    return midnight.timestamp() + float(seconds)


class ScenarioRecorder:
    """What the day leaves behind: operations, developer detail and tracks.

    Written as the day runs rather than at the end, so a day that is stopped
    half way still leaves everything up to that point. Files are opened on the
    first write, so a session nobody plays writes nothing. Operational events
    and developer diagnostics are deliberately written to different files.
    """

    # Everything that touches the files and the proximity records is done on
    # one writer thread, in the order it was asked, so the tick -- which
    # holds the session's lock and the interpreter with it -- spends a few
    # microseconds handing the work over instead of thirty-odd milliseconds
    # encoding a hundred states and walking every pair of them, once a
    # second, with every socket in the process waiting. The files come out
    # byte for byte as before: one writer, one queue, one order. What is
    # counted (`rows`, `events`) is counted when asked, which is what the
    # status shows; `finish` and `close` wait for the queue to empty.
    def __init__(self, directory, scenario_id, *, workspace=None, policy=None):
        self.directory = Path(directory) / scenario_id
        self.scenario_id = scenario_id
        self._tracks = None
        self._events = None
        self._diagnostics = None
        self.rows = 0
        self.events = 0
        self.started_at = None
        self._proximity_workspace = Path(workspace) if workspace is not None else Path(directory)
        self._proximity_policy = deepcopy(policy or {})
        self._proximity = None
        self.finalized = False
        self._queue = queue.Queue()
        self._writer = None

    def _open(self):
        if self._tracks is None:
            self.directory.mkdir(parents=True, exist_ok=True)
            self._tracks = (self.directory / "tracks.jsonl").open("w", encoding="utf-8")
            self._events = (self.directory / "events.jsonl").open("w", encoding="utf-8")
            self._diagnostics = (self.directory / "diagnostics.jsonl").open("w", encoding="utf-8")
            self.started_at = time.time()
            from data.simulation.proximity_records import ProximityRecords
            self._proximity = ProximityRecords(self._proximity_workspace, self.scenario_id, self._proximity_policy)

    def _submit(self, work):
        if self._writer is None:
            self._writer = threading.Thread(target=self._drain_forever, name='scenario-recorder', daemon=True)
            self._writer.start()
        self._queue.put(work)

    def _drain_forever(self):
        while True:
            work = self._queue.get()
            try:
                if work is None:
                    return
                work()
            except Exception:  # noqa: BLE001 - a record that cannot be written must not stop the day
                logging.getLogger(__name__).exception('scenario recorder write failed')
            finally:
                self._queue.task_done()

    def _wait(self):
        """Everything asked for so far is on disk and in the proximity records."""
        if self._writer is not None:
            self._queue.join()

    def track(self, moment, states):
        self._open()
        states = list(states)
        self.rows += sum(1 for state in states if not (RECORD_FLYING_ONLY and not state["flight_id"]))
        self._submit(lambda: self._write_track(moment, states))

    def _write_track(self, moment, states):
        self._proximity.observe(moment, states)
        for state in states:
            if RECORD_FLYING_ONLY and not state["flight_id"]:
                continue
            self._tracks.write(json.dumps({
                "t": round(moment, 1), "aircraft_id": state["aircraft_id"],
                "flight_id": state["flight_id"], "phase": state["phase"],
                "lat": round(state["latitude_deg"], 7), "lon": round(state["longitude_deg"], 7),
                "alt": round(state["altitude_m"], 1),
                "hdg": None if state["heading_deg"] is None else round(state["heading_deg"], 1),
                "spd": round(state["speed_mps"], 1), "hold": state["holding"],
                "battery_pct": state.get("battery_pct"),
                "power_kw": (state.get("energy") or {}).get("power_kw"),
            }, ensure_ascii=False) + "\n")

    def event(self, event):
        self._open()
        self.events += 1
        # A copy, so a record the day goes on editing is written as it was asked.
        event = copy.deepcopy(event)
        self._submit(lambda: self._write_event(event))

    def _write_event(self, event):
        self._proximity.event(event)
        self._events.write(json.dumps(event, ensure_ascii=False) + "\n")
        self._events.flush()

    def diagnostic(self, diagnostic):
        """Persist developer detail outside the operational event stream."""
        self._open()
        diagnostic = copy.deepcopy(diagnostic)
        self._submit(lambda: self._write_diagnostic(diagnostic))

    def _write_diagnostic(self, diagnostic):
        self._diagnostics.write(json.dumps(diagnostic, ensure_ascii=False) + "\n")
        self._diagnostics.flush()

    def finish(self, engine, schedule, *, analysis=None):
        """The two files that are read rather than replayed: flights and holds."""
        self._open()
        self._wait()
        self._proximity.flush()
        for handle in (self._tracks, self._events, self._diagnostics):
            if handle:
                handle.flush()
        actual = {}
        energy_by_flight, minimum_soc = {}, {}
        for event in (analysis or {}).get('events', engine.events):
            row = actual.setdefault(event["flight_id"], {})
            row[event["kind"]] = event
            if isinstance(event.get('energy'), dict):
                energy_by_flight[event['flight_id']] = event['energy']
                minimum_soc[event['flight_id']] = min(minimum_soc.get(event['flight_id'], 100), event['energy']['soc_pct'])
        energy_by_flight.update((analysis or {}).get('energy_current', {}))
        for identifier, energy in energy_by_flight.items():
            minimum_soc[identifier] = min(minimum_soc.get(identifier, 100), energy['soc_pct'])
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["flight_plan_id", "aircraft_id", "seats", "origin", "destination",
                         "planned_off_block", "actual_off_block", "off_block_delay_s",
                         "planned_touchdown", "actual_touchdown", "touchdown_delay_s",
                         "hold_seconds", "landing_sequence", "direct_corridor", "status",
                         "energy_used_kwh", "energy_deficit_kwh", "charge_grid_kwh", "battery_min_pct"])
        for flight in schedule["flights"]:
            rows = actual.get(flight["flight_id"], {})
            off = rows.get("off_block")
            touch = rows.get("touchdown")
            request = rows.get("arrival_request", {})
            energy = energy_by_flight.get(flight['flight_id'], {})
            writer.writerow([
                flight["flight_id"], flight["aircraft_id"], flight["seats"],
                flight["origin"], flight["destination"],
                flight_schedule.clock_text(flight["off_block_s"]),
                off["clock"] if off else "", round(off["delay_s"], 1) if off else "",
                flight_schedule.clock_text(flight["touchdown_s"]),
                touch["clock"] if touch else "",
                round(touch["time_s"] - flight["touchdown_s"], 1) if touch and flight["touchdown_s"] else "",
                round(touch.get("hold_s", 0.0), 1) if touch else "",
                request.get("sequence", ""), "yes" if (off or {}).get("direct") else "",
                "flown" if touch else ("started" if off else "not started"),
                energy.get('flight_used_kwh', ''), energy.get('flight_deficit_kwh', ''),
                energy.get('flight_grid_kwh', ''), minimum_soc.get(flight['flight_id'], ''),
            ])
        # csv.writer already ends its rows the way a spreadsheet expects. Writing
        # that through a text file which translates line endings again turns every
        # row into two, so the translation is switched off here rather than the
        # writer being told to produce something no spreadsheet reads.
        with open(self.directory / "flights.csv", "w", encoding="utf-8-sig", newline="") as handle:
            handle.write(buffer.getvalue())
        (self.directory / "holds.json").write_text(json.dumps({
            "schema_version": SCHEMA_VERSION, "scenario_id": self.scenario_id,
            "statistics": engine.psu.statistics(), "holds": engine.psu.holds(),
        }, ensure_ascii=False, indent=1), encoding="utf-8")
        (self.directory / "summary.json").write_text(json.dumps({
            "schema_version": SCHEMA_VERSION, "scenario_id": self.scenario_id,
            "schedule": flight_schedule.summary(schedule), "result": engine.summary(),
            "track_rows": self.rows, "events": self.events,
            "recorded_at": time.time(),
        }, ensure_ascii=False, indent=1), encoding="utf-8")
        from data.simulation.operations_records import write_operations
        from user_application.uam_mission.operations_analysis import capture
        write_operations(self.directory, analysis or capture(engine, schedule, self.scenario_id))
        self.finalized = True  # Only successful durable writes may suppress a retry.
        return self.manifest()

    def manifest(self):
        files = []
        for name in ("tracks.jsonl", "events.jsonl", "diagnostics.jsonl",
                     "flights.csv", "holds.json", "summary.json"):
            path = self.directory / name
            if path.exists():
                files.append({"name": name, "bytes": path.stat().st_size})
        return {"scenario_id": self.scenario_id, "files": files, "rows": self.rows,
                "proximity": None if self._proximity is None else {
                    "run_id": self._proximity.logger.run_id,
                    "path": (self._proximity.directory/'proximity.json').relative_to(self._proximity_workspace).as_posix(),
                    "continuous_minimum_guaranteed": False}}

    def close(self):
        self._wait()
        if self._writer is not None:
            self._queue.put(None)
            self._writer.join(timeout=5)
            self._writer = None
        if self._proximity is not None:
            self._proximity.close()
        for handle in (self._tracks, self._events, self._diagnostics):
            if handle:
                handle.close()
        self._tracks = self._events = self._diagnostics = None


def _serialized(method):
    @wraps(method)
    def read(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)
    return read


class ScenarioSession(ScenarioObservation):
    """One loaded day, and the clock the operator drives it with."""

    def __init__(self, *, vertiports, network, elevation=None, directory=None, now=time.time,
                 pilots_factory=None, provisional_names=(), profile=None, policy=None, log_workspace=None,
                 custody=None):
        # The speeds every flight of a loaded day is built to, read when the day
        # is loaded so it does not change speed halfway through.
        self._profile = profile
        # The decision charts' numbers, read the same way and for the same
        # reason: a day is one rehearsal of one set of rules. Saving a change
        # while a day is playing takes effect when it is loaded again, which is
        # the honest behaviour - half a day flown under each rule answers
        # nothing.
        self._policy = policy
        self._provisional_names = provisional_names
        self._pilots_factory = pilots_factory
        self._vertiports, self._network, self._elevation = vertiports, network, elevation
        self._directory = Path(directory) if directory else None
        self._log_workspace = log_workspace
        self._now = now
        self._lock = threading.RLock()
        self._gc_sweep_at = self._gc_full_at = time.monotonic()
        self.schedule = None
        self.engine = None
        self.recorder = None
        self.state = IDLE
        self.speed = DEFAULT_SPEED
        self.name = ""
        self.scenario_id = ""
        self.loaded_at = None
        self.control_open = False
        # Which airframe, if any, a person is flying, and the speed to put back.
        self.manual_aircraft, self.manual_previous_speed = None, None
        # One globe, one clock, one fleet: the day and a single flight cannot
        # both be driving them. Without one of these the twin is this session's
        # alone, which is what the tests do.
        self.custody = custody or twin_custody.TwinCustody()
        self._anchor_wall = None
        self._anchor_scenario = None
        self._last_record = None
        self._recorded_events = 0
        self._recorded_diagnostic_sequence = 0
        self._prediction_history = PredictionHistory()
        self._prediction_watches = {}
        self._prediction_generation = 0
        self._manual_prediction_references = {}
        # What a cockpit has posted, and what it is told back. The pilot's
        # socket touches these without the lock at about twenty messages a
        # second; the tick drains them under it. Nothing here reads or writes
        # the fleet -- that belongs to whoever owns it, which is the tick.
        self._manual_poses = {}          # aircraft_id -> pose kwargs; newest wins, drained by the tick
        self._manual_watch = set()       # aircraft_id with a cockpit currently flying it
        self._manual_advice = {}         # aircraft_id -> the last advisory the tick computed
        # vertiport id -> (latitude, longitude, cos latitude) of its frame, read
        # once per loaded day for the wire view's nearest-endpoint test.
        self._surface_frames = {}
        self._manual_advice_at = -float('inf')

    def _make_pilots(self, policy):
        """Build the pilots, telling them the rules if they want to be told.

        A factory that takes nothing is a factory that flies the numbers it was
        compiled with, which is a fair thing to want and what every caller
        wanted until the charts existed. Asking rather than assuming keeps
        those callers working."""
        if self._pilots_factory is None:
            return None
        try:
            wants_policy = bool(inspect.signature(self._pilots_factory).parameters)
        except (TypeError, ValueError):
            wants_policy = False
        return self._pilots_factory(policy) if wants_policy else self._pilots_factory()

    def close(self):
        with self._lock:
            if self.engine:
                self.engine.close()
            self._close_recorder()
            self.state = PAUSED if self.engine else IDLE

    # ---- loading -----------------------------------------------------------
    def load(self, text, *, name="", on_progress=None):
        """Read a flight-plan file and set the day out on the decks."""
        if on_progress:on_progress("initialize", 0, 1)
        with self._lock:
            infrastructure_revision = getattr(self, "_infrastructure_revision", 0)
            records = list(self._vertiports())
        schedule = flight_schedule.read_schedule(text, vertiports=records, name=name)
        policy = self._policy() if callable(self._policy) else self._policy
        operators = VertiportOperators(records)
        engine = ScenarioEngine(schedule, vertiports=records, network=self._network(),
                                elevation=self._elevation, profile=self._profile, policy=policy,
                                pilots=self._make_pilots(policy),
                                provisional_names=self._provisional_names,
                                ground_control=VertiportGroundControl(), on_prepare=on_progress,
                                vertiport_operators=operators)
        if on_progress:on_progress("publish", 0, 1)
        with self._lock:
            self._close_recorder()
            if self.engine is not None:
                self.engine.close()
            self.schedule, self.engine = schedule, engine
            self._surface_frames = {}
            self._infrastructure_dirty = infrastructure_revision != getattr(self, "_infrastructure_revision", 0)
            from data.simulation.operations_records import OperationsHistory
            self._operations_history = OperationsHistory()
            self._reset_prediction_history()
            self.name = name or schedule.get("name") or "비행계획"
            self.scenario_id = f"{schedule['schedule_id']}-{uuid.uuid4().hex[:6]}"
            self.state, self.speed = READY, DEFAULT_SPEED
            self.control_open = False
            self.manual_aircraft, self.manual_previous_speed = None, None
            self.loaded_at = self._now()
            self._anchor_wall = self._anchor_scenario = None
            self._last_record = None
            self._recorded_events = 0
            self._recorded_diagnostic_sequence = 0
            self.recorder = ScenarioRecorder(self._directory, self.scenario_id,
                workspace=self._log_workspace, policy=self.engine.policy) if self._directory else None
        self._freeze_day()
        return self.description()

    # The cyclic collector's oldest-generation pass walks every tracked object
    # in the process, and a loaded morning is millions of them: measured on the
    # live server while a pilot flew, it stopped every thread for 200-290 ms
    # every 9-10 s, which is the hitch the pilot felt. Once a day is loaded,
    # what is alive is moved to the collector's permanent generation and never
    # walked again; the passes that keep running see only what the ticks
    # allocate, which is small and dies young. Unloading moves the day back
    # and collects it, so a day that is gone does not stay in memory.
    def _freeze_day(self):
        gc.unfreeze()
        gc.collect()
        gc.freeze()
        self._gc_sweep_at = self._gc_full_at = time.monotonic()

    # Measured on the live server with the day frozen at load: the collector's
    # oldest pass still stopped every thread every 9 s, for longer as the day
    # went on (118 ms at the start of a flight, 275 ms ten minutes in), because
    # what the day keeps as it runs - events, trails, histories, pair minima -
    # piles up behind the freeze and every pass walks all of it. So the tick
    # sweeps that pile every GC_SWEEP_S and freezes what survived, which keeps
    # each pass to a few milliseconds, and every GC_FULL_S thaws and collects
    # the whole day once, so nothing that died frozen stays. Only when garbage
    # is collected changes; nothing the day computes does.
    def _collect_garbage_quietly(self):
        now = time.monotonic()
        if now - self._gc_full_at >= GC_FULL_S:
            self._gc_full_at = self._gc_sweep_at = now
            gc.unfreeze()
            gc.collect()
            gc.freeze()
        elif now - self._gc_sweep_at >= GC_SWEEP_S:
            self._gc_sweep_at = now
            gc.collect()
            gc.freeze()

    @staticmethod
    def _thaw_day():
        gc.unfreeze()
        gc.collect()

    def clear(self):
        with self._lock:
            self._close_recorder()
            if self.engine is not None:
                self.engine.close()
            self.schedule = self.engine = None
            self._surface_frames = {}
            self._forget_manual()
            self._reset_prediction_history()
            self.state, self.control_open = IDLE, False
            self.scenario_id, self.name = "", ""
        self._thaw_day()
        return self.description()

    def _close_recorder(self):
        if self.recorder is not None:
            if self.engine is not None and self.engine.events and not self.recorder.finalized:
                from data.simulation.operations_records import write_operations
                snapshot = self.analysis_input()
                snapshot['meta']['state'] = 'finished'
                write_operations(self.recorder.directory, snapshot)
            self.recorder.close()
            self.recorder = None

    @_serialized
    def analysis_cache_key(self):
        # Wall-clock TTL owns freshness; simulation speed must not defeat sharing.
        return (self.scenario_id, self.state, id(self.engine), getattr(self, '_analysis_epoch', 0))

    @_serialized
    def analysis_stamp(self):
        return (self.scenario_id, self.state, int(self.engine.time_s // 5) if self.engine else None)

    @_serialized
    def analysis_input(self):
        from user_application.uam_mission.operations_analysis import capture
        return capture(self.engine, self.schedule, self.scenario_id, self.name, self.state,
                       self._operations_history.observe(self.engine.events)) if self.engine else None

    # ---- the clock ---------------------------------------------------------
    def open_control(self):
        """Hand the twin over to the day without starting it.

        This is the switch the operator throws when the control panel opens: the
        clock moves to the scheduled date, the live traffic outside the window
        stops being drawn, and the day's aircraft appear on their stands. The
        day is not running yet — nothing moves until play.
        """
        with self._lock:
            if self.engine is None:
                raise ValueError("비행계획을 먼저 불러오세요")
            if self.state == FINISHED:
                self.reset()
            if not self.control_open:
                # Raises by name when a single flight has it, so the operator is
                # told what to end rather than left with a day that will not open.
                self.custody.take(twin_custody.DAY)
            self.control_open = True
        return self.status()

    def close_control(self):
        """Closing the console ends simulation, releases native pilots and hides entities."""
        with self._lock:
            self.stop()
            if self.engine:
                self.engine.close()
            self.control_open = False
            self.manual_aircraft, self.manual_previous_speed = None, None
            self._anchor_wall = None
            self.custody.clear(twin_custody.DAY)
        return self.status()

    def play(self):
        with self._lock:
            if getattr(self, "_infrastructure_dirty", False):
                raise ValueError("버티포트 설정이 변경되었습니다. 비행계획을 다시 불러와 경로를 생성해 주세요.")
            if self.engine is None:
                raise ValueError("비행계획을 먼저 불러오세요")
            if self.state == FINISHED:
                return self.status()
            if any(a.failed for a in self.engine.aircraft.values()):
                raise ValueError("물리 비행 오류가 있습니다. 초기화 후 다시 실행하세요")
            self._anchor(self.engine.time_s)
            self.state = PLAYING
            self.control_open = True
        return self.status()

    def pause(self):
        with self._lock:
            if self.state == PLAYING:
                if not self.engine.pilots:
                    self.tick()
                self.state = PAUSED
        return self.status()

    def stop(self):
        """End the day here and write what it produced."""
        with self._lock:
            if self.engine is None:
                return self.status()
            if self.state == PLAYING and not self.engine.pilots:
                self.tick()
            self.state = FINISHED
            self._anchor_wall = None
            if self.recorder is not None and not self.recorder.finalized:
                self.recorder.finish(self.engine, self.schedule, analysis=self.analysis_input())
        return self.status()

    def reset(self):
        """Back to the start of the day, with the sequence forgotten too."""
        with self._lock:
            if self.engine is None:
                return self.status()
            self._close_recorder()
            self.engine.reset()
            self._analysis_epoch = getattr(self, "_analysis_epoch", 0) + 1
            from data.simulation.operations_records import OperationsHistory
            self._operations_history = OperationsHistory()
            self._reset_prediction_history()
            self.state = READY
            self.speed = DEFAULT_SPEED
            self._anchor_wall = self._anchor_scenario = None
            self._last_record = None
            self._recorded_events = 0
            self._recorded_diagnostic_sequence = 0
            if self._directory:
                self.scenario_id = f"{self.schedule['schedule_id']}-{uuid.uuid4().hex[:6]}"
                self.recorder = ScenarioRecorder(self._directory, self.scenario_id,
                    workspace=self._log_workspace, policy=self.engine.policy)
        return self.status()

    def set_speed(self, speed):
        speed = int(speed)
        if speed not in SPEEDS:
            raise ValueError(f"배속: {', '.join(str(item) for item in SPEEDS)} 중에서 고르세요")
        with self._lock:
            if self.state == PLAYING and not self.engine.pilots:
                # Re-anchor first, or the time already flown is re-flown at the
                # new speed and the day jumps.
                self.tick()
            self.speed = speed
            if self.state == PLAYING:
                self._anchor(self.engine.time_s)
        return self.status()

    def _anchor(self, scenario_s):
        self._anchor_wall = self._now()
        self._anchor_scenario = float(scenario_s)

    def tick(self, max_advance_s=None):
        """Move the day to where the wall clock says it should be.

        Called from whatever loop is serving the twin. A gap longer than
        `MAX_ADVANCE_S` is walked in pieces so the sequence still happens in
        order, and the anchor is moved with it so the day does not sprint to
        catch up after a long pause.
        """
        with self._lock:
            # Before the early return, not after: a paused day is still being
            # flown by hand, so its poses still land and its clearances still
            # refresh. Only the schedule stops when the day is paused.
            self._pump_manual()
            self._collect_garbage_quietly()
            if self.state != PLAYING or self.engine is None or self._anchor_wall is None:
                return False
            elapsed = (self._now() - self._anchor_wall) * self.speed
            target = self._anchor_scenario + elapsed
            if target <= self.engine.time_s:
                return False
            limit = min(MAX_ADVANCE_S, 12.0) if self.engine.pilots else MAX_ADVANCE_S
            if max_advance_s is not None:
                limit = min(limit, max_advance_s)
            if target - self.engine.time_s > limit:
                target = self.engine.time_s + limit
                self._anchor(target)
            self.engine.advance(target)
            self._capture_prediction_history()
            if any(a.failed for a in self.engine.aircraft.values()):
                self.state = PAUSED
            self._record()
            # Planned closing time is not actual completion: queues and native
            # dynamics can run late. Never freeze an unfinished flight mid-air.
            if (self.engine.time_s >= self.engine.closes_s
                    and all(a.finished and a.energy.charge_state not in ('connecting', 'charging')
                            for a in self.engine.aircraft.values())):
                self.state = FINISHED
                if self.recorder is not None:
                    self.recorder.finish(self.engine, self.schedule, analysis=self.analysis_input())
            return True

    def advance_view(self):
        """One bounded physical slice and its consistent read-only wire view.

        Called on a worker, never the ASGI loop. Controls need wait for at most
        this slice, not twelve simulated seconds of every aircraft.
        """
        with self._lock:
            self.tick(max_advance_s=max(.25, self.speed * .12))
            rate = self.speed if self.state == PLAYING else 0.0
            return self.epoch_time(), self.entities(), rate

    def _record(self):
        self._operations_history.observe(self.engine.events)
        if self.recorder is None:
            return
        moment = self.engine.time_s
        if self._last_record is None or moment - self._last_record >= RECORD_INTERVAL_S:
            self._last_record = moment
            self.recorder.track(moment, self.engine.states())
        history = self._operations_history.events
        for event in history[self._recorded_events:]:
            self.recorder.event(event)
        self._recorded_events = len(history)
        for diagnostic in self.engine.diagnostics:
            sequence = int(diagnostic.get('diagnostic_sequence') or 0)
            if sequence > self._recorded_diagnostic_sequence:
                self.recorder.diagnostic(diagnostic)
                self._recorded_diagnostic_sequence = sequence

    # ---- what the twin sees ------------------------------------------------
    @property
    def showing(self):
        """Whether the twin is on this day rather than on the live clock.

        It is opening the console that decides this, not playing: an operator
        who has opened it is looking at the scheduled morning with 84 aircraft
        standing on their decks, and that is already the day rather than now.
        """
        return self.engine is not None and self.control_open

    @_serialized
    def epoch_time(self):
        """The real instant the day is currently at, for everything else in the
        sky. None when no day is loaded, so the caller keeps the wall clock."""
        if not self.showing:
            return None
        return epoch_of(self.schedule.get("date"), self.engine.time_s)

    @_serialized
    def entities(self):
        """The day's aircraft as twin entities, in the shape the live wire uses."""
        if not self.showing:
            return ()
        moment = self.epoch_time() or self._now()
        entities = []
        for state in self.engine.states():
            entities.append(self._entity(state, moment))
        return tuple(entities)

    def _entity(self, state, moment):
        latitude, longitude = state["latitude_deg"], state["longitude_deg"]
        altitude = state["altitude_m"]
        position = _ecef(latitude, longitude, altitude)
        # The engine knows how fast this is going and which way, so the entity
        # carries its velocity. Without it nothing downstream can project the
        # aircraft forward, and a UAM whose speed we know would be the one thing
        # on the map that could not be extrapolated.
        velocity = _velocity_ecef(latitude, longitude, state["heading_deg"], state["speed_mps"],
                                  state.get("climb_mps", 0.0))
        # Attitude yaw is not the velocity bearing during a turn or sideslip.
        # Carry the native NED vector unchanged through the coordinate transform.
        ned = state.get("velocity_ned_mps")
        if ned and len(ned) == 3 and all(math.isfinite(v) for v in ned):
            velocity = _velocity_ecef(latitude, longitude, math.degrees(math.atan2(ned[1], ned[0])),
                                      math.hypot(*ned), -ned[2]) or (0.0, 0.0, 0.0)
        name = state["aircraft_id"]
        if state["flight_id"]:
            name = f"{state['aircraft_id']} · {state['flight_id']}"
        return TwinEntity(
            entity_id=f"scenario:{state['aircraft_id']}", name=name, kind="uam",
            position_ecef_m=position, velocity_ecef_mps=velocity,
            latitude_deg=latitude, longitude_deg=longitude, altitude_m=altitude,
            heading_deg=state["heading_deg"], state_time=moment, observation_time=moment,
            received_time=moment, orbit_epoch=None, derivation="simulated",
            quality="nominal", source="scenario", model_id="asset_states",
            visual_asset_id=state["asset_id"], provenance="simulation",
            orientation_source="attitude" if state["engine"] == "native-fastphysics-simpleflight" else "ground_track",
            pitch_deg=state["pitch_deg"], roll_deg=state["roll_deg"], tilt_deg=state["tilt_deg"],
            control_surface_deg=state.get("control_surface_deg"), rotor_radps=state["rotor_radps"], flight_phase=state["phase"], visual_match="representative",
            ground_waiting=state['ground_waiting'], ground_action=state['instruction'].get('action'),
            charging_connection=ChargingConnection(**state['charging_connection']) if state.get('charging_connection') else None,
            battery_pct=state.get('battery_pct'), charge_state=(state.get('energy') or {}).get('charge_state'),
            surface_reference=self._surface_reference(state))

    @_serialized
    def prediction_input(self, entity_id):
        """A consistent state/intent pair, read without advancing the simulation."""
        if not self.showing or not str(entity_id).startswith("scenario:"):
            return None
        aircraft = self.engine.aircraft.get(str(entity_id).split(":", 1)[1])
        if aircraft is None:
            return None
        state = self.engine._state(aircraft)
        entity = self._entity(state, self.epoch_time())
        points, cursor, rules = (), 0, {}
        pilot = getattr(self.engine.pilots, "flights", {}).get(aircraft.aircraft_id)
        if aircraft.external and aircraft.route:
            # The automatic phase clock deliberately stops during manual control.
            # Derive the remaining route from the observed pose, as single manual
            # prediction does; never resume the old automatic target behind it.
            from user_application.uam_mission.replay_prediction import manual_reference
            cache = self._manual_prediction_references.get(aircraft.aircraft_id)
            if cache is None or cache['route'] is not aircraft.route or cache['owner'] is not aircraft.external:
                plan = {'legs': [{'stage': phase.stage, 'speed_mps': phase.speed_mps,
                                 'path': [[p[1], p[0], p[2]] for p in phase.points]}
                                for phase in aircraft.route.phases]}
                cache = {'route': aircraft.route, 'owner': aircraft.external, 'plan': plan, 'intent': None}
            reference = manual_reference(entity, cache['plan'], cache['intent'])
            cache['intent'] = reference
            self._manual_prediction_references[aircraft.aircraft_id] = cache
            while len(self._manual_prediction_references) > 8:
                self._manual_prediction_references.pop(next(iter(self._manual_prediction_references)))
            points, cursor = reference.waypoints, reference.target_index
        elif aircraft.pilot_active and pilot:
            cursor = aircraft.telemetry.get("route_target_index", 0)
            points = getattr(pilot, "prediction_points", ())[cursor:]
            rules = getattr(pilot, "prediction_policy", {})
        elif aircraft.route and not aircraft.pilot_active:
            # Ground/rehearsal routes have a known phase clock. Restrict the
            # projection to that active phase before walking the remaining ones.
            remaining = []
            for index, phase in enumerate(aircraft.route.phases[aircraft.index:], aircraft.index):
                if state["phase"] in {"gate_in", "gate_out"} and (index != aircraft.index or state["speed_mps"] < .05):
                    break
                if phase.stage in {"parked", "charge"}:
                    break
                pairs = list(zip(phase.points, phase.points[1:]))
                if index == aircraft.index and pairs:
                    share = min(1.0, aircraft.elapsed / max(.001, phase.duration_s))
                    wanted = share * phase.distance_m
                    skip = next((i for i in range(len(pairs)) if phase.marks[i+1] >= wanted), len(pairs)-1)
                    pairs = pairs[skip:]
                remaining.extend(PredictionWaypoint(tuple(a), tuple(b), phase.speed_mps, phase.stage) for a, b in pairs)
                if phase.stage == "landing":
                    break
            points = tuple(remaining)
        holding = bool(aircraft.hold) or state["holding"]
        if holding:
            fix = (aircraft.hold or {}).get("fix")
            here = (entity.latitude_deg, entity.longitude_deg, entity.altitude_m)
            points = (PredictionWaypoint(here, tuple(fix or here), float(rules.get("hold_speed_mps", 6)), "hold"),)
        intent = UamPredictionIntent(entity.entity_id, entity.state_time, state["flight_id"], state["phase"],
            tuple(points), cursor, holding,
            max_speed_mps=float(rules.get("max_speed_mps", 60)),
            climb_rate_mps=float(rules.get("climb_rate_mps", 2)),
            descent_rate_mps=float(rules.get("descent_rate_mps", 2.54)),
            landing_rate_mps=float(rules.get("landing_rate_mps", 1.2)),
            approach_speed_mps=float(rules.get("approach_horizontal_speed_mps", 10)),
            hold_speed_mps=float(rules.get("hold_speed_mps", 6)),
            brake_mps2=float(rules.get("approach_brake_mps2", .7)),
            reverse_speed_mps=float(rules.get("reverse_speed_mps", 8)),
            reverse_transition_s=float(rules.get("reverse_transition_s", 20)),
            reverse_margin_m=float(rules.get("reverse_margin_m", 100)),
            wing_recover_mps=float(rules.get("wing_recover_mps", 26)))
        return entity, intent

    def _reset_prediction_history(self):
        self._prediction_generation += 1
        self._prediction_history.clear()
        self._manual_prediction_references.clear()
        self._prediction_watches.clear()

    def _prediction_context(self, entity, intent):
        return (self._prediction_generation, self.scenario_id, intent.mission_id, entity.continuity_id)

    def _capture_prediction_sample(self, entity_id, *, force=False):
        captured = self.prediction_input(entity_id)
        if captured is None:
            return None
        entity, intent = captured
        context = self._prediction_context(entity, intent)
        previous = self._prediction_history.latest(entity_id, context)
        if force or previous is None or entity.state_time-previous[0] >= .2:
            # Actual off-block, not planned time, selection time, or Unix epoch.
            departure = next((event['time_s'] for event in reversed(self.engine.events)
                              if event['kind']=='off_block' and event['flight_id']==intent.mission_id), None)
            if departure is not None:
                sample = feature_sample(entity, intent, self.engine.time_s-departure, previous)
                if sample is not None:
                    target=intent.waypoints[0]
                    target_key=(intent.target_index,target.start,target.end,target.speed_mps)
                    self._prediction_history.append(entity_id, context, entity.state_time, sample,target_key=target_key)
        return entity, intent, context

    def _capture_prediction_history(self):
        # Selected objects only, at most eight. No extra dynamics substeps or inference here.
        for entity_id, until in tuple(self._prediction_watches.items()):
            if until < self._now():
                self._prediction_watches.pop(entity_id, None)
            else:
                self._capture_prediction_sample(entity_id)

    @_serialized
    def learned_prediction_input(self, entity_id):
        captured = self._capture_prediction_sample(entity_id, force=True)
        if captured is None:
            return None
        self._prediction_watches.pop(entity_id, None)
        self._prediction_watches[entity_id] = self._now()+60
        while len(self._prediction_watches)>8:
            self._prediction_watches.pop(next(iter(self._prediction_watches)))
        entity, intent, context = captured
        windows = {f'uam_route_mlp_{name}': self._prediction_history.window(
            entity_id, context, entity.state_time, step)
            for name, step in (('short',.4),('mid',1.2),('long',1.2))}
        return {'entity':entity,'intent':intent,'context':context,'windows':windows}

    @_serialized
    def prediction_context_matches(self, captured):
        current = self.prediction_input(captured['entity'].entity_id)
        if current is None:
            return False
        entity, intent = current
        prior = captured['intent']
        return (self._prediction_context(entity, intent)==captured['context']
                and entity.state_time>=captured['entity'].state_time
                and intent.phase==prior.phase and intent.holding==prior.holding
                and intent.target_index==prior.target_index
                and intent.waypoints[:1]==prior.waypoints[:1])

    def _surface_reference(self, state):
        """Read the nearest endpoint's datum; never feed display heights back.

        The renderer may use World Terrain while physics uses the local DEM.
        Carry the actual simulation datum rather than making a client guess it
        from a parked sample. The endpoint is chosen geometrically, not by the
        newest phase, so buffered takeoff/landing samples keep the right deck.
        """
        candidates = []
        frames = self.__dict__.setdefault('_surface_frames', {})
        for identifier in {state.get('origin'), state.get('destination')} - {None}:
            frame = frames.get(identifier, False)
            if frame is False:
                raw = self.engine._layout(identifier).get('frame') or {}
                frame = frames[identifier] = (
                    (raw['latitude'], raw['longitude'], math.cos(math.radians(raw['latitude'])))
                    if all(isinstance(raw.get(key), (int, float)) for key in ('latitude', 'longitude')) else None)
            if frame is None:
                continue
            north = state['latitude_deg'] - frame[0]
            east = (state['longitude_deg'] - frame[1]) * frame[2]
            candidates.append((north * north + east * east, identifier))
        if not candidates:
            return None
        identifier = min(candidates)[1]
        return SurfaceReference(identifier, self.engine._deck_height(identifier))

    # ---- what the panel reads ----------------------------------------------
    @_serialized
    def description(self):
        if self.schedule is None:
            return {"schema_version": SCHEMA_VERSION, "state": IDLE, "loaded": False,
                    "speeds": list(SPEEDS)}
        return {
            "schema_version": SCHEMA_VERSION, "state": self.state, "loaded": True,
            "scenario_id": self.scenario_id, "name": self.name,
            "speeds": list(SPEEDS), "speed": self.speed,
            "schedule": flight_schedule.summary(self.schedule),
            "initial_state": self.engine.initial_state,
            "problems": self.schedule.get("problems", [])[:20],
        }

    @_serialized
    def edit_infrastructure(self, operation):
        """Serialize stored infrastructure changes against play/pause transitions."""
        with self._lock:
            if self.state in (PLAYING, PAUSED):
                raise PermissionError("시뮬레이션 진행 중에는 이착륙 높이를 변경할 수 없습니다. 시뮬레이션을 종료한 뒤 수정해 주세요.")
            result = operation()
            self._infrastructure_revision = getattr(self, "_infrastructure_revision", 0) + 1
            self._infrastructure_dirty = self.engine is not None
            return result

    @_serialized
    def status(self):
        if self.engine is None:
            return {"schema_version": SCHEMA_VERSION, "state": IDLE, "loaded": False,
                    "speeds": list(SPEEDS), "speed": self.speed, "control_open": False,
                    "manual_aircraft": None, "twin_holder": self.custody.holder}
        summary = self.engine.summary()
        return {
            "schema_version": SCHEMA_VERSION, "state": self.state, "loaded": True,
            "scenario_id": self.scenario_id, "name": self.name,
            "speeds": list(SPEEDS), "speed": self.speed, "control_open": self.control_open,
            "manual_aircraft": self.manual_aircraft,
            "twin_holder": self.custody.holder,
            "date": self.schedule.get("date", ""),
            "epoch_time": self.epoch_time(),
            "recording": None if self.recorder is None else
                         {"rows": self.recorder.rows, "events": self.recorder.events,
                          "scenario_id": self.recorder.scenario_id},
            **summary,
        }

    @_serialized
    def events(self, since=0, limit=200):
        if self.engine is None:
            return []
        return self.engine.events[max(0, int(since)):][:int(limit)]

    # ---- one aircraft flown by a person ----------------------------------
    # The day keeps running around them, so all of this is taken under the same
    # lock as everything else that touches the engine.
    @_serialized
    def manual_models(self, vertiport=None):
        return [] if self.engine is None else manual_takeover.models(self.engine, vertiport=vertiport)

    @_serialized
    def manual_candidates(self, asset_id=None, vertiport=None, seats=None):
        return [] if self.engine is None else manual_takeover.candidates(
            self.engine, asset_id=asset_id, vertiport=vertiport, seats=seats)

    @_serialized
    def assign_manual(self, aircraft_id=None, *, flight_id=None, asset_id=None, vertiport=None, seats=None):
        """Hand one airframe to a person, choosing it for them when they did not.

        Flying by hand only works in real time, so the day drops to x1 and the
        speed it was running at is kept to be put back. Doing it for them beats
        refusing: the operator asked to fly, not to think about the clock.
        """
        if self.engine is None:
            raise ValueError("비행계획을 먼저 불러오세요")
        if aircraft_id is None:
            offered = manual_takeover.candidates(self.engine, asset_id=asset_id, vertiport=vertiport, seats=seats)
            if not offered:
                raise ValueError("조건에 맞는 출발 예정편이 없습니다. 기체나 출발지를 바꾸거나 시간을 더 진행하세요.")
            chosen = next((row for row in offered if row["flight_id"] == flight_id), None) if flight_id else None
            aircraft_id = (chosen or offered[0])["aircraft_id"]
        answer = manual_takeover.hand_over(self.engine, aircraft_id)
        self.manual_aircraft = aircraft_id
        if self.speed != 1:
            self.manual_previous_speed = self.speed
            if self.state == PLAYING and not self.engine.pilots:
                self.tick()
            self.speed = 1
            if self.state == PLAYING:
                self._anchor(self.engine.time_s)
        return {**answer, "speed": self.speed, "restored_speed": self.manual_previous_speed}

    @_serialized
    def release_manual(self, aircraft_id=None):
        identifier = aircraft_id or self.manual_aircraft
        released = bool(identifier) and self.engine is not None and manual_takeover.release(self.engine, identifier)
        if identifier == self.manual_aircraft:
            self.manual_aircraft = None
        restored = self.manual_previous_speed
        if restored and self.engine is not None:
            if self.state == PLAYING and not self.engine.pilots:
                self.tick()
            self.speed = restored
            if self.state == PLAYING:
                self._anchor(self.engine.time_s)
        self.manual_previous_speed = None
        return {"released": released, "speed": self.speed}

    @_serialized
    def manual_assignment(self, aircraft_id):
        return None if self.engine is None else manual_takeover.assignment(self.engine, aircraft_id)

    @_serialized
    def continue_manual(self, aircraft_id, *, battery_pct):
        """Keep the same cockpit and airframe for its next scheduled flight."""
        if self.engine is None:
            raise ValueError("비행계획을 먼저 불러오세요")
        answer = manual_takeover.continue_flight(
            self.engine, aircraft_id, battery_pct=battery_pct)
        # The socket reads the lock-free advisory cache. Replace it as one
        # finished dict so the next ground sync cannot briefly show the old
        # completed flight after the assignment has advanced.
        if aircraft_id in self._manual_watch:
            self._manual_advice[aircraft_id] = self._advice_now(aircraft_id)
            self._manual_advice_at = self._now()
        return answer

    def place_manual(self, aircraft_id, **pose):
        """NO LOCK. Post a pose for whoever owns the fleet to apply.

        The cockpit sends about twenty of these a second and cannot wait behind
        a tick that is walking the whole fleet. So this only leaves the pose in
        a mailbox and returns; `_pump_manual` applies it at the top of the next
        tick, which is exactly where it became visible before. `advance_view`
        holds the lock across `tick()` and `entities()`, so the wire has only
        ever sampled the fleet once per tick: a pose overtaken before the tick
        reads it was never observable by anything.
        """
        if self.engine is None:
            return False
        # The guard `manual_takeover.place` applies, applied at the door
        # instead. Nonsense from a stalled link must not reach the fleet, and a
        # pose that would raise must not be left for the tick to raise on.
        for key in ("latitude", "longitude", "altitude"):
            value = pose.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                return False
        # Taken out rather than read, so what comes back is a pose the tick has
        # certainly not applied yet. `step` says how long it took to get here,
        # and "here" is measured from the last pose the fleet actually took, so
        # a pose overtaking one still in the mailbox carries both messages'
        # time. Without this a collapsed pair reports twice the climb rate it
        # flew, which is the one thing `step` exists to get right.
        waiting = self._manual_poses.pop(aircraft_id, None)
        if waiting is not None and pose.get("step") and waiting.get("step"):
            pose = {**pose, "step": waiting["step"] + pose["step"]}
        self._manual_poses[aircraft_id] = pose
        return True

    def manual_advice(self, aircraft_id):
        """NO LOCK. The last advisory the tick computed for this aircraft, or None.

        One dict lookup. Entries are whole dicts the tick finished building
        before it put them here, so a reader never sees half of one.
        """
        return self._manual_advice.get(aircraft_id)

    @_serialized
    def manual_watch(self, aircraft_id):
        """A cockpit has taken this airframe. Registers it AND computes the first
        advisory immediately, so `manual_advice` has an answer from the first read."""
        self._manual_watch.add(aircraft_id)
        advice = self._advice_now(aircraft_id)
        self._manual_advice[aircraft_id] = advice
        self._manual_advice_at = self._now()
        return advice

    @_serialized
    def manual_unwatch(self, aircraft_id):
        """The cockpit has gone. Drops the registration, the cached advice and any
        pose still waiting in the mailbox."""
        watched = aircraft_id in self._manual_watch
        self._manual_watch.discard(aircraft_id)
        self._manual_advice.pop(aircraft_id, None)
        self._manual_poses.pop(aircraft_id, None)
        return watched

    def _advice_now(self, aircraft_id):
        """One cockpit's advisory, computed with the lock already held.

        The same two calls `manual_advisory` makes, in the same order and with
        the same clock attached, so the cockpit reading the cache and the
        operator reading the endpoint are told the same thing.
        """
        if self.engine is None:
            return None
        manual_takeover.check(self.engine, aircraft_id)
        answer = manual_takeover.advisory(self.engine, aircraft_id)
        if answer is not None:
            answer["clock"] = {"state":self.state,"date":self.schedule.get("date"),"time_s":self.engine.time_s,"rate":self.speed}
        return answer

    def _forget_manual(self):
        """Nothing posted to a day that is gone may reach the next one."""
        self._manual_poses.clear()
        self._manual_watch.clear()
        self._manual_advice.clear()
        self._manual_advice_at = -float('inf')

    def _pump_manual(self):
        """Apply what the pilots have sent, and refresh what they are told.

        Both halves belong to whoever owns the fleet, because `manual_takeover.place`
        writes straight into a live aircraft - position, speed, telemetry and
        `airborne`, which pad occupancy, approach separation and the ground checks
        all read. A pilot writing that while the tick walks the fleet is a real race.
        """
        if self.engine is None:
            return
        # Snapshot the keys and pop each one. Swapping the dict instead
        # (`poses, self._manual_poses = self._manual_poses, {}`) loses a pose
        # that lands between the two assignments; a pose that lands after its
        # own pop simply waits for the next tick. Bounded, and nothing is lost.
        for aircraft_id in list(self._manual_poses):
            pose = self._manual_poses.pop(aircraft_id, None)
            if pose is None:
                continue
            try:
                manual_takeover.place(self.engine, aircraft_id, **pose)
            except Exception:
                # One unusable pose is that pilot's problem. On the socket
                # thread it was swallowed and the flight went on; it must not
                # now stop the whole fleet from the tick thread.
                continue
        if not self._manual_watch:
            return
        now = self._now()
        if now - self._manual_advice_at < MANUAL_ADVICE_INTERVAL_S:
            return
        self._manual_advice_at = now
        # Only what a cockpit asked for. `check()` records violations, and today
        # it runs for no other aircraft; broadening it to everything `external`
        # would invent violations that do not exist.
        for aircraft_id in list(self._manual_watch):
            # A whole entry at a time, so a lock-free reader never sees half of one.
            self._manual_advice[aircraft_id] = self._advice_now(aircraft_id)

    @_serialized
    def manual_advisory(self, aircraft_id):
        if self.engine is None:
            return None
        # Checking here rather than in the step: it is the reading that has to
        # be honest, and a violation found is one the pilot is told about now.
        manual_takeover.check(self.engine, aircraft_id)
        answer = manual_takeover.advisory(self.engine, aircraft_id)
        if answer is not None:
            answer["clock"] = {"state":self.state,"date":self.schedule.get("date"),"time_s":self.engine.time_s,"rate":self.speed}
        return answer

    @_serialized
    def manual_request(self, aircraft_id, kind, **detail):
        if self.engine is None:
            raise ValueError("비행계획을 먼저 불러오세요")
        if kind == "resume_day":
            aircraft=self.engine.aircraft.get(aircraft_id)
            if aircraft is None or not aircraft.external:raise ValueError("수동 배정된 기체가 아닙니다")
            self.play()
            flight=manual_takeover._flight_of(self.engine,aircraft)
            self.engine._record(self.engine.time_s,'simulation_clock_resumed',flight,
                                role='scenario_operator',aircraft_id=aircraft_id)
            # Compatibility action on the historical request URL. This is a
            # whole-scenario clock command, never a Pilot -> PSU message.
            return {"state":"accepted","reason":"운항 시계 재생 · 전체 기체 운항이 진행됩니다",
                    "message_type":"simulation_clock_command_result",
                    "direction":"application_to_user"}
        return manual_takeover.request(self.engine, aircraft_id, kind, **detail)

    @_serialized
    def holds(self):
        return [] if self.engine is None else self.engine.psu.holds()

    @_serialized
    def flight(self, flight_id):
        return None if self.engine is None else self.engine.flight_detail(flight_id)

    aircraft = _serialized(ScenarioObservation.aircraft)

    @_serialized
    def track(self, aircraft_id):
        """Where one airframe has been on the flight it is flying or just flew."""
        if self.engine is None:
            return None
        track = self.engine.track(aircraft_id)
        if track is None:
            return None
        # Track points remain authoritative simulation altitudes.  The map may
        # register a deck against a different rendered terrain height, so give
        # the display the same endpoint datums carried by live entities.  The
        # renderer applies these only as a visual offset; recorded state is not
        # rewritten and never comes back into Simulation.
        references = {}
        for endpoint in ('origin', 'destination'):
            vertiport_id = track.get(endpoint)
            if vertiport_id and vertiport_id not in {
                    item['vertiport_id'] for item in references.values()}:
                references[endpoint] = {
                    'vertiport_id': vertiport_id,
                    'altitude_m': self.engine._deck_height(vertiport_id),
                }
        track['surface_references'] = references
        return track

    @_serialized
    def passengers(self):
        answer = ScenarioObservation.passengers(self)
        if answer is not None:
            answer.update(state_time=self.epoch_time(), scenario_id=self.scenario_id)
        return answer

    # Which end of a flight each vertiport stage belongs to. A deck's operator
    # is responsible for what happens on their own surface, so an aircraft
    # taxiing out is the departure deck's and one rolling in is the arrival
    # deck's, whatever the aircraft's own `vertiport` field says mid-flight.
    _DEPARTURE_PHASES = ("gate_out", "takeoff")
    _ARRIVAL_PHASES = ("landing", "gate_in", "charge")


    vertiport = _serialized(ScenarioObservation.vertiport)

    vertiport_summary = _serialized(ScenarioObservation.vertiport_summary)

    pilot_operations = _serialized(ScenarioObservation.pilot_operations)

    @_serialized
    def recording(self):
        return None if self.recorder is None else self.recorder.manifest()

    # What the day has produced, as the files themselves. A download taken while
    # the day is still running is of everything up to this moment: the derived
    # files are rebuilt first rather than handing over whatever was last written
    # at the end of some earlier run.
    EXPORTS = ("tracks.jsonl", "events.jsonl", "flights.csv", "holds.json", "summary.json")

    def export(self, name):
        if self.recorder is None or self.engine is None or name not in self.EXPORTS:
            return None
        with self._lock:
            if self.state == PLAYING:
                self.tick()
            self.recorder.finish(self.engine, self.schedule)
        path = self.recorder.directory / name
        if not path.exists():
            return None
        return path.read_text(encoding="utf-8-sig" if path.suffix == ".csv" else "utf-8")

    def export_summary(self, name):
        """One line about what that file holds, for the Library to show."""
        if self.engine is None:
            return "재생한 비행계획 없음", False
        result = self.engine.summary()
        rows = self.recorder.rows if self.recorder else 0
        if name == "flights.csv":
            return (f"비행 {result['flights']}편 · 완료 {result['flights_completed']}편 · "
                    f"대기 {result['psu']['held']}건"), result["flights_started"] > 0
        if name == "tracks.jsonl":
            return f"항적 {rows:,}행 · {self.name}", rows > 0
        if name == "holds.json":
            statistics = result["psu"]
            return (f"대기 {statistics['held']}건 · 평균 {statistics['hold_seconds_mean']:.0f}초 · "
                    f"최대 {statistics['hold_seconds_max']:.0f}초"), statistics["held"] > 0
        return f"{self.name} · {result['clock']}", result["flights_started"] > 0


def _velocity_ecef(latitude_deg, longitude_deg, heading_deg, speed_mps, climb_mps=0.0):
    """How this aircraft is moving, as earth-centred metres per second.

    `speed_mps` is the whole speed and `climb_mps` how much of it is upward, so
    the ground track is whatever is left over. Both are what the engine measured
    -- the physics reports its own vertical rate, and an aircraft walked along a
    phase gets one from the height it actually gained -- so nothing here is
    invented.

    It used to answer a purely horizontal vector. That made every prediction
    level by construction: an aircraft climbing out or coming down was drawn
    flying straight on at its cruise height, and the whole speed was spent on
    the ground track, so it was drawn going forward faster than it was.
    """
    if heading_deg is None:
        return None
    climb = float(climb_mps or 0.0)
    total = float(speed_mps or 0.0)
    if not total and not climb:
        return None
    # The ground part of the speed. A total that is all climb leaves none.
    ground = math.sqrt(max(0.0, total * total - climb * climb))
    latitude, longitude = math.radians(latitude_deg), math.radians(longitude_deg)
    heading = math.radians(heading_deg)
    north, east = math.cos(heading) * ground, math.sin(heading) * ground
    sin_lat, cos_lat = math.sin(latitude), math.cos(latitude)
    sin_lon, cos_lon = math.sin(longitude), math.cos(longitude)
    up = (cos_lat * cos_lon, cos_lat * sin_lon, sin_lat)
    return (-sin_lon * east - sin_lat * cos_lon * north + up[0] * climb,
            cos_lon * east - sin_lat * sin_lon * north + up[1] * climb,
            cos_lat * north + up[2] * climb)


def _ecef(latitude_deg, longitude_deg, altitude_m):
    """WGS-84 geodetic to earth-centred metres, the way the live wire carries it."""
    a, f = 6378137.0, 1 / 298.257223563
    e2 = f * (2 - f)
    latitude, longitude = math.radians(latitude_deg), math.radians(longitude_deg)
    sin_lat, cos_lat = math.sin(latitude), math.cos(latitude)
    n = a / math.sqrt(1 - e2 * sin_lat * sin_lat)
    return ((n + altitude_m) * cos_lat * math.cos(longitude),
            (n + altitude_m) * cos_lat * math.sin(longitude),
            (n * (1 - e2) + altitude_m) * sin_lat)
