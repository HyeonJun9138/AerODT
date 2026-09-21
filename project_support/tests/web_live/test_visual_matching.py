"""Representative 3D model assignment for catalogued objects.

A match is a display assignment, never an identification of the real vehicle.
"""
import pytest

from data.ingestion.source_records import SourceRecords
from digital_twin.live_twin.state_synchronization import LiveSynchronizer
from digital_twin.model_library.visual_matching import SatelliteModelMatcher, load_satellite_matching

AVAILABLE = {'iss', 'hubble', 'landsat_8', 'terra', 'eo_1', 'ssl_1300', 'van_allen',
             'gnss_bus', 'cubesat_3u', 'cubesat_1u', 'leo_comms_bus', 'starlink_flat', 'goes'}


def matcher(available=AVAILABLE):
    return SatelliteModelMatcher(load_satellite_matching(), available=available)


def test_exact_object_is_matched_by_catalogue_number_and_by_name():
    resolver = matcher()
    by_number = resolver.resolve('ISS (ZARYA)', norad=25544)
    assert by_number.asset_id == 'iss' and by_number.quality == 'exact' and by_number.kind == 'station'
    assert resolver.resolve('HST', norad=None).asset_id == 'hubble'
    assert resolver.resolve('hst', norad=None).quality == 'exact', 'catalogue names are matched case-insensitively'


def test_same_series_object_is_labelled_series_not_exact():
    resolver = matcher()
    exact = resolver.resolve('LANDSAT 8', norad=39084)
    series = resolver.resolve('LANDSAT 9', norad=49260)
    assert (exact.asset_id, exact.quality) == ('landsat_8', 'exact')
    assert (series.asset_id, series.quality) == ('landsat_8', 'series')


def test_constellation_families_use_their_bus_and_unknown_payloads_use_the_orbit_representative():
    resolver = matcher()
    assert resolver.resolve('STARLINK-1008').asset_id == 'starlink_flat'
    assert resolver.resolve('ONEWEB-0012').asset_id == 'leo_comms_bus'
    assert resolver.resolve('ONEWEB-0012').quality == 'representative'
    assert resolver.resolve('COSMOS 2555', regime='LEO').asset_id == 'eo_1'
    assert resolver.resolve('INTELSAT 39', regime='GEO').asset_id == 'ssl_1300'
    assert resolver.resolve('GSAT-0201', regime='MEO').asset_id == 'gnss_bus', 'Galileo names are a GNSS family'
    assert resolver.resolve('NAVSTAR 81', regime='MEO').asset_id == 'gnss_bus'
    assert resolver.resolve('MOLNIYA 3-50', regime='HEO').asset_id == 'van_allen'
    assert resolver.resolve('UNKNOWN OBJECT', regime='XEO').asset_id == 'eo_1', 'an unknown regime falls back to LEO'


def test_rocket_bodies_and_debris_get_no_model_and_stay_points():
    resolver = matcher()
    for name in ('CZ-6A R/B', 'ATLAS 5 CENTAUR R/B', 'FENGYUN 1C DEB', 'COSMOS 2251 DEBRIS'):
        match = resolver.resolve(name)
        assert match.asset_id is None
        assert match.quality == 'none'
        assert match.kind in ('rocket', 'debris')


def test_stations_and_cubesats_use_their_own_representatives():
    resolver = matcher()
    assert resolver.resolve('CSS (TIANHE)').asset_id == 'iss'
    assert resolver.resolve('ISS (DESTINY)').kind == 'station'
    cubesat = resolver.resolve('LEMUR-2-HUBBLE-4')
    assert cubesat.kind == 'cubesat' and cubesat.asset_id == 'cubesat_3u'


def test_an_asset_awaiting_rights_review_is_never_assigned():
    resolver = matcher(available=AVAILABLE - {'starlink_flat', 'leo_comms_bus', 'cubesat_3u'})
    starlink = resolver.resolve('STARLINK-1008')
    assert starlink.asset_id == 'eo_1' and starlink.quality == 'representative'
    assert resolver.resolve('ONEWEB-0012').asset_id == 'eo_1'
    assert resolver.resolve('LEMUR-2-HUBBLE-4').asset_id == 'cubesat_1u'
    assert resolver.resolve('ISS (ZARYA)').asset_id == 'iss', 'available exact matches are unaffected'


def test_every_shipped_rule_names_an_asset_the_library_actually_holds():
    from pathlib import Path
    definition = load_satellite_matching()
    root = Path('digital_twin/model_library/visual_assets/spacecraft/satellites')
    named = {rule['asset_id'] for rule in definition['models']}
    for entry in definition['representatives'].values():
        named |= {entry} if isinstance(entry, str) else set(entry or ())
    missing = sorted(asset for asset in named if not (root / asset / 'model.glb').is_file())
    assert missing == []


def satellite_record(store, *, name, norad, regime='LEO'):
    from sgp4.api import Satrec
    from sgp4.exporter import export_omm
    sat = Satrec.twoline2rv(
        '1 25544U 98067A   19343.69339541  .00001764  00000-0  38792-4 0  9991',
        '2 25544  51.6439 211.2001 0007417  17.6667  85.6398 15.50103472202482')
    fields = export_omm(sat, name)
    fields.update(NORAD_CAT_ID=norad, OBJECT_NAME=name, ORBIT_REGIME=regime)
    epoch = (sat.jdsatepoch + sat.jdsatepochF - 2440587.5) * 86400
    store.register('gp', [fields], epoch + 60, format='celestrak_gp')
    return epoch


def test_live_twin_assigns_and_reports_the_match_per_object():
    store = SourceRecords()
    epoch = satellite_record(store, name='ISS (ZARYA)', norad=25544)
    sync = LiveSynchronizer(matcher=matcher())
    entity = sync.synchronize(store.records(), epoch + 60)[0]
    assert entity.visual_asset_id == 'iss'
    assert entity.visual_match == 'exact'

    store = SourceRecords()
    epoch = satellite_record(store, name='CZ-6A R/B', norad=54321)
    entity = LiveSynchronizer(matcher=matcher()).synchronize(store.records(), epoch + 60)[0]
    assert entity.visual_asset_id == ''
    assert entity.visual_match == 'none'


def test_matching_is_resolved_once_per_catalogue_and_not_per_tick():
    store = SourceRecords()
    epoch = satellite_record(store, name='STARLINK-1008', norad=44713)
    resolver = matcher()
    calls = []
    original = resolver.resolve
    resolver.resolve = lambda *args, **kwargs: (calls.append(1), original(*args, **kwargs))[1]
    sync = LiveSynchronizer(matcher=resolver)
    for step in range(5):
        entities = sync.synchronize(store.records(), epoch + 60 + step)
    assert entities[0].visual_asset_id == 'starlink_flat'
    assert len(calls) == 1


def test_aircraft_keep_their_representative_model_and_say_so():
    store = SourceRecords()
    store.register('test', [dict(id='abc', name='TEST', latitude=37.0, longitude=127.0, altitude_m=1000,
                                 track_deg=90, speed_mps=100, vertical_rate_mps=0, observed_at=100)],
                   101, format='aircraft_v1')
    entity = LiveSynchronizer().synchronize(store.records(), 100)[0]
    assert entity.visual_asset_id == 'amvlab_a320'
    assert entity.visual_match == 'representative', 'provider states carry no aircraft type'


@pytest.mark.parametrize('name,kind', [
    ('FLOCK 4X-12', 'cubesat'), ('SPACEBEE-134', 'cubesat'), ('DOVE PIONEER', 'cubesat'),
    ('SL-16 R/B', 'rocket'), ('IRIDIUM 33 DEB', 'debris'), ('TERRA', 'payload')])
def test_object_kind_classification(name, kind):
    assert matcher().resolve(name).kind == kind
