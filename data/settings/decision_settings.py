"""Where the operator's decision-chart values are kept.

The same shape as the source settings beside it, and for the same reason: a
damaged file is "nothing saved yet" rather than a fatal error, because a
rehearsal must still start. What is written here has already been checked
against the charts by the caller - this layer keeps files, it does not know
what a landing separation is.
"""
import json
import os
from pathlib import Path


class DecisionSettings:
    def __init__(self, path):
        self._path = Path(path)

    def read(self):
        """What was saved, or an empty answer. Never raises."""
        try:
            content = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return {}
        return content if isinstance(content, dict) else {}

    def write(self, values):
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(".tmp")
        temporary.write_text(json.dumps(values, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, self._path)
        return values

    def clear(self):
        """Back to the values the code was written with, permanently.

        The file is removed rather than filled with the defaults, so a default
        that changes later reaches an operator who never overrode it.
        """
        try:
            self._path.unlink()
        except OSError:
            pass
        return {}
