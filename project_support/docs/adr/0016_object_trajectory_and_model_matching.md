# ADR 0016: 선택 대상의 궤적 자원과 위성 3D 모델 매칭

- 날짜: 2026-09-08
- 상태: 적용
- 범위: Live Twin의 경로 계산과 모델 배정, Communication의 읽기 전용 자원 하나, Visualization의 경로 표시. Native FastPhysics/SimpleFlight/Unreal, 기체 package, 수집 자산 원본과 권리 설정은 변경하지 않는다.

## 문제

대상을 선택해도 현재 상태값만 보였고 어디서 와서 어디로 가는지는 알 수 없었다. 위성은 16,509개 전부가 같은 임시 대표 형상 하나를 사용해 ISS와 파편이 같은 모양으로 보였다. 3D 미리보기 창은 지도와 같은 Cesium 로고를 한 번 더 표시했다.

## 결정

1. **궤적은 궤도를 전파할 수 있는 대상에만 제공한다.** `digital_twin/live_twin/trajectory.py`가 현재 상태와 같은 모델로 경로를 만든다. 위성은 같은 GP를 SGP4로 전파해 현재 시각 앞뒤 한 궤도(최대 6시간)를 지구고정계로 표본화하고 GP 유효 한계에서 끊는다. 항공기 상태에는 저장된 항로가 없고 60초 등속 외삽은 항로가 아니므로 경로를 만들지 않는다. 브라우저는 궤도를 전파하거나 속도를 외삽하지 않으며, 경로가 없는 종류에는 요청도 보내지 않는다.
2. **표본은 현재 위치 주변에서 촘촘하다.** 표본 사이를 직선으로 이으면 호를 `현 chord²/(8r)`만큼 가로지른다. LEO에서 31초 간격은 약 957 m라 근접 확대에서 위성이 선 위아래로 오르내려 보인다. 현재 시각 ±240초는 2초 간격(약 4 m), 나머지 호는 기존 간격을 유지하고 전체를 600점으로 제한한다.
3. **읽기 전용 자원 하나로 제공한다.** `GET /api/live/trajectory/{entity_id}`가 `schema_version=1`, `reference_frame=ecef_m`, `derivation=gp_propagated`, `points`(`[시각, x, y, z]`), `span_seconds`, `valid_until`, `summary`, `note`를 돌려준다. 알 수 없는 대상과 경로가 없는 대상은 404다. 선택한 대상 하나만 요청하며 snapshot wire v1은 그대로다. 표시에는 궤도 주기·원지점·근지점·경사각·궤도 기준 시각 경과와 함께 "실제 측정 궤적이 아니다"를 남긴다.
4. **위성 모델은 카탈로그 항목으로 배정한다.** `digital_twin/model_library/visual_models/satellite_matching.json`에 ICDCDT 위성 모델 manifest의 규칙을 AeroDT 자산 ID로 옮겼다. NORAD 번호/이름의 정확 일치, 동일 계열, 계열군(별칭) 순으로 판정하고 실패하면 종류(정거장·큐브샛)와 궤도권(LEO/MEO/GEO/HEO) 대표 형상을 쓴다. 로켓 본체와 파편은 모델을 배정하지 않고 점으로만 표시한다. 판정은 GP 카탈로그를 컴파일할 때 한 번 수행하며 매 tick 반복하지 않는다.
5. **배정은 실제로 공개되는 자산으로 제한한다.** 권리 검토 대기 자산은 배정 대상에서 제외하고 다음 순위 대표 형상으로 내려간다. 결과는 entity의 `visual_match`(`exact`/`series`/`representative`/`none`)로 함께 보내며 상세 패널이 "해당 대상의 대표 모델", "동일 계열 모델", "대표 형상", "모델 없음"을 구분해 표시한다. 이는 표시 배정이며 실제 기체 식별이 아니다.
6. **엔진 credit은 페이지에 한 번만 둔다.** 3D 미리보기 widget의 credit은 전용 sink로 보내고 지도·엔진 출처는 기존 footer의 `#map-credits`가 계속 표시한다. 미리보기는 로컬 GLB만 그리므로 같은 로고를 창 안에 다시 넣지 않는다.

## 계층 경계

Data는 원본 GP와 항공기 응답만 보유한다. Live Twin이 경로와 모델 배정을 계산하고, runtime `TwinWorld`가 현재 상태의 소유자로 남는다. Communication은 계산 결과를 버전이 있는 자원으로 중계만 한다. Visualization은 받은 점들을 그리고 갱신 주기(항공기 20초, 위성 180초)만 관리한다. 모델 매칭 규칙은 model_library의 정적 정의이며 런타임 상태가 아니다.

## 한계

- 궤적은 저장된 모델의 계산 결과다. 위성은 GMST 회전만 적용한 시각화용 근사다.
- 현재 위치에서 멀어진 구간은 표본 간격이 넓어 최대 약 957 m 안쪽으로 호를 가로지른다. 전지구 시야에서는 보이지 않지만 그 구간까지 확대하면 같은 현상이 남는다.
- 항공기 항로는 공급자 상태에 없다. 실제 비행 항로를 그리려면 별도의 track/flight 자료가 필요하며 요청 횟수가 늘어난다. 이번 범위에서는 하지 않았다.
- 위성 배정의 다수는 `representative`다. 실측 카탈로그 16,510개 기준 정확 일치 31개, 동일 계열 19개이며 Starlink·OneWeb 계열은 해당 버스 모델이 권리 검토 대기라 LEO 대표 형상으로 내려간다. 권리가 정리되면 규칙 변경 없이 그 모델이 사용된다.
- `visual_match`는 wire v1에 추가된 선택 필드다. 기존 소비자는 무시해도 되며 transport projection의 정적 metadata로 전달된다.
- 항공기는 공급자 상태에 기종 정보가 없어 대표 A320 형상을 유지한다. 기종 매칭은 별도 자료가 필요하다.
- 규칙 출처: `D:\ICDCDT`의 `user_application/web/assets/models/manifest.json`과 `scripts/orbit/satellite_models.js`. 모델 파일 자체는 이미 수집된 AeroDT 자산을 사용하며 새로 복사하지 않았다.
