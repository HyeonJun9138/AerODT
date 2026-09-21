# ADR 0001: ProjectAirSim을 legacy 호환 경계 뒤에 보존

## 상태

채택, 2026-09-03

## 배경

기존 ProjectAirSim은 FastPhysics, SimpleFlight, 틸트 actuator, Unreal 표현, NNG 통신이 함께 동작하는 UAM 기준선을 이미 제공한다. 전체 소스를 한 번에 이동하면서 기능까지 수정하면 이산 시뮬레이션 순서와 Unreal 빌드 규칙이 동시에 바뀌어 회귀 원인을 분리하기 어렵다.

## 결정

기준 커밋의 트리를 `project_support/reference/projectairsim`에 보존한다. AeroDT의 첫 실행 경로는 `communication`의 호환 adapter만 legacy SDK를 참조한다. UAM model package와 mission, 로그 소유권은 즉시 새 구조로 옮긴다. Native C++ 이식은 회귀시험이 준비된 작은 단위로 진행한다.

## 결과

사용자는 새 AeroDT 진입점으로 검증된 UAM을 계속 실행할 수 있다. 단, 현재 물리와 제어 구현의 실제 소유 코드는 아직 legacy에 있으며 이를 제거하려면 FastPhysics, actuator, SimpleFlight 순으로 이식하고 같은 임무 궤적을 비교해야 한다.

## 후속 상태

ADR 0008에서 native physics/controller의 실제 Unreal host 연결을 완료했다.
ProjectAirSim 호환 adapter는 이제 process, service 및 scene 생명주기만 담당한다.
