# Native FastPhysics 이식 순서

1. [완료] 현재 FastPhysics와 UAM actuator 수치 회귀 기준 정의
2. [완료] 강체 상태와 wrench 계약 고정
3. [완료] canonical UAM model package를 typed runtime config로 컴파일
4. [완료] rotor, tilt 및 control-surface actuator 계산 이식
5. [완료] 이전 스텝 wrench를 사용하는 무충돌 강체 적분 이식
6. [완료] drag, wing lift-drag, contact observation과 grounded/collision 분기를 엔진에 연결
7. [완료] SimpleFlight PID, multirotor 및 tiltrotor fixed-wing velocity cascade와 전환 blend 이식
8. [완료] 직접 `ControlAxes`, position/yaw-rate 또는 velocity/yaw goal부터 actuator와 FastPhysics까지 native runtime tick 연결
9. [완료] native UAM mission sequencer, headless 실행 진입점 및 전체 임무 CTest 연결
10. [완료] IMU, GPS, camera state sensor와 환경 모델 이식
11. [완료] Unreal adapter와 host plugin이 `StateSnapshot`만 소비하도록 연결
12. [완료] compatibility adapter를 service/scene 생명주기로 축소하고 중복 mission 제거

각 단계는 이전 단계의 UAM 회귀시험이 통과한 뒤에만 진행한다.

6단계는 public `ContactObservation`을 받아 free-flight candidate 뒤 landing,
ground latch 또는 impulse response를 선택한다. Unreal adapter가 이 계약을 실제
collision callback에 연결하는 작업은 10단계에 포함한다.
7단계는 multirotor position/velocity cascade, tiltrotor fixed-wing velocity,
speed hysteresis, 10단계 확인 counter와 5초 출력 blend까지 포함한다.
8단계는 package actuator ID를 조립 시 검증하고 `physics -> estimate -> control -> actuator -> next wrench` 순서를 회귀시험으로 고정한다. 직접 축 명령 경로는 진단과 수동 제어를 위해 유지한다.
9단계는 mission state를 User/Application에 두고 snapshot에서 typed goal만 생성한다.
짧은 native 임무는 123.294초의 simulation time에 이륙, 고정익 천이, 순항,
멀티로터 복귀, 귀환 및 접촉 착륙 단계를 완료했다. Headless flat-ground geometry가
`ContactObservation`을 만들고 FastPhysics grounded latch가 참이 된 뒤에만
성공한다.

10단계에서는 `FlatGroundContactModel`과 simulation-time 기반 `NativeSensorSuite`를
완료했다. IMU specific force/각속도, GPS WGS84 위치/NED 속도, camera world
pose/intrinsics가 physics 직후에 갱신되며 Data Layer telemetry로 기록된다. 대기·바람
입력은 기존 aerodynamic environment 계약으로 FastPhysics에 들어간다.

11단계의 engine-independent 경계와 실제 host binding을 완료했다.
`UnrealVisualizationAdapter`가
`StateSnapshot`을 ProjectAirSim과 동일한 NED m -> NEU cm pose로 변환하고,
scene sweep hit를 `ContactObservation`으로 되돌린다. `AeroDTNative` plugin은
ProjectAirSim이 만든 `UAM1` actor의 legacy tick을 끄고 native runtime을 3 ms
substep으로 실행한다. 실제 Blocks 장면에서 9개 임무 단계, 지면 collision,
`grounded=true` 및 종료 정리를 검증했다.

12단계에서는 중복 Python mission/flight-command wrapper를 삭제했다. 남은
ProjectAirSim adapter는 Unreal process, NNG service와 scene load/종료만 담당하므로
Communication과 Digital Twin의 책임이 겹치지 않는다. 원본 전체 기능은
`project_support/reference/projectairsim`에 보존한다.

UAM V1 이식 단계는 모두 완료했다. sensor noise/fault, camera pixel renderer와 외부
wire protocol은 이 기준선을 변경하지 않고 추가하는 후속 기능이다.
