# AeroDT V1 코드 경계

## 실행 구조

```text
User/Application: Web Dashboard
  -> Communication: versioned HTTP/WebSocket routes and external-provider adapters
  -> Digital Twin: immutable aircraft, UAM and satellite snapshots
  -> Visualization: CesiumJS domain shell and domain-owned presentation modules
  -> Data: optional local runtime records under data/workspace
```

CesiumJS 시각화는 snapshot을 소비할 뿐 현재 물리 상태를 소유하지 않는다. 공급자
인증정보, 응답 캐시, 실행 로그와 DEM은 로컬 운용 자료이며 소스 저장소에 넣지 않는다.
ProjectAirSim 원본과 Unreal 호스트는 현재 배포 범위에 포함하지 않는다.

Native headless 실행 경로는 다음과 같다.

```text
User/Application: uam_native_demo
  -> UamMissionSequencer (snapshot을 읽고 typed goal만 생성)
  -> UamVehicleRuntime (현재 상태의 유일한 소유자)
     -> FastPhysics + SimpleFlight + UAM actuators
     -> StateSnapshot + transition diagnostics
     -> simulation-time native SensorFrame
  -> Data: RunRecorder
     -> data/workspace/logs/runs/<run-id>/events.jsonl
     -> data/workspace/logs/runs/<run-id>/manifest.json
     -> data/workspace/logs/runs/<run-id>/sensor_telemetry.jsonl
```

Web 시각화 경계는 다음과 같다.

```text
UamVehicleRuntime StateSnapshot
  -> immutable browser snapshot
  -> Cesium entity/model pose
  -> cockpit, planning and operations presentation
```

표시 계층의 보간과 카메라 상태는 화면 표현에만 쓰며 runtime으로 되먹이지 않는다.
접촉 판정은 native runtime의 contact model이 담당하고 브라우저 지형은 시각 자료다.

Mission sequencer는 운용 단계와 goal 생성만 담당하며 physics state를 복제하지
않는다. waypoint 완료는 위치와 속도 허용오차를 함께 사용한다. 고정익 천이의
작은 상승 속도는 AirTaxi의 strict speed threshold를 결정론적으로 넘기기 위한
mission profile 값이며 SimpleFlight의 임계값을 변경하지 않는다.
착륙 단계는 하강 속도 goal을 내고 `StateSnapshot::is_grounded`와 정지 속도가
확인된 뒤에만 완료한다. Headless 실행에서는 model package에서 생성한 body
clearance를 쓰는 `FlatGroundContactModel`이 contact를 제공한다.

Native 계산 경로는 renderer와 독립적으로 실행된다.

```text
Model Library JSONC package
  -> build-time package compiler
  -> typed UamRuntimeConfig
  -> UamVehicleRuntime (현재 상태의 단일 소유자)
     -> 이전 actuator wrench로 FastPhysics 적분
     -> IMU, GPS와 camera state의 독립 sample schedule 갱신
     -> ground-truth state를 SimpleFlight 좌표 입력으로 변환
     -> typed position 또는 velocity + yaw goal 처리
     -> multirotor와 tiltrotor fixed-wing cascade를 매 tick 계산
     -> 속도 확인 및 5초 flight-mode blend
     -> SimpleFlight tiltrotor mixer
     -> tilt, rotor, control-surface actuator 갱신
     -> 다음 tick wrench + StateSnapshot
```

package compiler는 실행 중인 서비스나 별도 loader가 아니다. 정적 모델 정의를 빌드 산출물인 typed C++ 구성으로 변환하므로 native runtime에는 JSON parser와 legacy 코드 의존성이 없다. SimpleFlight의 문자열 parameter map도 컴파일 경계에서 기본값과 override를 적용한 typed `SimpleFlightParameters`로 바뀌며 runtime에는 원본 map을 중복 저장하지 않는다.

Sensor definition은 같은 package의 `sensors.jsonc`에 있으며 runtime tick은 physics
직후 immutable `SensorFrame`을 방출한다. IMU/GPS/camera가 현재 상태를 별도로
저장하지 않으며 각 sample schedule과 sequence만 소유한다. Data Layer writer는
frame을 JSONL wire/storage 형식으로 바꾸지만 simulation에 역의존하지 않는다.

`fixed_wing_capable`은 model package에 저장된 airframe 특성이고,
`fixed_wing_requested`는 runtime velocity update의 운용 입력이다. 전환 결과는
현재 상태의 별도 사본이 아니라 같은 tick 결과의 진단 값으로 반환한다.

접촉 흐름은 다음과 같다.

```text
Native contact model
  -> immutable ContactObservation contract
  -> UamVehicleRuntime tick
  -> FastPhysics free-flight candidate
  -> landing / grounded latch / impulse response branch
  -> authoritative VehicleState
```

공통 시계 위의 여러 개체(Simulation Engine의 Temporal State Manager 자리)는 다음과 같다.

```text
User/Application (임무·비행계획 스케줄러)
  -> SimulationWorld (runtime): SimulationClock 한 개, 개체 목록, 개체별 StateSnapshot
     -> UamVehicleRuntime (물리 기체) — application이 넘긴 VehicleStep으로 tick
     -> TrajectoryActorRuntime (궤적 배우) — KinematicTrajectory 표를 시계 시각으로 읽음
  -> 매 스텝 스냅샷 열 (기체 먼저, 배우 다음)
```

World는 기체를 어떻게 모는지, 개체가 서로 어떻게 상호작용하는지 모른다. 기체 골격은
`simple_flight/airframe.hpp`의 `Airframe`이 정하고, 패키지 컴파일러가 actuator
topology를 그에 맞춰 검사하며, `SimpleFlightMixer`가 골격별 행렬을 고른다.

## 계층별 책임

### 계획과 운영자 실행

웹의 계획 생성은 `user_application/uam_mission/flight_planning.py`, 불변 계획 저장은
`data/simulation/flight_plans.py`, batch 실행 조립은 `user_application/uam_mission/flight_execution.py`다.
native 임의 경로의 조종사 목표 계산은 같은 mission 모듈의 `RoutePilot`이 맡는다.
실행 프로그램은 목표를 Runtime에 적용할 뿐 조종사 판단을 다시 구현하지 않는다.
물리 상태는 Runtime, 조종사의 의도와 진행은 application, 과거 기록은 Data 소유다.

Interaction Model에는 정적 역할 정책을 두고 활동 중인 이해관계자 객체를 두지 않는다.
PSU/버티포트 운영자/승객의 후속 계약과 전체 도식은 [비행 운영 분리 설계](FLIGHT_OPERATIONS.md)에 있다.
현재 batch 실행은 허가를 사전 가정하며 실시간 관제 기능이 아니다. 재생 제어를 운항 명령으로
사용하지 않는다. API 확장과 호환성은 ADR 0031에 기록했다.

다중 비행은 application의 `ScenarioPilots`가 기체별 native `RoutePilot`과
`UamVehicleRuntime`을 communication C ABI adapter로 연결한다. `ScenarioEngine`은
계획 시각 도래와 관측 수집을 담당한다. 시설별 `VertiportGroundControl`은 출발
스탠드에서 FATO까지 최단·차선 유도로 후보와 현재 점유 사실을 제안하고 지상이동
권한을 발급한다. FATO와 지상경로 후보 비교·출발 충돌 해석·출발 슬롯과 시설 순서는
`PsuSequencer`가 소유한다. 비행 목표는 조종사, 물리 상태는 Runtime이 소유한다.
표시 계층은 관찰된 자세/틸트/회전수만 소비한다. 경로 입력, 우측 오프셋 및 공유 패널
종료 계약은 [ADR 0040](../adr/0040_native_scheduled_route_pilots.md)에 기록했다.
단일/다중의 경로 유도는 같은 `RoutePilot` 정책과 획득 반경을 사용한다. 다중 전용
`precision_route` 분기는 제거했으며 통과점, 출발 정렬 및 접근 제동 계약은
[ADR 0046](../adr/0046_shared_single_and_fleet_guidance.md)을 따른다.
항로 탐색은 WP 사이 F만 양방향이며 C/G는 단방향이다. 스케줄 생성은 전체 경유점
순서를 CSV에 보존하고, 실행은 명시된 순서를 다시 최적화하지 않는다. 항로가 없는
경우 직선으로 대체하지 않는 계약은 [ADR 0047](../adr/0047_network_routes_and_schedule_waypoints.md)을 따른다.

버티포트 자원 경계는 [ADR 0104](../adr/0104_vertiport_resource_reports.md)를 따른다.
ScenarioEngine은 물리 점유 관측만 시설별 `VertiportOperator`에 전달하고, 운영자는
버전·순번·유효시간이 있는 `VertiportResourceReport`를 발행한다. PSU는 시설 객체나
SimulationEngine의 점유 표를 직접 조회하지 않고 `VertiportResourceMonitor`가 받은
보고로 FATO 가용성과 주기장 점유·예약을 판단한다. PSU의 교통 슬롯과 시설의 자원
상태는 서로 다른 상태다.

버티포트 지상경로 제안은 현재 동일 프로세스 typed call이다. 정적 그래프와 실제 위치
관측을 받아 계산하지만 현재 위치를 별도로 저장하지 않는다. `ScenarioEngine`은 제안된
로컬 경로를 실행 좌표로 투영하고 움직임을 적분할 뿐 유도로 탐색을 다시 구현하지 않는다.
운항 판단 요약은 `events.jsonl`, 노드별 후보와 탈락 사유는 개발용
`diagnostics.jsonl`에 분리하며, 어느 로그도 Runtime의 현재 상태가 아니다. 세부 결정은
[ADR 0106](../adr/0106_vertiport_ground_route_proposals.md)을 따른다.

도착 GATE는 접근 전에 선점하지 않는다. PSU는 FATO가 사용 가능하면 GATE 없이도
착륙을 허가할 수 있고, 접지 관측 순서대로 빈 GATE와 버티포트가 제안한 복수
FATO→GATE 경로를 선택한다. GATE가 없으면 실제 기체는 FATO에 남아 점유를 유지한다.
동일 FATO의 공중 대기 순번은 남은 항로 ETA로 갱신하고, FATO 착륙 시작점 위에
10 m 간격의 순번별 대기층을 지정한다. 세부 결정은
[ADR 0110](../adr/0110_touchdown_order_gate_and_fato_holding.md)을 따른다.

겸용 FATO에 접지한 기체가 출발 용량을 모두 닫지 않도록 PSU는 임박한 출발 수요가
있을 때 착륙 전후의 실제 사용 가능 이륙 FATO 수를 비교한다. 기본은 300초 안의
출발편에 대해 이륙 가능한 FATO의 50%를 남기는 것이다. 서로 다른 FATO는 중심
거리에 관계없이 독립 자원으로 세고, 이미 최종 진입한 착륙편과 해당 FATO의 실제
점유를 함께 센다. 부족하면 Pilot을 기존 FATO 주변 대기층에 유지한다.
버티포트는 자원 사실을 보고하고 Simulation은 기하·현재 교통 관측을 제공할 뿐 보호
비율과 허가 결과는 PSU가 소유한다. 세부 결정은
[ADR 0111](../adr/0111_mixed_fato_departure_capacity_reserve.md)을 따른다.

PSU와 조종사, 조종사와 Runtime의 방향별 계약은
[PSU/Pilot ICD](PSU_PILOT_ICD.md)와
[ADR 0105](../adr/0105_pilot_psu_runtime_boundaries.md)를 따른다. Pilot→PSU 요청·보고,
PSU→Pilot 응답·허가·지시, Pilot→Runtime 조종 의도를 서로 다른 typed 계약으로
분리한다. PSU가 Simulation이나 actuator를 직접 명령하는 경로는 없다. 수동 축 입력,
조종 보조와 자동 유도는 생성 방식만 다르며 Pilot→Runtime 경계는 같다.

접근 순번 요청 시점도 Pilot이 소유한다. Simulation은 현재 위치와 남은 시간 관측만
제공하고, 자동 Pilot은 기준 충족 시 요청을 보내며 수동 Pilot은 동일 기준에서 버튼과
알림을 활성화한다. PSU는 요청 이후의 순번과 자원 판단만 수행한다. 이 경계는
[ADR 0107](../adr/0107_pilot_owned_arrival_request_trigger.md)을 따른다.

| 계층 | 현재 책임 | 현재 제외 범위 |
|---|---|---|
| Foundation | 시간, 진단 계약, 공통 값 타입 | 시뮬레이션 상태 소유 |
| Communication | 외부 공급자와 HTTP/WebSocket 프로토콜 경계 | 현재 상태 저장, 임무 로직 |
| Data | 실행 폴더, JSONL event, 원자적 상태 manifest, 향후 replay | 제어 및 물리 계산 |
| Digital Twin Contracts | 계층 간 불변 상태 및 contact observation 형식 | 구체 통신 및 파일 형식 |
| Model Library | 기체 패키지(질량, 공력, actuator, native sensor, SimpleFlight 설정, airframe), 버티포트·항로 규칙 | 실행 생명주기 |
| Runtime | 기체 현재 상태, model package 조립, 이산 tick 및 sensor phase 순서, SimulationClock·SimulationWorld·궤적 배우 | 통신 및 renderer 구현 세부사항, 임무·스케줄 논리 |
| Simulation | FastPhysics, 공력·접촉 계산, SimpleFlight core와 골격별 믹서, actuator, ideal sensor 계산, 궤적 표 보간 | 화면 표현과 임무 로직 |
| Visualization | 불변 snapshot의 CesiumJS 표현, 카메라와 표시 수명주기 | 물리 상태의 권위 있는 소유, simulation tick |
| User/Application | 임무 sequencer, 조립, CLI, 운용 흐름 | 물리 상태 소유 및 프로토콜 구현 |

## 중복 방지 결정

계층 내부 UAM/Satellite 구현 경로와 공유 기준은 [도메인 소유권](DOMAIN_OWNERSHIP.md)과 [도메인 구현 경로 ADR](../adr/20260921_domain_owned_implementation_paths.md)을 따른다.

웹의 UAM 학습 예측은 [ADR 0058](../adr/0058_uam_learned_prediction_comparison.md)을 따른다.
Data가 제한된 과거 입력 이력, AI PnP가 미래 예측 결과를 소유한다. Application은
현재 runtime 상태와 활성 조종사 의도를 잠금 안에서 읽고, 추론은 잠금 밖에서
실행한다. 모델 라이브러리는 가용성 및 검증 계약만 제공하고 시각화는 예측을
읽기만 한다. 예측 경로는 runtime 상태 또는 비행 명령을 수정하지 않는다.

1. 현재 상태 저장소를 별도로 만들지 않는다. 권위 상태는 native runtime의 World가 소유한다.
2. 내부 EventBus를 만들지 않는다. 동일 프로세스에서는 typed call을 사용한다.
3. 외부 통신은 compatibility adapter 한 곳에만 존재한다.
4. UAM 기체 설정은 model package 한 곳에만 둔다.
5. 런타임 로그는 Data Layer 구현을 통과해 workspace에 기록한다.
6. actuator 명령은 model package의 문자열 ID를 조립 시 한 번 검증한 뒤 runtime 내부 index로 연결한다. 선언 순서에 의미를 중복 부여하지 않는다.
7. SimpleFlight estimator는 `VehicleState`를 읽기만 하는 좌표 변환 view이다. 별도 상태 저장소나 sensor fusion 결과를 만들지 않는다.
8. contact 구성은 질량과 관성을 복제하지 않는다. FastPhysics의 vehicle dynamics
   값과 model package의 restitution/friction만 조합한다.
9. 실행 ID, event stream 및 manifest는 Data Layer `RunRecorder`가 소유한다.
   응용프로그램은 별도 실행 로그 형식을 만들지 않는다.
10. 좌표와 단위 변환은 계약 경계에서 한 번만 수행하고 시각화가 상태를 재계산하지 않는다.
11. 삭제한 legacy 비행 명령 wrapper와 mission runner를 Communication에 다시 추가하지 않는다.
12. Sensor sample은 `SensorFrame`에서 한 번 생성하고 Data Layer가 그대로 기록한다.
    별도 current sensor store를 만들지 않는다.
13. 운용 설정은 versioned deployment config가 소유하며 환경 변수별 사본을 만들지
    않는다.

운항정보 분석은 [ADR 0059](../adr/0059_daily_operations_analysis.md)를 따른다. Data가 과거 운항 사건과 저장 입력을 소유하며 Application은 잠금으로 복사한 계획/실적을 평가한다. Communication과 Web은 읽기 전용 집계를 노출하고 시계·임무·물리 상태를 변경하지 않는다.

PRISM 주변 교통 레이더는 [ADR 0078](../adr/0078_prism_nearby_risk.md)을 따른다.
모델 라이브러리가 2D 모델 정의와 가중치, Data가 제한된 관측 이력, AI PnP가
미래 궤적 분포를 소유한다. Application이 별도 CPU 추론 프로세스를 조립하고
Communication은 고정 JSONL/HTTP 계약만 전달한다. Web은 현재 교통과 예측을
읽기만 한다. 위험 예측이라는 UI 분류는 충돌확률이나 자동 회피 기능을 뜻하지 않는다.

## 웹 도메인 확장

Satellite/UAM 선택과 프런트엔드 책임 분리 1차 범위는 `DOMAIN_EXPANSION.md`를 따른다. 기존 물리 실행 기준선과 상태 소유권은 변경하지 않는다.
