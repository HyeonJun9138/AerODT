# 0054: 브라우저 수신 순서에 시계 epoch 반영

날짜: 2026-09-11

## 문제

TwinWorld는 실시간에서 비행계획 재생으로 이동하거나 재생을 초기화할 때 기존 v1 snapshot의 epoch를 증가시킨다. 브라우저 DisplaySamples는 이를 알고 있지만 TrackingClient와 WorkerTrackingClient는 state_time만 비교하여 이전 날짜의 시뮬레이션 상태를 모두 버렸다. 별도로 조회하는 운항 표와 승객은 움직이는데 지도 비행체 상태는 수신되지 않는 결과였다.

## 결정

- 기존 snapshot wire 형식과 물리 실행은 변경하지 않는다. 수신 비교는 epoch 우선, 같은 epoch 안에서만 기존 시각/sequence 순서를 적용한다. epoch가 없는 기존 입력은 0으로 취급한다.
- Worker 내부 start, floor, resumed 메시지에도 epoch를 전달한다. 이전 epoch의 HTTP floor와 재개 응답이 새 재생 상태를 지우지 않게 같은 비교 함수를 사용한다.
- 서버 재시작은 epoch 자체가 0으로 초기화될 수 있다. `/ws/live`가 새 연결의 첫 프레임으로 현재 snapshot을 보내는 기존 계약에 따라, 새 소켓의 첫 유효 프레임이 낮은 epoch이면 수신 기준을 초기화한다. 이후 프레임과 교체된 소켓의 콜백은 이를 할 수 없다. 새 서버 sequence가 이전 값을 따라잡아도 복구한다.
- TrackingClient의 선택적 onReset 콜백은 이 연결 초기화를 알린다. Worker의 내부 streamRevision을 증가시켜 이전 연결에서 대기 중인 floor가 새 연결에 적용되지 않게 한다. 메인 스레드는 새 revision 첫 프레임에서만 순서 기준과 이전 pending 값을 초기화한다. 외부 서버 프로토콜 변경은 아니다.

## 검증과 한계

Worker 수신 회귀시험은 시계 되감기, 중복/옛 epoch 차단, floor 경합, 일시정지/재개, fallback, 서버 재시작, 이전 소켓 콜백을 포함한다. 모델 표시 검증은 별도 읽기 전용 브라우저에서 수행하고 운영 중 시나리오를 중지하거나 재생하지 않는다.

실제 서버를 재시작하는 검증은 운영 중 시뮬레이션을 보호하기 위해 하지 않는다. 서버 재시작은 모의 소켓 시험으로 검증한다. 아직 서버 instance ID가 없으므로 첫 연결이 과거 메시지를 재생하지 않는 현재 `/ws/live` 계약에 의존한다.
