# ADR 0037: 공동 관찰과 역할별 운영 연습

날짜: 2026-09-10

## 결정

동일한 AeroDT 서버 프로세스에 접속하는 브라우저는 기존 `/ws/live`와
`/api/live/snapshot`의 서버 생성 상태를 읽는다. 카메라, 선택, 작업 패널은
개인 화면 상태다. PSU와 버티포트의 역할 선택으로 World를 따로 생성하지 않는다.
현재 저장 UAM 실행의 브라우저 재생 시간은 개인 상태이며 공동 실행 시간이 아니다.

이번 구현은 실운항 기능이 아니라 협업 GUI를 검증하는 명시적 연습이다.
`user_application/apps/web_dashboard/operations_rehearsal.py`가 한 프로세스의
참가자와 요청, 응답만 소유한다. Runtime의 기체 상태나 시설 가용 상태를
복제하지 않고, FastPhysics/SimpleFlight/조종사 goal을 수정하지 않는다.
`communication/web/operations_routes.py`는 주입된 객체를 호출하는 V1 HTTP
어댑터다. 내부 EventBus/CommandBus를 추가하지 않는다.

## 외부 계약

접두 경로: `/api/operations/rehearsal`

- GET: schema_version=1, scope=shared_rehearsal, room_id, revision,
  server_time, member, participants, facilities, requests, history, capabilities.
- POST `/join`: name(32자), role(psu/vertiport), facility_id. 무작위 세션
  token은 이 응답에만 포함한다. 클라이언트 메모리에만 두며 이후
  X-AeroDT-Session 헤더로 전달한다. 새로고침하면 재입장한다.
- POST `/examples`: PSU가 저장 시설 최대 3개에 출발/접근 예시를 한 번 추가.
- POST `/reports`: 담당 버티포트의 시설 보고, note 최대 240자.
- POST `/requests/{id}/decision`: version, action, note. PSU만 가능하다.
  hold/resequence는 후속 응답 가능, proceed/rejected/acknowledged는 종료다.
  시설 보고에는 acknowledged만 허용한다. version 불일치는 409이며 자동
  재전송하지 않는다. 현재 시설이 삭제됐으면 응답하지 않는다.

90초 무응답 세션은 제외된다. 최대 64명, 요청 200건, 처리 이력 100건이다.
응답은 no-store이고 cross-origin 브라우저 요청을 거부한다. 참가자 목록에
세션 token을 노출하지 않는다. 인증된 신원/역할이 아니라 연습 선택이며,
전체 기존 애플리케이션 API의 접근 권한을 제어하지 않는다.

브라우저는 3초마다 연습 정보만 조회하며 Live 항적 전송은 기존 WebSocket을
사용한다. 끊김/만료 시 응답 버튼을 잠근다. 같은 room의 과거 revision은
채택하지 않는다. 새로고침은 공유 요청을 지우지 않지만 서버 재시작은 모두
초기화하고 새 room_id를 만든다. 영구 실행 로그나 실제 허가 이력이 아니다.

## 화면 책임

- PSU 좌측: 역할 입장, 접속자, 공유 Live 표본 시각/수량, 미처리/대기/시설,
  보고된 조정 항목과 시설/상태 필터. 자동 충돌 탐지나 안전 판정은 미연결.
- PSU 하단: 요청 선택, 근거/사유 확인, 대기/진행/순서 조정/보류 응답 연습,
  공유 처리 이력. 버티포트 패널과는 상호 배타적으로 열어 겹침을 방지한다.
- 버티포트: 담당 시설로 입장, 공유 연습방에 보고, 해당 시설 PSU 응답 조회.
  기존 폐쇄/점유/시간표 예시는 여전히 브라우저 로컬이며 공유 요청과 별개다.

## 배포와 이후 연결 조건

현재 `main.py` 단일 프로세스 서버 한 개만 실행하고 모두 그 서버 주소로
접속한다. 각 PC에서 자기 `main.py`를 띄우면 서로 다른 방이다. 복수 worker나
복수 서버 간 공유는 지원하지 않는다. 로그인 없이 인터넷에 공개하는 운영은
금지하며, 이 기능은 기존 네트워크 접근을 확대하지 않는다.

실제 공동 UAM 운항 연결은 별도 단계다. 단일 Runtime 실행 ID와 서버
시뮬레이션 시간, 읽기 전용 StateSnapshot 배포, 인증된 역할/시설 권한,
조종사별 typed intent 및 실행 결과 계약, 취소/중복/만료 규칙, Data 기록과
회귀검증이 선행되어야 한다. 임의의 연습 응답을 비행 명령으로 변환하지 않는다.
현재 캡처와 시험은 협업 UI 증거이며 UAM 임무/Unreal 운용 승인을 대체하지 않는다.
