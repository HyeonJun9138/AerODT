"""Data-owned, indexed operational I/O journal within the application's run.

The bounded worker queue keeps disk work off ASGI and simulation threads. Each
batch commits transactionally. Queue loss/write failure is surfaced in health;
a successful local send never implies acknowledgement by the remote consumer.
"""
import hashlib
import json
import math
import queue
import re
import sqlite3
import threading
import time
import uuid
import zlib
from contextlib import closing
from pathlib import Path

SECRET = re.compile(r'authorization|cookie|token|secret|password|credential|api.?key|session', re.I)


def sanitize(value, depth=0):
    if depth > 12:
        return {'truncated': 'depth_limit'}
    if isinstance(value, dict):
        result = {str(k)[:200]: '[redacted]' if SECRET.search(str(k)) else sanitize(v, depth+1)
                  for k, v in list(value.items())[:10000]}
        if len(value) > 10000:
            result['_truncated_fields'] = len(value)-10000
        return result
    if isinstance(value, (list, tuple)):
        result = [sanitize(v, depth+1) for v in value[:10000]]
        if len(value) > 10000:
            result.append({'truncated_items': len(value)-10000})
        return result
    if isinstance(value, str):
        return value if len(value) <= 8192 else value[:8192] + ' [truncated]'
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return {'type': type(value).__name__}


class AuditJournal:
    def __init__(self, run_directory, capacity=2048):
        self.directory = Path(run_directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / 'operational-audit.sqlite3'
        self.run_id = self.directory.name
        self._queue = queue.Queue(maxsize=capacity)
        self._lock = threading.Lock()
        self._closed = False
        self.accepted = self.written = self.dropped = self.failures = 0
        with closing(self._connect()) as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS events (
                seq INTEGER PRIMARY KEY, at REAL NOT NULL, kind TEXT NOT NULL,
                scenario TEXT, flight TEXT, correlation TEXT, body TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS event_scope ON events(scenario, seq);
                CREATE INDEX IF NOT EXISTS event_correlation ON events(correlation, seq);
                CREATE TABLE IF NOT EXISTS payloads (digest TEXT PRIMARY KEY, content BLOB NOT NULL);''')
        self._worker = threading.Thread(target=self._write, name='operational-audit', daemon=True)
        self._worker.start()

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.execute('PRAGMA journal_mode=WAL')
        return db

    def record(self, kind, *, payload=None, **detail):
        # Capture caller-owned mutable objects before returning. All caps are
        # explicit in the stored record; truncated content is never called raw.
        body = sanitize(detail)
        content = None
        if payload is not None:
            encoded = json.dumps(sanitize(payload), ensure_ascii=False, allow_nan=False).encode('utf-8')
            if len(encoded) > 2*1024*1024:
                body['payload_omitted'] = 'sanitized_payload_exceeds_2MiB'
                body['sanitized_bytes'] = len(encoded)
            else:
                digest = hashlib.sha256(encoded).hexdigest()
                body.update(payload_ref=digest, payload_policy='sanitized_bounded_json', payload_bytes=len(encoded))
                content = (digest, zlib.compress(encoded))
        item = (time.time(), kind, body.get('scenario_id'), body.get('flight_id'),
                body.get('correlation_id') or uuid.uuid4().hex, json.dumps(body, ensure_ascii=False), content)
        with self._lock:
            if self._closed:
                self.dropped += 1
                return False
            try:
                self._queue.put_nowait(item)
                self.accepted += 1
                return True
            except queue.Full:
                self.dropped += 1
                return False

    def _write(self):
        db = self._connect()
        try:
            while True:
                first = self._queue.get()
                if first is None:
                    self._queue.task_done()
                    break
                batch = [first]
                while len(batch) < 64:
                    try:
                        item = self._queue.get_nowait()
                    except queue.Empty:
                        break
                    if item is None:
                        # close only enqueues after flush, so cannot appear here.
                        self._queue.task_done()
                        break
                    batch.append(item)
                try:
                    with db:
                        for item in batch:
                            db.execute('INSERT INTO events(at,kind,scenario,flight,correlation,body) VALUES(?,?,?,?,?,?)', item[:6])
                            if item[6]:
                                db.execute('INSERT OR IGNORE INTO payloads VALUES(?,?)', item[6])
                    with self._lock:
                        self.written += len(batch)
                except (OSError, sqlite3.Error):
                    with self._lock:
                        self.failures += 1
                        self.dropped += len(batch)
                finally:
                    for _ in batch:
                        self._queue.task_done()
        finally:
            db.close()

    def health(self):
        with self._lock:
            return dict(run_id=self.run_id, accepted=self.accepted, written=self.written,
                        dropped=self.dropped, write_failures=self.failures,
                        pending=self._queue.unfinished_tasks, closed=self._closed,
                        complete=self.dropped == 0 and self.failures == 0)

    def query(self, scenario_id=None, before=None, limit=100):
        conditions, values = [], []
        if scenario_id:
            conditions.append('scenario=?'); values.append(scenario_id)
        if before is not None:
            conditions.append('seq<?'); values.append(int(before))
        where = ' WHERE ' + ' AND '.join(conditions) if conditions else ''
        with closing(self._connect()) as db:
            rows = db.execute('SELECT seq,at,kind,correlation,body FROM events' + where +
                              ' ORDER BY seq DESC LIMIT ?', [*values, min(200, max(1, int(limit)))]).fetchall()
            totals = db.execute('SELECT kind,COUNT(*) FROM events' + (' WHERE scenario=?' if scenario_id else '') +
                               ' GROUP BY kind', [scenario_id] if scenario_id else []).fetchall()
        return {'schema_version': 1, 'scope': 'scenario_context' if scenario_id else 'application_run',
                'scenario_id': scenario_id, 'health': self.health(), 'counts': dict(totals),
                'rows': [dict(json.loads(body), id=seq, timestamp=at, kind=kind, correlation_id=corr)
                         for seq, at, kind, corr, body in rows],
                'next_before': rows[-1][0] if rows else None,
                'delivery_semantics': 'local_send_only; remote_acknowledgement_not_available'}

    def flush(self):
        self._queue.join()

    def close(self):
        with self._lock:
            if self._closed:
                return
            self._closed = True
        self.flush()
        self._queue.put(None)
        self._worker.join(timeout=10)
        (self.directory / 'audit-health.json').write_text(json.dumps(self.health()), encoding='utf-8')


class AuditRecords:
    """Reopen previous run journals read-only; no SQL or path supplied by clients."""
    def __init__(self, directory):
        self.directory = Path(directory)

    def path(self, run_id):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', run_id or ''):
            raise ValueError('올바르지 않은 기록 ID')
        result = (self.directory / run_id).resolve()
        if result.parent != self.directory.resolve():
            raise ValueError('기록 경로 범위 초과')
        return result

    def list(self):
        if not self.directory.exists():
            return []
        return [{'id': p.name, 'modified': (p/'operational-audit.sqlite3').stat().st_mtime}
                for p in sorted(self.directory.iterdir(), reverse=True)
                if p.is_dir() and (p/'operational-audit.sqlite3').is_file()][:100]

    def query(self, run_id, scenario_id=None, before=None, limit=100):
        directory = self.path(run_id)
        database = directory / 'operational-audit.sqlite3'
        if not database.is_file():
            raise ValueError('I/O 기록 없음')
        class Reader:
            def _connect(self):
                return sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=5)
            def health(self):
                path = directory / 'audit-health.json'
                return json.loads(path.read_text(encoding='utf-8')) if path.is_file() else {
                    'run_id': run_id, 'complete': None, 'closed': None,
                    'note': '최종 종료 상태 미확인 · 기록된 행만 표시'}
        return AuditJournal.query(Reader(), scenario_id, before, limit)

    def payload(self, run_id, digest):
        if not re.fullmatch(r'[a-f0-9]{64}', digest):
            raise ValueError('올바르지 않은 내용 ID')
        database = self.path(run_id) / 'operational-audit.sqlite3'
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=5)) as db:
            row = db.execute('SELECT content FROM payloads WHERE digest=?', (digest,)).fetchone()
        if row is None:
            raise ValueError('보관 내용 없음')
        decoder = zlib.decompressobj()
        decoded = decoder.decompress(row[0], 2*1024*1024+1)
        if len(decoded) > 2*1024*1024 or not decoder.eof:
            raise ValueError('보관 내용 크기 초과')
        return {'payload_ref': digest, 'policy': 'sanitized_bounded_json', 'payload': json.loads(decoded)}
