import base64
import io
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from PIL import Image
from fastapi import FastAPI
from fastapi.testclient import TestClient


def frame(**changes):
    image = io.BytesIO()
    Image.new('RGB', (576, 288)).save(image, 'JPEG')
    body = dict(session_id='session-1', entity_id='aircraft:1', camera='front',
                frame_id=1, captured_at=1234.5, width=576, height=288,
                image_base64=base64.b64encode(image.getvalue()).decode())
    body.update(changes)
    return body


def runner(**kwargs):
    from ai_pnp.flying_object_detection import FlyingObjectDetector
    return FlyingObjectDetector(**kwargs)


class Model:
    def predict(self, image):
        return [[10, 20, 50, 60, .9, 0]]


class Tracker:
    def update(self, boxes):
        return [dict(box=list(boxes[0][:4]), confidence=.9, class_id=0, track_id=1)]


def test_implementation_exists():
    from pathlib import Path
    assert Path('ai_pnp/flying_object_detection.py').exists(), '독립 카메라 탐지 구현이 필요합니다.'


def test_status_and_validation_do_not_load_model():
    calls = []
    detector = runner(model_factory=lambda: calls.append(1))
    assert detector.describe()['loaded'] is False
    for changes in ({'image_base64': 'bad!'}, {'width': 1281}, {'height': 721},
                    {'width': 100}, {'frame_id': True}, {'captured_at': float('nan')},
                    {'camera': 'other'}, {'session_id': '../bad'},
                    {'image_base64': 'A' * (1024 * 1024 + 1)}):
        with pytest.raises(ValueError):
            detector.predict(frame(**changes))
    assert calls == []


def test_metadata_sequence_and_session_isolation():
    loaded, trackers = [], []
    def model():
        loaded.append(1)
        return Model()
    def tracker():
        value = Tracker()
        trackers.append(value)
        return value
    detector = runner(model_factory=model, tracker_factory=tracker)
    result = detector.predict(frame())
    for key in ('session_id', 'entity_id', 'camera', 'frame_id', 'captured_at', 'width', 'height'):
        assert result[key] == frame()[key]
    assert result['detections'][0]['track_id'] == 1
    detector.predict(frame(session_id='session-2'))
    assert len(trackers) == 2 and len(loaded) == 1
    with pytest.raises(ValueError): detector.predict(frame())
    with pytest.raises(ValueError): detector.predict(frame(frame_id=2, camera='rear'))
    detector.release('session-1')
    detector.predict(frame())
    assert len(trackers) == 3 and len(loaded) == 1


def test_session_capacity_and_expiry():
    now = [0]
    detector = runner(model_factory=Model, tracker_factory=Tracker, clock=lambda: now[0], max_sessions=1, ttl_seconds=2)
    detector.predict(frame())
    with pytest.raises(RuntimeError): detector.predict(frame(session_id='session-2'))
    now[0] = 3
    detector.predict(frame(session_id='session-2'))
    assert detector.describe()['sessions'] == 1


def test_one_active_inference_without_queue():
    started, finish = threading.Event(), threading.Event()
    class Blocking(Model):
        def predict(self, image):
            started.set()
            finish.wait(5)
            return super().predict(image)
    detector = runner(model_factory=Blocking, tracker_factory=Tracker)
    with ThreadPoolExecutor() as pool:
        future = pool.submit(detector.predict, frame())
        assert started.wait(2)
        try:
            with pytest.raises(RuntimeError): detector.predict(frame(session_id='session-2'))
        finally: finish.set()
        future.result()


def test_router_status_validation_and_release():
    from communication.web.camera_detection_routes import create_camera_detection_router
    detector = runner(model_factory=Model, tracker_factory=Tracker)
    app = FastAPI()
    app.include_router(create_camera_detection_router(detector.predict, detector.describe, detector.release))
    with TestClient(app) as client:
        assert client.get('/api/camera/model').json()['loaded'] is False
        assert client.post('/api/camera/detect', json=frame(image_base64='bad')).status_code == 422
        assert client.post('/api/camera/detect', json=frame(), headers={'Origin': 'https://evil.example'}).status_code == 403
        assert client.post('/api/camera/detect', content=b'A' * (1024 * 1024 + 8193)).status_code == 413
        assert client.post('/api/camera/detect', json=frame()).json()['detections'][0]['track_id'] == 1
        assert client.delete('/api/camera/session/session-1').status_code == 200


def test_release_during_first_inference_does_not_resurrect_session():
    started, finish = threading.Event(), threading.Event()
    class Blocking(Model):
        def predict(self, image):
            started.set()
            finish.wait(5)
            return super().predict(image)
    detector = runner(model_factory=Blocking, tracker_factory=Tracker)
    with ThreadPoolExecutor() as pool:
        future = pool.submit(detector.predict, frame())
        assert started.wait(2)
        detector.release('session-1')
        finish.set()
        future.result()
    assert detector.describe()['sessions'] == 0


def test_process_description_and_release_never_start_worker():
    from user_application.apps.web_dashboard.camera_detection_process import CameraDetectionProcess
    worker = CameraDetectionProcess()
    assert worker.describe()['loaded'] is False
    worker.release('session-1')
    assert worker.process is None
    worker.close()


def test_real_bytetrack_sessions_do_not_reset_existing_id_counter():
    pytest.importorskip('ultralytics')
    from ai_pnp.flying_object_detection import ByteTrackSession
    one = ByteTrackSession()
    initial = [[10, 10, 40, 40, .9, 1], [100, 100, 130, 130, .9, 1]]
    assert len(one.update(initial)) == 2
    two = ByteTrackSession()
    two.update([[10, 10, 40, 40, .9, 1]])
    detections = [*initial, [200, 200, 230, 230, .9, 1]]
    one.update(detections)
    assert sorted(row['track_id'] for row in one.update(detections)) == [1, 2, 3]


def test_camera_audit_never_persists_jpeg_payload():
    from communication.web.audit_routes import OperationalAuditMiddleware
    from communication.web.camera_detection_routes import create_camera_detection_router
    events = []
    detector = runner(model_factory=Model, tracker_factory=Tracker)
    app = FastAPI()
    app.include_router(create_camera_detection_router(detector.predict, detector.describe, detector.release))
    app.add_middleware(OperationalAuditMiddleware, audit=lambda kind, **detail: events.append((kind, detail)))
    with TestClient(app) as client:
        assert client.post('/api/camera/detect', json=frame()).status_code == 200
    assert 'image_base64' not in str(events)
    assert events[-1][1]['received_bytes'] > 0


def test_release_while_first_frame_decodes_does_not_start_worker(monkeypatch):
    from user_application.apps.web_dashboard import camera_detection_process as module
    entered, finish = threading.Event(), threading.Event()
    original = module.validate_frame
    def decoding(body):
        entered.set()
        finish.wait(3)
        return original(body)
    monkeypatch.setattr(module, 'validate_frame', decoding)
    worker = module.CameraDetectionProcess()
    with ThreadPoolExecutor() as pool:
        future = pool.submit(worker.predict, frame())
        assert entered.wait(2)
        worker.release('session-1')
        finish.set()
        try:
            with pytest.raises(RuntimeError, match='취소'): future.result(timeout=15)
            assert worker.process is None
        finally: worker.close()


def test_idle_expiry_without_new_frames():
    import time
    detector = runner(model_factory=Model, tracker_factory=Tracker, ttl_seconds=.02)
    detector.predict(frame())
    stop = threading.Event()
    thread = threading.Thread(target=detector.collect_idle, args=(stop, .01))
    thread.start()
    try:
        time.sleep(.08)
        # Inspect directly: describe() would itself mask a missing idle sweep.
        assert detector.sessions == {}
    finally: stop.set(); thread.join(timeout=2)


def test_cancel_during_worker_start_does_not_send_detection(monkeypatch):
    from user_application.apps.web_dashboard import camera_detection_process as module
    entered, finish = threading.Event(), threading.Event()
    worker = module.CameraDetectionProcess()
    sent = []
    class Process:
        def poll(self): return None
    def start():
        entered.set()
        finish.wait(3)
        worker.process = Process()
    monkeypatch.setattr(worker, '_start', start)
    monkeypatch.setattr(worker, '_send', lambda body: sent.append(body) or {})
    with ThreadPoolExecutor() as pool:
        future = pool.submit(worker.predict, frame())
        assert entered.wait(2)
        worker.release('session-1')
        finish.set()
        with pytest.raises(RuntimeError, match='취소'): future.result(timeout=5)
    assert sent == [{'operation': 'release', 'session_id': 'session-1'}]


def test_cancel_during_decode_releases_existing_worker_session(monkeypatch):
    from user_application.apps.web_dashboard import camera_detection_process as module
    entered, finish = threading.Event(), threading.Event()
    worker = module.CameraDetectionProcess()
    class Process:
        def poll(self): return None
    worker.process = Process()
    sent = []
    original = module.validate_frame
    def decode(body):
        entered.set()
        finish.wait(3)
        return original(body)
    monkeypatch.setattr(module, 'validate_frame', decode)
    monkeypatch.setattr(worker, '_send', lambda body: sent.append(body) or {})
    with ThreadPoolExecutor() as pool:
        future = pool.submit(worker.predict, frame(frame_id=2))
        assert entered.wait(2)
        worker.release('session-1')
        finish.set()
        with pytest.raises(RuntimeError, match='취소'): future.result(timeout=5)
    assert sent == [{'operation': 'release', 'session_id': 'session-1'}]


def test_describe_and_result_carry_the_provider_the_model_took():
    # The GPU when the runtime can see one, the CPU when it cannot - and
    # whichever it was, it is said, so a slow camera is a number with a name.
    class OnGpu(Model):
        provider = 'DmlExecutionProvider'
    detector = runner(model_factory=OnGpu, tracker_factory=Tracker)
    before = detector.describe()
    assert before['provider'] in ('DmlExecutionProvider', 'CPUExecutionProvider')
    assert before['execution'] == ('local_dml_onnx' if before['provider'] == 'DmlExecutionProvider' else 'local_cpu_onnx')
    assert detector.predict(frame())['provider'] == 'DmlExecutionProvider'
    after = detector.describe()
    assert after['provider'] == 'DmlExecutionProvider' and after['execution'] == 'local_dml_onnx'
    # A model that says nothing about it ran on the CPU.
    plain = runner(model_factory=Model, tracker_factory=Tracker)
    assert plain.predict(frame())['provider'] == 'CPUExecutionProvider'
    assert plain.describe()['execution'] == 'local_cpu_onnx'
