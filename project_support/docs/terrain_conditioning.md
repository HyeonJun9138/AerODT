# 사용자 DEM 사전 보정

`project_support/tools/condition_dem.py`는 SRTM GeoTIFF와 OpenMapTiles 계열 벡터 MBTiles를 결합하여 **시각화용 지형**을 생성한다. 실행 중인 시뮬레이터 설정과 충돌 판정용 지표면을 변경하지 않는다. 원본을 덮어쓰지 않으며 이미 존재하는 출력 폴더도 거부한다.

## 입력과 처리

- 현재 입력 계약은 WGS84 경위도, Point 표본, 동일한 간격, EGM96 수직 기준을 가진 단일 밴드 GeoTIFF이다. `DTED_VerticalDatum=E96` 태그를 확인한다.
- 벡터 타일은 읽기 전용 SQLite 연결로 해석한다. TMS 행 방향과 MVT 화면 좌표를 경위도로 변환하고, 원본 DEM 표본 위치에 공항과 수면 폴리곤, 도로 중심선을 래스터화한다.
- 지형은 하나의 표본 격자로 조합한 뒤 처리한다. 필터 블록에는 주변 여유 영역을 넣고 공항 면은 원본 타일 경계를 넘어 한 번에 적합한다. 동일 위치에 중복된 표본의 높이가 1 m를 넘게 다르면 입력 검토를 위해 중단한다.
- 일반 지표면의 작은 요철은 1~4도 경사에서 강도를 줄여 처리한다. 변경량은 최대 2 m이다. 고도가 낮다는 이유만으로 산지까지 평탄화하지 않는다.
- 수면은 수면 내부 표본만 사용해 국소적으로 완화하고 변경량을 최대 8 m로 제한한다. 강 전체를 같은 높이로 만들거나 흐름 방향을 강제하는 수리학적 보정은 아니다. 강둑과 섬의 육지 표본은 보존한다.
- 공항 면은 이상치 영향을 줄인 경사 평면을 적합한다. 적합 경사가 2도를 넘으면 건너뛰며, 수정량은 최대 12 m로 제한한다. 따라서 원본의 깊은 구멍과 큰 돌출부가 완전히 제거되지는 않을 수 있다. 폴리곤 경계에서는 변경량을 부드럽게 줄인다.
- 도로는 교량, 터널, 고가·지하 표식을 제외한 주요 도로 중심선에 한정한다. 실제 도로 폭과 고가 상판을 추정하여 평탄화하지 않는다. 폭이 없는 활주로 선도 공항 면으로 확대하지 않는다.
- 원본 NoData와 없는 지역은 그대로 남긴다. 30 m급 표본을 1 m 측량 지형으로 바꾸는 처리가 아니다. 또한 30 m는 표본 간격이지, 각 30 m 구역이 수평이라는 뜻이 아니다.

## 출력

- `merged_conditioned_30m.tif`: 입력 전체 범위를 합친 단일 GeoTIFF. 없는 지역은 NoData이다.
- `geotiff/*_conditioned.tif`: EGM96 기준 보정 높이.
- `geotiff/*_change_m.tif`: 원본 대비 수정량.
- `geotiff/*_mask.tif`: 변경 종류. 0=유지, 1=완만한 육지, 2=수면, 3=도로 중심선, 4=공항, 255=NoData.
- `package/manifest.json`과 float32 데이터: 기존 LocalDem reader용 패키지. 런타임은 저장된 EGM96 높이에 지오이드 높이를 한 번만 더해 타원체 높이를 얻는다.
- `report.json`: 입력 해시, 범위, 파라미터, 공항 적합 결과와 수정량 통계.
- `build_arrays`: 중간 합성 격자와 마스크. 생성물이며 소스 저장소에 포함하지 않는다.
- 검토 도구를 실행하면 `qa/validation.json`과 김포공항, 한강, 북한산의 비교 그림을 만든다. 거칠기는 Gaussian sigma 1.2 표본을 뺀 고주파 성분의 RMS이며 지형의 절대 정확도 지표가 아니다.

## 재현

격리된 Python 환경에 `project_support/tools/terrain_build_requirements.txt`의 의존성을 설치한다. 운영 서버 환경에 GIS 패키지를 설치할 필요는 없다.

```powershell
python -m project_support.tools.condition_dem --source <입력_DEM_폴더> --mbtiles <벡터.mbtiles> --geoid <us_nga_egm96_15.tif> --output <새_출력_폴더>
python -m project_support.tools.review_conditioned_dem <출력_폴더>
python -m pytest project_support/tests/web_live/test_condition_dem.py project_support/tests/web_live/test_local_terrain.py -q
```

사용한 지오이드 파일은 [PROJ 배포 NGA EGM96](https://cdn.proj.org/us_nga_egm96_15.tif)이다. 해당 파일의 CRS는 WGS84 3D(EPSG:4979)이므로 4326만 허용하는 판정은 부적합하다. 대상 높이 EPSG:5773과 밴드 설명 `geoid_undulation`도 확인한다. SRTM 높이 기준은 [USGS SRTM 자료 설명](https://www.usgs.gov/centers/eros/science/usgs-eros-archive-digital-elevation-shuttle-radar-topography-mission-srtm)을 참고한다.

## 적용 전 확인

이 단계는 데이터 생성과 reader/타일 호환성 검증이다. 기본 Cesium World Terrain을 교체하지 않는다. 적용할 때는 별도 검토에서 `terrain_provider=local_dem`과 패키지 경로를 지정하고, 김포공항과 한강의 실제 화면, 경계 혼합, 버티포트 높이 정합, 지상 이동을 확인해야 한다. 특히 시각화용 지형과 물리 지상 판정이 다른 상태로 운항 검증을 완료했다고 판단하면 안 된다.

MBTiles의 water `class=lake`가 강에도 쓰여 이름만으로 호수 전체를 수평화하지 않는다. 원본 벡터의 출처와 이용 조건, 공항 경계의 정확성도 별도로 확인해야 한다. 보정 지형은 측량, 안전 운항, 정밀 착륙 판정 자료가 아니다.
