# ADR 0019: Simulation Engine의 골격 — 기체 airframe 선택, 궤적 배우, 공통 시계 World

- 날짜: 2026-09-09
- 상태: 적용 (1차: airframe 등록과 멀티로터 믹서, 궤적 재생 배우, SimulationWorld·SimulationClock, 쿼드로터 패키지)
- 범위: `digital_twin/simulation`, `digital_twin/runtime`, `digital_twin/model_library`(compiler, packages), `foundation/math`. 검증된 틸트로터 UAM 경로의 동작은 바꾸지 않는다. Unreal 플러그인, 웹 Live Twin, 비행계획 스케줄러는 이 문서 범위 밖이다.

## 문제

아키텍처 그림의 Digital Layer는 Shared Digital Model Library, Simulation Engine(Temporal State Manager + Parallel/Fast Simulation Model + Scenario/Parameters), Live Twinning, Real-time Twin Models, Visualization Service, Predictive World Model로 나뉜다. 코드는 기체 **한 대**(`UamVehicleRuntime`)와 **한 골격**(vtol-quad-tiltrotor)만 굴릴 수 있었고, 여러 개체를 한 시계로 진행시키는 자리(Temporal State Manager)와 물리 없이 표를 따라 움직이는 개체(비행계획 재생)가 없었다. ProjectAirSim 보존본에는 SimpleFlight의 quadrotor-x/hexarotor-x 믹서와 EnvActor+Trajectory가 남아 있어, 이를 우리 계층 규칙대로 들여온다.

## 결정

1. **airframe은 SimpleFlight의 열거형이며 패키지가 하나를 고른다.** `simulation/control/simple_flight/airframe.hpp`의 `Airframe {vtol_quad_tiltrotor, quadrotor_x, hexarotor_x}`와 `TopologyOf()`(로터 수, 틸트 수, 양력면 허용, 고정익 가능)가 규칙의 단일 출처다. manifest의 `airframe`과 model의 `airframe-setup`은 같아야 하고, 컴파일러가 패키지 actuator 수를 그 topology와 대조해 거부한다. 테일시터는 보존본에서도 예제·시험이 없어 들여오지 않았다.
2. **믹서는 골격별 행렬이고 선택은 한 곳에서 한다.** `MultirotorMixer`가 보존본 `Mixer.hpp`의 QuadX(4×4)·HexX(6×4) 행렬을 그대로 옮긴 것이고, `SimpleFlightMixer`가 airframe으로 `TiltrotorMixer`/`MultirotorMixer`를 고른다(legacy 펌웨어의 switch). 로터 포화 처리는 우리 틸트로터 믹서와 같은 규칙(최솟값 미달 시 일괄 상승, 최댓값 초과 시 일괄 축소)이다. AGENTS.md 8절의 "SimpleFlight mixer가 control allocation의 단일 구현"은 유지된다: 별도 ControlAllocation 계층 없이 SimpleFlight 안의 행렬이 늘었을 뿐이다.
3. **runtime은 골격을 검증하고 믹서를 고른다.** `UamRuntimeConfig.airframe`(컴파일 시 결정)로 `UamVehicleRuntime`이 믹서를 만들고, 로터·틸트·양력면 수와 `fixed_wing_capable`이 topology와 맞지 않으면 생성 시 거부한다. 고정익 불가 골격에 들어온 `fixed_wing_requested`는 운용 입력이 골격을 넘어선 것이므로 무시한다(멀티로터 blend 유지). 틸트로터 경로의 tick 순서·수치는 그대로다(기존 시험과 8초 전체 임무 시험이 통과).
4. **패키지마다 loader 하나.** 컴파일러가 `--symbol`로 생성 함수 이름을 받는다. 두 번째 패키지 `packages/vehicles/air/multirotor/aerodt_quadrotor`는 보존본 `robot_quadrotor_fastphysics.jsonc`의 1 kg 시연 쿼드로터를 옮긴 것이며(`LoadAeroDTQuadrotorRuntimeConfig`), 실측 기체가 아니다. `controller.parameters`는 선택 항목이 되어 SimpleFlight 기본값으로 난다.
5. **궤적 배우는 물리가 아닌 운동 모델이다.** `simulation/trajectory/KinematicTrajectory`가 보존본 Trajectory(time·pose·angular pose·linear velocity 표)를 옮긴 것으로, 행 사이는 선형 보간(각도는 짧은 호), 표 이전은 첫 행에서 정지, 표 이후는 마지막 행에서 정지(loop 선택), 시간·위치·yaw 오프셋을 갖는다. 보존본과 다른 점: 표 이전에 원점이 아니라 첫 행에 놓이고(주기된 항공기는 스탠드에 서 있다), 표 밖에서는 속도가 0이다. 위치만 있는 표를 위해 `DeriveVelocities`를 둔다. `runtime/TrajectoryActorRuntime`이 그 표를 가진 개체의 현재 `StateSnapshot`을 소유한다.
6. **SimulationWorld가 Temporal State Manager의 자리다.** `runtime/SimulationClock`(고정 스텝, 경과·스텝 수)과 `SimulationWorld`가 물리 기체(`UamVehicleRuntime`)와 궤적 배우를 같은 스텝으로 진행시키고 개체별 스냅샷을 든다. 기체를 어떻게 모는지는 World가 모른다: 기체를 넣을 때 application이 `VehicleStep`(임무 goal + contact를 넣어 tick)을 함께 준다. 임무 상태기계는 `user_application/uam_mission`에 그대로 있다. 기체의 스텝이 World 스텝과 다르면 거부하고, 스냅샷 시각이 시계와 어긋나면 논리 오류다. 시간 배율과 실시간 페이싱은 호스트(headless 루프, Unreal tick) 책임이다.
7. **foundation에 RPY→quaternion을 둔다.** `Quaternion::FromRollPitchYaw`는 컴파일러의 식과 SimpleFlight 추정기의 역변환과 같은 ZYX 규약이다.

## 그림과 코드의 대응

| 그림 | 코드 | 상태 |
|---|---|---|
| Shared Digital Model Library · Vehicle Parameter DB / Model Setup | `model_library/packages/*` + `compiler/compile_uam_package.py` → typed `UamRuntimeConfig` | 패키지 2개 (틸트로터 UAM, 시연 쿼드로터) |
| Flight Dynamics / Aerodynamic / Actuator / Flight Control / Sensor Model | `simulation/{fast_physics, aerodynamics, actuation, control/simple_flight, sensors}` | 있음 |
| Supporting Asset Model (버티포트·항로) | `model_library/vertiport_layout.py`, `route_network.py` | 있음(Python, 웹) |
| Simulation Engine · Temporal State Manager | `runtime/SimulationClock` + `SimulationWorld` | **이번에 추가** |
| Simulation Engine · Parallel/Fast Simulation Model | `runtime/UamVehicleRuntime`(물리) + `TrajectoryActorRuntime`(궤적) | 궤적 배우 **추가** |
| Simulation Engine · Scenario/Parameters | `user_application/configs/runtime/*.json`, `uam_mission` 프로파일 | 비행계획→World 채우기는 다음 단계 |
| Live Twinning / Real-time Twin Models | `digital_twin/live_twin`, `runtime/real_time_twin/world.py` | 있음(Python), native와 미연결 |
| Visualization Service | Unreal 어댑터·플러그인, 웹 Cesium | 있음 |
| Predictive World Model | `ai_pnp/SCOPE.md` | 없음 |

## 다음 연결 지점

- 비행계획(FPL) → `TrajectorySample` 표: 지점·구간·시각에서 표를 만드는 변환은 `user_application`(스케줄러) 몫이고, `DeriveVelocities`가 속도를 채운다. 위경도↔NED 변환은 foundation에 C++로 아직 없다(`foundation/geodesy.py`만).
- World 스냅샷 → 웹 Live Twin: `communication`의 프로세스 경계(파일 또는 소켓)로 `StateSnapshot` 열을 넘긴다. World 안에서 직접 웹을 호출하지 않는다.
- headless `uam_native_demo`와 Unreal `AeroDTNative`는 아직 `UamVehicleRuntime` 하나를 직접 tick한다. World로 옮기는 것은 동작 보존 이식이라 별도 단계에서 회귀시험과 함께 한다.

## 검증

- 새 시험 3개: `airframe_mixer_test`(이름 왕복, QuadX·HexX 행렬이 legacy와 같음, 포화 규칙, 골격별 선택, 잘못된 topology 거부), `kinematic_trajectory_test`(보간·정지·오프셋·짧은 호·loop·속도 유도·거부), `simulation_world_test`(쿼드로터 패키지 컴파일, 쿼드로터가 8초 안에 위치 goal로 상승, 멀티로터의 고정익 요청 무시, 두 개체 lockstep, Reset, 거부 규칙).
- `project_support/tools/test_structure.ps1`: clean 빌드 후 ctest 16/16(이전 13), 틸트로터 전체 임무 시험 통과, regression 25, architecture PASS.

## 한계

- 쿼드로터 패키지는 시연 값이다. FPL의 a2~a8 기체는 실측 질량·로터·공력을 가진 패키지로 새로 만들어야 한다.
- 옥토·리프트+크루즈 골격은 없다. 행렬 한 벌과 `Airframe` 항목을 더하면 같은 틀에 들어간다.
- World는 개체 간 상호작용(충돌·간격)을 모른다. 그림의 Interaction Model 자리다.
- 궤적 배우는 표 사이를 직선으로 잇는다. 항로 구간의 곡선·고도 프로파일은 표를 만드는 쪽이 촘촘히 주어야 한다.
