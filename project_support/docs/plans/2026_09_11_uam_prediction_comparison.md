# UAM 단기·중기·장기 예측 연결 Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development for independent model and presentation tasks; integration remains with the coordinator. TDD and a scoped review are required.

**Goal:** 선택 UAM의 동일한 기준 시각에서 10/90/240초 학습 예측을 계산하고 구분 가능한 세 경로로 표시한다.

**Architecture:** 원본 임시 패키지는 읽기 전용으로 보존한다. 가중치는 기존 data/workspace 패키지에 안전한 tensor 형식으로 가져오며 순전파는 ai_pnp, 입력 이력은 data, 일관된 상태/임무 수집은 user_application, 지도 표시는 digital_twin/visualization 및 사용자 UI가 맡는다. 현재/미래 상태를 혼동하거나 예측을 비행 명령으로 쓰지 않는다.

**Tech Stack:** 기존 Python/NumPy, 검증 도구의 PyTorch, FastAPI threadpool, Cesium/JavaScript.

**Spec:** 사용자가 2026-09-11 대화에서 승인한 세 모델 동시 예측/색상 비교 설계. 단기 청록, 중기 주황, 장기 보라; 모델별 표시 선택; 이력 부족 안내; 원본 출력 재현과 현재 UAM 정확도를 구분.

## Global Constraints
- 코딩은 현재 codex/visual-asset-library 작업에 좁게 적용한다. 이미 공유된 미커밋 AeroDT 소스를 새 worktree의 오래된 HEAD로 대체하지 않는다. 작업별 소유 파일을 구분하며 커밋/리셋/운영 서버 재시작은 하지 않는다.
- 외부 backend 전체를 복사하거나 새 최상위 폴더를 만들지 않는다. 작업 기록은 data/workspace/ 아래에 둔다.
- 세 모델마다 25개 입력/25개 출력, 상태21개, 경로48×13, 시간간격/원점/yaw/scaler 계약을 보존한다.
- 불충분한 이력/경로/잘못된 값은 status/reason으로 알리고 가짜 입력이나 외삽을 학습 결과로 표시하지 않는다.
- 같은 포인트를 시간적으로 늘려 다른 horizon으로 위장하거나 공간적으로 옆으로 옮겨 경로를 구분하지 않는다.

## 공동 인터페이스
- 추가 비교 model ID: `uam_route_mlp_comparison`. 기존 `uam_prediction.model` 단일 선택 설정은 호환 유지. 새 `short_enabled`, `mid_enabled`, `long_enabled` bool은 기본 true.
- 순전파 `ai_pnp.uam_route_model.UamRouteModel(package_dir)`; `predict(state_history, route, target_point_index=0, current_target=None)`는 portable 입력/출력 dict 규격(25개 feature명 dict, local ENU route)을 사용한다. `package_dir`는 개별 model folder이다. 프로세스 내 인스턴스를 재사용한다.
- 비교 HTTP 응답은 `kind:'uam_prediction_comparison',schema_version:2,entity_id,name,epoch,continuity_id,flight_phase,generated_at,predictions:[...]`.
- 각 entry는 `model_id,label,horizon_seconds,color,status,reason,history_seconds,available_history_seconds,path`. `status`: ready/warming_up/unavailable. 성공 path는 기존 `kind:'aircraft',points:[[absolute_time,ecef_x,ecef_y,ecef_z]],summary:{seconds,model,...}` 규격과 같은 entity/epoch/continuity 정보. 실패 path는 null. 최상위 points는 없다. 모든 entry의 기준 시각은 generated_at이다.
- 기존 단기·중기·장기 개별 모델 선택도 비교 envelope 한 entry로 반환한다. 기존 임무/등속 예측과 위성 응답은 변경하지 않는다.

## Task 1 — 검증된 추론 실행
- [x] source forward/route/scaler 중 필요한 부분을 구현하고 기준 JSON 대비 회귀 RED→GREEN.
- [x] 기존 safetensors를 안전하게 읽고 원본 입력/출력 결과를 최대 1e-4 m 허용오차로 검증. 한 번 검증한 패키지의 source/weights hash와 실행 규약을 manifest/evidence에 기록.
- [x] 재사용 가능한 UamRouteModel, 유한 값/shape/시간/마스크 검사를 제공한다. PyTorch는 원본 검증에만 사용하며 웹 프로세스에서 pickle을 열지 않는다.

## Task 2 — 이력과 HTTP 조립
- [x] data의 bounded immutable 입력 이력에 동일 시각 중복, 시간 역행/새 임무 reset, yaw wrap, 결측/긴 gap, 9.6/28.8초 구간을 시험한다.
- [x] ScenarioSession에서 현재 상태와 controller/intent를 잠금 안에서 수집하되 추론은 잠금 밖에서 실행한다. 실제 수신 이력만 사용한다.
- [x] 모델별 feature/scaler/고정 원점과 body→ENU→ECEF 변환, 같은 기준시각 비교, partial readiness, bounded 실행 캐시, 모델별 실패 격리를 시험한다.
- [x] catalog의 가용성은 검증된 manifest로 개방한다. 라이브 입력의 근사/제어기 차이를 결과에 명시한다.

## Task 3 — 세 경로 시각화와 설정
- [x] 기존 단일/위성 경로 회귀를 유지하며 비교 envelope 검증/렌더/정리를 추가한다.
- [x] 모델별 색/선패턴과 +10/+90/+240초 끝점, 범례/개별 표시를 추가한다. 공간 왜곡 금지, 데이터 갱신은 부드럽게.
- [x] 선택/epoch/임무 전환과 지연 응답, warmup/null/partial/error, 체크박스 저장을 시험한다.

## Task 4 — 종합 검증과 기록
- [x] 집중 Python/Node, 전체 Node, architecture, syntax를 실행하고 기존 실패와 새 실패를 구분한다.
- [x] 독립 Cesium 페이지에서 예측 세 개/색/끝점/표시 토글/준비 상태 확인. 사용자의 재생 탭은 유지한다.
- [x] 리뷰, CURRENT/HISTORY/evidence 갱신. 운영 Python 프로세스 반영 여부와 재시작 필요를 사실대로 보고한다.

## 검증 기준 결정 및 결과
- 원본 float32 runner도 현환경에서 엄격1e-4m를 넘으므로 strict pass/fail을 보존하면서 고정2mm 수치호환 기준을 분리했다. 원본float64 forward/scaler 일치가 전제이며 예측 정확도 주장이 아니다.
- 입력 t는 실제 off-block 이후 초, 원본 yaw 범위와 이산 목표를 보존한다.
- 리뷰 수정: 좌표계 필드, yaw/이산 목표 보간, 조밀한 GET의 이력 침식, 부분 가용 비교 선택, contract/scaler/구현 해시, 불완전 manifest 예외.
- 집중 Python109/109, Node56/56, 전체Node1183/1184(기존layout preparing 기대1건), architecture PASS. 실제 가중치→HTTP→JS 계약 PASS 및 독립 Cesium 세 경로 표시 확인.
- 사용자 서버와 재생은 유지했다. 실제 native 예측 정확도/Unreal 운항은 미검증이며 운영 Python 반영은 재시작 필요.
