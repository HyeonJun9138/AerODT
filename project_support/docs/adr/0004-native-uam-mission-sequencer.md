# ADR 0004: Native UAM 임무 sequencer와 실행 진입점

- 상태: 승인
- 날짜: 2026-09-03

## 배경

Native `UamVehicleRuntime`은 typed position/velocity goal을 처리할 수 있지만,
이륙부터 착륙까지 goal을 생성하는 운용 흐름과 독립 실행 진입점이 없었다.
임무 상태를 runtime 내부에 넣으면 물리 상태 소유권과 사용자 운용 정책이
섞이고, 반대로 Python 호환 임무만 유지하면 native 경로를 끝까지 회귀시험할
수 없다.

AirTaxi 구성은 멀티로터 pitch 제한과 body drag 때문에 수평 정속 비행만으로는
고정익 전환의 엄격한 속도 조건 바로 아래에서 수렴할 수 있다. 전환 임계값이나
SimpleFlight 코드를 완화하면 legacy 동작을 바꾸므로 허용하지 않는다.

## 결정

1. `user_application/uam_mission`에 상태를 읽어 typed goal만 생성하는
   `UamMissionSequencer`를 둔다.
2. sequencer는 runtime 상태를 저장하거나 수정하지 않는다. 현재 상태의 유일한
   소유자는 계속 `UamVehicleRuntime`이다.
3. 임무 단계는 수직 이륙, 상승, 고정익 천이, 순항, 멀티로터 복귀, 귀환,
   접근, 수직 착륙, 완료 순서로 명시한다.
4. waypoint는 위치뿐 아니라 속도 허용오차도 만족해야 도착한 것으로 판정한다.
5. 고정익 천이 중에는 profile에 명시된 작은 상승 속도를 함께 요청하여 thrust
   margin을 확보한다. controller 속도 임계값과 model parameter는 변경하지 않는다.
6. `uam_native_demo`는 native runtime, sequencer, Data Layer JSONL logger만 조립하며
   가능한 한 빠르게 steppable clock을 실행한다.
7. 짧은 전체 임무를 CTest에 넣어 native FastPhysics + SimpleFlight 경로의
   이륙-천이-순항-복귀-착륙 단계가 모두 완료되는지 검증한다.

## 결과

- legacy NNG/Unreal 없이 native 전체 임무를 반복 실행할 수 있다.
- 임무 정책은 Digital Twin 계산 코드와 분리된다.
- 전환을 위해 controller나 물리 임계값을 변조하지 않는다.
- Python 호환 임무는 실제 Unreal 경로가 native adapter로 교체될 때까지 한시적으로
  유지한다.

## 후속 상태

ADR 0008의 native Unreal 전체 임무 검증 후 Python 호환 임무를 삭제했다.
Headless와 Unreal 실행은 동일한 C++ sequencer를 사용한다.
