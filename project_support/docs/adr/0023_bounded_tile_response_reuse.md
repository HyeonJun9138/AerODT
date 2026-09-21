# ADR 0023: 타일 응답 재사용과 이동 중 렌더 예산

- 날짜: 2026-09-10
- 상태: 적용
- 범위: 웹 지도 표시와 타일의 전송·저장. 물리 상태, 원본 mesh, 지형 데이터, 거리와 상세도 설정은 유지한다.

## 확인한 병목

기존 V-World 메모리 캐시는 변환한 B3DM 원문을 보관했지만, 응답마다 공통 GZipMiddleware가 level 9로 다시 압축했다. 같은 종로 부모 타일의 원문은 3,777,196 bytes다. 로컬의 반복 요청에서도 약 120 ms가 걸렸으며 압축은 웹 이벤트 루프에서 동기 실행됐다. 메모리에서 쫓겨나거나 서버가 재시작되면 사진 변환과 원본 다운로드도 다시 필요했다.

정지한 카메라에서도 지표 pick과 셀 frustum 선별이 200 ms마다 반복됐다. 화면 프레임 통계는 호출할 때마다 배열을 복사하고 정렬했으며, 고부하 카메라 이동에서는 원래 해상도로 모든 픽셀을 그렸다.

## 결정

1. Communication은 타일 변환 후 gzip-1을 worker에서 한 번 생성한다. 메모리의 96 MiB LRU와 요청 병합은 압축 결과 한 개를 공유한다. 원문이 필요한 비 HTTP 호출과 identity 응답만 worker에서 해제한다. 두 사진 variant의 캐시 키는 분리하고 기존 다운로드 8개, 변환 2개, 대기 64개 제한은 유지한다.
2. 같은 타일 응답의 약한 ETag를 압축 결과에서 한 번 만든다. HTTP의 `If-None-Match`는 일치하면 본문 없는 304를 보낸다. `Accept-Encoding`의 gzip 및 q=0, wildcard와 identity를 구분하고 `Vary: Accept-Encoding`을 제공한다. Same-origin 검사와 입력 검증은 조건부 응답보다 먼저다. API 본문과 경로는 바꾸지 않는다.
3. 해당 경로는 일반 GZipMiddleware에서 제외한다. 따라서 이미 만든 gzip을 재압축하거나 gzip;q=0 요청을 다시 압축하지 않는다. 나머지 HTTP 응답은 level 3으로 압축해 실시간 응답 CPU와 압축률을 절충한다. WebSocket payload는 변경하지 않는다.
4. Data의 `VWorldTileRecords`가 공개 3D 타일의 변환 결과만 저장한다. Application이 `data/workspace/cache/vworld_3d` 아래 저장소를 조립해 Communication에 주입한다. 키, keyed 영상·공역·건물 속성 응답은 저장하지 않는다. 파일명은 버전/상대 경로/variant의 해시다. 최대 목표 256 MiB, 2,048개, 단일 파일 48 MiB이며 TTL은 기존과 같은 1시간이다. 임시 파일의 원자 교체, 길이/해시 확인, 자체 파일만 LRU 정리를 사용한다. 디스크 읽기/쓰기 역시 worker에서 실행하며 저장 실패가 지도 실패가 되지 않는다. 캐시를 다시 열어도 TTL은 연장하지 않는다. 여러 프로세스의 동시 쓰기와 교체 중 staging 때문에 순간 사용량은 목표를 넘을 수 있다. 오래된 자체 staging 파일은 후속 쓰기에서 정리한다.
5. 카메라·화면 크기·투영·거리·지형 공급자가 같으면 지표 시야를 재사용한다. 지형 로딩 중에는 500 ms, 로딩 종료 때에는 즉시, 정지 후에는 최대 5초마다 안전 갱신한다. 같은 focus를 사용하는 압출 셀은 공간 선별만 재사용하고 요청 완료, GPU 교체, 취소 및 큐 진행은 계속 처리한다.
6. 프레임 통계의 백분위 계산은 최대 200 ms에 한 번 재사용한다. 카메라가 실제 이동하면서 35~200 ms 프레임 간격이 지속되는 경우에만 drawing buffer 배율을 1 → 0.85 → 0.7로 낮춘다. 변경 간격은 최소 1.5초이고 최초 판단에는 0.9초의 지속 부하를 요구한다. 카메라가 0.7초 멈추면 1로 복구한다. 진입 연출과 모드 전환, 정지 상태, 단발 지연 및 긴 스케줄링 공백은 저해상도로 고정시키지 않는다. 0.7 배율에서 drawing buffer 픽셀 수는 원래의 49%지만 FPS가 두 배라는 뜻은 아니다. Cesium의 LOD와 지도 라벨도 이동 중에는 이 버퍼에 맞춰 보일 수 있으며 DOM 설정 메뉴는 그대로다.

## 검증과 한계

동일 원문 타일로 기존 gzip-9 반복 응답과 새 응답을 비교하는 `building_benchmark.py`를 추가했다. 원문 형상과 사진 예산은 양쪽이 동일하다. 압축 level 1의 전송량은 약간 늘지만 CPU 재압축을 없앤다. 전송량 감소율을 gzip 미적용 원문과만 비교해 기존 대비 개선이라고 주장하지 않는다.

HTTP 협상·304·요청 병합·캐시 바이트 상한·TTL·재시작·손상 파일과 공간 이탈 방지, 정지 캐시의 지형/카메라 무효화, GPU 배율의 지속 조건·정지 복원을 회귀시험한다. 실제 화면과 측정치는 CURRENT 및 evidence에 기록한다. GPU 메모리 목표, 원거리 초기 로딩, 공급자 구축 범위는 이전과 동일한 한계다. KTX2 재인코딩이나 mesh 병합은 별도 인코더 비용과 외벽 UV/정밀도 회귀 검증이 필요하므로 이번 실시간 경로에 억지로 넣지 않았다. 전체 FPS 또는 모든 끊김 제거는 주장하지 않는다.

## 근거

- [Cesium Viewer resolutionScale](https://cesium.com/learn/cesiumjs/ref-doc/Viewer.html#resolutionScale)
- [Starlette GZipMiddleware 구현](https://github.com/encode/starlette/blob/0.52.1/starlette/middleware/gzip.py)
- [Cesium 1.143 KTX2 지원 경로](https://github.com/CesiumGS/cesium/blob/1.143/packages/engine/Source/Workers/transcodeKTX2.js)
