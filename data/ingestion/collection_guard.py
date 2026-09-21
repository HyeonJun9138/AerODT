"""When each external source may next be asked, kept on disk.

A provider does not see processes, it sees an address. A restart, a second
dashboard, a validation run and another project on the same machine are one
client to CelesTrak, and this address was blocked once for exactly that: nothing
held the schedule outside a running process, so every restart was a fresh
request and every failure was retried by each instance on its own.

The schedule therefore lives in a file. Whoever is about to ask claims the slot
first, so a crash mid-request still holds it, and anyone else - including the
next run, minutes or days later - sees the claim. Storage only: what the waits
should be is the application's policy, and the HTTP is the communication layer's.
"""
import json
import os
import re
import time
from contextlib import contextmanager
from pathlib import Path

# Answers that will not come good by asking again: the address moved, the client
# is not welcome, or the resource is gone. CelesTrak's usage policy asks a client
# to stop and let a person look rather than keep knocking.
FATAL_STATUS_CODES = frozenset({301, 302, 303, 307, 308, 400, 401, 403, 404, 410, 451})
JOURNAL_LIMIT = 200
_SOURCE = re.compile(r"[a-zA-Z0-9_-]+")


class CollectionGuard:
    def __init__(self, path, clock=time.time, journal_limit=JOURNAL_LIMIT):
        self._path = Path(path)
        self._clock = clock
        self._journal_limit = journal_limit

    # -- reading -------------------------------------------------------------

    def _read(self):
        try:
            content = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"schema_version": 1, "sources": {}, "journal": []}
        if not isinstance(content, dict) or not isinstance(content.get("sources"), dict):
            return {"schema_version": 1, "sources": {}, "journal": []}
        content.setdefault("journal", [])
        return content

    def state(self, source):
        """What is known about one source. Empty when it has never been asked."""
        return dict(self._read()["sources"].get(source, {}))

    def journal(self, limit=JOURNAL_LIMIT):
        """The most recent attempts, newest last. This is what answers 'how
        often did we actually ask them?' after the fact."""
        return list(self._read()["journal"])[-max(0, int(limit)):]

    def stopped(self, source):
        """Why automatic collection is stopped, or None."""
        return self.state(source).get("stopped_reason") or None

    def seconds_until_allowed(self, source):
        """How long before this source may be asked. Infinite while stopped."""
        entry = self.state(source)
        if entry.get("stopped_reason"):
            return float("inf")
        return max(0.0, float(entry.get("next_allowed", 0)) - self._clock())

    # -- writing -------------------------------------------------------------

    @contextmanager
    def _locked(self):
        """A short exclusive hold, so two processes cannot both read the old
        schedule and write over each other's claim. Writes are sub-millisecond;
        a lock older than the timeout is treated as abandoned, because a crashed
        holder must never stop collection for good."""
        lock = self._path.with_suffix(".lock")
        self._path.parent.mkdir(parents=True, exist_ok=True)
        handle, deadline = None, time.monotonic() + 2.0
        while handle is None:
            try:
                handle = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                if time.monotonic() > deadline:
                    try:
                        lock.unlink()
                    except OSError:
                        pass
                    continue
                time.sleep(0.01)
            except OSError:
                break  # an unwritable directory must not stop collection either
        try:
            yield
        finally:
            if handle is not None:
                os.close(handle)
                try:
                    lock.unlink()
                except OSError:
                    pass

    def _write(self, source, changes, outcome=None, code=None):
        if not _SOURCE.fullmatch(source):
            raise ValueError("Invalid source identifier")
        with self._locked():
            content = self._read()
            entry = dict(content["sources"].get(source, {}))
            entry.update(changes)
            content["sources"][source] = entry
            if outcome:
                content["journal"] = (content["journal"] + [{
                    "at": round(self._clock(), 3), "source": source, "outcome": outcome,
                    **({"code": code} if code else {}),
                    "next_allowed": round(float(entry.get("next_allowed", 0)), 3),
                }])[-self._journal_limit:]
            temporary = self._path.with_suffix(".tmp")
            try:
                temporary.write_text(json.dumps(content, ensure_ascii=False, allow_nan=False),
                                     encoding="utf-8")
                temporary.replace(self._path)
            except OSError:
                # The schedule is a guard, not twin state. If it cannot be
                # written the caller still collects; it just loses the memory.
                pass
        return entry

    def claim(self, source, interval_seconds):
        """Take the next slot, or refuse. The claim is written before the
        request, so a process that dies mid-request still holds the interval."""
        if self.seconds_until_allowed(source) > 0:
            return False
        now = self._clock()
        self._write(source, {"last_attempt": round(now, 3),
                             "next_allowed": round(now + max(0.0, float(interval_seconds)), 3)},
                    outcome="attempt")
        return True

    def record_success(self, source, interval_seconds):
        now = self._clock()
        self._write(source, {"last_success": round(now, 3), "failures": 0, "stopped_reason": "",
                             "next_allowed": round(now + max(0.0, float(interval_seconds)), 3)},
                    outcome="success")

    def record_failure(self, source, delay_seconds, code=None):
        """Hold the source off for delay_seconds, or stop it for good when the
        answer is one that will not change by asking again."""
        now = self._clock()
        failures = int(self.state(source).get("failures", 0)) + 1
        changes = {"failures": failures,
                   "next_allowed": round(now + max(0.0, float(delay_seconds)), 3),
                   "last_failure": round(now, 3), "last_code": code or 0}
        if code in FATAL_STATUS_CODES:
            changes["stopped_reason"] = f"HTTP {code}"
        self._write(source, changes, outcome="failure", code=code)
        return changes.get("stopped_reason") or None

    def stop(self, source, reason):
        self._write(source, {"stopped_reason": str(reason)[:200]}, outcome="stopped")

    def resume(self, source):
        """The operator has looked and wants collection to start again."""
        self._write(source, {"stopped_reason": "", "failures": 0, "next_allowed": 0},
                    outcome="resumed")

    def validator(self, source):
        """The value to send back as If-Modified-Since, or empty."""
        return str(self.state(source).get("last_modified") or "")

    def record_validator(self, source, last_modified):
        if last_modified:
            self._write(source, {"last_modified": str(last_modified)[:100]})


class _Unguarded:
    """A source that never leaves the machine needs no schedule, and writing one
    for a five second fixture would churn the file and bury the journal."""

    def state(self, source):
        return {}

    def stopped(self, source):
        return None

    def seconds_until_allowed(self, source):
        return 0.0

    def claim(self, source, interval_seconds):
        return True

    def record_success(self, source, interval_seconds):
        pass

    def record_failure(self, source, delay_seconds, code=None):
        return None

    def resume(self, source):
        pass

    def validator(self, source):
        return ""

    def record_validator(self, source, last_modified):
        pass


UNGUARDED = _Unguarded()
