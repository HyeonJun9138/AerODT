# PRISM 2D 주변 교통 레이더 구현 계획 (2026-09-13)

승인된 설계: 비행체 선택 시 우측 중앙 heading-up 3km 레이더. 크기/숨김/반경/고도대 조정, 주변 교통과 5/10/15초 다중 궤적 및 불확실성. Prediction 및 모델 라이브러리, 조종사 진입 연결. 자동 회피/비행 제어 제외.

Architecture: 데이터 이력은 data, 모델 정의/가중치는 model_library, 능동 추론은 ai_pnp, API 조립은 user_application, HTTP는 communication, UI는 user_application/web. PRISM 원본은 읽기 전용. 현재 World는 복제/변경하지 않는다. 표시상 위험과 충돌확률을 혼동하지 않는다. 관측 공분산 대체/시뮬레이션 입력과 학습 분포 차이는 명시한다.
Tech: 기존 Python/FastAPI/PyTorch(선택 의존), Canvas/SVG/JS. 별도 클라우드 모델/API 없음.

## Task 1: 모델 패키지 + 이력 + 추론
- model_library/prism_2d: 선택 근거 및 원본 SHA, 모델/특징 코드 최소 포팅, 실행 가능 체크.
- data/simulation/risk_history.py: 0.5초 관측 이력20점, 누락 mask, stale/epoch 분리, 메모리 상한.
- ai_pnp/risk_prediction.py: RiskPredictionRunner.observe(snapshot), predict(snapshot,entity_id,radius_m=3000,horizon_s=15,altitude_band_m=150). 주변 최대16개 배치, 추론 single flight/LRU, 입력/결과 provenance.
- 회귀 먼저 작성, 원본 특징/신경망 입출력 비교, 실제 artifact smoke.

## Task 2: 레이더 컴포넌트
- user_application/web/risk_radar.js/css: constructor({document,getJSON,onSettings}), select(entity), observe(snapshot), open(), hide(), destroy(). 선택/epoch 변경 abort, 숨김/탭 hidden 중 요청 중지. 단일 pending. Canvas는 표시만 부드럽게, 추론은 2Hz 이하.
- heading-up 현재 위치/방위/상대고도, 범위 밖 고도 흐리게/unknown 별도. compact/expanded/collapsed, 객체 클릭 detail, 범례와 모델 대기/오류 명시. DOM 안전 textContent.
- 브라우저 모사 및 순수 투영/응답 순서/수명주기 tests.

## Task 3: 조립 및 설정
- communication/web/risk_routes.py injection-only GET forecast + GET/PUT settings same-origin.
- application.py: runner instance, snapshot commit observe, API threaded inference. 추가 추론은 요청시만.
- risk 설정은 enabled/model_id/radius_m/altitude_band_m/horizon_s, 검증/저장. ai_models 위험 예측 job 등록.
- app.js 선택/observe/조종사/Prediction 진입을 동일 radar에 연결. index CSS 및 cache.
- 통합 tests, 가능하면 독립 preview 시각검증(사용자 비행/서버 조작 금지), ADR 및 CURRENT/HISTORY 기록.

## v1 UI response 계약
{schema_version:1,model_id,status,reason,basis,epoch,state_time,ownship_id,radius_m,horizon_s,ownship:{entity_id,latitude_deg,longitude_deg,altitude_m,heading_deg},tracks:[{entity_id,name,latitude_deg,longitude_deg,altitude_m,heading_deg,distance_m,relative_altitude_m,status,reason,prediction:{branches:[{weight,points:[{t_s,east_m,north_m,cov_ee,cov_nn,cov_en}]}],type_probabilities:[]}}]}
- 예측 좌표는 응답 ownship 위치를 원점으로 하는 ENU metre. covariance도 ENU m². 시간 t_s는 state_time 이후 초.
- status ready/warming_up/unavailable/disabled; 개별 track status도 같은 상태. UI는 모델 미출력을 추정 성공으로 채우지 않는다.
- 입력 처리/계산/연결 상세는 ADR에 남기고 표시에는 요약.

Ruling: 기존 변경이 누적된 사용자의 현재 작업 폴더에서 지정 파일만 수정한다. 새 worktree로 미반영 변경을 누락하지 않는다. 서비스 재시작/원격 배포/실제 비행 실행은 이 작업의 자동 단계가 아니다.

## 구현 및 검증 현황

- [x] Task 1: 실제 가중치 포팅, 관측 이력 및 추론. 원본 특징/네트워크 수치 일치와 현재 상태 불변 검증.
- [x] Task 2: heading-up SVG 레이더, 고도 강조/상세/반경/시간/접기/확대, 수명주기와 좌표/공분산 회귀.
- [x] Task 3: 지도/조종사/Prediction/모델 라이브러리 연결, 설정 및 API, torch 미설치 웹 환경의 격리 CPU worker.
- [x] 독립 코드 검토 후 이력 용량 초과, 요청 시점 이후 입력, stale 및 주변 continuity, 이벤트 루프 준비 대기, 조종사 선택 덮어쓰기 보완.
- [x] ADR 0078 및 계층 경계 문서 갱신. 최종 명령과 결과는 개발 로그 evidence에 기록.
- [ ] 실제 운영 화면의 시각/성능 검증. 독립 file preview의 브라우저 접근이 차단되어 성공으로 기록하지 않는다.
- [ ] 운영 서버 재시작 및 원격 반영. 사용자 실행 중인 서비스와 비행을 변경하지 않았다.

보완된 wire v1은 ownship/각 track의 `continuity_id`를 포함한다. UI 2Hz 상한은 브라우저당이며 여러 사용자를 합친 전역 상한을 뜻하지 않는다. 서버는 single-flight busy 거부로 요청 적체를 막는다. 입력 누락은 대기 상태로 드러내고 추정 성공처럼 대체하지 않는다.
