# ADR 0022: 줌아웃을 유지하는 건물 시야와 원거리 LOD

- 날짜: 2026-09-10
- 상태: 적용
- 범위: 웹 표현, 표시 설정, V-World 3D 중계의 표시용 LOD/사진 변환. 물리 상태, 건물 충돌 판정, 원본 좌표와 DEM은 바꾸지 않는다.
- ADR 0021의 카메라 바로 아래 중심, 2/3.5/5 km 범위와 8/11 km 표시 고도 제한을 대체한다.

## 확인한 문제

카메라 지표점을 중심으로만 잘랐기 때문에 틸트 시 화면 중앙보다 화면 아래쪽에 건물이 몰렸다. 셰이더는 카메라와 건물 사이의 사선 거리를 사용했으므로 고도가 높아지기만 해도 모든 건물이 투명해졌다. 별도로 고도 8~11 km에서 레이어를 껐다. 압출 도형 예산도 먼저 도착한 밀집 셀에서 소진되어 뒤쪽 셀을 채우지 못했다.

실제 V-World Yeongdeungpo-gu에는 content가 없는 80 m 오차의 공간 분할 노드가 있다. Cesium 1.143의 기본 traversal은 화면 오차가 충분히 작으면 이 빈 노드에서 멈춘다. 이 경우 tilesLoaded=true여도 tileVisible이 0이었다. 이 문제는 클리핑이나 네트워크 실패와 구분해서 수정해야 한다.

## 결정

1. 표시 거리와 상세도를 분리한다. `buildings.distance`는 `auto/near/city/metro`이다. 기존 파일은 `auto`로 보완하고 공급자, 상세도, 투명도는 보존한다. 자동 반경은 `clamp(8000 + height * 1.6, 8000, 40000)` m, 고정 반경은 8/20/40 km이다. 이는 화면이 향하는 지표 주변의 최대 반경이며 전체 건물이 반드시 존재하거나 동시에 적재된다는 뜻이 아니다.
2. 화면 중앙의 지표 ray hit를 우선하고 하늘이면 화면 아래쪽을 시도한다. 건물 지붕을 고르지 않는다. 준비되지 않은 지형에서는 타원체 또는 heading/pitch의 지표 투영을 사용한다. 지평선의 무한히 먼 점으로 요청이 쏠리지 않도록 중심 이동은 반경의 80%로 제한한다. 같은 중심을 clipping ENU와 거리 셰이더에 전달한다.
3. 거리 감쇠는 지표 중심과 건물의 world 좌표로 계산한다. 카메라 높이 자체는 원거리 투명도의 근거가 아니다. 원거리 안개색과 최외곽 감쇠를 적용한다. 70~120 km 고도에서는 천천히 사라지고 궤도에서 요청을 중단한다. 2D에서는 3D 건물을 명시적으로 숨긴다.
4. 96/192/256 MiB 캐시와 64 MiB overflow 목표는 유지한다. 거리 선택은 셰이더 uniform과 클리핑을 바꾸고 GPU 프로그램을 다시 만들지 않는다. Cesium의 메모리 보정 SSE를 반복 초기화하지 않는다. 다만 명시적 거리/상세도 변경과 큰 줌/지역 이동에서는 한 번 재평가한다. 광역의 매우 높은 memory floor가 근접 시야에서도 계속 남는 문제가 실제로 확인됐기 때문이다. 3초 간격과 1.8배/0.55배 줌 경계를 사용하며 정지한 시점에서는 재초기화하지 않는다. 250 ms 이상 프레임 간격은 스케줄링/다른 작업과 구분할 수 없어 지속 렌더 부하의 신호로 쓰지 않는다. 이 정책은 일정 FPS를 보장하지 않는다.
5. V-World 중계는 content/contents가 없고 children이 있는 공간 분할 노드의 geometricError만 최소 4096 m로 보정한다. 원본 mesh, 위치, RTC, 실제 모델의 geometricError와 ADD/REPLACE 의미는 유지한다. 빈 공간 분할을 도시의 저해상도 모델로 잘못 선택하지 않게 하는 표시 호환 보정이다. 값은 유한하며 frustum과 메모리 예산은 계속 적용한다.
6. 실제 REPLACE 모델 중 더 자세한 자식이 있는 부모의 사진은 overview로 중계한다. 타일 전체 256 Ki pixels, 개별 최대 256 px이다. 작은 자식/최종 leaf와 ADD 모델은 기존 최대 4 Mi pixels, 개별 최대 1024 px 사진을 유지한다. Cesium이 먼 곳은 작은 부모 사진으로, 가까운 곳은 자세한 자식 사진으로 전환한다. geometry는 양쪽 모두 원본이다. 동일한 102-atlas 시험에서 부모 사진의 업로드 픽셀 예산은 약 1/16이다. 이는 전체 GPU 메모리나 FPS가 16배 개선된다는 뜻이 아니다.
7. `/api/visualization/vworld/3d/{path}`에 `texture=full|overview` 표시 옵션을 추가한다. overview는 B3DM만 허용한다. 이 옵션과 키는 공개 upstream에 전송하지 않는다. 두 변환 결과는 cache key를 분리하지만 같은 96 MiB 바이트 LRU, 64개 대기, 8개 다운로드/변환 작업, 2개 변환 슬롯, 실패 backoff를 공유한다. metadata URI 버전은 v=4로 바뀐다. URI의 다른 사용자 지정 URL/경로/쿼리는 여전히 거부한다.
8. 도형 압출 fallback은 32/48/64셀과 보관 목표 80셀로 넓히되 18,000동/260,000 원본 정점, 동시 2셀은 유지한다. 보이는 셀 전체에 예산을 나눠 빈 후순위 셀을 줄인다. 네트워크 완료 후 GPU 준비 대기까지 동시 2셀에 포함하고, 교체 중에는 기존/신규 배치 중 큰 쪽을 예약 예산으로 센다. 표시 건물 수는 GPU 교체가 끝날 때 갱신한다. 셀 enumeration은 지표 중심의 8 km 안에서만 수행한다. 이 공급자는 Data API 요청량 때문에 도시 전체를 덮는 대안이 아니며 UI에서 OSM/정밀 3D를 광역 공급자로 안내한다. 셰이더 uniform은 공유하고 이동 중 appearance나 geometry를 재생성하지 않는다.

## 검증과 남는 한계

거리 확대, 지표 pick과 지평선 제한, 방향 반전, 12/20 km 레이어 유지, 고도별 fade, 설정 파일 이전, 공유 형상 예산, 빈 LOD 보정, 원거리 사진 예산, 변환 cache 격리 및 same-origin 제한을 회귀시험한다. `building_check.py`의 실제 Cesium 화면은 고도 20 km, 중거리, 수평 틸트, 반대 방향과 궤도를 재현한다. 관측 결과와 테스트 수는 CURRENT와 별도 evidence에 기록한다.

공급자 자체의 범위와 제작 시기는 그대로다. 큰 타일 하나와 원자적인 교체 때문에 Cesium의 소프트 캐시 목표를 조금 넘을 수 있다. 넓은 실사 시야는 최초 로딩이 길 수 있으며 상한 아래에서도 모든 지역을 동시에 채우지 못할 수 있다. 브라우저 검증에서 1초대 프레임 간격도 관측되어 안정적 FPS/개선율은 주장하지 않는다. UAM 임무와 Unreal 실행 검증을 대신하지 않는다.

## 근거

- [Cesium 1.143 traversal의 SSE 종료 조건](https://github.com/CesiumGS/cesium/blob/1.143/packages/engine/Source/Scene/Cesium3DTilesetTraversal.js)
- [Cesium 1.143 기본 traversal](https://github.com/CesiumGS/cesium/blob/1.143/packages/engine/Source/Scene/Cesium3DTilesetBaseTraversal.js)
- [Cesium 캐시와 상세도 API](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html)
- [V-World 시설물 원본 metadata](https://xdworld.vworld.kr/TDServer/services/facility_LOD4/vworld_3d_facility.json)
