# ADR 0078: PRISM 2D 주변 교통 예측과 레이더

- 날짜: 2026-09-13
- 상태: 코드 및 자동 시험 반영. 운영 서버 반영과 실제 화면 검증은 미실시.

## 목적과 경계

선택 기체를 중심으로 주변 교통과 PRISM의 미래 궤적 분포를 읽기 전용으로 표시한다. UI의 분류명은 `위험 예측`이지만 모델 출력은 2D 다중 궤적, 수평 공분산과 종류 분포이다. 충돌확률, 공인 분리 기준, 회피 명령 또는 안전 판정으로 해석하지 않는다. 고도대 강조는 현재 상대 고도를 이용하는 표시 기능이며 미래 고도는 예측하지 않는다.

PRISM 원본은 변경하지 않는다. `20260815_010810_full5x_s6`의 완료된 full 모델을 선택했고, 다른 seed보다 성능이 우수하다는 주장은 하지 않는다. 가중치와 원본 코드의 해시는 모델 패키지 manifest에 기록한다.

## 소유권

- `digital_twin/model_library/prism_2d`: 모델 구조, 입력 특징, 가중치와 출처.
- `data/simulation/risk_history.py`: 이미 공개된 불변 관측의 제한된 과거 이력.
- `ai_pnp/risk_prediction.py`: 특징 조립, 능동 추론, 미래 결과 및 소규모 LRU.
- `communication/prediction_process.py`: 고정된 로컬 프로세스의 JSONL 통신.
- `communication/web/risk_routes.py`: 주입된 함수만 호출하는 HTTP 어댑터.
- `user_application/apps/web_dashboard`: World snapshot 읽기, 모델 실행 환경 및 API 조립.
- `user_application/web/risk_radar*`: 관측과 예측의 표시. 조종사, Prediction, 지도 선택이 같은 레이더를 연다.

World와 entity는 여전히 현재 상태의 단일 소유자이다. 예측 입력을 위해 별도 현재 상태 저장소를 만들거나 비행 제어를 호출하지 않는다. FastPhysics 실행 순서, SimpleFlight, Native/Unreal 코드와 운항 명령은 변경하지 않는다.

## 입력 및 계산

0.5초 간격 20개 슬롯(경과 9.5초), 슬롯당 13개 특징, 객체 슬롯 10개를 사용한다. 관측 누락은 mask로 남기며 관측이 없는 ADS-B 외삽 위치를 새로운 감지로 복제하지 않는다. 선택 기체의 연속 입력이 부족하면 `warming_up`이다.

관측 이력은 최대 512개 entity, 슬롯마다 첫 관측/최신 관측 두 개를 보존한다. 요청 시각 이후의 관측은 사용하지 않는다. 선택 기체와 우선 주변 16개에 15초짜리 보호 기간을 부여하되 전체 보호 대상은 128개를 넘지 않는다. epoch, 시간 역행, continuity 변경은 이전 이력을 끊는다. 현재 상태가 stale/frozen/invalid 또는 만료이면 과거 이력이 있어도 예측하지 않는다.

실제 항법 관측을 우선 사용한다. Simulation 상태를 사용하는 경우 `experimental_simulation_state`로 명시한다. 공분산이 없으면 표적의 등방 표준편차 10m를 가정하며, 수신 수평 표준편차가 있으면 등방 근사한다. ownship의 0.5m 표준편차는 원본의 가정이다. 이 출처들은 응답 provenance와 UI에 표시한다.

응답에는 최대 128개 가까운 교통을 포함하고, 고도대와 거리를 우선하여 한 번에 최대 16개를 배치 추론한다. 캐시는 8개로 제한한다. 원본 가중치의 3개 분기를 0.5초 간격으로 최대 15초까지 제공하며 잘못된 모양, 비유한 값, 비정상 가중치나 공분산은 배치 전체에서 거부한다.

## HTTP v1

- `GET /api/prediction/risk/config`: `{schema_version:1, settings, model}`.
- `PUT /api/prediction/risk/config`: 같은 origin에서 설정 patch 저장. 기존 라이브러리 저장과 동일 잠금/검증 경로를 사용한다.
- `GET /api/prediction/risk?entity_id=...&radius_m=3000&altitude_band_m=150&horizon_s=15`: 서버의 World snapshot을 사용한다. 클라이언트에서 위치나 모델 명령을 받지 않는다.

설정은 `enabled`, `model=prism_2d_v1`, `radius_m`(500~10000), `altitude_band_m`(0~3000; 0 또는 query `all`은 전체), `horizon_s`(5/10/15)를 가진다. UI 반경/고도대/시간 변경은 현재 보기 설정이며 라이브러리 저장은 공유 기본값이다. 기존 서버 접근 정책을 따르며 새로운 인증 체계를 추가하지 않는다.

예측 응답에는 `schema_version`, `model_id`, `status`, `reason`, `epoch`, `state_time`, `ownship_id`, 설정 값, `ownship`, `tracks`, `provenance`가 있다. ownship 및 track은 entity ID와 continuity ID, 경위도/고도/방위를 가진다. 각 track의 `prediction`은 `branches[{weight, points[{t_s,east_m,north_m,cov_ee,cov_nn,cov_en}]}]`와 종류 분포이다.

좌표는 **응답 시점 ownship**을 원점으로 하는 ENU 미터이며 공분산은 같은 좌표계의 m²이다. `t_s`는 응답 `state_time` 이후 초이다. UI에서 이동한 현재 기체에 표시할 때 원점과 공분산을 함께 재변환한다. 분기 가중치는 충돌확률이 아니다. 상태는 `ready/warming_up/unavailable/disabled`이며 관측만 있고 예측이 없으면 대체 궤적을 만들어 성공처럼 표시하지 않는다.

응답은 no-store이다. API는 threadpool에서 계산하고 서버당 한 요청만 추론하며 바쁜 경우 503으로 거부하여 계산 대기를 쌓지 않는다. 모델 설명 시 Python 준비 확인도 이벤트 루프 밖에서 실행한다.

## 로컬 실행 환경과 수명주기

웹 Python에 torch가 없어도 동작하도록 application이 별도 CPU 추론 Python을 선택한다. 배포 구성 `risk_python_executable`이 지정되면 해당 실행기를 쓰고, 빈 값이면 현재 Python과 PATH Python을 제한된 시간으로 검사한다. 개인 경로나 다른 환경의 라이브러리 복사는 저장하지 않는다. torch/numpy가 없으면 사용 불가로 표시한다.

고정 명령 `python -u -m ai_pnp.prism_worker --package <package>`만 application이 생성한다. HTTP에서 실행 파일이나 명령을 지정할 수 없다. worker는 CPU 2 threads, `weights_only=True`, strict state dict를 사용한다. JSONL v1 요청 `{schema_version:1,samples:[{x,agent_mask}]}`와 응답 `{result:...}`/`{error:...}`를 사용하고 요청 4MiB/응답 8MiB 제한 및 쓰기를 포함한 30초 timeout을 둔다. shell을 사용하지 않으며 Windows에서는 숨긴 프로세스로 실행한다. 오류와 종료 시 이 application이 만든 worker만 정리한다.

## 표시 및 부하 제한

우측 중앙의 작은 heading-up SVG 레이더를 기본으로 하고 확대, 접기 및 재열기 버튼을 제공한다. 기본 반경은 3km, 강조 고도대는 ±150m이다. 고도대 밖 교통은 흐리게 남기고 고도 미상은 별도로 표시한다. 기존 기체 정보창과 겹치거나 작은 화면에 공간이 없으면 접고 다시 열 수 있다.

브라우저당 최대 2Hz, 한 개의 대기 요청만 허용한다. 숨김/탭 비활성/선택 변경 시 요청을 취소하고 오래된 응답을 버린다. 이것은 모든 접속자를 합친 전역 2Hz 보장이 아니다. 지도 관측의 단순 갱신이 조종사 화면에서 명시적으로 고른 레이더 대상자를 덮어쓰지 않는다. 예측은 epoch와 ownship 및 주변 객체 continuity가 맞아야 표시되며 수신 지연/오래된 예측을 숨긴다. 자체 simulation이나 위치 외삽 루프를 추가하지 않는다.

## 검증과 남은 범위

실제 가중치로 원본 특징 x/mask/frame과 신경망 5개 raw 출력의 완전 일치를 확인했다. 웹 venv에서 별도 Python worker를 통한 실제 HTTP 추론도 합성 snapshot으로 검사했다. 관측 누락, 과거 시점 요청, 이력 용량 초과, stale/continuity, 잘못된 출력, timeout, 설정과 UI 수명주기에 대한 회귀를 추가했다.

이식의 수치 일치가 실제 교통 정확도나 불확실성 보정을 증명하지는 않는다. 합성 입력 및 로컬 CPU 단위 측정만 수행했다. 실제 운영 브라우저 시각/성능 확인, 원격 배포, 운영 서버 재시작, 새 UAM 임무 및 Unreal 검증은 수행하지 않았다. 운영 반영에는 서버 코드 재로딩과 프런트엔드 새 파일 로딩이 필요하다.
