# ADR 0082: UAM 시각 자산의 실내 및 조종석 투영 계약

상태: 적용 (2026-09-14)

## 결정

다섯 대표 기종의 flight_model.glb에 저폴리 실내를 추가한다. 원본 model.glb와 기존 외부 정점, 리그, 텍스처 데이터 및 물리 파라미터는 보존한다. 승객 정원은 Joby2, AirTaxi4, KP2 6, EVTOL8, X57 4이며 조종사1석은 별도다. 이는 현재 AeroDT 대표 정원이지 제작사 좌석 인증 정보가 아니다.

asset.json의 선택적 cockpit(schema_version=1)은 eye, forward, up, passenger_seats, seat_nodes, screens를 제공한다. screen 항목은 id(pfd/nav/system), center, width, height, right, up이다. 좌표는 flight GLB의 최종 authored scene +X forward/+Y up이며 display scale 적용 전이다. 모델별 shell 내부와 실제 투명 유리 통과를 검사한다. visual_catalog는 유효한 cockpit 메타데이터만 공개한다. 기존 장기 실행 서버는 최대5개 로컬 asset metadata 조회로 선택적 정보를 보완할 수 있다.

visualization의 카메라는 GLB 축 보정 [x,-z,y], 현재 표시 행렬과 동일 스케일을 사용한다. 별도 위치 추정이나 물리 상태를 만들지 않는다. 기체 내부 눈 위치는 고정하고 head yaw/pitch와 FOV만 변경한다. 기본 아래12도, FOV70도, 범위35~90도다. 종료 시 기존 frustum 및 입력 설정을 복구한다. 모델/선택/연속성/epoch 유실 또는2D 전환 시 종료한다.

계기는 user_application이 읽기 전용으로 조합한다. DOM 화면을 실제 세 화면 모서리에 perspective 투영하여 3D 외피와 동기화한다. near plane/역면/퇴화 투영은 숨긴다. 화면 갱신은 최대10Hz, 카메라/투영은 렌더 프레임에 맞춘다. 별도 WebGL renderer나 서버 비행 명령은 추가하지 않는다. 표시 위치/자세와 최신 관측 속도 및 최근 임무 조회의 시각 차이를 명시한다.

## 제한 및 검증

목표는 시각화용 실내이며 제작사 cockpit 복제나 인증된 인체공학을 의미하지 않는다. 좁은 화면 또는 확대된 화각에서는 실제 원근법 때문에 계기 일부가 화면 밖으로 나갈 수 있다. 원본 bubble canopy에는 임의 중앙 필러를 만들지 않는다. 기본 획득 모델의 라이브러리 원형은 보존한다.

브라우저 회귀93 PASS, Python 자산/카탈로그29 PASS, architecture PASS. Three 자산35개 시야와 Cesium 별도 local QA에서5기종 확인. 운영 중인 비행/서버는 재시작하지 않았다. 실제 운영 시나리오 및 Unreal 임무 수용 검증은 별도이며 이번 작업에서 수행하지 않았다. 기존 X57 로터 기대값2/실제14 불일치는 별도 이슈로 보존했다.
