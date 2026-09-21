"""Raw ingress ownership. The optional disk cache is never a current twin state."""
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType


def freeze(value):
    if isinstance(value, dict):
        return MappingProxyType({key: freeze(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(freeze(item) for item in value)
    return value


@dataclass(frozen=True)
class SourceRecord:
    source: str
    payload: object
    received_time: float
    format: str
    provenance: str


class SourceRecords:
    def __init__(self, cache_directory=None):
        self._records = {}
        self._cache_directory = Path(cache_directory) if cache_directory else None

    def register(self, source, payload, received_time, *, format, provenance="live", persist=False):
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", source) or not math.isfinite(received_time):
            raise ValueError("Invalid source identifier or timestamp")
        old = self._records.get(source)
        if old and old.received_time > received_time:
            return old
        record = SourceRecord(source, freeze(payload), float(received_time), format, provenance)
        if persist and self._cache_directory:
            self._cache_directory.mkdir(parents=True, exist_ok=True)
            path = self._cache_directory / f"{source}.json"
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps(dict(source=source, payload=payload,
                received_time=received_time, format=format, provenance=provenance),
                ensure_ascii=False, allow_nan=False), encoding="utf-8")
            temporary.replace(path)
        self._records[source] = record
        return record

    def latest(self, source):
        return self._records.get(source)

    def records(self):
        return tuple(self._records.values())

    def discard(self, source):
        """Forget a source's raw record. A live provider that replaces a saved
        bootstrap uses this so the same objects are not carried by both."""
        return self._records.pop(source, None) is not None

    def restore(self, source):
        if not self._cache_directory:
            return None
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", source):
            raise ValueError("Invalid source identifier")
        path = self._cache_directory / f"{source}.json"
        if not path.exists():
            return None
        record = json.loads(path.read_text(encoding="utf-8"))
        if record["source"] != source:
            raise ValueError("Source mismatch in cache")
        return self.register(**record)
