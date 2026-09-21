# ADR 0008: Native Unreal host plugin과 legacy 장면 경계

- 상태: 승인
- 날짜: 2026-09-03

## 배경

Native `UamVehicleRuntime`과 engine-independent Unreal adapter가 각각 검증됐지만,
실제 ProjectAirSim Unreal 장면에서 actor pose와 collision sweep을 연결하는 host가
필요했다. 새 plugin을 보존 영역에 직접 넣으면 `project_support/reference/projectairsim`이 더 이상
읽기 전용 기준선이 아니게 된다.

## 결정

- 실제 plugin 소스는 `digital_twin/visualization/unreal/AeroDTNative`에 둔다.
- 빌드와 실행 스크립트는 검증된 `project_support/reference/projectairsim/unreal/Blocks/Plugins`
  부모 아래에 임시 directory junction만 만들고 항상 제거한다.
- plugin은 환경 변수로 명시적으로 활성화된 실행에서만 native runner를 만든다.
- ProjectAirSim이 장면에서 만든 `UAM1` actor를 찾은 뒤 legacy actor tick을 끄고,
  native `UamVehicleRuntime`을 현재 상태의 유일한 소유자로 사용한다.
- `OnWorldPostActorTick`에서 고정 3 ms native substep을 수행하고
  `UnrealVisualizationAdapter`를 통해 actor를 sweep 이동한다.
- 같은 sweep의 `FHitResult`를 `ContactObservation`으로 바꾸어 다음 FastPhysics
  tick에 공급한다. Unreal 형식은 host source 밖으로 노출하지 않는다.
- Communication adapter는 ProjectAirSim service 시작, NNG 연결 및 scene load만
  담당한다. 비행 goal, 제어 및 동역학은 plugin의 native 경로가 담당한다.
- native 실행과 orchestration 실행은 각각 Data Layer run manifest와 event를 남기며,
  종료 시 Unreal log도 orchestration run 폴더로 복사한다.

## 결과

ProjectAirSim 원본을 수정하지 않고 native FastPhysics + SimpleFlight UAM을 실제
Unreal 장면에서 실행할 수 있다. Headless와 Unreal 경로가 동일한 runtime과 mission
sequencer를 사용하며, 차이는 contact 제공자가 flat-ground model인지 실제 Unreal
sweep인지뿐이다.
