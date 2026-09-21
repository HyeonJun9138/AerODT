"""Simulation data storage: the flights that were run, and replaying them.

A run is what the simulation engine produced — the plan it flew and the state
of the vehicle at every tick — kept on disk so it outlives the page that asked
for it. This is the same shelf a live flight's states would land on; the only
difference is who put them there.

Each run is its own folder: a manifest that can be listed cheaply, and the
states beside it as one line each, so replaying reads a file rather than
re-running a simulation, and a long run does not have to be held in memory to
be listed. Storage only: nothing here flies anything or decides what a state
means.
"""
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1
MANIFEST = "manifest.json"
STATES = "states.jsonl"
PLAN = "plan.json"


def _now():
    return datetime.now(timezone.utc)


class FlightRuns:
    """The stored simulation runs under `directory`."""

    def __init__(self, directory):
        self.directory = Path(directory)

    # ---- writing ----------------------------------------------------------
    def create(self, plan, states, summary, *, label=None, clock=_now):
        """Keep one run and answer its manifest. The states are written first
        and the manifest last, so a run that is being listed is a run that is
        complete: a crash half way through leaves a folder without a manifest,
        which `list` skips rather than reporting as a short flight."""
        stamp = clock()
        run_id = f"{stamp:%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex[:8]}"
        folder = self.directory / run_id
        folder.mkdir(parents=True, exist_ok=True)
        with open(folder / STATES, "w", encoding="utf-8", newline="\n") as file:
            for state in states:
                file.write(json.dumps(state, ensure_ascii=False) + "\n")
        (folder / PLAN).write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
        departure, arrival = plan.get("departure") or {}, plan.get("arrival") or {}
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "run_id": run_id,
            # To the microsecond: two runs asked for in the same second still
            # order, and `list` sorts by this rather than by the random suffix
            # the folder name ends with.
            "created_at": stamp.isoformat().replace("+00:00", "Z"),
            "label": label or f"{departure.get('name', '')} → {arrival.get('name', '')}".strip(" →"),
            "vehicle": plan.get("vehicle") or {},
            "departure": departure,
            "arrival": arrival,
            "totals": plan.get("totals") or {},
            "summary": dict(summary or {}),
        }
        (folder / MANIFEST).write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        return manifest

    # ---- reading ----------------------------------------------------------
    def list(self):
        """Every complete run, newest first."""
        found = []
        try:
            entries = os.listdir(self.directory)
        except OSError:
            return []
        for name in entries:
            manifest = self._manifest(name)
            if manifest is not None:
                found.append(manifest)
        found.sort(key=lambda item: (str(item.get("created_at") or ""), str(item.get("run_id") or "")),
                   reverse=True)
        return found

    def _manifest(self, run_id):
        try:
            return json.loads((self.directory / run_id / MANIFEST).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def get(self, run_id):
        """One run's manifest, or None."""
        return self._manifest(run_id) if self._safe(run_id) else None

    def plan(self, run_id):
        """The plan that was flown, or None."""
        if not self._safe(run_id):
            return None
        try:
            return json.loads((self.directory / run_id / PLAN).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def states(self, run_id, *, since=None, until=None, limit=None):
        """The states of a run, optionally the window between two times. Read a
        line at a time, so asking for ten seconds of a long flight does not
        pull the whole thing into memory."""
        if not self._safe(run_id):
            return []
        found = []
        try:
            with open(self.directory / run_id / STATES, encoding="utf-8") as file:
                for line in file:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        state = json.loads(line)
                    except ValueError:
                        continue
                    time = state.get("t")
                    if since is not None and time is not None and time < since:
                        continue
                    if until is not None and time is not None and time > until:
                        break
                    found.append(state)
                    if limit is not None and len(found) >= limit:
                        break
        except OSError:
            return []
        return found

    def delete(self, run_id):
        """Remove one run; True when there was one."""
        if not self._safe(run_id):
            return False
        folder = self.directory / run_id
        if not folder.is_dir():
            return False
        for name in (MANIFEST, STATES, PLAN):
            try:
                (folder / name).unlink()
            except OSError:
                pass
        try:
            folder.rmdir()
        except OSError:
            return False
        return True

    # A run id names a folder, so it may not reach outside the shelf.
    @staticmethod
    def _safe(run_id):
        text = str(run_id or "")
        return bool(text) and "/" not in text and "\\" not in text and not text.startswith(".")
