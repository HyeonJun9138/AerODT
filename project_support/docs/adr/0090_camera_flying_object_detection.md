# ADR 0090: 기체 카메라의 로컬 영상 탐지와 파생 추적 상태

상태: 승인된 2026-09-14 카메라 설계 구현.

## 결정

브라우저는 시뮬레이션 장면의 JPEG만 전송한다. Communication은 같은 origin의
JSON 계약과 요청 상한을 검사한다. Application은 선택적인 전용 Python
프로세스를 조립하고, AI PnP는 영상 인식과 세션별 ByteTrack 파생 상태를
소유한다. 모델 정의와 가중치는 model_library/detection_models에 있다.
현재 물리 상태, 제어 명령, 시뮬레이터 정답 좌표는 이 경로의 입력이 아니다.

GET /api/camera/model은 가용성만 반환하며 프로세스/모델을 시작하지 않는다.
POST /api/camera/detect의 요청은 session_id, entity_id, camera, frame_id,
captured_at, width, height, image_base64다. camera는 front/rear/left/right/down,
frame_id는 비음수 정수, captured_at은 유한 비음수 클라이언트 캡처 시각이다.
시각 단위는 클라이언트 동일 시계이며 서버는 변환하지 않고 그대로 돌려준다.
JPEG base64는 1 MiB 이하, decoded width≤1280 height≤720이고 선언 크기와 같아야
한다. 기본 영상은 576×288이다. JSON 전체는 1 MiB+8192 byte 이하로 제한한다.

응답은 image_base64를 제외한 모든 메타데이터와 detections, inference_ms,
model_id를 포함한다. detections는 box[x1,y1,x2,y2], class_name, confidence,
track_id다. 좌표는 요청 JPEG의 원본 픽셀이다. 트랙 ID는 해당 세션에서만
유효하며 다른 세션과의 숫자 일치를 객체 일치로 해석하지 않는다.

한 번에 추론 하나만 허용하고 대기열은 만들지 않는다. 바쁜 상태/모델 실패는
503, 입력/세션/순번 오류는 422, body 상한 초과는 413, origin 오류는 403이다.
최대 8개 세션을 유지하고 30초 idle 세션은 1초 주기 정리 스레드로 해제한다. entity,
camera 또는 크기를 변경할 때 새 세션이 필요하다. 같은 세션은 frame_id가
증가하고 captured_at이 역행하지 않아야 한다. DELETE /api/camera/session/{id}는
모델을 다시 로드하지 않고 파생 추적만 해제한다. 실행 중 삭제 요청도 처리 후
정리한다. 작업 종료는 child process를 종료한다. 영상 payload는 audit에
보관하지 않고 HTTP 바이트 수와 성공/실패만 기록한다.

## 가중치와 한계

고정 Hugging Face revision 07d22a0c022c349323ded7f8f5806e59cf420683의 best.pt를
검증하고 torch 2.6의 weights_only=True 및 검토한 고정 클래스 allowlist로
ONNX 변환했다. 런타임은 다운로드된 pickle을 로드하지 않는다. 모델 카드와
달리 실제 클래스는 Drone, Airplane, Helicopter, Bird, Fixed-wing drone이며
Background는 없다. 러시아어 원본 클래스와 번역을 manifest에 보존한다.

카드의 MIT 표기와 Ultralytics AGPL-3.0/Enterprise 조건은 별도로 기록한다.
배포 적합성을 승인하지 않는다. UAM 전용 모델, 회피 제어, 정확한 객체 식별,
실시간성 또는 native UAM 임무 완료를 보장하지 않는다.
