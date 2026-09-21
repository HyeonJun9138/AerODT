# ADR 0009: Native sensor publication과 versioned deployment

- 상태: 승인
- 날짜: 2026-09-03

## 배경

Native FastPhysics와 SimpleFlight가 기체 상태를 소유한 뒤에도 IMU, GPS와 camera
state는 ProjectAirSim robot sensor backend가 만들고 있었다. 또한 Unreal host의
workspace, mission profile과 배속을 여러 환경 변수로 전달해 실행 구성을 재현하기
어려웠다.

## 결정

1. `SensorFrame`을 Digital Twin의 불변 출력 계약으로 사용한다.
2. `NativeSensorSuite`가 physics 적분 직후, controller 계산 전에 simulation time으로
   IMU, GPS 및 camera state의 독립 주기를 갱신한다.
3. UAM V1 센서는 deterministic ideal mode로 고정한다. IMU는 body/sensor frame의
   specific force와 각속도, GPS는 scene home point 기준 WGS84 위치와 NED 속도,
   camera state는 world pose·intrinsics·활성 image type을 출력한다.
4. 센서 정의는 model package의 `sensors.jsonc`에 둔다. ProjectAirSim이 읽는
   `model.jsonc`에서는 sensors를 제거하여 legacy sensor topic을 생성하지 않는다.
5. Data Layer의 `SensorTelemetryWriter`가 실행 폴더의
   `sensor_telemetry.jsonl`에 모든 native sample을 기록한다.
6. `user_application/configs/runtime/native_unreal_uam.v1.json`이 scene, package version, mission,
   배속, timeout, workspace와 요구 sensor ID의 단일 deployment source다.
   Unreal process에는 구성값 여러 개 대신 이 파일의 위치 하나만 전달한다.
7. Unreal host는 compiled package ID/version과 sensor ID가 deployment config와
   정확히 같지 않으면 시작을 거부한다.

## 결과

- wall-clock 속도와 Unreal frame rate가 sensor 표본 수를 바꾸지 않는다.
- native sensor sample과 manifest가 같은 run ID 아래 보존된다.
- 보존된 ProjectAirSim은 Unreal actor/scene와 NNG scene-load 생명주기만 제공하며
  UAM sensor backend가 아니다.
- camera state 계약은 pose와 intrinsics를 다룬다. 실제 RGB/depth pixel 생성은
  Visualization renderer의 별도 출력이며 이 계약에 대용량 byte buffer를 넣지 않는다.
