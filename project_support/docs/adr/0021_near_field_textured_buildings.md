# ADR 0021: 카메라 근거리 건물 스트리밍과 브이월드 실사 3D

- 날짜: 2026-09-10
- 상태: 적용
- 범위: 웹 지도 표현, 외부 공간정보 어댑터, 같은 출처 중계와 표시 설정. 물리, 충돌 판정, authoritative 상태 및 DEM 교체는 범위 밖이다.
- ADR 0020의 공급자 선택을 확장한다. 이전 XDServer 시험 결과를 별도 공개 TDServer에 일반화하지 않는다.
- 후속 ADR 0022가 거리/중심/고도 제한, 압출 셀 분배와 원거리 사진 예산을 대체한다. 아래 수치는 첫 근거리 구현의 기록이다.

## 문제와 확인

틸트하면 `computeViewRectangle`이 지평선까지 늘어난다. 그 사각형 중심으로 셀을 골랐으므로 정작 카메라 근처는 빠졌다. 캐시 셀을 모두 표시했고, 겹친 요청의 경계 건물을 중복으로 세웠으며, 지형 갱신 때 기존 배치를 먼저 삭제했다. 전역 지형 타일 준비 상태도 도시 전체의 표시를 켜고 끄는 조건이었다.

별도 공개 [V-World 시설물 LOD4 3D Tiles](https://xdworld.vworld.kr/TDServer/services/facility_LOD4/vworld_3d_facility.json)가 응답한다. 서울 구별 건물 B3DM을 실제로 받았다. 그러나 Cesium 1.143에 그대로 넣으면 구형 `KHR_techniques_webgl`과 `compressedImage3DTiles.crunch`를 읽지 않아 흰색 대체 이미지가 표시된다. 이미지 URI의 흰색 1픽셀과 실제 CRN bufferView가 함께 들어 있었다.

## 결정

1. **실제 카메라 근처부터 표시한다.** 카메라 경위도와 frustum을 함께 쓰고 지표 점이 아니라 높은 건물까지 포함하는 셀 구로 가시성을 검사한다. 3D Tiles는 root clipping origin의 역행렬을 사용한 ENU clipping plane 네 개로 같은 근거리 범위를 적용한다. 틸트와 추적에서도 기준이 바뀌지 않는다.
2. **렌더링량을 먼저 줄인다.** 가볍게 2 km, 기본 3.5 km, 넓게 5 km와 96/192/256 MiB GPU 캐시 목표를 제공한다. 추가 64 MiB는 허용한다. 이는 Cesium의 소프트 예산이며 한 큰 가시 타일 때문에 초과할 수 있다. 그림자, 건물 picking, 숨긴 공급자 선로딩을 끈다. 부모 coverage를 유지하는 기본 LOD를 사용한다. 실제 시야에 필요한 단계만 곧장 받는 방식도 비교했으나 안정성이 검증되지 않아 채택하지 않았다.
3. **캐시와 표시 집합은 다르다.** 압출 건물은 보이는 셀 16개, 보관 목표 24개, 동시 로딩 2개, 전체 18,000동 및 원본 정점 260,000개로 제한한다. 셀당 높은 건물부터 1,800동, 중심 소유 셀 하나에서만 생성한다. 메모리 예산은 비동기 지형 표본을 기다리기 전에 예약한다. 오래된 HTTP를 취소하고 CPU 도형 생성은 160개 또는 4 ms마다 양보한다.
4. **빈 프레임을 만들지 않는다.** 도형을 받아 둔 셀은 지형만 다시 표본한다. 기존 Primitive는 새 Primitive의 GPU 준비가 끝났을 때 교체한다. 먼 지형 타일 지연이나 실패로 전체 건물을 숨기지 않는다. 지형을 명시적으로 끈 경우 고정 바닥 높이의 OSM/정밀 타일은 기존 정책대로 숨긴다.
5. **사진이 있는 원본 형상을 쓰되 텍스처는 제한한다.** `communication/external/vworld_texture.py`에서 CRN을 해제하고 WebP 품질 90으로 바꾼다. 재질을 표준 PBR baseColor와 unlit로 옮긴다. 원본 geometry buffer, accessor, 좌표, RTC와 LOD는 그대로다. 개별 사진 최대 1,024 px, 전체 타일 최대 4 MP이며 100장 넘는 부모 타일도 전체 예산을 공유한다. 원본 무손실 복원이 아니며 가까운 작은 자식 타일이 더 많은 사진 해상도를 쓴다.
6. **고정 공급자 중계만 연다.** 공개 타일 요청에는 계정 키를 보내지 않는다. `/api/visualization/vworld/3d/{path}`는 고정 TDServer 아래 허용 확장자만 받고 절대 URL, 부모 경로, 쿼리와 임의 호스트를 거부한다. JSON의 상대 URI는 같은 출처 URI로 바꾼다. 32 MiB 원본 전송, 다운로드부터 변환까지 8개 작업, 변환 2개, 완료 바이트 캐시 96 MiB/1시간, 대기 64개와 실패 60초를 제한한다. 같은 요청은 합친다. 앱이 타일/사진을 디스크 파일로 보관하지 않으며 브라우저 HTTP 캐시는 별개다.
7. **SSE를 불필요하게 다시 쓰지 않는다.** Cesium의 maximumScreenSpaceError setter는 같은 값이어도 내부 메모리 보정값을 초기화한다. 반복 대입을 제거하고 메모리 floor를 존중한다. 명시적인 프로필 변경 때만 한 번 초기화한다. 지속 부하는 프레임 시간 중앙값으로 판정하며 단일 컴파일/스케줄링 지연은 품질을 무너뜨리지 않는다.
8. **외관과 출처.** 단색 건물은 청회색, 기본 진하기 90%, 먼 거리는 약한 안개색을 쓴다. 초기 Bayer 투과 방식은 실제 화면에서 점무늬가 거슬려 단색 및 낮은 진하기에서 매끄러운 알파 합성으로 바꿨다. Cesium의 투명 경로는 GPU 비용이 더 들므로 형상과 거리 예산을 먼저 제한한다. 실사 사진은 진하기 90% 이상에서 불투명 fast path를 쓰고, 불투명 건물의 최외곽 거리 감쇠만 고정 coverage다. 실사 재질은 색상 램프로 덮지 않는다. 압출 및 정밀 자료는 사용 중 출처 크레딧을 유지한다.
9. **표시 설정 계약 확장.** `buildings.provider`에 `vworld_3d`, `quality`에 `compact/balanced/wide`, `opacity`에 0.35~1을 추가한다. 기존 설정은 기본값으로 보완된다. 설정 패널과 Library는 같은 저장값을 사용한다. 공개 정밀 3D 연결이 있어도 키 없는 영상/압출 API를 켜지 않는다.

## 검증과 한계

회귀시험은 틸트의 거대한 사각형, 사각형이 없는 수평 시야, 셀 중복, 취소/실패 큐, GPU 원자 교체, 전체 예산, CRN 재질 변환, 102장 부모 타일, 같은 출처 제한, 캐시, 자격 분리와 메뉴 배선을 다룬다. 실제 Chrome/Cesium 1.143로 사진 외벽, 수평 시야의 가까운 압출 건물과 실제 설정 패널을 확인한다. 실행 결과는 개발 로그와 evidence에 기록한다.

공급자의 촬영 시점과 지역별 구축 범위가 다르다. DEM은 World Terrain 그대로이므로 도심 융기와 바닥 불일치는 남는다. 낮은 GPU와 첫 셰이더 생성의 순간 지연, 네트워크 지연을 없앤다는 보장은 없다. 전체 UAM 임무 및 Unreal 실행은 이 변경에서 검증하지 않는다.

## 근거

- [Cesium3DTileset의 캐시, SSE와 LOD](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html)
- [Cesium clipping plane 좌표계](https://cesium.com/learn/cesiumjs/ref-doc/ClippingPlaneCollection.html)
- [Texture2DDecoder 소스와 라이선스](https://github.com/K0lb3/texture2ddecoder)
- [V-World 공식 API 예제 저장소](https://github.com/V-world/V-world_API_sample)
