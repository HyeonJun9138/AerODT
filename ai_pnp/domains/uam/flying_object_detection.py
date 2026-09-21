"""Image-only flying-object inference; tracks are derived, never world state."""
import base64
import binascii
import hashlib
import io
import json
import math
import re
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = ROOT / 'digital_twin/model_library/detection_models/flying_objects_v1'
MAX_ENCODED = 1024 * 1024
FIELDS = ('session_id', 'entity_id', 'camera', 'frame_id', 'captured_at', 'width', 'height')


def validate_frame(body):
    if not isinstance(body, dict): raise ValueError('JSON 객체가 필요합니다.')
    if not isinstance(body.get('session_id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,96}', body['session_id']):
        raise ValueError('세션 식별자가 올바르지 않습니다.')
    if not isinstance(body.get('entity_id'), str) or not 1 <= len(body['entity_id']) <= 160:
        raise ValueError('기체 식별자가 필요합니다.')
    if body.get('camera') not in ('front', 'rear', 'left', 'right', 'down'): raise ValueError('카메라 방향 오류')
    for key, maximum in [('width', 1280), ('height', 720), ('frame_id', 2**53 - 1)]:
        value = body.get(key)
        if type(value) is not int or not (0 if key == 'frame_id' else 1) <= value <= maximum:
            raise ValueError('영상 크기 또는 프레임 순번 오류')
    captured = body.get('captured_at')
    if type(captured) not in (int, float) or not math.isfinite(captured) or captured < 0: raise ValueError('캡처 시각 오류')
    encoded = body.get('image_base64')
    if not isinstance(encoded, str) or not 1 <= len(encoded) <= MAX_ENCODED: raise ValueError('영상 데이터 크기 오류')
    from PIL import Image
    try:
        raw = base64.b64decode(encoded, validate=True)
        with Image.open(io.BytesIO(raw)) as image:
            if image.format != 'JPEG' or image.size != (body['width'], body['height']): raise ValueError('JPEG 크기 불일치')
            image.load()
            return image.convert('RGB')
    except (OSError, binascii.Error, Image.DecompressionBombError) as error:
        raise ValueError('유효한 JPEG 영상이 필요합니다.') from error


class OnnxFlyingObjects:
    def __init__(self, package=PACKAGE):
        import onnxruntime as ort
        self.manifest = json.loads((package / 'manifest.json').read_text(encoding='utf-8'))
        artifact = package / self.manifest['artifact']
        if hashlib.sha256(artifact.read_bytes()).hexdigest() != self.manifest['sha256']:
            raise RuntimeError('탐지 모델 해시 불일치')
        # The GPU when the runtime can see one, the CPU when it cannot. Measured
        # 2026-09-15 on this machine, YOLOv8m at 640x640: DirectML on the RTX
        # 3080 10.1 ms a frame; the CPU 446 ms on 2 threads, 180 on 8, 372 on
        # 24 (oversubscribed against the twin and the physics workers). Eight is
        # the CPU's knee and is what the fallback runs at.
        self.provider = 'CPUExecutionProvider'
        self.session = None
        if 'DmlExecutionProvider' in ort.get_available_providers():
            options = ort.SessionOptions()
            # What DirectML asks for: no memory-pattern planning, sequential
            # execution. Anything else is left at the runtime's defaults.
            options.enable_mem_pattern = False
            options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            try:
                self.session = ort.InferenceSession(str(artifact), sess_options=options,
                                                    providers=['DmlExecutionProvider', 'CPUExecutionProvider'])
                if 'DmlExecutionProvider' in self.session.get_providers():
                    self.provider = 'DmlExecutionProvider'
                else:
                    self.session = None
            except Exception:
                # A DirectML that is present but cannot take this graph is not a
                # reason to have no detector at all.
                self.session = None
        if self.session is None:
            options = ort.SessionOptions()
            options.intra_op_num_threads = 8
            options.inter_op_num_threads = 1
            self.session = ort.InferenceSession(str(artifact), sess_options=options, providers=['CPUExecutionProvider'])

    def predict(self, image):
        import numpy as np
        import cv2
        width, height = image.size
        size = 640
        ratio = min(size / width, size / height)
        w, h = round(width * ratio), round(height * ratio)
        left, top = (size - w) // 2, (size - h) // 2
        pixels = np.full((size, size, 3), 114, np.uint8)
        pixels[top:top+h, left:left+w] = cv2.resize(np.asarray(image), (w, h))
        tensor = np.ascontiguousarray(pixels.transpose(2, 0, 1)[None], dtype=np.float32) / 255
        rows = self.session.run(None, {self.session.get_inputs()[0].name: tensor})[0][0].T
        classes = rows[:, 4:].argmax(axis=1)
        scores = rows[:, 4:].max(axis=1)
        selected = scores >= .1
        rows, classes, scores = rows[selected], classes[selected], scores[selected]
        if not len(rows): return np.empty((0, 6), dtype=np.float32)
        xywh = rows[:, :4].copy()
        xywh[:, :2] -= xywh[:, 2:] / 2
        keep = []
        for cls in np.unique(classes):
            indices = np.where(classes == cls)[0]
            retained = cv2.dnn.NMSBoxes(xywh[indices].tolist(), scores[indices].tolist(), .1, .45)
            keep.extend(indices[np.asarray(retained).reshape(-1)].tolist())
        keep = sorted(keep, key=lambda i: -scores[i])[:100]
        boxes = xywh[keep]
        boxes[:, 2:] += boxes[:, :2]
        boxes[:, [0, 2]] = np.clip((boxes[:, [0, 2]] - left) / ratio, 0, width)
        boxes[:, [1, 3]] = np.clip((boxes[:, [1, 3]] - top) / ratio, 0, height)
        return np.column_stack((boxes, scores[keep], classes[keep])).astype(np.float32)


class ByteTrackSession:
    def __init__(self):
        from types import SimpleNamespace
        from ultralytics.trackers.byte_tracker import BYTETracker
        self.tracker = BYTETracker(SimpleNamespace(track_high_thresh=.25, track_low_thresh=.1,
            new_track_thresh=.25, track_buffer=15, match_thresh=.8, fuse_score=True), frame_rate=5)
        self.counter = 0

    def update(self, detections):
        import numpy as np
        from ultralytics.engine.results import Boxes
        from ultralytics.trackers.basetrack import BaseTrack
        values = np.asarray(detections, dtype=np.float32).reshape(-1, 6)
        # Upstream owns a global counter and resets it in each constructor.
        # Inference is serialized; switch its counter together with the session.
        BaseTrack._count = self.counter
        tracks = self.tracker.update(Boxes(values, (720, 1280)))
        self.counter = BaseTrack._count
        return [dict(box=row[:4].tolist(), track_id=int(row[4]), confidence=float(row[5]), class_id=int(row[6])) for row in tracks]


class FlyingObjectDetector:
    def __init__(self, *, model_factory=OnnxFlyingObjects, tracker_factory=ByteTrackSession,
                 clock=time.monotonic, max_sessions=8, ttl_seconds=30):
        self.model_factory, self.tracker_factory = model_factory, tracker_factory
        self.clock, self.max_sessions, self.ttl_seconds = clock, max_sessions, ttl_seconds
        self.model = None
        self.sessions = {}
        self.busy = threading.Lock()
        self.state_lock = threading.Lock()
        self.active_session = None
        self.active_cancelled = False
        self.manifest = json.loads((PACKAGE / 'manifest.json').read_text(encoding='utf-8')) if (PACKAGE / 'manifest.json').is_file() else {}

    def describe(self):
        with self.state_lock:
            self._expire()
            # Once a model is loaded the provider is the one it actually took;
            # before that, the one the runtime offers.
            if self.model is not None:
                provider = getattr(self.model, 'provider', 'CPUExecutionProvider')
            else:
                try:
                    import onnxruntime as ort
                    provider = 'DmlExecutionProvider' if 'DmlExecutionProvider' in ort.get_available_providers() else 'CPUExecutionProvider'
                except Exception:
                    provider = 'CPUExecutionProvider'
            return dict(model_id='flying_objects_v1', loaded=self.model is not None,
                ready=(PACKAGE / 'model.onnx').is_file(), sessions=len(self.sessions),
                classes=self.manifest.get('classes', []), provider=provider,
                execution='local_dml_onnx' if provider == 'DmlExecutionProvider' else 'local_cpu_onnx',
                reason='' if (PACKAGE / 'model.onnx').is_file() else '로컬 탐지 모델 설치가 필요합니다.')

    def _expire(self):
        now = self.clock()
        for key in list(self.sessions):
            if now - self.sessions[key]['seen'] >= self.ttl_seconds: del self.sessions[key]

    def collect_idle(self, stop, interval=1):
        """Sweep derived sessions even while the worker waits for its next frame."""
        while not stop.wait(interval):
            with self.state_lock: self._expire()

    def release(self, session_id):
        with self.state_lock:
            self.sessions.pop(session_id, None)
            if self.active_session == session_id: self.active_cancelled = True

    def predict(self, body):
        if not self.busy.acquire(False): raise RuntimeError('탐지 처리 중입니다.')
        try:
            image = validate_frame(body)
            with self.state_lock:
                self._expire()
                session = self.sessions.get(body['session_id'])
                identity = (body['entity_id'], body['camera'], body['width'], body['height'])
                if session is not None:
                    if session['identity'] != identity or body['frame_id'] <= session['frame_id'] or body['captured_at'] < session['captured_at']:
                        raise ValueError('세션 또는 프레임 순서가 변경되었습니다.')
                elif len(self.sessions) >= self.max_sessions: raise RuntimeError('탐지 세션이 가득 찼습니다.')
                self.active_session, self.active_cancelled = body['session_id'], False
            started = time.perf_counter()
            if self.model is None: self.model = self.model_factory()
            detections = self.model.predict(image)
            if session is None:
                session = dict(identity=identity, tracker=self.tracker_factory())
            tracks = session['tracker'].update(detections)
            classes = self.manifest.get('classes', ['Airplane'])
            output = []
            for track in tracks:
                cls = track.pop('class_id')
                name = classes[cls] if 0 <= cls < len(classes) else 'Unknown'
                if name.lower() == 'background': continue
                if track['confidence'] < .25: continue
                track['class_name'] = name
                output.append(track)
            with self.state_lock:
                session.update(frame_id=body['frame_id'], captured_at=body['captured_at'], seen=self.clock())
                if not self.active_cancelled: self.sessions[body['session_id']] = session
            return {**{key: body[key] for key in FIELDS}, 'detections': output,
                    'inference_ms': (time.perf_counter() - started) * 1000, 'model_id': 'flying_objects_v1',
                    'provider': getattr(self.model, 'provider', 'CPUExecutionProvider')}
        finally:
            with self.state_lock: self.active_session = None
            self.busy.release()


def _worker():
    import sys
    from contextlib import redirect_stdout
    detector = FlyingObjectDetector()
    idle_stop = threading.Event()
    threading.Thread(target=detector.collect_idle, args=(idle_stop,), daemon=True).start()
    for line in sys.stdin:
        try:
            body = json.loads(line)
            with redirect_stdout(sys.stderr):
                if body.get('operation') == 'release':
                    detector.release(body['session_id'])
                    result = {'released': True}
                else: result = detector.predict(body)
            answer = {'result': result}
        except ValueError: answer = {'error': 'invalid_frame'}
        except Exception: answer = {'error': 'model_unavailable'}
        print(json.dumps(answer, allow_nan=False), flush=True)
    idle_stop.set()


if __name__ == '__main__': _worker()
