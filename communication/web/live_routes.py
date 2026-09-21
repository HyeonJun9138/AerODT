"""Versioned wire adapters. Callables are injected by application composition."""
import asyncio
import time
import hashlib
import uuid
from urllib.parse import urlsplit
from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool


async def stream_snapshots(send, snapshot_payload, wait_for_change=None, interval_seconds=1.0,
                           keepalive_seconds=None, sleep=asyncio.sleep, clock=time.monotonic):
    """Send each new immutable payload once, spaced by at least interval_seconds.

    A slower runtime tick no longer produces duplicate frames, and a new state
    is pushed as soon as it exists rather than at the next fixed interval. An
    unchanged payload is repeated only as a rare keepalive. Without a change
    signal the payload identity is polled once per interval.
    """
    keepalive = max(interval_seconds, 10 * interval_seconds if keepalive_seconds is None else keepalive_seconds)
    sent, sent_at = None, None
    while True:
        payload = snapshot_payload()
        if payload is not sent or clock() - sent_at >= keepalive:
            # Latest immutable snapshot only: no unbounded per-client backlog.
            started = clock()
            await asyncio.wait_for(send(payload), timeout=5)
            sent, sent_at = payload, started
            # Encoding/compression and socket backpressure already used part
            # of the interval. Adding a whole sleep after send made a 10 Hz
            # producer beat against a slower consumer and skip unevenly.
            await sleep(max(0, interval_seconds - (clock() - started)))
            continue
        if wait_for_change is None:
            await sleep(interval_seconds)
            continue
        try:
            # The bounded wait also covers a change signalled between the
            # identity check above and this registration.
            await asyncio.wait_for(wait_for_change(), timeout=interval_seconds)
        except asyncio.TimeoutError:
            pass


# Every connected page is sent the same snapshot string each tick, and the
# audit wants the exact number of bytes that went out. Encoding a ~150 kB
# payload once per page purely to measure it put a full UTF-8 pass per client
# per tick on the one event loop that also serves the manual flight socket.
# The measurement is unchanged; it is now taken once for the payload rather
# than once for each page reading it.
_measured_payload = (None, 0)


def payload_bytes(payload):
    global _measured_payload
    previous, size = _measured_payload
    if previous is payload:
        return size
    size = len(payload.encode('utf-8'))
    _measured_payload = (payload, size)
    return size


def same_origin(request):
    """The local dashboard only. A browser page from elsewhere may not steer
    which part of the world this server asks its providers about."""
    origin = request.headers.get("origin")
    return not origin or urlsplit(origin).netloc == request.headers.get("host")


def create_router(snapshot_payload, asset_catalog, interval_seconds=1, wait_for_change=None,
                  trajectory=None, report_view=None, audit=None):
    router = APIRouter()

    @router.post("/api/live/view", include_in_schema=False)
    async def view(request: Request):
        # Display input, never twin state: it only chooses the area requested
        # from the aircraft provider, and a rejected body changes nothing.
        if not same_origin(request):
            return JSONResponse({"error": "same_origin_required"}, status_code=403)
        if report_view is None:
            return JSONResponse({"accepted": False, "reason": "no_aircraft_provider"}, status_code=200)
        try:
            payload = await request.json()
        except ValueError:
            return JSONResponse({"accepted": False, "reason": "invalid_json"}, status_code=400)
        accepted = bool(report_view(payload))
        return JSONResponse({"accepted": accepted}, status_code=200 if accepted else 400)

    @router.get("/api/health")
    async def health():
        return {"status": "ready", "schema_version": 1}

    @router.get("/api/live/snapshot")
    async def snapshot():
        return Response(content=snapshot_payload(), media_type="application/json")

    @router.get("/api/visual-assets")
    async def assets():
        return asset_catalog()

    @router.get("/api/live/trajectory/{entity_id}")
    async def entity_trajectory(entity_id: str):
        # One selected object at a time; the Live Twin owns the projection.
        path = await run_in_threadpool(trajectory, entity_id) if trajectory and len(entity_id) <= 128 else None
        if path is None:
            return JSONResponse({"schema_version": 1, "error": "unknown_entity"}, status_code=404)
        return path

    @router.websocket("/ws/live")
    async def live(socket: WebSocket):
        # Local dashboard is read-only, but reject cross-site browser origins.
        if not same_origin(socket):
            await socket.close(code=1008)
            return
        await socket.accept()
        correlation = uuid.uuid4().hex
        counts = {'attempted': 0, 'locally_sent': 0, 'bytes': 0}
        last_payload, first_digest = None, None
        window = time.monotonic()

        def flush(outcome, error_type=None):
            nonlocal window, first_digest
            if audit:
                audit('stream_delivery', correlation_id=correlation, outcome=outcome,
                    error_type=error_type, **counts, period_s=round(time.monotonic()-window, 2),
                    first_digest=first_digest,
                    last_digest=hashlib.sha256(last_payload.encode()).hexdigest() if last_payload else None,
                    remote_acknowledged=None, delivery_scope='local_websocket_transport')
            counts.update(attempted=0, locally_sent=0, bytes=0)
            first_digest = None
            window = time.monotonic()

        async def sending(payload):
            nonlocal last_payload, first_digest
            counts['attempted'] += 1
            await socket.send_text(payload)
            counts['locally_sent'] += 1
            counts['bytes'] += payload_bytes(payload)
            last_payload = payload
            if first_digest is None:
                first_digest = hashlib.sha256(payload.encode()).hexdigest()
            if time.monotonic()-window >= 10:
                flush('local_send_batch')

        outcome, error_type = 'closed', None
        try:
            await stream_snapshots(sending, snapshot_payload, wait_for_change, interval_seconds)
        except (WebSocketDisconnect, asyncio.TimeoutError, RuntimeError, OSError) as error:
            outcome, error_type = 'transport_closed_or_failed', type(error).__name__
        finally:
            flush(outcome, error_type)

    return router
