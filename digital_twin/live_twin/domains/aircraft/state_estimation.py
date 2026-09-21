"""Interpret provider values here, not inside transport or rendering."""
import math
from collections.abc import Mapping


def aircraft_observations(record):
    if record.format == "aircraft_v1":
        candidates = record.payload
    elif record.format == "opensky_states":
        candidates = []
        if not isinstance(record.payload, Mapping):
            return
        rows = record.payload.get("states") or ()
        if not isinstance(rows, (list, tuple)):
            return
        for row in rows:
            if not isinstance(row, (list, tuple)) or len(row) < 14:
                continue
            # Reject missing geometric altitude: pressure altitude is not WGS84 height.
            candidates.append(dict(id=row[0], name=str(row[1] or row[0]).strip(),
                longitude=row[5], latitude=row[6], altitude_m=row[13],
                speed_mps=row[9], track_deg=row[10], vertical_rate_mps=row[11], observed_at=row[3]))
    else:
        return
    if not isinstance(candidates, (list, tuple)):
        return
    for item in candidates:
        try:
            if not isinstance(item, Mapping):
                continue
            fields = ("latitude", "longitude", "altitude_m", "speed_mps", "track_deg", "vertical_rate_mps", "observed_at")
            values = {key: float(item[key]) for key in fields}
            if not all(math.isfinite(value) for value in values.values()):
                continue
            if not (-90 <= values["latitude"] <= 90 and -180 <= values["longitude"] <= 180
                    and -1000 <= values["altitude_m"] <= 50000 and values["speed_mps"] >= 0):
                continue
            identifier = str(item["id"]).strip()
            if not identifier or len(identifier) > 100:
                continue
            yield dict(values, id=identifier, name=str(item.get("name") or identifier)[:120])
        except (KeyError, TypeError, ValueError):
            continue
