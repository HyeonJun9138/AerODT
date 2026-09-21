# 0024 선택 가능한 로컬 DEM과 World Terrain 혼합

상태: 채택, 2026-09-10

## 결정

지도 표시 설정의 지형 자료를 `world_terrain`(기본)과 `local_dem`으로 나눈다.
설정은 기존 source settings 저장 경로를 사용한다. 기존 `terrain.enabled`와
평면 표시 기능은 그대로이며, 지형 자료를 바꾼다고 평면 모드가 해제되지 않는다.

로컬 자료는 사용자 제공 1 arcsecond WGS84 PixelIsPoint TIFF 11장이다.
원본을 보존하고 일회성 importer로 `data/workspace/terrain/user_dem`에
native int16 격자와 manifest를 만든다. importer만 Pillow/numpy가 필요하다.
런타임은 표준 라이브러리 mmap 4개와 생성 타일 LRU 128개를 사용한다.
다른 DEM 다운로드 산출물은 연결하지 않는다.

원본에는 수직 CRS가 없다. SRTM v3 파일명에 근거한 **EGM96 가정**을
메타데이터와 UI에 명시한다. NGA/PROJ EGM96 geoid의 `h = H + N`으로
타원체 높이를 만든다. 이 가정과 지형 자체의 정확도는 측량으로 확인한 것이 아니다.
공식 geoid 출처: https://cdn.proj.org/us_nga_egm96_15.tif
라이선스: https://raw.githubusercontent.com/OSGeo/PROJ-data/master/us_nga/us_nga_README.txt

## 책임과 계약

- `data/terrain`: 읽기 전용 DEM, NoData와 높이 기준 처리.
- `digital_twin/visualization`: 렌더링용 지형 타일과 Cesium provider.
- `communication/web`: 고정된 HTTP 경로와 동일 출처 검사.
- `user_application`: 자료를 조립하고 선택을 저장한다.

`GET /api/visualization/terrain/local`은 schema_version=1, 가용 여부,
크기 65x65, level 6..14, 경계, datum note, version을 반환한다.
`GET /api/visualization/terrain/local/{level}/{x}/{y}`는 Geographic 2x1
타일 체계이며 북→남, 서→동 순서의 float32 little-endian 높이 4,225개,
이어서 혼합 가중치 4,225개다. 총 33,800 bytes다. 밖은 204, 비활성은
404, 잘못된 인덱스는 400이다. 클라이언트가 파일 경로를 지정하지 못한다.

자료 내부는 로컬 높이를 쓰고, 범위 밖과 NoData는 World Terrain을 쓴다.
외곽 0.02도에서 smoothstep 혼합하며 인접 원본 장 사이에는 적용하지 않는다.
이 가장자리 혼합은 시각화를 위한 처리이며 측량 지형으로 재사용하지 않는다.
브라우저 로컬 요청은 동시 6개, metadata 대기는 10초로 제한한다.
요청 실패는 World Terrain으로 복귀한다. World Terrain 자체가 불가능하면
완전한 전 세계 오프라인 지형을 제공할 수 없다. level 14 이상은 보간이며
원본보다 정밀한 지형이라고 주장하지 않는다.

## 검증과 한계

합성 격자 bilinear/NoData/geoid 부호/경계 혼합, HTTP 범위, provider fallback,
전환 경쟁, 평면 모드 보존, 설정 저장을 시험한다. 별도 UI 검증 앱은
live 소스 없이 사용한다. 실제 Cesium 1.143에서 지형 적재 완료와 선택 유지,
sampleTerrainMostDetailed의 로컬 높이를 확인했다.

여의도 3개 지점에서 기존 지형 대비 높이 차이는 약 -0.001, +0.364, -0.181 m다.
동일 계열 원자료일 가능성이 있으며 도심 융기의 개선을 보장하지 않는다.
실사 3D 모델 자체의 지면/높이 기준은 변경하지 않는다. 내부 NoData 경계의
완만한 혼합 및 원본의 수직 기준 확정은 후속 과제다. FastPhysics나 실시간
비행 상태는 수정하지 않으며 UAM/Unreal 검증 완료를 뜻하지 않는다.
