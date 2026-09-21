"""Data owns the file the operator's source settings live in.

Only validated settings are written, and a damaged file is treated as "no
settings yet" rather than a fatal error: acquisition must still start.
"""
import json
import os
from pathlib import Path


class SourceSettings:
    def __init__(self, path):
        self._path = Path(path)

    def read(self):
        from user_application.apps.web_dashboard.library_settings import validate_settings
        try:
            content = json.loads(self._path.read_text(encoding="utf-8"))
            return validate_settings(content)
        except (OSError, ValueError, TypeError):
            return validate_settings({})

    def write(self, settings):
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(".tmp")
        temporary.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, self._path)
        return settings
