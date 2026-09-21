"""Compose the approved data -> live -> state -> visualization route.

Only lifespan starts work. Existing native UAM runtimes remain independent.
"""
import asyncio
import hashlib
import json
import logging
import os
import time
import threading
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Awaitable, Callable

import httpx
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


class RevalidatedStaticFiles(StaticFiles):
    """Browser modules import each other by bare path, so every file must be
    revalidated on load: a heuristically cached importer next to a freshly edited
    dependency fails the whole boot. The ETag keeps a revalidation a 304."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response
from communication.web.response_compression import TileAwareGZipMiddleware
from communication.web.visual_static import BufferedModelFiles
from ai_pnp.domains.uam.uam_prediction import UamPredictionRunner, COMPARISON_ID

from communication.external.aircraft_window import ViewWindow
from communication.external.aircraft.opensky_source import OpenSkySource
from communication.external.satellite.celestrak_source import CelesTrakSource, NotModified
from communication.external.weather_source import OpenMeteoSource
from communication.web.live_routes import create_router
from communication.web.wire_snapshot import encode_snapshot
from data.ingestion.collection_guard import CollectionGuard, UNGUARDED
from data.ingestion.source_records import SourceRecords
from data.settings.source_settings import SourceSettings
from data.python.aerodt.data.run_logger import RunLogger
from data.ingestion.operational_audit import AuditJournal, AuditRecords
import uuid
from digital_twin.contracts.live import CAPABILITIES, SourceStatus
from digital_twin.model_library import ai_models, uam_prediction_catalog
from digital_twin.live_twin.domains.aircraft.model_setup import load_definitions
from digital_twin.live_twin.weather_conditions import read_conditions
from digital_twin.live_twin.composition.state_synchronization import LiveSynchronizer
from digital_twin.model_library.visual_matching import SatelliteModelMatcher
from user_application.apps.web_dashboard.library_settings import (BINDINGS, LibraryPolicy, describe_library,
                                                                  retry_delay_seconds, validate_settings)
from digital_twin.live_twin.twin_state_update import prepare
from digital_twin.runtime.real_time_twin.world import TwinWorld

ROOT = Path(__file__).resolve().parents[3]
LOGGER = logging.getLogger("aerodt.web_live")


@dataclass(frozen=True)
class SourceBinding:
    id: str
    format: str
    fetch: Callable[[], Awaitable[object]]
    interval_seconds: float
    persist: bool = False
    provenance: str = "live"
    # What the provider said about the copy we hold, sent back so it can answer
    # "not modified" instead of the whole catalogue.
    validator: Callable[[], str] | None = None
    # A bootstrap source this one replaces once it has delivered: the saved GP
    # shows satellites immediately, and both carrying them would double them.
    supersedes: str = ""


def _read_config_document(path):
    document = json.loads(path.read_text(encoding="utf-8"))
    includes = document.get("includes")
    if not includes:
        return document
    config = {}
    for include in includes:
        included = _read_config_document(path.parent / include)
        duplicates = config.keys() & included.keys()
        if duplicates:
            raise ValueError(f"duplicate web-dashboard settings: {', '.join(sorted(duplicates))}")
        config.update(included)
    return config


def load_config(path=None):
    path = Path(path) if path else ROOT / "user_application/configs/web_dashboard/default.json"
    config = _read_config_document(path)
    for key in ("tick_seconds", "stream_seconds", "celestrak_poll_seconds", "aircraft_poll_seconds"):
        if float(config[key]) <= 0:
            raise ValueError(f"{key} must be positive")
    return config


def published_asset_ids():
    from digital_twin.model_library.visual_catalog import read_visual_catalog
    catalogue = read_visual_catalog(ROOT / "digital_twin/model_library/visual_assets")
    return {asset["asset_id"] for asset in catalogue["assets"]}


def create_app(config=None, *, sources=None):
    include_physical = sources is None or bool(config and 'physical_uam_url' in config)
    settings = load_config()
    settings.update(config or {})
    tick = max(.01, float(settings["tick_seconds"]))
    world = TwinWorld()
    records = SourceRecords(settings.get("cache_directory") or ROOT / "data/workspace/live_ingestion")
    # Acquisition policy the operator owns: stored by Data, read live by the collector.
    workspace_directory = Path(settings.get("workspace_directory") or ROOT / "data/workspace")
    # The default demonstration is durable source data, while the editable copy
    # remains in the ignored workspace. A missing file is restored on first
    # start; an operator-authored file is never replaced.
    if workspace_directory.resolve() == (ROOT / "data/workspace").resolve():
        from data.simulation.workspace_seed import seed_simulation_workspace
        seed_simulation_workspace(
            workspace_directory,
            ROOT / "data/simulation/examples/seoul_uam",
        )
    settings_store = SourceSettings(workspace_directory / "settings/sources.json")
    # One schedule for every process on this machine: a restart or a second
    # dashboard must not turn one provider's poll into several.
    guard = CollectionGuard(settings.get("collection_guard") or workspace_directory / "collection/guard.json")
    library = LibraryPolicy(settings_store.read())
    library_write_lock=threading.Lock()
    uam_predictor = UamPredictionRunner(ROOT / uam_prediction_catalog.DEFAULT_PACKAGE)
    from user_application.apps.web_dashboard.camera_detection_process import CameraDetectionProcess
    camera_detector = CameraDetectionProcess(settings.get('camera_detection_python'))
    from ai_pnp.domains.uam.risk_prediction import RiskPredictionRunner
    from digital_twin.model_library.prism_2d.catalog import describe_model as describe_risk_model
    from user_application.apps.web_dashboard.domains.uam.prediction.risk_model_setup import PrismProcessModel, prediction_python
    risk_workers=[]
    def risk_runtime():return prediction_python(settings.get('risk_python_executable',''))
    def risk_model(package):
        model=PrismProcessModel(package,python=risk_runtime(),root=ROOT);risk_workers.append(model);return model
    risk_predictor=RiskPredictionRunner(model_factory=risk_model,availability=lambda:bool(risk_runtime()))
    def risk_description():
        model=describe_risk_model()
        if model.get('artifact_ready') and risk_runtime():
            model.update(ready=True,runtime_ready=True,reason='',execution='isolated_local_python')
        return model

    # Where the operator is looking. The aircraft provider is asked for a window
    # around it; the twin uses the screen itself to decide which satellites are
    # overhead. Reporting works whether or not an aircraft provider is running.
    view_window = ViewWindow(settings["aircraft_bounds"])

    def satellite_view(window=view_window):
        # Reconnecting clients may not have moved their camera yet. Until the
        # first view report, use the configured operating area rather than
        # serializing the entire orbital catalogue at the UAM update cadence.
        return (window.reported_view() or settings['aircraft_bounds']) if library.follow_view("satellite") else None

    from data.ingestion.aircraft_prediction_history import AircraftPredictionHistory
    synchronizer = LiveSynchronizer(load_definitions(), retention_seconds=library.retention(),
                                    prediction_history=AircraftPredictionHistory(),
                                    matcher=SatelliteModelMatcher(available=published_asset_ids()),
                                    view=satellite_view,
                                    # Read each tick, so choosing another model
                                    # or switching estimation off applies at once.
                                    estimation=library.estimation)
    library.subscribe(lambda values: setattr(synchronizer, 'retention_seconds', values['aircraft']['retention_seconds']))
    statuses = {}
    run_log = None
    operational_audit = None

    def audit(kind, **detail):
        if operational_audit is not None:
            # This labels the displayed run context; external provider data is
            # not thereby claimed to describe any simulated sortie.
            if scenario_session is not None:
                detail.setdefault('scenario_id', scenario_session.scenario_id or None)
            return operational_audit.record(kind, **detail)

    if sources is None:
        sources = []
        if settings["celestrak_enabled"]:
            source = CelesTrakSource(settings["celestrak_group"], validator=lambda: guard.validator("celestrak"))
            sources.append(SourceBinding("celestrak", "celestrak_gp", source.fetch, settings["celestrak_poll_seconds"],
                persist=True, supersedes="celestrak_saved", validator=lambda gp=source: gp.last_modified))
        else:
            statuses["celestrak"] = SourceStatus("celestrak", "disabled", message="위성 공급자 비활성")
        credentials = (os.environ.get("AERODT_OPENSKY_CLIENT_ID"), os.environ.get("AERODT_OPENSKY_CLIENT_SECRET"))
        if settings["opensky_enabled"] and all(credentials):
            # The requested area follows the display and fills the provider's
            # cheapest tier without exceeding it, so the daily budget does not
            # depend on where the operator looks. Without a report the configured
            # box is used.
            # The display may steer the window, but only while the operator lets it.
            def aircraft_window(window=view_window):
                return window.current() if (library.follow_view() and window.reported) else library.bounds()
            source = OpenSkySource(*credentials, bounds=aircraft_window)
            sources.append(SourceBinding("opensky", "opensky_states", source.fetch, settings["aircraft_poll_seconds"]))
        else:
            statuses["opensky"] = SourceStatus("opensky", "disabled", message="항공기 공급자 승인 및 인증 설정 필요")
        weather = OpenMeteoSource(lambda: library.bounds())
        sources.append(SourceBinding("open_meteo", "open_meteo_v1", weather.fetch, library.interval("open_meteo") or 900))
        if settings.get("fixture_mode"):
            from user_application.apps.web_dashboard.fixture_source import AircraftFixture
            fixture = AircraftFixture()
            sources.append(SourceBinding("fixture_aircraft", "aircraft_v1", fixture.fetch, 5, provenance="fixture"))
        if settings.get("fixture_satellites"):
            from user_application.apps.web_dashboard.fixture_source import SatelliteFixture
            fixture = SatelliteFixture(count=settings.get('fixture_satellite_count', 24))
            sources.append(SourceBinding("fixture_satellites", "celestrak_gp", fixture.fetch, 7200, provenance="fixture"))
    sources = tuple(sources)
    for source in sources:
        statuses[source.id] = SourceStatus(source.id, "connecting", message="연결 중")

    # One derived wire string per sequence. It has no mutable/authoritative state.
    wire_json = encode_snapshot(world.snapshot(), CAPABILITIES)
    # Stream clients wake on each new wire string instead of polling on a timer.
    updated = asyncio.Event()

    def payload():
        return wire_json

    async def wait_for_change():
        await updated.wait()

    def trajectory(entity_id):
        snapshot = world.snapshot()
        entity = next((item for item in snapshot.entities if item.entity_id == entity_id), None)
        chosen = library.estimation()
        learned_id = chosen.get('uam_prediction_model')
        if (entity is not None and entity.kind=='uam'
                and learned_id in (COMPARISON_ID,*uam_prediction_catalog.MODEL_IDS)):
            if not chosen.get('uam_prediction'):
                return None
            captured = (physical_input.capture(entity) if entity.source == 'physical_uam' else
                        scenario_session.learned_prediction_input(entity_id) if scenario_session else None)
            answer = uam_predictor.predict(
                captured['entity'] if captured else entity, captured['intent'] if captured else None,
                captured['windows'] if captured else {}, epoch=snapshot.epoch,
                context=captured['context'] if captured else None, model_id=learned_id)
            # Discard an in-flight result when its run, target or model was changed.
            latest = library.estimation()
            if (world.snapshot().epoch!=snapshot.epoch
                    or latest.get('uam_prediction_model')!=learned_id or not latest.get('uam_prediction')
                    or (captured and not (physical_input.matches(captured) if entity.source == 'physical_uam'
                                          else scenario_session.prediction_context_matches(captured)))):
                return None
            return answer
        intent = None
        if entity is not None and entity.source == 'physical_uam':
            captured = physical_input.capture(entity)
            if not captured:
                return None
            # A future-only prediction horizon is separate from the two-second
            # navigation validity. This copy never goes back into TwinWorld.
            prediction_seed = replace(entity, valid_until=None)
            path = synchronizer.trajectory(prediction_seed, entity.state_time, intent=captured['intent'])
            if path is not None:
                path['summary']['observation_age_seconds'] = max(0, entity.state_time-entity.observation_time)
                path['note'] = 'Physical 모사 센서 기반 예측 · ' + path.get('note', '')
            return None if path is None else dict(path, epoch=snapshot.epoch)
        if entity is not None and entity.kind == "uam" and scenario_session is not None:
            captured = scenario_session.prediction_input(entity_id)
            if captured is not None:
                entity, intent = captured
        path = None if entity is None else synchronizer.trajectory(entity, entity.state_time, intent=intent)
        return None if path is None else dict(path, epoch=snapshot.epoch)

    def weather_conditions():
        record = records.latest("open_meteo")
        if record is None:
            return {"schema_version": 1, "received_time": None, "observed_time": None, "points": [], "summary": {}}
        return read_conditions(record.payload, record.received_time)

    def catalog():
        path = ROOT / "digital_twin/model_library/visual_assets/catalog.json"
        from digital_twin.model_library.visual_catalog import read_visual_catalog
        return read_visual_catalog(path.parent)

    from user_application.apps.web_dashboard.twinning_test import TwinningTestSession
    twinning_test = TwinningTestSession(catalog, audit=audit)

    async def poll(source):
        failures = 0
        # A stop survives a restart on purpose: the process is not the client,
        # the address is. Only the operator switching the source off and on
        # again says a person has looked.
        paused = False
        schedule = guard if source.provenance != "fixture" else UNGUARDED
        if source.persist:
            try:
                restored = await asyncio.to_thread(records.restore, source.id)
                if restored:
                    statuses[source.id] = SourceStatus(source.id, "stale", restored.received_time, "이전 수집 자료; 갱신 시도 중")
            except (ValueError, OSError, KeyError):
                statuses[source.id] = SourceStatus(source.id, "connecting", message="캐시를 사용할 수 없어 새 자료 요청")
        while True:
            if not library.enabled(source.id):
                if statuses.get(source.id, None) is None or statuses[source.id].status != "paused":
                    statuses[source.id] = SourceStatus(source.id, "paused", message="Library 설정으로 수집 중지")
                paused, failures = True, 0
                await asyncio.sleep(1)
                continue
            if paused:
                # Switched off and on again: the operator has looked, so a stop
                # is cleared and the source may be asked at once.
                await asyncio.to_thread(schedule.resume, source.id)
                paused = False
            delay = library.interval(source.id) or source.interval_seconds
            stopped = await asyncio.to_thread(schedule.stopped, source.id)
            if stopped:
                held = records.latest(source.id)
                statuses[source.id] = SourceStatus(source.id, "stopped", held.received_time if held else None,
                    f"공급자 응답 {stopped} · 자동 재시도 중지 · Library에서 수집을 껐다 켜면 다시 시도합니다")
                await asyncio.sleep(5)
                continue
            # The schedule is shared, so another process, or this one before it
            # was restarted, may already have used the slot.
            if not await asyncio.to_thread(schedule.claim, source.id, delay):
                wait = await asyncio.to_thread(schedule.seconds_until_allowed, source.id)
                current = statuses.get(source.id)
                # Only when this run has nothing better to say. A status from an
                # actual attempt is more use than the clock.
                if current is None or current.status == "connecting":
                    state = await asyncio.to_thread(schedule.state, source.id)
                    held = records.latest(source.id)
                    before = f"이전 실행에서 {int(state['failures'])}회 실패 · " if state.get("failures") else ""
                    statuses[source.id] = SourceStatus(source.id, "waiting",
                        held.received_time if held else None, f"{before}다음 시도까지 {round(wait / 60)}분")
                await asyncio.sleep(min(5, max(1, wait)))
                continue
            correlation = uuid.uuid4().hex
            audit('source_request', correlation_id=correlation, source=source.id,
                  format=source.format, provenance=source.provenance, outcome='request_started')
            try:
                raw = await source.fetch()
                received = time.time()
                await asyncio.to_thread(audit, 'source_received', correlation_id=correlation,
                    source=source.id, format=source.format, provenance=source.provenance,
                    received_time=received, payload=raw, outcome='received')
                # Always register through Data before any Live Twin processing.
                await asyncio.to_thread(records.register, source.id, raw, received, format=source.format,
                    provenance=source.provenance, persist=source.persist)
                audit('source_registered', correlation_id=correlation, source=source.id,
                      outcome='accepted_by_data', format=source.format)
                statuses[source.id] = SourceStatus(source.id, "ready", received,
                    "시험 입력" if source.provenance == "fixture" else "외부 자료 수신")
                failures = 0
                await asyncio.to_thread(schedule.record_success, source.id, delay)
                if source.validator:
                    await asyncio.to_thread(schedule.record_validator, source.id, source.validator())
                if source.supersedes and await asyncio.to_thread(records.discard, source.supersedes):
                    statuses.pop(source.supersedes, None)
            except asyncio.CancelledError:
                audit('source_cancelled', correlation_id=correlation, source=source.id, outcome='cancelled')
                raise
            except NotModified:
                audit('source_unchanged', correlation_id=correlation, source=source.id, outcome='not_modified')
                # The provider answered that our copy is current. That is a
                # success: no payload changes hands and none needs to.
                failures = 0
                await asyncio.to_thread(schedule.record_success, source.id, delay)
                old_record = records.latest(source.id)
                statuses[source.id] = SourceStatus(source.id, "ready",
                    old_record.received_time if old_record else None, "공급자 확인: 변경 없음")
            except Exception as error:
                failures += 1
                code = error.response.status_code if isinstance(error, httpx.HTTPStatusError) else None
                audit('source_error', correlation_id=correlation, source=source.id,
                      outcome='failed', status=code, error_type=type(error).__name__)
                delay = retry_delay_seconds(library.interval(source.id) or source.interval_seconds, failures, code)
                message = f"공급자 HTTP {code}" if code else f"공급자 연결 실패 ({type(error).__name__})"
                stopped = await asyncio.to_thread(schedule.record_failure, source.id, delay, code)
                if stopped:
                    message = f"{message} · 자동 재시도 중지 · Library에서 수집을 껐다 켜면 다시 시도합니다"
                    statuses[source.id] = SourceStatus(source.id, "stopped",
                        records.latest(source.id).received_time if records.latest(source.id) else None, message)
                    LOGGER.warning("Source %s stopped: %s", source.id, message)
                    continue
                message = f"{message} · {failures}회 연속 · {round(delay / 60)}분 뒤 재시도"
                if failures >= 3 and code is None:
                    # Packets going nowhere, not a service answering with an
                    # error: the operator needs to look at the address itself.
                    message += " · 주소 차단 여부 확인 필요"
                old = records.latest(source.id)
                statuses[source.id] = SourceStatus(source.id, "error", old.received_time if old else None, message)
                if run_log:
                    await asyncio.to_thread(run_log.log, 'source_error', message, level='warning', data={'source': source.id})
                LOGGER.warning("Source %s: %s", source.id, message)
            await asyncio.sleep(delay)

    # Assigned once the vertiports and the route network exist, below. The loop
    # above reads it every tick, so a day loaded later is picked up without a
    # restart, and no day at all leaves the live clock alone.
    scenario_session = None
    from user_application.apps.web_dashboard.domains.uam.input.physical_input import PhysicalInput
    from data.settings.physical_source import PhysicalSourceSettings
    from data.settings.uam_alignment import UamAlignmentSettings
    physical_input = PhysicalInput(settings.get('physical_uam_url', '') if include_physical else '',
        source_store=PhysicalSourceSettings(workspace_directory / 'settings/physical_uam.json') if include_physical else None,
        alignment_store=UamAlignmentSettings(workspace_directory / 'settings/uam_alignment.json'),world_snapshot=world.snapshot,
        enabled=lambda: library.values.get('uam', {}).get('enabled', True),
        simulation_showing=lambda: bool(scenario_session and scenario_session.showing), statuses=statuses)
    # Which clock the twin is currently on. A change between the two is what
    # makes the next snapshot a new epoch.
    clock_source = 'live'
    background_synced_at = -float('inf')

    async def update_once():
        """One tick of the twin: move the clock, synchronise, put it on the wire."""
        nonlocal wire_json, clock_source, background_synced_at
        # A scheduled day, when one is being flown, owns the twin's clock: the
        # sky drawn over it is the sky of the day in question, and the aircraft
        # on it are the day's rather than the ones outside the window now. The
        # live feeds keep arriving and keep being stored; they are simply not
        # what is shown while the day runs.
        #
        # Whatever the day does, it must not be able to stop the twin. A
        # scenario that throws is reported as a source failure and dropped for
        # this tick, and the live world goes on being served.
        scenario = scenario_session
        scenario_time = None
        scenario_entities, scenario_rate = (), 1.0
        if scenario is not None:
            try:
                scenario_time, scenario_entities, scenario_rate = await asyncio.to_thread(scenario.advance_view)
                statuses.pop('scenario', None)
            except Exception as error:
                statuses['scenario'] = SourceStatus('scenario', 'error',
                    message=f"비행계획 재생 오류 ({type(error).__name__})")
                LOGGER.exception("Scenario tick failed: %s", type(error).__name__)
        # The live clock never runs backwards, but a scheduled day may be any
        # date at all. Going to that date and coming back are both deliberate, so
        # they change the twin's epoch rather than being clamped into the live
        # run — clamping would pin the twin to the day it replayed.
        source = 'scenario' if scenario_time is not None else 'live'
        rebased = source != clock_source or (scenario_time is not None and scenario_time < world.snapshot().state_time)
        clock_source = source
        if scenario_time is not None:
            target = scenario_time
        else:
            target = max(time.time(), 0.0 if rebased else world.snapshot().state_time)
        try:
            if scenario_time is not None:
                # The sky is put away while a day is flown. Sixteen thousand
                # orbits propagated every tick is the single most expensive
                # thing in this process and it shares the interpreter with the
                # day's aircraft, so it is not merely hidden on the map — it is
                # not computed, not encoded and not sent. Nobody replaying a UAM
                # morning is reading satellites, and the aircraft are what the
                # rehearsal is about.
                #
                # Live aircraft go for a different reason: estimating one across
                # a jump of days is not a thing to hand the estimator, and the
                # day supplies its own aircraft.
                entities = scenario_entities
            else:
                previous = tuple(entity for entity in world.snapshot().entities if entity.source not in ('scenario', 'physical_uam'))
                # Flight publishing is 10 Hz; orbital/background estimation need
                # not become ten times more expensive. Reuse the World
                # observations (with their original sample times), not a second
                # mutable state cache.
                if rebased or time.monotonic()-background_synced_at >= max(.5, tick):
                    entities = await asyncio.to_thread(synchronizer.synchronize, records.records(), target, previous=previous)
                    background_synced_at = time.monotonic()
                else:
                    entities = previous
                entities = tuple(entity for entity in entities if entity.source not in ('scenario', 'physical_uam'))
                # Background propagation may have yielded while new telemetry
                # arrived. Align UAMs to now, not to the time before that work.
                target = max(target, time.time())
                entities += physical_input.entities(target, world.snapshot().entities)
            statuses.pop('synchronization', None)
            commit = world.rebase if rebased else world.replace
            snapshot = commit(prepare(entities), target, tuple(statuses.values()))
        except Exception as error:
            # Keep the last valid world visible but expose failure, never silently die.
            statuses["synchronization"] = SourceStatus("synchronization", "error", message=f"동기화 실패 ({type(error).__name__})")
            # A failed tick keeps showing what was last true, not an empty
            # map: the day's aircraft while a day is being flown, the live world
            # otherwise. Either way the sky stays put away during a day.
            replaying = scenario_time is not None
            held = (lambda item: (item.source == 'scenario') == replaying)
            entities = tuple(replace(entity, quality='stale')
                             for entity in world.snapshot().entities if held(entity))
            snapshot = world.rebase(entities, target, tuple(statuses.values()))
            LOGGER.error("Synchronization failed: %s", type(error).__name__)
        try:
            risk_predictor.observe(snapshot)
        except (ValueError,TypeError,AttributeError,RuntimeError):
            # Display inference must not stop authoritative flight publication.
            LOGGER.warning('Risk observation input rejected; world publication continues')
        wire_json = await asyncio.to_thread(encode_snapshot, snapshot, CAPABILITIES,
                                          scenario_rate if scenario_time is not None else None)
        updated.set()
        updated.clear()

    async def update():
        """The twin's heartbeat. Nothing above this restarts it.

        Everything downstream — the socket, the snapshot endpoint, the map —
        reads what this loop last wrote, so a tick that raises must not end it.
        Before this was guarded, one bad tick left the wire frozen on its last
        good snapshot with nothing anywhere saying why, which looks exactly like
        a twin that is simply very calm.
        """
        while True:
            started = time.monotonic()
            try:
                await update_once()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                LOGGER.exception("Twin update failed, continuing: %s", type(error).__name__)
                statuses["twin_update"] = SourceStatus("twin_update", "error",
                    message=f"트윈 갱신 오류 ({type(error).__name__})")
            else:
                statuses.pop("twin_update", None)
            cadence = min(tick, .1) if physical_input.active or (scenario_session is not None and scenario_session.showing) else tick
            await asyncio.sleep(max(.005, cadence - (time.monotonic() - started)))

    @asynccontextmanager
    async def lifespan(app):
        nonlocal wire_json, run_log, operational_audit
        workspace = Path(settings.get('workspace_directory') or ROOT / 'data/workspace')
        run_log = await asyncio.to_thread(RunLogger, workspace, 'web_dashboard',
            {'sources': [source.id for source in sources], 'fixture': any(source.provenance == 'fixture' for source in sources)})
        operational_audit = await asyncio.to_thread(AuditJournal, run_log.run_dir)
        await asyncio.to_thread(run_log.log, 'started', 'Web Live Twin started; source status is authoritative')
        if settings.get('saved_satellites'):
            from data.ingestion.saved_gp import load_saved_gp
            saved = await asyncio.to_thread(load_saved_gp, settings['saved_satellites'])
            records.register(saved.source, saved.payload, saved.received_time,
                             format=saved.format, provenance=saved.provenance)
            from datetime import datetime, timezone
            collected = datetime.fromtimestamp(saved.received_time, timezone.utc).isoformat()
            statuses[saved.source] = SourceStatus(saved.source, 'cached', saved.received_time,
                f'저장 궤도 기반 계산 · 수집 {collected} · API 요청 중지')
        world.replace((), time.time(), tuple(statuses.values()))
        wire_json = encode_snapshot(world.snapshot(), CAPABILITIES)
        jobs = [asyncio.create_task(poll(source)) for source in sources]
        jobs.append(asyncio.create_task(update()))
        jobs.append(asyncio.create_task(physical_input.run()))
        jobs.append(asyncio.create_task(physical_operations.run()))
        try:
            yield
        finally:
            await twinning_test.stop()
            for job in jobs:
                job.cancel()
            await asyncio.gather(*jobs, return_exceptions=True)
            for model in risk_workers:await asyncio.to_thread(model.close)
            await asyncio.to_thread(camera_detector.close)
            await asyncio.gather(*(endpoint.aclose() for endpoint in cesium_endpoints))
            if scenario_session is not None:
                scenario_session.close()
            if local_dem is not None:
                local_dem.close()
            await asyncio.to_thread(operational_audit.close)
            await asyncio.to_thread(run_log.log, 'audit_closed', 'Operational I/O journal closed', data=operational_audit.health())
            await asyncio.to_thread(run_log.finish, 'stopped')

    app = FastAPI(title="AeroDT Live Twin", lifespan=lifespan)
    from communication.web.domains.uam.camera_detection_routes import create_camera_detection_router
    app.include_router(create_camera_detection_router(camera_detector.predict, camera_detector.describe, camera_detector.release))
    app.state.camera_detector = camera_detector
    from communication.web.domains.uam.twinning_test_routes import create_twinning_test_router
    app.include_router(create_twinning_test_router(twinning_test))
    app.state.twinning_test = twinning_test
    app.add_middleware(TileAwareGZipMiddleware)
    from communication.web.domains.uam.audit_routes import OperationalAuditMiddleware, create_audit_router
    app.add_middleware(OperationalAuditMiddleware, audit=audit)
    app.include_router(create_audit_router(lambda: operational_audit, AuditRecords(workspace_directory / 'logs/runs')))
    app.state.ingestion = records
    app.state.world = world
    app.state.physical_input = physical_input
    from communication.web.domains.uam.physical_uam_routes import create_physical_uam_router
    app.include_router(create_physical_uam_router(physical_input))
    app.include_router(create_router(payload, catalog, min(settings["stream_seconds"], .1), wait_for_change, trajectory,
        report_view=view_window.report, audit=audit))

    from communication.web.building_routes import create_building_router
    from communication.external.cesium_buildings import BuildingEndpoint
    from communication.web.terrain_routes import create_terrain_router
    from communication.external.cesium_terrain import TerrainEndpoint
    from data.terrain.local_dem import LocalDem
    from digital_twin.visualization.local_terrain import LocalTerrainTiles
    from communication.web.local_terrain_routes import create_local_terrain_router
    local_dem = None
    local_package = Path(settings.get("local_dem_directory") or workspace_directory / "terrain/user_dem")
    try:
        local_dem = LocalDem(local_package)
    except (OSError, ValueError, KeyError, TypeError):
        pass  # Optional package: never fail the global dashboard or expose a local path.
    local_tiles = LocalTerrainTiles(local_dem) if local_dem else None
    app.include_router(create_local_terrain_router(local_tiles))
    cesium_endpoints = []
    token = os.environ.get('AERODT_CESIUM_ION_TOKEN')
    for enabled, adapter, router in (
            (settings.get('buildings_enabled'), BuildingEndpoint, create_building_router),
            (settings.get('terrain_enabled', settings.get('buildings_enabled')), TerrainEndpoint, create_terrain_router)):
        endpoint = adapter(token) if enabled and token else None
        if endpoint is not None:
            cesium_endpoints.append(endpoint)
        app.include_router(router(endpoint.fetch if endpoint else None))

    # V-World relays national imagery tiles and building cells with the key kept here.
    from communication.web.vworld_routes import create_vworld_router
    from communication.external.vworld import VWorldClient
    from data.ingestion.vworld_tiles import VWorldTileRecords
    vworld_tile_records = VWorldTileRecords(workspace_directory / 'cache/vworld_3d')
    vworld_key = os.environ.get('AERODT_VWORLD_API_KEY')
    vworld = VWorldClient(vworld_key, settings.get('vworld_domain') or f"http://{settings['host']}:{settings['port']}", tile_records=vworld_tile_records) \
        if settings.get('vworld_enabled') and vworld_key else None
    if vworld is not None:
        cesium_endpoints.append(vworld)
    # Public textured tiles have no key parameter. This does NOT enable WMTS,
    # footprints or airspace without their own configured credential.
    vworld_tiles = vworld or VWorldClient(None, "", public_tiles_only=True, tile_records=vworld_tile_records)
    if vworld is None:
        cesium_endpoints.append(vworld_tiles)
    app.include_router(create_vworld_router(vworld, tiles_client=vworld_tiles))

    from communication.web.weather_routes import create_weather_router
    app.include_router(create_weather_router(weather_conditions))

    # The data library: what the operator decided about each source, and what
    # each source is doing right now. Storage is Data's, policy is applied live.
    from communication.web.library_routes import create_library_router

    class Library:
        # Which runtime status speaks for each library source, in order of preference.
        REPORTERS = {"aircraft": ("opensky", "fixture_aircraft"), "satellite": ("celestrak", "celestrak_saved", "fixture_satellites"),
                     "weather": ("open_meteo",), "uam": ("physical_uam",)}

        def state(self):
            reported = []
            for source in describe_library()["sources"]:
                # Whatever is actually feeding the display speaks for the source:
                # with live requests off, the saved orbits are the honest answer.
                present = [statuses[key] for key in self.REPORTERS.get(source["id"], ()) if key in statuses]
                status = next((item for item in present if item.status not in ("paused", "disabled")),
                              present[0] if present else None)
                if status is not None:
                    reported.append({"id": source["id"], "status": status.status, "message": status.message,
                                     "updated_at": status.updated_at})
                elif source["id"] == "clouds":
                    # Imagery is drawn by the browser, so the honest state is what was chosen.
                    on = bool(library.values.get("clouds", {}).get("enabled"))
                    reported.append({"id": "clouds", "status": "ready" if on else "disabled",
                                     "message": "지도에 표시 중" if on else "표시 꺼짐", "updated_at": None})
                elif source["id"] == "state_estimation":
                    # The estimator is not fed by a provider: what it is doing is
                    # the model it is running.
                    chosen = library.estimation()
                    model = synchronizer.aircraft_model(chosen)
                    reported.append({"id": source["id"],
                                     "status": "ready" if chosen["enabled"] else "disabled",
                                     "message": (f"{model.get('label', model['model_id'])} 적용 중"
                                                 if chosen["enabled"] else "관측값 그대로 표시 (추정 꺼짐)"),
                                     "updated_at": None})
                elif source["id"] == "trajectory_prediction":
                    chosen = library.estimation()
                    drawing = synchronizer.prediction_model(chosen)
                    if not chosen["prediction"]:
                        status, message = "disabled", "표시 꺼짐"
                    elif not chosen["enabled"]:
                        status, message = "disabled", "상태 추정이 꺼져 있어 그릴 것이 없습니다"
                    elif drawing is None:
                        picked = ai_models.find(chosen["prediction_model"]) or {}
                        status = "unavailable"
                        message = (f"{picked.get('label', chosen['prediction_model'])}: "
                                   f"{picked.get('requires', '조건 미상')}가 필요해 공급자 항공기에는 적용되지 않습니다")
                    else:
                        status = "ready"
                        message = f"{drawing.get('label', drawing['model_id'])} · {int(chosen['prediction_seconds'])}초"
                        if drawing['model_id'] == 'gru_direct_v1_1':
                            message = ('보정 입력 기반 GRU · 최대 15초 · 첫 관측 이후 3초 필요 · '
                                       '관측 경과 45초 이상 중단 · 보정 입력 정확도 미검증')
                    reported.append({"id": source["id"], "status": status, "message": message, "updated_at": None})
                elif source["id"] == "uam_prediction":
                    # A UAM's prediction does not depend on the estimator: the
                    # twin is flying it, so there is always a state to project.
                    # What it does depend on is a model that can run here.
                    chosen = library.estimation()
                    drawing = synchronizer.uam_prediction_model(chosen)
                    if not chosen.get("uam_prediction"):
                        status, message = "disabled", "표시 꺼짐"
                    elif drawing is None:
                        picked = ai_models.find(chosen.get("uam_prediction_model")) or {}
                        status = "ready" if picked.get('ready') else "unavailable"
                        message = (f"{picked.get('label', chosen.get('uam_prediction_model'))}: "
                                   f"{('선택 기체의 입력 이력 준비 후 계산' if picked.get('ready') else picked.get('reason') or picked.get('requires', '조건 미상'))}")
                    else:
                        status = "ready"
                        message = (f"{drawing.get('label', drawing['model_id'])} · "
                                   f"{int(chosen.get('uam_prediction_seconds', 60))}초")
                    reported.append({"id": source["id"], "status": status, "message": message, "updated_at": None})
                elif source["id"] == "risk_prediction":
                    model=risk_description();enabled=library.values['risk_prediction']['enabled']
                    reported.append({'id':'risk_prediction','status':('ready' if model['ready'] else 'unavailable') if enabled else 'disabled',
                        'message':('선택 기체 주변만 계산 · 2D 연구용 / 충돌 확률 아님' if model['ready'] else model['reason']) if enabled else 'AI 위험 예측 꺼짐', 'updated_at':None})
                elif source["id"] in ("terrain", "buildings", "imagery"):
                    # Which provider is chosen decides which credential has to be there.
                    chosen = library.values.get(source["id"], {}).get("provider", "")
                    if source["id"] == "imagery":
                        configured = vworld is not None or not chosen.startswith("vworld")
                        message = "지도에 표시 중" if configured else "브이월드 인증 설정 필요 (vworld.json)"
                    elif source["id"] == "terrain" and chosen == "local_dem":
                        configured = local_tiles is not None
                        message = "로컬 DEM 준비됨 · 범위 밖 Cesium (별도 인증 필요)" if configured else "로컬 DEM 없음 · Cesium으로 대체"
                    elif source["id"] == "buildings" and chosen == "vworld_3d":
                        configured = True
                        message = "공개 정밀 3D 타일 사용 가능 (지역별 구축 범위 상이)"
                    elif source["id"] == "buildings" and chosen == "vworld_hybrid":
                        configured = vworld is not None
                        message = ("근거리 공개 실사 3D · 원거리 단순 건물 사용 가능 (실사 구축 범위 상이)"
                                   if configured else
                                   "근거리 공개 실사 3D 사용 가능 · 원거리 단순 건물은 브이월드 인증 설정 필요 (vworld.json)")
                    elif source["id"] == "buildings" and chosen == "vworld":
                        configured = vworld is not None
                        message = "브이월드 연결됨" if configured else "브이월드 인증 설정 필요 (vworld.json)"
                    else:
                        configured = bool(os.environ.get("AERODT_CESIUM_ION_TOKEN")) and bool(settings.get("buildings_enabled"))
                        message = "공급자 연결됨" if configured else "인증 설정 필요"
                    reported.append({"id": source["id"], "status": "ready" if configured else "unavailable",
                                     "message": message, "updated_at": None})
                else:
                    reported.append({"id": source["id"], "status": "pending", "message": "연동 준비 중", "updated_at": None})
            return reported

        def describe(self):
            result={**describe_library(library.values), "state": self.state()}
            result['ai_models']['models']=[risk_description() if model['model_id']=='prism_2d_v1' else model for model in result['ai_models']['models']]
            return result

        def apply(self, body):
            with library_write_lock:
                settled = validate_settings(body, base={"sources": library.values})
                settings_store.write(settled)
                library.apply(settled)
            return self.describe()

    app.include_router(create_library_router(Library()))
    from communication.web.domains.uam.risk_routes import create_risk_router
    def write_risk_settings(patch):
        if set(patch)-set(library.values['risk_prediction']):raise ValueError('알 수 없는 위험 예측 설정입니다.')
        with library_write_lock:
            settled=validate_settings({'sources':{'risk_prediction':patch}},base={'sources':library.values})
            settings_store.write(settled);library.apply(settled)
        return library.values['risk_prediction']
    app.state.risk_predictor=risk_predictor
    # Objects a viewer's camera detector has placed in the world. They are not
    # the twin's state; they are listed beside it for the risk picture, and
    # each report is a sighting in the predictor's history with its own error.
    from data.simulation.perceived_objects import PerceivedObjects
    from communication.web.domains.uam.perception_routes import create_perception_router
    perceived=PerceivedObjects()
    def report_perception(body):
        kept=perceived.report(body)
        history=risk_predictor.history
        for item in kept:
            history.observe_perceived(item['entity_id'],item['state_time'],item['position_ecef_m'],item['sigma_m'],
                epoch=history.epoch,context=(item['continuity_id'],'perception','camera_ai',None))
        return kept
    app.include_router(create_perception_router(report_perception,perceived.current))
    app.state.perceived_objects=perceived
    def risk_picture():
        snapshot=world.snapshot()
        extra=[e for e in perceived.entities() if e.entity_id not in {x.entity_id for x in snapshot.entities}]
        return replace(snapshot,entities=(*snapshot.entities,*extra)) if extra else snapshot
    app.include_router(create_risk_router(
        lambda entity_id,**options:risk_predictor.predict(risk_picture(),entity_id,**options),
        lambda:library.values['risk_prediction'],write_risk_settings,risk_description,
        predict_injected=lambda entity_id,body,**options:risk_predictor.predict_injected(risk_picture(),entity_id,body,**options)))

    # Simulation assets: user-authored vertiports. Data owns the file, the model
    # library validates and compiles the layout, the wire only relays results.
    from communication.web.domains.uam.simulation_routes import create_simulation_router
    from data.simulation.vertiport_records import VertiportRecords
    from digital_twin.model_library.vertiport_layout import describe_options, generate_layout, validate_definition
    vertiport_records = VertiportRecords(
        Path(settings.get('workspace_directory') or ROOT / 'data/workspace') / 'simulation/vertiports.json')

    class Vertiports:
        @staticmethod
        def wire(record):
            # Saved definitions may predate later fields; validation fills the defaults.
            definition = validate_definition(record)
            return dict(definition, layout=generate_layout(definition))

        def list(self):
            return [self.wire(record) for record in vertiport_records.list()]

        def get(self, identifier):
            record = vertiport_records.get(identifier)
            return None if record is None else self.wire(record)

        def edit(self, operation):
            session = getattr(app.state, "scenario_session", None)
            return session.edit_infrastructure(operation) if session else operation()

        def create(self, body):
            return self.edit(lambda: self.wire(vertiport_records.create(validate_definition(body))))

        def update(self, identifier, body):
            definition = validate_definition(body)
            record = self.edit(lambda: vertiport_records.update(identifier, definition))
            return None if record is None else self.wire(record)

        def delete(self, identifier):
            return self.edit(lambda: vertiport_records.delete(identifier))

        def preview(self, body):
            return generate_layout(validate_definition(body))

        @staticmethod
        def options():
            # The groups already in use, so a form can offer them instead of
            # asking everyone to spell 수도권 the same way twice. The module
            # describing the options is pure; only the store knows these.
            used = sorted({str(record.get('group') or '').strip()
                           for record in vertiport_records.list()} - {''})
            return {**describe_options(), 'groups': used}

    def vertiport_edit_state():
        session = getattr(app.state, "scenario_session", None)
        state = session.status().get("state", "idle") if session else "idle"
        locked = state in ("playing", "paused")
        return {"locked": locked, "state": state, "message":
                "시뮬레이션 진행 중에는 이착륙 높이를 변경할 수 없습니다. 시뮬레이션을 종료한 뒤 수정해 주세요." if locked else ""}

    app.include_router(create_simulation_router(Vertiports(), edit_state=vertiport_edit_state))

    # The demand setup's starting point: how much of a day belongs to each deck,
    # from the travel-demand shares we were given. Read-only; what the operator
    # changes rides in the request the panel builds.
    from communication.web.domains.uam.demand_routes import create_demand_router
    app.include_router(create_demand_router(Vertiports().list))

    # Routes: waypoints and segment links between them and the vertiports'
    # FATOs. Data owns the file, the model library validates and derives the
    # FATO endpoints from the vertiport layouts, a locality name comes from
    # OpenStreetMap when a waypoint is left unnamed.
    from communication.external.place_names import PlaceNameLookup
    from communication.web.domains.uam.simulation_routes import create_revision_router, create_route_router
    from data.simulation.route_records import RouteRecords
    from digital_twin.model_library import route_network
    route_records = RouteRecords(
        Path(settings.get('workspace_directory') or ROOT / 'data/workspace') / 'simulation/routes.json')
    vertiports = Vertiports()

    class Routes:
        @staticmethod
        def endpoints():
            nodes = {node["id"]: node for node in route_records.nodes()}
            fatos = {fato["id"]: fato for fato in route_network.fato_endpoints(vertiports.list())}
            return nodes, fatos

        def network(self):
            return route_network.network(route_records.nodes(), route_records.links(), vertiports.list())

        @staticmethod
        def options():
            return route_network.describe_options()

        def create_node(self, body):
            names = [node["name"] for node in route_records.nodes()]
            return route_records.create_node(route_network.validate_node(body, names))

        def update_node(self, identifier, body):
            names = [node["name"] for node in route_records.nodes() if node["id"] != identifier]
            return route_records.update_node(identifier, route_network.validate_node(body, names))

        def delete_node(self, identifier):
            return route_records.delete_node(identifier)

        def create_link(self, body):
            nodes, fatos = self.endpoints()
            return route_records.create_link(route_network.validate_link(body, nodes, fatos, route_records.links()))

        def update_link(self, identifier, body):
            nodes, fatos = self.endpoints()
            definition = route_network.validate_link(dict(body, id=identifier), nodes, fatos, route_records.links())
            return route_records.update_link(identifier, definition)

        def delete_link(self, identifier):
            return route_records.delete_link(identifier)

    place_lookup = PlaceNameLookup() if settings.get("place_names_enabled", True) else None

    # Where a route meets the buildings under it: the V-World footprints of the
    # cells the link crosses, measured against the eased height profile. The
    # display sends the terrain heights along each link; the cells come from the
    # relay's own cache, a few at a time.
    from digital_twin.model_library import route_conflicts

    async def check_conflicts(body):
        links = route_conflicts.validate_request(body)
        # The ground the display has given to vertiport decks. A building a deck
        # stands on is not drawn and is not measured; the map and this check
        # then answer the same question about the same city.
        cleared = route_conflicts.validate_cleared(body)
        wanted = {cell for link in links for cell in route_conflicts.cells_for_link(link)}
        gate = asyncio.Semaphore(6)

        async def fetch(cell):
            async with gate:
                return cell, await vworld.buildings(*cell)

        cells = dict(await asyncio.gather(*(fetch(cell) for cell in sorted(wanted))))
        report = {}
        for link in links:
            buildings = [building for cell in route_conflicts.cells_for_link(link)
                         for building in (cells.get(cell) or {}).get("buildings", [])]
            report[link["id"]] = await asyncio.to_thread(route_conflicts.check_link, link, buildings, 0.01, cleared)
        return {"links": report, "cells": len(wanted), "cleared": len(cleared),
                "tight_clearance_m": route_conflicts.TIGHT_CLEARANCE_M}

    app.include_router(create_route_router(Routes(), place_lookup.lookup if place_lookup else None,
                                           check_conflicts if vworld is not None else None))

    # One short answer for every screen that has this open: a hash over the
    # stored simulation records. It changes on any create, edit or delete, so a
    # second browser can notice the file moved without fetching the whole lot.
    def simulation_revision():
        records = vertiport_records.list()
        nodes, links = route_records.nodes(), route_records.links()
        stamp = hashlib.sha1()
        for group in (records, nodes, links):
            for record in group:
                stamp.update(json.dumps(record, sort_keys=True, ensure_ascii=False).encode("utf-8"))
            stamp.update(b"|")
        return {"revision": stamp.hexdigest()[:16], "vertiports": len(records),
                "nodes": len(nodes), "links": len(links)}

    app.include_router(create_revision_router(simulation_revision))

    # Airspace: prohibited, restricted and danger areas and the rest of the
    # national aeronautical map, fetched once a day and kept in the workspace.
    # Without a credential the map is told so and shows nothing.
    from communication.external.airspace import AirspaceSource
    from communication.web.domains.uam.airspace_routes import create_airspace_router
    # The V-World key (vworld.json) serves the 항공정보도 layers directly; a
    # 공공데이터포털 key (datago.json) needs the dataset's own WFS url in the config.
    airspace_config = dict(settings.get('airspace') or {})
    if not airspace_config.get('provider'):
        airspace_config['provider'] = 'vworld' if os.environ.get('AERODT_VWORLD_API_KEY') else 'wfs'
    airspace_key = os.environ.get('AERODT_VWORLD_API_KEY') if airspace_config['provider'] == 'vworld' else os.environ.get('AERODT_DATAGO_SERVICE_KEY')
    airspace = None
    if settings.get('airspace_enabled', True) and airspace_key and (airspace_config['provider'] == 'vworld' or airspace_config.get('url')):
        airspace = AirspaceSource(airspace_config, airspace_key,
                                  Path(settings.get('workspace_directory') or ROOT / 'data/workspace') / 'airspace',
                                  domain=settings.get('vworld_domain') or 'localhost')
    app.state.airspace = airspace
    app.include_router(create_airspace_router(airspace))

    # Flight plans: one whole flight derived from the vertiports and the route
    # network — taxi out, lift off, fly the corridor, land, taxi in, charge.
    # Composition only: planning does not run physics; execution consumes a
    # stored plan snapshot, even if the editor/network subsequently changes.
    from communication.web.domains.uam.plan_routes import create_plan_router
    from communication.web.domains.uam.run_routes import create_run_router
    from data.simulation.flight_plans import FlightPlans
    from data.simulation.flight_runs import FlightRuns
    from user_application.uam_mission.flight_planning import FlightPlanning
    from user_application.uam_mission.flight_execution import FlightExecution

    simulation_directory = Path(settings.get('workspace_directory') or ROOT / 'data/workspace') / 'simulation'
    flight_runs = FlightRuns(simulation_directory / 'runs')
    # How fast a UAM is flown, as the pilot sets it. One profile for the whole
    # dashboard: two flights drawn side by side at different speeds would be two
    # different days on the same map. Where a flight goes and how high is not
    # here — the route network decides that and the aircraft follows it.
    from communication.web.domains.uam.operating_profile_routes import create_operating_profile_router
    from data.settings.operating_profile_settings import OperatingProfileSettings
    operating_profile = OperatingProfileSettings(simulation_directory / 'operating_profile.json')
    app.state.operating_profile = operating_profile
    app.include_router(create_operating_profile_router(operating_profile))

    planning = FlightPlanning(vertiports=vertiports.list, network=Routes().network,
                              plans=FlightPlans(simulation_directory / 'plans'),
                              profile=operating_profile.read)
    execution = FlightExecution(planning=planning, runs=flight_runs, root=ROOT,
                                engine=str(settings.get('flight_engine') or 'auto').strip().lower())
    app.state.flight_runs = flight_runs
    app.state.flight_planning = planning
    app.state.flight_execution = execution
    app.include_router(create_plan_router(planning))
    from communication.web.domains.uam.manual_routes import create_manual_router
    from data.simulation.manual_prediction_history import ManualPredictionHistory
    manual_prediction_history = ManualPredictionHistory()
    # The day is built further down, so it is reached through app.state rather
    # than passed: a manual session may be one airframe of it, and every pose
    # that session produces goes back into the day the rest of the fleet reads.
    # One globe, one clock, one fleet: a whole day and a single flight cannot
    # both be driving them, so whoever has the twin holds it here.
    from user_application.uam_mission.twin_custody import TwinCustody
    twin_custody_holder = app.state.twin_custody = TwinCustody()
    app.include_router(create_manual_router(planning, ROOT / 'data/workspace', manual_prediction_history,
                                            scenario=lambda: getattr(app.state, 'scenario_session', None),
                                            custody=twin_custody_holder))
    from user_application.uam_mission.replay_prediction import ReplayPrediction
    replay_prediction = ReplayPrediction(flight_runs, uam_predictor, library.estimation, synchronizer.trajectory, manual_prediction_history)
    app.include_router(create_run_router(execution, replay_prediction))

    # A whole scheduled day: a flight-plan file loaded, set out on the decks and
    # flown forward on a clock the operator drives. It reads the same vertiports
    # and route network the single-flight planner does, and the elevation
    # package when the workspace has one, so a corridor above the ground is
    # above this ground.
    from communication.web.domains.uam.scenario_routes import create_scenario_router
    from communication.web.domains.uam.decision_routes import create_decision_router
    from data.settings.decision_settings import DecisionSettings
    from user_application.uam_mission.scenario_session import ScenarioSession
    scenario_routes = Routes()
    # The decision charts' numbers. One file, beside the source settings: what
    # the operator changed survives a restart, and clearing it goes back to the
    # values the code was written with.
    decision_store = DecisionSettings(workspace_directory / "settings/decisions.json")
    from communication.python.native_pilot import NativePilotLibrary
    from user_application.uam_mission.scenario_pilots import ScenarioPilots

    def scenario_pilots(policy=None):
        try:
            return ScenarioPilots(NativePilotLibrary(), workers=settings.get('scenario_physics_workers'),
                                  policy=(policy or {}).get('pilot'))
        except (RuntimeError, OSError) as error:
            raise ValueError(str(error)) from error

    scenario_session = ScenarioSession(pilots_factory=scenario_pilots, provisional_names=("지점 20",),
        policy=lambda: decision_store.read(),
        vertiports=vertiports.list, network=scenario_routes.network,
        elevation=(local_dem.sample if local_dem else None),
        profile=operating_profile.read,
        directory=simulation_directory / 'scenarios', log_workspace=workspace_directory,
        custody=twin_custody_holder)
    app.state.scenario_session = scenario_session
    from communication.web.domains.uam.analysis_routes import create_analysis_router
    from data.simulation.operations_records import OperationsRecords
    from user_application.apps.web_dashboard.domains.uam.operations.physical_operations import PhysicalOperations
    from user_application.apps.web_dashboard.operating_context import OperatingContext,OperatingReports
    from communication.web.domains.uam.operating_context_routes import create_operating_context_router
    physical_operations=PhysicalOperations(physical_input,workspace_directory/'physical_uam/operations')
    operating_context=OperatingContext(scenario_session,physical_operations,vertiports.list,scenario_routes.network,simulation_revision,decision_store,operating_profile)
    app.state.physical_operations=physical_operations;app.state.operating_context=operating_context
    physical_input.operation_status=operating_context.status
    app.state.operations_reports = OperatingReports(operating_context,OperationsRecords(simulation_directory / 'scenarios'),OperationsRecords(workspace_directory/'physical_uam/operations'))
    app.include_router(create_operating_context_router(operating_context))
    app.include_router(create_analysis_router(app.state.operations_reports))
    def load_example_scenario():
        source = simulation_directory / "examples" / "fpl_all.csv"
        if not source.is_file():
            raise ValueError("예시 비행계획 FPL_all.csv 파일이 없습니다")
        return scenario_session.load(source.read_bytes(), name="예시 비행계획 · FPL_all.csv")

    app.include_router(create_scenario_router(scenario_session, load_example=load_example_scenario))

    def decisions_apply_to():
        # A day already loaded is flying the rules it was loaded with. Saying
        # which is on screen is the difference between a control and a lie.
        return "다음 재생" if scenario_session.engine is not None else "지금부터"

    app.include_router(create_decision_router(decision_store, on_change=decisions_apply_to))

    # The day the operator asks for rather than one somebody else wrote: the
    # multi-flight setup becomes a schedule here and is loaded straight into the
    # session above, so pressing 생성 요청 ends with the day on the map. It runs
    # on its own thread and reports how far along it is, because building a day
    # takes longer than a request may wait.
    from communication.web.domains.uam.plan_generation_routes import create_plan_generation_router
    from user_application.uam_mission.plan_generation import PlanGenerator

    def apply_generated_plan(text, summary, *, on_progress=None):
        name = f"생성된 비행계획 · {summary.get('flights', 0)}편"
        return scenario_session.load(text.encode('utf-8'), name=name, on_progress=on_progress)

    plan_generator = PlanGenerator(vertiports=vertiports.list, network=scenario_routes.network,
                                   profile=operating_profile.read, apply=apply_generated_plan)
    app.state.plan_generator = plan_generator
    app.include_router(create_plan_generation_router(plan_generator))

    # Shared human rehearsal only. Live World snapshots remain authoritative;
    # this room owns presence/requests, never a second copy of vehicle state.
    from communication.web.domains.uam.operations_routes import create_operations_router
    from user_application.apps.web_dashboard.domains.uam.operations.operations_rehearsal import OperationsRehearsal
    app.state.operations_rehearsal = OperationsRehearsal(vertiports.list, audit=audit)
    app.include_router(create_operations_router(app.state.operations_rehearsal))

    # Downloads: the design work in this workspace as files, saved by whichever
    # computer asked for them. The exports read the same live sources the API
    # serves, so a download is never of a stale copy.
    from communication.web.domains.uam.export_routes import create_export_router
    from user_application.apps.web_dashboard.exports import Exports
    routes_for_export = Routes()
    exports = Exports(vertiports=vertiports.list, routes=routes_for_export.network,
                      route_options=routes_for_export.options, vertiport_options=Vertiports.options,
                      airspace=(lambda: airspace.collection) if airspace else None,
                      flight_runs=flight_runs, scenario=scenario_session)
    app.include_router(create_export_router(exports))

    @app.get("/", include_in_schema=False)
    async def index():
        return FileResponse(ROOT / "user_application/web/index.html")

    for route, directory in (("/static", "user_application/web"),
            ("/visualization", "digital_twin/visualization/web"),
            ("/communication", "communication/browser"),
            ("/visual-assets", "digital_twin/model_library/visual_assets")):
        files = BufferedModelFiles if route == '/visual-assets' else RevalidatedStaticFiles
        app.mount(route, files(directory=ROOT / directory, check_dir=False), name=route[1:])
    return app
