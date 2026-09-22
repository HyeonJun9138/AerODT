# AeroDT 현재 개발 상태

## 2026-09-22 출입문과 충전·절차 종료 분리

- 사용자 보고: 충전 중 `문 닫기`가 케이블 분리와 절차 release까지 실행했고, 충전 전에 닫으면 다른 버튼이 모두 잠겼다. `close_door`를 순수 출입문 명령으로 변경했다. 문을 닫아도 케이블·충전·승객 operation은 유지되고, 다시 열어도 승객 하차가 중복되지 않는다. 구 클라이언트의 명시적 `release`만 호환 목적으로 기존 분리·종료 의미를 유지한다.
- operation에 `door_state`와 연속 `door_open`을 독립 상태로 추가했다. 문 버튼은 모든 지상 작업 단계에서 활성화되며 이동 중·비행 중 같은 물리 안전 조건만 서버가 거절한다. 문을 닫은 채로도 하차가 끝났다면 충전을 요청할 수 있고, 승객 하차만 열린 문을 요구한다.
- 다음 비행은 `phase=released`가 아니라 승객 하차 완료와 실제 문 닫힘으로 만든 `turnaround_complete`를 사용한다. TURNAROUND 화면도 이 상태로 다음 비행 버튼을 노출하며, 문 닫힘이 충전기 상태를 바꾸지 않는다.
- 검증: 관련 Python 54 PASS, Node 32 PASS, Python compile/JavaScript syntax PASS. 충전 중 문 닫기 후 `release_s`·`disconnect_s` 미생성, cable 시각화 유지, 문 재개방, 닫힌 문 상태에서 충전 요청과 `released` 없이 다음 비행 전환을 회귀시험으로 확인했다. Python 서버 재시작과 브라우저 새로고침 뒤 적용된다. ADR 0117 갱신.

## 2026-09-22 보행 기능 사용자 노출 보류

- 사용자 결정에 따라 TURNAROUND에서 조종사 `내려서 걷기` 버튼을 제거했다. 문 열기/닫기, 승객 하차, 충전 요청과 다음 비행 이어가기만 남는다. 웹 화면에서 `crew_out`을 요청하는 다른 진입점도 없다.
- 직전 검토 중이던 조이스틱 보행, 3인칭 보행자 모델, 시야 높이 변경과 시점 복구 확장은 적용하지 않았다. 기존 보행 모듈은 추후 재검토를 위해 남아 있지만 화면에서 시작할 수 없다.
- 검증: TURNAROUND·DeckWalk·WalkCamera 관련 Node 44 PASS, 변경 JavaScript syntax check와 diff check PASS. 서버 재시작은 필요 없고 브라우저 새로고침 후 버튼 제거가 적용된다.

## 2026-09-22 수동 비행 렉: 10초 주기 GC 정지 제거와 1 ms 타이머

- 사용자 요청: 일반 시뮬레이션 말고 수동 비행 쪽 렉에 집중, 5분간 모니터링. 사용자가 조종하는 동안 실서버(사용자가 14:12에 직접 재시작한 본, 핫패스·리비전 캐시·양보·타이머 포함) 이벤트 루프 지연을 20 Hz로 5분 측정: p50 20.8 ms·p95 71·p99 106·max 290, 100 ms 초과 56회(200 ms 초과 26회), **200~290 ms 정지가 9~10초마다 한 번**(9.8, 20.5, 30.6, 39.3 … 291.8 s), 하루 시계/벽시계 0.987, 서버 CPU 중앙값 107%. 이 주기 정지가 조종 중 느껴지는 렉이다.
- 원인 확인(오프라인, 같은 하루 06:45 x1 300틱, gc.callbacks): 순환 GC 2세대 전체 수집이 2회, 각각 144·150 ms로 틱을 멈춤(틱 최대 276 ms). 하루를 올린 뒤 살아 있는 객체 25만 개를 `gc.freeze()`로 영구 세대에 옮기자 2세대 수집은 9.1 ms 한 번, 틱 최대 194 ms, 250 ms 초과 0. 실서버는 객체가 더 많아 정지가 더 길고 잦았다(200~290 ms, 10초).
- scenario_session.py: `load()` 끝에 `_freeze_day()`(unfreeze→collect→freeze), `clear()`에 `_thaw_day()`(unfreeze→collect). 동작 불변, 메모리 관리만 바뀜. test_day_freeze.py 1건, 세션·기록자 시험 31 PASS.
- GIL 대기 실험(같은 하루를 x1로 돌리는 워커 옆에서 대기 스레드가 인터프리터를 받기까지의 간격, 15 s×4): 기본 21.6/61 ms(p50/p95) → Windows 타이머 1 ms 6.5/24.5 → 1 ms 양보만 17.6/84 → 둘 다 8.0/41.9. 타이머는 확실히 효과, 양보는 효과 없음(놓은 스레드가 GIL을 곧바로 되찾는 구조; 전환 요청이 있어야 강제 인계). launcher.py는 서비스 중 `timeBeginPeriod(1)`을 잡고 끝날 때 되돌리며(timer_resolution.py, 시험 2건), 양보 코드는 넣었다가 제거했다.
- 리비전 캐시·ChangeWatch 숨은 탭 생략은 앞 섹션대로. 폴링 핸들러의 순수 계산은 3~6 ms라 렉의 주범이 아니었다.
- x1 벤치(cProfile 없이) 51대 비행: 틱 p50 89.5 ms. cProfile 아래에서는 173 ms(2배 과대). 스텝당 고정 비용은 네이티브 풀 대기 ~77 ms(GIL 해제), 출발 검토·대기열 지시·예측 갱신 등 파이썬 ~100 ms/스텝(x10 기준)이며 이 몫은 그대로 남아 있다.
- 지문: 양보가 있든 없든 04:58 이후의 x10 벤치 지문은 f5a197d590de51e1로 바뀌었고 06:45 시점의 출발 편수도 55→63으로 달라졌다. 04:58 이후 엔진 경로에서 바뀐 파일은 Codex의 decision_policy.py·arrival_allocation.py·psu_sequencing.py·manual_procedure.py(14:01~14:05)와 terminal_plan/board(05:00~05:17)뿐이고, 이 세션의 변경은 양보(넣었다 제거)와 GC 관리(메모리만)라 지문 변화는 Codex의 결정 로직 변경에 따른 것으로 본다. 핫패스 절감의 동일성은 04:58 지문 일치와 test_tick_hot_paths.py의 옛 함수 대조로 이미 확인했다.
- 재시작본(고정+타이머+핫패스+리비전 캐시)에서 사용자 비행 중 깨끗한 5분 재측정(27→42대 비행): p50 17.1·p90 54·p95 64.6·p99 110·max 275 ms, 100 ms 초과 55회, 200 ms 초과 14회(전 26회), 300 ms 초과 0, 시계 비율 0.994. 그러나 9~10초 주기 정지는 남아 있고 길이가 비행 초 118 ms에서 10분 뒤 275 ms로 자라났다. 고정 뒤에 쌓이는 하루의 상태(이벤트·항적·이력·근접 최소값)를 2세대 수집이 매번 다 훑기 때문이다(벤치에서 30초분 = 9 ms → 0.3~0.45 ms/s로 증가).
- scenario_session.py `_collect_garbage_quietly()`: 틱마다(락 안) 30초에 한 번 `gc.collect(); gc.freeze()`로 고정 뒤에 쌓인 것만 걷어 다시 고정하고(수 ms), 15분에 한 번 `unfreeze→collect→freeze`로 하루 전체를 한 번 걷어 고정된 채 죽은 객체를 돌려준다(한 번 150~300 ms). 자동 2세대 수집은 30초분 이하만 걷게 된다. 시험 2건(test_day_freeze.py). 서버 재시작 후 적용.

## 2026-09-22 보행 조종사 출입문 근접 탑승

- 보행 모드의 탑승을 `E` 키 하나로 제한하고 `Escape` 원격 탑승을 제거했다. 현재 기체 자세와 airframe 출입문 offset으로 출입문 옆 지점을 매번 다시 계산하며, 같은 데크 층에서 2 m 이내일 때만 서버에 `crew_in`을 요청한다.
- 거리가 멀면 탑승 요청을 보내지 않고 출입문까지 거리를 표시한다. 터미널 층에서는 먼저 데크로 올라가라는 안내를 표시한다. TURNAROUND의 기존 `기체로 돌아가기` 버튼도 동일한 근접 판정을 우회하지 않도록 `DeckWalk.board()`를 거치며 `출입문에서 탑승`으로 이름을 명확히 했다.
- 검증: `deck_walk.test.mjs`와 `cockpit_ground_controls.test.mjs` 28 PASS, 변경 JavaScript syntax check PASS. 서버 변경은 없어 재시작이 필요하지 않으며 브라우저 새로고침 후 적용된다.

## 2026-09-22 TURNAROUND 문·승객·충전 버튼 분리

- 사용자 요청에 따라 결합 동작을 제거했다. 기체 지상 절차는 첫 줄의 `문 열기/문 닫기`, `승객 하차`, `충전 요청` 세 버튼으로 분리한다. 조종사가 직접 내리는 `내려서 걷기`는 별도 전체 폭 버튼이며 승객 하차와 다른 `crew_out/crew_in` 동작이다.
- 서버는 `open_door`에서 문만 열고 `door_open`으로 대기한다. 승객 수와 보행은 `disembark`를 별도로 누른 시점부터 시작하며, 하차 완료 뒤에만 `charge`가 가능하다. 문은 하차 전에 닫고 다시 열 수 있지만 `turnaround_complete=false`라 다음 비행으로 넘어갈 수 없다. 재개는 같은 operation을 사용해 승객을 중복 생성하지 않는다.
- 충전 중 문 닫기는 기존처럼 케이블 분리 후 닫히며, 다음 비행은 승객 하차 완료·문 닫힘·목표 SOC를 모두 만족해야 한다. 이전 결합 요청 `disembark`/`release`는 구 클라이언트 호환용으로 유지한다. 새 capability `ground_handling_v3`가 없는 구 서버에서는 분리 버튼을 활성화하지 않는다.
- 시각화의 승객 레이어 시작 시각도 실제 `alighting_start_s`로 변경해 문을 열었다는 이유만으로 사람이 먼저 움직이지 않는다. TURNAROUND 버튼 영역은 3열 기체 절차, 별도 조종사 행동, 조건부 다음 비행 행으로 구성했다.
- 검증: 관련 Python9파일73 PASS, Node5파일30 PASS. 문 열기만 수행 시 승객 정지, 세 요청의 독립 순서, 하차 전 닫기/재열기, 중복 하차 방지, 다음 비행 차단, 조종사 버튼 분리 확인. py_compile/node syntax/diff-check 수행. ADR0117 기록. 적용에는 Python 서버 재시작과 브라우저 새로고침이 필요하며 현재 비행 보호를 위해 임의 재시작하지 않았다.

## 2026-09-22 외부 카메라 깜빡임 수정과 API 폴링의 서버 비용 절감

- 사용자 보고: EXTERNAL VISION을 켜면 메인 화면이 깜빡임. 원인은 shared_view_camera.js가 렌즈 시점 렌더를 별도 rAF에 예약한 것. 지도 루프는 성능 프로파일에 따라 `targetFrameRate`를 60 미만으로 두면 표시 프레임을 건너뛰므로(globe.js:1058), 지도가 그리지 않은 프레임에서 렌즈 이미지가 메인 캔버스에 남아 그대로 화면에 올라갔다. 렌즈 렌더를 장면의 `preUpdate`(렌더의 첫 단계) 안에서 수행해 같은 작업에서 지도 렌더가 바로 덮어쓰도록 바꿨고, 지도의 입력 단계(`initializeFrame`)는 두 번 돌리지 않는다. 회귀시험 9건(shared_view_camera.test.mjs 재작성) 및 조종석 시험 포함 30 PASS. 서버 재시작 없이 새로고침으로 적용.
- 사용자 보고: 남은 미세 끊김이 API 호출과 맞물려 보임. 비행 중 실서버 측정(기준 /api/health p50 6.5 ms): 리비전 스탬프 p50 46 ms(71 B), 승객 72 ms, 상태 41 ms, 수동 PSU 48 ms, 데크 요약 49 ms, 조종사 45 ms(154 KB). 오프라인 순수 계산은 각각 3·4·0.2·0·6·3 ms라 대부분은 틱과의 GIL·락 경합이고, 그 경합에서 폴링 핸들러가 잡는 인터프리터 시간이 조종 스텝(이벤트 루프 인라인)을 늦춘다.
- application.py `simulation_revision`: 매 호출마다 버티포트·노드·링크 전부를 JSON 직렬화해 SHA1하던 것을, VertiportRecords/RouteRecords에 저장 횟수 `version`을 두고 (버전 쌍)별로 기억해 되돌려준다(답 동일; test_shared_editing 23 PASS, test_store_versions 2건 추가). 페이지마다 2 s·5 s 폴러 두 개가 부르므로 탭 수만큼 곱해지던 비용이 사라진다. 서버 재시작 후 적용.
- change_watch.js: 숨은 탭은 리비전을 묻지 않고 박자만 유지하다가 다시 보이면 즉시 묻는다(회귀시험 2건). 운영 환경 2 s 폴러는 이미 hidden 검사가 있었다.
- 확인한 것: 기록자 지연 쓰기가 참조하는 상태 값은 모두 스칼라(위치·속도·배터리·power_kw; energy.snapshot()은 새 dict)라 엔진이 뒤에 상태를 바꿔도 기록이 달라지지 않는다. /ws/live 스냅샷은 115대 기준 129 KB/틱, 서버 인코딩 2 ms, 클라이언트 파싱 1~2 ms로 끊김 원인이 아니다.

## 2026-09-22 서로 다른 FATO의 거리 기반 연동 폐쇄 제거

- 사용자 결정에 따라 `pad_adjacency_m`를 제거했다. 이제 실제 점유는 같은 FATO 식별자에만 적용한다. F1이 사용 중이어도 F2는 중심 거리에 관계없이 닫히지 않는다.
- `ScenarioEngine._nearby_pads`를 `_same_fato`로 바꾸고 출발 blocker, 최종 착륙, 도착 재배정, 이륙 FATO 보호 용량, 선착륙 판단을 모두 같은 규칙으로 통일했다. 서로 다른 FATO의 접근·상승 경로 교차, 지상 유도로 교차와 실제 공중 근접 대응은 기존 별도 검사에 남아 있다.
- PSU 의사결정 차트와 브라우저 기준 데이터에서 `인접 패드 간격` 설정을 삭제했다. 현재 운항 계약은 ADR 0117에 기록했고 BOUNDARIES, FLIGHT_OPERATIONS, ADR 0110을 갱신했다.
- 검증: 관련 Python 11개 파일 139 PASS, 정책 차트 Node 31 PASS, `py_compile` PASS. 실행 중 서버는 정책 snapshot과 Python 코드를 이미 적재했으므로 재시작 전까지 이 변경이 적용되지 않는다.

## 2026-09-22 충전 전 문 닫기 이후 지상 절차 복구

- 사용자 화면에서 하차 후 충전 전에 `문 닫기`를 누르자 phase가 `released`로 끝나고, 다음 편 목표95%에 현재84%라 `다음 비행 이어가기`도 잠겼으며 문 열기/충전/내리기 버튼도 모두 비활성화되는 교착을 확인했다. 서버의 release가 문 닫기와 절차 최종 종료를 하나로 처리했고 화면은 released에서 복구 동작을 제공하지 않았다.
- ManualGround에 `reopen` 요청 추가. 충전을 요청하기 전에 닫은 완료 절차만 다시 열 수 있으며, 기존 operation과 완료된 승객 하차 walk를 보존하고 release 전이를 제거해 `awaiting_charge`(충전기 있음) 또는 `complete`(충전기 없음)로 돌아간다. 기체 접지·GATE 위치·정지·로터·스로틀/스틱 조건을 다시 확인하고, 충전 완료 절차는 되돌리지 않는다.
- TURNAROUND 화면은 서버가 `reopen_allowed`를 보낼 때 `문 다시 열기`를 활성화한다. 다음 비행 SOC 미달로 이어가기 버튼이 잠겨 있어도 재개 버튼은 사용할 수 있다. 재개 후 충전 연결 요청 또는 충전 시설이 없는 경우 내려서 걷기를 다시 수행할 수 있다.
- 검증: 관련 Python5파일44 PASS, 관련 Node2파일14 PASS. 문 닫기→released→재개→awaiting_charge→충전 요청, 승객 하차 비반복, 이동 중 재개 거부, SOC84%/목표95% 화면 교착 해제를 확인. Python 서버 재시작 전까지 실행 중 세션에는 미적용이며 현재 비행 초기화를 피하기 위해 임의 재시작하지 않았다.

## 2026-09-22 목적지 대기점 부족 시 출발 FATO 교착 방지

- 실운행 중 수동편 UAM0064가 VP011 F2에서 최종 착륙 허가를 기다릴 때, 자동편 UAM0057/FPL000044가 인접 F1을 점유한 채 `PSU 접근 대기점 여유 확보 대기`로 멈춘 사실을 확인했다. F1-F2는 48 m로 `pad_adjacency_m=50` 안이어서 F2 착륙도 함께 보류된 것이며, 수동 조종사의 접근→중단 대기→재접근 순서는 정상이었다.
- 원인은 목적지 대기점 예약을 출발 GATE가 아니라 지상이동 완료 뒤 native Pilot 시작 직전에 수행한 순서였다. 자동편이 출발 FATO까지 간 다음 예약에 실패하면 그 자리에서 정지했다.
- `ScenarioEngine._maybe_depart`가 출발 슬롯 확정 전 목적지 대기점과 그 경로를 가역적으로 준비한다. 후보가 없으면 `PSU 접근 대기점 여유 확보 대기 (GATE 유지)`로 GATE에 남고 FATO 점유·출발 clearance를 만들지 않는다. 출발 슬롯이 거절되면 그 판단 중 생성한 예약을 반환하며, 허가된 때만 경로와 운영 로그를 확정한다. 이미 비행 중인 편의 기존 `_prepare_waiting_route`는 같은 공통 빌더를 사용한다.
- 수동 최종 착륙 보류 문구는 일반적인 `최종 패드 점유` 대신 패드·운항 종류·비행체를 표시하게 했다. 이후 ADR 0117에서 서로 다른 FATO의 연동 폐쇄 자체를 제거했으므로 현재는 **같은 FATO** 점유자만 이 사유로 표시한다.
- 검증: 변경과 직접 관련된 시나리오·PSU·수동 절차 7개 파일 89 PASS, `py_compile` PASS. 비교용으로 기존 `test_fato_resource_utilization`까지 포함한 5개 파일은 52 PASS/2 FAIL이며, 두 실패는 이번 변경과 무관한 기존 접근 속도 경계 실패(현재 정책 7 m/s, fixture 8 m/s)다. 실행 중 서버는 변경 전 코드지만, 재확인 시 UAM0057가 대기점을 얻어 이륙했고 UAM0064의 `최종 착륙 허가 요청`이 활성화된 것을 실제 API로 확인했다. 새 예방 로직과 상세 문구는 서버 재시작 뒤 적용된다.

## 2026-09-22 버티포트 실내 4단계: 운항 시간표와 그 시간표가 만드는 사람들

- 새 모듈 `digital_twin/model_library/terminal_board.py`는 하루 계획(이미 `off_block_s`·`touchdown_s`·`passengers`·`departure_stand`를 들고 있다)과 각 편의 현재 상태와 시계만으로 한 데크의 출발·도착 행을 만든다. 엔진과 관측에서 떼어 냈다: 위상과 시계를 화면의 낱말로 바꾸는 규칙은 시나리오를 띄우지 않고도 시험할 수 있어야 하고, 여기서 비행에 대해 결정하는 것은 하나도 없다.
- 상태는 읽기일 뿐이다. 출발은 `gate_out`→이동, 비행 중→출발, 스탠드에 서 있으면 시계가 판단(예정/탑승/지연). 도착은 `gate_in`/충전→도착, 홀딩→대기, `landing`→착륙, 비행 중→접근.
- **행과 사람이 한 답에서 나온다.** 행마다 게이트와 승객 수를 들고 있으므로 `waiting_by_gate`가 같은 행에서 게이트별 대기 인원을 뽑아 `board.waiting`으로 함께 실려 나간다. 호출된 편(탑승·지연)만 센다 — 하루치 승객을 전부 라운지에 세우면 새벽 네 시에 만원인 터미널이 된다. "누가 기다리는가"를 두 군데서 읽으면 1분 안에 어긋난다.
- 새 경로를 만들지 않았다. 페이지가 이미 몇 초마다 부르는 `/api/simulation/scenario/vertiports/{id}` 답에 `board`를 얹었다. 같은 데크를 두 번 물으면 두 화면이 서로 다른 출발 시각을 말하게 된다.
- 그리기: `terminal_board.js`의 `paintBoard`가 1024x384 캔버스에 머리글·시계·행(시각/편명/←→행선지/게이트/상태)을 칠하고 상태마다 색을 준다. 판은 케이스가 아니라 **한 장의 평판**이다 — 두 점짜리 wall은 quad 하나여서 그림이 한 번 매핑되고, 네 면을 도는 ring에 칠하면 시간표가 모서리를 타고 흐른다. 빈 판은 "예정된 운항이 없습니다", 아직 못 받았으면 "불러오는 중"이라고 말한다(빈 화면은 고장이다).
- 사람: `terminal_people.js`가 하루 탑승 보행이 쓰는 그 카탈로그(kenney_blocky_person)를 그대로 써서 40개 몸을 풀로 잡고 재사용한다. 조종사가 있을 수 있는 건물은 하나뿐이라 풀은 데크에 내릴 때(가만히 서 있는 순간) 채운다. `peopleOn`이 라운지 자리부터 채우고 남은 사람은 뒷줄 뒤에 계단을 보고 세우며, 검색 레인과 화장실 아닌 점포마다 직원을 둔다. 군중은 44명으로 제한한다.
- 게이트 연동: 각 라운지 표지가 `G4 · 07:26 상암 · 탑승`처럼 자기 편을 말한다. 번호만 적힌 게이트는 번호일 뿐이고, 거기 서 있는 이유는 100 m 떨어진 벽에만 적혀 있었다.
- 갱신은 걷는 동안 2.5초마다 한 번. 응답 전에 시각을 찍어 느린 답 뒤에 두 번째 요청이 줄 서지 않게 했고, 답이 도착했을 때 이미 기체로 돌아갔으면 칠하지 않는다.
- 검증: 신규 `test_terminal_board.py` 19 PASS, `test_scenario_session.py`에 실제 하루를 띄워 데크 답이 자기 board를 들고 나오는지 확인하는 시험 추가(27 PASS). 신규 `terminal_life.test.mjs` 12 PASS, `deck_walk` 14 PASS(갱신 주기/느린 응답/탑승 후 도착 응답 4건 추가). 전체 Node 2288/2301, 전체 Python 2032 PASS/38 FAIL — 둘 다 실패 집합이 2·3단계와 파일별로 완전히 동일하다. 아키텍처 PASS.
- 화면 확인(내장 브라우저, 여의도): 판에 `여의도`와 `07:30`, 그 아래 `07:21 F87 ← 상암 G1 도착`부터 `08:08 F59 → 수서 G6 예정`까지 9행이 시간순으로 칠해지고 지연은 붉게, 탑승은 초록으로 나온다. G4 라운지에는 board가 말한 그대로 6명이 `G4 탑승 대기` 표지와 `G4 ↑` 계단 밑에 서 있다. 몸 모델 40개가 모두 올라왔다(실패 0).
- **실행 중 서버는 여전히 이 변경 전 Python이다.** 화면 확인은 같은 데크 기하로 로컬에서 만든 평면과, 서버가 보낼 모양 그대로의 board를 주입해서 했다. 사용자가 재시작해야 실제 페이지에 나온다. 시나리오를 불러오지 않은 서버에서는 판이 "예정된 운항이 없습니다"가 된다.
- 남은 것: 사람은 2.5초마다 다시 놓일 뿐 걷지 않는다(도착 승객이 빠져나가는 보행도 없다). 실내 소리도 없다. 터미널 둘레가 외장 클래딩 안쪽 3 m인 것도 그대로라 유리 너머는 여전히 클래딩 뒷면이다.

## 2026-09-22 버티포트 실내 3단계: 층 배치(입구·보안검색·라운지·상점·시간표 자리·좌석)

- 새 모듈 `digital_twin/model_library/terminal_plan.py`. 평면은 층 외곽선, 이미 서 있는 계단, 건물 방위만으로 유도한다. 결정 하나가 나머지를 정했다: 게이트가 데크 전체에 퍼져 있으므로 계단도 바닥 전체에 퍼져 있고(실제 여의도는 182x128 m 바닥을 가로질러 (-75,31)~(39,-58)), 바닥을 가로지르는 검색선을 그으면 일부 게이트가 landside로 떨어진다. 그래서 보안검색은 **들어오는 자리**에 둔다 — 1층 로비에서 올라오는 승강장 + 입구 홀, 그 안쪽에 검색 레인, 그 너머는 전부 airside(게이트·상점·식당 포함). 실제 터미널도 리테일이 검색 뒤에 있으면 이 배치다.
- 모든 항목은 회전값이 아니라 **네 꼭짓점 링**으로 내보낸다. 사각형+회전은 틀릴 곳이 둘이고 그중 하나는 눈에 안 보인다. 같은 링이 그려지는 것이자 걸어서 막히는 것이자 시험되는 것이다.
- 배치는 거절 방식이다(제자리에 놓아 보고, 차 있으면 옮긴다). 겹침은 분리축(SAT)으로 판정한다. 라운지는 자기 계단 옆에, 상점은 둘레를 따라 걸은 거리로 고르게, 벤치는 바닥 자체의 격자 위에.
- 실측으로 잡은 결함 두 가지. (1) 처음에는 라운지를 상점과 같은 여유(4 m)로 계단에서 떼어 놨더니 **모든 라운지가 자기 계단 때문에 거절**돼 8게이트 중 2~6개만 생겼다. 계단 여유를 두 겹으로 나눴다: 상점은 멀찍이, 라운지는 자기 계단에 붙여서. (2) 합성 기하 7종은 전부 통과했는데 **실제 저장된 여의도에서는 평면 자체가 만들어지지 않았다** — 정문 벽 한가운데에서 12 m 떨어진 곳에 계단이 서 있어 홀을 뒤로 미는 시도가 전부 막혔다. 벽을 따라 옆으로도 미끄러뜨리고, 안 되면 작은 홀로 줄이게 고쳤다.
- `terminal_fitout.js`(신규)가 그린다. 상점은 닫힌 상자가 아니라 세 면 벽 + 유리 정면 + 업종 색 간판띠 + 이름표이며, 정면은 평면이 말하는 `facing_m` 과 맞는 모서리를 골라 그린다. 라운지/벤치는 좌석 상판까지, 검색 레인과 벽, 승강장, 시간표 패널(내용은 4단계). 간판은 폴리라인/라벨과 같은 무광원이라 새벽 4시에도 읽힌다.
- `walk_camera.js`에 `blockedAt`과 world의 `blocks`를 더했다. 막힌 곳은 데크 가장자리와 **같은 방식으로** 거절한다(이동을 통째로 취소). 층이 달라도 같은 경위도이므로 블록은 층을 들고 다니며, 계단 위에 무엇이 그려져 있어도 계단은 막히지 않는다 — 층 사이의 유일한 통로다. `walkWorld()`가 `blocks_m`을 세계 좌표로 내보낸다.
- 검증: 신규 `test_terminal_plan.py` 18 PASS(6개 방위 x 2) + 기존 터미널 8 PASS. 신규 `terminal_fitout.test.mjs` 7 PASS, `walk_camera` 16 PASS(막힘 4건 추가). 전체 Node 2272/2285, 실패 13건은 2단계와 같은 기존 집합. 전체 Python 2012 PASS/38 FAIL이며 파일별 분포가 2단계 기준선과 완전히 동일하다(test_flight_plan 13 = visual_selection 기존). 아키텍처 검사 PASS.
- 실제 저장된 19개 버티포트 전부에 대해 평면을 생성해 확인: 게이트 수만큼 라운지(4~12/4~12), 상점 6~18개, 레인 2~3, 블록 19~69개, 모든 항목이 바닥 안에 있고 서로 겹치지 않으며 계단 위에 놓인 것이 없다. 문제 있는 포트 0개.
- 화면 확인(내장 브라우저, 여의도): 천장을 걷어 위에서 보면 마트/상점/카페/식당/화장실이 벽을 따라, 입구 홀과 보안 검색과 운항 시간표가 정문 쪽에, `G3 탑승 대기` 같은 라운지 표지와 `G8 ↑` 계단 표지가 각 계단 옆에 있다. 눈높이에서는 천장 조명선, 멀리 유리 외벽, 게이트 표지, 간판띠가 실내로 읽힌다.
- **실행 중 서버는 이 변경 전 Python이라 `layout.terminal.plan`을 아직 내보내지 않는다.** 화면 확인은 같은 데크 기하로 로컬에서 평면을 만들어 페이지에 주입해서 했다. 사용자가 서버를 재시작해야 실제 페이지에 나온다.
- 남은 것: 4단계(시간표 내용과 사람·직원을 운항 계획에서 끌어오기)는 미착수라 시간표 패널은 비어 있다. 터미널 둘레가 외장 클래딩 안쪽 3 m인 것도 그대로여서 유리 너머는 클래딩 뒷면이다.

## 2026-09-22 극한 최적화 4차: 외부 카메라 장면 공유·라벨 가림 읽기 분리·서버 핫패스 정확 절감

- 사용자 요청: EXTERNAL VISION을 켜면 더 끊기고 기체 모양·주변이 맞지 않음("왜 다시 그리고 재사용하지 못하나"), 부하가 틱을 방해하지 말 것, 지상 이동→비행→착륙→주변 전환의 틱/fps/계산 밀림을 항목별로 극한 최적화, 기체 데이터 생성부 포함.
- 외부 카메라(digital_twin/visualization/web/shared_view_camera.js, cockpit_view.js changeExternalCamera): 두 번째 CesiumWidget(별도 WebGL 컨텍스트라 타일·GLB·프로그램을 전부 다시 로딩)을 버리고 지도의 장면을 렌즈 자세로 한 번 더 그려 픽셀만 복사한다. 그 렌더 동안 장면 이벤트(_preUpdate/_postUpdate/_preRender/_postRender)와 camera._changed를 잠그고 자세·fov·near·transform을 되돌리며, 배 아래(DOWN)에서만 자기 기체를 숨긴다. postRender에서 다음 rAF(Cesium 렌더보다 앞)로 예약하고 지도 프레임 비용+카메라 비용+1.5 ms가 프레임 예산(globe.timing p50)에 들어갈 때만 그리되 1.5 s 상한으로 정지하지는 않는다. 회귀시험 7건(shared_view_camera.test.mjs).
- 내장 브라우저에서 실제 Cesium 장면(V-World 영상·건물·하강 중 UAM0003 모델)으로 확인: DOWN/FRONT/TOP 세 모드 모두 이미지 생성, 되돌린 카메라 차이 첫 렌더 9e-16(setView 정규화 1 ulp) 이후 0, 렌더 중 장면 리스너 호출 0회, 자기 기체 표시 복원. 추가 렌더 비용은 타일이 있을 때 DOWN 5 ms·FRONT 28 ms, 새 자세 첫 프레임 40~330 ms(타일·셰이더). 실제 조종 화면의 fps 변화는 미측정.
- 라벨 가림 판정(whole_label_occlusion.js schedule, entity_scene.js): scene.pickPosition(readPixels = GPU 파이프라인 드레인, 9/19 실측 프레임당 9~13 ms·최대 80 ms)을 postRender 작업 안에서 하지 않고 다음 매크로태스크에서 한다. 프레임이 컴포지터로 넘어간 뒤 유휴 구간에서 기다리므로 렌더 태스크 길이에서 빠진다. 조작 중 즉시 증거를 버리는 동작과 150 ms/10 Hz 페이싱은 그대로. 회귀시험 4건 추가. 실제 기기 측정은 없음(추론 기반).
- 전환 구간 매 프레임 작업 절감(그리는 결과 동일): 승객 탑승/문(globe.js) Map 2개·정규식·좌석 계산을 모델이 준비된 기체에만, 색인은 응답이 바뀔 때만; 데크 등(deck_lights.js) 램프마다 Color 할당 → 스크래치 1개; 예측 경로 follow(trajectory_layer.js) 매 프레임 JSON.stringify → 값 비교; 수동 턴어라운드(manual_turnaround.js) 문 행렬·스탠드 Cartesian을 바뀔 때만; 비행 항적(flight_track_layer.js) 3초마다 900점 전부 재변환 → 같은 참조면이면 이미 변환한 앞부분 재사용(회귀시험 3건).
- 서버 핫패스 4곳, 결과 비트 단위 동일(project_support/tests/web_live/test_tick_hot_paths.py: 옛 함수 사본과 무작위 4,000/3,000건+경계값 비교): holding_queue.transfer_clear 삼각부등식 broad phase(1 mm 여유; 틱의 20%였음), ground_motion.advance 노트 스캔 조기 종료(2a(mark-distance) ≥ bound), terminal_reservations.blockers를 클레임 변경(acquire/release) 전까지 기억, VertiportResourceMonitor.occupants/reservations를 (종류, 시각)별로 기억(ingest/advance/clear가 비움; 보고서는 불변 스냅샷). 같은 날 앞서: 물리 풀 작업 묶음(ScenarioPilots.submit_many/_NativeSlot), 기록자 쓰기 스레드(ScenarioRecorder._submit, 카운터는 접수 시점, finish/close 대기) — test_tick_offload.py 4건.
- 오프라인 tick 벤치(같은 3,765편 하루, 06:45 48대 비행, 150 tick): 평균/p50/p90 699/645/882(세션 시작) → 470/458/531(스케줄링 캐시) → 443/407/506 ms, 지문 bf29f391a660d208 동일(상태+이벤트 해시, 세션 시작 이후 모든 변경에 걸쳐). transfer_clear 누적 11.7→5.8 s, ground_motion.advance는 상위 목록에서 빠짐. 이번 벤치는 Node 스위트와 겹쳐 BelowNormal로 돌아 max 1,910 ms 등 잡음이 있음. 남은 큰 몫: _refresh_predictions 34 ms/step, _queue_instruction·holding_queue.retarget(Codex 진행 중 큐 랭크), _ground_permissions 22 ms/step, occupied_intervals 9 s/150 tick.
- 실제 서버(04:31 재시작본 = 묶음·기록자 스레드·스케줄링 캐시 포함, 핫패스 절감 미포함) 하루 재생 06:45 48대 비행, 조종 없음: /api/health p50 37.5 ms·p90 102·p95 111·p99 146·max 291(551 샘플, 100 ms 초과 62건·200 ms 초과 2건). 이전 측정(42대 비행+사용자 조종 중) p50 61·p95 189·max 454와는 조건이 달라 직접 비교는 아님. 핫패스 절감분은 04:58 이후 재시작본부터. 그 재시작본(핫패스 4곳 포함)에서 같은 조건(06:45, 48대 비행, 페이지 없음)으로 다시 재면 p50 32.9 ms·p90 75.7·p95 84.3·p99 121.5·max 297(630 샘플, 100 ms 초과 11건·200 ms 초과 3건): p95 111→84 ms, 100 ms 초과 비율 11.3%→1.7%.
- 검증: Node 전체 2274 중 2261 PASS, 실패 13건은 아침과 같은 기존 집합(신규 10건 포함 PASS). Python 새 시험 6+4+4건 PASS, 관련 14파일 157 PASS/2 FAIL(test_ground_operations 2건 기존). 전체 Python 최종 1994 PASS/38 FAIL/57 SKIP(모든 변경 적용 후 재실행; 앞선 04:29 실행 1987/39와 견줘 새 실패 0건, test_entry_forecast_parallel 1건만 회복) — 38건은 Codex 최근 기록(HISTORY "전체 Python 1988 PASS/38 FAIL 전부 기존")과 같은 기존 집합으로 판단(PSU/FATO 큐 랭크 작업 중인 test_paused_queue_claims·test_ground_operations·test_multi_flight_native·test_predictive_operations·test_fato_resource_utilization, test_right_lane_guidance, test_satellite_view_scope, Codex의 contact_heights가 든 test_manual_heartbeat_pose, node 하위 프로세스가 없는 test_manual_altitude_datum, test_flight_plan 13건), test_entry_forecast_parallel은 부하 중 타이밍으로 재실행 PASS; test_physical_fleet 1건은 조용한 상태에서도 준비 대기 1.5 s 안에 fleet 엔진이 뜨지 않아 실패(status error None, 호스트 타이밍). 이 세션의 엔진 메모(_ground_observations·_ground_review_stamp)를 끄고 PSU 관련 8건을 재실행해도 같은 실패라 캐시 원인이 아님.
- 함정: 패치 스크립트의 skip_if 마커가 앞 블록이 넣은 문자열과 겹쳐 두 블록이 조용히 건너뛰어짐(BROAD_PHASE_MARGIN_M 미정의·acquire/release 무효화 누락 → 18건 실패 후 수정, 각 블록 고유 마커로). Codex 편집 중 vertiport_layout.py의 일시적 NameError(_thick)로 test_scenario_engine을 import하는 모듈 전부가 1분쯤 수집 실패.
- 하지 않은 것: 조종석 project()의 getBoundingClientRect 2회/프레임 캐싱, deck_detail 2초 DOM 재구성, 충전 케이블 Primitive 동기 생성(비용 작음), 수동 전송 워커. 실제 조종 화면 fps·끊김 개선 폭 미측정(Chrome 확장 미연결, 내장 브라우저는 rAF 없음).

## 2026-09-22 버티포트 실내 2단계: 데크 아래 터미널 층의 평면·보행·외피

- 설계 근거: 실제 데크는 188x134 m급 다이아몬드라 데크 위에 건물을 세울 빈 구역이 없다. 터미널은 데크 바로 아래 층이고 평면은 플랫폼 폴리곤 자체이며, 충전기 옆 2.6x3.6 m 구조물이 계단실이다. 건물 저층부(vertiport_base.js의 podium/entranceOf)는 그대로 가로 로비이고 이번 층은 그 위 출발층으로 서로 다른 층이다.
- vertiport_layout.py: `_inset_convex`(변마다 내부 법선으로 정확히 오프셋; 중심으로 축소하면 188x134에서 장변만 과하게 들어가 틀린다), `_ring_contains`, `_terminal`. `platform.height_m`는 슬래브 두께가 아니라 지면 위 높이이므로 바닥은 데크에서 4.6 m 아래이고 남는 15.4 m는 공중이다(이 부분을 두께로 읽어 처음에 바닥을 지하 34.6 m에 놓았다). 5.2 m 미만 데크는 `terminal` 키 자체를 내보내지 않는다. 계단 착지점은 계단실 footprint 밖으로 양쪽 모두 밀어 되돌림 순환을 막는다.
- walk_camera.js: 층(level)과 층간 링크. 같은 경위도가 두 층에 동시에 속하므로 어느 층인지는 점이 아니라 사람의 상태다. vertiport_layer.js `walkWorld()`가 데크(level 0), 터미널(level -1), 계단 링크(내려가기/올라오기)를 함께 준다.
- terminal_shell.js(신규): 바닥·천장·유리 둘레·코브·천장등·계단실·게이트 표지. 파트 id는 레이어 관례대로 `vertiport:<id>:terminal:<part>`다. `VertiportLayer.showTerminal(id, on)`은 거리로 켜지 않고 조종사가 데크에 내린 순간 세운다 — 데크에 가려 밖에서는 보이지 않으므로 거리 기준은 아무도 못 보는 기하에 값을 치르는 셈이고, 계단을 걸어 들어가는 순간이 아니라 서 있는 순간에 짓는 편이 낫다. deck_walk.js가 층 변경을 안내 문구로 알린다.
- Cesium 엔티티 폴리곤은 faceforward로 태양광 음영을 받아 아래를 향한 천장은 어떤 색을 줘도 거의 검게 렌더된다(#1b262c를 #aeb9c0으로 바꿔도 화면 변화 없음을 실측). 폴리라인은 무광원이므로 조명을 선으로 그린다: `lampRuns()`가 가장 긴 벽 방향으로 줄을 놓고(북쪽 기준이면 돌아간 방을 가로지른다) `clipToRing()`이 유리에서 끊는다. 실제 터미널 천장을 아래에서 본 모습도 어두운 슬래브에 밝은 선이다.
- 검증(명령/결과): `pytest project_support/tests/web_live/test_vertiport_terminal.py -q` 8 PASS(신규). `node --test .../browser/{terminal_shell,deck_walk,walk_camera,vertiport}.test.mjs` 109 PASS(신규 14+10 포함). 전체 Node 브라우저 스위트 2267 중 2254 PASS, 실패 13건은 기존 집합과 같다 — app.js의 새 한 줄만 빼고 같은 10개 파일을 돌려 92/80/12로 동일함을 확인했으므로 이번 변경 탓이 아니다. 전체 Python web_live 1988 PASS / 38 FAIL(test_flight_plan 13건은 visual_selection 기존 기준선, 나머지도 버티포트·터미널과 무관하다. `layout["terminal"]`을 읽는 곳은 표시 코드 두 곳뿐이고 시뮬레이션은 읽지 않는다).
- 실측(내장 브라우저, 여의도 VP001): 데크 79.91 m, 터미널 바닥 75.31 m, 계단 8개. 실제 기하로 걷혀 8개 계단 전부 데크에서 3초(4.2 m) 걸으면 아래층 75.31 m에 도착하고, 8개 전부 다시 데크로 올라온다. 어떤 착지점도 자기 계단실 안에 있지 않다(되돌림 순환 없음). 데크 위 화면은 종전과 같고 실내가 새어 보이지 않는다.
- 남은 것과 위험: 실내는 아직 외피뿐이다(3단계 라운지·보안검색·상점·좌석, 4단계 시간표와 사람은 미착수). 터미널 둘레가 외장 클래딩 안쪽 3 m라 유리 너머로 보이는 것은 클래딩 뒷면이며, 그 층만 유리 띠로 뚫는 일은 하지 않았다. 실행 중 서버는 정적 JS를 no-cache로 내보내 새로고침하면 적용되지만, 사용자 화면에서 직접 확인하지는 않았다.

## 2026-09-22 초기 화면 0% 모듈 로딩 실패 복구

- 실제 Chrome 콘솔의 startup failed 및 HTTP 의존성 조회로 원인을 특정했다. deck_walk.js가 저장소 상대 경로로 walk_camera.js를 import해 브라우저에서는 /digital_twin/visualization/web/walk_camera.js 요청이 되어404였다. 서버 health는 ready였으며 앞선 Python 고도 변환 오류는 아니었다.
- import를 실제 정적 mount /visualization/walk_camera.js로 수정. Node 전용 시험은 해당 웹 주소를 file URL로 치환해 로드하며 production import가 웹 mount를 사용하는지도 검증한다. 걷기 동작/서버 상태 변경 없음.
- 검증: deck_walk 및 walk_camera19 PASS, JS syntax PASS. 수정 후 실제 서버의 앱 의존성217개 HTTP 오류0. Chrome의 다시 시도 버튼을 눌러0% 모듈 오류 통과 확인. 이후85%에서 초기 지도 준비30초 timeout이 발생했다. 캐시가 확보된 뒤 한 번 재시도했으나 최종 관찰도85% 타일 수신 중이므로 전체 화면 복구는 미완료다. 서버 재시작 없음, 비행계획 idle/loaded=false.

## 2026-09-22 수동 접촉 고도와 항적의 중복 데크 보정 수정

- 사용자 제공 분석을 코드로 재검토: 수동 EntityScene.refreshPosition은 socket 고도를 그대로 사용하나 _share가 같은 고도를 자동 운항 엔진에 그대로 게시하고 track은 서버 deck surface_reference로 다시 보정했다. 사용자가 제시한 VP005 수치는 이번 세션에서 다시 수집한 수치가 아니며, 현재 서버는 idle/loaded=false라 같은 상황을 실측 재현하지 못했다. proximity는 두 기체 모두 지상이면 제외하므로 두 주기 기체가 곧바로 위험쌍 기록된다는 주장은 구분한다.
- native 원점/접촉/조종석 표시/원본 기록은 유지. 검증된 contact_decks의 높이를 내부 manual mailbox에 전달하고 manual_takeover.place에서 fleet datum으로 변환한다. 새 manual_altitude는 deckSurfaceOffset의 역변환이며 데크 근처에서만 작동하고 순항/원거리 고도는 유지한다. 위치와 예측 NED 수직 속도를 같은 기준으로 변환. 항적과 거리 기록은 공통 기준 사용. 기존 높이 메타데이터 없는 호출과 자동 운항은 불변.
- 검증: Python 관련10파일77 PASS; 실제 JS 전방향 함수와84가지 고도/거리 역변환 조합 오차1e-7m 이내. native sample 불변, 항적 일치, proximity 수직차3cm, 출도착/후속편, 순항 불변, 속도 변환 확인. ADR0116에 내부 계약 및 한계 기록.
- 사용자가 서버 재시작/비행 초기화를 승인. 실행 직전 /api/simulation/scenario는 idle/loaded=false였으나 표준 launcher --restart --no-browser를 Hidden으로 시작하는 명령 자체가 도구 정책으로 차단돼 실행되지 않았다. 우회 종료하지 않고 사용자에게 평소 방법의 재시작을 요청했다. 현재 실행 서버 적용 및 실제 화면 재검증 미완료. 기존 혼합 기준 항적/과거 위험 기록은 재작성하지 않으며 새 비행부터 사용한다. 세션 도중 지형 소스를 바꾸는 문제와 서버 DEM 데이터 부재 자체는 이 변경으로 해결했다고 주장하지 않는다.

## 2026-09-22 스케줄링 계산 효율: tick 출발 검토 캐시와 항로 구성 메모

- 대상 확인: 하루 생성(`/api/simulation/plans/multi`)의 단계별 시간은 수요 0.08 s·항로 계산 6.0 s·기체 배정 0.42 s·정리 0.25 s·초기화 9.0 s·기체 예측 준비 36.2 s(3,765편, 서버 status 기준). 수요·배정 알고리즘은 이미 빠르다. 느린 곳은 재생 중 매 tick 도는 출발 스케줄링(FATO 배정 검토)과 계획 적용의 초기화·예측 준비다. 전자는 tick이 GIL을 쥐는 시간이라 조종 밀림과 직결된다(재생 중 `/api/health` p50 61 ms·p95 189 ms·max 454 ms, 42대 비행 중).
- 오프라인 벤치(scratchpad tick_bench.py): 앱과 같은 방식으로 세션을 만들고 생성된 3,765편 CSV를 불러 x10으로 06:45(48대 비행·53편 활성)까지 진행한 뒤 150 tick을 cProfile로 잰다. 상태·이벤트 지문(bf29f391a660d208, 13,087건, problems 0)이 세 실행 모두 동일해 동작이 보존됐다. 프로파일러 오버헤드·사용자 서버와의 동시 실행이 포함된 상대 비교다.
- tick 평균/p50/p90: 699/645/882 ms → 1차 캐시 556/520/622 → 2차 캐시 470/458/531 ms(평균 -33%, p90 -40%). `_maybe_depart` 42.1 → 12.8 s, `fato_assignment.options` 호출 8,148 → 1,789, `_departure_ground_proposals` 16,179 → 3,091, `occupied_intervals` 234,827 → 69,625회.
- scenario_engine.py: `_ground_observations`를 기체 상태 스탬프(식별자·airborne·phase·버티포트·편·위치)가 같은 동안 재사용(호출마다 새 리스트). `_departure_options`가 출발 FATO 대안 검토를 (그 데크의 관측, 지상관제 `review_stamp`)가 바뀔 때만 다시 계산하고 `_assignment_stamps`에 검토 종료 시점 스탬프를 보관. 첫 검토가 택시 그래프를 구성해도 두 번째 검토를 강제하지 않는다. 지상관제 없는 엔진은 이전과 같이 한 번만 계산한다.
- ground_control.py: `_candidate_paths` 결과를 (버티포트·출발·도착·개수)별 `_candidate_cache`에 보관, `configure_vertiport`·`reset`에서 폐기. `review_stamp(vertiport)`가 구성 횟수와 그 데크의 클레임(기체·route_id·반경·start/end)을 준다. fato_assignment.py는 네트워크 링크 집합을 엔진당 한 번 만든다. scenario_session.py `_surface_reference`는 프레임 위도·경도·cos를 하루당 한 번 읽는다.
- 적용 단계: flight_plan.py `air_graph`가 네트워크 객체당 한 번 구성하고 places/ground 표는 복사본으로 넘긴다(`scheduled_route.resolve`가 임시 노드를 추가하므로). ground_motion.py `prepare`가 (경로·속도·hold)당 한 번 계산하고 경로·프로파일(리스트 포함)을 복사해 넘긴다(`align_start`·`prepare_pushback`가 쓰기). 적용 프로파일에서 항로 구성 639개가 10.8 s(`build_plan` 8.9 s, `_ground_leg` 4.1 s, `air_graph` 727회 1.3 s)였다.
- 검증: 회귀시험 6건 추가(후보 경로 캐시, 관측 스탬프, 링크 집합, 검토 스탬프, 항로 그래프 격리, 택시 프로파일 격리). 관련 Python 23파일 340 PASS / 8 SKIP / 13 FAIL이며 실패 13건은 전부 test_flight_plan의 visual_selection 기존 실패(9/18 기준선과 동일). 적용 단계 재프로파일: 항로 구성 639개 10.8 → 9.1 s(`build_plan` 8.9 → 7.1, `_ground_leg` 4.1 → 2.3, `scheduled_route.resolve` 1.6 → 0.25 s, `air_graph` 재구성 소멸); 적용 50.5 s 중 예측 준비 40 s는 그대로다.
- 실행 중 서버는 03:32 재시작본이라 이 변경 전 코드다. 다음 재시작부터 적용되며, 벤치 스크립트는 세션 scratchpad의 tick_bench.py(생성된 CSV 필요)로 재현한다.
- 손대지 않은 것: 기체 예측 준비 36 s는 고유 (항로, 방위)마다의 네이티브 리허설로 본질 비용이며, 재사용하려면 디스크 캐시(항로 기하·방위·튜닝·DLL 버전 키)가 필요하다. 대기열 기하 검사 `_queue_transfer_clear`(tick의 ~15-20%)는 호출 반복률이 낮아 캐시 이득이 작다. 기록기 `track`(1 s 간격, 호출당 ~38 ms, 근접 기록 O(n²))도 그대로다.

## 2026-09-22 간헐적 밀림: 지연 응답의 되감김 제거와 조종 소켓 무홉 처리

- 사용자 보고: 앞선 수정 뒤 많이 좋아졌지만 간헐적으로 밀림. 어제 소켓 기록을 메시지 단위로 다시 보니 하루 재생 중 응답 간격의 5~8%가 180~357 ms(tick 길이)이고, 그 메시지가 실은 보통의 120~135 ms 비행시간만 담고 있으며 다음 응답이 곧바로 뒤따랐다. 즉 시뮬레이션이 멈춘 게 아니라 응답 전달이 tick 뒤로 밀린 것이다. 화면은 그 사이 예측 지평까지 달린 뒤 늦은 샘플 시각으로 되돌아갔다가(뒤로 튐) 다시 앞으로 나갔다.
- manual_flight_display.js: 표시 시각을 단조 증가로 고정해 늦은 샘플이 자세를 뒤로 끌지 못하게 하고(샘플이 따라올 때까지 한두 프레임 정지), 예측 지평을 평균 간격의 2배(0.08~0.30 s)로 늘려 p95 지연과 대부분의 tick 길이 지연을 정지 없이 덮는다. 새 회귀시험: 230 ms 늦게 함께 도착하는 두 응답에서 뒤로 가는 프레임 0, 정지 ≤ 6프레임(10 ms 단위). 기존 9건 모두 PASS.
- manual_routes.py: 메시지마다 `run_in_threadpool(advance)`로 넘기던 물리 스텝을 이벤트 루프에서 직접 실행한다. 작업은 native 스텝·run log 한 줄·mailbox 게시·캐시 읽기로 2 ms 미만이며 세션 락을 잡지 않는다. 홉마다 tick이 쥔 GIL을 기다리던 것이 메시지당 4회(수신 재개, worker 진입, native 호출 뒤 재획득, 루프 복귀)에서 2회로 준다. 수동 소켓·인계 pytest 9파일 72 PASS. **실행 중 서버에는 재시작 전까지 적용되지 않는다.**
- 확인한 주기: 하루 재생 중 `update_once`는 100 ms마다 `advance_view`(락+GIL, ~110 ms)를 돌리고 `/ws/live`는 새 스냅샷을 최대 10 Hz로 보낸다. 내장 브라우저에서 잰 `globe.replace`는 기체 115대 기준 p50 0.2 ms·max 3 ms라 지도 쪽 스냅샷 반영은 병목이 아니다. 현재 서버는 시나리오 `finished` 상태라 `/api/health` p99 6 ms로 조용하며, 재생 중 GIL 기아는 이번에 재현하지 못했다.
- 실패한 검증: interaction_stutter_check(headed)가 페이지 준비 대기 120 s에서 시간 초과(entry/loading 게이트 미도달, 사용자가 화면을 쓰는 중이라 창이 가려져 rAF가 멈춘 것으로 추정). Chrome 확장은 여전히 미연결이라 실제 조종 탭 계측은 못 했다.
- 전체 브라우저 스위트 2211/2224 PASS, 실패 13건은 이전과 동일한 기존 집합.
- 스냅샷 팬아웃 감사(app.js onSnapshot 경로 전부): 지도 쪽은 싸고, 선택 중인 기체가 있으면 매 스냅샷 `globe.replace → refreshDetails → onSelect → aircraftDashboard.show`가 하단 요약 띠에 60~100건의 무조건 DOM 쓰기(텍스트·속성·인라인 style, 타일 전부 숨겼다 다시 표시)를 하고 있었다. 조종석에서는 자기 기체가 항상 선택돼 있어 비행 내내 10 Hz로 돈다. aircraft_dashboard.js의 쓰기를 값이 바뀔 때만 하도록 바꾸고, 안 그린 타일만 뒤에서 숨기게 했다. 관련 시험 9 PASS, 대시보드·선택·표시·예산 관련 스위트 169/174(실패 5건 기존). 위험 레이더 창을 열어 두면 10 Hz로 SVG 전체를 다시 만드는 경로(risk_radar.js paintPlot)가 남아 있으니 비행 중에는 닫아 두는 편이 낫다.

## 2026-09-22 조종석 끊김: 샘플 예측 지평·해상도 고정·3D 타일 처리 예산

- 어제 23:46-23:55에 남은 조종 소켓 기록(data/workspace/frame_pacing_*.json)을 다시 계산했다. 재시작 뒤 서버는 sim/wall 1.00x를 지켰지만 상태 샘플은 초당 7.3-8.7회(간격 p50 108-127 ms, p95 165-194 ms, 최대 357 ms)였다. 화면 보간(manual_flight_display.js)은 최신 샘플 뒤 80 ms까지만 예측하므로 매 간격의 나머지 40-60 ms 동안 자세가 멈췄다가 다음 샘플에서 튀었다. 조종석 카메라가 이 자세에 붙어 있어 순항·선회 모두에서 초당 8회 밀림-정지가 보였다. 새 회귀시험(120 ms 실시간 전달)에서 수정 전 프레임당 전진량 최대/최소 비는 308이었다.
- 예측 지평을 관측된 샘플 간격의 1.5배(0.08-0.25 s)로 따라가게 했다. 20 Hz 정상 전달에서는 이전과 같은 80 ms 바닥이라 변화가 없고, 120 ms 간격에서는 비가 1.0으로 연속이 된다. 유실 패킷 예측은 여전히 간격 1.5배에서 멈춘다. 서버 조종 경로(manual_routes.py)는 손대지 않았다.
- 조종석에서는 해상도 사다리와 지형·건물 상세 낮춤을 모두 고정했다(render_budget.js `holdResolution`, globe.js frame). 이 화면은 메인스레드 병목이라(9/19 실측) 픽셀 감축이 효과가 없었고, 사다리 한 단계마다 프레임버퍼 전체가 재할당돼 선회 뒤마다 내려갈 때 1회·올라올 때 6회의 끊김이 났다. 기체 자세는 매 프레임 미세하게 변해 `moving`이 거의 항상 참이었다. 지도 화면의 사다리와 `moving` 기반 스트리밍 예산은 그대로다.
- 실제 설정은 건물 Cesium OSM 3D 타일셋·지형 World Terrain·영상 World Imagery(`/api/library/sources` values)라, 오늘 앞서 나눈 V-World 발자국 업로드와 로컬 DEM 분할은 이 경로에 걸리지 않는다. Cesium 1.143은 타일셋 처리 큐를 프레임당 예산 없이 전부 끝내므로(processTiles), 도시 위를 지날 때 여러 타일의 GPU 업로드·드로우 커맨드·특징별 스타일 평가가 한 프레임에 몰렸다. `Cesium3DTile.prototype.process`를 감싸 프레임당 3 ms 예산(첫 호출은 항상 수행)으로 나누는 tile_processing_budget.js를 추가하고 globe 생성 시 적용했다. 로드 순서·상세·데이터는 동일하고 끝나는 프레임만 나뉜다. 엔진 확인: CPU 스타일 단계가 커스텀 셰이더 뒤에 있어 높이별 색은 살아 있는 작업이라 제거하지 않았다.
- 검증: 회귀시험 추가(manual_flight_display 1건, render_budget 1건, tile_processing_budget 5건) 및 관련 12파일 129/130 PASS(실패 1건은 manual_flight_transport의 서버 파일 경로 시험으로 기존 실패). 전체 브라우저 스위트 2210/2223 PASS, 실패 13건은 app.js 연결·livery·레일·occupancy 등 기존 집합. 실행 서버가 변경 JS 4개를 HTTP 200/no-cache로 제공하고, 내장 브라우저에서 진단 페이지 부팅에 콘솔 오류 없음·실제 Cesium 1.143에서 패치 적용(`aerodtTileBudget`)·표시 지평 0.18 s를 확인했다.
- 한계: 실제 조종 화면의 FPS·끊김 개선 폭은 미측정(Chrome 확장 미연결, 현재 시나리오 `finished`로 수동 비행 없음). 새로고침해야 적용된다. 외부 기체 카메라(DOWN)는 켜져 있으면 두 번째 Cesium 장면을 200-1500 ms마다 동기 렌더해 그 자체가 주기적 끊김이 될 수 있어 A/B용으로 꺼 보길 권한다. 기반시설 페이드의 10 Hz 절감은 기존 시험이 이동 카메라의 30 Hz 추종을 고정하고 있어 보류했다.

## 2026-09-22 추가 프레임 비용 점검 및 로딩 직렬화

- 실제 코드에서 EntityScene warmQueue가 loadWarmAsset promise를 버려 사전 로딩을 동시에 시작하는 결함을 확인하고 수정했다. 파일 로딩뿐 아니라 GPU ready와250ms 준비 구간이 끝나야 다음 자산을 시작한다. 오류/10초 GPU 준비 timeout/장면 폐기 때 listener, timer, 임시 모델 및 대기를 정리한다.
- 선택 기체의 궤적은 매 프레임 전체 최대900점 기록을 다시 dirty 처리하던 경로를 제거했다. 고정 기록과 두 점짜리 움직이는 연결선을 별도 PolylineCollection에 보관하며 기록은 기존3초 조회 때만 갱신한다. 조종 위치와 선의 종점은 매 프레임 유지한다.
- LocalTerrainProvider의 DEM 경계4225점 동기 보간을 최대256 world-mesh 보간/2ms soft slice로 분할. 공용 post-paint FIFO가 한 프레임 기회에 한 continuation만 재개해 동시 응답의 CPU 집중을 줄인다. 전부 로컬 값인 타일은2ms 내 복사 가능하면 한 번에 완료하며 인위적인17프레임 지연을 주지 않는다. 높이/해상도/가중치/childmask/credit 및 기존 conditioned source 선택 보존. 취소 후 불필요한 fallback 방지.
- 검증: node --test project_support/tests/web_live/browser/{mission_paths,local_terrain,entity_scene,streaming_work,staged_primitive,vworld_layers,terrain_layer,airframe_camera_startup}.test.mjs 에 해당하는8개 파일182 PASS. 새로운 사전 로딩 직렬화·오류·timeout·폐기 시험, DEM 시간/개수 양보·높이 전체 일치·취소,60프레임 궤적 history 쓰기0회 확인. 변경JS4개 node --check PASS. Node에 rAF가 없는 시험 harness 초기1실패는 명시적 가짜 rAF로 수정 후 통과.
- 실행 서버8766에서 변경JS4개 HTTP200/no-cache 제공 확인. 서버 재시작이나 브라우저 새로고침은 수행하지 않았다. 현재 수동 비행 보호. 실제 화면 적용과 FPS 개선 폭은 미확인이고, 모든 끊김 해결/고정FPS 보장은 아니다. 경계 지형 완성 및 전체 사전 로딩 지연, 한 번의 보간/GL 작업 선점 불가 위험이 남는다. 승객 모델 pool 생성 등 추가 후보는 이 변경에 포함하지 않았다. ADR0115 추가 기록.

## 2026-09-22 지도 및 footprint 건물 스트리밍 작업 분할

- 사용자가 조종석 최적화 이후 개선을 확인했으나 지도/건물 로딩 시 끊김을 보고했다. 코드상 footprint CPU 양보 뒤에도 한 셀 전체를 단일 Primitive로 전달함을 확인. Cesium1.143 공식 Primitive의 createVertexArray가 worker 결과를 렌더 스레드에서 GPU로 업로드하고 QuadtreePrimitive endFrame의 지도/지형 큐가 기본5ms를 쓰는 점을 확인했다. 실제 GPU stall 원인별 시간비율 측정은 아니다.
- 건물은128 instance/4096 입력정점 단위로 준비하며 multipart cell은 StagedPrimitive가 layer 공용 frame gate를 통해 프레임당 미완료 chunk 하나만 진행한다. 이미 준비된 geometry 그리기는 매 프레임 유지. 기존 셀은 전체 대체 mesh 준비까지 유지. 취소/오류/폐기에서 chunk primitive를 해제한다. 단일 polygon/holes는 손상 방지를 위해 분해하지 않으므로 한도를 넘을 수 있다.
- 건물 응답 선별 및 geometry CPU 루프는2ms/작은개수 단위로 post-paint 양보, 정확한 terrain sample은96개씩 요청. 메인과 external camera의 지도/지형 큐 slice는 guarded _loadQueueTimeSlice1ms로 제한. 해상도, 최종geometry/quality/quota, 물리/입력전송 변경 없음. private Cesium1.143 호환 설정은 terrain_layer 단일 함수로 격리하고 ADR0115에 근거/한계를 기록했다.
- 검증: node --test project_support/tests/web_live/browser/staged_primitive.test.mjs project_support/tests/web_live/browser/vworld_layers.test.mjs project_support/tests/web_live/browser/terrain_layer.test.mjs project_support/tests/web_live/browser/airframe_camera_startup.test.mjs =>61 PASS. split upload 도입 후 기존 모의GPU 시험2건은 frame 진행이 없어 실패하여 실제 렌더프레임을 흉내 내도록 harness를 수정, 밀집 overview/closeup 총건물수와budget 조건은 유지했다. 새 시험은 frame gate, hidden GPU 준비, holes, 중단자원해제,96/96/58 terrain sample,원자교체를 포함한다. 변경 JS4개 syntax PASS. 전체시험/장시간 비행재생은 생략.
- 실제 Chrome 화면에서 사용자 수동 접근 및 DOWN 외부카메라ON 확인. 새로고침 승인 후 reload를 시도했으나 Chrome 연결이 사라져 호출 실패, 현재 도구에는 IAB만 연결됨. 서버 재시작/수동비행 reset 없음. 실행 중인 페이지에 새 코드가 적용됐다고 확인하지 못함. 변경 후 실제 프레임시간/FPS 미검증. 단일texture/shader/복잡polygon은 선점 불가능하며 신규 상세 로딩 지연과draw call 증가 가능성이 남는다.

## 2026-09-22 수동 도착 GATE 보고 판정 수정

- 실행 중 UAM0064/FPL000001에서 `GATE 도착 보고` 요청이 여러 번 정상 접수됐지만 서버가 매번 `도착 G8 중심에 정차한 뒤 보고하세요`로 거절한 기록을 확인했다. 버튼 클릭이나 통신 누락은 아니었다.
- FATO 도착에서 이미 제거했던 서로 다른 수직 datum 비교가 GATE 보고에 남아 있었다. 수동 Runtime의 렌더링 접촉 고도와 생성형 시설의 로컬 데크 높이는 직접 비교하지 않는다. 접지 상태, GATE 중심 수평 3m 이내, 0.15m/s 이하 정지를 보고 조건으로 사용한다.
- GATE 보고 버튼은 더 이상 무조건 활성화되지 않는다. 실제 보고 조건과 같은 판정을 사용하며, 미충족 시 중심까지 남은 거리, 접지 상태, 현재 속도를 구분해 안내한다.
- 검증: 수동 완료·절차·도착 권한 집중 시험 35 PASS, 수동 지상·배정·인계·세션 확대 시험 51 PASS, `py_compile` 및 변경 범위 `git diff --check` PASS. 실행 시나리오는 조회 직후 finished 상태가 되어 재시작하지 않았으며 다음 서버 시작부터 반영된다.

## 2026-09-22 순항 및 회전 중 조종석 표시 중복 처리 축소

- 현재 서버 PID38152를 재시작하지 않고 WS를 약7초 관찰: 58 sample, wall6.86388초/sim6.89806초, 수신 중앙117.48ms/최대162.25ms로 관찰 구간1x 유지. 서버 전체 상황을 정상으로 보증하는 측정은 아니다. 실제 Chrome 성능 UI는 목표30FPS, native3440x1384에서26FPS/p95 53ms. 건물 표시를 잠시 끈 뒤23FPS/p95 61ms였으나 시점과 표시 모델 수가 달라 통제된 A/B는 아니며 GPU 원인 배제로 해석하지 않는다. 건물 표시ON/설정닫기/집중모드ON으로 원상복구. 7초 nonblocking 서버 stack은 data/workspace/cruise_stacks_20260922.txt.
- CockpitView에서 기체와 함께 움직이는 눈/패널의 상대 투영을 재사용한다. 기체 순항 및 yaw만으로 매 프레임 ECEF 투영과 CSS matrix를 다시 만들지 않는다. 머리 시선, FOV/frustum, 화면 크기/위치, 기체scale, 패널geometry, 확대/좌석 전환 시 즉시 재계산하며 비강체/미지원 카메라는 기존 경로 유지. 페이드와 외부 카메라 갱신은 cache hit에도 유지. 동일 opacity/hidden/style 중복 쓰기 제거, 확대 패널 layout 읽기는 쓰기 전에 수행.
- PSU/지상 절차 텍스트를 기존 계기판과 같은100ms cadence로 합치고 입력 허용/요청pending/절차 변경은 즉시 반영. 동일 입력 설정 UI 중복쓰기를 생략하되 최신 input state 참조는 항상 갱신. 물리, 입력전송, 3D 조종간, 카메라 pose, 해상도 및 건물 품질 변경 없음.
- 최소 검증: node --test project_support/tests/web_live/browser/{cockpit_frame_cost,cockpit_view,cockpit_camera,cockpit_single,cockpit_ground_controls,cockpit_dock_controls}.test.mjs 에 해당하는6개 파일50 PASS. 합성120프레임 이동/회전에서 초기 투영 이후 추가투영/스타일쓰기0, 외부카메라120회 유지, 최종 직접 재투영과matrix 오차1e-5 미만. 이는 실제 FPS 개선 측정이 아니다. 요청에 따라 전체suite/장시간재생 생략.
- 적용: 사용자 명시 승인 후 실제 Chrome 탭 새로고침, UAM 선택 완료. 서버 재시작 없음. /static/domains/uam/cockpit/cockpit_view.js?v=20260921-psu-eta HTTP200/no-cache 및 새 최적화 코드 제공 확인, 페이지 error 로그 없음. 새로고침으로 이전 수동 비행은 종료. 수정 후 동일 순항 구간 FPS 비교는 아직 미검증, 모든 끊김 해결을 주장하지 않는다.

## 2026-09-21 yaw 시 footprint 건물 작업 재사용 및 프레임 양보

- 사용자 yaw 중 잔여 버벅임 개선 요청. VWorldBuildingLayer의 시야 이탈 즉시 CPU/GPU 작업 취소 경로를 확인했다. 새 작업은 여전히 현재 wanted에만 시작하며 이미 시작한 작업은 마지막 표시 요청부터 최대1200ms 유지한다. 재방문 시 같은 pendingPrimitive/지형 샘플링 작업을 재사용하고 화면 밖에서는 숨긴다. grace 만료/disable/terrain·cleared rebuild/destroy 및 기존 메모리 압력 eviction은 취소 유지.
- 회전 중 geometry CPU batch는 기존160개/4ms 대신80개/2ms로 양보하며 requestAnimationFrame 다음 task에 재개한다. 숨겨진 탭의 rAF 정지에는100ms fallback을 둔다. 단일 복잡한 폴리곤, Cesium worker 및 GPU 업로드를2ms로 보장하지 않는다. concurrent build/network 및 메모리 budget, 해상도, 물리·조종 입력 변경 없음. 임의360도 preload/더 큰 캐시를 추가하지 않았다.
- 수정 전 yaw 재방문/진행중 지형작업/CPU batch 시험3건 실패 재현. 관련71 PASS, node syntax 및 scoped diff-check PASS. 전체 browser2192건 중2179 PASS/13 FAIL이며 camera_startup_full.txt의 기존13 실패명과 동일. 새 post-paint 양보 시험 포함. data/workspace/yaw_building_full_tests.txt.
- 실제 Chrome yaw 구간 GPU/frame시간 비교는 아직 미실시. 현재 비행 보호를 위해 서버 재시작/페이지 reload 없음. 기존 pagehide close_control이 비행을 종료하므로 다음 사용자 새로고침부터 적용. footprint fallback 경로 최적화이며 native3D tiles/DEM/모델 최초 업로드까지 모든 회전 끊김을 해결했다는 의미가 아니다.


## 2026-09-21 서버 재시작 후 갱신 간격 검증

- 사용자 명시 승인 후 표준 launcher --restart --no-browser를 Hidden으로 실행, 새 서버 PID49912 기동 확인. 현재 원본3742편/115대 CSV와 status를 frame_pacing_plan.csv/frame_pacing_before_restart.json에 보존하고 동일 schedule_id 8a1986c8fa680e65로 재로드. 이전 실행 중 수동 상태는 승인 범위에서 초기화됐다. 브라우저 reload의 기존 pagehide close_control이 첫 재생을 종료하여, 이후 open_control로 다시 준비/재생했다. 그때의 live-clock 측정은 폐기했다.
- 운항 구간까지 임시10x 진행 후06:35:26에1x 복귀. 자동 시나리오 측정: 174스냅샷/실제19.9425초/시뮬레이션19.9763초, 갱신 중앙107.7ms/최대335.5ms. 수정 전43스냅샷/19.6322초/10.5초/최대1207.5ms 대비 개선 확인. data/workspace/frame_pacing_after.json 및 after_status.json. 두 구간은 같은 계획의 비슷한 시각이지만 현재 상태와 수동 인계까지 일치하는 결정론적 A/B는 아니다.
- 실제 Chrome 페이지 새로고침 후 UAM/Control Panel 표시, 저장된6인승 수동 요청에 의해 UAM0064 다시 인계되어 조종석 표시 확인. 사용자의 조이스틱 입력은 바꾸지 않았다. 수동 상태 추가12초 측정87스냅샷/벽11.8564초/sim11.7961초, 갱신 중앙126.4ms/최대356.7ms,1x 유지. 마지막 상태06:36:49 playing,공중27대,active42대,manual UAM0064. frame_pacing_after_manual*.json 보존.
- 변경 전후 수신 trace를 동일 DisplaySamples 등속 합성 재생(60Hz)에서 비교: warm5초 이후 정지23/909프레임→0/903, 표시100m/s 기준 후속 속도94.99~102.67m/s. 실제 GPU FPS 계측은 아니며 전체 상황의 끊김 해소를 주장하지 않는다. 화면 품질 및 표시 버퍼 알고리즘은 변경하지 않았다. 서버1x와 수동 화면을 유지하며 검증 수집 프로세스 모두 종료.


## 2026-09-21 수동 NAV ETA와 접근 순번 활성화 기준 통일

- 사용자 화면에서 NAV는 현재 지상속도만으로 `01:22`를 표시했지만 접근 순번 버튼은 감속·하강·수직착륙을 포함한 조종사 절차 ETA가 180초 이하일 때 활성화되어, 같은 화면에 서로 다른 도착시간 기준이 노출됐다. 실제 실행 기록상 버튼은 06:36:19에 조종사 절차 ETA 180초로 활성화됐으며 기능 소실은 아니었다.
- 수동 advisory의 timeline에 버튼 판단에 실제 사용한 `remaining_route_eta_s`, `arrival_request_lead_s`, `arrival_request_due`를 함께 제공한다. 수동 NAV는 이 값이 있으면 동일한 ETE와 ETA를 표시하고 `접근 순번 활성화와 동일한 남은 항로 ETA · 감속·하강 포함`이라고 출처를 명시한다. 구 서버에서는 기존 지상속도 추정으로 하위 호환한다.
- 기존 수동 Pilot 절차가 요청 시점을 판단하고 PSU가 요청 이후 배정하는 역할 경계는 유지한다. 계약은 `manual_pilot_procedure_v1.md`에 추가 기록했다.
- 검증: 수동 절차/남은 항로 19 PASS, 관련 수동 접근·대기·배정·세션 Python 41 PASS, NAV/알림/PSU 브라우저 25 PASS. 현재 실행 서버와 시나리오는 보존했으므로 Python 반영에는 서버 재시작, 브라우저 반영에는 새로고침이 필요하다.

## 2026-09-21 서버 갱신 불규칙 실측 및 FATO 후보 중복 계산 제거

- 사용자 화면 품질 하향에도 끊김 보고. 실행 서버를 재시작/초기화하지 않고 WS를 측정했다. 연속 sequence 43개, 수신 19.632초 동안 sim10.5초 진행(요청1x), 간격57ms~1208ms. data/workspace/frame_pacing_live.json. 동일 시각 trace를 DisplaySamples에 입력한 합성 등속 이동 재생에서 warm-up5초 이후909프레임 중23 정지 재현. 실제 브라우저 FPS 측정은 아니며 GPU 문제 전체 배제를 주장하지 않는다.
- py-spy nonblocking 30Hz/12초 서버 샘플링398건, _select_fatos/options 경로246건, scheduled_route.resolve95건, departure_ground_proposals77건. 표본 포함 비율이며 함수 독점 CPU 비율은 아니다. data/workspace/frame_pacing_stacks.txt. 진단 도구 py-spy는 project_support/environment/web_venv에만 설치, 배포 dependency 변경 없음.
- fato_assignment.options에서 기존 engine _supplied_routes의 정적 항로 해석을 재사용하고 한 호출 안에서는 출발 FATO별 지상 제안을 한 번만 조회한다. 도착 FATO 조합마다 같은 출발 경로를 재조회하지 않는다. 다음 호출에서는 점유/claim을 새로 조회하며 동적 판단 또는 허가를 캐시하지 않는다. 물리 적분과 규칙, 그래픽 품질 변경 없음.
- 신규 회귀2건 수정 전 실패 확인 후 통과. FATO/지상/출발 시간창/교착106 PASS, PSU/scenario/entry-meter39 PASS, 합145 PASS. 실제 ground controller를 사용하는 4x4 후보 fixture60회 비교에서 동일 결과 확인, 중앙값1.930ms→0.317ms. 이는 후보 함수 microbenchmark이며 전체 서버 개선율이 아니다. data/workspace/fato_candidate_benchmark.json.
- 실행 서버는 기존 코드를 계속 실행 중. 실제 변경 후 WS 및 Web 개선 미검증, 표시 버퍼 자체 수정 없음. 사용자에게 재시작 여부 질문했으며 승인 전 현재 비행을 유지한다. 전체 끊김 해결로 완료 처리하지 않는다.


## 2026-09-21 FATO 보호의 겸용 전용 범위 정정

- 사용자 VP002 화면의 UAM0084/0085/0002를 GET 확인: 모두 이륙 FATO 보호 0/1로 대기. 실제 배치 F1/F3 takeoff, F2/F4 landing이며 간격34.1/48.22m. 앞선 2→1 보정만으로 해결되지 않았다. 관측 보존 landing_empty_four_fato.json, vp002_layout_evidence.json.
- 사용자 명시 기준에 따라 보호 규칙은 착륙 대상 역할이 both일 때만 적용하며 분모도 both로 제한한다. 전용 착륙은 혼합 배치에서도 즉시 이 보호 규칙 대상에서 제외. 전용 이륙은 PSU quota 분모에서도 제거한다. 물리 점유/인접 충돌/시간 간격은 별도 유지. 겸용 compact 배치에서는 불가능한 동시 용량 보존 대신 순차 운항으로 제한한다.
- 검증 54 PASS: 실제 VP002 좌표, 전용 역할 분리, 혼합배치 전용착륙, 겸용 보호와 시간창 회귀. diff-check PASS. 서버 재시작 및 재실행 없음. 현재 서버에는 이전 규칙이 남아 있으므로 기존 화면 대기는 이 변경만으로 즉시 사라지지 않는다. 전체 착륙 해결 또는 세 기체 접지는 아직 확인되지 않았다.


## 2026-09-21 VP013 실제 착륙 교착 진단 및 재실행

- 실행 서버에서 UAM0009/FPL000003, UAM0001/FPL000001, UAM0058/FPL000016 모두 `이륙 FATO 보호 대기 · 1/2개만 유지`로 막힘을 확인했다. 원본 상태는 data/workspace/landing_blockers_20260921.json, 정책은 landing_policy_before.json에 보존했다. 전용 이륙 FATO 2개 모두를 보존하는 floor가 인접한 착륙 전용 FATO 전체를 금지했다.
- dedicated 개수 floor를 제거하고 실제 이륙 가능 FATO 수의 설정 비율(2개/50%이면 1개)을 적용한다. 예정 출발 보호는 실제 출발지의 parked 기체에 한정하고 ready_s/off_block_s 외 entry_forecast departure_s도 고려한다. 실제 진행 중 출발/점유는 보호 유지. 관련 56 PASS, py_compile PASS.
- 사용자 재시작 승인 후 도구의 launcher 실행이 정책 거부되어 우회하지 않았다. 사용자가 직접 재시작 완료 응답. 보존한 동일 원본 4160편 CSV를 재로드하고 10배속 native-fastphysics-simpleflight 재생했다. 새 run 63791bd6245d60b6-fe2b3e.
- 실제 검증: UAM0009/FPL000003 06:40:50 touchdown (event_sequence 4621), 이후 gate_in, 고도30m, blocked_by=[] 지상 이동 확인. UAM0001 접근 재개 확인, UAM0058은 아직 접근/복귀 중이며 두 후속편의 접지는 검증하지 못했다. 모든 착륙 문제 해결을 주장하지 않는다. 기록 data/workspace/landing_validation_live.json.
- 사용자가 검증 소요시간을 지적하여 06:42:15에 1배속 복구하고 모니터 프로세스 중단. 서버/운항은 계속 실행 중이다. 동일 초기 계획 재실행은 인계 상태를 초기화했으며 명시 승인 범위였다.


## 2026-09-21 초기 접근 예약의 자동 출발 시간창

- 지상 실제 점유/이동 claim은 그대로 유지한다. 조기 차단 원인으로 확인한 터미널 초기 접근 예약의 순서 의존을 제거했다. 기존에는 출발 blocker가 있어야 초기 접근 prefix를 썼으나 이제 예측 접근/최종진입 전에는 제동 여유가 검증된 prefix를 먼저 사용한다.
- scenario_engine은 초기 접근 claim의 현재 위치 기반 잔여시간과 자동 출발의 지상이동+이륙+상승 전체 시간(계획 duration과 native leg 계산 중 큰 값)을 비교한다. 최종진입 또는 혼합 분리 간격 중 큰 값과 ETA 여유를 확보해야 한다. PSU는 충분한 gap에서만 도착 우선 대기를 건너뛰며 실제 패드/터미널 점유는 유지한다. 수동·정지·고장·불명확 예측은 허용하지 않는다. 대기 사유를 시간 부족/예측 확인으로 분리했다. ADR 0114.
- 검증: 신규 5 PASS; 관련 122 PASS. 확대 Python 묶음 178 PASS/2 FAIL/8 SKIP. 2건은 ground_operations의 gate-before-landing와 native_exit_permission이며 새 조건을 수정 전으로 메모리에서 바꿔 재검사해 동일 실패 확인(파일 롤백 없음). native runner 요구 일부 8건 SKIP. py_compile 및 범위 diff-check PASS.
- 다른 작업은 manual_takeover 우선 lease만 수정하고 이 작업의 scenario_engine/psu_sequencing 범위와 분리하기로 조율했다. 서버 재시작/사용자 비행 변경 없음. 실행 중 기체의 대기시간 개선 및 실제 Web/native 비행은 아직 검증하지 않았다. 자동 시간창 개선으로, 모든 지상 막힘 제거 또는 수동 ETA 기반 출발 허용을 뜻하지 않는다.


## 2026-09-21 새 계획 수동 첫 편 우선 배치와 폼 설정 유지

- 생성 요청의 선택적 manual 조건을 서버에서 검증하고 스케줄러에 전달한다. 같은 준비 시각에서 선택 인승/출발지의 최초 후보를 먼저 검토하고 첫 편 생성 후 일반 순서로 복귀한다. 수요·항로 및 FATO 자원 조건은 유지한다. 인계/기존 스케줄 변경은 없다. 일치하는 생성 편이 없으면 notes에 사유를 안내한다. ADR 0113에 하위 호환 요청 필드와 범위를 기록했다.
- UAM 계획 폼의 범위, 연결, 수요, 시간, 시드, 기체 구성, 수동 조건, 계획시간 입력을 브라우저 localStorage에 저장하고 새 창에서 복원한다. 결과 및 서버 수요 기준값은 저장하지 않는다. 명시적 초기화도 저장되며 저장 차단과 깨진 JSON은 폼을 막지 않는다.
- 검증: 스케줄러/계획 생성 Python 53 PASS (실제 generate 경로에서 6인승 첫 편 07:00 확인 포함), 요청 전달/설정 복원 Node 6 PASS. 전체 브라우저 2175 PASS/13 FAIL, 이전 camera_startup_full.txt 실패명과 동일. 범위 diff-check 및 신규 JS syntax PASS.
- 서버 재시작 및 사용자 비행 탭 새로고침 없음. 실제 웹 창 검증은 미실시. 실행 서버의 Python 재시작 및 웹 새로고침 후 새 스케줄 생성부터 사용 가능하다. 같은 브라우저/원점 안에서만 설정을 유지하며 저장 차단 환경은 지속 저장되지 않는다.


## 2026-09-21 외부 카메라 첫 표시 및 시점 전환 부하 분산

- AirframeCamera의 기존 OFF/ON context 및 pending 모델 재사용은 유지한다. 조종석 시설 Entity 추가를 프레임당 최대 12개 또는 생성 루프 4ms로 나눠 최초 렌더에 최대 180개를 한꺼번에 전달하지 않는다. 단일 geometry/GPU 작업 시간의 상한을 보장하는 정책은 아니며 최종 표시 대상 수와 해상도는 줄이지 않았다.
- 조종석에서 내 기체 모델의 준비 전에는 주변 기체의 새 모델 로딩을 뒤로 미룬다. 이미 존재하는 교통 모델은 계속 갱신하며 내 모델 누락/실패는 교통 로딩을 막지 않는다. 방향 변경은 기존 갱신 타이머를 취소하고 다음 호스트 업데이트에서 즉시 예약한다.
- 검증: 관련 Node 시험 37 PASS (신규 4건), 전체 브라우저 2173 PASS/13 FAIL. 실패명을 manual_request_full.txt baseline과 정규화 비교하여 동일함을 확인했다. node --check, 변경 범위 git diff --check PASS.
- 서버 재시작, 사용자 비행 탭 새로고침 없음. 실제 WebGL 첫 표시 시간과 GPU 지연은 아직 실측하지 않았으며 현재 열린 페이지에는 기존 모듈이 남는다. 이번 변경은 초기 작업 집중과 시점 전환 대기 개선이며 모든 지형/모델 로딩 지연 해결을 의미하지 않는다.


## 2026-09-21 수동 출발 요청 가능 시각 안내

- 출발 요청 가능 시각 전에는 PSU 단계 `출발 시각 대기`, 본문 `출발 요청까지 N분 N초 · GATE 대기`, 비활성 버튼에도 남은 시간을 표시한다. 사유에는 earliest_departure 기반 실제 요청 가능 시각과 이동 허가가 아님을 명시한다. 초기 우선 배정 문구가 이 대기를 덮어쓰지 않으며 재생 중에도 재생을 요구하던 문구를 제거했다. 기존 배정 접수 후 자동 재검토 단계는 유지한다.
- 선택 방식은 기존과 동일하게 인승·출발지 조건을 만족하는 인계 가능한 후보(기본 45분 이내)의 off_block_s 오름차순이다. 필터 후 가장 빠른 편 선택 회귀시험을 추가했다.
- 검증: manual_procedure/manual_entry_priority/manual_takeover 28 PASS, py_compile와 범위 diff-check PASS. 서버 재시작 및 현재 수동 조종 변경 없음. 현재 서버에는 아직 새 안내가 적용되지 않았으며 재시작 후 적용된다.


## 2026-09-21 저고도 착륙 접근점 복귀 차단 수정

- 실행 중 성수 VP009의 UAM0062/0067/0083 상태를 GET 조회하고 `data/workspace/analysis/VP009_hold_diagnosis.json`에 보존했다. F2는 FPL000021(UAM0067)의 접근 점유가 남고 해당 기체는 약 58m에서 rejoin 40m로 복귀하지 못했다. 관측 교통만 분리 재검사하면 UAM0067의 복귀는 통과하지만 UAM0062/0083은 그 기체에 막힌다.
- `_queue_transfer_clear`가 교통 수직 분리 45m를 지형 여유로 고정 적용해, 평지에서도 58m→지정 40m 접근을 거부하는 결함을 시험 2건으로 먼저 재현했다. 대기 예약 rejoin이 작성된 착륙 시작점과 정확히 일치할 때만 끝점의 지형 여유에 맞춰 경로 검사 여유를 점진 축소한다. 최소 5m 여유와 중간 지형 검사, 다른 기체의 수평120m/수직45m 분리 검사는 유지한다. 임의 저고도 우회점에는 적용하지 않는다.
- 검증: 신규 7건 포함 관련 51 PASS, 추가 대기열 묶음 45 PASS/3 실패. 수정 전 함수로 메모리 안에서 되돌려 비교한 결과 같은 3건 실패(성숙한 출발 예약 1, paused queue iteration 2)이며 파일 롤백은 하지 않았다. py_compile, 범위 diff-check PASS.
- 현재 서버 재시작이나 운항 상태 변경은 하지 않았다. 실제 복귀/착륙 완료 검증은 재시작 승인 후 남아 있다. 지면 오프셋·다른 교통과 동시 접근까지 전체 해소를 주장하지 않는다. 다른 작업의 `_prepare_waiting_route` 변경과 분리해 이 함수만 수정했다.


## 2026-09-21 이착륙 겸용 FATO의 출발 용량 보호

- PSU에 겸용 FATO 출발 용량 보호 판단을 추가했다. 기본값은 300초 안에 출발 예정·요청·진행 중인 편이 있을 때 이륙 가능한 FATO의 50%를 남기는 것이다. 독립된 겸용 FATO가 4개면 2개를 이륙용으로 보호한다. 전용 이륙 FATO가 있으면 보호 수는 그 수보다 작아지지 않는다.
- 단순 FATO 개수가 아니라 시설 보고의 폐쇄·정비 상태, 실제 점유, 이미 최종 접근에 진입한 착륙편과 `pad_adjacency_m`에 따른 동시 폐쇄 범위를 계산한다. 새 착륙으로 사용 가능 출발 FATO가 보호 수보다 줄면 `이륙 FATO 보호 대기`를 반환하고 기존 FATO 주변 대기층에 유지한다. 기존 장애로 이미 용량이 낮은 경우에는 새 착륙이 추가로 줄이지 않는 현재 용량까지만 보호하여 전체 도착을 교착시키지 않는다.
- 자동 비행은 접근 예측과 최종 진입에서 같은 보호 판단을 반복하고, 수동 비행은 접근·착륙 요청 모두 같은 결과를 사용한다. 여러 편이 같은 주기에 접근해도 먼저 최종 진입한 편을 다음 판단에 포함한다. 이미 수직 착륙이 물리적으로 확정된 기체는 계산 변화만으로 대기점으로 되돌리지 않는다.
- PSU 결정 화면에 `임박한 이륙 FATO 보호`, `이륙 FATO 보호 비율`, `이륙 용량 보호 예고시간`을 추가했다. 버티포트는 역할·상태·점유를 보고하고 Simulation은 기하와 교통 사실을 전달하며, 보호 비율과 착륙 허가 결과는 PSU가 소유한다. 설계는 ADR 0111과 경계·운항·ICD 문서에 기록했다.
- 검증: 관련 PSU·도착·수동/자동·FATO·시나리오 Python 255 PASS, 다중 FATO native·수용량·회복·접근 분리 Python 29 PASS, 대기열 Python 15 PASS/기존 반올림 회귀 1건 제외, 관련 브라우저 69 PASS, 변경 Python `py_compile`과 범위 제한 `git diff --check` PASS. 실행 서버는 현재 시나리오를 보존하기 위해 재시작하지 않았고 실제 4-FATO 동시 이착륙 운항은 아직 수행하지 않았다.
- 제한: `2 착륙 + 2 이륙`은 네 FATO가 실제로 독립일 때의 목표다. FATO 간격이나 공중·지상 경로 중첩 때문에 착륙 FATO 하나가 여러 출발 FATO를 닫으면 PSU는 더 적은 착륙만 허가한다. 50%와 300초는 연구용 정책값이며 실제 시설 인증 용량이 아니다.

## 2026-09-21 수동 비행 요청이 설정 창 조회로 취소되는 경로 수정

- 실행 서버는 3,339편 시나리오 재생 중 manual_aircraft=null이었다. 조회 당시 6인승 배정 후보 24편을 확인했다. 특정 출발지 선택 여부는 확인되지 않아 사용자 신고의 단일 원인으로 단정하지 않는다.
- 새 설정 창의 readPlan 조회가 기본 manual.want=false를 기존 배정 요청에 전달하던 경로를 제거했다. 읽기 콜백은 수동 요청을 바꾸지 않으며 명시적 생성/적용/수동 선택은 계속 전달한다. 후보가 없을 때는 조건과 대기 이유를 한 번 알린다.
- 회귀시험: 관련 15 PASS; 전체 브라우저 2,166 PASS / 기존 동일 실패 13개. JS 구문 및 범위 diff 검사 수행. 실제 실행 API는 GET으로만 확인했으며 서버 재시작, 사용자 새로고침, 강제 수동 배정은 하지 않았다. 수정 JS는 다음 페이지 로드부터 적용된다. 현재 세션의 조종석 진입 성공은 미검증이다.


## 2026-09-21 다중 비행 스케줄링 설정 GUI 개선

- 기존 단계형 설정에 스케줄링 기준을 추가했다. 서버 기본값을 읽고 FATO 간격, 회복여유와 고급 단계별 하한을 수정하며 생성 요청에 전달한다. 기본값 복원, 입력 범위 검증, 편집값 유지와 생성 요약 표시를 추가했다. 사용자 요청에 따라 공중 항로 충돌 제외 안내는 설정 및 요약 GUI에서 제거했다. 계산 정책은 변경하지 않았다.
- 검증: 전체 브라우저 시험 2,165 PASS / 13 기존 실패. 직전 schedule_browser_tests_20260921.log의 실패명을 경로 정규화해 비교하여 13개 모두 같음을 확인했다. 신규 테스트 4개는 모두 통과했다. JS syntax와 범위 제한 diff-check PASS.
- 별도 IAB 탭의 1280x720 화면에서 스케줄링 기준 배치, FATO 60→90초 입력 및 단계별 고급 항목 표시를 확인했다. 사용자 탭과 서버를 재시작하지 않았고 계획 생성 및 실제 운항은 실행하지 않았다. 1920x1080과 모바일 breakpoint는 미검증이다.


## 2026-09-21 접지 순서 GATE 배정과 FATO 중심 실시간 착륙 대기열

- 도착 허가에서 GATE 사전 확보를 분리했다. PSU는 착륙 FATO가 비어 있고 최종 접근 분리가 확보되면 GATE가 아직 없어도 접근과 착륙을 허가한다. 접지한 기체는 접지 순서대로 빈 GATE와 FATO→GATE 지상경로 후보를 평가받으며, 통행 가능한 대체경로가 있으면 점유된 최단경로보다 우선한다. GATE나 안전한 경로가 없으면 FATO에서 정지하고, 실제로 FATO 중심에서 25 m 이상 벗어난 뒤에만 FATO 점유를 해제한다.
- 접근 대기열은 목적지 FATO별로 분리하고 남은 계획 항로 ETA가 짧은 순서로 매 주기 다시 정렬한다. 각 FATO의 착륙 시작점 주변에 8개 후보 위치를 두며, 1순위는 착륙 시작 고도 +10 m, 2순위는 +20 m처럼 순번마다 10 m씩 높인다. 순번이 당겨지면 기존 예약을 안전하게 새 순번·위치로 옮기고, 여러 FATO를 쓰는 기체는 배정된 FATO별 대기열로 산개한다.
- 대기 위치는 FATO와 바로 연결된 공개 이륙 링크, 다른 대기 위치, 이동 구간, 지형 및 관측 교통과 겹치지 않는 후보만 사용한다. 최종 접근이 준비되면 대기 위치에서 착륙 시작점으로 직접 이동하되 전 구간을 다시 검사하고, 위험하면 측면 경유 지점을 사용한다. 착륙 시작점 도달 뒤 PSU 허가를 다시 확인한 다음 착륙한다. 자동·수동 조종 모두 같은 PSU 자원 판단과 Pilot 절차를 사용한다.
- 역할은 버티포트의 자원 사실·지상경로 제안·이동 허가, PSU의 ETA 순번·대기층·FATO 허가·접지 후 GATE 선택, Pilot의 대기/최종 접근 이동과 허가 요청, Simulation의 관측·실행으로 구분했다. 공개 clearance의 `deferred_stand` 확장과 전체 절차는 ADR 0110 및 경계·운항·ICD 문서에 기록했다.
- 검증: 관련 PSU·지상관제·수동/자동 도착·시나리오 Python 231 PASS, 다중 FATO·수용량·접근 분리·대기 압력 Python 19 PASS, 대기열 집중 Python 15 PASS, 관련 브라우저 12 PASS, 변경 Python `py_compile`과 범위 제한 `git diff --check` PASS. `test_mature_ground_admission_is_not_requeued_due_to_tick_rounding` 1건은 성숙한 지상 예측시각이 재계산 때 밀리는 현재 작업 트리의 별도 실패로 남아 있다.
- 실행 중인 서버와 현재 시나리오는 보존하기 위해 재시작하지 않았고, 실제 다기체 운항과 충돌 회피 비행은 아직 수행하지 않았다. GATE가 비어 있지 않으면 접지 기체가 FATO를 계속 막으므로 이 정책이 항상 처리량을 높이는 것은 아니다. 10 m 대기 고도 간격과 25 m FATO 이탈 반경은 현재 시뮬레이션 정책값이며 실제 운항 기준으로 간주하지 않는다.

## 2026-09-21 시설 자원·기체 순환·회복여유를 반영한 UAM 정기편 생성

- 현재 저장된 버티포트 19곳, 항로 노드 138개와 링크 270개를 대상으로 계획 생성기와 같은 운항 프로필을 사용해 전수 계산했다. 연결된 GATE/FATO 지상이동 조합 244개와 방향별 FATO OD 900개 중 연결 가능한 840개를 평가했다. 평균은 출발 지상이동 146.3초, 이륙 13.7초, 상승·정천이 30.7초, 순항 266.1초, 강하·역천이 30.3초, 착륙 22.8초, 도착 지상이동 134.6초, 충전·승객 처리 401.8초다. 재현 도구와 보고서를 `project_support/tools/calibrate_uam_schedule.py`, `data/workspace/analysis/schedule_calibration_20260921.json`에 남겼다. 이는 실제 물리 비행 로그가 아니라 현재 작성 항로와 기체 프로필을 모두 통과시킨 오프라인 계획 실험이다.
- 정기편에는 거리별 순항시간을 그대로 두고 터미널 단계에 평균/P80 계획 하한을 적용했다. 계획 용량은 GATE, FATO, 기체와 회항시간만 다룬다. 동일 FATO는 60초 간격으로 예약하고 가능한 출도착 FATO 조합 중 가장 빠른 것을 고르며 필요한 지연은 `departure_resource_wait_sec`에 기록한다. 공중 항로는 점유 자원으로 예약하지 않고 충돌이 없는 것으로 가정한다.
- 같은 기체는 이전 편의 도착과 좌석 등급별 최소 회항시간이 끝난 뒤에만 다시 배정한다. 실제 계산 충전시간과 최소 회항시간 중 큰 값에 120초 회복여유를 더한다. 생성 요약과 GUI에는 FATO 슬롯 조정 편수·최대 지연, FATO 예약 수, 회복여유와 기체별 회전 횟수를 공개한다. 사용한 계획값은 요청과 결과에 함께 저장해 재현할 수 있게 했다. 결정은 ADR 0109에 기록했다.
- 항로 용량을 제외한 19곳·171개 버티포트 쌍·하루 675명·버티포트당 4인승 1대 통합 계산은 4.834초에 완료됐다. 운항시간 수요 535명 중 항로 반영 527명, 435편/435명 수송, 미수송 92명, 미해결 도착 0편이었다. FATO 자원으로 29편이 조정됐고 총 지연 1,603.0초, 최대 지연 80.1초였다. 대기하던 수요가 다른 기체에 실린 경우 그 대기시간이 다음 수요 시간대로 누적되던 오류도 제거했다. 결과는 `data/workspace/analysis/schedule_integration_20260921.json`에 보존했다.
- 검증: 관련 Python 98 PASS, Python py_compile·JavaScript node check·범위 제한 diff-check PASS. 관련 수요 브라우저 시험은 53 PASS/1 기존 source-shape 실패, 전체 브라우저는 2,161 PASS/13 현재 기준선과 같은 기존 실패였다. 서버를 승인된 방식으로 재시작했고 HTTP 200과 `seoul_uam_20260921`, FATO 60초, 회복여유 120초 및 항로 계획 파라미터 부재를 확인했다. 별도 브라우저 탭에서 UAM / Simulation의 다중 비행 화면과 19개 버티포트 표시를 확인하고 탭을 닫았으며 실제 계획 생성 버튼은 눌러 현재 운항 상태를 바꾸지 않았다.
- 제한: 생성기는 탐욕적 휴리스틱이라 전체 최적성을 보장하지 않는다. 공중시간 보정은 현재 4인승 AeroDT 쿼드 틸트로터 기준이다. 공중 항로 충돌, 고도 분리와 외부 사업자 교통은 계획에서 고려하지 않으며 실행 중 PSU가 판단한다. 현재 시설은 충전기 수와 GATE 수가 같아 GATE 점유로 충전 용량을 대신하지만, 두 수가 다른 시설에는 별도 충전기 예약 달력이 필요하다. FATO 계획 간격은 연구용 값이며 실제 허가는 PSU가 계속 소유한다.

## 2026-09-21 연결되지 않은 OD 수요의 부분 확산 적용

- 운항시간 수요를 먼저 선택된 모든 버티포트 사이의 잠재 OD로 계산한 뒤 실제로 연결되는 방향에만 직접 수요를 남기도록 바꿨다. 연결되지 않은 OD의 85%는 같은 출발지, 같은 도착지, 두 끝점 공유, 나머지 연결 항로 순으로 대체 배분하며 15%는 다른 수단·시간대 또는 이동 포기로 이탈 처리한다. 실제 항로 계산에 실패한 방향도 같은 규칙을 적용하고 직선 항로는 만들지 않는다.
- 스케줄러 입력 수요와 운항시간 내 잠재수요를 분리했다. 결과 요약은 직접 연결 수요, 연결되지 않은 원수요, 대체 분산 수요, 네트워크 이탈 수요와 최종 항로 반영 수요를 각각 제공한다. 기체 부족으로 인한 `unserved_passengers`는 네트워크 이탈과 별도로 유지한다.
- 수요 요약 화면과 생성 완료 안내도 같은 85% 정책을 사용한다. 좌석 공급 비교는 전체 잠재수요가 아니라 최종 항로 반영 수요를 기준으로 하며, 기본값 API profile에 정책값을 공개했다. 결정과 추가 응답 필드는 ADR 0108에 기록했다.
- 검증: 수요 비율·수요 생성·스케줄·계획 생성 Python 56 PASS, 수요 요약 브라우저 시험 20 PASS, 변경된 수요 설정 브라우저 시험 4 PASS. 전체 수요 설정 브라우저 시험은 33 PASS/1 기존 `LiveGlobe.destroy()` 소스 형태 검사 실패이며 이번 계산 변경과 무관하다. Python `py_compile`, JavaScript `node --check`, 범위 제한 `git diff --check` PASS. 새로 시작된 8766 서버에서 기본값 API의 `od_redistribution_rate=0.85`와 HTTP 200을 확인했으나 실제 화면에서 계획을 생성하는 운항 검증은 수행하지 않았다.
- 제한: 현재 대체 선택은 연결 관계와 기존 OD 비율을 사용하며 거리, 요금, 운항시간 효용은 아직 반영하지 않는다. 85%는 사용자와 정한 초기 정책값으로 실측 탄력성 추정치가 아니다.

## 2026-09-21 고층 밀집지 및 강변 도로 DEM 보완 적용

- MBTiles 지하철/터널 및 음수 layer가 지상 보호 마스크에 들어가 원본 요철을 고정하던 분류를 수정했다. 지상 교량과 양수 layer는 보존한다. 전체 20,212타일을 다시 추출했으며 구조물 조각은 99,086개에서 75,359개로 줄었다(시설 개수가 아닌 타일 조각 수). 분류 변경을 반영해 mask_cache schema를 2로 올려 구 마스크 재사용을 차단했다. 공개 runtime package schema는 그대로다.
- 건물 윤곽 밖 2표본을 배경 추정에서 제외하고 건물 밀집 구역에 25표본 opening을 혼합했다. 국소 목표면 대비 추가 변화는 12 m로 제한한다. 강변 7표본 보호대에서 지상 도로 중심선 45 m 이내는 보정하되 바로 인접한 1표본 제방과 물은 보존한다. 보호 교량/수변과 낮춘 시가지의 단차를 줄이도록 120 m 연결부를 둔다. 건물 render_height를 지면 기준 고도로 쓰지 않는다.
- 출력은 data/workspace/terrain/conditioned_urban_riverside_20260921, version fe618863ebb41839. 원본과 이전 적용본을 보존했다. 초기 시험안은 여의도 RMS가 오히려 증가하여 배포하지 않았고 추가 수정 상한과 경계 완화를 비교한 후 최종안을 생성했다.
- 전체 데이터 검증: 유효 142,585,201표본, 10 cm 초과 수정 39,444,884표본, 최대 80 m, 공유 경계 15개 일치. NoData, 보호 자연/지상 구조물, 패키지 해시, GeoTIFF/reader 일치와 지오이드 기준 검증 PASS. 이전 강화본 대비 RMS 감소는 여의도 도로 19.53%, 강변 지상 도로 13.10%, 여의도 시가지 3.66%, 강남 시가지 16.82%, 강남 도로 33.32%, 김포공항 78.66%, 한강 0.12%. 북한산은 0.27% 증가했다. 이는 고주파 요철 지표이며 절대 측량 정확도나 모든 지역의 개선을 뜻하지 않는다.
- 검증 명령: terrain_build Python의 `-m pytest project_support/tests/web_live/test_condition_dem.py project_support/tests/web_live/test_local_terrain.py -q` 32 PASS. `-m project_support.tools.review_conditioned_dem <새 출력> --baseline <직전 출력>` PASS. 도구 py_compile 및 범위 제한 git diff --check PASS. 결과는 urban_riverside_tests.log, urban_riverside_qa.log와 생성물 qa/validation.json에 저장했다.
- 사용자 승인 후 launcher --restart --no-browser로 서버 재시작, 새 버전 metadata와 HTTP200/33,800 bytes 확인, 구 버전 요청 HTTP409 확인. 이후 서버 PID가 다른 실행 프로세스로 바뀌었으나 활성 API 버전은 동일함을 재확인했고 다시 재시작하지 않았다. 별도 Chrome 탭에서 UAM 서울 화면과 보정 DEM 선택 상태를 확인했으며 관측 console warn/error는 없었다. 검증 탭은 닫고 사용자 탭은 유지했다. 기존 사용자 화면은 새로고침이 필요하다.
- 남은 위험: 보호 지형의 원본 오류와 고층 밀집부 잔여 요철은 남는다. 여의도 저고도 3D 거리별 외관 전체 검증, 정식 UAM 임무 검증 및 물리 접촉면 정합은 미실시다. 성능 향상을 주장하지 않는다. 이 작업은 사전 생성 표시용 높이만 바꾸며 native/수동 비행의 물리 지표는 바꾸지 않는다.

## 2026-09-21 조종사 소유 접근 순번 요청과 수동 알림

- 접근 순번 요청 기준을 `ScenarioEngine`/PSU 규칙에서 Pilot 절차로 옮겼다. 자동 조종사는 현재 위치 기반 잔여시간 또는 도착 진입점 기준에 도달하면 PSU에 자동 요청하고, 수동 조종사는 같은 기준에서만 `접근 순번 요청` 버튼이 활성화된다. 기준 전 API 요청도 대기 응답을 반환한다. PSU는 요청을 받은 뒤 순번, FATO와 GATE를 판단한다.
- 수동 조종의 잔여시간 계산도 자동 조종과 같은 남은 계획 항로 ETA로 통일했다. 실제 3차원 위치를 아직 지나지 않은 항로 구간에 투영하고, 항로 복귀와 남은 polyline을 구간별 수평속도·상승률·강하율·착륙률로 계산한다. 기존 착륙점 직선거리 추정은 제거했다.
- 수동 조종 화면은 버튼이 비활성에서 활성으로 바뀌는 순간 `received` 알림음을 한 번 재생하고 `지금 PSU에 요청` 안내를 표시한다. 브라우저의 도착 거리는 이미 활성화된 안내를 보강할 뿐 요청을 임의로 활성화하지 않는다.
- `arrival_request_lead_s`의 단일 소유권을 Pilot 결정 차트로 옮겼다. 기존 PSU 위치에 저장된 사용자 값은 읽을 때 이관하고 PSU 차트에는 Pilot 값을 참조로만 표시한다. 자동 요청 이벤트에는 Pilot→PSU 방향을, 수동 기준 도달에는 `pilot_arrival_request_ready`를 한 번 기록한다. 경계는 ADR 0107과 PSU/Pilot ICD에 반영했다.
- 검증: manual/scenario/decision 관련 Python 294 PASS, 남은 항로 ETA 집중 Python 17 PASS, 수동 도착·PSU 브라우저 16 PASS, 확대 수동/PSU 브라우저 149 PASS/1 변경 경로와 무관한 `manual_flight_transport` fixture 오류, 변경 Python `py_compile` 및 `git diff --check` PASS. 아키텍처 시험은 현재 기본/웹 Python 환경 모두 `commentjson` 부재로 수집하지 못했다.
- 실행 중인 서버는 현재 시나리오를 보존하기 위해 재시작하지 않았다. 실제 브라우저에서 운항을 시작해 알림음을 청취하는 검증도 수행하지 않았으므로, 변경은 다음 서버 재시작 뒤 적용되며 실제 음량·장치 출력은 별도 확인이 필요하다.

## 2026-09-21 MBTiles 기반 시가지 DEM 강화 보정 적용

- `urban_strong` 프로필을 추가했다. 일반 도로, 건물 윤곽과 시가지 토지 이용을 포함하고 주변 지표에서 추정한 완만한 면으로 돌출과 구멍을 줄인다. 일반 완경사 지표도 완화하되 산지, 자연지형, 교량/터널 표식과 수변 보호 구역을 보존한다. 시가지 최대 수정량 80 m는 시각적 변형 상한이며 측량 정확도를 의미하지 않는다. 건물 높이를 지면 해발고도로 사용하지 않는다.
- 새 생성물 `data/workspace/terrain/conditioned_urban_max_20260921`의 version `2befd51095d065e8`을 기존 보정 DEM 선택에 연결했다. 원본과 기존 약한 보정본은 보존했다. 입력과 마스크 해시를 검증하는 재사용 경로 및 빈 벡터 조각 처리 회귀시험도 추가했다.
- 수치 검증: 유효 표본 142,585,201개, 10 cm 초과 변경 38,908,570개, 최대 절대 변경 80 m, 공유 경계 15개 일치. NoData, 보호 마스크, 패키지 해시, GeoTIFF/패키지 대응, 지오이드 높이 변환 검증 통과. 동일 마스크에서 기존 보정본 대비 고주파 RMS는 강남 시가지 36.33%, 여의도 시가지 26.51%, 강남 도로 11.29%, 한강 46.90% 감소했다. 김포공항은 4.56% 증가했고 북한산은 0.165% 증가로 거의 유지되었다. 모든 지역의 개선이나 절대 고도 정확도 향상으로 해석하지 않는다.
- 검증 명령: terrain_build 환경의 `python -m pytest project_support/tests/web_live/test_condition_dem.py project_support/tests/web_live/test_local_terrain.py -q` 29 PASS. 버전 캐시 수정 후 local_terrain 13 PASS, local_terrain/browser_display_settings 관련 Node 시험 18 PASS, 도구 py_compile 및 변경 코드 diff-check PASS. `review_conditioned_dem <새 출력> --baseline <기존 보정본>`의 전체 데이터 검증 결과는 생성물 qa/validation.json에 기록했다.
- 사용자 승인 후 서버를 재시작했다. 새 metadata enabled=true, 새 버전 타일 HTTP200/33,800 bytes를 확인했다. 이전 버전 키로 새 높이를 반환하지 않도록 stale version 요청은 HTTP409/no-store로 거부한다. ADR에 명시했다. 기존에 열린 브라우저는 새로고침해야 한다.
- 별도 Chrome 검증 탭에서 UAM 진입과 보정 DEM 선택 상태, 실제 화면을 확인했다. 새 버전 타일 HTTP200 요청 101건을 관측했고 관측 구간 console warn/error는 없었다. 검증 탭만 닫고 사용자 탭은 유지했다. 증거는 data/workspace/urban_max_live_api.json 및 urban_max_browser_requests.json이다.
- 제한: 시각화용 추정 지표이며 native 물리/수동 비행 지상 판정은 변경하지 않았다. 실제 작은 둔덕/절개면이 완화될 수 있고 보호 구역의 요철은 남을 수 있다. 전체 지역 외관, 버티포트 높이 정합, 프레임 성능 개선은 검증하지 않았다. 정식 UAM validation 폴더가 비어 있으며 운항 시험/Unreal 실행은 수행하지 않아 정식 임무 검증 완료를 주장하지 않는다.

## 2026-09-21 버티포트 지상경로 제안과 분리 기록

- 출발 스탠드에서 FATO까지의 유도로 탐색을 `ScenarioEngine`에서 `VertiportGroundControl`로 옮겼다. 버티포트는 정적 유도로 그래프에서 최단 경로와, 실제로 다른 경로가 존재할 때 다음 최단 단순 경로까지 최대 두 개를 만든다. 현재 실제 점유와 기존 지상이동 claim을 이용해 후보별 진행 가능 거리와 방해 기체도 함께 계산한다.
- 새 불변 `GroundRouteProposal`은 버티포트 ID, 안정된 경로 ID, 시작·종료 자원, 노드열, 로컬 north/east 경로, 거리·순위·진행 가능 거리·방해 기체를 담는다. 이는 이동 허가가 아니며 실제 이동은 기존 `MovementAuthority`가 계속 통제한다.
- `ScenarioEngine`은 Runtime의 위치 관측을 버티포트에 전달하고 제안된 로컬 경로를 실행 좌표로 투영한다. `PsuSequencer`는 버티포트의 지상경로 제안과 FATO, 도착 혼잡, 터미널 충돌 및 출발 간격을 함께 비교한다. 점유되지 않은 대안이 있으면 점유된 최단 경로보다 우선하며, 없는 대체 경로를 직선으로 만들지 않는다.
- 기록을 분리했다. 운항용 `events.jsonl`에는 버티포트 후보 요약과 PSU 선택 결과를 남기고, 전체 노드열·후보별 점유 판정·구성 탈락 사유는 같은 시나리오 폴더의 개발용 `diagnostics.jsonl`에 저장한다. 두 기록은 현재 상태나 허가의 입력으로 사용하지 않는다. 설계는 ADR 0106과 `BOUNDARIES.md`, `FLIGHT_OPERATIONS.md`, `PSU_PILOT_ICD.md`에 반영했다.
- 검증: 지상관제·PSU·FATO·시나리오 기록 집중 시험 131 PASS, 관련 지상·도착·시나리오 확대 시험 95 PASS / 기존 최종 출구 허가 시나리오 1건 제외, 수동 비행 전체 214 PASS, 비행계획 관련 변경 경로 54 PASS. 비행계획 전체 파일은 55 PASS / 13 FAIL이며 13건은 현재 기준선에 이미 기록된 시각 모델별 경로 동일성 시험이다. 변경 Python `py_compile`, 저장소 아키텍처 검사와 `git diff --check` PASS.
- 실행 중인 서버는 현재 시나리오를 보존하기 위해 재시작하지 않았다. 새 지상경로 제안과 분리 로그는 다음 서버 재시작 후 시작하는 시나리오부터 적용된다. 도착 후 주기장 재배정 경로는 이번 범위에서 바꾸지 않았다.

## 2026-09-21 설정에서 보정 DEM 선택 연결

- 공용 지형 선택에 `conditioned_dem` / `보정 DEM 사용`을 추가했다. World Terrain과 기존 local_dem을 유지하며 기본 선택을 강제 변경하지 않는다. 설정의 지도 표시와 Library는 기존 브라우저별 저장 경로를 공유한다.
- 플랫폼의 `conditioned_dem_directory`를 앞서 검증한 `data/workspace/terrain/conditioned_srtm_20260921/package`에 연결했다. 별도 reader와 `/api/visualization/terrain/conditioned` 라우트를 사용하므로 원본 로컬 지형과 캐시가 섞이지 않는다. 수동 비행 elevation 입력은 기존 local_dem 그대로이며 보정 지형으로 바꾸지 않았다.
- 전환은 데이터별 독립 로딩 Promise와 세대 번호로 보호한다. 보정 패키지 없음/오류는 World Terrain 유지와 경고로 처리한다. 범위 밖은 기존 혼합/fallback 정책을 쓴다. ADR: `project_support/docs/adr/conditioned_dem_display_selection_v1.md`.
- 검증: local_terrain/library Python 31 PASS; manual_surfaces/manual_ground_start/manual_ground 30 PASS; focused browser 18 PASS; py_compile PASS. 전체 browser는 변경 전 2167개 중 2154 PASS/13 FAIL, 변경 후 2171개 중 2158 PASS/13 FAIL이며 정규화한 실패명 집합이 동일하다. 결과는 `data/workspace/conditioned_dem_*` 파일에 저장했다.
- 사용자 승인 후 launcher --restart --no-browser로 8766 서버를 재시작했다. 실제 metadata enabled=true, 패키지 version 604eb6d32286eade, 11개 구획, 지형 타일 HTTP 200/33,800 bytes를 확인했다. Chrome 별도 탭에서 UAM 진입, 설정 선택/World Terrain 복귀, 확대 시 보정 tile 요청(포착한 52건), 새로고침 후 보정 선택 유지, Satellite 공용 설정의 선택 유지까지 확인했다. 화면 console warn/error는 관측한 구간에 없었다.
- 1280×720에서 설정 창 스크롤과 보정 선택 항목의 표시/겹침을 확인했다. 검증 전에 쓰던 World Terrain 선택으로 복원하고 viewport도 원복했으며 테스트 탭을 닫았다. 실제 운항/수동 비행은 시작하지 않았다.
- 남은 범위: 현재 `project_support/tests/validation` 폴더가 비어 있어 정식 UAM 임무 validation은 실행하지 못했다. 지형/버티포트/물리 지상 판정의 정합과 전체 지역 장시간 성능을 검증한 것은 아니다. 이번 완료 범위는 보정 지형 데이터의 설정 선택과 표시 연결이며 접촉 물리 변경이 아니다.

## 2026-09-21 사용자 SRTM 사전 보정본 생성 (운용 미적용)

- 입력 SRTM 1 arc-second GeoTIFF 11장을 읽기 전용으로 조합하고 korea.mbtiles의 상세 벡터 20,212타일에서 보정 영역을 추출했다. 원본 EGM96 높이 기준과 Point 표본 위치를 유지한다. 원본 중첩 높이 차이는 0 m였다.
- `project_support/tools/condition_dem.py`를 추가했다. 완만한 육지 최대 2 m, 주요 지상 도로 중심선 1 m, 수면 8 m, 공항 12 m로 보정량을 제한한다. 강둑과 섬, NoData를 보존하고 교량/터널을 도로 보정에서 제외한다. 공항 연결 면은 타일 경계를 넘어 경사 평면으로 적합한다. 수면 처리는 국소 완화이며 하류 방향을 강제하는 수리학적 평탄화가 아니다.
- 생성물은 `data/workspace/terrain/conditioned_srtm_20260921` 아래 단일 merged GeoTIFF, 원본 구획별 높이/수정량/분류 GeoTIFF, 기존 LocalDem용 패키지와 EGM96 지오이드다. 제공 범위 126–130 E, 36–39 N 중 n38_e129 원본은 없으며 전국 자료라고 간주하지 않는다. runtime 물리, 운용 설정, 실행 서버는 변경하지 않았다.
- `project_support/tools/review_conditioned_dem.py`의 검증: 유효 표본 142,585,201개, 10 cm 초과 수정 18,397,531개, 최대 절대 수정 12 m, 공유 경계 15개 완전 일치, NoData/패키지 해시/GeoTIFF 대응 확인. EGM96 + 지오이드 = 타원체 높이 변환과 level 12/14 타일 33,800 byte 생성 확인. cold 타일 생성은 이번 장비에서 약 0.1초로, 첫 렌더 성능 향상까지 입증한 것은 아니다.
- 지정 평가 마스크에서 sigma 1.2 고주파 RMS: 김포공항 1.9784→0.7960 m(약 60% 감소), 한강 0.3202→0.1417 m(약 56% 감소). 북한산 전체 검사 영역은 3.4700→3.4644 m, 높이 범위 38–813 m 유지. 이는 측량 정확도 개선률이 아니다. 김포 원본의 큰 이상치는 상한 때문에 일부 남아 있다.
- 검증 명령: 격리 terrain_build Python으로 `pytest project_support/tests/web_live/test_condition_dem.py project_support/tests/web_live/test_local_terrain.py -q` 실행, 18 PASS. 두 도구 py_compile PASS. 합성 입력의 전체 builder/manifest/reader/경계/기존 출력 보호 회귀를 포함한다.
- 첫 생성 시 NGA 지오이드의 EPSG:4979를 거부하는 CRS 판정을 발견했다. 4326/4979 및 목표 EPSG:5773, 밴드 의미를 검증하도록 고치고 새 출력 폴더에 전체 빌드를 성공적으로 다시 실행했다. 카테고리 overview는 nearest로 생성한다.
- 남은 확인: 실제 Cesium/Web 적용, UAM 임무 validation, 지형과 버티포트/물리 지표면의 정합은 미실시. 따라서 데이터 제작 단계만 완료되었으며 운용 적용 완료로 간주하지 않는다. 실시간 필터 부하는 없지만 기존 local terrain adapter의 첫 타일 생성 비용은 별도 최적화 대상이다. 입력 벡터 이용 조건과 측량 정확도도 별도 확인이 필요하다.

## 2026-09-21 저장소 작업 규칙 README 명시

- 루트 `AGENTS.md`, 코드 경계 문서와 웹 GUI 전용 `user_application/web/AGENTS.md`의 적용 위치를 README에 명시했다.
- GUI 변경 시 도메인 격리와 생명주기 정리, 불변 snapshot 표현, 공용 시각 토큰, 접근성·성능·실제 화면 검증 규칙을 요약해 연결했다.
- 검증: README 링크와 Markdown 구조를 육안 검토했다. 코드와 실행 동작은 변경하지 않았다.
기준일: 2026-09-21

## 현재 제품 기준선

- 실행 진입점은 저장소 루트의 `python main.py`이다.
- 시각화는 CesiumJS Web Dashboard를 사용한다. Unreal 호스트와 ProjectAirSim 로컬 복제본은 배포 범위에서 제거했다.
- UAM은 FastPhysics + SimpleFlight 기반 쿼드 틸트로터를 기준으로 한다.
- 첫 화면에서 UAM과 Satellite 도메인을 선택하며, 공유 셸 아래에서 도메인별 코드와 설정을 분리한다.
- 기본 지형은 Cesium World Terrain이다. 로컬 DEM 코드는 선택적 adapter로만 남고 원본과 변환 자료는 저장소에 포함하지 않는다.

## 저장소 정리 상태

- 제품 소스: `foundation`, `communication`, `data`, `digital_twin`, `ai_eng`, `ai_pnp`, `user_application`.
- 유지보수 자료: `project_support/docs`, `project_support/tests`, `project_support/tools`.
- `project_support/environment`는 현재 PC의 로컬 실행 환경이며 Git에서 제외한다.
- `data/workspace`는 Git에서 제외되는 실행 영역이다. 다만 편집 가능한 버티포트, 항로 및 예시 비행계획은 `data/workspace/simulation`에 유지한다. 실행 로그, 공급자 캐시, 캡처와 시나리오 결과만 재생성 대상으로 취급한다.
- 기본 UAM 운용 입력은 `data/simulation/examples/seoul_uam`에도 Git 추적 가능한 기준본으로 보관한다. 기본 workspace에서 파일이 없을 때만 이 기준본을 복사하며 사용자가 편집한 파일은 덮어쓰지 않는다.
- 임시 작업 폴더, 배포 사본, 백업, 빌드 결과, 외부 연구 복제본, Unreal 자료와 로컬 DEM은 제거했다.
- GLB, ONNX와 PyTorch 가중치는 `.gitattributes`에서 Git LFS 대상으로 지정했다.

## 도메인 구조

- UAM 웹 구현: `user_application/web/domains/uam`.
- UAM 웹 API: `communication/web/domains/uam`.
- live twin 계산: `digital_twin/live_twin/domains/{aircraft,uam,satellite}`.
- 공통 좌표 계산: `digital_twin/live_twin/kinematics`.
- snapshot 조립: `digital_twin/live_twin/composition`.
- UAM AI PnP 구현: `ai_pnp/domains/uam`.
- 도메인 설정: `user_application/configs/web_dashboard/domains`.

## 이번 정리 검증

- 아키텍처 검사: PASS.
- UAM actuator, Library와 도메인 구조 집중 시험: 27 passed.
- Web Library/도메인 구조 시험: 23 passed.
- Python compileall: PASS.
- CMake preset 목록: `windows-debug`, `windows-release`만 유지.
- 복구된 UAM 기준 데이터: 버티포트 19개(수도권 18개, 울산 1개), 항로 지점 138개, FATO 58개, 링크 270개, 예시 비행계획 1,825편. 2026-09-19 실제 API 응답 잔존본과 현재 API가 정확히 일치하며 누락·문제 링크는 0개다.
- 시각 자산 통합 시험은 22개 중 19개 통과, 3개 실패가 남아 있다. 실패는 일부 flight visual 경로 규칙과 NASA GLB manifest checksum 불일치이며 이번 정리에서 모델 바이트나 manifest를 임의 수정하지 않았다.

## Git 전달 전 남은 일

- 현재 작업 폴더의 기존 `.git`은 ProjectAirSim 과거 이력을 포함하므로 그대로 push하지 않는다.
- 깨끗한 AeroDT 최초 이력을 만들고, Git LFS가 GLB/ONNX/PT 객체를 추적하는지 확인한 뒤 새 원격에 push한다.
- 광범위 Python/브라우저 전체 시험은 동시 개발 변경이 섞인 비정상 기준선이므로 clean snapshot에서 다시 수행한다.

## 2026-09-21 UAM 편집 데이터 최신본 복구

- 로컬 임시 작업 영역에 남아 있던 2026-09-19 실제 API 응답 `vp.json`과 `routes.json`을 발견했다. 추정이나 재설계가 아니라 당시 서버가 반환한 정의와 파생 결과다.
- API가 붙인 `layout`과 FATO endpoint만 제거하여 저장 형식으로 역변환했다. `id_sequence=19`, `node_id_sequence=43`을 실제 번호에서 복원했고, 수도권 18개와 울산 테스트 1개, 노드 138개, 링크 270개를 workspace와 Git 추적 기준본에 적용했다.
- 여의도·잠실·목동·사당·성수·연신내·강남·마곡·망우·수서는 4-FATO다. 마곡은 radial, Gate 12개, FATO 4개 모두 이착륙 겸용이다.
- 삭제 직후 복구했던 2-FATO 기준선은 `data/workspace/recovery_candidates/pre_20260919_restore_20260921_183510`에 보존했다. 원본 API 응답과 복구본은 `data/workspace/recovery_candidates/20260919_api_snapshot`에 해시와 함께 보존했다.
- 검증: 정의 19개 전부 validation 및 layout 재생성 성공. 재생성 API는 보존된 2026-09-19 응답과 버티포트·항로 모두 정확히 일치했다. 실행 서버 API 19 vertiports / 138 nodes / 58 FATOs / 270 links / dropped 0 / problems 0. 버티포트 그룹·항로·workspace seed 집중 시험 35 PASS. 함께 실행한 flight-plan 전체 파일에서는 복구 데이터와 무관한 visual-selection 경로 동일성 회귀 13건이 실패하여 전체 통과로 기록하지 않는다.

## 2026-09-21 UAM 기반시설 표시 복구

- Physical UAM 주소가 설정되어 있으나 송신 서버의 첫 운용 환경이 아직 도착하지 않은 동안 `physical::pending`의 빈 환경이 저장된 시나리오 환경을 덮어쓰던 문제를 수정했다.
- Physical 환경 수신 전에는 저장된 UAM 버티포트와 항로를 계속 표시하고, 송신 환경이 실제로 도착하면 해당 revision으로 전환한다. 명시적으로 수신한 빈 Physical 환경은 계속 권위 있는 입력으로 취급한다.
- 검증: `project_support/tests/web_live/test_physical_operations.py` 13 PASS. 서버 재시작 후 서울 기본 시야에서 버티포트 18곳과 수도권 항로가 Cesium 지도에 표시되는 것을 확인했다.

## 2026-09-21 운항시간 수요 절단 방식 수정

- `기준 교통량 × UAM 전환률` 결과를 24시간 잠재수요로 정의했다. 스케줄 생성 수요는 서울시 시간대별 출발 곡선에서 실제 운항 창이 차지하는 비율만 취하며, 닫힌 시간대 수요를 운항시간 안으로 재정규화하지 않는다.
- 기본 13,500,000명 × 0.5%는 24시간 67,500명이며, 06:30~21:30은 곡선의 79.3136%인 53,537명이다. 나머지 13,963명은 운항시간 외 수요로 별도 집계한다.
- 생성 요약과 완료 문구는 24시간 잠재수요, 운항시간 내 수요, 운항시간 외 수요를 구분한다. 좌석 공급 부족도 운항시간 내 수요와 비교한다.
- 검증: 수요·스케줄·계획 생성 Python 45 PASS, 수요 요약 브라우저 시험 19 PASS, 변경된 생성 상태 시험 PASS. demand setup 전체 34건 중 변경 관련 33건은 통과했고, 기존 `LiveGlobe.destroy()` 문자열 형태를 검사하는 무관한 1건은 계속 실패한다. 서버를 재시작하고 demand defaults API의 24시간 곡선 24개와 합계 99.9999를 확인했다.

## 2026-09-21 UAM 도메인 진입 줌인 표시 복구

- 원인: 도메인 선택의 activateDomain이 globe.entry 완료를 기다린 뒤 선택 창과 덮개를 닫아, 서울 진입 애니메이션이 가려졌다.
- 변경: UAM 준비 단계에서 카메라 이동을 제거하고 onAfterClose에서 덮개를 숨긴 다음 기존 globe.entry를 시작한다. Satellite 전환과 reduced-motion 설정은 유지한다.
- 검증: node --test project_support/tests/web_live/browser/domain_shell.test.mjs: 16/16 PASS. 전체 browser/*.test.mjs: 2163 중 2150 PASS, 13 FAIL. 전체 실패의 변경 전 baseline 비교는 수행하지 않아 기존 실패로 단정하지 않는다. 원시 결과는 data/workspace/domain_zoom_browser_tests.txt.
- 실제 Chrome 별도 탭에서 UAM 선택 후 가림 없는 지구 화면과 서울 확대 화면을 확인했다. 사용자 기존 탭은 새로고침하지 않았고 운항 시작/초기화 및 서버 재시작은 하지 않았다.
- 남은 검증: 전체 실패 baseline 비교, 1280x720 전용 화면 검증 및 UAM 임무 validation은 미실시. 수정 범위는 진입 카메라 호출 순서뿐이다.

## 2026-09-21 버티포트 자원 보고와 PSU 경계 분리

- 버티포트별 `VertiportOperator`가 자기 FATO, 주기장과 충전시설의 운영 상태, 점유와 예약을 관리하고 `VertiportResourceReport` v1을 발행한다.
- 보고에는 버티포트·운영자 ID, 순번, 관측·유효 시각, 자원별 상태·점유자·예약자·revision이 들어간다. JSON 왕복 계약을 함께 고정했다.
- 시나리오 엔진은 실제 위치를 계산한 뒤 점유 관측만 해당 운영자에게 전달한다. PSU는 `VertiportResourceMonitor`가 받은 최신 유효 보고를 통해서만 production 경로의 FATO 가용성과 주기장 점유·예약을 판단한다.
- 주기장 예약은 PSU 내부 표를 먼저 바꾸지 않고 운영자에게 동기 요청하며, 운영자는 보고에서 본 resource revision이 여전히 맞는지 검사한 뒤 새 보고서를 발행한다.
- 웹 시나리오와 물리 fleet 조립에 시설별 운영자를 주입했다. 버티포트 관측 API에는 PSU가 받은 원본 `resource_report`를 함께 노출한다.
- 시설 폐쇄 보고는 출발을 실제로 대기시키며, 보고 누락·만료 자원은 비어 있다고 가정하지 않는다. 시나리오 reset 시 PSU 보고 캐시도 새 운항일 시각으로 초기화한다.
- 설계 결정은 `project_support/docs/adr/0104_vertiport_resource_reports.md`에 기록했다.
- 검증: 관련 PSU·시나리오·예측·도착·수동 운항·세션·버티포트 시험 312 PASS, 신규 자원 보고 시험 7개 포함. 변경 Python 파일 `py_compile` 및 `git diff --check` PASS.
- 남은 위험: 버티포트 화면의 폐쇄·재개 버튼은 아직 연습 상태이므로 운영자 API에 연결해야 한다. 별도 지상운항 전체 파일은 27 PASS / 1 FAIL이며, 실패는 반복 순서와 무관하게 `hold`를 기대하나 `land`가 나온 기존 최종 출구 허가 시나리오다.

## 2026-09-21 UAM 진입 줌인 렌더링 예산

- 진입 중 CameraRenderBudget을 비활성화하여 전체 픽셀 버퍼를 강제하던 예외를 제거했다. entryActive를 approach로 취급해 초기 0.85 배율과 기존 느린 프레임 적응/점진 복구 정책을 적용한다. 녹화와 장면 morph 예외는 유지한다.
- entry 조기 반환 전에 지형 SSE 하한 8을 적용하여 지나가는 중간 지형의 세분화를 제한한다. 정상 완료와 실패 모두 진입 전 SSE로 복원한다. 물리, 운항 상태 및 사용자 저장 설정은 변경하지 않는다.
- 집중 시험 95/95 PASS. 전체 브라우저 시험 2164 중 2151 PASS / 13 FAIL. 직전 domain_zoom_browser_tests.txt의 실패명과 시간 부분을 제거해 비교했으며 동일한 13건이다.
- 남은 검증: GPU/프레임 시간 전후 정량 비교 및 UAM 임무 validation 미실시. 해상도 축소 동안 지도가 일시적으로 부드럽게 보일 수 있다. 기존 사용자 탭과 서버는 재시작하지 않았다.

## 2026-09-21 PSU, 조종사와 Runtime 방향별 계약

- `PilotPsuRequest`, `PilotPsuReport`, `PsuPilotMessage` v1을 추가해 Pilot→PSU 요청·보고와 PSU→Pilot 응답·허가·지시를 서로 다른 불변 계약으로 구분했다. 메시지 ID, 원 요청 correlation, 발신자별 순번, 발행·만료 시각과 시설 결과를 포함하며 JSON 왕복 시 메시지 종류와 방향을 검사한다.
- 수동 조종 HTTP 요청은 브라우저가 message ID와 단조 증가 sequence를 보내도록 변경했다. 같은 ID와 같은 내용의 재전송은 기존 결과를 반환하고, 같은 ID의 내용 변경과 이미 처리한 순번은 거절한다. PSU 응답은 원 요청 ID를 참조하고 양방향 메시지를 기존 운항 event stream에 남긴다.
- 수동 축 입력, 고도·위치 유지와 자동조종 출력을 공통 `PilotVehicleCommand`로 감쌌다. `source`만 manual, assisted, automatic으로 구분하고 Runtime adapter에서만 기존 native 유도/축 호출로 변환한다. 명령 기록에는 원시 UI 입력 대신 typed 조종사 명령을 저장한다.
- 시뮬레이션 전체 시계의 `resume_day`는 PSU 허가가 아니므로 Pilot↔PSU 통신 이력에서 제거하고 별도 `simulation_clock_resumed` 실행 제어 사건으로 기록한다.
- 방향과 기능 목록, 필드, 처리 규칙은 `project_support/docs/architecture/PSU_PILOT_ICD.md`, 결정 근거는 ADR 0105에 기록했다. 기능별 숫자 코드는 사용자가 정할 후속 범위로 남겼다.
- 검증: 신규 계약 시험을 포함한 PSU 수동 절차 집중 시험 45 PASS, 관련 브라우저 시험 22 PASS, 아키텍처 검사 PASS, 변경 Python `py_compile`, JavaScript `node --check`, `git diff --check` PASS. 전체 수동 Python 시험은 151 PASS / 61 FAIL이며 61건 모두 제거된 native 수동 DLL의 직접 또는 연쇄 부재로 실패했다. 별도 관련 브라우저 묶음은 27 PASS / 1 FAIL이고 실패는 현재 소스에 이미 없는 `STEPS_PER_MESSAGE` 상수를 검사하는 기존 transport 시험이다.
- 남은 위험: 외부 PSU·원격 조종사 transport와 인증은 아직 없다. 일정 기반 native 자동비행은 기존 C++ `RoutePilotCommand` typed 경계를 유지하지만, ScenarioEngine 내부의 자동 PSU 호출 전체를 이번 Python wire 메시지로 바꾸지는 않았다. native DLL이 복구되기 전에는 실제 물리 수동 비행과 Unreal 증거를 검증할 수 없다.

## 2026-09-21 수동 비행 native DLL 복구

- 수동 비행 시작 화면의 `aerodt_uam_manual_v3.dll` 오류는 Python loader의 문제가 아니라 우선 탐색하는 v12부터 호환 fallback인 v3까지 어느 DLL도 존재하지 않아 마지막 후보 경로가 오류에 표시된 것이 원인이었다.
- Visual Studio 2022 x64 개발 환경에서 `aerodt_uam_manual` target을 다시 빌드해 `project_support/build/aerodt/windows-release/bin/aerodt_uam_manual_v12.dll`을 생성했다. 일반 PowerShell에서 바로 빌드하면 MSVC 표준 헤더 경로가 없어 실패하므로 `vcvars64.bat` 환경을 사용했다.
- 검증: 수동 비행 Python 전체 시험 212 PASS. native runtime 생성, 자동조종, 고도·위치 유지, 지상 절차, control surface telemetry, WebSocket 수동 세션과 새 Pilot command 경계까지 모두 포함한다.
- 현재 실패한 수동 비행 화면은 이미 종료된 세션이므로 화면 안내대로 수동 비행을 다시 시작해야 한다. DLL은 세션 생성 시 로드되므로 서버 재시작은 필요하지 않다.

## 2026-09-21 수동 출발 FATO 도착 판정 수정

- 실행 중인 UAM0077을 API에서 확인한 결과 VP012 F1 중심과의 수평 거리는 0.61 m, 속도는 0.0 m/s, native 접지 상태는 참이었다. 그런데 수동 Runtime의 렌더링 접촉 고도는 ellipsoid 기준 99.27 m이고 ScenarioEngine의 생성형 플랫폼 높이는 로컬 기준 35.0 m여서, 서로 다른 수직 datum을 5 m 허용오차로 비교한 기존 `at_pad`가 정상 정차를 거절했다.
- FATO 도착 판정은 수평 중심 거리 7 m와 Runtime의 접지 상태, 정지 속도를 사용하도록 분리했다. `at_pad`는 수평 포함 여부만 판단하고, 이륙 요청 단계는 접지 여부와 0.5 m/s 이하 정지를 별도로 확인한다. 수직 datum 차이를 실제 비행 고도로 잘못 해석하지 않는다.
- 비활성 사유를 하나의 “FATO 중심에 정차” 문구로 뭉치지 않고 중심까지 남은 거리, 현재 속도, 접지 상태 또는 FATO 위치 누락으로 구분했다.
- 검증: datum이 64 m 다른 접지 기체의 이륙 요청 활성화 및 허가 회귀시험과 사유 구분 시험을 추가했다. 관련 집중 시험 47 PASS, 수동 비행 Python 전체 시험 214 PASS.
- 실행 중 서버는 운항 상태 손실 가능성이 있어 자동 재시작하지 않았다. 현재 세션에 수정 코드를 반영하려면 서버를 다시 시작해야 한다.

## 2026-09-21 진입 줌인 실측 및 GPU 준비/노출 분리

- 앞선 해상도/지형 예산 조절만으로 해결되었다고 판단하지 않고 격리된 실제 Edge WebGL에서 Cesium postRender 간격과 CPU 프로파일을 수집했다. 사용자 Chrome 탭은 수정/새로고침하지 않았다. GET/HEAD/OPTIONS 외 HTTP 쓰기는 차단했고 시뮬레이션 시작/초기화는 하지 않았다.
- 측정 환경: RTX 3080 ANGLE D3D11, viewport 1718x1214, diagnostics 모드, 별도 새 프로필. HTTP routing으로 일반 브라우저 캐시와 다르며 원래 사용자 탭의 GPU 부하도 완전히 통제하지 못한다.
- 기준선 entry_baseline.json: 보이는 진입 5104.7ms, 프레임 간격 p95 9.3ms / 최대 227.9ms / 100ms 초과 5건. CPU profile에서 getProgramParameter 약 693.7ms가 관찰됐다. 평균 FPS보다 드문 shader link 지연이 문제였다.
- 비교만 수행한 후보: 후속 UAM 데이터 조회 지연, 고고도 warmup view 추가, 완료 후 다시 진입. 큰 지연이 남아서 해당 후보 코드는 제품에 반영하지 않았다.
- 적용: 선택 창/덮개 뒤에서 같은 카메라 경로를 준비하고, 레이어 숨김·입력 잠금·렌더 예산 상태를 복원하지 않은 채 선택 창이 닫힐 때 보이는 진입을 시작한다. domain_entry의 ready/reveal 장벽으로 이 순서를 고정했다. 최초 준비 대기가 약 5초 늘어나는 tradeoff가 있다.
- 실제 적용 검증 1회(entry_final.json): 보이는 구간 최대 118.9ms / 100ms 초과 1건. 당시 전체 테스트도 실행되어 CPU 부하가 겹쳤으며 개선 수치에서 제외하거나 완전 해결로 단정하지 않는다.
- 실제 적용 재검증(entry_verified.json): DOM에서 선택 창이 닫힌 프레임만 사용, 684 frames / 4278.7ms / p95 7.6ms / 최대 8.8ms / 100ms 초과 0건, 페이지 오류 0. 숨겨진 준비 프레임은 위 통계에서 제외했다. 별도 비교 후보에서도 유지된 준비 직후 최대 21.8ms / 100ms 초과 0건이었다.
- 별도 발견: reduced-motion이 꺼진 브라우저에서 DomainChooser 기본 setTimeout의 this 바인딩으로 Illegal invocation이 발생했다. globalThis 호출 래퍼로 고쳤고 회귀시험을 추가했다.
- 검증: 도메인/진입 집중 시험 50 PASS. 전체 browser/*.test.mjs 2167 중 2154 PASS / 13 FAIL. 직전 entry_budget_all_tests.txt와 정규화한 실패명 13건 동일. 준비/노출 순서, 준비 실패, 타이머 receiver 회귀 포함.
- 남은 위험: 사용자 기존 Chrome 탭에서의 체감 개선과 장시간 운용 중 GPU 경합은 미확인. 모든 PC에서 무끊김을 보장하지 않는다. 1280x720 UI 및 UAM 임무 validation 미실시. 서버 재시작 불필요, 사용자 탭 적용에는 새로고침 필요.

## 2026-09-21 생성 계획의 기체 예측 준비 시간과 진행률 수정

- 실행 서버의 완료 상태를 확인한 결과 6,392편·132대 계획은 전체 78.156초 중 native 진입 예측에 73.485초를 사용했다. 현재 4-FATO 기반시설에서는 첫 비행 132대가 실제로 421개 FATO 후보 경로를 만들며, 기존 전체 경로 키로는 408개의 native 비행을 따로 수행했다.
- 화면은 실제 예측 경로 수가 아니라 기체 수 132에서 진행률을 잘라 표시했다. 따라서 132/132와 98%가 된 뒤에도 나머지 수백 개의 예측이 계속되어 멈춘 것처럼 보였다.
- 진입 예측은 조종사가 첫 하강 구간을 선택하는 순간 끝나므로 그 이후의 하강·착륙 FATO suffix는 결과에 영향을 주지 않는다. 캐시 키를 하강 전 경로 prefix와 출발 방위로 한정해 동일 순항의 도착 FATO 변형을 한 번만 비행하도록 했다. 출발 FATO가 달라 상승 경로가 달라지는 경우는 계속 별도로 예측한다.
- 진행률은 실제 고유 native 예측 경로의 완료를 `기체 예측 경로 · n/N개`로 표시하고, 요청 순서가 아니라 완료되는 즉시 증가시킨다. 132/132 조기 완료 표시는 제거했다.
- 동일 CSV와 현재 기반시설을 사용한 native 실측에서 예측 수가 408개에서 225개로 줄었고 전체 엔진 준비는 40.832초였다. 기존 실행 서버의 예측 단계 73.485초와 비교하면 약 44% 감소했다. 대표 도착 FATO 2·4개 변형에서 기존 개별 예측값은 각각 완전히 같았다.
- 검증: 예측 병렬화·계획 생성 집중 시험 37 PASS. 시나리오 관련 확대 시험은 111 PASS / 1 FAIL이며 실패는 이번 변경 경로가 아닌 불완전한 `ScenarioEngine.__new__` fixture에 `psu`가 없는 기존 ETA cache 시험이다. `py_compile` PASS. scheduling progress 브라우저 시험은 11 PASS / 1 FAIL이며 실패는 현재 `app.js`에 이미 없는 `adoptPlan` 문자열을 요구한다. 아키텍처 시험은 로컬 Python 환경의 `commentjson` 부재로 수집하지 못했다.
- 실행 중 서버는 현재 생성 계획을 잃지 않도록 재시작하지 않았다. 변경된 시간과 진행률은 다음 서버 재시작부터 적용된다. 첫 준비는 실제 native 물리 예측이므로 0초가 되지는 않으며, 기반시설·경로·CPU 부하에 따라 실측 40초 전후가 달라질 수 있다.

## 2026-09-21 정기편 출발 의사결정의 PSU 소유권 정리

- FATO 후보별 출발·도착 대기시간 비교와 후보 선택을 `fato_assignment.choose`의 독립 판단에서 `PsuSequencer.select_departure_plan`으로 옮겼다. `fato_assignment`는 연결 가능한 FATO·항로 후보를 구성하는 역할만 유지하며 기존 호출자를 위한 함수는 PSU 메서드로 위임한다.
- 시설 보고 누락·FATO 사용 불가, 실제 패드 점유와 인접 FATO, 터미널 경로 중첩, 대기 도착편 우선순위를 출발 blocker로 해석하는 규칙을 `PsuSequencer.departure_blockers`로 모았다. Simulation은 경로 중첩과 기체 상태를 관측 자료로 만들어 전달할 뿐 hold 여부를 결정하지 않는다.
- 최종 출발 슬롯, 공용 패드 간격, 이미 진입한 도착편 우선과 허가·대기 결과를 `PsuSequencer.authorize_departure`가 반환한다. PSU 반환값은 비행체 위치를 직접 바꾸지 않으며 `ScenarioEngine`은 허가된 결과만 터미널 claim과 조종사 실행 흐름에 적용한다.
- PSU clearance 조회를 위한 read-only `clearances()`를 추가해 이번 출발 경로가 PSU 내부 딕셔너리를 직접 읽지 않게 했다. 버티포트 자원 상태의 소유권과 `VertiportResourceReport` 경계는 변경하지 않았다.
- 정기편 자동 경로의 동일 프로세스 흐름과 역할을 `PSU_PILOT_ICD.md`, `BOUNDARIES.md`, `FLIGHT_OPERATIONS.md`에 반영했다. 외부 transport나 JSON wire는 추가하지 않았다.
- 검증: 출발·FATO·PSU·버티포트·수동 절차·ScenarioEngine 집중 시험 116 PASS, 수동 비행 전체 214 PASS. 도착·터미널·시나리오 확대 시험 182 PASS / 1 FAIL / 1 SKIP이며, 실패는 `ScenarioEngine.__new__` fixture에 기존 필수 `psu`가 없는 `test_scenario_eta_cache` 한 건이다. 최종 PSU 소유권 직접 회귀시험 23 PASS, 변경 Python `py_compile` 및 저장소 아키텍처 검사 PASS.
- 실행 중 서버는 현재 생성 시나리오를 보존하려고 재시작하지 않았다. 변경된 출발 판단 경로는 다음 서버 재시작부터 적용된다.

## 2026-09-21 MBTiles 지형 보정 입력 검토

- 사용자 지정 korea.mbtiles를 SQLite mode=ro로 검사했다. 약 296 MB, Tilemaker/OpenMapTiles 계열 gzip PBF 벡터 타일, metadata zoom 0–14. DEM 높이 격자가 아니라 보정 영역을 지정할 수 있는 지도 벡터다.
- 김포 및 여의도/한강 주변 z14 각 9타일을 직접 해독하여 공항 경계·계류장 polygon, 활주로/유도로 line, 수역 polygon, 하천 line 및 도로/교량/터널 속성을 확인했다. 김포 공항 라벨에는 RKSS/GMP 및 ele=18이 있지만 검증된 활주로 표면 높이나 수직 기준으로 취급하지 않는다.
- 샘플의 water polygon class가 lake로만 나타나므로 하천/호수 분류를 class 하나로 결정하지 않는다. 타일 경계 절단/중복, 도로 폭 부재 및 누락 가능성도 고려해야 한다. 상세도 zoom 14는 측량 정확도를 의미하지 않는다.
- 권고: 원본 DEM + 벡터 경계 결합 -> 구역별 보정 -> 경계 연속성/변경량 검증 -> 사전 terrain tile 생성. 교량/터널은 일반 지표 도로 평탄화에서 제외. 원본 및 런타임 코드는 변경하지 않았으며 실제 보정/적용은 아직 하지 않았다. 파일 출처/라이선스와 DEM 수직기준 확인 필요.
- 검증 산출물: data/workspace/mbtiles_terrain_review.json. 타일별 feature 조각 집계이며 실제 시설 수가 아니다. 전체 전국 데이터의 누락·정확성 검증은 수행하지 않았다.

## 2026-09-21 터미널 지정 항로와 비행 궤적 표시 정합

- FATO 주변 도착 대기점을 넣을 때 마지막 순항점을 낮은 대기점으로 교체하던 로직을 제거했다. 계획된 순항 종점과 접근 진입점을 유지하고, 기체가 그 진입점에 도달한 뒤에만 강하 단계에서 대기점으로 이동한다. 최종 접근 권한 경로에서는 대기점을 제외하고 원래 착륙 시작점부터 사용한다.
- 출발 상승 경로는 기존 작성 순서를 그대로 사용한다. 이번 변경은 도착 대기 경로가 멀리서부터 계획 외 대각선 강하를 만들던 문제를 바로잡은 것이며, 일반 항로를 임의의 직선 단축으로 대체하지 않는다.
- 녹색 비행 궤적에 출발·도착 버티포트의 화면용 데크 기준을 전달하고, 실시간 기체와 같은 지형/데크 오프셋을 적용했다. Runtime의 물리 고도와 저장된 궤적 데이터는 변경하지 않는다.
- 계약과 책임은 ADR 0112 및 `FLIGHT_OPERATIONS.md`에 기록했다. 이 변경은 3D 건물 메시를 새 장애물 데이터로 사용하지 않으므로, 작성 항로와 건물 모델 자체가 불일치하는 경우에는 별도 장애물 데이터 보강이 필요하다.
- 검증: 지정 접근 진입점 보존·최종 접근 권한 경로 회귀시험과 궤적 API 시험 3 PASS, 궤적 시각화 시험 19 PASS, ScenarioSession 시험 26 PASS. 관련 도착 확대 시험은 45 PASS / 1 기존 tick 반올림 실패였다. 유도 확대 시험은 32 PASS / 9 FAIL / 9 SKIP이며 실패는 이번 변경 파일 밖의 현재 작업트리에 이미 존재하는 반복 전환·우측 통행 회귀다. `py_compile`과 변경 범위 `git diff --check` PASS.
- 실행 중 서버와 시나리오는 보존하려고 재시작하지 않았다. 새 경로 구성은 다음 서버 재시작 및 새 시나리오 로드부터 적용되고, 브라우저 궤적 표시 변경은 새로고침 뒤 적용된다.

## 2026-09-21 수동 출발 우선권의 제출 후 순서 보존

- 실행 중 UAM0078/FPL000105를 조회해 출발 요청이 06:37:08에 접수됐지만, 약속된 06:41:01에 도달하자 06:42:41로 다시 밀린 사실을 확인했다. 같은 출발지의 후속 자동편도 수동 요청 뒤에 새로 출발하고 있었다.
- 수동 인계 시 시뮬레이션이 이미 시작됐더라도 120초 출발 우선 기회를 부여한다. 그 안에 조종사가 출발 요청을 제출하면 허가 또는 명시적 취소까지 동일 출발지의 새 자동 출발보다 순서를 유지한다. 이미 지상 이동 중이거나 공중에 있는 기체, 실제 FATO·경로 점유와 안전 차단은 선점하지 않는다.
- 약속된 지상 출발 시각이 성숙한 뒤에는 아직 주기장에 남은 과거 예측이 해당 예약을 매 tick 뒤로 다시 보내지 못하게 했다. 실제 지상 이동·비행 중인 교통은 계속 재검토하며, 안전상 충돌하면 수동편도 대기한다. tick이 예약 시각을 조금 지난 것만으로 기록된 예약 시각을 덮어쓰지 않는다.
- ADR `manual_initial_departure_priority_v1.md`를 실제 동작에 맞게 갱신했다. 검증: 수동 우선·입장 예약·수동 절차 집중 시험 64 PASS, ScenarioEngine·접근 backpressure·용량 복구·PSU·native 접근 분리 확대 시험 57 PASS, 변경 Python `py_compile` 및 범위 `git diff --check` PASS.
- 실행 중인 기존 수동 배정에는 소급 적용하지 않는다. 다음 서버 재시작과 새 수동 배정부터 적용된다.

### 후속 실운항 재현 보완

- 새 3,745편 실행에서 FPL000001의 도착 진입 예약이 event 1로 가장 먼저 생성됐지만, 이후 다른 출발지에서 지상 이동을 시작한 FPL000008과 FPL000014를 재검토가 선행 실제 교통으로 오인했다. 수동편은 06:34:59로 밀리고, 동시에 VP012의 새 자동편은 수동 출발 우선권 때문에 멈춰 사용자가 버티포트 전체 고장으로 관측했다.
- 수동 예약보다 뒤의 진입 시각을 받은 비공중 기체는 지상 이동을 시작했더라도 예약 순서를 뒤집지 못한다. 해당 기체가 실제로 이륙하면 관측 ETA를 다시 우선한다. 따라서 수동편을 먼저 내보낸 뒤 같은 출발지 대기를 해제하면서 공중 안전은 유지한다.
- `출발 요청 취소`는 현재 요청과 예약만 취소하고 남은 120초 우선 기회까지 포기시키지 않는다. 수동 인계 해제 또는 기회 만료는 기존대로 우선권을 제거한다.
- 추가 회귀시험을 포함한 수동 우선·입장 예약 시험 32 PASS, 관련 도착·PSU·수동 확대 시험 106 PASS. 현재 실행 중 서버는 구 코드이므로 재시작 전 화면에는 적용되지 않는다.
