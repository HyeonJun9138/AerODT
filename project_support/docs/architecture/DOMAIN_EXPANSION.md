# UAM과 Satellite 확장 경계

## 2026-09-21 현재 적용한 범위

프런트엔드 구현을 공용 셸과 UAM/Satellite 화면으로 분리했다. 지도 준비 뒤 명시적으로 도메인을 선택해야 하며, UAM은 기존 서울 진입을 사용하고 Satellite는 지구 전체를 보여준다. 화면 필터와 라이브러리 설정 범위를 한 곳에서 결정한다. 세부 이동 목록은 `project_support/domain_split_20260921/moves.json`에 있다.

기존 UAM 화면 55개는 `user_application/web/domains/uam`으로 옮겼다. Satellite에는 기존 데이터 표시만 연결했다. 이후 서버와 통신의 기존 구현도 계층 내부에서 분리했다. 현재 배치와 공유 판단 기준은 [도메인 소유권과 공유 경계](DOMAIN_OWNERSHIP.md)를 따른다.

## 계층과 도메인은 다른 축이다

최상위에 UAM/Satellite 폴더를 만들고 통신, 동역학, 데이터와 GUI를 모두 넣지 않는다. 기존 최상위 계층은 유지하고, 도메인별 구현이 실제로 필요한 계층 내부에서 나눈다.

| 관심사 | 책임과 현재 위치 | 향후 위성 확장 시 지킬 경계 |
|---|---|---|
| 이해관계자 및 조작 화면 | `user_application/web/domains/uam/operations` | 위성 운영자, 임무 요청자, 지상국 담당 화면은 Satellite 내부에서 별도 정의 |
| 임무계획과 단계 | `user_application/uam_mission`, 웹의 `uam/planning` | 위성 임무의 목표와 일정은 응용 계층. 동역학 엔진을 화면 안에 구현하지 않음 |
| 물리 계산 | `digital_twin/simulation`의 기존 FastPhysics/SimpleFlight | 이번에는 우주 동역학 엔진을 추가하지 않음. 향후 추가 전 입력/출력 계약과 검증 기준 필요 |
| 정적 모델 | `digital_twin/model_library/packages` | 질량, 관성, 센서 등은 버전 가능한 모델 패키지. 운용 구성과 혼합 금지 |
| 현재 상태 | `digital_twin/runtime` 및 기존 live-twin 경로 | 브라우저 도메인마다 현재 상태 저장소를 새로 만들지 않음 |
| 외부 자료 | `communication/external/aircraft`, `communication/external/satellite` | 공급자별 adapter를 분리하며 기존 `live_sources.py`는 호환 경로로만 유지 |
| 기존 궤도 표시 계산 | `digital_twin/live_twin/domains/satellite` | SGP4 표시 계산은 Satellite가 소유하며 새 우주 동역학 엔진을 의미하지 않음 |
| 실시간 상태 동기화 | `digital_twin/live_twin/composition` | UAM/항공기/위성 결과를 읽기 전용으로 합치며 현재 상태를 별도로 소유하지 않음 |
| 분석 및 예측 화면 | `uam/analysis`, `uam/prediction` | UAM 운항 지표를 위성 지표로 재명명하지 않음. 위성용은 현재 미구현 |
| 기록과 재생 | `data` | 도메인 태그/스키마 변경이 필요해지면 별도 ADR과 호환 시험 후 도입 |
| 시각화 | `digital_twin/visualization/web` | Cesium 렌더링은 공용. 해당 계층의 대규모 이동은 이번 범위 밖 |

## 기능 격리의 의미

Satellite 선택 시 이 브라우저의 UAM 운항 감시와 예측 갱신을 중지 상태로 유지하고, 기체 음향 객체를 만들지 않는다. 수신 스냅샷은 위성 개체만 표시한다. 하지만 공용 서버의 UAM 엔진이나 외부 수집기를 중지하지는 않는다. 다른 사용자의 운항을 브라우저 선택만으로 바꾸지 않기 위해서다.

공용 지도 설정은 계속 같은 브라우저 값을 사용한다. UAM 전용 설정은 Satellite에 노출하지 않는다. 나중에 같은 기능을 도메인별로 다르게 저장해야 한다면 별도 버전 키와 기존 값 마이그레이션을 설계한다.

## 남은 구조 정리

1. `app.js`의 UAM 구성 코드 일부를 생명주기 단위로 추가 추출한다. 현재는 생성과 활성화를 분리했지만 모든 UAM 모듈이 지연 import되는 구조는 아니다.
2. 웹 서버의 `application.py`는 composition root로 남아 있다. 새 도메인 기능은 이 파일에 구현하지 말고 해당 `domains/<domain>` 모듈에서 조립한 뒤 등록만 한다.
3. 실제 위성 임무계획 요구가 정해지면 운영 역할, 시간 기준과 좌표계, 자원 제약, 평가 지표를 먼저 계약으로 정의한다.
