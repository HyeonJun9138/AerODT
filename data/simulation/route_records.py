"""User-authored route nodes and links on disk. Definitions only.

The Data layer owns the file. FATO endpoints are not stored here: they are
derived from the vertiports whenever the network is read, so a vertiport edit
never leaves a stale endpoint behind.
"""
import json
import threading
from datetime import datetime, timezone
from pathlib import Path

from .identifiers import highest, number_of, numbered, random_id

# Waypoints carry on the stored WP numbering. Links have never been numbered -
# nothing names one by hand and there are hundreds of them - so they keep the
# random style rather than gaining a numbering nobody reads.
NODE_ID_PREFIX = "WP"
LINK_ID_PREFIX = "rl"


class RouteRecords:
    def __init__(self, path):
        self._path = Path(path)
        self._lock = threading.Lock()
        self._nodes, self._links, self._issued = self._load()
        # How many times this store has saved since it was opened. Every
        # change goes through `_save`, so a reader that remembers what it
        # derived from the records can tell, for nothing, whether they moved.
        self.version = 0

    def _load(self):
        if not self._path.is_file():
            return [], [], 0
        try:
            document = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return [], [], 0
        if not isinstance(document, dict):
            return [], [], 0

        def items(key):
            values = document.get(key)
            return [dict(item) for item in values if isinstance(item, dict) and item.get("id")] if isinstance(values, list) else []
        nodes = items("nodes")
        # The highest waypoint number ever handed out; a file written before
        # this was kept falls back to the highest still present.
        issued = document.get("node_id_sequence")
        return nodes, items("links"), max(int(issued) if isinstance(issued, int) else 0,
                                          highest(NODE_ID_PREFIX, (item["id"] for item in nodes)))

    def _save(self):
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"schema_version": 1, "node_id_sequence": self._issued,
                                         "nodes": self._nodes, "links": self._links},
                                        ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self._path)
        self.version += 1

    @staticmethod
    def _now():
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    def nodes(self):
        with self._lock:
            return [dict(item) for item in self._nodes]

    def links(self):
        with self._lock:
            return [dict(item) for item in self._links]

    def node(self, identifier):
        with self._lock:
            return next((dict(item) for item in self._nodes if item["id"] == identifier), None)

    def link(self, identifier):
        with self._lock:
            return next((dict(item) for item in self._links if item["id"] == identifier), None)

    def _create(self, items, identify, definition):
        record = dict(definition)
        record["id"] = identify(item["id"] for item in items)
        record["created_at"] = record["updated_at"] = self._now()
        items.append(record)
        self._save()
        return dict(record)

    def _update(self, items, identifier, definition):
        for index, item in enumerate(items):
            if item["id"] == identifier:
                record = dict(definition, id=identifier, created_at=item.get("created_at", self._now()), updated_at=self._now())
                items[index] = record
                self._save()
                return dict(record)
        return None

    def _merge(self, items, records):
        added = replaced = 0
        for given in records:
            record = dict(given)
            identifier = str(record.get("id") or "").strip()
            if not identifier:
                continue
            record["id"] = identifier
            record["updated_at"] = self._now()
            for index, item in enumerate(items):
                if item["id"] == identifier:
                    record["created_at"] = item.get("created_at", record.get("created_at") or self._now())
                    items[index] = record
                    replaced += 1
                    break
            else:
                record.setdefault("created_at", record["updated_at"])
                items.append(record)
                added += 1
        return added, replaced

    def merge(self, nodes=(), links=()):
        """Insert or replace nodes and links by the id they carry, for importing a
        network authored somewhere else. Nodes go in first so a link can name one
        of them. Returns {'nodes': (added, replaced), 'links': (added, replaced)}."""
        with self._lock:
            counts = {"nodes": self._merge(self._nodes, nodes), "links": self._merge(self._links, links)}
            # Numbers that arrived with an import are spoken for as surely as
            # ones this store issued.
            self._issued = max(self._issued, highest(NODE_ID_PREFIX, (item["id"] for item in self._nodes)))
            if any(sum(pair) for pair in counts.values()):
                self._save()
            return counts

    def create_node(self, definition):
        with self._lock:
            # The number is taken, and the mark raised, before the record is
            # written: one save, and the mark never trails the id on disk.
            identifier = numbered(NODE_ID_PREFIX, (item["id"] for item in self._nodes), issued=self._issued)
            self._issued = number_of(NODE_ID_PREFIX, identifier)
            return self._create(self._nodes, lambda _ids: identifier, definition)

    def update_node(self, identifier, definition):
        with self._lock:
            return self._update(self._nodes, identifier, definition)

    def delete_node(self, identifier):
        """Removes the node and every link that touched it; returns how many links went."""
        with self._lock:
            before = len(self._nodes)
            self._nodes = [item for item in self._nodes if item["id"] != identifier]
            if len(self._nodes) == before:
                return None
            links_before = len(self._links)
            self._links = [item for item in self._links if identifier not in (item.get("from"), item.get("to"))]
            self._save()
            return links_before - len(self._links)

    def create_link(self, definition):
        with self._lock:
            return self._create(self._links, lambda _ids: random_id(LINK_ID_PREFIX), definition)

    def update_link(self, identifier, definition):
        with self._lock:
            return self._update(self._links, identifier, definition)

    def delete_link(self, identifier):
        with self._lock:
            before = len(self._links)
            self._links = [item for item in self._links if item["id"] != identifier]
            if len(self._links) == before:
                return False
            self._save()
            return True
