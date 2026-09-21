# ADR0091: 로컬 원본 진단

GET /api/twinning-test/wire는 실제 peer가 loopback일 때만 최신 TCP 원문 한 줄을 반환한다. 최대4096바이트, 메모리만 사용, Cache-Control no-store, 중지와 재연결 시 제거한다. forwarded 헤더는 신뢰하지 않는다. LAN에서는403. 일반 상태 API 및 영구 로그에는 추가하지 않는다. 원본에 포함된 미해석 센서 필드 확인을 위한 진단이며 제어 및 상태 소유권은 변경하지 않는다.
