# ADR 0002: SimpleFlight 구성을 typed runtime 값으로 컴파일

- 상태: 승인
- 날짜: 2026-09-03

## 배경

UAM model package의 SimpleFlight 설정은 문자열 키와 숫자 값의 map으로
`UamRuntimeConfig`에 남아 있었다. 이 방식은 오타를 실행 중까지 발견하지
못하고, 전환 상태기계와 controller가 같은 실속 속도를 별도 필드에 보관하게
만들었다.

## 결정

package compiler는 JSONC의 legacy-compatible parameter map을 한 번 전달하고,
`LoadSimpleFlightParameters`가 ProjectAirSim 기본값과 override 규칙을 적용해
다음 typed 값으로 변환한다.

- multirotor cascade PID와 축 제한
- fixed-wing cascade PID와 축 제한
- 최소 throttle
- 실속 및 기본 전진 속도
- fixed-wing 최소 pitch와 airframe capability

`UamRuntimeConfig`에는 이 typed `SimpleFlightParameters`만 저장한다. 원본 문자열
map과 별도 실속 속도 사본은 보관하지 않는다.

## 결과

- native runtime의 controller 구성은 컴파일된 타입으로만 접근한다.
- JSON parser와 legacy `Params`에 대한 실행 의존성은 생기지 않는다.
- fixed-wing controller가 추가될 때 같은 typed 설정을 재사용한다.
- `fixed_wing_capable`은 정적 model package 특성만 나타낸다. 운용 중
  fixed-wing 전환 요청은 controller update 입력으로 별도 전달한다.
- model package의 외부 키는 ProjectAirSim 호환성을 위해 현재 그대로 유지한다.
