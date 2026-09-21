# 선택 기체 사운드 구현 계획 (2026-09-13)

승인 설계: 선택한 한 기체만 음향화. 기본 음소거, 볼륨, 거리 감쇠, RPM/틸트/속도 우선, 단계 보조값, UAM/일반 항공기/위성 음색과 자연스러운 전환. 위성 및 미측정 엔진음은 연출임을 표시한다.

## 경계 및 구현 순서
- [x] digital_twin/visualization/web/entity_sound_profile.js: 상태를 읽어 음향 목표값 계산. 상태 변경 없음. 기종별 대표 음색, 유효 RPM 0 보존, Physical RPM 부재 시 가상 회전 금지. Node 회귀 먼저 작성.
- [x] digital_twin/visualization/web/selected_entity_audio.js: Web Audio 합성, 두 개의 고정 voice bank 교차 전환, 평활 파라미터, 제한된 최대 출력, mute/suspend/destroy. fake context 수명주기 및 실제 OfflineAudioContext 검증.
- [x] user_application/web/entity_sound_controls.js 및 CSS: 음향 토글/음량/설명. app.js에서 선택 기체의 표시 telemetry와 카메라 거리 공급, 숨김과 종료 정리. index.html 설정 영역에 삽입.
- [x] project_support/tests/web_live/browser/entity_sound.test.mjs: 수치, 누락/정지/거리, 교차 전환, 재생 실패, 자원 제한, UI 상태 회귀.
- [x] project_support/tools/web_visualization/entity_sound_check.html: 독립 브라우저 검증. 실운항 재시작/변경 없이 오프라인 음향 수치 및 버튼/거리 전환 확인.
- [x] 관련 테스트/구문검사 및 개발 로그. 실제 청취 미실시 시 음질 확인 완료로 쓰지 않는다.

현재 작업 디렉터리의 사용자/동시 작업 변경을 유지한다. 서버 배포, 운영 프로세스 재시작, 물리 상태/전송 계약 변경은 범위 밖이다. 새 외부 음원/라이선스 의존성 없음. 음향은 연구용 청각 표현이며 음압/소음 인증 모델이 아니다.

검증 결과: 관련 Node 79 PASS, 변경 JS 구문 PASS. 독립 Chromium Web Audio 12초 오프라인 렌더링 PASS(peak 0.617534 미만, 마지막 0.5초 RMS 0.0000891 미만), 실제 context 토글 running→suspended 확인. 운영 지도 통합 청취와 실제 스피커 음질 평가는 미실시. 코드 리뷰 지적 두 건 회귀로 재현 후 수정 확인.
