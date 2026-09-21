# AeroDT 작업 규칙

이 파일은 사람용 소개 문서가 아니라, 이 저장소를 수정하는 AI와 자동화 도구가 **작업을 시작하기 전에 반드시 읽어야 하는 규칙**이다. 하위 폴더에 더 구체적인 `AGENTS.md`가 있으면 그 규칙을 함께 적용한다.

## 1. 현재 목표

- 첫 번째 동작 기준선은 **FastPhysics + SimpleFlight 기반 쿼드 틸트로터 UAM**이다.
- 시각화 기준선은 CesiumJS 기반 웹 대시보드이며 Unreal 호스트는 배포 범위에 넣지 않는다.
- PX4, ROS, MAVLink, JSBSim, KFDS, 해양 및 우주 동역학은 현재 빌드 범위에 넣지 않는다.
- 새 기능보다 재현 가능한 이륙, 천이, 고정익 순항, 멀티로터 복귀, 수직 착륙을 우선한다.

## 2. 작업 시작 전 읽기 순서

1. 이 파일
2. `data/development_log/CURRENT.md`
3. `project_support/docs/architecture/BOUNDARIES.md`
4. 변경 대상과 가장 가까운 테스트

ProjectAirSim 원본 비교가 필요하면 ADR에 기록된 기준 커밋을 별도로 받아 읽는다.
외부 연구 코드와 대용량 원본 자료는 저장소에 vendoring하지 않는다.

## 3. 최상위 계층과 책임

- `foundation`: 수학, 단위, 시간, 좌표계, 구성, 진단 계약
- `communication`: 프로세스 및 기술 경계를 넘는 통신 어댑터와 외부 프로토콜
- `data`: 실행 기록, 재생, manifest, 로그 파일 저장
- `digital_twin`: 계약, 모델 라이브러리, 런타임, 시뮬레이션, 시각화
- `ai_eng`: 학습 및 모델 엔지니어링의 향후 경계
- `ai_pnp`: 예측 및 계획의 향후 경계
- `user_application`: 실행 프로그램, CLI, 사용자 SDK
- `user_application/configs`: 모델 자체가 아닌 배포 및 운용 구성
- `project_support`: 문서, 저장소 전체 시험, 도구 및 읽기 전용 참조 구현
- `data/workspace`: 실행 로그와 데이터 생성물. 소스 코드가 아님

최상위에는 위 일곱 계층과 `project_support`만 디렉터리로 둔다. 빌드 산출물과
개발 환경도 `project_support` 아래에 두며 루트에 별도 폴더를 만들지 않는다.

## 4. 의존성 규칙

허용되는 기본 방향은 다음과 같다.

```text
foundation
  <- digital_twin/contracts
  <- digital_twin/model_library
  <- digital_twin/simulation
  <- digital_twin/runtime

user_application -> communication, data, digital_twin
communication    -> foundation 또는 버전이 명시된 wire schema
data             -> foundation 및 digital_twin/contracts
visualization    -> digital_twin/contracts
```

다음 의존성은 만들지 않는다.

- FastPhysics에서 renderer, NNG 또는 파일 로거 직접 호출
- SimpleFlight에서 recorder 직접 호출
- runtime에서 구체적인 NNG 또는 renderer 형식 사용
- data에서 runtime 내부 객체 소유 또는 수정
- model_library에서 simulation 실행 객체 생성
- 시각화 코드에서 FastPhysics 내부 구현 헤더 사용

내부 흐름은 타입이 지정된 C++ 호출 또는 작은 계약을 사용한다. 현재 버전에 내부 EventBus, CommandBus, QueryBus, Gateway를 추가하지 않는다. 외부 통신만 RPC와 topic 의미를 가진다.

## 5. 상태 소유권

- 현재 상태의 유일한 소유자는 `digital_twin/runtime`의 World 및 entity이다.
- UAM 임무 단계와 goal 생성은 `user_application/uam_mission`이 맡고 runtime
  상태를 복제하거나 직접 수정하지 않는다.
- 외부 공개와 기록에는 불변 `StateSnapshot`을 사용한다.
- 과거 상태는 `data`가 소유한다.
- 미래 상태는 나중에 `ai_pnp`가 소유한다.
- 같은 현재 상태를 별도의 StateStore, RuntimeBuffer, TopicCache에 중복 저장하지 않는다.

## 6. FastPhysics 이산 실행 순서

구조 변경 중 아래 순서를 임의로 바꾸면 기존 궤적이 달라지므로 반드시 회귀시험을 먼저 추가한다.

```text
SimulationClock advance
-> 이전 스텝 wrench로 FastPhysics 적분
-> 환경 갱신
-> 센서 갱신
-> SimpleFlight 제어 계산
-> actuator 갱신
-> 다음 스텝에 사용할 wrench 생성
-> StateSnapshot 방출
```

## 7. 명명 규칙

- 폴더와 파일: `lower_snake_case`
- C++ 타입: `PascalCase`
- C++ namespace: `aerodt::<layer>::<module>`
- 실제 CMake target: `aerodt_<module>`
- CMake alias: `AeroDT::<Module>`
- Layer는 최상위에만 사용하며 폴더 이름에 `_layer`를 붙이지 않는다.
- 독립 기능은 Module이지만 폴더 이름에 `_module`을 붙이지 않는다.
- Model은 정적 물리 정의와 파라미터, Engine은 능동 계산 객체, Runtime은 생명주기와 현재 상태, Adapter는 기술 경계, Protocol은 외부 wire schema, Contract는 내부 typed API에만 사용한다.
- `core`, `common`, `utils`, `manager`, `backend`, `gateway`, `interface` 같은 모호한 이름을 새로 만들지 않는다.
- 독립 프로세스가 아닌 코드에 `service`라는 이름을 쓰지 않는다.

## 8. 모델과 구성

- 기체의 질량, 관성, 공력, actuator, sensor, 제어기 파라미터는 `digital_twin/model_library/packages` 아래 하나의 버전 가능한 model package로 둔다.
- 배포 주소, 로그 수준, 실행 모드 등은 `user_application/configs`에 둔다.
- 같은 기체 파라미터를 `user_application/configs/vehicles`에 복제하지 않는다.
- 현재 SimpleFlight mixer가 control allocation의 단일 구현이다. 골격(airframe)별 행렬은 `simulation/control/simple_flight` 안에 두고 `SimpleFlightMixer`가 고른다. 별도 ControlAllocation 폴더를 만들지 않는다.
- 기체 골격은 `simple_flight/airframe.hpp`의 `Airframe` 목록이 유일한 출처이며, 패키지 manifest의 `airframe`과 model의 `airframe-setup`은 같아야 한다. 새 골격은 열거형·topology·믹서 행렬·패키지 예제·시험을 함께 더한다.
- rotor/tilt/control-surface 힘 계산은 actuator 영역의 책임이고 FastPhysics는 합성 wrench와 강체 운동을 계산한다.

## 9. Legacy 정책

- ProjectAirSim 기준 커밋은 `097429f56fee32b0edfe508820bf2323ee7f2cb2`이며
  로컬 복제본은 저장소에 포함하지 않는다.
- 버그 비교가 필요할 때만 별도 checkout을 사용하며 직접 기능 개발을 계속하지 않는다.
- 불가피한 호환 패치는 먼저 ADR에 이유를 기록하고 최소 범위로 적용한다.
- 새 AeroDT 코드가 legacy 내부 경로에 퍼지지 않게 모든 접근을 `communication`의 호환 adapter에 가둔다.

## 10. 로깅과 완료 기록

- 사용자 실행 로그는 `data`의 logger를 통해
  `data/workspace/logs/runs/<run-id>`에 기록한다.
- 소스에는 암호, 토큰, 개인 경로, 대용량 런타임 로그를 커밋하지 않는다.
- 의미 있는 작업을 마칠 때마다 `data/development_log/CURRENT.md`를 갱신하고 `HISTORY.jsonl`에 한 줄을 추가한다.
- 개발 로그에는 변경 내용, 검증 명령, 결과, 남은 위험을 적는다. 검증하지 않은 내용을 성공으로 기록하지 않는다.
- 완료 판단은 `project_support/tests/validation`의 UAM 임무 검증과 실제 Cesium/Web
  실행 증거를 모두 요구한다.

## 11. 변경 원칙

- 구조만 바꾸는 변경과 동작을 바꾸는 변경을 한 단계에서 섞지 않는다.
- 동작을 보존하는 가장 작은 단위로 옮기고 매 단계 테스트한다.
- 사용되지 않는 코드는 새 구조로 복사하지 않는다. 필요할 때 legacy에서 근거와 테스트를 확인한 뒤 이식한다.
- 빈 미래 폴더를 대량 생성하지 않는다. 향후 영역은 책임과 진입 조건을 적은 문서 하나로만 유지한다.
- public API, wire schema, model package format 변경은 `project_support/docs/adr`에
  기록한다.
