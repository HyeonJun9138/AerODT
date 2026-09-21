"""Bounded observations for active manual runs; never owns a physical runtime."""
from collections import deque
from copy import deepcopy
from threading import Lock


class ManualPredictionHistory:
    def __init__(self):
        self._runs = {}
        self._lock = Lock()

    def open(self, run_id, plan):
        with self._lock:
            self._runs[run_id] = (deepcopy(plan), deque(maxlen=4096))

    def append(self, run_id, sample):
        with self._lock:
            entry = self._runs.get(run_id)
            if entry is None:
                return
            rows = entry[1]
            t = sample['time_s']
            if rows and t <= rows[-1]['t']:
                return
            rows.append(dict(t=t, **sample['position'], **{
                key: sample.get(key) for key in ('heading_deg', 'pitch_deg', 'roll_deg',
                'tilt_deg', 'rotor_radps', 'speed_mps', 'stage')}))
            while rows and rows[0]['t'] < t - 45:
                rows.popleft()

    def read(self, run_id, seconds):
        with self._lock:
            entry = self._runs.get(run_id)
            if entry is None:
                return None
            return deepcopy(entry[0]), [dict(row) for row in entry[1]
                                      if max(0, seconds - 40) <= row['t'] <= seconds]

    def close(self, run_id):
        with self._lock:
            self._runs.pop(run_id, None)
