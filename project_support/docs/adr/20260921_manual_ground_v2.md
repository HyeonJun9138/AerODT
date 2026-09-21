# 수동 지상 절차 v2: 하차와 충전 요청 분리

날짜: 2026-09-21

## 문제
수동 기체의 GATE 완료 보고에도 fleet 자동 도착 처리가 하차와 충전 연결 타이머를 시작했다. 확인한 실행 상태는 연결 중인데 충전 전력 0, 연결 객체 없음이었다. 별도의 ManualGround 절차 역시 하차가 끝나면 요청 없이 충전으로 넘어갔다.

## 결정
- 수동 기체(external)의 scenario 도착 보고는 자동 unloading/charging을 시작하지 않는다. 기존 자동 운항은 그대로 유지한다.
- ManualGround가 기존 수동 세션의 지상 절차를 소유한다. GATE 보고 및 안전 정차 후 disembark 요청으로 문 열기/하차를 시작한다.
- 하차 완료 시 충전기가 있으면 awaiting_charge 상태에서 기다린다. 새 ground action charge가 접수되어야 직원 이동, 연결, 충전 순서로 진행한다.
- charge는 접지, 배정 GATE 상면, 정지 속도, 로터 정지, 중립 입력을 재확인한다. 기존 request_id 멱등성을 유지한다.
- release는 awaiting_charge에서도 가능하며 케이블 분리 없이 2초 문 닫기로 끝난다. 충전 연결 후에는 기존 분리/문 닫기 순서를 유지한다.
- snapshot은 charge_requested_s, alighting_end_s, release 시 disconnect_s를 추가한다. 요청 전 crew_path는 null이다. 렌더러는 서버 door_open을 사용하고 요청 전 케이블을 표시하지 않는다.
- WebSocket ready에 ground_handling_v2를 추가하고 기존 v1 식별자도 유지한다. 새 클라이언트는 capability가 없는 서버에 charge를 보내지 않는다. 백엔드 재시작 및 새 세션/브라우저 새로고침이 필요하다.

## 경계와 제한
물리 pose, PSU 허가/점유, 자동 fleet 충전 계산을 재설계하지 않는다. 수동 배터리는 기존 ManualFlight 추정 에너지 경로를 유지하며 scenario fleet 에너지 장부와 통합했다고 주장하지 않는다. 오래 열린 서버 세션은 새 상태기계로 자동 이행하지 않는다.

## 검증
manual Python 207개, 집중 ground/completed-gate/scenario-energy 26개, cockpit/manual 브라우저 단위시험 249개 통과. native 정차/입력 잠금, 요청 전 충전 없음, 요청 후 SOC 증가 및 반복 절차 포함. 실제 도시 장면 충전과 전체 UAM 임무/Unreal 검증은 수행하지 않았다.
