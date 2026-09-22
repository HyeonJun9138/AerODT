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

### 3.1 정기편 출발 판단의 내부 연결

정기편의 계획 출발시각 도래는 허가가 아니라 요청을 시작할 조건이다. 현재 자동
시나리오에서는 `ScenarioEngine`이 시계를 진행하며 이 조건을 감지하고, 외부 wire 대신
동일 프로세스의 직접 호출로 PSU에 판단 자료를 전달한다.

```text
Runtime/Simulation -> Vertiport: 실제 지상 위치 관측
Vertiport -> PSU: 최단·차선 지상경로 제안과 현재 경로 점유 사실
Simulation -> PSU: 실행 가능한 비행 FATO 후보, 터미널 경로 중첩, 현재 교통 관측
Vertiport -> PSU: VertiportResourceReport
PSU -> Pilot: 선택된 FATO와 출발 허가 또는 대기 결과
Pilot -> Runtime: 허가를 반영한 지상이동·이륙 조종 명령
```

`VertiportGroundControl`은 해당 시설의 유도로 그래프에서 최단 경로와, 존재할 경우
다음으로 짧은 단순 경로를 만든다. 각 제안에는 실제 점유 관측으로 확인한 진행 가능
거리와 방해 기체가 붙는다. 이 제안은 이동 허가가 아니며 별도 외부 wire 보고를
강제하지 않는다. 현재 동일 프로세스에서는 typed 반환값으로 PSU 비교 단계에 전달한다.

`PsuSequencer`가 지상경로 제안과 FATO 후보의 운항 순서를 비교하고, 시설 보고·패드 점유·터미널 경로
중첩·대기 도착편 우선순위·최소 출발 간격을 해석하며, 최종 출발 슬롯을 허가하거나
대기시킨다. `ScenarioEngine`은 계획 시각을 감지하고 관측 및 버티포트 제안을 전달하며,
선택된 지상경로를 좌표계에 배치하고 실행한다. 유도로 탐색이나 경로 선택을 하지 않는다.
PSU의 허가가 반환된 뒤에만 엔진이 해당 결과를 조종사 실행 흐름에 적용한다.

운항용 `events.jsonl`에는 버티포트의 후보 요약과 PSU 선택 결과를 남긴다. 노드 전체,
후보별 점유 판정과 탈락 사유는 같은 실행 폴더의 개발용 `diagnostics.jsonl`에 따로
기록한다. 개발 진단은 운항 허가나 현재 상태로 사용하지 않는다.

자동 정기편 경로는 아직 `PilotPsuRequest`를 JSON으로 직렬화하지 않는다. 이는 외부
연결이 없기 때문이며, 요청의 논리적 수신자와 출발 판단 주체는 PSU로 고정한다.

### 3.2 접근 순번 요청 시점

접근 순번 요청 기준은 PSU나 Simulation의 결정이 아니라 Pilot 절차다. Runtime과
Simulation은 현재 위치, 비행 단계, 예상 잔여시간과 도착 진입점 근접 여부를 관측으로
제공한다. 자동 조종사는 기준 충족 시 `arrival` 요청을 즉시 전송하고, 수동 조종사는
같은 기준에서 요청 버튼과 일회성 알림음을 활성화한다. 기준 전 수동 요청은 대기
응답으로 처리한다.

두 모드는 남은 계획 항로를 따라 계산한 ETA를 공통 입력으로 사용한다. 수동 기체는
실제 3차원 위치를 아직 지나지 않은 항로 구간에 투영하고, 해당 구간 복귀와 남은
polyline을 구간별 속도·상승률·강하율로 계산한다. 착륙점까지의 직선거리는 요청
기준으로 사용하지 않는다.

PSU는 요청을 수신한 뒤 도착 순번, FATO와 접근 가능 여부를 판단한다. GATE는 실제
접지 뒤 착륙 순서대로 배정하며, 배정과 함께 버티포트가 계산한 복수 FATO→GATE
지상경로 중 하나를 선택한다. GATE 미확보는 빈 FATO의 착륙 자체를 막지 않지만,
접지한 기체는 배정될 때까지 FATO를 점유한다.
동일 FATO의 대기 순번은 남은 항로 ETA로 실시간 갱신된다. 1순위는 착륙 시작
고도 +10 m, 이후 순번은 10 m씩 높은 FATO 주변 대기층을 받는다. 순번 변경 이동과
착륙 시작점 직선 복귀는 관측 교통 및 이륙 경로 분리 검사를 통과해야 한다.

최종 접근 전 Simulation은 시설 보고에서 읽은 FATO 운용 상태, 실제 점유, FATO 간
인접 관계, 이미 최종 접근에 진입한 착륙편과 설정된 예고시간 안의 출발편 식별자를 PSU에
전달한다. PSU는 이륙 가능한 FATO의 보호 비율을 적용하여 착륙 후에도 남는 출발
용량을 계산한다. 기본 50%에서는 독립된 겸용 FATO 4개 중 2개를 보호한다. 부족하면
PSU→Pilot 응답은 `이륙 FATO 보호 대기`이며 Pilot은 기존 대기 지시를 계속 따른다.
브라우저에서 계산한 거리는 이미 활성화된 안내를 표시하는 보조값이며 요청 권한을
만들 수 없다. 세부 결정은 [ADR 0107](../adr/0107_pilot_owned_arrival_request_trigger.md)을
따른다.

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
