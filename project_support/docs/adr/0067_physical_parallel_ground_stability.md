# ADR 0067: 병렬 Physical 수신과 지상 정지 관측 제약

- 날짜: 2026-09-11
- 상태: 적용

## 배경

100대 Physical 센서를 하나의 HTTP latest batch로 받았다. 전역 sequence를 수신 순서로 간주하면 병렬 응답에서 정상적인 다른 기체의 패킷이 거절된다. 송신 과부하 복구가 센서·임무 ID를 초기화했고, Twin은 지상 잡음과 AHRS 누락에 의해 정지 기체의 위치·자세를 바꿀 수 있었다.

## 결정

- 기존 HTTP JSON 및 gzip 전송을 유지한다. fleet status가 telemetry_shards=4를 광고하면 수신기는 CRC32(aircraft_id)%4로 분할된 네 개의 latest 요청을 독립적으로 실행한다. 쿼리는 delivery=latest, shards=4, shard=0..3이다. ordered API는 기존대로 유지한다. 기능을 광고하지 않는 송신기는 단일 batch로 받는다.
- 최대 네 개의 진행 요청, 그룹별 cursor와 재시도 간격을 둔다. FIRST_COMPLETED로 완료된 그룹부터 반영하며 다른 그룹을 기다리는 병합 장벽을 두지 않는다. 수신 해제·주소/세대 변경·종료는 진행 요청을 취소하고 회수한다. 느린 그룹 격리가 목적이며 CPU 계산의 네 배 병렬화나 대역폭 감소를 의미하지 않는다.
- optional aircraft_sequence를 임무별로 추가한다. 전역 sequence는 cursor로 유지하고 병렬 수신의 중복·역행 검사는 기체별로 한다. 센서 시각과 임무/프로세스 연속성 검사는 유지한다. latest coalescing은 원시 센서 이력 재생과 구별하며 샘플 누락과 불확실성을 숨기지 않는다.
- 매 응답의 상태 표시에는 전체 센서·경로의 deep copy 대신 관측 시각 scalar만 읽는다. 입력 이력의 소유권과 World 현재 상태의 단일 소유권은 바꾸지 않는다.
- 송신 과부하 복구는 미래 샘플의 스케줄만 현재 시계에 맞춘다. 이미 생성된 backlog는 폐기하되 과거 관측의 시각을 고쳐 쓰지 않는다. 센서 바이어스·sequence·실제 임무 ID·outage 상태는 유지한다. tick당 최대 두 번/.1초 wall budget으로 실행 기회를 나눈다.
- World entity의 불변 SensorPosterior에 정지 획득 시각·위치·자세를 보관한다. 새 StateStore를 만들지 않는다. 모델 패키지의 ground_constraints가 실제 접지 보고, 정지 phase/명시적 지상 대기, GNSS 속도, IMU 각속도, AHRS와 위치 일치 여부를 검사한다. 1.5초 확인 후 정지 위치·자세/0속도를 유지하고 원본 센서 잡음과 공분산 하한을 보존한다.
- 신선도 한도는 2초다. 이미 획득된 정지는 최대6초의 일시 지연 동안 위치만 유지하며 fresh/stationary 진단을 거짓 갱신하지 않는다. 실제 이동·접지 해제·모순·만료에서는 제약을 해제한다. 실제 지상 이동이나 이륙을 gate 좌표에 고정하지 않는다.
- AHRS가 없거나 늦으면 마지막 채택 자세를 유지하며 관측 경과와 stale 상태를 공개한다. 보고된 surface_reference를 근접한 접지 고도 제약 및 Physical 지도 deck datum 정합에 사용한다. simulator truth endpoint나 계획 gate 위치로 센서값을 덮어쓰지 않는다.

## 검증과 한계

Python68, Node19, architecture PASS. 지연된 한 그룹과 취소·역행·100기체 분할·과부하 연속성·정지/이동/이륙 전환·누락 AHRS를 시험했다. 실제 원격100대 수신 및20초 정지 표본의 위치·고도·방위 유지도 확인했다. 상세 수치와 명령은 data/development_log/evidence/2026_09_11_physical_parallel_stability.json에 기록한다.

병렬 요청은 느린 그룹을 격리하지만 전체 응답시간이나 호스트 계산량을 항상 줄이지 않는다. 실제 항공전자 통신 규격이나 절대 GNSS 바이어스 보정은 아니다. native/Unreal 전체 임무를 이번 변경으로 재검증하지 않았다.
