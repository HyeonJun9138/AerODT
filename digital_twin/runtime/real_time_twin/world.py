"""The sole authority for this web runtime's current live entity state."""
import math
from digital_twin.contracts.live import Snapshot


class TwinWorld:
    def __init__(self):
        self._snapshot = Snapshot(1, 0, 0.0, (), (), 0)

    def replace(self, entities, state_time, sources):
        """The next instant of the run the twin is already on.

        Time rises and never falls. That is a guarantee about drift, not a claim
        that the twin only ever looks at now: an instant earlier than the last
        one, inside the same run, means a source arrived late or an estimate was
        corrected backwards, and neither may be shown.
        """
        if not math.isfinite(state_time) or state_time < self._snapshot.state_time:
            raise ValueError("Twin state time must be finite and monotonic")
        return self._commit(entities, state_time, sources, self._snapshot.epoch)

    def rebase(self, entities, state_time, sources):
        """Move the twin to a different instant on purpose.

        An operator replaying a scheduled day is deliberately looking at another
        date, and coming back afterwards is just as deliberate. Both are allowed,
        both are said — the epoch changes — and neither is confused with a clock
        that slipped.
        """
        if not math.isfinite(state_time):
            raise ValueError("Twin state time must be finite and monotonic")
        return self._commit(entities, state_time, sources, self._snapshot.epoch + 1)

    def _commit(self, entities, state_time, sources, epoch):
        entities = tuple(entities)
        if len({entity.entity_id for entity in entities}) != len(entities):
            raise ValueError("Duplicate entity ID")
        if any(not all(math.isfinite(x) for x in entity.position_ecef_m) for entity in entities):
            raise ValueError("Non-finite entity position")
        self._snapshot = Snapshot(1, self._snapshot.sequence + 1, state_time,
                                  entities, tuple(sources), epoch)
        return self._snapshot

    def snapshot(self):
        return self._snapshot
