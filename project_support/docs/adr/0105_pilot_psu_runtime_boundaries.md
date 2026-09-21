# ADR 0105: PSU, 조종사와 Runtime 명령 경계

- 상태: 채택
- 날짜: 2026-09-21

## 배경

수동 조종 화면의 PSU 요청은 문자열 `kind`와 응답 사전으로 동작했고, 조종 입력은
축 값 그대로 native adapter에 전달됐다. 이 구조에서는 PSU의 운항 판단, 조종사의
요청과 보고, 조종사의 비행체 조종 의도가 코드상 같은 종류의 명령처럼 보일 수
있다. 또한 자동과 수동이 서로 다른 운항 절차를 갖는 것으로 오해하기 쉽다.

## 결정

방향별 계약을 `digital_twin/contracts`에 둔다.

- Pilot에서 PSU로 가는 요청은 `PilotPsuRequest`다.
- Pilot에서 PSU로 가는 사실 보고는 `PilotPsuReport`다.
- PSU에서 Pilot로 가는 응답, 허가, 지시와 정보는 `PsuPilotMessage`다.
- Pilot에서 Runtime으로 가는 조종 의도는 `PilotVehicleCommand`다.

PSU 메시지는 기체 제어 명령이 아니며 PSU에서 Simulation으로 직접 전달하지 않는다.
수동 축 입력, 조종 보조와 자동 유도는 `source`만 다르고 같은 Pilot에서 Runtime
경계를 통과한다. Runtime adapter는 이 경계에서만 typed 명령을 native 축 및 유도
호출로 변환한다.

대화형 PSU 요청은 message ID와 단조 증가 순번을 사용한다. 같은 ID의 재전송은
기존 결과를 반환하고, 이미 처리한 순번을 다시 사용한 새 메시지는 거절한다. PSU
응답은 원 요청 ID를 참조하며 응답 순번과 유효 시각을 가진다.

기능별 숫자 코드는 이번 결정에 포함하지 않는다. 각 방향은 `message_type`과
`direction`으로 먼저 분리하고 기능은 문자열 `kind`로 구분한다. 향후 번호 체계가
정해지면 별도 스키마 revision과 ADR로 추가한다.

## 결과

브라우저 버튼은 조종사의 요청을 만들 뿐 허가를 만들지 않는다. PSU 판단 결과는
조종사에게 돌아오며, 기체가 실제로 움직이려면 조종사가 별도의
`PilotVehicleCommand`를 Runtime에 보내야 한다. 물리 상태와 actuator 계산의
소유권은 기존 Runtime과 Simulation에 그대로 남는다.

같은 프로세스에서는 typed 직접 호출을 사용한다. 외부 PSU나 원격 조종사가 연결될
때만 Communication adapter에서 `as_dict`와 `from_dict`를 사용한다. 현재 외부
transport와 인증은 구현 범위가 아니다.

## 검증

계약 JSON 왕복, 방향 불일치 거절, 요청·응답 correlation, 중복 ID의 멱등 처리,
낡은 순번 거절, 수동·자동 source의 공통 명령 envelope와 Runtime 경계 변환을
단위시험으로 고정한다.

