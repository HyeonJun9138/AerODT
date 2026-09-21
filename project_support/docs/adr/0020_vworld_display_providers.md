# ADR 0020: 국내 지도 영상과 건물은 브이월드로 바꿔 볼 수 있고, 지형은 바꾸지 않는다

- 날짜: 2026-09-09
- 상태: 적용
- 범위: 지도 영상·3D 건물의 공급자 선택(브이월드 WMTS·Data API), 서버 릴레이, 설정 모델, 지구 레이어. 지형(DEM) 교체는 조사 결과 불가능하여 범위 밖이다. Live Twin 추정과 Simulation 자산은 건드리지 않는다.

## 문제

지도 영상은 Esri World Imagery, 건물은 Cesium OSM Buildings, 지형은 Cesium World Terrain으로 고정되어 있었다. 국내에는 국토교통부 브이월드가 항공·위성 영상과 건축물 도형(층수·높이 포함)을 열어 주는데, 이를 쓰려면 키가 필요하고 국내만 덮으며 반출 제한이 있다. 사용자는 "기존 자료도 유지하고 설정에서 바꿀 수 있게" 했다.

## 조사 결과 (키로 직접 확인)

- WMTS `req/wmts/1.0.0/{key}/{Base|Satellite|Hybrid|midnight}/{z}/{y}/{x}`: 레벨 6~19, 국내만. 밖은 `FileNotFound · 서비스 제공영역이 아닙니다` OWS 예외. Referer·domain 없이도 응답.
- Data API `req/data` GetFeature `LT_C_BLDGINFO`: MultiPolygon 도형에 `height`(실측 21%), `grnd_flr`(76%), `bld_nm`. 요청당 10 km², 1000건 제한. 서울 도심 0.03°×0.02° 상자에 14,301동. `LT_C_SPBD`(통합건물)도 되지만 높이가 없다.
- 3D/지형: XDServer `requestLayerNode`(dem·facility_build·tile)는 `ERROR_DB_GENERAL`로 닫혀 있고, WMS 355개 층 중 DEM·표고 층은 없다. **지형은 브이월드로 교체할 수 없다.**

## 결정

1. **키는 서버에만 있고 브라우저는 릴레이만 부른다.** `%LOCALAPPDATA%\AeroDT\credentials\vworld.json`의 `apiKey`를 `configure_vworld`가 `AERODT_VWORLD_API_KEY`로 올리고, `communication/external/vworld.py`의 `VWorldClient`가 타일과 건물 셀을 대신 받는다. 브라우저 URL·응답·로그 어디에도 키가 없다. 등록 도메인은 설정 `vworld_domain`이다.
2. **타일은 `/api/visualization/vworld/tiles/{layer}/{z}/{y}/{x}.{ext}`로 그대로 흘리고, 없는 곳은 투명 1픽셀 PNG다.** 그래서 브이월드 층은 World Imagery **위에** 얹히고 국내 밖에서는 아래 영상이 그대로 보인다. 확장자는 층마다 하나(위성 jpeg, 나머지 png)라 다른 조합은 404다. 하루 캐시.
3. **건물은 0.01° 고정 격자 셀로 받는다.** `/api/visualization/vworld/buildings/{column}/{row}`가 셀 하나를 1000건씩 넘기며 받아 도형(외곽·구멍)·높이·층수·이름만 남긴 JSON으로 돌려준다. 높이는 실측 `height` > `grnd_flr`×3.3 m > 3 m 순이다. 셀은 서버 메모리에 6시간 보관하고(디스크에 쓰지 않는다: 반출 제한), 같은 셀을 동시에 여러 브라우저가 물으면 한 번만 받는다. 국내 밖 셀은 요청 없이 빈 셀이다.
4. **선택은 Library 설정이 소유한다(ADR 0018 확장).** `buildings.provider`(`osm`/`vworld`)와 새 source `imagery.provider`(`world_imagery`/`vworld_satellite`/`vworld_hybrid`/`vworld_base`/`vworld_midnight`)를 `library_settings.py`가 검증·서술한다. 기본은 지금까지의 OSM·World Imagery다. 설정 패널 "지도 표시"에 "지도 영상"·"건물 자료" 선택 행이 있고, Library 카드에도 같은 선택이 있다. 저장되므로 같은 대시보드를 보는 모든 화면이 같은 지도를 본다.
5. **저장된 선택은 시작할 때 지도에 닿는다.** `LibraryPanel.sync()`가 지구를 만든 직후 설정을 읽어 지형·건물·구름·영상을 적용한다. 전에는 Library 섹션을 열어야 적용됐다.
6. **건물 공급자는 하나만 보이고, 다른 쪽은 지운 것이 아니라 끈 것이다.** `LiveGlobe.setBuildingsProvider`가 OSM tileset과 `VWorldBuildingLayer` 중 하나만 켠다. 브이월드 층은 카메라 9 km 아래에서 화면의 셀(가까운 것부터 최대 48개)을 3개씩 받아 `Primitive`(셀당 하나, 건물별 `PolygonGeometry` 압출, OSM과 같은 중립 색 램프)로 세우고 11 km 위에서 숨기며, 90셀을 넘으면 먼 셀부터 버린다. 바닥은 셀마다 지형을 한 번 표본(`groundHeights`)해 정하고, 지형이 켜지거나 꺼지거나 도착하면 전부 다시 세운다. 지형이 아직 없으면 그 셀은 다음 갱신까지 기다린다.
7. **영상 층의 자리.** 브이월드 영상은 기본 영상 바로 위, 지역명·구름 아래에 들어간다. 기본 영상이 아직 없으면 선택만 기억했다가 기본 영상이 오는 순간 얹는다. `hybrid`는 위성과 도로·지명 두 층이다. 태양 조명 스타일은 기본 영상과 같이 받는다.
8. **지형은 World Terrain 그대로다.** 브이월드가 DEM을 열어 주지 않으므로 선택지를 만들지 않고, 지형 카드의 안내문에 이유를 적었다. 국내 DEM은 별도 자료 작업이 필요하다는 기존 판단(README `지형 자료의 한계`)이 유지된다.

## 결과와 한계

- 서울 도심 2.4 km 시야에서 40셀 89,381동이 세워졌고 상태는 `브이월드 건물 표시`. OSM으로 되돌리면 OSM tileset이 다시 보이고 브이월드 셀은 숨은 채 남는다.
- 밀집 지역은 셀당 2~3회의 1000건 요청이라 처음 볼 때 몇 초가 걸리고, 건물 수만 동을 한 번에 세우므로 낮은 GPU에서는 느릴 수 있다. 건물 하나하나를 집거나 이름을 띄우지는 않는다(`allowPicking:false`).
- 브이월드 키의 일일 사용량 한도는 확인하지 못했다. 셀 캐시가 같은 화면의 재요청을 막지만, 넓은 지역을 훑으면 요청이 많다.
- 브이월드 영상은 국내만 덮고 반출 제한이 있어 타일과 셀을 디스크에 저장하지 않는다.
