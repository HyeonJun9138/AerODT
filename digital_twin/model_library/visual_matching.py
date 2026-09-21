"""Assign a representative 3D model to a catalogued object.

Display assignment only: a match says which shape is drawn, never that the real
vehicle was identified. Rules are static model-library data; the resolver holds
no runtime state and never reads transport, storage or the current twin state.
Assets awaiting a rights review are skipped, so an assignment is always a model
the library actually publishes.
"""
import json
import re
from dataclasses import dataclass
from pathlib import Path

DEFINITION = Path(__file__).resolve().parent / "visual_models/satellite_matching.json"
ORBIT_REGIMES = ("LEO", "MEO", "GEO", "HEO")


def load_satellite_matching(path=None):
    return json.loads(Path(path or DEFINITION).read_text(encoding="utf-8"))


@dataclass(frozen=True)
class ModelMatch:
    asset_id: str | None
    quality: str
    kind: str


def _compile(patterns):
    return tuple(re.compile(pattern, re.IGNORECASE) for pattern in patterns or ())


class SatelliteModelMatcher:
    """Pure resolver over the shipped rules; `available` filters unpublished assets."""

    def __init__(self, definition=None, available=None):
        definition = definition if definition is not None else load_satellite_matching()
        self.available = None if available is None else set(available)
        self._kinds = tuple((kind, _compile(patterns))
                            for kind, patterns in definition.get("object_kinds", {}).items())
        self._representatives = dict(definition.get("representatives", {}))
        self._rules = tuple({
            "asset_id": rule["asset_id"],
            "exact_norad": {str(value) for value in (rule.get("exact") or {}).get("norad", ())},
            "exact_names": _compile((rule.get("exact") or {}).get("names")),
            "series_norad": {str(value) for value in (rule.get("series") or {}).get("norad", ())},
            "series_names": _compile((rule.get("series") or {}).get("names")),
            "family_names": _compile((rule.get("family") or {}).get("names")),
        } for rule in definition.get("models", ()))

    def _usable(self, asset_id):
        return bool(asset_id) and (self.available is None or asset_id in self.available)

    def kind_of(self, name):
        for kind, patterns in self._kinds:
            if any(pattern.search(name) for pattern in patterns):
                return kind
        return "payload"

    def representative(self, kind, regime):
        if kind in ("station", "cubesat"):
            keys = (kind, "payload:LEO")
        else:
            regime = regime if regime in ORBIT_REGIMES else "LEO"
            keys = (f"payload:{regime}", "payload:LEO")
        for key in keys:
            entry = self._representatives.get(key)
            # A single asset or an ordered fallback chain: the first published one wins.
            for asset_id in ((entry,) if isinstance(entry, str) else tuple(entry or ())):
                if self._usable(asset_id):
                    return asset_id
        return None

    def resolve(self, name, norad=None, regime=None):
        name = str(name or "").strip()
        kind = self.kind_of(name)
        # Rocket bodies and fragments are deliberately left as points: no shipped
        # shape represents them, and reusing a satellite model would misinform.
        if kind in ("rocket", "debris"):
            return ModelMatch(None, "none", kind)
        number = None if norad is None else str(norad)
        regime = str(regime or "").upper()
        for stage, quality in (("exact", "exact"), ("series", "series"), ("family", "representative")):
            for rule in self._rules:
                if not self._usable(rule["asset_id"]):
                    continue
                numbers = rule.get(f"{stage}_norad") or ()
                patterns = rule[f"{stage}_names"]
                if (number is not None and number in numbers) or any(p.search(name) for p in patterns):
                    return ModelMatch(rule["asset_id"], quality, kind)
        return ModelMatch(self.representative(kind, regime), "representative", kind)
