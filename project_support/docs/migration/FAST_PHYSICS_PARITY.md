# FastPhysics native 이식 기준

## 완료된 범위

ProjectAirSim `FastPhysicsModel::CalcNextKinematicsNoCollision`의 강체 적분을 외부 라이브러리 없이 `aerodt::digital_twin::simulation::fast_physics::FastPhysicsEngine`으로 이식했다. 다음 동작을 원본 단위시험 수치와 비교한다.

- 이전 acceleration을 사용한 평균 속도 계산
- linear 및 angular acceleration 계산
- velocity Verlet 적분
- body frame Euler rotation equation
- 이전 스텝 wrench 입력
- 속도 상한과 비정상 수치 차단
- quaternion 적분 및 정규화

또한 UAM에 필요한 rotor와 tilt actuator를 이식했다.

- rotor control의 0에서 1 범위 제한
- 1차 지연 필터
- RPM, 추력, 반작용 토크, 전력 계산
- 공기 밀도 비율
- tilt quaternion을 통한 추력 방향 변경
- rotor 위치에 따른 모멘트 합산
- 회전 방향 및 fault 처리

기체 공력과 접촉 응답도 독립적인 native 계산 단위로 이식했다.

- ProjectAirSim의 단면별 quadratic body drag와 NED/body 좌표 변환
- 상대 풍속과 공기 밀도 반영
- wing의 받음각, 실속 전후 계수, lift, drag, moment 계산
- 조종면 각도에 따른 계수 변화와 압력 중심 모멘트
- 지상 고정 시 roll/pitch 제거와 yaw 유지
- 충돌의 restitution 및 Coulomb friction impulse

body drag와 wing lift-drag는 `FastPhysicsEngine::Advance`의 총 wrench 계산에 연결했다.
접촉 응답은 public `ContactObservation`으로 runtime tick에 연결했고,
`UnrealVisualizationAdapter`가 Unreal sweep hit의 NED 단위 변환을 담당한다.

SimpleFlight는 먼저 다른 controller에서도 재사용 가능한 핵심 계산부터 이식했다.

- proportional, integral, derivative 항과 integral discount
- integral windup 및 최종 출력 제한
- 멀티로터와 고정익 tiltrotor mixer matrix
- tilt 비율에 따른 두 matrix의 연속 혼합
- rotor desaturation과 조종면 출력 제한

수치 기준은 `project_support/tests/regression/data/fast_physics_projectairsim_baseline.json`에 고정했다.

Canonical UAM package도 native 실행 구성에 연결했다.

- JSONC의 질량, 합성 관성, drag face, wing, rotor, tilt, control-surface 및 controller 파라미터를 빌드 시점에 typed C++로 컴파일
- package의 actor ID, 초기 위치·자세 및 3 ms 고정 step 보존
- mixer의 actuator order와 model 선언 순서를 문자열 ID로 명시적으로 결합
- control-surface 1차 지연과 회전각 변환 이식
- `UamVehicleRuntime`에서 이전 wrench 적분 후 actuator를 갱신하여 다음 wrench를 만드는 이산 순서 고정
- 각 tick에서 외부 공개용 `StateSnapshot` 생성
- tiltrotor의 stall-speed hysteresis, 고정익 진입/복귀 확인 counter 및 5초 선형 blend 상태기계
- SimpleFlight parameter map을 legacy 기본값과 override 규칙에 따라 typed multirotor/fixed-wing 구성으로 변환
- ground-truth `VehicleState`의 RPY 및 NED-to-body 변환
- multirotor position -> velocity -> angle-level -> angle-rate cascade와 NED Z throttle 변환
- `UamVehicleRuntime::AdvancePositionGoal`에서 physics 적분 뒤 controller와 actuator를 순서대로 실행
- multirotor world-velocity goal의 NED-to-body 변환, yaw-angle/yaw-rate 분리
- tiltrotor fixed-wing의 zero-roll hold, vertical-velocity-to-pitch cascade,
  heading/yaw-rate 및 speed-to-throttle 계산
- 양 controller branch를 먼저 계산한 뒤 speed confirmation과 5초 blend 적용
- runtime velocity goal에서 blend를 tilt와 control-surface mixer까지 전달
- public `ContactObservation`을 FastPhysics tick에 전달하여 landing,
  grounded latch 및 collision impulse 분기 선택
- `UamMissionSequencer`가 위치와 속도 도착 조건을 사용하여 수직 이륙,
  상승, 고정익 천이, 순항, 멀티로터 복귀, 귀환 및 수직 착륙 goal 생성
- `uam_native_demo`가 native runtime을 steppable clock으로 끝까지 실행하고
  Data Layer `RunRecorder`에 JSONL event와 최종 manifest 기록
- 짧은 전체 native 임무를 CTest에 포함하여 simulation time 111.252초에 완료 검증
- model package root collision box에서 body ground clearance를 생성하고 headless
  flat-ground contact를 다음 FastPhysics tick에 공급
- 착륙 하강 goal, contact branch, grounded latch 및 정지 상태가 모두 확인된 뒤에만
  UAM 임무 완료
- `StateSnapshot`의 NED m pose를 Unreal NEU cm와 quaternion 부호 규칙으로 변환
- Unreal sweep hit의 normal, impact point, collision position 및 penetration을
  typed `ContactObservation`으로 역변환
- `AeroDTNative` Unreal plugin에서 ProjectAirSim `UAM1` actor의 legacy tick을 끄고
  native runtime pose를 실제 scene에 적용
- 3 ms native substep, 8배속 실행, 실제 Unreal 지면 sweep contact 및 grounded
  착륙을 포함한 전체 UAM 임무 검증
- ProjectAirSim adapter를 process/service/scene 생명주기만 남도록 축소하고
  중복 Python 제어 및 mission 경로 제거
- simulation time 주기의 native IMU, GPS와 camera pose/intrinsics state 생성
- 모든 native sensor sample을 실행별 `sensor_telemetry.jsonl`로 publication
- ProjectAirSim host model에서 sensor 선언을 제거하고 legacy sensor topic 미생성 검증
- package ID/version, scene, mission, 배속과 sensor set을 versioned deployment
  config로 고정하고 Unreal 시작 시 compiled package와 대조

## V1 이후 확장 범위

- IMU/GPS noise, bias와 fault injection model
- camera state를 소비하는 RGB/depth pixel renderer 및 선택적 외부 stream
- NNG 이외 외부 wire protocol adapter

현재 검증된 Unreal UAM 실행에서 native runtime이 actor pose, SimpleFlight controller,
FastPhysics, contact response와 sensor publication의 권위 있는 경로다. ProjectAirSim은
보존된 Unreal scene과 NNG scene-load 생명주기만 제공한다.
