# ADR 0031: 비행계획, batch 실행, 경로 조종사의 분리

- 날짜: 2026-09-10
- 상태: 계획/실행/조종사 분리 적용. 이해관계자 실시간 운항은 후속 설계.

## 배경

web application 내부의 Plans/Runs가 요청 해석, 계획 생성, 엔진 선택과 기록을 한 번에 처리했다.
native runner의 main에도 경로 추종 판단이 있었다. UI 재생과 실시간 조종 개입을 혼동할 여지가 있었다.

## 결정

- Application의 FlightPlanning과 FlightExecution으로 책임을 나눈다.
- Data의 FlightPlans는 ID별 불변 계획과 SHA-256을 저장한다. 원자적 게시 이전의 파일은 읽지 않는다.
- `POST /api/simulation/plans`는 준비된 문서 `{schema_version:1, plan_id, created_at,
  content_sha256, plan}`를 201로 반환한다. GET `.../plans/{plan_id}`는 그 문서 또는 404다.
- 기존 options/preview API는 유지한다. preview는 저장하거나 실행하지 않는다.
- `POST /api/simulation/runs`에 `{plan_id, rate_hz?, execution_mode?}`를 추가한다.
  실행 시 항로를 다시 만들지 않고 저장된 계획을 읽는다. plan_id와 계획 override의 혼용은 422다.
  기존 raw 계획 요청도 유지하되 먼저 불변 계획을 저장한다.
- `execution_mode`는 `batch_precleared`만 허용한다. commands/interactive를 조용히 무시하지 않는다.
- 실행 결과 plan.execution과 run.summary.execution에 plan ID/hash와 독립 batch 식별자를 남긴다.
  기존 run schema 1의 선택 필드 확장이며 예전 기록은 그대로 읽는다. runtime 전역 actor 등록은 아니다.
- 결과의 시간 재조정은 원본 계획과 별도 저장한다. auto/native/kinematic 선택과 fallback 표시는 보존한다.
- 긴 계산은 HTTP event loop 밖에서 실행한다. 현재 단일 비행 도구는 프로세스당 batch 1개만
  허용하며 추가 실행은 409 run_busy로 답한다. 조회와 live 갱신은 계산 중에도 진행한다.
- C++ RoutePilot은 경로 진행과 goal 생성만 소유한다. Runtime 의존이나 physics tick은 갖지 않는다.
  runner는 monostate waypoint 보고를 tick으로 바꾸지 않고 다음 목표를 요청한다.
- Vehicle Model, FastPhysics 이산 순서, SimpleFlight 및 actuator 방정식을 변경하지 않는다.

## 상호작용 경계

Interaction Model은 정책과 규칙의 정적 라이브러리다. 활동 중인 Pilot/Operator/PSU는 application
운영 실행 부분에 둔다. 상태의 권위는 기존 Runtime에 남긴다. 내부 bus나 새 gateway는 만들지 않는다.
구체 역할, 명령 계약과 요청/허가/보고 흐름은 `../architecture/FLIGHT_OPERATIONS.md`에 정의한다.
아직 없는 관제/예약 과정을 실행 후 생성한 가짜 이벤트로 증명하지 않는다.

## 검증 기준과 한계

분리 전후 동일 입력의 native stdout을 smooth 0/1 각각 byte 비교한다. 단위 시험은 조종사별 진행
격리, 관측 비변경, 목표 종류, hover 안정화와 시동을 검사한다. 계획 저장에는 엔진 호출 금지,
편집 후 기존 계획 실행, 내용 손상, ID 경로 검증, 중복 계획 저장 격리, 재시간화 원본 보존 시험을 둔다.
UI는 계획 저장만으로 비행이 시작되지 않으며 입력 변경/지연 응답/중복 실행을 검사한다.

실시간 대기/재허가, PSU 판단, 버티포트 자원 경합, 외부 계획 import, 실제 승객 상태와 Unreal
검증은 이번 적용 범위가 아니다. 준비한 계획은 지도 정의 변경 뒤에도 의도적으로 보존되며 실제 운항
허가를 뜻하지 않는다. 후속 실시간 실행에서는 최신 자원 및 환경을 별도로 재검증해야 한다.
