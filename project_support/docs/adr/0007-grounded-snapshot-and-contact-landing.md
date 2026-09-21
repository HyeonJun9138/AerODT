# ADR 0007: Grounded snapshot과 접촉 기반 착륙 완료

- 상태: 승인
- 날짜: 2026-09-03

## 배경

초기 headless 임무는 착륙 단계를 시작 위치 근처의 위치·속도 조건으로 끝냈다.
AirTaxi scene의 초기 body origin은 지면보다 4 m 위에 있으므로 이 조건은 실제
지면 접촉을 증명하지 못했다. Unreal 연동의 완료 기준과도 일치하지 않았다.

## 결정

- `StateSnapshot::is_grounded`가 같은 runtime tick의 FastPhysics grounded latch를
  외부에 읽기 전용으로 공개한다.
- UAM 임무의 착륙 단계는 양의 NED Z 하강 속도 goal을 계속 생성하며,
  `is_grounded`와 정지 속도를 모두 확인한 뒤에만 완료한다.
- headless 검증에는 최소 `FlatGroundContactModel`을 사용한다. model package의
  root collision box로부터 생성한 body ground clearance와 NED ground plane으로
  `ContactObservation`을 만들고 다음 runtime tick에 공급한다.
- 실제 Unreal 실행에서는 flat-ground model을 사용하지 않고 scene sweep hit를
  `UnrealVisualizationAdapter`를 통해 동일 계약으로 공급한다.

## 결과

Headless 전체 임무도 실제 contact branch와 grounded latch를 통과해야 성공한다.
현재 상태의 권위는 여전히 runtime에 하나만 있으며 snapshot의 bool은 상태 사본이
아니라 해당 tick 결과의 접촉 진단이다.
