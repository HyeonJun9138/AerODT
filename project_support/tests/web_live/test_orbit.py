import math
from sgp4.api import Satrec
from sgp4.exporter import export_omm

from data.ingestion.source_records import SourceRecords
from digital_twin.live_twin.state_synchronization import LiveSynchronizer
from foundation.geodesy import to_ecef, from_ecef


def test_sgp4_position_uses_real_epoch_not_receipt_timestamp():
    sat = Satrec.twoline2rv(
        '1 25544U 98067A   19343.69339541  .00001764  00000-0  38792-4 0  9991',
        '2 25544  51.6439 211.2001 0007417  17.6667  85.6398 15.50103472202482')
    epoch = (sat.jdsatepoch + sat.jdsatepochF - 2440587.5) * 86400
    records = SourceRecords()
    records.register('test_gp', [export_omm(sat, 'ISS')], epoch + 100, format='celestrak_gp')
    entity = LiveSynchronizer().synchronize(records.records(), epoch + 101)[0]
    assert entity.derivation == 'gp_propagated' and entity.observation_time is None
    assert abs(entity.orbit_epoch - epoch) < .01
    assert 350000 < entity.altitude_m < 500000
    assert 6000 < math.sqrt(sum(v*v for v in entity.velocity_ecef_mps)) < 9000
    old = LiveSynchronizer().synchronize(records.records(), epoch + 86400 * 10)[0]
    assert old.quality == 'stale'


def test_ecef_roundtrip_at_poles_and_dateline():
    for lat, lon, alt in [(37,127,1000), (89.999,180,400000), (-90,0,10), (0,-180,0)]:
        out = from_ecef(to_ecef(lat,lon,alt))
        assert abs(out[0] - lat) < 1e-7
        assert abs(out[2] - alt) < .01


def test_gp_far_in_future_is_not_claimed_valid():
    sat = Satrec.twoline2rv(
        '1 25544U 98067A   19343.69339541  .00001764  00000-0  38792-4 0  9991',
        '2 25544  51.6439 211.2001 0007417  17.6667  85.6398 15.50103472202482')
    epoch = (sat.jdsatepoch + sat.jdsatepochF - 2440587.5) * 86400
    records = SourceRecords()
    records.register('gp', [export_omm(sat, 'ISS')], epoch, format='celestrak_gp')
    assert LiveSynchronizer().synchronize(records.records(), epoch - 30*86400) == ()
