"""Operational HTTP request/result trace; credentials and query strings omitted."""
import json
import sqlite3
import time
import uuid
from fastapi import APIRouter, Query, HTTPException
from starlette.concurrency import run_in_threadpool


class OperationalAuditMiddleware:
    def __init__(self, app, audit):
        self.app, self.audit = app, audit

    async def __call__(self, scope, receive, send):
        path = scope.get('path', '')
        relevant = scope['type'] == 'http' and path.startswith('/api/') and (
            scope.get('method') in ('POST', 'PUT', 'PATCH', 'DELETE') or path == '/api/live/snapshot')
        if not relevant or path == '/api/live/view':
            return await self.app(scope, receive, send)
        correlation = uuid.uuid4().hex
        incoming, outgoing = bytearray(), bytearray()
        received_bytes = sent_bytes = 0
        status = None
        started = time.monotonic()
        self.audit('http_request', correlation_id=correlation, method=scope['method'], path=path)

        async def reading():
            nonlocal received_bytes
            message = await receive()
            data = message.get('body', b'')
            received_bytes += len(data)
            if path != '/api/camera/detect':
                incoming.extend(data[:max(0, 65536-len(incoming))])
            return message

        async def writing(message):
            nonlocal status, sent_bytes
            if message['type'] == 'http.response.start':
                status = message['status']
                message = dict(message, headers=[*message.get('headers', []),
                                                (b'x-aerodt-trace', correlation.encode())])
            data = message.get('body', b'')
            # Count only bytes accepted by the local ASGI transport.
            await send(message)
            sent_bytes += len(data)
            if path != '/api/live/snapshot':
                outgoing.extend(data[:max(0, 65536-len(outgoing))])

        def captured(data, size):
            if size > len(data):
                return {'omitted': 'body_exceeds_capture_limit', 'bytes': size}
            try:
                return json.loads(data) if data else None
            except (ValueError, UnicodeDecodeError):
                return {'omitted': 'non_json_body', 'bytes': size}

        try:
            await self.app(scope, reading, writing)
        except BaseException as error:
            self.audit('http_result', correlation_id=correlation, method=scope['method'], path=path,
                       outcome='transport_failed', error_type=type(error).__name__, status=status,
                       received_bytes=received_bytes, locally_sent_bytes=sent_bytes)
            raise
        else:
            self.audit('http_result', correlation_id=correlation, method=scope['method'], path=path,
                status=status, outcome='local_response_sent', duration_ms=round((time.monotonic()-started)*1000, 1),
                received_bytes=received_bytes, locally_sent_bytes=sent_bytes,
                payload={'request': ({'omitted': 'camera_pixels', 'bytes': received_bytes}
                                     if path == '/api/camera/detect' else captured(incoming, received_bytes)),
                         'response': captured(outgoing, sent_bytes)})


def create_audit_router(journal, records=None):
    router = APIRouter()

    @router.get('/api/simulation/analysis/flow-records')
    async def archived():
        return {'records': await run_in_threadpool(records.list) if records else []}

    @router.get('/api/simulation/analysis/flow-payload/{digest}')
    async def payload(digest: str, run_id: str = Query('', max_length=100)):
        store = journal()
        try:
            if records is None:
                raise ValueError('보관 내용 없음')
            return await run_in_threadpool(records.payload, run_id or (store.run_id if store else ''), digest)
        except (OSError, ValueError, sqlite3.Error):
            raise HTTPException(404, '보관된 내용을 찾을 수 없습니다.')

    @router.get('/api/simulation/analysis/flows')
    async def flows(scenario_id: str = Query('', max_length=100), before: int = Query(None, ge=1),
                    limit: int = Query(100, ge=1, le=200), run_id: str = Query('', max_length=100)):
        store = journal()
        if run_id and (store is None or run_id != store.run_id) and records:
            try:
                return dict(await run_in_threadpool(records.query, run_id, scenario_id or None, before, limit), available=True)
            except (OSError, ValueError, sqlite3.Error):
                raise HTTPException(404, 'I/O 기록을 찾을 수 없습니다.')
        if store is None:
            return {'schema_version': 1, 'available': False, 'rows': []}
        return dict(await run_in_threadpool(store.query, scenario_id or None, before, limit), available=True)

    return router
