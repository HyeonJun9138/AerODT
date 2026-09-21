import asyncio
from user_application.apps.web_dashboard.fixture_source import AircraftFixture, SatelliteFixture


def test_fixture_clock_and_locations_are_deterministic_and_explicit():
    source = AircraftFixture(now=lambda: 100)
    first = asyncio.run(source.fetch())
    assert len(first) == 3
    assert all(item['name'].startswith('TEST') for item in first)
    assert first == asyncio.run(source.fetch())
    assert all(item['observed_at'] == 100 for item in first)


def test_satellite_fixture_is_explicit_and_uses_ingestion_path():
    from data.ingestion.source_records import SourceRecords
    from digital_twin.live_twin.state_synchronization import LiveSynchronizer
    source = SatelliteFixture(now=lambda: 1788858053)
    store = SourceRecords()
    store.register('fixture_satellites', asyncio.run(source.fetch()), 1788858053,
        format='celestrak_gp', provenance='fixture')
    entities = LiveSynchronizer().synchronize(store.records(), 1788858054)
    assert len(entities) == 24
    assert all(entity.name.startswith('TEST SATELLITE') and entity.provenance == 'fixture' for entity in entities)


def test_satellite_fixture_count_is_bounded_for_benchmark():
    import pytest
    assert len(asyncio.run(SatelliteFixture(count=100).fetch())) == 100
    with pytest.raises(ValueError):
        SatelliteFixture(count=1000000)
