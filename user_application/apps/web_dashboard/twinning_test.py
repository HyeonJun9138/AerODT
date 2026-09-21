"""Composition and lifecycle for the opt-in phone attitude experiment."""
import asyncio
import ipaddress
import time
from collections import deque
from dataclasses import asdict
from communication.twinning_tcp import MAX_LINKS, TcpAttitudeReceiver
from digital_twin.runtime.twinning_test import TwinningTestRuntime
from data.ingestion.twinning_test_history import TwinningTestHistory


class TwinningTestSession:
    def __init__(self, catalog, audit=lambda *args, **kwargs: None):
        self.catalog, self.audit = catalog, audit
        self.runtime = TwinningTestRuntime()
        self.history = TwinningTestHistory()
        self.receiver = TcpAttitudeReceiver(self.observe, self.event, self.reconnected)
        self.lock = asyncio.Lock()
        self.events = deque(maxlen=20)
        self.arrivals = deque(maxlen=120)
        self.cancelled_operations = deque(maxlen=64)
        self.asset_id = None
        self.host = '0.0.0.0'
        # One pose per sender. The runtime owns a single pose by design, so a
        # second device gets a second runtime rather than sharing one and
        # overwriting the first on every line.
        self.devices = {}
        self.selected = None

    def event(self, text):
        # Bounded display diagnostics, not a separate run-log format.
        if not self.events or self.events[-1]['message'] != text:
            self.events.append({'at_unix_ms': int(time.time()*1000), 'message': text})
            self.audit('twinning_test', message=text)

    def device(self, device_id):
        """The pose and trend held for one sender, created when it first speaks."""
        held = self.devices.get(device_id)
        if held is None:
            held = {'runtime': TwinningTestRuntime(), 'history': TwinningTestHistory(),
                    'first_seen': time.monotonic()}
            self.devices[device_id] = held
        return held

    def observe(self, sample):
        now = time.monotonic()
        held = self.device(sample.device_id)
        updates = held['runtime'].observe(sample, now)
        held['history'].observe(sample, updates, now)
        held['last_seen'] = now
        self.arrivals.append(now)

    def reconnected(self, device_id=None):
        # A sender coming back on a new socket starts its own pose again. The
        # other senders are still talking and must not be cleared with it.
        if device_id is None:
            return
        held = self.device(device_id)
        held['runtime'].reset()
        held['history'].clear()

    async def start(self, config):
        async with self.lock:
            operation = config.get('operation_id')
            if operation is not None and (not isinstance(operation, str) or not 1 <= len(operation) <= 64):
                raise ValueError('invalid_operation_id')
            if operation is not None and operation in self.cancelled_operations:
                raise ValueError('start_cancelled')
            if self.receiver.server:
                raise ValueError('already_listening')
            host, port, asset = config.get('host'), config.get('port'), config.get('asset_id')
            if not isinstance(host, str):
                raise ValueError('invalid_host')
            ipaddress.IPv4Address(host)
            if type(port) is not int or not 1024 <= port <= 65535:
                raise ValueError('port_must_be_1024_to_65535')
            if not any(a.get('asset_id') == asset and a.get('kind') == 'aircraft'
                       and a.get('uri', '').startswith('/visual-assets/') for a in self.catalog().get('assets', [])):
                raise ValueError('unknown_aircraft_asset')
            self.forget_devices()
            self.arrivals.clear()
            self.receiver.reset_statistics()
            await self.receiver.start(host, port)
            self.asset_id, self.host = asset, host
        return self.status()

    async def stop(self, operation_id=None):
        if operation_id is not None and (not isinstance(operation_id, str) or not 1 <= len(operation_id) <= 64):
            raise ValueError('invalid_operation_id')
        async with self.lock:
            if operation_id is not None:
                self.cancelled_operations.append(operation_id)
            await self.receiver.stop()
            self.forget_devices()
            self.arrivals.clear()
            self.asset_id = None
            self.event('Test Mode OFF')
        return self.status()

    def forget_devices(self):
        self.devices.clear()
        self.selected = None
        self.runtime.reset()
        self.history.clear()

    def select(self, device_id):
        """Which sender the single-pose views follow: the chart, the horizon and
        the reference the operator sets. Drawing all of them on the map is a
        different question and does not go through here."""
        if device_id is not None and device_id not in self.devices:
            raise ValueError('unknown_device')
        self.selected = device_id
        return self.status()

    def primary(self):
        """The selected sender, or the first one that spoke. Before anyone has,
        an empty pair so every view still has a shape to read."""
        if self.selected in self.devices:
            return self.devices[self.selected]
        first = next(iter(self.devices.values()), None)
        return first if first else {'runtime': self.runtime, 'history': self.history}

    def calibrate(self):
        self.primary()['runtime'].calibrate(time.monotonic())
        self.event('현재 자세를 기준으로 설정')
        return self.status()

    def status(self):
        now = time.monotonic()
        # The top level stays one sender's pose, because every single-pose view
        # already reads it there. The rest arrive alongside rather than instead.
        result = asdict(self.primary()['runtime'].snapshot(now))
        recent = [t for t in self.arrivals if now-t < 2]
        hz = (len(recent)-1)/(recent[-1]-recent[0]) if len(recent) > 1 and recent[-1] > recent[0] else 0.
        devices = [dict(asdict(held['runtime'].snapshot(now)), device_id=device_id,
                        connected=device_id in self.receiver.devices)
                   for device_id, held in self.devices.items()]
        result.update(schema_version=2, enabled=self.receiver.server is not None,
                      connected=self.receiver.writer is not None, peer=self.receiver.peer,
                      peers=self.receiver.peers, host=self.host, port=self.receiver.port or 5005,
                      asset_id=self.asset_id, devices=devices,
                      selected_device=self.primary_id(), device_limit=MAX_LINKS,
                      receive_hz=hz, errors=self.receiver.errors, events=list(self.events),
                      received_bytes=self.receiver.received_bytes, receive_bytes_per_second=self.receiver.bytes_per_second(),
                      sequence_gaps=self.receiver.sequence_gaps)
        return result

    def primary_id(self):
        if self.selected in self.devices:
            return self.selected
        return next(iter(self.devices), None)

    def history_payload(self):
        held = self.primary()
        return held['history'].read(time.monotonic(), held['runtime'].session_id)
