"""Sampled simulation distances, not predicted CPA or continuous collision proof.

Consumes detached state dictionaries and never changes the running world.
The minimum of each metric retains its own simultaneous distances and context.
"""
import copy
import json
import math
import os
import time
from itertools import combinations
from concurrent.futures import ThreadPoolExecutor

from data.python.aerodt.data.run_logger import RunLogger


class ProximityRecords:
    def __init__(self, workspace, scenario_id, policy):
        self.logger = RunLogger(workspace, 'scenario_proximity',
            {'scenario_id': scenario_id, 'policy': copy.deepcopy(policy),
             'source': 'simulation_state_samples', 'continuous_minimum_guaranteed': False})
        self.directory = self.logger.run_dir
        self.policy = copy.deepcopy(policy)
        self.scenario_id = scenario_id
        self.pairs, self.waits = {}, {}
        self.samples = self.invalid_states = 0
        self.last_time = None
        self.max_gap = 0.0
        self._last_flush = time.monotonic()
        self._closed = False
        self._writer = None
        self._checkpoint = None

    def observe(self, moment, states):
        if self._closed or not math.isfinite(moment) or (self.last_time is not None and moment <= self.last_time):
            return
        if self.last_time is not None:
            self.max_gap = max(self.max_gap, moment-self.last_time)
        self.last_time = moment
        self.samples += 1
        valid = []
        for s in states:
            try:
                lat, lon, alt = (float(s[k]) for k in ('latitude_deg','longitude_deg','altitude_m'))
                if not all(map(math.isfinite, (lat,lon,alt))) or not -90 <= lat <= 90 or not -180 <= lon <= 180:
                    raise ValueError('invalid position')
                if not s.get('aircraft_id'):
                    raise ValueError('missing identity')
            except (KeyError, TypeError, ValueError):
                self.invalid_states += 1
                continue
            self._wait(s.get('flight_id'), s['aircraft_id'], s.get('hold_seconds'), moment)
            # Spherical surface distance; 3D metric adds altitude difference.
            # This intentionally isn't mislabeled a precise ECEF distance.
            valid.append((s, math.radians(lat), math.radians(lon), alt))
        valid.sort(key=lambda row: row[0]['aircraft_id'])
        for (a,la,loa,aa),(b,lb,lob,ab) in combinations(valid,2):
            if a['aircraft_id'] == b['aircraft_id'] or not (a.get('airborne') or b.get('airborne')):
                continue
            hav = math.sin((la-lb)/2)**2 + math.cos(la)*math.cos(lb)*math.sin((loa-lob)/2)**2
            horizontal = 2*6371008.8*math.asin(math.sqrt(min(1,max(0,hav))))
            vertical = abs(aa-ab)
            spatial = math.hypot(horizontal,vertical)
            key = (a['aircraft_id'],b['aircraft_id'])
            row = self.pairs.setdefault(key, {'aircraft_ids': list(key), 'samples': 0})
            row['samples'] += 1
            for name, value in (('horizontal',horizontal),('vertical',vertical),('3d',spatial)):
                field = 'minimum_'+name
                if field not in row or value < row[field]['distance_m']:
                    row[field] = {'distance_m':value, 'time_s':moment,
                        'horizontal_m':horizontal,'vertical_m':vertical,'distance_3d_m':spatial,
                        'flight_ids':[a.get('flight_id'),b.get('flight_id')],
                        'phases':[a.get('phase'),b.get('phase')],
                        'positions':[[a['latitude_deg'],a['longitude_deg'],a['altitude_m']],
                                     [b['latitude_deg'],b['longitude_deg'],b['altitude_m']]]}
        # Serialize detached historical facts, not the running world. At most
        # one checkpoint is in flight; a slow disk cannot build a work queue.
        if self._checkpoint is not None and self._checkpoint.done():
            self._finish_checkpoint()
        if self._checkpoint is None and time.monotonic()-self._last_flush >= 30:
            content = self._checkpoint_content()
            if self._writer is None:
                self._writer = ThreadPoolExecutor(max_workers=1, thread_name_prefix='proximity-record')
            self._checkpoint = self._writer.submit(self._write_checkpoint, content)
            self._last_flush = time.monotonic()

    def _wait(self, flight_id, aircraft_id, seconds, moment):
        if not flight_id or not isinstance(seconds,(int,float)) or not math.isfinite(seconds) or seconds < 0:
            return
        row = self.waits.setdefault(flight_id, {'aircraft_id':aircraft_id,'reported_hold_seconds':0})
        row['reported_hold_seconds'] = max(row['reported_hold_seconds'],seconds)
        row['last_observed_s'] = moment

    def event(self, event):
        if event.get('kind') == 'touchdown':
            self._wait(event.get('flight_id'),event.get('aircraft_id'),event.get('hold_s'),event.get('time_s'))

    def _checkpoint_content(self):
        # Pair minima are replaced, never edited. Copy only the mutable outer
        # rows/counters and waits; no O(N²) deep copy inside the simulation lock.
        return {'schema_version':1,'scenario_id':self.scenario_id,'policy':self.policy,
            'source':'simulation_state_samples','continuous_minimum_guaranteed':False,
            'distance_method':'spherical_surface_haversine_and_altitude_hypot',
            'pair_scope':'aircraft_pairs_with_at_least_one_airborne; each minimum retains flight ids',
            'samples':self.samples,'last_sample_s':self.last_time,'max_sample_gap_s':self.max_gap,
            'invalid_states':self.invalid_states,'pairs':[dict(row) for row in self.pairs.values()],
            'flight_waits':{key:dict(row) for key,row in self.waits.items()}}

    def _finish_checkpoint(self):
        pending, self._checkpoint = self._checkpoint, None
        if pending is not None:
            pending.result()  # A write failure remains visible and retryable.

    def _write_checkpoint(self, content):
        path = self.directory/'proximity.json'
        temporary = path.with_suffix('.tmp')
        # One giant json.dumps still holds the GIL for hundreds of milliseconds,
        # even on a worker. Encode a pair at a time and stream to the same atomic
        # file format so physics and HTTP can run between bounded chunks.
        encode = json.JSONEncoder(ensure_ascii=False,allow_nan=False,separators=(',',':')).encode
        with temporary.open('w',encoding='utf-8') as stream:
            stream.write('{')
            for index,(key,value) in enumerate(content.items()):
                if index: stream.write(',')
                stream.write(encode(key)+':')
                if key == 'pairs':
                    stream.write('[')
                    for i,row in enumerate(value):
                        if i: stream.write(',')
                        stream.write(encode(row))
                    stream.write(']')
                elif key == 'flight_waits':
                    stream.write('{')
                    for i,(identifier,row) in enumerate(value.items()):
                        if i: stream.write(',')
                        stream.write(encode(identifier)+':'+encode(row))
                    stream.write('}')
                else:
                    stream.write(encode(value))
            stream.write('}')
        os.replace(temporary,path)

    def flush(self):
        # Explicit save/close waits, unlike the periodic checkpoint. Waiting
        # first prevents an older writer from replacing the final record.
        self._finish_checkpoint()
        self._write_checkpoint(self._checkpoint_content())
        self._last_flush = time.monotonic()

    def close(self):
        if not self._closed:
            try:
                self.flush()
                self.logger.finish('closed')
                self._closed = True
            finally:
                if self._writer is not None:
                    self._writer.shutdown(wait=True)
                    self._writer = None
