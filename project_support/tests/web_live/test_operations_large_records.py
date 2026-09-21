"""Large valid operational histories remain readable without uncapped files."""
import json
from pathlib import Path

import pytest

from data.simulation import operations_records as records
from data.simulation.physical_operations import PhysicalOperationsRecords
from test_operations_analysis import source
from user_application.uam_mission.operations_analysis import build_report


def test_actual_file_over_32_mib_can_be_written_listed_read_and_analyzed(tmp_path):
    data = source()
    data['events'].append({'kind': 'psu_decision', 'flight_id': 'F0', 'time_s': 4000,
                           'detail': 'x'*(33*1024*1024)})
    records.write_operations(tmp_path/'day-1', data)
    assert (tmp_path/'day-1'/'operations.json').stat().st_size > 32*1024*1024
    store = records.OperationsRecords(tmp_path)
    assert store.list()[0]['id'] == 'day-1'
    restored = store.read('day-1')
    assert restored['events'] == data['events']
    assert build_report(restored)['totals']['completed'] == 2


def test_valid_index_lists_without_reading_the_large_body(tmp_path, monkeypatch):
    records.write_operations(tmp_path/'day-1', source())
    original = records._read
    def metadata_only(path, **kwargs):
        assert Path(path).name != 'operations.json', 'listing decoded the entire history'
        return original(path, **kwargs)
    monkeypatch.setattr(records, '_read', metadata_only)
    assert records.OperationsRecords(tmp_path).list()[0]['flights'] == 8


def test_legacy_body_without_index_and_stale_index_fall_back_to_bounded_data(tmp_path):
    data = source()
    path = tmp_path/'day-1'
    records.write_operations(path, data)
    (path/'operations.index.json').unlink()
    assert records.OperationsRecords(tmp_path).list()[0]['flights'] == 8
    records.write_operations(path, data)
    data['plans'] = data['plans'][:3]
    data['meta']['name'] = 'a replacement written by an older writer'
    temporary = path/'legacy.pending'
    temporary.write_text(json.dumps(data), encoding='utf-8')
    temporary.replace(path/'operations.json')
    listed = records.OperationsRecords(tmp_path).list()[0]
    assert listed['flights'] == 3 and listed['name'] == data['meta']['name']


def test_record_size_limit_preserves_last_good_body_and_index(tmp_path, monkeypatch):
    path = tmp_path/'day-1'
    records.write_operations(path, source())
    before = {p.name: p.read_bytes() for p in path.iterdir()}
    monkeypatch.setattr(records, 'MAX_OPERATIONS_BYTES', 1024)
    with pytest.raises(ValueError, match='크기'):
        records.write_operations(path, source())
    assert {p.name: p.read_bytes() for p in path.iterdir()} == before
    with pytest.raises(ValueError, match='크기'):
        records.OperationsRecords(tmp_path).read('day-1')


def test_serialization_failure_never_promotes_a_partial_checkpoint(tmp_path):
    path = tmp_path/'day-1'
    records.write_operations(path, source())
    before = {p.name: p.read_bytes() for p in path.iterdir()}
    bad = source()
    bad['events'][-1]['time_s'] = float('nan')
    with pytest.raises(ValueError):
        records.write_operations(path, bad)
    assert {p.name: p.read_bytes() for p in path.iterdir()} == before


def test_index_replace_failure_leaves_complete_new_data_with_safe_listing_fallback(tmp_path, monkeypatch):
    path = tmp_path/'day-1'
    records.write_operations(path, source())
    original = Path.replace
    def fail_index(self, target):
        if Path(target).name == 'operations.index.json':
            raise OSError('simulated index interruption')
        return original(self, target)
    monkeypatch.setattr(Path, 'replace', fail_index)
    changed = source()
    changed['plans'] = changed['plans'][:3]
    with pytest.raises(OSError):
        records.write_operations(path, changed)
    store = records.OperationsRecords(tmp_path)
    assert len(store.read('day-1')['plans']) == 3
    assert store.list()[0]['flights'] == 3
    assert sorted(p.name for p in path.iterdir()) == ['operations.index.json', 'operations.json']


def test_same_size_replacement_cannot_reuse_an_old_index_identity(tmp_path):
    path = tmp_path/'day-1'
    data = source()
    data['meta']['name'] = 'old'
    records.write_operations(path, data)
    old = (path/'operations.json').stat()
    data['meta']['name'] = 'new'
    # Same writer encoding and restored timestamp still have a distinct file ID.
    temporary = path/'replacement.pending'
    temporary.write_text(json.dumps(data, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    assert temporary.stat().st_size == old.st_size
    import os
    os.utime(temporary, ns=(old.st_atime_ns, old.st_mtime_ns))
    temporary.replace(path/'operations.json')
    assert records.OperationsRecords(tmp_path).list()[0]['name'] == 'new'


def test_writer_and_reader_enforce_the_same_event_row_bound(tmp_path, monkeypatch):
    path = tmp_path/'day-1'
    records.write_operations(path, source())
    monkeypatch.setattr(records, 'MAX_EVENTS', 2)
    with pytest.raises(ValueError, match='행|범위'):
        records.write_operations(path, source())
    with pytest.raises(ValueError, match='행|범위'):
        records.OperationsRecords(tmp_path).read('day-1')


def test_checkpoint_exposes_size_failure_and_can_recover(tmp_path, monkeypatch):
    journal = PhysicalOperationsRecords(tmp_path)
    raw=source()
    journal.begin('day-1','test-process',1,{'analysis_base':{k:v for k,v in raw.items() if k not in ('meta','active','events')}})
    journal.observe_events([dict(e,event_sequence=i+1) for i,e in enumerate(raw['events'])])
    journal.observe({}, {k:raw[k] for k in ('meta','active')},2)
    monkeypatch.setattr(records, 'MAX_OPERATIONS_BYTES', 1024)
    assert journal.checkpoint() is False
    assert '크기' in journal.error
    monkeypatch.setattr(records, 'MAX_OPERATIONS_BYTES', 256*1024*1024)
    assert journal.checkpoint() is True and journal.error is None
    assert records.OperationsRecords(tmp_path).read('day-1')['events'] == journal.analysis_input()['events']


def test_late_index_from_another_writer_never_mixes_its_metadata_with_newer_body(tmp_path, monkeypatch):
    path = tmp_path/'day-1'
    older = source()
    older['meta']['name'] = 'older'
    newer = source()
    newer['meta']['name'] = 'newer'
    newer['plans'] = newer['plans'][:3]
    original = records._atomic_json
    interleaved = False
    def interleave(target, body, limit):
        nonlocal interleaved
        if target.name == 'operations.index.json' and not interleaved:
            interleaved = True
            records.write_operations(path, newer)
        return original(target, body, limit)
    monkeypatch.setattr(records, '_atomic_json', interleave)
    records.write_operations(path, older)
    store = records.OperationsRecords(tmp_path)
    assert store.read('day-1')['meta']['name'] == 'newer'
    assert store.list()[0]['name'] == 'newer' and store.list()[0]['flights'] == 3


def test_corrupt_or_oversized_index_does_not_hide_an_intact_archive(tmp_path, monkeypatch):
    path = tmp_path/'day-1'
    records.write_operations(path, source())
    index = path/'operations.index.json'
    index.write_text('{interrupted', encoding='utf-8')
    assert records.OperationsRecords(tmp_path).list()[0]['flights'] == 8
    index.write_text('x'*1024, encoding='utf-8')
    monkeypatch.setattr(records, 'MAX_INDEX_BYTES', 64)
    assert records.OperationsRecords(tmp_path).list()[0]['flights'] == 8


def test_reader_bounds_bytes_even_when_file_size_check_is_stale(tmp_path, monkeypatch):
    from types import SimpleNamespace
    path = tmp_path/'growing.json'
    path.write_text(json.dumps(source()), encoding='utf-8')
    monkeypatch.setattr(records.os, 'fstat', lambda _: SimpleNamespace(st_size=1))
    with pytest.raises(ValueError, match='크기'):
        records._read(path, max_bytes=64)
