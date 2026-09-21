"""AeroDT 실행 이벤트와 manifest를 소유하는 Data Layer 구현."""

from __future__ import annotations

import json
import platform
import sys
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# 콘솔에 남길 수준. 기록은 events.jsonl이 갖고 있고, 터미널은 사람이 보고
# 조치할 것만 보여준다. 수동 비행은 초당 열 건씩 표본을 남기므로 info까지
# 찍으면 정작 경고가 그 안에 묻힌다.
CONSOLE_LEVELS = ("warning", "error", "critical")


class RunLogger:
    """한 번의 실행을 독립 폴더에 JSONL과 manifest로 기록한다."""

    def __init__(self, workspace: Path, application: str, metadata: dict[str, Any]):
        timestamp = datetime.now(timezone.utc)
        self.run_id = f"{timestamp:%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex[:8]}"
        self.run_dir = workspace / "logs" / "runs" / self.run_id
        self.run_dir.mkdir(parents=True, exist_ok=False)
        self.events_path = self.run_dir / "events.jsonl"
        self.manifest_path = self.run_dir / "manifest.json"
        # 수동 비행은 스텝마다 한 줄을 남긴다. 줄마다 파일을 열고 닫으면 한 건에
        # 0.6 ms가 들어 초당 스무 번이면 12 ms가 조종 응답에서 빠져나간다.
        # 라인 버퍼 핸들은 줄 끝마다 그대로 내려쓰므로 중간에 죽어도 읽히는
        # 성질은 같고, 한 건이 0.02 ms로 줄어든다. 여러 스레드가 같은 실행을
        # 기록하므로 한 줄은 한 번의 write로, 자물쇠 안에서 쓴다.
        self._stream = self.events_path.open("a", encoding="utf-8", buffering=1)
        self._write_lock = threading.Lock()
        self._started_at = timestamp
        self._default_component = f"user_application.{application}"
        self._manifest: dict[str, Any] = {
            "schema_version": 1,
            "run_id": self.run_id,
            "application": application,
            "status": "running",
            "started_at": timestamp.isoformat(),
            "host": {
                "platform": platform.platform(),
                "python": sys.version.split()[0],
            },
            "metadata": metadata,
        }
        self._write_manifest()

    def log(
        self,
        event: str,
        message: str,
        *,
        level: str = "info",
        component: str | None = None,
        data: dict[str, Any] | None = None,
    ) -> None:
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": level,
            "component": component or self._default_component,
            "event": event,
            "message": message,
        }
        if data:
            record["data"] = data
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self._write_lock:
            if self._stream.closed:
                self._stream = self.events_path.open("a", encoding="utf-8", buffering=1)
            self._stream.write(line)
        if level.lower() in CONSOLE_LEVELS:
            print(f"[{level.upper():7}] {event}: {message}", flush=True)

    def finish(self, status: str, error: str | None = None) -> None:
        finished = datetime.now(timezone.utc)
        self._manifest["status"] = status
        self._manifest["finished_at"] = finished.isoformat()
        self._manifest["duration_seconds"] = round(
            (finished - self._started_at).total_seconds(), 3
        )
        if error:
            self._manifest["error"] = error
        self._write_manifest()
        with self._write_lock:
            if not self._stream.closed:
                self._stream.close()

    def _write_manifest(self) -> None:
        temporary = self.manifest_path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(self._manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temporary.replace(self.manifest_path)
