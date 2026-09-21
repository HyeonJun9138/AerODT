# ADR 0006: Unreal 시각화 경계

- 상태: 승인
- 날짜: 2026-09-03

## 배경

Native `UamVehicleRuntime`은 headless 전체 임무를 완료하지만 아직 Unreal actor의
pose와 collision callback에 연결되지 않았다. Unreal 형식을 runtime이나
FastPhysics에 직접 넣으면 시뮬레이션이 렌더링 엔진에 다시 종속된다.

## 결정

`digital_twin/visualization`에 `UnrealVisualizationAdapter`와 작은
`UnrealScenePort`를 둔다.

- adapter는 불변 `StateSnapshot`을 읽어 NED m에서 Unreal NEU cm pose로 변환한다.
- Unreal host가 전달한 hit는 같은 adapter에서 `ContactObservation`으로 변환한다.
- `UnrealScenePort`는 한 snapshot의 transient pose 적용과 그 sweep에서 생긴 hit 반환만
  표현하며 상태를 저장하거나 simulation tick을 실행하지 않는다. adapter는 반환된
  hit를 다음 runtime tick이 받을 `ContactObservation`으로 즉시 변환한다.
- public 경계에는 Unreal 헤더를 포함하지 않는다. 실제 플러그인은 POD 값을
  `FVector`, `FQuat` 및 `FHitResult`와 복사하는 얇은 host binding만 구현한다.
- 위치는 `(x, y, z) NED m -> (100x, 100y, -100z) NEU cm`, quaternion은
  `(w, x, y, z) NED -> (x=-x, y=-y, z=z, w=w) Unreal`로 변환하여 보존된
  ProjectAirSim 규칙과 일치시킨다.

## 결과

- Native 시뮬레이션은 Unreal SDK 없이 계속 빌드·시험할 수 있다.
- 좌표 및 단위 변환을 플러그인 곳곳에 중복하지 않는다.
- 실제 host 구현과 collision sweep 입력 배선은 ADR 0008에서 완료했다.
