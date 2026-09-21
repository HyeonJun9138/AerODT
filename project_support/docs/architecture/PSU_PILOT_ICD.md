# PSU, 조종사와 Runtime 사이의 ICD

이 문서는 AeroDT 내부 운항 절차에서 사용하는 메시지 방향과 책임을 고정한다.
메시지 번호 체계는 아직 정하지 않는다. 현재 `kind`는 기능을 구분하는 안정적인
문자열이며, 향후 번호를 붙이더라도 아래 방향과 책임은 바꾸지 않는다.

## 1. 경계 원칙

PSU 메시지와 비행체 조종 명령은 같은 것이 아니다.

```text
Pilot --요청/보고--> PSU
Pilot <--응답/허가/지시/정보-- PSU

Pilot --조종 의도--> Runtime --제어기/actuator--> Simulation
Runtime --현재 상태 snapshot--> Pilot 및 표시 계층
```

PSU는 이륙, 접근, 착륙 순서와 대기를 판단하지만 로터, 추력, 자세 또는 조종면을
직접 명령하지 않는다. 조종사는 PSU 메시지를 자기 운항 의사결정의 입력으로 받아
별도의 `PilotVehicleCommand`를 만든다. Runtime은 그 명령을 제어기 입력으로
번역하고, Simulation은 물리 계산만 수행한다. 따라서 PSU에서 Simulation으로
직접 가는 운항 명령 경로는 두지 않는다.

동일 프로세스에서는 아래 typed 객체를 직접 전달한다. 외부 시스템을 연결할 때만
Communication adapter가 `as_dict`와 `from_dict`를 사용해 같은 내용을 wire로
직렬화한다. 내부 EventBus, CommandBus 또는 별도 현재 상태 저장소는 만들지 않는다.

## 2. Pilot에서 PSU로

### `PilotPsuRequest`

조종사가 원하는 운항 절차를 요청한다. 요청을 전송했다는 사실만으로 허가가 생기지
않는다.

| `kind` | 의미 |
|---|---|
| `departure` | 출발 절차 요청 |
| `takeoff` | 이륙 허가 요청 |
| `arrival` | 도착 순서 요청 |
| `hold` | 대기 또는 대기 해제 검토 요청 |
| `approach` | 접근 허가 요청 |
| `landing` | 착륙 허가 요청 |

공통 필드는 `schema_version`, `message_type`, `direction`, `message_id`,
`flight_id`, `aircraft_id`, `pilot_id`, `psu_id`, `kind`, `issued_at_s`,
`sequence`다. 도착 관련 예상 시각은 선택 필드 `eta_s`로 보낸다.

### `PilotPsuReport`

조종사가 관측한 사실, 수신 확인 또는 수행 불가를 보고한다.

| `kind` | 의미 |
|---|---|
| `report_airborne` | 이륙 완료 보고 |
| `report_landed` | 착륙 완료 보고 |
| `report_gate` | 도착 GATE 정차 보고 |
| `acknowledgement` | PSU 메시지 수신·수락 확인 |
| `unable` | 지시 수행 불가 보고 |

요청 공통 필드에 `reference_message_id`와 `reason`을 추가한다. 보고는 새로운
허가를 만들지 않으며 PSU가 처리 결과를 다시 회신한다.

## 3. PSU에서 Pilot로

`PsuPilotMessage` 하나로 응답, 허가, 지시와 정보를 전달한다.

| `kind` | 기능 |
|---|---|
| `departure_response` | 출발 요청 결과 |
| `takeoff_clearance` | 이륙 허가 |
| `arrival_sequence` | 도착 순서 |
| `hold_directive` | 대기 지시 |
| `resume_directive` | 대기 해제 지시 |
| `approach_clearance` | 접근 허가 |
| `landing_clearance` | 착륙 허가 |
| `report_acknowledgement` | 조종사 보고 처리 결과 |
| `request_refused` | 요청 거절 |
| `clearance_amendment` | 기존 허가 변경 |
| `clearance_cancellation` | 기존 허가 취소 |
| `traffic_information` | 교통 정보 |

`request_message_id`로 원 요청이나 보고와 연결한다. `issued_at_s`와
`expires_at_s`는 메시지의 시간 범위를 나타내고, `sequence`는 PSU별 응답 순서를
나타낸다. 시설 결과가 포함되면 `vertiport_id`, `fato_id`, `stand_id`를 사용한다.
허가가 실제 시설 자원을 임의로 생성하지는 않는다. PSU는 버티포트가 발행한 최신
`VertiportResourceReport`를 근거로 판단한다.

## 4. Pilot에서 Runtime으로

`PilotVehicleCommand`는 사람이 직접 만든 축 입력, 조종 보조 출력과 자동 유도
출력을 같은 경계로 전달한다.

| `source` | 생성 주체 |
|---|---|
| `manual` | 조종 장치의 직접 입력 |
| `assisted` | 고도 유지 등 조종 보조 기능의 출력 |
| `automatic` | 자동 조종사가 만든 유도 출력 |

명령은 식별자, 조종사·기체·비행 식별자, 순번, 발행·만료 시각, 비행 모드와
`throttle`, `roll`, `pitch`, `yaw`를 가진다. 자동 유도가 활성화되면
`PilotGuidanceGoal`에 heading, NED down, 속도 목표를 함께 넣는다. 명령은 현재
기체 상태가 아니며 Runtime이 명령을 적용한 뒤에도 권위 있는 상태는 Runtime의
World와 entity에만 존재한다.

대화형 수동 비행과 그 안의 자동조종·고도유지는 현재 이 계약을 사용한다. 기존
native 일정 비행의 `RoutePilotCommand`도 동일한 Pilot에서 Runtime으로의 typed
직접 호출 경계를 따르지만 C++ 제어 goal variant를 사용하므로 JSON wire 계약으로
직렬화하지 않는다.

## 5. 처리 규칙

1. 발신자는 각 방향에서 단조 증가하는 양의 `sequence`를 사용한다.
2. 동일한 `message_id`와 동일한 내용이 재전송되면 PSU는 처음 처리한 결과를 그대로
   돌려준다. 같은 ID에 다른 내용을 넣으면 거절한다.
3. 이미 처리한 순번보다 같거나 작은 새 메시지는 거절한다.
4. 응답은 반드시 원 요청의 `message_id`를 참조한다.
5. `message_type`과 `direction`이 계약과 다르면 역직렬화 단계에서 거절한다.
6. 화면의 버튼, 폴링 또는 재생 상태가 허가나 비행체 명령을 임의로 만들지 않는다.
7. PSU 메시지의 수신만으로 비행체는 움직이지 않는다. 조종사가 별도 명령을 만들고
   Runtime이 적용해야 한다.

시뮬레이션 전체의 재생, 일시정지와 배속은 운항 허가가 아니라 Application의 실행
제어다. 호환 URL에서 `resume_day`를 받더라도 Pilot→PSU 통신 이력에는 넣지 않는다.

현재 브라우저 수동 조종 경로는 `message_id`와 `sequence`를 전송하고, 서버는
중복 요청과 뒤집힌 순서를 검사한다. 별도 외부 PSU 또는 원격 조종사 transport는
아직 연결하지 않았으며, 필요해질 때 Communication 계층에 adapter를 추가한다.
