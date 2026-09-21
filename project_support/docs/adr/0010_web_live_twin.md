# ADR 0010: Web Live Twin 입력과 상태 소유권

날짜: 2026-09-08. 상태: 승인된 사용자 설계의 구현.

## 결정

웹 대시보드는 외부 공급자 → Communication → Data ingestion → Live Twining → Runtime의 Real-time Twin → Communication → Visualization → User 화면 경로를 사용한다. 기존 UAM C++ 빌드와 실행 순서는 변경하지 않는다. 웹 Live 동기화에 한정된 SGP4 의존성은 이번 사용자 요청에 따른 범위 확장이다.

원본 자료, 출처와 수신 시각은 Data가 보유하고 현재 해석된 상태는 TwinWorld만 소유한다. LiveSynchronizer는 불변 입력과 이전 snapshot을 받아 새 변경값을 계산한다. 계산된 현재 상태를 그 내부나 UI의 별도 StateStore에 보관하지 않는다. GP 컴파일 캐시는 모델이지 상태가 아니다.

공유 모델 정의는 model_library/motion_models에 단일 저장한다. 3D 자산은 visual_assets에 단일 저장한다. 모델 패키지와 운용 구성은 복제하지 않는다. 운영 상태 보존 TTL은 운용 설정이며 추정 제한과 보정 상수는 운동 모델 정의이다.

## 공개 계약

HTTP /api/live/snapshot, WebSocket /ws/live는 schema_version=1의 동일 snapshot JSON을 제공한다. 단조 sequence/state_time, immutable entities, sources, capabilities를 포함한다. 도메인 객체를 재귀복사하지 않고 sequence마다 JSON 문자열을 한 번 생성한다. 이는 수정 불가능한 전송 파생물이며 권위 상태 저장소가 아니다.

entity는 위치, 속도, state_time, observation_time, received_time, orbit_epoch, derivation, quality, provenance, model_id, visual_asset_id, orientation_source, valid_until, discontinuity, continuity_id를 제공한다. continuity_id는 불연속이 발생한 뒤 유지되어 클라이언트가 중간 snapshot을 건너뛰어도 잘못된 장거리 보간을 하지 않도록 한다. 항공기 지상 track은 실제 body attitude로 주장하지 않는다.

GP는 실제 텔레메트리가 아니다. TEME에서 지구 고정계로 바꾸는 초기 계산은 GMST 회전과 지구 자전 속도를 적용하며, UT1/극운동 보정이 없는 시각화용 근사다. 고정밀 ITRF 변환을 달성했다고 주장하지 않는다. Python sgp4의 내부 Alpha-5 번호 제한은 계산에 사용되지 않는 bookkeeping ID만 대체하며 원본 OMM 식별자는 그대로 유지한다.

## 장애와 확장

자료 지연 시 제한적으로만 전파하고 유효기간이 지나면 정지/stale로 표시한다. 보존 TTL 이후 항공기는 현재 상태에서 제거한다. 새 관측의 정상 오차는 Live에서 점진 보정하고 큰 차이/재획득은 continuity 세대를 바꾼다.

인식/융합 및 상황평가의 결과는 disabled/None이다. 이 계약은 AI나 안전평가가 구현됐다는 의미가 아니다. fixture 모드는 명시적 opt-in이며 화면, 상태와 manifest에 기록한다. 외부 공급자 인증이 없으면 disabled 상태이고 fixture로 조용히 대체하지 않는다.

## 알려진 검증 경계

실제 공급자의 지속 수집 성공과 실제 Unreal 재검증은 별도 실행 증거가 필요하다. 브라우저 시험이나 과거 UAM 증거만으로 그 완료를 대신하지 않는다.
