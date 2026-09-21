# Visual Asset Library Implementation Plan

**Goal:** 승인된 공유 라이브러리에 웹용 항공기와 위성 자산을 수집하고 재현 가능한 검증 근거를 남긴다.
**Architecture:** 정적 모델은 model_library, 도구와 원본은 project_support, 실행 증거는 data/workspace.
**Tech Stack:** Python 표준 라이브러리, GLB 2.0, glTF Validator, 브라우저 WebGL.
**Spec:** project_support/docs/adr/0010_visual_asset_library.md
**Execution:** 현재 작업에서 순차 실행. 기존 staged 변경을 커밋하거나 되돌리지 않는다.

## 제약

- ICDCDT 원본 보존. 기존 물리 package/compiler/runtime 변경 금지.
- 경로는 lower_snake_case, 루트 디렉터리 추가 금지.
- 공개 출처와 고정 revision 기록. 권리 미확인 항목은 public 배포 금지.
- 같은 bytes는 복제하지 않고 별칭으로 관리. 형상과 동역학을 구분.

## 작업

- [x] 1. `project_support/tests/integration/test_visual_assets.py`에 GLB 파싱, 외부 리소스 및 경로 거부, 라이브러리 checksum 시험을 먼저 작성하고 실패 확인.
- [x] 2. `project_support/tools/visual_assets/asset_library.py`에 검증과 읽기 전용 import 구현. `python -m unittest discover -s project_support/tests/integration -p test_visual_assets.py -v`로 검사.
- [x] 3. ICDCDT의 GLB/thumbnail/manifest를 검증하고 고유 형상 단위로 수집. 원본 manifest의 alias와 근사 치수 보존.
- [x] 4. Fab 원본 확보 가능 여부 기록. NASA와 제작자 공개 저장소에서 항공기 및 추가 위성 선별 수집. 원본 이력과 라이선스 문서 보존.
- [x] 5. 전체 GLB의 공식 validator 결과와 브라우저 로딩/렌더링 근거 생성. 변환 필요 파일은 검증 후만 등록하고 실패 항목은 대기 목록에 기록.
- [x] 6. 카탈로그 README, 사용법, 획득 대기 목록, CURRENT/HISTORY 갱신. architecture 회귀와 단위시험 재실행. 수량과 미완료 범위를 정확하게 보고.

## 실행 결과

86개 수집과 검증 완료. Fab 원본 획득은 진행 불가 조건을 기록하고 보류했다. 이는 요청 전체 완료가 아니라 1차 수집 결과다. 기존 staged 변경을 포함한 커밋/푸시는 수행하지 않았다.
