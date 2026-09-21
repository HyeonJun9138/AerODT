# Communication 도메인 배치 규칙

루트 `AGENTS.md`를 먼저 따른다. Communication은 외부 wire/기술 경계만 소유하며 현재 상태, 임무 판단과 물리 계산을 소유하지 않는다.

- 공급자 adapter는 `external/aircraft`, `external/satellite`처럼 자료의 도메인 아래 둔다.
- UAM 전용 HTTP·WebSocket route는 `web/domains/uam`에 둔다.
- 압축, 정적 파일, Cesium 지도 자료, 스냅샷 인코딩, 여러 entity kind의 읽기 전용 stream처럼 의미가 같은 전송 기능은 `web`의 역할별 공용 위치에 둔다.
- 도메인 route끼리 직접 import하지 않는다. 공통 전송 계약만 상위의 구체적인 역할 모듈에서 사용한다.
- 루트에 남은 이전 route/source 파일은 호환 진입점이다. production 조립 코드는 실제 도메인 경로를 import한다.
- UI 선택만으로 공유 수집기나 다른 사용자의 서버 실행을 중지하지 않는다.
