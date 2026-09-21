# 0025 지상 이동 속도 프로파일과 이륙 초기 방향

2026-09-10, 채택

## 문제와 결정

최근 저장 비행에서 gate_out 종료 heading=55°, native takeoff 시작=0°였다.
이륙 pitch는 0~0.01°로, 보고된 약 45° 현상은 적어도 이 기록에서는
기체가 기울어진 것이 아니라 ground/native 경계의 yaw 초기화 불연속이다.
렌더링에서 숨기지 않고 native runner 초기 상태로 직전 지상 기수를 전달한다.

runner stdin에 선택적 `initial_yaw <degrees>`를 추가한다. 생략하면 기존 0°다.
유한 숫자만 받으며 runtime 생성 전에 initial_orientation_body_to_ned의 yaw
quaternion에 적용한다. 파이썬 어댑터는 이륙 직전 마지막 이동 leg의 끝 방향을
구한다. C++ binary와 어댑터를 함께 배포해야 한다. 옛 binary는 새 키워드를
거부한다. FastPhysics 적분, 제어기, mixer 실행 순서 자체는 변경하지 않는다.

## 지상 이동

model_library/ground_motion이 지상 중심선의 코너를 2 m 이내로 잘라
quadratic 곡선을 만든다. 각 인접 선분 길이의 24% 이하로도 제한해 연속
코너가 겹치지 않게 한다. 게이트와 FATO 끝점, 고도 기준은 유지한다.
원래 taxi_nodes는 길찾기 경로 식별자로 남고 실제 표시 path에는 곡선 표본이
추가된다. path의 각 점이 taxi_nodes와 일대일로 대응한다고 가정하면 안 된다.

목표 최고속도는 기존 기체 taxi_speed_mps다. 대표 횡가속 0.5 m/s²와
가감속 0.6 m/s²로 코너 속도 및 전후 가감속 상한을 계산한다. 이 값은
실측/인증된 항공기 지상 성능이 아니라 시뮬레이션용 가정이다. gate hold를
양 끝에 나누고 출발/도착 속도는 0이다. 긴 이동 선분도 2 m 이하로 나눠
가감속 시간 적분을 안정적으로 표현한다.

leg의 추가 선택 필드 `ground_motion`은 times_s, distances_m, speeds_mps의
동일 길이 배열이다. 시간과 거리는 단조 증가하며 샘플 사이 일정 가속도로
적분한다. leg duration, energy, battery 및 뒤 단계 시각을 새 소요시간에 맞춘다.
기존 파일에서 필드가 없으면 기존 선형 시간 경로를 유지한다.

실행기는 이 프로파일을 읽어 상태를 생산한다. state.f는 경로 거리 비율로
유지하고 battery는 시간 비율로 계산한다. 웹의 계획 미리보기도 같은
프로파일을 읽고, 기록 재생은 저장된 상태를 보간한다. View에서 원본 상태를
변형하거나 속도만 낮게 적어 실제 이동과 불일치시키지 않는다.

## 검증과 한계

곡선 끝점, convex hull 내부, 가속 상한, 거리/속도/시간 일관성, 단거리와
정지 경로, 상태 및 웹 프로파일 보간, C++ 실제 55° 이륙을 시험한다.
사용자 최근 요청(VP001→VP005)을 별도 공간에서 재생성하고 native로 다시
실행해 지상 종료와 이륙 시작 heading=55.08°가 같은 것을 확인했다.

코너는 중심선 사이의 영역에 머물지만 모델의 전체 swept envelope와 장애물,
유도로 포장 폭을 검증한 것이 아니다. 측정된 차량/견인 물리로 해석하지 않는다.
기존 저장 비행은 덮어쓰지 않고 새 계획/새 실행부터 적용한다. 착륙 후
지상 이동 시작 방향의 별도 정렬 및 일반적인 공중 선회 제어 개선은 범위 밖이다.

## 후속: 착륙 후 코너 heading 지연 제거 (2026-09-10)

사용자 저장 실행 20260910T062202Z-556aed7a에서 incoming taxi의 경로 선분 방향과 heading이 최대 57.994도 벌어졌다. ground_motor_lifecycle이 위치 이동과 무관하게 heading만 10도/초로 제한해 코너를 지난 뒤에도 계속 회전하는 원인이었다.

- ground_motion에 선택적 headings_deg 배열을 추가한다. 거리 표본마다 인접 접선을 중간 방향으로 연결하고 위치와 동일한 누적 거리로 방향을 보간한다. 서버 state_at과 브라우저 계획 미리보기가 같은 방식을 사용한다. 없는 구형 계획은 종전 선분 heading으로 해석하며 기존 저장 states는 수정하지 않는다.
- 코너 표본은 24개다. 기존 횡가속/종가속 제한에 더해 인접 heading 차이와 거리로 10도/초에 맞는 속도 상한을 두고 전후 가감속을 계산한다. heading을 이동 후 사후 제한하지 않는다.
- 실제 touchdown 방향이 첫 taxi 방향과 다르면 ground_motion.heading_alignment의 from_deg/duration_s로 정지 중 smoothstep 정렬한다. 최고 변화율이 10도/초 이내가 되도록 1.5*각도/10초를 예약하고 이동 시작까지 1초 여유를 둔다. 부족한 최초 hold는 늘려 계획과 charge-relative 하차 시각을 함께 재시간화한다.
- motor lifecycle은 표시용 로터 idle/shutdown만 담당한다. 네이티브 공중 동역학/제어/계산 순서는 변경하지 않는다. 지상 바퀴 물리 및 타이어 모델을 새로 구현한 것은 아니다.

검증 도구: `python -m project_support.tools.web_visualization.taxi_heading_check 20260910T062202Z-556aed7a`. 원본 저장 실행은 보존하고 workspace/visualization_checks/taxi_heading에 비교 실행을 만든다. 해당 경로 최대 heading/선분 차이 57.994→5.750도, 최대 yaw rate 10도/초 유지, 입고 taxi 82.4→105.5초. 유한 선분을 접선으로 보간하기 때문에 차이가 정확히 0은 아니다. 실제 Cesium 모형을 코너 전/중/후 시점에서 확인했으며 Unreal/실세계 지상 동역학 검증은 아니다.
