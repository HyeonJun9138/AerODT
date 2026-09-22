# 0115 지도 로딩과 건물 GPU 업로드의 작업 단위 제한

날짜: 2026-09-22

## 배경

조종석의 반복 DOM 갱신을 줄인 뒤에도 새 지도와 건물을 불러올 때 끊김이 보고됐다.
기존 footprint 생성은 JS 루프를 양보하지만 한 셀의 모든 GeometryInstance를
하나의 Cesium Primitive에 넘겼다. 비동기 geometry 계산이 끝난 뒤의 GPU 버퍼
생성은 렌더링 스레드에서 한꺼번에 진행된다. 이는 코드상 확인한 큰 작업 단위이며
이번 변경 전후 실제 GPU stall 시간을 비교한 결과는 아니다.

## 결정

- 건물 geometry를 최대128 instance 또는4096 입력 정점 단위로 나눈다.
  단일 polygon은 형태와 hole을 보존하기 위해 분해하지 않으므로 정점 한도를 넘을 수 있다.
- StagedPrimitive는 하나의 layer 안에서 한 렌더 프레임에 하나의 미완료 chunk만
  Cesium.update에 넘긴다. 준비된 geometry 그리기는 늦추지 않는다.
- 기존 셀은 대체 셀이 모두 준비될 때까지 표시한다. 숨겨진 대체 셀도 업로드를
  진행하며, 취소나 폐기에서는 소유한 모든 자원을 해제한다.
- 건물 응답 정리와 geometry 준비를 작은 task로 나누고, 정확한 지형 샘플 요청은
  최대96개씩 수행한다. 원래 해상도, 정점, 건물 quota, 착륙 판정은 바꾸지 않는다.
- Cesium1.143 QuadtreePrimitive의 `_loadQueueTimeSlice`를 기존5ms에서1ms로 제한한다.
  이 큐는 지형과 지도 영상 처리를 함께 진행한다. public 설정이 없어
  `terrain_layer.configureTileLoadSlice` 하나에 필드 존재 및 숫자 검사를 둔다.
  메인 지도와 external camera 모두 적용하며, 없는 버전에서는 아무것도 하지 않는다.
  height callback slice 및 native 물리에는 손대지 않는다.

## 한계와 검증

시간 제한은 soft budget이다. 하나의 복잡한 polygon, 텍스처 업로드나 shader link는
중간에 선점할 수 없다. 장면 draw call은 묶음 수만큼 늘며 신규 상세 표시까지의 시간은
길어질 수 있다. FPS 보장은 아니다. Cesium 버전 변경 때 아래 구현과 호환 시험을 확인한다.
공용 상태 계약이나 wire schema 변경은 없다.

- [Cesium1.143 Primitive](https://github.com/CesiumGS/cesium/blob/1.143/packages/engine/Source/Scene/Primitive.js): createVertexArray, update
- [Cesium1.143 QuadtreePrimitive](https://github.com/CesiumGS/cesium/blob/1.143/packages/engine/Source/Scene/QuadtreePrimitive.js): processTileLoadQueue, _loadQueueTimeSlice
- `staged_primitive.test.mjs`: 프레임 제한, 다중 셀 공유, 숨김, 취소, 준비 완료, 지도 호환 설정
- `vworld_layers.test.mjs`: 기존 quota, 교체, holes, terrain batch, 취소 자원 해제

## 2026-09-22 인접 로딩 경로 점검

- EntityScene 사전 로딩의 기존 promise chain은 실제 loadWarmAsset 반환값을
  보관하지 않아 여러 자산을 동시에 시작했다. 실제 promise를 연결하고 GPU
  ready 및 250ms warm-up 종료까지 기다린다. GPU 준비 오류/10초 timeout/장면
  폐기는 대기, listener, 임시 모델을 정리해 다음 작업이 영구 대기하지 않게 한다.
- FlightTrackLayer는 기록 궤적과 두 정점짜리 실시간 연결선을 별도
  PolylineCollection으로 분리한다. 전체 기록은 기존 3초 조회 때만 갱신하고
  조종 중 위치 갱신은 연결선만 변경한다. 서버 기록이나 표시 위치를 변경하지 않는다.
- LocalTerrainProvider의 경계 혼합은 동일 공식을 사용하되 최대256개의
  world-mesh 보간 또는2ms마다 양보한다. 여러 응답이 동시에 완료돼도 공용
  terrain_work_yield는 paint 기회 이후 task에 한 continuation만 재개한다.
  숨겨진 탭은100ms fallback이 있다. 로컬 높이만 복사하는 내부 타일에는
  불필요한256픽셀 한도를 적용하지 않는다. 취소 시 fallback을 새로 시작하지 않는다.
- mergeHeightTile 동기 함수는 유지하며 실행 provider만 sliced 경로를 사용한다.
  65x65 값 전체, 경계 가중치, tile mask와 credit을 유지한다. native 물리 지형 및
  기존 local/conditioned source 선택은 바꾸지 않는다.

새 시험은 사전 로딩 직렬화/오류/timeout/폐기, 프레임 간 DEM 작업 분리,
동기·비동기 높이값 일치, 취소, 60프레임 궤적 기록 버퍼 쓰기0회를 확인한다.
실제 브라우저 FPS는 아직 측정하지 않았다. 지도 경계의 완성 시간 및 전체 사전
로딩 시간은 늘 수 있고, 한 번의 world interpolation/GPU upload 자체는 선점할 수 없다.
