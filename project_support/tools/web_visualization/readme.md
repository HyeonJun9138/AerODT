# 웹 시각화 재현 검사

프로젝트 루트에서 `python main.py --no-browser`로 개발 서버를 실행한다. 기존 공급자 설정을 그대로 사용하며 CelesTrak 재시도나 credential 변경은 하지 않는다. 비교 시 다른 GPU 작업과 브라우저 탭의 렌더링을 최소화한다.

## Entity 렌더링 비교

1. `performance_check.html`을 `user_application/web/performance_check.html`로 임시 복사한다.
2. `/api/live/snapshot`을 한 번 받아 JSON을 gzip으로 압축해 `user_application/web/performance_snapshot.json.gz`에 둔다. 전후 시험에서 **같은 파일**을 재사용한다. 원본 snapshot을 커밋하지 않는다.
3. `http://127.0.0.1:8766/static/performance_check.html`을 같은 브라우저, 같은 창 크기로 연다.
4. Ready 후 Run benchmark를 누른다. 3개 시점마다 4.5초 안정화와 14초 측정을 수행한다. terrain/building/place-name overlay는 분리 측정을 위해 끈다. 해당 설정은 운용 UI 기본값을 변경하지 않는다.
5. 화면 JSON을 `data/workspace/performance`에 저장한다. `positionCpu`는 프레임당 작업이며 `lodCpu`는 호출당 작업이다. 분산 LOD는 여러 호출로 한 스캔을 완료하므로 단일 호출 수치만으로 전체 계산량을 비교하지 않는다. 실제 `frames`와 함께 읽는다.

## 통합 검증

`terrain_check.html`도 같은 방법으로 임시 복사한다. SF/서울의 실제 DEM와 OSM 건물, Ground clearance, 실제 수신 aircraft의 대표 모델 및 tracking, 레이어 숨김/복원을 확인한다. Sample DEM은 현재 카메라 좌표를 가장 상세한 지형과 한 번 대조한다. 이 점 검사는 전세계 고도 정확도 보증이 아니다. 고도는 타원체 기준이며 해수면고도와 다르다.

이 HTML들은 검증 도구이지 운용 기능이 아니다. 선택한 항공기 모델은 시각화용 대표 형상이며 수신 데이터로 실제 기종이 확인된 것이 아니다. 지면 clearance는 건물 내부 충돌 방지와는 별개다.

## 카메라 탐색 CPU 및 실제 GLB 확인

`navigation_performance_check.py`는 별도의 `127.0.0.1:8892` 읽기 전용 검증 서버다.
`data/workspace/navigation_benchmark`의 `snapshot.json`, `assets.json`, `routes.json`을
고정 입력으로 사용한다. 각각 로컬 대시보드의 `/api/live/snapshot`, `/api/visual-assets`,
`/api/simulation/routes` 응답 형식이며, 이 도구가 운용 서버나 인증 파일을 읽지는 않는다.
Python으로 실행한 뒤 `/qa/navigation_performance_check.html`을 연다.

- CPU 비교는 항로 픽셀 크기 갱신과 엔티티 LOD만 150회 실행하고 초기 20회를 제외한다.
  전체 프레임 시간이나 FPS가 아니며, 비교 전 모델 표시를 꺼 놓은 초기 화면을 사용한다.
- 선택 접근 및 회전 검사는 실제 라이브러리 GLB를 사용하되 지형, 건물 및 실시간 수신은
  제외한다. UAM이 없는 입력에는 표시 시험용 AirTaxi 하나만 추가하며 비행을 실행하지 않는다.
- 브라우저 비활성 창의 스케줄링과 첫 GLB 준비 지연도 포함되므로 완료 여부, 카메라 좌표의
  유효성, 모델 준비, 추적 유지와 최종 해상도 복원을 확인한다. 전체 앱의 성능 보증이 아니다.
- 미리보기 검사는 메인 지도의 렌더 루프를 끄고 실제 GLB 미리보기만 측정한다. 첫 준비
  1.5초를 제외한 정지 1.2초와 방향키 입력 후 1.2초의 실제 그리기 횟수를 비교한다.
  다른 카메라 검사를 다시 하려면 페이지를 새로 연다.
- 완료 후 화면의 **검증 종료**로 Cesium을 해제하고 검증 서버만 종료한다. 운용 서버는 건드리지 않는다.

## 통신 Worker CPU 검사

```powershell
node project_support/tools/web_visualization/measure_worker.mjs
```

현재 개발 서버의 상태를 받아 실제 Node worker_threads를 이용해 JSON 해석, transferable, 메인 복원 비용을 비교한다. **브라우저 FPS나 GPU 성능 시험은 아니다.** 결과는 `data/workspace/performance/worker_transport.json`에 저장한다. 초기 metadata 비용과 반복 갱신 비용을 구분한다.

시험 후 임시 복사한 HTML과 `performance_snapshot.json.gz`를 `user_application/web`에서 제거한다. 소스 도구와 측정 요약은 보존하되 원본 snapshot과 screenshot 등 큰 결과물은 `data/workspace`에만 둔다.


## Hover 및 상세 패널 재현 검사

1. `inspection_check.html`과 `inspection_check.js`를 `user_application/web`에 임시 복사하고 실행 중인 로컬 서버의 `/static/inspection_check.html`을 연다.
2. 이 화면의 위치와 속도는 **명시적 시험 입력이며 실제 항공기/위성 상태가 아니다**. 위성의 3 km 고도도 표시 시험용이다. 외부 항공 데이터나 credential을 요청하지 않는다. 기존 공개 시각 자산 카탈로그와 GLB만 사용한다.
3. `Hover aircraft`는 실제 Cesium MOUSE_MOVE handler에 화면 좌표를 전달한다. `Inspect result`에서 `hoverVisible=true`, `pointOutline=1.5`, `previewCanvases=0`을 확인한다.
4. `Select aircraft`/`Select satellite`는 LEFT_CLICK picking 경로를 실행한다. 대표 모델 렌더링과 상태 필드를 확인하고, 프리뷰를 드래그하거나 포커스를 주어 방향키 및 +/-를 시험한다.
5. `Broken preview`로 GLB 404를 의도적으로 발생시켜 썸네일 대체를 확인한다. 이 경우 console의 404는 시험에서 의도한 오류다. 빠르게 항공기/위성을 전환한 뒤 닫고 `previewCanvases=0`, `totalState=2`인지 확인한다.
6. 390×844에서 패널의 닫기/하단 버튼과 내부 스크롤을 확인한다. 별도로 실제 운용 화면에서 기체 클릭, Esc 닫기, 데이터 갱신, 새 로딩 화면을 확인한다.
7. 시험 후 임시 복사한 두 파일만 제거한다. 이 폴더의 원본 도구는 남긴다. 브라우저의 임시 viewport override도 해제한다.

## 항공기 움직임 재생 비교

```powershell
& project_support/environment/web_venv/Scripts/python.exe project_support/tools/web_visualization/replay_live_twin.py --label after
node project_support/tools/web_visualization/replay_display_motion.mjs --label after --timing data/workspace/performance/aircraft_motion_after.json --motion data/workspace/performance/aircraft_motion_before.json
node data/workspace/performance/probe_aircraft_motion.mjs after
```

- `replay_live_twin.py`: 25초 주기·12초 지연 관측, 한 번의 수신 누락, 100초 단절이 있는 선회 항공기 하나를 1초 tick으로 Live Twin에 재생한다. stale·정지·점프 tick과 불연속 횟수(부드러움)와 진실 대비 오차(재현 정확도)를 구분해 `data/workspace/performance/live_twin_replay_<label>.json`에 저장한다. `--module`, `--catalog`로 다른 구현을 같은 입력에 적용해 비교한다. 외부 요청은 없다.
- `replay_display_motion.mjs`: probe가 기록한 실제 도착·상태 시각으로 화면 보간 계층만 재생한다. 움직임은 기록된 항공기 속도로 합성하므로 서버 추정이 아니라 표시 계층의 정지 프레임 비율, 점프, 역행, 표시 지연을 측정한다. `--module`로 이전 구현과 비교하고 `--motion`으로 항공기 속도를 담은 다른 probe 파일을 지정한다.
- `probe_aircraft_motion.mjs <label>`: 실행 중인 서버의 `/ws/live`를 50초 수신해 도착 간격, 공급자 갱신 간격, stale 비율, 불연속 프레임을 기록한다.


## 글자 진행률 로딩 화면 검증

- `loading_check.html`을 `user_application/web`에 임시 복사하고 기존 서버의 `/static/loading_check.html`에서 확인한다. 실제 로딩 HTML/CSS와 LoadingScreen을 재사용하되 진행률은 명시적 디자인 시험 입력이다. 외부 데이터 수집은 하지 않는다.
- 0/45/90/100% 버튼으로 글자 clip과 접근성 진행률을 확인하고 오류→다시 시도, 완료 전환을 시험한다. 390×844에서도 제목과 진행 글자가 잘리지 않아야 한다.
- 실서비스 `/`에서 실제 준비 단계 이후 메인 화면 전환을 별도로 확인한다. `prefers-reduced-motion`에서는 즉시 전환하는 것이 정상이다.
- 확인 후 임시 HTML만 지우고 viewport override를 복원한다. 재현 원본은 이 폴더에 유지한다.

## 상호작용 끊김 프로브 (실제 Chrome)

`interaction_stutter_check.mjs`는 Playwright로 별도 Chrome을 띄워 운영 페이지(`?diagnostics`)를 그대로 조작하며 단계별로 측정한다.
지도 로딩, 휠 확대/축소, 드래그 회전·기울임, 버티포트로 비행, 버티포트 배치(커서 추종·우클릭 도구·슬라이더), 저장된 버티포트 수정, 항로 편집(호버·지점 추가), 스냅샷 수신 대기, 모델 등장, 기체 카메라 창 순서다.

```bash
node project_support/tools/web_visualization/interaction_stutter_check.mjs --url http://127.0.0.1:8766/?diagnostics --label after --root D:/AeroDT --vertiport VP001
```

- `--root`를 주면 `/static`, `/visualization`, `/communication`의 JS/CSS를 그 폴더에서 서빙하므로, 같은 서버·같은 데이터로 두 소스 트리를 비교할 수 있다(운영 페이지의 캐시는 건드리지 않는다).
- 서버에는 GET과 상태를 바꾸지 않는 두 POST(`/api/simulation/vertiports/preview`, `/api/simulation/routes/conflicts`)만 보낸다. 저장·삭제·시나리오 제어는 204로 막고 횟수를 기록한다.
- 단계마다 `postRender` 프레임 간격, `PerformanceObserver` long task, 표시 메서드 실행 시간(`cpu`), WebGL 호출(`glCalls`: `getProgramParameter`가 Direct3D 프로그램 링크 대기)을 남긴다. 결과는 `data/workspace/performance/interaction_stutter_<label>.json`과 단계별 PNG.
- 이 PC는 원격 데스크톱 32 Hz라 30~32 fps가 상한이다. fps보다 `longTasks`, `frame.maxMs`, `glCalls.getProgramParameter.totalMs`를 비교한다.
- 패널 버튼(모드·탭·지도에서 선택·항로 추가)은 Playwright 클릭이 5 s 안에 되지 않으면 스크립트 클릭으로 누른다(측정 대상은 표시이지 포인터가 아니다). 그래도 단계가 실패하면 `phases[*].failure`에 남으므로, 수치를 읽기 전에 이 필드와 `mapLoad.resources.slowest[].start`(페이지 시작이 늦은 실행: 서버가 바빴던 것)를 먼저 확인한다.
