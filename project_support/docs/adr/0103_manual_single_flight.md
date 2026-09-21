# ADR 0103: 수동 단일 비행 입력과 지상 훈련 보조

- 상태: 웹 시뮬레이터 구현, native/API 회귀 검증 완료; Unreal 미검증 (2026-09-17)
- 기존 Autopilot은 생성된 기록의 재생이다. Manual은 연결별 native UamVehicleRuntime을 생성하며 Python/브라우저에서 위치를 적분하지 않는다.
- C ABI: aerodt_manual_create(yaw), step_v2(handle, double[5] throttle/roll/pitch/wing-request/yaw, int steps 0..25, double[13] snapshot), destroy, error. 독립 aerodt_uam_manual_v2 DLL로 기존 pilot ABI 및 실행 인스턴스를 변경하지 않는다.
- WebSocket /api/simulation/manual: 최초 {plan_id,altitude_m}; 저장 계획 control_mode=manual만 허용. 지형 고도는 시각화가 해석한 출발 위치 기준이며 동일 평면 접촉을 사용한다. 응답 ready/state는 runtime snapshot에서 변환한 sample. 입력 sequence는 엄격 증가하며 throttle 0..1, roll/pitch/yaw -1..1, flight_mode multirotor/fixed_wing. pause/resume/stop 제어. 요청 간 실시간 간격을 4ms 스텝으로 진행하고 0.5초 이상 끊긴 입력은 진행하지 않는다. 연결 종료 및 30초 무입력은 handle을 해제한다. 같은 origin 및 최대 4 세션.
- 자세 보조: 스틱은 roll ±6.9도/pitch ±5.7도 요청이며 0.45초 입력 평활화 및 yaw ±12도/초 요청, collective 변화율 15%p/초 제한, 자세/각속도 피드백 후 기존 SimpleFlight mixer와 actuator/FastPhysics에 전달. 스로틀은 0..1 collective 명령으로 고도 유지 기능이 아니다. 고정익 요청은 지상 또는 출발면 15m 이내에서 억제하고, 부분 틸트로 가속 후 15m/s 이상에서 완전 전환한다. 요청 모드와 실제 틸트 기반 모드는 구분한다.
- 모든 형상은 기존과 동일한 AirTaxi 공통 동역학. 출발면 평면 외 지형/건물 충돌, 인증 성능, 기종별 실측 배터리 모델은 범위 밖이다. 에너지 값은 단순 추정이며 20% 이하는 경고 기록만 하고 강제 추락시키지 않는다.
- Data RunLogger에 입력과 샘플 및 저배터리 이벤트를 기록하고 종료 manifest를 남긴다. 제어 명령은 시뮬레이션 전용으로 외부 기체에 전달하지 않는다.

- 키 계약(2026-09-17 사용자 변경): 방향키 pitch/roll(지상에서는 전후/좌우 속도 요청), Q/E 요잉, W/S collective 6%p/초 증가/감소 후 유지, Z/X 고정익/멀티로터. 키 해제 시 자세/회전 입력은 0으로 복귀한다.
- 지상 보조 계약: Runtime.AdvanceGroundAssist -> FastPhysics.AdvanceGroundAssist. 상태는 기존 physics 객체가 계속 단독 소유한다. 이 별도 경로에서만 출발면 0.2m 이내 및 상승속도 제한을 검사하고 기체 기준 전후/측방 합성 1.5m/s, 가감속 0.8m/s², yaw 0.21rad/s로 적분한다. 평면 위 pitch/roll은 수평 유지하며 키를 놓으면 감속한다. 휠 역학이나 건물 충돌 모델이 아닌 명시적인 훈련용 지상 보조이며 일반 Advance 순서는 바꾸지 않는다. collective 10% 이하의 지면 근접 상태에서만 사용하고 이륙 후 기존 native 물리 경로로 돌아간다.
- 검증: JS 수동 입력/패널/실행 연결 7건, Python 실제 DLL/WS/기록/지상 전후측방/제동/yaw/착륙 5건, 재빌드한 native physics/contact/ground/runtime CTest 4개 스위트 통과. 실제 Unreal 실행 증거는 없으므로 프로젝트 전체 완료 기준 달성을 주장하지 않는다.

- 2026-09-17 입력 안정성 수정: 제어 전송은 RAF가 아닌 50ms 타이머에서 진행하며 서버 ACK backpressure를 유지한다. 서버 지연 보호 임계는 2초, 적분은 여전히 요청당 최대 100ms로 제한해 지연분을 몰아서 진행하지 않는다. focus/visibility 복귀 시 눌림 키를 비우고 resume ACK 후 활성화한다. keepalive/alive 메시지는 상태를 진행하지 않고 일시정지 연결만 유지한다. 실제 socket 단절은 재시작 필요 안내를 유지한다.
