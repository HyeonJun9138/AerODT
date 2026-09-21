import gzip
import json
from data.ingestion.saved_gp import load_saved_gp


def test_saved_gp_preserves_collection_time_and_marks_cached(tmp_path):
    path = tmp_path / 'active.json.gz'
    with gzip.open(path, 'wt', encoding='utf8') as stream:
        json.dump({'fetched_at':'2026-09-07T10:57:23+00:00','items':[{'NORAD_CAT_ID':25544}]}, stream)
    record = load_saved_gp(path)
    assert record.provenance == 'cached'
    assert record.received_time == 1788778643
    assert record.payload[0]['NORAD_CAT_ID'] == 25544
