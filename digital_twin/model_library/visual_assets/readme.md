# AeroDT 공유 3D 자산 라이브러리

고유 GLB 100개. 파일 전체 114.3 MiB. 기본 장면의 glTF 및 WebGL 검증 기준이다.

## 사용

- `catalog.json`: 로컬 보유 전체 형상. `asset.json`이 모델 정보의 원본이다.
- `web_catalog.json`: 출처 조건과 기술 검사를 통과한 후보만 참조한다. 공개 서버에 전체 디렉터리를 무조건 노출하지 않는다.
- `acquisition.json`: 아직 받지 못한 Fab 상품. 보유 수량에 포함하지 않는다.
- `model.glb`: glTF 2.0. Draco를 요구하는 모델은 뷰어에 해당 decoder를 구성해야 한다.
- `thumbnail.jpg`: 실제 파일의 브라우저 기본 장면 렌더. 원본 공급자 홍보 이미지가 아니다.
- `attribution.txt`: 출처와 이용 조건. 웹에서 사용자에게도 접근 가능하게 제공한다.

## 구분

민간 9개: A320, A350, A380, B737, B787, 범용 eVTOL, 드론, NASA X-57, ProjectAirSim AirTaxi.
AirTaxi는 AeroDT 시뮬레이터가 쓰는 model package의 링크 배치를 그대로 Unreal에서 내보낸 것이라 크기와 축이 측정값이다.
군용 계열 1개: Global Hawk. NASA 연구용 외형이며 실제 작전용 도색이나 센서 구성을 보증하지 않는다.
위성/우주정거장 77개: ICDCDT 50개와 추가 NASA 27개. 동일 형상의 위성군 매핑은 aliases로 보존한다.
위성의 exact/series/family는 이전 프로젝트의 식별 매핑이며 3D 형상의 정밀도 인증이 아니다.

## 크기와 자세

GLB는 오른손 좌표계 +Y-up 기준이지만 각 모델의 기수 방향은 별도 확인이 필요하다.
`browser_measured_extent`는 장면 bounding box에서 측정한 원본 단위 크기다. 곧바로 실제 미터로 해석하지 않는다.
ICDCDT의 `reference_extent_m`와 alias별 `size_m`은 근사 표시값이다. 동일 형상을 쓰는 alias마다 배율이 다를 수 있다.
실제 세계 배율과 기수 방향 검증 전에는 지도 위 자세가 정확하다고 주장하지 않는다. 미리보기는 auto-fit만 한다.

Cluster II, CNOFS, Polar, Van Allen은 전체 장면에 맞춘 썸네일에서 본체가 작게 보인다. 전용 표시 구도와 배율 검토가 남아 있다.

## 권리 및 보정

NASA는 공급처의 자료 이용 지침을 보존한다. 상표, 로고, 제3자 권리 및 보증 표현은 별도 검토한다.
amvlab는 CC BY 4.0 출처표시, 라이선스 링크와 수정 이력 표시가 필요하다.
SpaceTwin 자체 제작 4개 형상과 GOES-R 1개는 권리 재확인 전까지 공개 후보 색인에서 제외했다.
Fab 원본은 아직 미획득이며 EULA 동의/계정 절차 및 Unreal/FBX 변환이 남아 있다. No-AI 표시도 보존했다.
Terra 외부 텍스처, A320/GOES-R 법선과 색상, Jason/Jason-2/QuikSCAT UV 문제는 원본을 보존하고 보정했다.
누락 texture/UV 면은 기본 색상을 사용한다. GOES-R의 정의되지 않은 법선은 조명용 대체값으로 처리했다.
보정 후 형상 위치는 유지하지만 재질과 조명이 원본과 동일하다고 보장하지 않는다.

## 목록

| ID | 이름 | 분류 | 표시 성격 |
|---|---|---|---|
| amvlab_a320 | A320 (logo-free) | aircraft/civilian | type_visualization |
| amvlab_a350 | A350 (logo-free) | aircraft/civilian | type_visualization |
| amvlab_a380 | A380 (logo-free) | aircraft/civilian | type_visualization |
| amvlab_b737 | B737 (logo-free) | aircraft/civilian | type_visualization |
| amvlab_b787 | B787 (logo-free) | aircraft/civilian | type_visualization |
| amvlab_drone | drone (logo-free) | aircraft/civilian | generic |
| amvlab_evtol | EVTOL (logo-free) | aircraft/civilian | generic |
| joby_s4 | Joby S4 eVTOL | aircraft/civilian | specific |
| kp2a | KP-2A UAM airframe | aircraft/civilian | specific |
| projectairsim_airtaxi | ProjectAirSim AirTaxi (quad tiltrotor UAM) | aircraft/civilian | specific |
| x_57 | X-57 | aircraft/civilian | mission_visualization |
| global_hawk | Global Hawk | aircraft/military | research_livery_military_origin |
| ace | Advanced Composition Explorer | spacecraft/satellites | mission_visualization |
| acrimsat | Active Cavity Irradiance Monitor Satellite (AcrimSAT) (A) | spacecraft/satellites | mission_visualization |
| aim | Aeronomy of Ice in the Mesosphere | spacecraft/satellites | mission_visualization |
| aqua | Aqua (EOS PM-1) | spacecraft/satellites | mission_visualization |
| aquarius | SAC-D / Aquarius | spacecraft/satellites | mission_visualization |
| aura | Aura (EOS CH-1) | spacecraft/satellites | mission_visualization |
| calipso | CALIPSO | spacecraft/satellites | mission_visualization |
| chandra | 찬드라 X선 관측위성 | spacecraft/satellites | mission_visualization |
| cloudsat | CloudSat | spacecraft/satellites | mission_visualization |
| cluster_ii | Cluster II | spacecraft/satellites | mission_visualization |
| cnofs | Communication and Navigation Outage Forecast System (CNOFS) | spacecraft/satellites | mission_visualization |
| cubesat_1u | 1U 큐브샛 (일반형) | spacecraft/satellites | generic |
| cubesat_2u | CubeSat - 2 RU Generic | spacecraft/satellites | generic |
| cubesat_3u | 3U 큐브샛 | spacecraft/satellites | generic |
| cygnss | CYGNSS | spacecraft/satellites | mission_visualization |
| dscovr | Deep Space Climate Observatory (DSCOVR) (Triana) | spacecraft/satellites | mission_visualization |
| eo_1 | Earth Observing-1 | spacecraft/satellites | mission_visualization |
| fermi | Fermi (GLAST) | spacecraft/satellites | mission_visualization |
| fuse | FUSE | spacecraft/satellites | mission_visualization |
| geotail | Geotail | spacecraft/satellites | mission_visualization |
| gnss_bus | GNSS 항법위성 | spacecraft/satellites | generic |
| goes | GOES 계열 | spacecraft/satellites | mission_visualization |
| goes_r | GOES-R 계열 (GOES 16~19) | spacecraft/satellites | mission_visualization |
| gpm | GPM Core Observatory | spacecraft/satellites | mission_visualization |
| grace | GRACE / GRACE-FO 계열 | spacecraft/satellites | mission_visualization |
| hete_2 | HETE-2 | spacecraft/satellites | mission_visualization |
| hinode | Hinode (Solar-B) | spacecraft/satellites | mission_visualization |
| hubble | 허블 우주망원경 | spacecraft/satellites | mission_visualization |
| ibex | IBEX | spacecraft/satellites | mission_visualization |
| icecube | CubeSat - ICECube | spacecraft/satellites | mission_visualization |
| icesat | Ice, Clouds, and Land Elevation Satellite (ICESat) (A) | spacecraft/satellites | mission_visualization |
| icesat_2 | ICESat-2 | spacecraft/satellites | mission_visualization |
| iss | 국제우주정거장 ISS | spacecraft/satellites | mission_visualization |
| jason | Jason 계열 해양고도계 위성 | spacecraft/satellites | mission_visualization |
| jason_2 | Ocean Surface Topography Mission (OSTM Jason-2) | spacecraft/satellites | mission_visualization |
| kepler | Kepler (A) | spacecraft/satellites | mission_visualization |
| landsat_1_3 | Landsat 1, 2, and 3 | spacecraft/satellites | mission_visualization |
| landsat_4_5 | Landsat 4 and 5 | spacecraft/satellites | mission_visualization |
| landsat_7 | Landsat 7 | spacecraft/satellites | mission_visualization |
| landsat_8 | Landsat 8 | spacecraft/satellites | mission_visualization |
| leo_comms_bus | OneWeb형 통신위성 | spacecraft/satellites | generic |
| mir | Mir | spacecraft/satellites | mission_visualization |
| mirata | CubeSat - MiRaTa | spacecraft/satellites | mission_visualization |
| mms | MMS 자기권 관측위성 | spacecraft/satellites | mission_visualization |
| oco_2 | OCO-2 | spacecraft/satellites | mission_visualization |
| poes | NOAA POES 계열 | spacecraft/satellites | mission_visualization |
| polar | Polar | spacecraft/satellites | mission_visualization |
| quikscat | Quick Scatterometer (QuikSCAT) | spacecraft/satellites | mission_visualization |
| radarsat_1 | RADARSAT-1 | spacecraft/satellites | mission_visualization |
| rhessi | HESSI-RHESSI | spacecraft/satellites | mission_visualization |
| roman | Nancy Grace Roman Space Telescope (A) | spacecraft/satellites | mission_visualization |
| sac_c | SAC-C | spacecraft/satellites | mission_visualization |
| sdo | Solar Dynamics Observatory | spacecraft/satellites | mission_visualization |
| seastar | SeaStar | spacecraft/satellites | mission_visualization |
| sentinel_6 | Sentinel-6 Michael Freilich | spacecraft/satellites | mission_visualization |
| skylab | Skylab | spacecraft/satellites | mission_visualization |
| soho | Solar and Heliospheric Observatory | spacecraft/satellites | mission_visualization |
| sorce | SORCE | spacecraft/satellites | mission_visualization |
| spitzer | Spitzer Space Telescope | spacecraft/satellites | mission_visualization |
| ssl_1300 | SSL-1300 정지궤도 통신위성 버스 | spacecraft/satellites | mission_visualization |
| starlink_flat | Starlink형 평판 위성 | spacecraft/satellites | generic |
| stereo | Solar TErrestrial RElations Observatory (STEREO) | spacecraft/satellites | mission_visualization |
| suomi_npp | Suomi NPP / JPSS 계열 | spacecraft/satellites | mission_visualization |
| suzaku | Suzaku | spacecraft/satellites | mission_visualization |
| swas | SWAS | spacecraft/satellites | mission_visualization |
| swift | Swift 감마선 관측위성 | spacecraft/satellites | mission_visualization |
| tdrs | TDRS 데이터 중계위성 | spacecraft/satellites | mission_visualization |
| terra | Terra (EOS AM-1) | spacecraft/satellites | mission_visualization |
| tess | TESS | spacecraft/satellites | mission_visualization |
| themis | THEMIS | spacecraft/satellites | mission_visualization |
| toms | TOMS-EP | spacecraft/satellites | mission_visualization |
| topex | TOPEX/Poseidon | spacecraft/satellites | mission_visualization |
| trmm | Tropical Rainfall Measuring Mission (TRMM) | spacecraft/satellites | mission_visualization |
| van_allen | Van Allen Probes (RBSP) | spacecraft/satellites | mission_visualization |
| wind | Wind | spacecraft/satellites | mission_visualization |
| wire | WIRE | spacecraft/satellites | mission_visualization |
| wmap | Wilkinson Microwave Anisotropy Probe (WMAP) | spacecraft/satellites | mission_visualization |

## 승객 모사 초안용 사람

- `people/civilian/kenney_blocky_person_b`: Kenney CC0, 약 126 KiB, 72 삼각형, idle/walk/sit 등 27개 클립.
- 원본 높이 2.7 좌표 단위는 실측 인체 키가 아니다. 배치 시 별도 키 보정 필요. 탑승 로직은 미구현.

- 승객 모델을 11종으로 확장했다. people/civilian/README.md 참고. 동일 형상의 복장/얼굴 텍스처 변형이며 각 GLB는 독립적으로 사용 가능하다.
