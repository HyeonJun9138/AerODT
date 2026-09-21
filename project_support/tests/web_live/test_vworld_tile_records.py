import os
import time

from data.ingestion.vworld_tiles import VWorldTileRecords, HEADER


def test_restart_reuses_bytes_but_does_not_extend_expiry(tmp_path):
    clock = [100]
    records = VWorldTileRecords(tmp_path, clock=lambda: clock[0])
    records.put('v5:Seoul/parent.b3dm:overview', b'compressed-tile', ttl=10)
    clock[0] = 106
    restarted = VWorldTileRecords(tmp_path, clock=lambda: clock[0])
    assert restarted.get('v5:Seoul/parent.b3dm:overview') == (b'compressed-tile', 4)
    assert restarted.get('v5:Seoul/parent.b3dm:full') is None
    assert restarted.get('v6:Seoul/parent.b3dm:overview') is None
    clock[0] = 111
    assert restarted.get('v5:Seoul/parent.b3dm:overview') is None
    assert not list(tmp_path.glob('*.vwcache'))


def test_corrupt_and_oversized_files_are_cache_misses_not_bad_responses(tmp_path):
    records = VWorldTileRecords(tmp_path, max_entry_bytes=16)
    records.put('a', b'abc')
    path = records._path('a')
    data = path.read_bytes()
    path.write_bytes(data[:-1] + b'x')
    assert records.get('a') is None
    records.put('large', b'a' * 17)
    assert records.get('large') is None
    path.write_bytes(b'broken')
    assert records.get('a') is None


def test_byte_and_entry_limits_evict_only_owned_files(tmp_path):
    records = VWorldTileRecords(tmp_path, max_bytes=2 * (HEADER.size + 20), max_entries=2)
    unrelated = tmp_path / 'keep.txt'
    unrelated.write_text('not a tile')
    for key in ['a', 'b']:
        records.put(key, b'x' * 20)
    old = time.time() - 100
    os.utime(records._path('a'), (old, old))
    records.put('c', b'x' * 20)
    assert records.get('a') is None
    assert records.get('b')[0] == b'x' * 20
    assert sum(p.stat().st_size for p in tmp_path.glob('*.vwcache')) <= records.max_bytes
    assert unrelated.read_text() == 'not a tile'
    assert not list(tmp_path.glob('*.tmp'))


def test_arbitrary_key_cannot_escape_cache_directory(tmp_path):
    records = VWorldTileRecords(tmp_path / 'tiles')
    key = '../../outside/https://example.test/x?secret=not-a-real-key'
    records.put(key, b'data')
    path = records._path(key)
    assert path.parent == records.directory
    assert key not in path.name
    assert records.get(key)[0] == b'data'


def test_unwritable_cache_is_optional(tmp_path):
    file = tmp_path / 'not-a-directory'
    file.write_text('keep')
    records = VWorldTileRecords(file)
    records.put('a', b'data')
    assert records.get('a') is None
    assert file.read_text() == 'keep'
