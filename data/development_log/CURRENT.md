# AeroDT 현재 개발 상태

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

## 2026-09-21 MBTiles 지형 보정 입력 검토

- 사용자 지정 korea.mbtiles를 SQLite mode=ro로 검사했다. 약 296 MB, Tilemaker/OpenMapTiles 계열 gzip PBF 벡터 타일, metadata zoom 0–14. DEM 높이 격자가 아니라 보정 영역을 지정할 수 있는 지도 벡터다.
- 김포 및 여의도/한강 주변 z14 각 9타일을 직접 해독하여 공항 경계·계류장 polygon, 활주로/유도로 line, 수역 polygon, 하천 line 및 도로/교량/터널 속성을 확인했다. 김포 공항 라벨에는 RKSS/GMP 및 ele=18이 있지만 검증된 활주로 표면 높이나 수직 기준으로 취급하지 않는다.
- 샘플의 water polygon class가 lake로만 나타나므로 하천/호수 분류를 class 하나로 결정하지 않는다. 타일 경계 절단/중복, 도로 폭 부재 및 누락 가능성도 고려해야 한다. 상세도 zoom 14는 측량 정확도를 의미하지 않는다.
- 권고: 원본 DEM + 벡터 경계 결합 -> 구역별 보정 -> 경계 연속성/변경량 검증 -> 사전 terrain tile 생성. 교량/터널은 일반 지표 도로 평탄화에서 제외. 원본 및 런타임 코드는 변경하지 않았으며 실제 보정/적용은 아직 하지 않았다. 파일 출처/라이선스와 DEM 수직기준 확인 필요.
- 검증 산출물: data/workspace/mbtiles_terrain_review.json. 타일별 feature 조각 집계이며 실제 시설 수가 아니다. 전체 전국 데이터의 누락·정확성 검증은 수행하지 않았다.
