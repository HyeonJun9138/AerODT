"""Read a locally saved GP catalogue without changing its collection timestamp."""
import gzip
import json
from datetime import datetime
from pathlib import Path
from data.ingestion.source_records import SourceRecord, freeze


def load_saved_gp(path):
    with gzip.open(Path(path), 'rt', encoding='utf-8') as stream:
        document = json.load(stream)
    fetched = datetime.fromisoformat(document['fetched_at'].replace('Z', '+00:00'))
    if fetched.tzinfo is None or not isinstance(document['items'], list) or not document['items']:
        raise ValueError('Invalid saved GP catalogue')
    return SourceRecord('celestrak_saved', freeze(document['items']), fetched.timestamp(), 'celestrak_gp', 'cached')
