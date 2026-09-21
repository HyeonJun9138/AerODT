# ADR 0089: 격리된 Twinning Test 센서 v2

상태: 채택, 2026-09-14.

사용자 승인에 따라 v1 호환 JSONL v2에 선택적 자세/가속도/GPS와 센서별 관측 시각을 추가한다.
communication은 검증과 TCP framing, contracts는 불변 관측, runtime은 최신 센서/고도 기준/보정,
data는 60초/1200행 이력, application은 조립 및 history API, visualization은 독립 Cesium 표시를 담당한다.
GET /api/twinning-test/history는 session_id, seconds, now_s와 rows를 반환한다.
각 row는 time_s, seq, attitude [r,p,y], acceleration [x,y,z], gps [lon,lat,alt]를 가지며 미관측은 null이다.
20Hz 고정 버킷으로 실제 관측만 보관하고 보간하지 않는다. GPS 원점은 runtime만 소유한다.
기존 World와 운항 엔티티에 센서 값을 쓰지 않는다. 새 ACK나 제어 프로토콜은 추가하지 않는다.
첫 신선한 GPS 고도를 지면 기준으로 삼는 표시 방식이며 MSL을 타원체 고도로 오인하지 않는다.
상세 wire 계약은 project_support/docs/twinning_test_sender_v2.md 참조.
