"""Bounded saved public display tiles, never credentials or current twin state.

Communication supplies an opaque versioned key and already-compressed bytes.
Data owns atomic files, expiry, corruption checks and disk eviction. Call these
blocking methods from a worker, not the web event loop.
"""
import hashlib
import os
import re
import struct
import tempfile
import threading
import time
from pathlib import Path

HEADER = struct.Struct("<8sdI32s")
MAGIC = b"AEROVW1\0"
NAME = re.compile(r"[0-9a-f]{64}\.vwcache")


class VWorldTileRecords:
    def __init__(self, directory, *, max_bytes=256 * 1024 * 1024, max_entries=2048,
                 max_entry_bytes=48 * 1024 * 1024, clock=time.time):
        self.directory = Path(directory).resolve()
        self.max_bytes = max_bytes
        self.max_entries = max_entries
        self.max_entry_bytes = max_entry_bytes
        self.clock = clock
        self.lock = threading.Lock()

    def _path(self, key):
        return self.directory / (hashlib.sha256(key.encode()).hexdigest() + ".vwcache")

    def _remove(self, path):
        # Only files owned by this cache; never follow links or delete trees.
        if path.parent.resolve() == self.directory and NAME.fullmatch(path.name) and not path.is_symlink():
            path.unlink(missing_ok=True)

    def get(self, key):
        path = self._path(key)
        try:
            with self.lock:
                if path.is_symlink():
                    return None
                with path.open("rb") as stream:
                    magic, expires, size, digest = HEADER.unpack(stream.read(HEADER.size))
                    remaining = expires - self.clock()
                    valid = magic == MAGIC and 0 < remaining <= 3600 and size <= self.max_entry_bytes
                    data = stream.read(size + 1) if valid else b""
                if not valid or len(data) != size or hashlib.sha256(data).digest() != digest:
                    self._remove(path)
                    return None
                os.utime(path, None)  # LRU; expiry remains in the header.
                return data, remaining
        except (OSError, ValueError, struct.error):
            return None

    def put(self, key, data, ttl=3600):
        if not 0 < ttl <= 3600 or len(data) > self.max_entry_bytes or len(data) + HEADER.size > self.max_bytes:
            return
        temporary = None
        try:
            with self.lock:
                self.directory.mkdir(parents=True, exist_ok=True)
                header = HEADER.pack(MAGIC, self.clock() + ttl, len(data), hashlib.sha256(data).digest())
                # Only our abandoned staging files, never arbitrary workspace
                # files. Fresh staging files may belong to another process.
                for path in self.directory.glob('vworld_tile_*.tmp'):
                    if path.parent.resolve() == self.directory and not path.is_symlink() and path.stat().st_mtime < time.time() - 3600:
                        path.unlink(missing_ok=True)
                with tempfile.NamedTemporaryFile(dir=self.directory, prefix="vworld_tile_", suffix=".tmp", delete=False) as stream:
                    temporary = Path(stream.name)
                    stream.write(header)
                    stream.write(data)
                os.replace(temporary, self._path(key))
                temporary = None
                entries = []
                for path in self.directory.glob("*.vwcache"):
                    if NAME.fullmatch(path.name) and not path.is_symlink():
                        stat = path.stat()
                        entries.append((stat.st_mtime_ns, path, stat.st_size))
                size = sum(item[2] for item in entries)
                count = len(entries)
                for _, path, amount in sorted(entries):
                    if size <= self.max_bytes and count <= self.max_entries:
                        break
                    self._remove(path)
                    size -= amount
                    count -= 1
        except OSError:
            pass  # An unwritable/full cache must never break the live map.
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass
