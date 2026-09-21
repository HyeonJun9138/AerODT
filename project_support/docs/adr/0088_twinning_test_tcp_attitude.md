# ADR 0088: 독립 Twinning Test와 TCP 자세 입력 v1

## 결정

Live Twinning에 명시적으로 켜는 Twinning Test를 추가한다. 다른 컴퓨터가
아이폰 ZIG SIM 관측을 중계하며 이 서버는 IPv4 TCP 서버로 동작한다.
이 기능은 센서와 시각화 연결 실험이며 실기체 제어, UAM 임무 실행,
상태 추정 정확도 검증 또는 Digital-to-Physical 구동기 제어가 아니다.

## 책임

- `communication/twinning_tcp.py`: 길이가 제한된 JSONL v1 해석과 단일 TCP 연결.
- `digital_twin/contracts/test_attitude.py`: 불변 자세 관측.
- `digital_twin/runtime/twinning_test.py`: 독립 테스트 자세의 유일한 소유자.
  수신 자세와 기준 quaternion으로 불변 snapshot을 만든다. 실제 World에는 등록하지 않는다.
- `user_application/apps/web_dashboard/twinning_test.py`: 수신기 및 runtime 조립,
  테스트 시작/종료, 시각화 모델 선택. 기존 Data AuditJournal에 연결 활동을 기록한다.
- `communication/web/twinning_test_routes.py`: 명시적인 start/stop/calibrate와 읽기 전용 status.
- `user_application/web/twinning_test_panel.js`: 설정과 모니터링 UI.
- `digital_twin/visualization/web/twinning_preview.js`: 독립 Cesium 모델 표시.
  FRD quaternion은 표시 경계에서 X-forward/Y-left/Z-up으로 변환한다.

## 계약과 수명

기본 OFF이며 TCP 포트는 명시적인 수신 시작에서만 열린다. 기본 5005,
설정 가능 범위 1024~65535. 한 연결 안에서 device_id는 고정이고 seq는 증가해야 한다.
두 번째 연결은 닫는다. 재접속하면 기준 자세와 관측을 초기화한다.
마지막 정상 메시지 이후 단조 시계로 2초가 지나면 stale이다.
TCP 연결 상태와 관측 상태는 별도이며, 연결이 살아 있어도 stale일 수 있다.
오류 메시지는 현재 자세를 갱신하거나 freshness를 연장하지 않는다.

보정은 Euler 각 차감이 아니라 inverse(reference quaternion) * current quaternion이다.
원본과 적용 Euler 각을 함께 표시한다. Euler 표시에는 특이점이 존재하지만
실제 회전 계산은 quaternion을 사용한다. 모델 기수 정렬은 표시 전용이며 원본값을 바꾸지 않는다.

종료 시 listener, client와 수신 task를 닫고 테스트 runtime을 초기화한다.
대시보드 shutdown에서도 같은 정리가 실행된다. 정상 페이지 이탈은 stop beacon을
보내며 시작 operation_id의 취소를 최대 64개 보관하여 stop이 start보다 먼저 도착한
경우에도 해당 start를 거부한다. 브라우저 강제 종료나 네트워크 단절에서 beacon 전달을
보장하지 않으므로 이런 경우 다시 접속해 명시적으로 수신을 중지해야 한다.

## 안전 범위

TCP는 인증/암호화를 제공하지 않는다. 신뢰하는 LAN 또는 보호된 VPN에서만 사용하며
공인망에 포트를 개방하지 않는다. 방화벽 변경은 자동 수행하지 않는다.
대시보드 제어 API는 기존 same-origin 정책을 따른다. 원격 sender IP 제한이 필요한
경우 운영체제 방화벽에서 승인된 중계 컴퓨터로 범위를 제한한다.

송신 규칙 및 전달용 예시는 `project_support/docs/twinning_test_sender_v1.md`를 따른다.
실제 휴대폰 관측, 기체별 시각축 및 Unreal/UAM 임무 검증은 별도의 실험이다.
