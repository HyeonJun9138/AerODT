# Twinning Test GPS 및 센서 모니터 확장

사용자 승인: 기존 수신 테스트를 실제 GPS 위경도와 고도에 따라 움직이는
독립 3D 지도 화면으로 확장한다. 건물은 표시하지 않는다. 최초 유효 GPS 고도를
지면 기준으로 삼고 이후 상대 고도 변화를 사용하며 GPS 고도 원본과 구별한다.
기존 운항 World를 수정하지 않는다. 같은 작업 폴더에서 기존 변경을 보존한다.

## 구현 분담
- [x] TCP JSONL v2의 선택적 attitude/acceleration/GPS 블록과 센서별 시각을 검증하고 v1 유지.
- [x] Runtime에서 센서별 현재 관측/freshness/고도 기준을 소유. 중복 관측은 freshness를 갱신하지 않음.
- [x] Data에서 최대60초/1200개 실제 수신 이력을 보유, Application에서 조립 및 history API 노출.
- [x] 독립 GPS 지도 렌더러: 건물/terrain 높이 없음, 좌표 변환, 고도 이동, 추적/자유/상부 시점, 경로, 중지/정리.
- [x] GUI: 지도 중심, 센서별 상태와 계기, 하단 실제 흐름과 그래프, 설정 접기, 원본 펼치기.
- [x] v2 송신 규칙 및 ADR, 회귀시험, 실제 loopback 브라우저 확인, 완료 기록.

검증은 TDD로 파서/센서 freshness/GPS 기준고도/이력 한도/표시 계약을 확인한다.
UI와 지도는 독립 파일 소유로 병렬 구현하며 backend와 통합 후 전체 관련 시험을 실행한다.
실제 ZIG SIM 원본 축, GPS 고도 datum, 실환경 위치 정확도 및 전체 UAM/Unreal은 별도 검증이다.
