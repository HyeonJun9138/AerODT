"""User-authored vertiport definitions on disk. Definitions only; never layouts.

The Data layer owns the file. Layouts are derived by the model library on read,
so a dimension change never leaves stale geometry behind.
"""
import json
import threading
from datetime import datetime, timezone
from pathlib import Path

from .identifiers import highest, number_of, numbered

# Vertiports are numbered VP001 upwards; see identifiers.numbered for why a
# deleted number is never handed out again.
ID_PREFIX = "VP"


class VertiportRecords:
    def __init__(self, path):
        self._path = Path(path)
        self._lock = threading.Lock()
        self._records, self._issued = self._load()
        # How many times this store has saved since it was opened. Every
        # change goes through `_save`, so a reader that remembers what it
        # derived from the records can tell, for nothing, whether they moved.
        self.version = 0

    def _load(self):
        if not self._path.is_file():
            return [], 0
        try:
            document = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return [], 0
        items = document.get("vertiports") if isinstance(document, dict) else None
        records = [dict(item) for item in items if isinstance(item, dict) and item.get("id")] if items else []
        # The highest number ever handed out. A file written before this was
        # kept - or edited by hand - falls back to the highest still present,
        # which is the best that can be known from the records alone.
        issued = document.get("id_sequence") if isinstance(document, dict) else None
        return records, max(int(issued) if isinstance(issued, int) else 0, highest(ID_PREFIX, (item["id"] for item in records)))

    def _save(self):
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"schema_version": 1, "id_sequence": self._issued, "vertiports": self._records},
                                        ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self._path)
        self.version += 1

    @staticmethod
    def _now():
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    def list(self):
        with self._lock:
            return [dict(item) for item in self._records]

    def get(self, identifier):
        with self._lock:
            return next((dict(item) for item in self._records if item["id"] == identifier), None)

    def create(self, definition):
        with self._lock:
            record = dict(definition)
            record["id"] = numbered(ID_PREFIX, (item["id"] for item in self._records), issued=self._issued)
            self._issued = number_of(ID_PREFIX, record["id"])
            record["created_at"] = record["updated_at"] = self._now()
            self._records.append(record)
            self._save()
            return dict(record)

    def merge(self, records):
        """Insert or replace whole records by the id they carry, for importing a
        set authored somewhere else. Unlike `create` the id comes from the caller,
        which is what lets the same source be imported again onto itself. Returns
        (added, replaced)."""
        with self._lock:
            added = replaced = 0
            for given in records:
                record = dict(given)
                identifier = str(record.get("id") or "").strip()
                if not identifier:
                    continue
                record["id"] = identifier
                record["updated_at"] = self._now()
                for index, item in enumerate(self._records):
                    if item["id"] == identifier:
                        record["created_at"] = item.get("created_at", record.get("created_at") or self._now())
                        self._records[index] = record
                        replaced += 1
                        break
                else:
                    record.setdefault("created_at", record["updated_at"])
                    self._records.append(record)
                    added += 1
            # Numbers that arrived with an import are spoken for as surely as
            # ones this store issued.
            self._issued = max(self._issued, highest(ID_PREFIX, (item["id"] for item in self._records)))
            if added or replaced:
                self._save()
            return added, replaced

    def update(self, identifier, definition):
        with self._lock:
            for index, item in enumerate(self._records):
                if item["id"] == identifier:
                    record = dict(definition, id=identifier, created_at=item.get("created_at", self._now()),
                                  updated_at=self._now())
                    self._records[index] = record
                    self._save()
                    return dict(record)
            return None

    def delete(self, identifier):
        with self._lock:
            before = len(self._records)
            self._records = [item for item in self._records if item["id"] != identifier]
            if len(self._records) == before:
                return False
            self._save()
            return True
