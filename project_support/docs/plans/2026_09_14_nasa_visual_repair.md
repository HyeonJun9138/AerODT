# NASA 시각 모델 정규화 구현 계획

> 구현은 현재 작업에서 직접 진행한다. 기존 사용자의 변경과 실행 중인 비행 상태를 보존한다.

**목표:** 승인된 NASA 9종의 크기, 방향, 배색, 회전축과 틸트 구조를 수정한다.
**구조:** 시각 자산 변환 도구와 GLB 및 asset.json만 수정한다. 공통 비행 동역학과 상태 계약은 유지한다.
**기술:** Python, NumPy, glTF 2.0, 기존 RotorSpin, Three.js 검증 화면.
**요구사항:** NASA 공식 기준기체 이미지의 파란 동체와 어두운 창 및 로터를 참고한다. 출처와 물리 치수의 검증 범위를 명시한다.

- [x] `project_support/tests/visual_assets/test_nasa_repair.py`에 미터 단위, +X 전방, 기종별 틸트와 로터 축 회귀시험을 작성하고 기존 자산에서 실패를 확인한다.
- [x] `project_support/tools/visual_assets/repair_nasa_assets.py`에 원본 백업, 피트 변환과 기준축 정렬, 회전축 재배치, 기종별 틸트 구성, PBR 배색을 구현한다. 원본을 보존하고 재실행 시 중복 변환하지 않는다.
- [x] 좌석과 계기판 좌표에도 동일 변환을 적용한다. 로터 중심과 블레이드 길이를 보존한다.
- [x] 9종에 적용한 뒤 회귀시험과 glTF validator, 기존 RotorSpin 시험을 실행한다.
- [x] 실제 브라우저에서 축, 크기, 재질과 hover/cruise 장면을 비교하고 가벼운 JPG 썸네일을 새로 저장한다.
- [x] CURRENT.md와 HISTORY.jsonl에 검증 명령, 결과와 남은 한계를 기록한다.

검증 명령: `python -m unittest discover -s project_support/tests/visual_assets -p test_nasa_repair.py -v`

원본 보존 위치: `data/workspace/visual_assets/nasa_repair_original/`. 다른 자산과 사용자 변경을 되돌리지 않는다. 외형 실측이나 실제 Unreal 실행을 하지 않은 경우 인증 또는 전체 수용시험 완료로 기록하지 않는다.
