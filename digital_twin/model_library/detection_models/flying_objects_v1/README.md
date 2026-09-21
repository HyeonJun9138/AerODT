# 비행물체 영상 탐지 패키지

Javvanny/yolov8m_flying_objects_detection의 고정 revision을 제한된 체크포인트
로더로 읽고 ONNX로 변환한 로컬 모델이다. 운영 경로는 ONNX만 읽는다.
원본 URL, SHA-256, 변환 도구 버전과 허용 클래스 목록은 manifest.json에 있다.
원본 체크포인트는 로컬 검증용이며 커밋하지 않는다.

## 실제 클래스 계약

모델 카드에는 Background가 포함되어 있지만 실제 가중치는 배경 없는 5개
전경 클래스다. 인덱스는 가중치에서 검증했다.

| ID | 원본 이름 | 표시 이름 |
|---|---|---|
| 0 | БПЛА коптер | Drone |
| 1 | самолет | Airplane |
| 2 | вертолет | Helicopter |
| 3 | птица | Bird |
| 4 | БПЛА самелет | Fixed-wing drone |

UAM 학습은 확인되지 않았다. Drone을 UAM으로 바꾸지 않는다.

## 설치와 재현

기존 대시보드 Python을 변경하지 않는 전용 Python 환경을
project_support/environment/camera_detection에 만든다. Windows 기본 조립은
그 폴더의 Scripts/python.exe를 사용한다. 다른 OS/환경은 실행 구성의
camera_detection_python으로 지정한다. Python 3.10 이상에서 다음 의존성을
전용 환경에 설치한다. 기존 시스템 site-packages와 섞을 경우 torch 패키지의
메타데이터와 실제 __version__이 같은지 반드시 확인한다.

```text
torch==2.6.0 (CPU wheel 권장, 변환 시에만 필요)
torchvision==0.21.0
ultralytics==8.3.203
onnx==1.18.0
onnxruntime==1.22.1
lap==0.5.12
scipy==1.15.3
ultralytics-thop==2.0.17
polars==1.32.3
numpy, opencv-python, Pillow, PyYAML, matplotlib, requests, psutil
```

전용 Python으로 project_support/tools/setup_camera_detection.py를 실행한다.
다운로드는 고정 revision과 해시를 확인한다. 설치 도구는 torch 2.6 이상,
검토한 Ultralytics 8.3.203, 고정 allowlist를 요구한다. 동적으로 발견한
임의 클래스를 추가하거나 unrestricted pickle 로드로 우회하지 않는다.
운영 중 자동 패키지 설치와 모델 다운로드는 하지 않는다.

## 사용 조건과 검증 한계

[모델 카드](https://huggingface.co/Javvanny/yolov8m_flying_objects_detection)는
MIT라고 표기하지만 이것이 기반 YOLO와 ByteTrack 구현의 조건을 바꾸지는 않는다.
[Ultralytics 조건](https://www.ultralytics.com/license)은 AGPL-3.0 또는 Enterprise다.
이 패키지가 전체 시스템의 배포 적합성을 승인한다는 뜻이 아니며, 배포 전에
관련 조건을 별도로 검토해야 한다. 자동 라이선스 구매나 동의는 하지 않는다.

ONNX 입력은 고정 RGB float32 1×3×640×640, 114 letterbox, [0,1] 정규화다.
클래스별 NMS 후 원본 영상 좌표로 복원하고 세션별 ByteTrack을 적용한다.
confidence 0.1 이상을 tracker에 전달하고 0.25 이상 활성 추적만 표시한다.

실제 Boeing747 사진에서 Airplane 출력과 같은 JPEG 3프레임의 ID 유지가
확인되었다. 이는 실제 움직임의 장기 추적이나 UAM 정확도 평가가 아니다.
제공자의 글자와 박스가 포함된 validation montage에서는 글자를 비행기로
오탐했다. 해당 montage는 성공 증거로 사용하지 않았다. 실제 시뮬레이션
카메라의 일반화 성능, 야간/가림/작은 객체와 운영 안전성은 검증되지 않았다.
