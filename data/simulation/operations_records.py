"""Bounded read-only access to daily analysis inputs and older flight records."""
import csv
import copy
import json
import math
import os
import re
import uuid
from pathlib import Path

MAX_BYTES = 32 * 1024 * 1024
# A real 100-aircraft daily archive already exceeds the old generic 32 MiB
# bound. Analysis still materializes the JSON object, so this is a finite input
# bound, not a constant-memory claim. Small summary/legacy files keep MAX_BYTES.
MAX_OPERATIONS_BYTES = 256 * 1024 * 1024
MAX_INDEX_BYTES = 256 * 1024
MAX_PLANS = 20000
MAX_EVENTS = 2000000


class OperationsHistory:
    """Retain daily facts as the engine's short inspection ring rolls over."""
    def __init__(self):
        self.events, self.last, self.index = [], None, 0

    def observe(self, events):
        start = self.index
        if self.last is not None and (start > len(events) or events[start-1] is not self.last):
            start = next((i+1 for i in range(len(events)-1, -1, -1) if events[i] is self.last), 0)
        self.events.extend(copy.deepcopy(events[start:]))
        self.index = len(events)
        self.last = events[-1] if events else None
        return self.events


def write_operations(directory, source):
    path = Path(directory) / 'operations.json'
    _validate_source(source, path.parent.name)
    index = {'schema_version': 1, 'kind': 'operations_index', 'meta': source['meta'],
             'flights': len(source['plans']), 'events': len(source['events'])}
    # Check the small metadata budget before replacing a previous good body.
    if len(json.dumps(index, ensure_ascii=False, allow_nan=False).encode('utf-8')) > MAX_INDEX_BYTES-1024:
        raise ValueError('분석 기록 메타데이터의 허용 크기를 초과했습니다.')
    path.parent.mkdir(parents=True, exist_ok=True)
    index['source'] = _atomic_json(path, source, MAX_OPERATIONS_BYTES)
    # A crash between these independent replacements leaves a stale index.
    # Readers compare the actual file identity and fall back to its valid body.
    _atomic_json(path.with_name('operations.index.json'), index, MAX_INDEX_BYTES)


def _signature(stat):
    return {'bytes': stat.st_size, 'mtime_ns': stat.st_mtime_ns, 'file_id': stat.st_ino}


def _atomic_json(path, source, limit):
    temporary = path.with_name(f'{path.name}.{uuid.uuid4().hex}.pending')
    try:
        size = 0
        with temporary.open('xb') as file:
            for chunk in _json_records(source):
                # Do not create a second whole-document UTF-8 buffer.
                for start in range(0, len(chunk), 65536):
                    encoded = chunk[start:start+65536].encode('utf-8')
                    size += len(encoded)
                    if size > limit:
                        raise ValueError('분석 기록의 허용 크기를 초과했습니다.')
                    file.write(encoded)
            file.flush()
            os.fsync(file.fileno())
        # Capture the file that was written, not a concurrent writer's result
        # after replacement. A late index can never describe that other body.
        signature = _signature(temporary.stat())
        temporary.replace(path)
        return signature
    except RecursionError as error:
        raise ValueError('분석 기록의 JSON 중첩 범위를 초과했습니다.') from error
    finally:
        temporary.unlink(missing_ok=True)


def _json_records(source):
    """Use the C encoder per record, without a whole daily-document buffer."""
    encoder=json.JSONEncoder(ensure_ascii=False,allow_nan=False)
    if not isinstance(source,dict):
        yield from encoder.iterencode(source)
        return
    yield '{'
    for index,(key,value) in enumerate(source.items()):
        if index:yield ', '
        yield encoder.encode(key);yield ': '
        if isinstance(value,list):
            yield '['
            for row,item in enumerate(value):
                if row:yield ', '
                yield encoder.encode(item)
            yield ']'
        else:yield encoder.encode(value)
    yield '}'


def _read(path, *, max_bytes=None):
    limit = MAX_BYTES if max_bytes is None else max_bytes
    with path.open('rb') as file:
        if os.fstat(file.fileno()).st_size > limit:
            raise ValueError('분석 기록이 없거나 허용 크기를 초과했습니다.')
        encoded = file.read(limit+1)
    if len(encoded) > limit:
        raise ValueError('분석 기록의 허용 크기를 초과했습니다.')
    text = encoded.decode('utf-8-sig')
    del encoded  # Release the byte buffer before materializing all JSON rows.
    try:
        data = json.loads(text)
    except RecursionError as error:
        raise ValueError('분석 기록의 JSON 중첩 범위를 초과했습니다.') from error
    if not isinstance(data, dict):
        raise ValueError('분석 기록은 JSON 객체여야 합니다.')
    return data


def _validate_source(source, identifier):
    if not isinstance(source, dict):
        raise ValueError('분석 기록은 JSON 객체여야 합니다.')
    meta = source.get('meta')
    if (not isinstance(meta, dict) or source.get('schema_version') != 1
            or meta.get('scenario_id') != identifier):
        raise ValueError('분석 기록의 버전 또는 ID가 일치하지 않습니다.')
    for key, limit in (('plans', MAX_PLANS), ('events', MAX_EVENTS)):
        rows = source.get(key)
        if not isinstance(rows, list) or len(rows) > limit or not all(isinstance(row, dict) for row in rows):
            raise ValueError('분석 기록의 행 형식 또는 허용 범위가 올바르지 않습니다.')
    if not isinstance(source.get('active', {}), dict):
        raise ValueError('분석 기록 범위가 올바르지 않습니다.')


def _metadata(directory):
    path = directory/'operations.json'
    signature = _signature(path.stat())
    if signature['bytes'] > MAX_OPERATIONS_BYTES:
        raise ValueError('분석 기록의 허용 크기를 초과했습니다.')
    try:
        index = _read(directory/'operations.index.json', max_bytes=MAX_INDEX_BYTES)
        meta = index.get('meta')
        if (index.get('schema_version') == 1 and index.get('kind') == 'operations_index'
                and signature['file_id'] and index.get('source') == signature
                and isinstance(meta, dict) and meta.get('scenario_id') == directory.name
                and type(index.get('flights')) is int and 0 <= index['flights'] <= MAX_PLANS
                and type(index.get('events')) is int and 0 <= index['events'] <= MAX_EVENTS):
            return meta, index['flights']
    except (OSError, ValueError, TypeError):
        pass
    source = _read(path, max_bytes=MAX_OPERATIONS_BYTES)
    _validate_source(source, directory.name)
    return source['meta'], len(source['plans'])


def _clock(text):
    try:
        h, m, s = str(text).strip().split(':')
        value = int(h)*3600 + int(m)*60 + float(s)
        return value if math.isfinite(value) and value >= 0 else None
    except (ValueError, TypeError):
        return None


class OperationsRecords:
    def __init__(self, directory):
        self.directory = Path(directory)

    def path(self, identifier):
        if not isinstance(identifier, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', identifier):
            raise ValueError('분석 기록 ID가 올바르지 않습니다.')
        path = (self.directory / identifier).resolve()
        if path.parent != self.directory.resolve():
            raise ValueError('분석 기록 범위가 올바르지 않습니다.')
        return path

    def list(self):
        if not self.directory.is_dir():
            return []
        results = []
        paths = []
        for candidate in self.directory.iterdir():
            try:
                path = self.path(candidate.name)
                if path.is_dir():
                    paths.append((path.stat().st_mtime, path))
            except (OSError, ValueError):
                continue
        for _, path in sorted(paths, key=lambda item: item[0], reverse=True):
            try:
                if (path / 'operations.json').is_file():
                    meta, flights = _metadata(path)
                    results.append(dict(meta, id=path.name, recorded=True, flights=flights))
                elif (path / 'flights.csv').is_file() and (path / 'summary.json').is_file():
                    summary = _read(path / 'summary.json')
                    schedule = summary.get('schedule', {})
                    results.append({'id': path.name, 'scenario_id': path.name, 'date': schedule.get('date', ''),
                        'name': '이전 운항 기록', 'legacy': True, 'recorded': True,
                        'flights': schedule.get('flights'), 'observed_s': summary.get('result', {}).get('time_s')})
            except (OSError, ValueError, KeyError, TypeError):
                continue
            if len(results) >= 100:
                break
        return results

    def read(self, identifier):
        path = self.path(identifier)
        if (path / 'operations.json').is_file():
            source = _read(path / 'operations.json', max_bytes=MAX_OPERATIONS_BYTES)
            _validate_source(source, identifier)
            source['meta']['recorded'] = True
            return source
        summary = _read(path / 'summary.json')
        csv_path = path / 'flights.csv'
        if not csv_path.is_file() or csv_path.stat().st_size > MAX_BYTES:
            raise ValueError('편별 운항 기록을 읽을 수 없습니다.')
        schedule, result = summary.get('schedule', {}), summary.get('result', {})
        if not isinstance(schedule, dict) or not isinstance(result, dict):
            raise ValueError('이전 운항 요약의 형식이 올바르지 않습니다.')
        plans, events = [], []
        with csv_path.open(encoding='utf-8-sig', newline='') as file:
            for row in csv.DictReader(file):
                if len(plans) >= MAX_PLANS:
                    raise ValueError('분석 가능한 최대 비행편 수를 초과했습니다.')
                flight = row['flight_plan_id']
                plans.append({'flight_id': flight, 'aircraft_id': row['aircraft_id'], 'seats': int(row['seats']),
                    'passengers': None, 'origin': row['origin'], 'destination': row['destination'],
                    'off_block_s': _clock(row.get('planned_off_block')), 'touchdown_s': _clock(row.get('planned_touchdown'))})
                for field, kind in [('actual_off_block', 'off_block'), ('actual_touchdown', 'touchdown')]:
                    at = _clock(row.get(field))
                    if at is not None:
                        event = {'flight_id': flight, 'kind': kind, 'time_s': at}
                        if kind == 'touchdown':
                            event['hold_s'] = float(row.get('hold_seconds') or 0)
                        events.append(event)
        # Original events retain cancellation/failure/hold-release facts absent
        # from the old flights.csv. Do not infer those facts from "not started".
        event_path = path / 'events.jsonl'
        if event_path.is_file() and event_path.stat().st_size <= MAX_BYTES:
            with event_path.open(encoding='utf-8-sig') as file:
                for line in file:
                    try:
                        event = json.loads(line)
                        if isinstance(event, dict):
                            events.append(event)
                    except ValueError:
                        continue  # A partially written final line is not an event.
        start = schedule.get('window', {}).get('start_s')
        observed = result.get('time_s')
        if observed is None:
            observed = max((e.get('time_s', 0) for e in events), default=start or 0)
        return {'schema_version': 1, 'meta': {'scenario_id': identifier, 'name': '이전 운항 기록',
            'date': schedule.get('date', ''), 'state': 'finished', 'observed_s': observed,
            'start_s': start, 'planned_end_s': schedule.get('window', {}).get('end_s'),
            'engine': 'legacy', 'legacy': True, 'recorded': True},
            'plans': plans, 'events': events, 'active': {}, 'facilities': {}}
