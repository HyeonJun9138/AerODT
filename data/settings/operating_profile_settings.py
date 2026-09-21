"""Data owns the file the pilot's operating speeds live in.

Only a validated profile is written, and a damaged file reads as "nothing set
yet" rather than stopping the dashboard: a flight can always be built to the
operating figures' own values.
"""
import json
import os
from pathlib import Path


class OperatingProfileSettings:
    def __init__(self, path):
        self._path = Path(path)

    def read(self):
        from digital_twin.model_library import uam_operating_profile
        try:
            content = json.loads(self._path.read_text(encoding="utf-8"))
            return uam_operating_profile.validate(content)
        except (OSError, ValueError, TypeError):
            return uam_operating_profile.defaults()

    def write(self, profile):
        from digital_twin.model_library import uam_operating_profile
        settled = uam_operating_profile.validate(profile, base=self.read())
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(".tmp")
        temporary.write_text(json.dumps(settled, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, self._path)
        return settled

    def reset(self):
        from digital_twin.model_library import uam_operating_profile
        return self.write(uam_operating_profile.defaults())
