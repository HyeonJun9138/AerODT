# ADR 0040 — 경로가 있는 다중 비행과 기체별 native 조종사

- 날짜: 2026-09-10
- 상태: 채택
- 이전 결정: ADR 0031, 0038. 이 문서는 0038의 기체 크기 대체와 공중 운동학 보간을 대체한다.

## 실행 경계

`flight_schedule`은 CSV의 의도를 읽고 `scheduled_route`는 주어진 경유점 순서를 좌표로
해석한다. `ScenarioEngine`은 일정과 시설 사용을 조정한다. Application이 주입한
`ScenarioPilots`는 기체별 목표와 진행을 관리하며, Communication의 `native_pilot`을
통해 native 실행기를 호출한다. Simulation에서 application 구체 타입을 import하지 않는다.

Native 실행 핸들 하나에 `RoutePilot` 하나와 `UamVehicleRuntime` 하나가 있다. 물리 상태는
Runtime 소유이고 Python과 브라우저에는 관찰값만 전달한다. Runtime의 4 ms 실행 순서를
바꾸지 않는다. 단일 비행과 같은 AirTaxi FastPhysics 및 SimpleFlight 패키지를 사용한다.
다른 외형이 다른 제조사의 인증된 동역학을 뜻하지 않는다. 지상이동은 단일 비행의
ground_motion 제한을 사용하는 운동학적 이동이며 지상 물리 시뮬레이션으로 표시하지 않는다.

## C ABI v1 및 관찰값

`aerodt_uam_pilot` 공유 라이브러리는 abi/create/step/destroy/error 함수를 공개한다.
create는 상대 NED 좌표, 속도, fixed-wing 여부, capture 반경의 6개 double로 된 경유점
배열과 출발/착륙 yaw를 받는다. step은 제한된 시간과 선택적인 hold 목표를 받는다.
핸들은 단일 소유이고 예외는 경계를 넘지 않는다. DLL이 없거나 계산이 실패하면 사용자에게
오류를 알리고 멈춘다. 실제 실행에서 조용히 운동학 보간으로 되돌리지 않는다.

`TwinEntity`에 선택적인 pitch_deg, roll_deg, tilt_deg, rotor_radps, flight_phase를
추가한다. 기존 JSON 소비자는 무시할 수 있다. 브라우저 내부 worker packed stride는
21로 함께 바꾸고 round-trip을 시험한다. 자세와 로터는 같은 표시 시각에서 보간한다.
인승에 따른 8/11/13/15 m 강제 스케일을 제거하고 같은 단일 비행용 flight_visual과
rotor rig를 쓴다. flight_visual.size_m는 기존 GLB의 LOD 판단용 크기이지 새 확대 배율이 아니다.

## 경로와 임시 자료

- `route_path`는 이름 또는 ID의 JSON 배열이며 입력 순서를 보존한다. 잘못된 경로는
  경고/취소하고 직항으로 대체하지 않는다. 경로가 없는 기존 입력의 연습 호환은 남긴다.
- 기존 지도 링크가 없어도 CSV가 명시한 두 좌표의 연결은 계획자의 의도로 수용한다.
  지도 자체를 수정하지 않는다. 양방향 계획은 주어진 진행 방향으로 해석한다.
- 사용자가 임시 진행을 승인한 `지점 20`만 앞뒤 알려진 경유점의 중간 위치를 사용한다.
  실제 위치로 주장하지 않고 135편의 임시 사용을 UI와 계획 자료에 표시한다. 실제 지점이
  지도에 생기면 실제 좌표가 우선한다. 원본 CSV와 공유 항로 저장소는 수정하지 않는다.
- 순항 경로는 진행 방향 우측 30 m로 오프셋한다. 회랑 폭의 1/4을 넘지 않게 줄이며
  양 끝 200 m에서 원래 경로에 연결하고 급한 모서리의 miter 길이를 제한한다.
- 좁은 경유점에서는 일찍 역틸트하고 멀티로터로 감속/정렬한다. 이 precision_route
  프로파일은 다중 비행용으로 켜며 단일 비행의 기본값은 바꾸지 않는다.

우측 오프셋은 충돌회피 알고리즘이 아니다. 반대 방향 외에도 합류, 교차, 고도 차이,
대기 기체, 추월은 후속 분리 로직이 필요하다. 실제 운용 허가나 안전 보장을 하지 않는다.

## 시설과 수명

Gate 좌표는 저장된 레이아웃의 회전된 center_m를 사용한다. 존재하지 않는 Gate를
생성하지 않고 중복 배치는 실제 빈 Gate에만 재배정한다. 판의 DEM 기준과 platform
높이를 적용한다. PSU는 실제 점유된 FATO를 해제 전 재사용하지 않고 빈 Gate가 없으면
접근을 보류한다. 공중 대기는 native 목표이지 위치 덮어쓰기가 아니다.

`POST /api/simulation/scenario/example`은 application이 지정한 예시 파일을 매번 읽는다.
GUI 버튼은 '예시 비행계획 적용' 하나이고 파일 선택기는 제거한다. 기존 업로드 endpoint는
호환용으로만 남긴다.

`close_control`은 공유 시뮬레이션 종료다. native 핸들을 해제하고 scenario 개체를 내보내지
않는다. 동기화 성공/실패 양쪽에서 이전 scenario 개체를 걸러 잔상이 돌아오지 않게 한다.
다시 열면 처음 상태로 준비한다. 예정 운항 종료 시각이 지나도 미완료 비행을 공중에서
얼리지 않는다. 종료 요청이 실패하면 패널을 숨기지 않고 오류를 알린다.

## 검증과 남은 범위

Python 766, Node 759, CTest 18 통과, architecture PASS. 실제 CSV의 1,162편을 해석했고
84대로 1시간 native 시험에서 88편 시작, 16편 완료, native 실패 0을 확인했다. 전체 하루
완주는 검증하지 않았다. 별도 8885 서버와 Chrome에서 예시 적용, 재생, 닫기 후 scenario
개체 0을 확인했다. 사용자 8766 서버는 재시작하지 않았다.

짧은 구간/급한 선회는 보수적으로 감속하므로 예정 시간보다 늦을 수 있다. 기종별 물리
패키지, 모든 기체 간 충돌 검사, 실제 Unreal 실행 및 UAM 통합 승인 증거는 후속 검증이다.
