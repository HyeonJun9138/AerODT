"""Sole owner of one isolated test pose. Never inserted into the live World."""
import math
from dataclasses import dataclass


def multiply(a, b):
    w, x, y, z = a
    v, i, j, k = b
    return (w*v-x*i-y*j-z*k, w*i+x*v+y*k-z*j,
            w*j-x*k+y*v+z*i, w*k+x*j-y*i+z*v)


def quaternion(sample):
    r, p, y = (math.radians(x)/2 for x in (sample.roll_deg, sample.pitch_deg, sample.yaw_deg))
    return multiply(multiply((math.cos(y), 0, 0, math.sin(y)),
                             (math.cos(p), 0, math.sin(p), 0)),
                    (math.cos(r), math.sin(r), 0, 0))


@dataclass(frozen=True)
class TestPoseSnapshot:
    status: str
    age_seconds: object
    raw: object
    quaternion_wxyz: tuple
    applied_rpy_deg: tuple
    count: int
    session_id: int
    attitude: object
    acceleration: object
    gps: object
    sensors: dict
    gps_height_above_start_m: object
    gps_origin_altitude_m: object


class TwinningTestRuntime:
    def __init__(self):
        self.reset()

    def reset(self):
        self.session_id = getattr(self, 'session_id', 0)+1
        self.sample = None
        self.last_message = None
        self.acceleration = self.gps = None
        self.sensor_received = {}
        self.sensor_timestamps = {}
        self.sensor_source_age = {}
        self.gps_origin_altitude_m = None
        self.gps_origin_reference = None
        self.received_at = None
        self.reference = (1., 0., 0., 0.)
        self.count = 0

    def observe(self, sample, now):
        updates = {}
        for name, sensor, stamp in (
            ('attitude', sample if sample.roll_deg is not None else None, sample.attitude_observed_at_unix_ms),
            ('acceleration', sample.acceleration, sample.acceleration.observed_at_unix_ms if sample.acceleration else None),
            ('gps', sample.gps, sample.gps.observed_at_unix_ms if sample.gps else None)):
            if sensor is None:
                continue
            if stamp is not None and stamp <= self.sensor_timestamps.get(name, -1):
                continue
            self.sensor_received[name] = now
            self.sensor_source_age[name] = max(0., (sample.sent_at_unix_ms-stamp)/1000) if stamp is not None else 0.
            if stamp is not None:
                self.sensor_timestamps[name] = stamp
            if name == 'attitude':
                self.sample = sensor
            else:
                setattr(self, name, sensor)
            updates[name] = sensor
        if ('gps' in updates and self.gps_origin_altitude_m is None and self.gps.altitude_m is not None
                and self.sensor_source_age['gps'] < 5):
            self.gps_origin_altitude_m = self.gps.altitude_m
            self.gps_origin_reference = self.gps.altitude_reference
        self.last_message, self.received_at = sample, now
        self.count += 1
        return updates

    def calibrate(self, now):
        if self.sample is None or self.sensor_status('attitude', now)['status'] != 'receiving':
            raise ValueError('fresh_attitude_required')
        w, x, y, z = quaternion(self.sample)
        self.reference = (w, -x, -y, -z)

    def sensor_status(self, name, now):
        received = self.sensor_received.get(name)
        age = None if received is None else max(0., now-received)+self.sensor_source_age.get(name, 0.)
        return {'status': 'waiting' if age is None else 'stale' if age >= (5 if name == 'gps' else 2) else 'receiving',
                'age_seconds': age}

    def snapshot(self, now):
        age = None if self.received_at is None else max(0., now-self.received_at)
        q = multiply(self.reference, quaternion(self.sample)) if self.sample else (1., 0., 0., 0.)
        w, x, y, z = q
        rpy = tuple(map(math.degrees, (math.atan2(2*(w*x+y*z), 1-2*(x*x+y*y)),
                    math.asin(max(-1., min(1., 2*(w*y-z*x)))),
                    math.atan2(2*(w*z+x*y), 1-2*(y*y+z*z)))))
        attitude = None if self.sample is None else {
            'roll_deg': self.sample.roll_deg, 'pitch_deg': self.sample.pitch_deg, 'yaw_deg': self.sample.yaw_deg,
            'observed_at_unix_ms': self.sample.attitude_observed_at_unix_ms}
        relative_height = None
        if (self.gps is not None and self.gps.altitude_m is not None and self.gps_origin_altitude_m is not None
                and self.gps.altitude_reference == self.gps_origin_reference):
            relative_height = self.gps.altitude_m-self.gps_origin_altitude_m
        return TestPoseSnapshot('waiting' if age is None else 'stale' if age >= 2 else 'receiving',
                                age, self.last_message, q, rpy, self.count, self.session_id, attitude,
                                self.acceleration, self.gps,
                                {name:self.sensor_status(name, now) for name in ('attitude', 'acceleration', 'gps')},
                                relative_height, self.gps_origin_altitude_m)
