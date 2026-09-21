# ADR 0014: 지형과 화면 범위 기반 웹 시각화

- 날짜: 2026-09-08
- 상태: 적용
- 범위: 웹 시각화와 브라우저 통신. Native FastPhysics, SimpleFlight, 모델 package, 수집 자산 원본은 변경하지 않는다.

## 문제

OSM 건물을 기본 타원체 위에 표시하여 실제 지표와 건물 기초 높이가 맞지 않았다. 또한 약 2.5만 개 대상의 위치를 매 프레임 갱신하고, 전체 LOD 판정 및 큰 JSON 해석을 메인 스레드에서 한 번에 수행했다. 화면 밖의 대상도 매 프레임 계산되어 확대해도 비용이 줄지 않았다.

## 결정과 역할

1. Communication은 고정된 Cesium ion asset 1(World Terrain), 96188(OSM Buildings)의 endpoint만 중계한다. 루트 credential은 서버에 남고 브라우저에는 해당 asset에 한정된 임시 token만 전달한다. 새 read-only 경로는 `/api/visualization/terrain/endpoint`이다. 기존 건물 경로와 Live snapshot wire v1은 유지한다.
2. Visualization의 `terrain_layer.js`는 지형 provider 생명주기, 제한 시간, 재시도와 표시 상태를 맡는다. `building_layer.js`는 현재 뷰의 지형 준비 여부를 받아 건물 표시를 결정한다. 지형 오류 시 정상 정합으로 표시하지 않는다.
3. 카메라는 타원체가 아니라 현재 렌더된 지형과 ray를 교차시켜 확대 거리를 구한다. 지표 높이에 최소 20 m의 clearance를 더해 카메라를 보정한다. 항공기/위성의 관측 고도는 절대로 임의 보정하지 않는다.
4. `entity_scene.js`는 원본 상태를 삭제하지 않고 표시 대상만 선별한다. 화면 frustum(12% 여유), 지구 뒤쪽, 고도별 표시 거리와 5 px 화면 밀도 제한을 조합한다. 항공기/위성 collection 및 밀도 예산을 구분하고 선택 대상을 우선한다.
5. LOD 스캔을 프레임당 최대 4,000개로 나눈다. 전지구 점 위치는 10 Hz, 근접 점은 20 Hz, 선택 대상과 실제 모델은 렌더 프레임 주기로 갱신한다. 숨겨진 대상도 저주기 스캔에서 최신 표시 위치를 평가하므로 화면에 다시 들어올 수 있다.
6. 모델은 화면상 크기 6 px에서 진입하고 4 px에서 이탈하는 hysteresis를 사용한다. 모델 16개, 동시 로드 2개, 짧은 재사용 캐시 24개를 상한으로 삼는다. 실제 미터 배율을 유지하며 멀리 있는 선택 모델이 subpixel이면 선택 점을 함께 남긴다. 모델 로드 timeout과 늦은 완료의 파괴 처리를 둔다.
7. Communication의 Web Worker가 기존 JSON wire를 읽고 해석한다. Worker와 화면 사이에는 Float64Array/Uint32Array 및 변경된 정적 metadata만 transferable로 보낸다. 내부 transfer version은 1이며 외부 wire 변경이 아니다. nullable, provenance, continuity와 수치 정밀도를 보존한다. 화면은 과거 보간에 필요한 이전 entity를 수정하지 않는다.
8. Worker는 전송 중 1개와 최신 대기 1개만 유지한다. 숨긴 탭은 화면 갱신 및 Worker 전송/복원을 중지하고 복귀 시 최신 상태만 전달한다. WebSocket 수신/재접속은 유지한다. Worker를 사용할 수 없으면 기존 연결로 명시적으로 fallback한다.
9. User/Application은 상태 표시, 버튼과 모듈 조립만 담당한다. 같은 내용의 source DOM을 매초 다시 생성하지 않는다. 지형과 건물 준비 상태는 UI에 별도로 표시한다.

## 한계와 운용

- 밀도 제한은 점이 겹치는 구간의 렌더링 최적화다. 숫자 카운트와 원본 Live 상태는 전체 대상을 유지하므로 화면의 점 개수와 다를 수 있다.
- 고도 2,000 km 이상에서는 전지구 거리 제한을 해제한다. 그보다 가까우면 항공기는 `max(180 km, 카메라 고도 × 12)`, 위성은 `max(3,500 km, 카메라 고도 × 16)` 안의 대상만 후보로 삼는다. 선택 대상은 거리 제한을 우회하지만 화면 밖/지구 뒤쪽은 표시하지 않는다.
- DEM/건물의 해상도, 취득 시점, 수직 기준이 다르므로 모든 건물의 측량급 정합을 보장하지 않는다. `Globe.tilesLoaded`는 로딩 큐 상태이며 고도 정확도 증명은 아니다. 가까운 영역의 기존 지형을 재사용하되 먼 영역 이동과 tile 오류는 준비 판정을 무효화한다.
- 지형 캐시 100 tiles는 소프트 한도다. 현재 시야의 필수 타일은 초과할 수 있다. OSM 건물은 cache 64 MiB + overflow 32 MiB, 원거리 숨김, 숨김 시 preload 금지 및 이동 중 요청 culling을 사용한다.
- 서버→브라우저 JSON 전송량은 이번 변경에서 줄이지 않았다. Worker 이동은 메인 스레드 정지를 줄일 뿐 수집/통신량을 없애지 않는다. 최초 전체 metadata 및 큰 개체 수 변화에는 일회성 비용이 남는다.
- CelesTrak은 재개하지 않았다. 저장된 GP 사용 여부는 기존 source 상태로 구별한다. 토큰, 개인 경로, 원본 실시간 snapshot은 소스에 커밋하지 않는다.
- Cesium, OpenStreetMap, 지형 공급자 attribution은 유지한다. 사용 요금과 상업적 사용 권리는 공급자의 별도 이용 조건을 따른다.

## 검증 근거

동일 입력 25,376개, 동일 1 Hz 갱신, 동일 1280×720 브라우저와 3개 카메라 시점으로 전후 비교했다. 이 비교에서는 지형/건물을 끄고 entity 렌더링만 분리 측정했다. 전지구 frame p95는 51.1 ms에서 22.9 ms로 줄었으며 지역 확대의 프레임당 위치 계산 평균은 약 6.33 ms에서 0.029 ms로 줄었다. 이 수치는 다른 장비나 네트워크에서의 성능 보장이 아니다. 실제 지형/건물과 Worker 통합은 별도 브라우저 검증 증거로 기록한다.

기준 API: [Globe](https://cesium.com/learn/cesiumjs/ref-doc/Globe.html), [Camera](https://cesium.com/learn/cesiumjs/ref-doc/Camera.html), [CesiumTerrainProvider](https://cesium.com/learn/cesiumjs/ref-doc/CesiumTerrainProvider.html).
