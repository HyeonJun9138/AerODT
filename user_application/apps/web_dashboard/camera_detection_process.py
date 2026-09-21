"""Compose an optional isolated local Python detector; never start on status."""
import json
import os
import queue
import subprocess
import threading
from ai_pnp.domains.uam.flying_object_detection import PACKAGE, ROOT, validate_frame


class CameraDetectionProcess:
    def __init__(self, python=None):
        self.python = str(python or ROOT / 'project_support/environment/camera_detection/Scripts/python.exe')
        self.process = None
        self.loaded = False
        self.lock = threading.Lock()
        self.pending_lock = threading.Lock()
        self.pending_releases = set()
        self.responses = None

    def describe(self):
        manifest = json.loads((PACKAGE / 'manifest.json').read_text(encoding='utf-8')) if (PACKAGE / 'manifest.json').is_file() else {}
        ready = (PACKAGE / 'model.onnx').is_file() and os.path.isfile(self.python)
        # The device is the worker's to report: it is known after the first
        # frame, and not claimed before. `isolated_` says the worker is a
        # separate process on a separate Python, whichever device it took.
        provider = getattr(self, 'provider', None)
        execution = ('isolated_local_dml_onnx' if provider == 'DmlExecutionProvider'
                     else 'isolated_local_cpu_onnx' if provider else 'isolated_local_onnx')
        return dict(model_id='flying_objects_v1', ready=ready, loaded=self.loaded and self.process is not None and self.process.poll() is None,
                    classes=manifest.get('classes', []), execution=execution, provider=provider,
                    reason='' if ready else '로컬 탐지 모델과 전용 Python 설치가 필요합니다.')

    def _start(self):
        if self.process is not None and self.process.poll() is None: return
        self.loaded = False
        self.responses = queue.Queue(maxsize=1)
        environment = {**os.environ, 'YOLO_AUTOINSTALL': 'false', 'YOLO_CONFIG_DIR': str(ROOT / 'project_support/environment/camera_detection/config')}
        self.process = subprocess.Popen([self.python, '-u', '-m', 'ai_pnp.domains.uam.flying_object_detection'], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding='utf-8',
            env=environment, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        def read(process, responses):
            for line in process.stdout:
                try: responses.put_nowait(line)
                except queue.Full: return
            try: responses.put_nowait('')
            except queue.Full: pass
        threading.Thread(target=read, args=(self.process, self.responses), daemon=True).start()

    def _send(self, body):
        self.process.stdin.write(json.dumps(body, allow_nan=False) + '\n')
        self.process.stdin.flush()
        try: line = self.responses.get(timeout=60)
        except queue.Empty:
            self.close()
            raise RuntimeError('탐지 시간 초과')
        if not line: raise RuntimeError('탐지 프로세스 종료')
        answer = json.loads(line)
        if answer.get('error') == 'invalid_frame': raise ValueError('영상 세션 또는 순서 오류')
        if 'error' in answer: raise RuntimeError('탐지 모델 실행 오류')
        return answer['result']

    def predict(self, body):
        if not self.lock.acquire(False): raise RuntimeError('탐지 처리 중입니다.')
        try:
            validate_frame(body)
            with self.pending_lock:
                if body['session_id'] in self.pending_releases:
                    raise RuntimeError('탐지 요청이 취소되었습니다.')
            self._start()
            with self.pending_lock:
                if body['session_id'] in self.pending_releases:
                    raise RuntimeError('탐지 요청이 취소되었습니다.')
                pending, self.pending_releases = self.pending_releases, set()
            for session_id in pending: self._send({'operation': 'release', 'session_id': session_id})
            result = self._send(body)
            self.loaded = True
            # Which device the worker actually ran on, for `describe`.
            if isinstance(result, dict) and result.get('provider'):
                self.provider = result['provider']
            return result
        finally:
            # Requests cancelled during inference are released before another frame.
            while True:
                with self.pending_lock:
                    if not self.pending_releases:
                        self.lock.release()
                        break
                    pending, self.pending_releases = self.pending_releases, set()
                for session_id in pending:
                    try:
                        if self.process is not None and self.process.poll() is None:
                            self._send({'operation': 'release', 'session_id': session_id})
                    except Exception: self.close()

    def release(self, session_id):
        with self.pending_lock:
            if self.process is None and not self.lock.locked(): return
            if not self.lock.acquire(False):
                if len(self.pending_releases) < 8: self.pending_releases.add(session_id)
                return
        try: self._send({'operation': 'release', 'session_id': session_id})
        except Exception: self.close()
        finally: self.lock.release()

    def close(self):
        process, self.process = self.process, None
        self.loaded = False
        if process is not None:
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=3)
                except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=3)
            for stream in (process.stdin, process.stdout):
                if stream: stream.close()
