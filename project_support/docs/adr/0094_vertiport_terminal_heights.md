# ADR 0094: 버티포트별 이착륙 높이와 편집 잠금

상태: 구현, 실제 브라우저 및 Unreal 검증 대기 (2026-09-15)

## 결정

버티포트 definition/layout과 route FATO endpoint에 takeoff_height_m, landing_height_m을 추가한다. 단위는 패드 상면 기준 m, 기본값은 기존 동작인 30 m, 유효 범위는 1~300 m다. 기존 hover_m은 호환 별칭으로 남기고 both FATO에서도 경로 출발/도착 역할에 따라 올바른 값을 선택한다. build_plan의 수직 이착륙 구간과 공중 경로 양끝에 동일 값을 사용한다.

GET /api/simulation/vertiports/edit-state는 locked, state, message를 반환한다. 실행과 일시정지에서는 create/update/delete를 HTTP 409 simulation_running으로 거부한다. 최종 저장은 ScenarioSession의 실행 전환과 같은 RLock에서 확인한다. 중지 후 저장하면 이미 준비된 시나리오는 dirty가 되어 과거 경로 재생을 거부하고 비행계획을 다시 불러오도록 안내한다.

편집은 원본 경로를 바꾸지 않는 ghost로 표시한다. 비동기 결과는 편집 세대로 검증하며 취소/저장/이탈/다른 버티포트 선택 시 정리한다. 위치나 데크 높이 등 기하를 같이 바꾼 경우 먼저 저장하라고 안내한다.

## 판정 범위와 한계

기존 건물 자료 기반 검사를 재사용한다. 지형 검사는 연결 경로 중심선의 샘플 높이와 경로 높이를 비교하고 terrain_collisions, terrain_min_clearance_m, terrain_checked를 반환한다. 자료 누락/평면 대체 지형은 판정 불가로 취급한다. B/J 수직구간, 샘플 사이의 지형, 기체 체적 전체 및 미수신 장애물에 대한 충돌 보장은 하지 않는다. 운항 안전 인증 기능이 아니다. 기존 저장 데이터는 새 필드 없이 기본 30 m로 읽힌다.
