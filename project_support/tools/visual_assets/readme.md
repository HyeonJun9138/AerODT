# 3D 자산 수집 및 검수 도구

라이브러리는 `digital_twin/model_library/visual_assets`에 있다. 원본 프로젝트를
수정하지 않으며 기존 UAM 계산이나 실행 코드를 import하지 않는다.

## 환경

- Python 3.10 이상. import/검증은 표준 라이브러리, schema 시험은 jsonschema가 필요하다.
- Node.js 18 이상. 도구 의존성은 `project_support/environment/visual_assets`에 설치한다.
- Three.js 0.180.0, gltf-validator 2.0.0-dev.3.10. 패키지 버전은 검증 재현용으로 고정했다.
- 브라우저는 WebGL과 WASM을 지원해야 한다. Draco decoder는 Three.js 배포본을 로컬 제공한다.

저장소 루트에서 실행한다. pnpm 대신 npm을 쓰면 `npm install --prefix ...`로 동일한 경로에 설치할 수 있다.

```powershell
pnpm --dir project_support/environment/visual_assets add --ignore-scripts three@0.180.0 gltf-validator@2.0.0-dev.3.10
python project_support/tools/visual_assets/asset_library.py --import-icdcdt '<원본 모델 디렉터리>'
python project_support/tools/visual_assets/fetch_public_assets.py
node project_support/tools/visual_assets/validate_gltf.cjs
python project_support/tools/visual_assets/preview_server.py
```

`http://127.0.0.1:8767`에서 전체 WebGL 검증 버튼을 누른다. 완료 뒤 별도 셸에서:

```powershell
python project_support/tools/visual_assets/finalize_catalog.py
python project_support/tools/visual_assets/asset_library.py --verify
python -m unittest discover -s project_support/tests/integration -p test_visual_assets.py -v
```

마지막으로 preview 서버를 Ctrl+C로 종료한다. 외부 인터페이스 바인딩 옵션은 없다.
서버는 라이브러리와 Three.js, 검수 화면만 제공하며 저장소 전체를 노출하지 않는다.
POST는 동일 origin에서 현재 asset checksum에 맞는 검수 결과만 작업 폴더에 기록한다.
이는 개발용 도구이며 production 서비스가 아니다.

## Unreal 기체 형상 내보내기

시뮬레이터가 쓰는 기체를 지구본에서도 같은 형상으로 그리려면, model package가
선언한 Unreal 메시를 그대로 glTF로 내보낸다. 형상의 출처는 언제나 model package다.

```powershell
project_support	oolsuild_seoul_uam_sim.ps1      # /Drone 콘텐츠 플러그인 마운트
project_support	ools\export_uam_visual_asset.ps1
node project_support/tools/visual_assets/validate_gltf.cjs
python project_support/tools/visual_assets/preview_server.py --port 8791
# 전체 검증 버튼을 누른 뒤 Ctrl+C
python project_support/tools/visual_assets/finalize_catalog.py
```

`export_unreal_vehicle_gltf.py`는 Unreal 안에서 실행되며 `links[].visual`의 링크
배치(NED m·rpy-deg → Unreal NEU cm·좌수 회전)대로 부품을 놓고 그 선택만 내보낸다.
텍스처는 exporter가 JPEG 품질 90으로 쓴다. 무손실 PNG로는 41 MB가 나와 라이브러리
최대 자산의 세 배였다. `import_unreal_vehicle_asset.py`는 내보낸 파일을 **재해석하지
않고** 측정만 한다. 크기는 bounding box에서, Unreal↔glTF 축 대응은 원점에서 떨어진
부품의 좌표를 맞춰 구한다(추정하지 않는다). 그래서 이 자산만 `forward_axis`와
`reference_extent_m`이 측정값이고 `physical_dimensions_verified`가 참이다.

포트 8767이 Windows 예약 범위에 걸리면 `PermissionError [WinError 10013]`이 난다.
`--port`로 다른 포트를 주면 되고 서버는 그 포트로 same-origin을 검사한다.

## 후보 기체 한 덩어리 반입

model package가 없는 후보 형상(외부 프로젝트의 static mesh나 FBX)은 다음 경로로 넣는다.
출처와 권리는 추론하지 않고 intake spec에 사람이 적는다.

```powershell
$env:AERODT_EXPORT_ASSET_PATH = "/Game/KP2A/KP2StaticMesh"   # 또는 AERODT_EXPORT_SOURCE_FBX
$env:AERODT_EXPORT_OUTPUT = "data\workspace\visual_assets\export\kari_kp2a.glb"
$env:AERODT_EXPORT_REDUCE_TO_PERCENT = "0.10"                # CAD 밀도 메시만
& "<UE>\UnrealEditor-Cmd.exe" <uproject> "-ExecutePythonScript=project_support\tools\visual_assets\export_unreal_asset_gltf.py" -unattended -nosplash -stdout
python project_support/tools/visual_assets/import_unreal_vehicle_asset.py --export data/workspace/visual_assets/export/kari_kp2a.glb --asset-id kp2a --spec project_support/tools/visual_assets/intake/kp2a.json
```

- 원본 uasset은 **엔진 버전이 맞아야** 한다. UE 5.5로 저장된 것은 5.2에서 열리지 않는다.
  같은 자산의 5.2 사본이 있으면 그것을 쓰고, 없으면 FBX로 가져온다.
- `/Game/...` 경로를 유지해 Content로 복사하면 내부 참조가 유지된다. 호스트 프로젝트의
  `Content/`는 전부 이 반입용 임시 영역이며 git에 올리지 않는다.
- `sanitise_reduced_export`를 spec에 켜면 Unreal 감축기가 남긴 결함만 좁게 고친다:
  비어버린 primitive 제거, 비정상 값이 든 보조 채널(TANGENT/TEXCOORD_n) 제거와 번호
  재정렬, 참조 없는 accessor/bufferView 제거. **정점 위치는 건드리지 않으며** 수행한
  보정은 `conversion.repairs`에 남는다.
- 라이선스 파일이 없으면 `rights.public_export`를 false로 둔다. 그러면 카탈로그에는
  남지만 `web_catalog.json`과 live twin에는 나가지 않는다.

## 도구 책임

- `asset_library.py`: GLB 경계 검사, source hash 검사, 위성 alias 보존, 명시적인 웹 호환 보정.
- `fetch_public_assets.py`: 고정 commit의 NASA/제작자 모델 선별 수집. 실패는 pending으로 기록.
- `validate_gltf.cjs`: Khronos validator 실행. 오류가 있으면 비정상 종료.
- `preview_server.py`, `preview/`: 실물 파일의 브라우저 로딩과 기본 장면 렌더링, 썸네일 생성.
- `finalize_catalog.py`: 현재 checksum과 일치하는 검수 영수증만 반영하고 웹 후보 목록 생성.
- `export_unreal_vehicle_gltf.py`: Unreal 안에서 model package의 시각 링크를 조립해 glTF로 내보낸다.
- `import_unreal_vehicle_asset.py`: 내보낸 GLB를 측정해 출처·권리와 함께 라이브러리에 등재한다.
- `export_unreal_asset_gltf.py`: 단일 static mesh(또는 FBX)를 LOD 감축과 함께 내보낸다.
- `intake/*.json`: 후보 자산의 출처·권리·축·배율을 사람이 적어 두는 입력. 도구가 추정하지 않는다.

다시 수집해도 같은 파일은 중복 추가하지 않는다. 다른 내용으로 기존 asset id를
덮어쓰려 하면 중단한다. 변경된 모델은 새 버전 정책을 검토하고 기존 검증을 재사용하지 않는다.
GLB를 직접 변경한 경우 `model.sha256`을 고치는 것만으로 검증을 통과시키지 말고
원본 대비 변환 이력을 남긴 뒤 validator와 브라우저 검수를 다시 수행한다.
공급처 캐시는 commit별로 분리되어 이전 파일에 새 revision을 잘못 붙이지 않는다.
기존 public_export=false 검토 결과는 재수집으로 완화하지 않는다.
전체 검수와 개별 미리보기는 상호 배제되어 다른 모델의 화면을 검수 영수증에 기록하지 않는다.

## 데이터 보존 및 알려진 한계

원본 GLB가 그대로 사용되면 라이브러리 파일 자체가 원본 bytes다. 보정한 원본은
원본은 저장소 밖의 `AERODT_VISUAL_ASSET_SOURCES` 경로에도 보존한다. 환경 변수를
지정하지 않으면 `~/.aerodt/visual_asset_sources`를 사용한다. 원본 binary backup은
Git에서 제외되므로 별도 보관하거나 기록된 공급처에서 재수집해야 한다.
최초 다운로드 문서와 source inventory에 원본 revision/hash를 남긴다.

실행 결과는 `data/workspace/visual_assets`에 있다. 정상 종료한 카탈로그는
86개이나 모델별 경고, 누락 텍스처 대체, 연구용/대표 형상 및 권리 보류를 함께 읽어야 한다.
미터 배율, 기수 방향, 조종면/틸트 애니메이션, Cesium 통합은 이번 검수 범위가 아니다.
웹 후보 색인은 권리 검토를 돕기 위한 필터이지 법률상 보증이 아니다.

Fab 두 상품은 획득 대기다. EULA 동의나 계정 작업을 우회하지 않는다. 에셋을
단독으로 공개 배포하는 것과 애플리케이션에 포함하는 것은 다른 조건이므로,
무료 상품이어도 웹용 GLB로 변환한 뒤 자동으로 public_export를 true로 바꾸지 않는다.

## 단일 비행용 파생 모델 (2026-09-10)

`model.glb`는 획득한 원본이다. 비행 계획만 `flight_model.glb`와
`asset.json`의 `flight_visual` 리그를 사용한다. 다른 기종의 물리 모델은
추가하지 않으며 계산은 AirTaxi를 공유한다. ADR 0030을 참고한다.

재생성 순서 (저장소 루트에서 실행):

```powershell
node project_support/tools/visual_assets/prepare_flight_mesh.mjs digital_twin/model_library/visual_assets/aircraft/civilian/x_57/model.glb data/workspace/visual_assets/x57_decoded.glb
node project_support/tools/visual_assets/prepare_flight_mesh.mjs data/workspace/visual_assets/x57_decoded.glb data/workspace/visual_assets/x57_light.glb simplify
python project_support/tools/visual_assets/build_flight_rigs.py
node project_support/tools/visual_assets/validate_flight_rigs.cjs
```

가공 도구의 Node 의존성은 `project_support/environment/visual_assets/package.json`에 있다.
실행 앱은 이 패키지를 필요로 하지 않고 완성된 GLB만 읽는다.
독립 화면 검증은 `project_support/tools/web_visualization/single_flight_check.py`를
실행해 127.0.0.1:8878에서 한다. 테스트 버티포트와 임시 native 계산만 사용하며
운영 서버나 사용자 저장 실행을 변경하지 않는다. 리그를 재생성하면 검증 상태는
pending으로 초기화되므로 Khronos 및 Cesium 검증을 다시 수행한다.

## OpenVSP 기준 기체 반입 (2026-09-14)

NASA UAM reference vehicle은 메시가 아니라 OpenVSP 파라메트릭 모델(`.vsp3`)로 공개된다.
`openvsp_parts.py`가 OpenVSP 배치 해석기를 돌려 Geom 하나씩 따로 내보내고 glTF로 조립한다.

```powershell
python project_support/tools/visual_assets/openvsp_parts.py --model <...>.vsp3 --out <작업 폴더>
```

OpenVSP는 `project_support/environment/openvsp`에 **압축만 풀어** 둔다(설치 프로그램 아님,
해당 경로는 git에서 제외된다). 버전은 3.51.3 win64이며 `vspscript.exe`만 쓴다.

모델 전체를 한 번에 `ExportFile`하면 OpenVSP가 하나의 MeshGeom으로 용접해 버려 로터가
움직일 수 없다. 그래서 Geom을 사용자 set에 하나씩 넣어 따로 내보낸다. **각 OBJ 내보내기는
CompGeom 결과를 새 MeshGeom으로 모델에 남긴다.** 이 geom은 처음 조회한 목록에 없어 set
플래그가 초기화되지 않고, 다음 내보내기에 함께 딸려 나간다. 도구는 매 반복마다 타입이
`Mesh`인 geom을 지운 뒤 살아있는 목록으로 플래그를 다시 세운다. 이 처리가 없으면 모든
부품 파일이 직전까지 누적된 기체 전체를 담는다(sbs 기준 3.29 MB → 0.92 MB 차이).

선언값과 측정값을 섞지 않는다. 허브 위치·블레이드 수·마스트 각도는 모델 파라미터에서
그대로 읽고, 기수 방향과 미터 배율은 OpenVSP가 선언하지 않으므로 추정하지 않는다.
좌표는 OpenVSP(+X 후방·+Y 우현·+Z 상방)에서 glTF로 (x,y,z)→(y,z,x) 순환 치환한다.
오른손 좌표계가 유지되며 거울 반전이 없다. 어느 쪽이 기수인지는 여기서 정하지 않는다.

로터 정점은 자기 허브 기준으로 다시 쓰고 허브는 노드가 들고 있어 노드를 돌리면 로터가
자기 축으로 돈다. 같은 이름 번호를 쓰는 나셀 부품(blades/hub/cowling/EngineGroup)은
허브에 놓인 `AeroDT_Hinge_rotor_N` 아래로 묶여 함께 기울어진다.

### 캐빈·MFD·도장과 라이브러리 등재

```powershell
python project_support/tools/visual_assets/openvsp_cabin.py --build <작업 폴더>
node   project_support/tools/visual_assets/validate_openvsp_cabin.cjs <작업 폴더> ...
python project_support/tools/visual_assets/openvsp_register.py --build <작업 폴더의 상위>
```

`openvsp_cabin.py`는 네 가지를 순서대로 한다. **측정**: 가장 큰 Fuselage geom을 찾아 길이축
단면 폭으로 기수 방향을 읽고(꼬리 쪽이 더 가늘다) 캐빈 구간과 바닥 높이를 잡는다.
**유리**: 창은 동체 자신의 삼각형을 그대로 쓰고 머티리얼만 바꾼다. 정점을 옮기거나 더하거나
지우지 않으므로 외형은 NASA가 공개한 그대로다. **가구**: 바닥·좌석·탑승자·계기판은 측정한
외피에 맞춰 새로 만든 예시 형상이며 인증 치수가 아니다. **도장**: 부품 이름과 Geom 타입으로
airframe·rotor·duct·gear·glass·cabin·seat·screen 머티리얼을 배정한다.

전면창은 법선 방향이 아니라 **앞좌석보다 앞쪽**이라는 기준으로 고른다. UAM의 뭉툭한 기수에는
충분히 앞을 향하는 삼각형이 거의 없어 법선으로는 잡히지 않고, 착석 눈높이가 기수 원뿔보다
위에 있어 시선이 유리를 지나지 않는다. 계기판도 캐빈 앞 가장자리보다 **뒤**에 놓는다. 앞에
놓으면 기수가 짧은 기체에서 셸 밖으로 나간다.

`validate_openvsp_cabin.cjs`는 스크린샷으로는 가릴 수 없는 세 가지를 레이 캐스트로 확인한다.
착석 눈높이에서 앞을 볼 때 투명 머티리얼을 지나는가, 계기 화면 3면이 동체 안에 있는가,
좌석이 동체 안에 있는가. 화면 판정은 첫 충돌이 아니라 **동체 경계 포함 여부**로 한다. 붐이나
로터가 시선을 가로지르는 것과 화면이 공중에 뜬 것은 다른 문제다. 유리를 넣으면 동체가
primitive 2개가 되어 GLTFLoader가 Group으로 만들고 메시 이름에 접미사가 붙으므로, 이름 대조는
영숫자만 남겨 비교하고 타입을 가리지 않는다.
