# Twinning Test 구현 계획

승인된 설계: TCP JSONL v1 아이폰 중계 입력을 독립 테스트 기체의 자세에만 적용한다. 기본 OFF, 포트 5005, 단일 TCP 연결, 마지막 정상 메시지 이후 2초 stale. 실제 World/임무/예측 모델은 변경하지 않는다. 현재 작업 폴더에서 기존 변경을 보존한다.

## 순차 구현 및 검증
- [x] communication/twinning_tcp.py: JSONL 검증, 4096 byte 행 제한, 단일 연결, 잘못된 JSON/역행 sequence/장치 변경 차단. pytest 실제 loopback 분할 및 병합 전송 검증.
- [x] digital_twin/runtime/twinning_test.py: 불변 테스트 snapshot, quaternion 기준 자세 보정, 단조 시계 수신 age. pytest 기준 자세 및 stale 검증.
- [x] user_application/apps/web_dashboard/twinning_test.py 와 communication/web/twinning_test_routes.py: start/stop/status/calibrate, same-origin 보호, startup OFF 및 shutdown 정리. TestClient 검증.
- [x] user_application/web/twinning_test_panel.js 및 visualization preview: 선택 모델 독립 확대, 현재 자세, 데이터 상태, 오류, 연결 제어. Node 검증 및 가능한 실제 브라우저 확인.
- [x] ADR와 송신 규칙, CURRENT/HISTORY에 실행한 검증과 미검증 범위 기록. 자동 방화벽 변경/운영 배포/서버 재시작 없음.

검증: Python 15 PASS, Node 26 PASS. 로컬 브라우저에서 실제 loopback TCP 입력, 모델 회전, 기준 자세 설정, 연결 유지 중 stale, 종료 후 포트 닫힘을 확인했다. 실제 아이폰/LAN, 전체 UAM 임무 및 Unreal은 미검증. 운영 배포/재시작은 하지 않았다.
