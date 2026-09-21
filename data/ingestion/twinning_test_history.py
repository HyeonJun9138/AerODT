"""Bounded past observations for inspection charts, never current state."""
from collections import deque
import math


class TwinningTestHistory:
    def __init__(self):
        self.rows = deque(maxlen=1200)

    def clear(self):
        self.rows.clear()

    def observe(self, message, updates, now):
        if not updates:
            return
        a, g, attitude = updates.get('acceleration'), updates.get('gps'), updates.get('attitude')
        row = {'time_s': now, 'seq': message.seq,
               'attitude': [attitude.roll_deg, attitude.pitch_deg, attitude.yaw_deg] if attitude else None,
               'acceleration': [a.x_mps2, a.y_mps2, a.z_mps2] if a else None,
               'gps': [g.longitude_deg, g.latitude_deg, g.altitude_m] if g else None}
        # Merge bursts into an actual last-received point, never interpolate sensors.
        if self.rows and math.floor(now*20) == math.floor(self.rows[-1]['time_s']*20):
            previous = self.rows.pop()
            for key in ('attitude', 'acceleration', 'gps'):
                if row[key] is None:
                    row[key] = previous[key]
        self.rows.append(row)
        self._trim(now)

    def _trim(self, now):
        while self.rows and self.rows[0]['time_s'] < now-60:
            self.rows.popleft()

    def read(self, now, session_id):
        self._trim(now)
        return {'session_id': session_id, 'seconds': 60, 'now_s': now,
                'rows': [{**row, **{key: list(row[key]) if row[key] is not None else None
                                    for key in ('attitude', 'acceleration', 'gps')}} for row in self.rows]}
