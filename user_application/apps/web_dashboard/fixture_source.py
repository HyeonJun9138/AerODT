"""Explicit test-only external-source surrogate; never used by default."""
import math
import time
from datetime import datetime, timezone


class AircraftFixture:
    def __init__(self, now=time.time):
        self.now = now

    async def fetch(self):
        timestamp = self.now()
        aircraft = []
        for index, (lat, lon) in enumerate(((37.4, 126.6), (35.5, 139.5), (34, 118))):
            angle = (timestamp % 3600) / 3600 * 2 * math.pi + index
            aircraft.append(dict(id=f"test{index}", name=f"TEST AIRCRAFT {index + 1}",
                latitude=lat + .5 * math.sin(angle), longitude=lon + .5 * math.cos(angle),
                altitude_m=8000 + index * 1000, speed_mps=90, track_deg=(-math.degrees(angle)) % 360,
                vertical_rate_mps=0, observed_at=timestamp))
        return aircraft


class SatelliteFixture:
    """Artificial GP elements for UI validation, not real satellites or telemetry."""
    def __init__(self, now=time.time, count=24):
        self.now = now
        if not isinstance(count, int) or not 1 <= count <= 20000:
            raise ValueError('Fixture count must be 1..20000')
        self.count = count

    async def fetch(self):
        epoch = datetime.fromtimestamp(self.now(), timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')
        return [dict(OBJECT_NAME=f'TEST SATELLITE {index + 1}', OBJECT_ID='2026-000A',
            NORAD_CAT_ID=900001+index, EPOCH=epoch, MEAN_MOTION=15.2, ECCENTRICITY=.001,
            INCLINATION=53 if index % 2 else 97.6, RA_OF_ASC_NODE=(index*111.246117)%360,
            ARG_OF_PERICENTER=0, MEAN_ANOMALY=(index*137.507764)%360, EPHEMERIS_TYPE=0,
            CLASSIFICATION_TYPE='U', ELEMENT_SET_NO=1, REV_AT_EPOCH=0, BSTAR=0,
            MEAN_MOTION_DOT=0, MEAN_MOTION_DDOT=0) for index in range(self.count)]
