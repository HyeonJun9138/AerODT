"""Bounded JSONL v1/v2 TCP adapter. No World or flight-control access."""
import asyncio
import json
import math
import re
import time
from collections import deque
from digital_twin.contracts.test_attitude import TestAttitude, AccelerationObservation, GpsObservation

MAX_LINE = 4096


def finite_number(value, low, high):
    if type(value) not in (float, int) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError('invalid_sensor_number')
    return float(value)


def observed_at(block, sent):
    value = block['observed_at_unix_ms']
    if type(value) is not int or not 0 <= value <= min(2**53-1, sent+1000):
        raise ValueError('invalid_observation_time')
    return value


def parse_message(raw):
    try:
        if len(raw) > MAX_LINE:
            raise ValueError('message_too_large')
        v = json.loads(raw.decode('utf-8'))
        if not isinstance(v, dict) or type(v.get('version')) is not int or v['version'] not in (1, 2):
            raise ValueError('invalid_version')
        device = v.get('device_id')
        if not isinstance(device, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', device):
            raise ValueError('invalid_device_id')
        for key in ('seq', 'sent_at_unix_ms'):
            if type(v.get(key)) is not int or not 0 <= v[key] <= 2**53-1:
                raise ValueError('invalid_' + key)
        values, attitude_time, acceleration, gps = [None]*3, None, None, None
        if v['version'] == 1 or v.get('attitude') is not None:
            angles = v['attitude']
            values = [finite_number(angles[k], -360, 360) for k in ('roll_deg', 'pitch_deg', 'yaw_deg')]
            if v['version'] == 2:
                attitude_time = observed_at(angles, v['sent_at_unix_ms'])
        if v['version'] == 2:
            if v.get('acceleration') is not None:
                a = v['acceleration']
                if a['frame'] != 'body_frd' or type(a['includes_gravity']) is not bool:
                    raise ValueError('invalid_acceleration_convention')
                acceleration = AccelerationObservation(observed_at(a, v['sent_at_unix_ms']),
                    *(finite_number(a[k], -10000, 10000) for k in ('x_mps2', 'y_mps2', 'z_mps2')),
                    a['includes_gravity'], a['frame'])
            if v.get('gps') is not None:
                g = v['gps']
                altitude = None if g.get('altitude_m') is None else finite_number(g['altitude_m'], -12000, 100000)
                reference = g.get('altitude_reference')
                if altitude is not None and reference not in ('msl', 'wgs84_ellipsoid'):
                    raise ValueError('invalid_altitude_reference')
                vertical = None if g.get('vertical_accuracy_m') is None else finite_number(g['vertical_accuracy_m'], 0, 100000)
                # Latitude, longitude and the observation time are the fix. Height
                # and the two accuracies are what a phone happens to know about
                # itself; a simulator sending a position has none of them, and a
                # missing figure is reported as missing rather than made up.
                horizontal = None if g.get('horizontal_accuracy_m') is None else finite_number(g['horizontal_accuracy_m'], 0, 100000)
                gps = GpsObservation(observed_at(g, v['sent_at_unix_ms']),
                    finite_number(g['latitude_deg'], -90, 90), finite_number(g['longitude_deg'], -180, 180),
                    altitude, reference, horizontal, vertical)
            if values[0] is None and acceleration is None and gps is None:
                raise ValueError('sensor_required')
        return TestAttitude(device, v['seq'], v['sent_at_unix_ms'], *values,
                            attitude_time, acceleration, gps, v['version'])
    except (KeyError, TypeError, UnicodeError, json.JSONDecodeError, OverflowError) as error:
        raise ValueError('invalid_message') from error


# One socket per device. A phone and a simulator are two senders with two
# poses, and a single-connection receiver dropped the second one silently --
# the worst answer, because nothing on either side said so. The cap is small on
# purpose: an open port on a trusted LAN should not be able to grow unbounded
# state just by connecting.
MAX_LINKS = 4


class TcpAttitudeReceiver:
    def __init__(self, observe, event=lambda text: None, connected=lambda device=None: None):
        self.observe, self.event, self.connected = observe, event, connected
        self.server = self.writer = None
        # task -> {'writer', 'peer', 'device'}; insertion ordered, so the first
        # link stays the one the single-sender view reports.
        self.links = {}
        self.tasks = set()
        self.errors = 0
        self.peer = None
        self.port = None
        self.reset_statistics()

    @property
    def peers(self):
        return [link['peer'] for link in self.links.values()]

    @property
    def devices(self):
        return [link['device'] for link in self.links.values() if link['device']]

    def reset_statistics(self):
        self.errors = self.received_bytes = self.sequence_gaps = 0
        self.byte_samples = deque(maxlen=42)
        self.last_wire = None

    def record_bytes(self, count):
        self.received_bytes += count
        bucket = int(time.monotonic()*20)/20
        if self.byte_samples and self.byte_samples[-1][0] == bucket:
            moment, previous = self.byte_samples.pop()
            self.byte_samples.append((moment, previous+count))
        else:
            self.byte_samples.append((bucket, count))

    def bytes_per_second(self):
        now = time.monotonic()
        return sum(count for moment, count in self.byte_samples if now-moment < 2)/2

    async def start(self, host, port):
        if self.server is not None:
            raise ValueError('already_listening')
        self.server = await asyncio.start_server(self._accept, host, port, limit=MAX_LINE)
        self.port = self.server.sockets[0].getsockname()[1]
        self.event('TCP 수신 대기 시작')

    async def stop(self):
        self.last_wire = None
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            self.server = None
        for link in tuple(self.links.values()):
            link['writer'].close()
        tasks = tuple(self.tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self.links.clear()
        self.writer = None
        self.peer = None

    async def _accept(self, reader, writer):
        task = asyncio.current_task()
        self.tasks.add(task)
        link = None
        try:
            if self.server is None:
                return
            if len(self.links) >= MAX_LINKS:
                # Say so rather than hold a socket nobody reads.
                self.event(f'연결 한도 {MAX_LINKS}대 초과: 새 연결 거절')
                return
            link = {'writer': writer, 'peer': str(writer.get_extra_info('peername')), 'device': None}
            self.links[task] = link
            if self.writer is None:
                self.writer, self.peer = writer, link['peer']
            self.event(f'중계 컴퓨터 연결 ({len(self.links)}대)')
            seq, device = -1, None
            buffer = bytearray()
            while True:
                chunk = await reader.read(MAX_LINE)
                if not chunk:
                    if buffer:
                        self.errors += 1
                        self.event('newline_required')
                    break
                self.record_bytes(len(chunk))
                buffer.extend(chunk)
                while b'\n' in buffer:
                    end = buffer.index(b'\n')+1
                    if end > MAX_LINE:
                        self.errors += 1
                        self.event('메시지 길이 초과: 연결 종료')
                        return
                    raw = bytes(buffer[:end])
                    del buffer[:end]
                    # One bounded diagnostic frame, never persisted or sent in public status.
                    self.last_wire = raw.decode("utf-8", errors="replace")
                    try:
                        sample = parse_message(raw)
                        if sample.seq <= seq or (device is not None and device != sample.device_id):
                            raise ValueError('sequence_or_device_changed')
                        if device is None:
                            # Two sockets claiming one device would interleave
                            # their sequence numbers into one pose. Refuse the
                            # newcomer instead of letting them fight.
                            if any(other is not link and other['device'] == sample.device_id
                                   for other in self.links.values()):
                                raise ValueError('device_already_connected')
                            link['device'] = sample.device_id
                            self.connected(sample.device_id)
                        self.observe(sample)
                        if seq >= 0:
                            self.sequence_gaps += sample.seq-seq-1
                        seq, device = sample.seq, sample.device_id
                    except ValueError as error:
                        self.errors += 1
                        self.event(str(error))
                if len(buffer) >= MAX_LINE:
                    self.errors += 1
                    self.event('메시지 길이 초과: 연결 종료')
                    return
                await asyncio.sleep(0)
        except (ConnectionError, OSError):
            self.event('TCP 연결 오류')
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass
            if link is not None:
                self.links.pop(task, None)
                if self.writer is writer:
                    first = next(iter(self.links.values()), None)
                    self.writer = first['writer'] if first else None
                    self.peer = first['peer'] if first else None
                self.event(f"중계 컴퓨터 연결 종료{' · ' + link['device'] if link['device'] else ''}")
            self.tasks.discard(task)
