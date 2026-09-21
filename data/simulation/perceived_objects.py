"""Objects a camera's detector has placed in the world, reported by a viewer.

A browser watching an aircraft's camera runs the flying-object detector on the
image and, from the camera's pose and each box's apparent size, estimates where
the detected thing is. Those estimates arrive here. They are perception: a
direction that is fairly good and a range that is not, with the error stated.
Nothing in the twin's authoritative state is changed by them. They are kept
briefly so the risk predictor can list them beside the traffic it already knows
and feed its observation history with them, error and all, and they are gone as
soon as the camera stops seeing them.
"""
from __future__ import annotations

import math
import threading
import time

from digital_twin.contracts.live import TwinEntity

KINDS = ('bird', 'drone', 'uam', 'unknown')
# The visual the map draws for a perceived object of each kind.
ASSETS = {'bird': 'poly_flying_gull', 'drone': 'amvlab_drone', 'uam': 'joby_s4'}
MAX_OBJECTS = 32
# A sighting is current for this long after its report; the camera answers
# several times a second, so a track that has stopped being reported is gone
# from the risk picture within a couple of seconds.
TTL_S = 2.5
SIGMA_FLOOR_M, SIGMA_CEILING_M = 5., 500.


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _number(value, name, low, high):
    if not finite(value) or not low <= value <= high:
        raise ValueError(f'{name} 값이 범위를 벗어났습니다')
    return float(value)


def _text(value, name, limit):
    if not isinstance(value, str) or not value or len(value) > limit:
        raise ValueError(f'{name} 값이 올바르지 않습니다')
    return value


class PerceivedObjects:
    def __init__(self, *, clock=time.monotonic, ttl_s=TTL_S):
        self._clock = clock
        self._ttl = ttl_s
        self._lock = threading.Lock()
        self._objects = {}
        self._continuity = {}

    # ---- intake -----------------------------------------------------------
    def report(self, body, *, wall_time=None):
        """Validate one viewer's report and keep its objects. Returns them."""
        if not isinstance(body, dict):
            raise ValueError('JSON 객체가 필요합니다')
        own = _text(body.get('ownship_id'), 'ownship_id', 160)
        state_time = _number(body.get('state_time'), 'state_time', 0, 4e9)
        objects = body.get('objects')
        if not isinstance(objects, list) or len(objects) > MAX_OBJECTS:
            raise ValueError(f'objects 는 최대 {MAX_OBJECTS}개의 목록이어야 합니다')
        kept = []
        for raw in objects:
            if not isinstance(raw, dict):
                raise ValueError('objects 항목은 객체여야 합니다')
            track = _text(str(raw.get('track_id', '')), 'track_id', 64)
            kind = raw.get('kind') if raw.get('kind') in KINDS else 'unknown'
            position = raw.get('position_ecef_m')
            if not isinstance(position, (list, tuple)) or len(position) != 3 or not all(finite(v) for v in position):
                raise ValueError('position_ecef_m 는 유한한 3성분이어야 합니다')
            radius = math.hypot(*position)
            if not 6.2e6 <= radius <= 6.5e6:
                raise ValueError('position_ecef_m 가 지구 표면 근처가 아닙니다')
            velocity = raw.get('velocity_ecef_mps')
            if velocity is not None:
                if not isinstance(velocity, (list, tuple)) or len(velocity) != 3 or not all(finite(v) for v in velocity) \
                        or math.hypot(*velocity) > 200:
                    velocity = None
            heading = raw.get('heading_deg')
            heading = float(heading) % 360 if finite(heading) else None
            kept.append({
                'entity_id': f'perceived:{own}:{track}', 'own_id': own, 'track_id': track, 'kind': kind,
                'class_name': _text(str(raw.get('class_name', kind)), 'class_name', 40),
                'confidence': max(0., min(1., float(raw.get('confidence')) if finite(raw.get('confidence')) else 0.)),
                'latitude_deg': _number(raw.get('latitude_deg'), 'latitude_deg', -90, 90),
                'longitude_deg': _number(raw.get('longitude_deg'), 'longitude_deg', -180, 180),
                'altitude_m': _number(raw.get('altitude_m'), 'altitude_m', -500, 20000),
                'position_ecef_m': tuple(float(v) for v in position),
                'velocity_ecef_mps': tuple(float(v) for v in velocity) if velocity else None,
                'heading_deg': heading,
                'sigma_m': max(SIGMA_FLOOR_M, min(SIGMA_CEILING_M, float(raw.get('sigma_m')) if finite(raw.get('sigma_m')) else SIGMA_CEILING_M)),
                'range_m': float(raw.get('range_m')) if finite(raw.get('range_m')) else None,
                'sightings': int(raw.get('sightings')) if finite(raw.get('sightings')) else 1,
                'state_time': state_time,
                'received_at': wall_time if wall_time is not None else time.time(),
                'seen_at': self._clock(),
            })
        with self._lock:
            self._expire()
            for item in kept:
                key = item['entity_id']
                # A track keeps its continuity while it is reported; one that
                # went away and came back is a new track to the predictor.
                if key not in self._objects:
                    self._continuity[key] = self._continuity.get(key, 0) + 1
                item['continuity_id'] = self._continuity[key]
                self._objects[key] = item
        return kept

    def _expire(self):
        now = self._clock()
        for key in [k for k, v in self._objects.items() if now - v['seen_at'] > self._ttl]:
            del self._objects[key]

    # ---- reading ------------------------------------------------------------
    def current(self, own_id=None):
        with self._lock:
            self._expire()
            return [dict(v) for v in self._objects.values() if own_id is None or v['own_id'] == own_id]

    def entities(self, state_time=None):
        """The live objects as twin entities, for a snapshot the risk model reads.

        `valid_until` is the sighting's own expiry in twin time, so a stale
        sighting counts as stale by the same rule every other track is judged
        by; the source and provenance say it is a camera estimate.
        """
        result = []
        for item in self.current():
            result.append(TwinEntity(
                entity_id=item['entity_id'], name=f"{item['class_name']} 인식 #{item['track_id']}", kind=item['kind'],
                position_ecef_m=item['position_ecef_m'], velocity_ecef_mps=item['velocity_ecef_mps'],
                latitude_deg=item['latitude_deg'], longitude_deg=item['longitude_deg'], altitude_m=item['altitude_m'],
                heading_deg=item['heading_deg'], state_time=item['state_time'], observation_time=item['state_time'],
                received_time=item['received_at'], orbit_epoch=None, derivation='observed', quality='nominal',
                source='perception', model_id='flying_objects_v1', visual_asset_id=ASSETS.get(item['kind'], ''),
                provenance='camera_ai', orientation_source='ground_track' if item['heading_deg'] is not None else 'unavailable',
                visual_match='representative', valid_until=item['state_time'] + self._ttl,
                continuity_id=item['continuity_id']))
        return result

    def clear(self):
        with self._lock:
            self._objects.clear()
