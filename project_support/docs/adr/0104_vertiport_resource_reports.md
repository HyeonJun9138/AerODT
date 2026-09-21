# ADR 0104: 버티포트별 자원 보고와 PSU 모니터링

- 상태: 채택
- 날짜: 2026-09-21

## 배경

`ScenarioEngine`과 `PsuSequencer`가 주기장 점유와 FATO 실제 점유를 내부 표로 직접
관리하면 시뮬레이션 물리, 버티포트 운영자, PSU의 책임을 구분할 수 없다. 실제
운용에서는 PSU가 항공기 위치를 보고 시설이 비었다고 임의로 추정하는 대신 각
시설이 제공한 자원 상태를 받아 판단해야 한다.

## 결정

버티포트마다 `VertiportOperator`를 한 개 둔다. 운영자는 자기 시설의 FATO,
주기장과 충전시설만 다루며 다음 자료를 포함한 불변
`VertiportResourceReport`를 발행한다.

- 스키마 버전, 버티포트와 운영자 식별자
- 단조 증가하는 보고 순번
- 관측 시각과 유효 시각
- 자원 종류와 식별자
- 운영 상태, 실제 점유자, 예약자와 자원 revision

동일 프로세스에서는 typed report를 직접 전달한다. 원격 프로세스가 붙으면
`as_dict`/`from_dict`와 Communication adapter로 동일 내용을 직렬화한다. 내부
EventBus는 추가하지 않는다.

`ScenarioEngine`은 항공기 위치와 접촉을 계산한 뒤 점유 관측만 해당 운영자에게
전달한다. 각 운영자는 보고서를 만들고, `PsuSequencer`의
`VertiportResourceMonitor`가 순번과 유효기간을 검사해 최신 보고를 보관한다.
PSU의 주기장 배정과 FATO 가용 판단은 이 모니터를 통해서만 수행한다. 보고가
없거나 만료됐거나 시설이 폐쇄된 경우 자원을 비어 있다고 가정하지 않는다.

PSU의 착륙번호, 접근 순서와 시간 슬롯은 교통 흐름의 상태이므로 PSU가 계속
소유한다. 항공기의 실제 위치는 Runtime/ScenarioEngine이 계속 소유한다.
버티포트 보고서는 이 상태의 운영 관측이며 별도 World 사본이 아니다.

## 실행 흐름

```text
Runtime/ScenarioEngine 물리 관측
  -> 해당 VertiportOperator 점유 관측 갱신
  -> VertiportResourceReport v1 발행
  -> PSU VertiportResourceMonitor 수신
  -> 보고된 자원 상태로 배정·대기·허가 판단
```

시설 예약은 PSU가 버티포트 운영자에게 동기 요청하고, 운영자가 현재 revision과
점유를 검사해 수락한 뒤 새 보고서를 발행하는 순서다. PSU 내부 표를 먼저
수정하지 않는다.

## 호환성과 후속 작업

직접 `PsuSequencer`를 시험하는 기존 단위시험은 로컬 `StandTimeline`을 유지한다.
웹 시나리오와 물리 fleet의 production 조립은 항상 `VertiportOperators`를 주입한다.
남은 후속 작업은 버티포트 운영 화면의 폐쇄·재개 명령을 이 운영자 API에 연결하고,
원격 배치가 필요할 때 Communication 계층에 wire adapter를 추가하는 것이다.
