# UAM 선택 범위 확대

사용자 승인: 화면 중심 반경 25 CSS px, 큰 모델 외곽 여유, hover/click 동일 판정. 기체 크기와 운항 상태는 변경하지 않는다.

1. `project_support/tests/web_live/browser/uam_picking.test.mjs`에 경계, 가까운 기체, 가림/숨김, 직접 선택 우선순위, 편집 회귀를 작성하고 기존 코드에서 실패를 확인한다.
2. `digital_twin/visualization/web/uam_picking.js`에서 현재 화면상의 후보만 검사한다. 중심 가까운 후보는 제한된 GPU pick으로 가림을 확인하고 큰 모델은 외곽 주변 GPU pick을 사용한다. 무제한 drill/투명 프록시는 추가하지 않는다.
3. `globe.js`의 hover/click을 같은 판정에 연결한다. 항공기/위성/편집 도구는 기존 범위를 유지한다. 단일 계획 UAM도 같은 판정을 사용한다.
4. Node 집중/전체 회귀, 문법, 계층 검사 및 실제 Cesium 독립 QA를 수행한다. 서버와 사용자 재생 탭은 재시작하지 않는다.
5. 증거와 개발 로그에 결과/제약을 기록한다. 현재 미커밋 변경은 보존한다.
