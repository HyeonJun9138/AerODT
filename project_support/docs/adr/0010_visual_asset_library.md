# 공유 시각화 자산 라이브러리

날짜: 2026-09-08. 사용자 승인: 공유 라이브러리, 원본 보존, 웹용 GLB와 권리 검증을 분리하는 설계.

## 결정

3D 형상은 `digital_twin/model_library/visual_assets`가 소유한다. 기존
`packages`의 FastPhysics/SimpleFlight 물리 패키지와 혼합하지 않는다.
민간 항공기, 군용 항공기, 위성으로 분류하되 NASA 연구용 도색을 실제 군용
기체 외형이라고 표시하지 않는다. 같은 형상의 위성군 매핑은 복제 대신 별칭으로 둔다.

`catalog.json`은 asset metadata 경로의 색인이다. 각 `asset.json`에 출처,
라이선스와 배포 검토 상태, SHA-256, 형상 정확도, 치수 근거, 변환 이력,
검증 결과를 기록한다. GLB와 썸네일은 모델별 디렉터리에 둔다.
권리 확인 대기와 다운로드 대기는 별도 acquisition 목록에 기록하고 배포 색인에
없는 모델을 있다고 표시하지 않는다. NASA 사용지침, 상표와 제작자 권리는 별도다.

원본과 공급자 문서는 `project_support/reference/visual_asset_sources`에 보존한다.
실행 코드에서 이 경로를 읽지 않는다. 변환/검증 도구는 `project_support/tools/visual_assets`,
실행 증거는 `data/workspace/visual_assets`에 둔다. 공개 배포 전 권리 재검토가 필요하며
검증된 파일 형식과 권리 허가를 동일한 boolean으로 합치지 않는다.

## 범위와 비목표

ICDCDT는 읽기 전용이다. GLB가 이미 적절하면 원본을 그대로 사용한다.
추가 항공기 및 위성은 제작자나 공식 배포 출처를 확인하여 수집한다.
로켓, 지상/해상 이동체, 파편, 빈 미래 디렉터리는 추가하지 않는다.
3D 형상은 `visual_only`이며 새 동역학, 실제 텔레메트리 또는 기체 인증 제원이 아니다.
기존 실행 상태, 제어 주기와 Unreal 코드는 변경하지 않는다.

## 검증

단위시험으로 GLB 손상, 외부 URI, 경로 이탈, 중복과 checksum 불일치를 검출한다.
전체 자산에 glTF validator를 실행하고 브라우저 렌더링 결과를 별도로 기록한다.
브라우저 smoke test는 형상 정밀도나 모든 애니메이션의 품질 인증이 아니다.
기존 architecture 시험을 재실행한다. UAM/Unreal을 재실행하지 않았다면 전체 시스템
완료 검증이라고 보고하지 않는다.
