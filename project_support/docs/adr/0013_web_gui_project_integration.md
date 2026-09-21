# ADR 0013: 웹 GUI 원본 프로젝트 통합

2026-09-08. 사용자 요청에 따라 웹 GUI와 최상위 main.py를 실제 프로젝트 원본에서 실행한다. 별도 작업 폴더의 소스나 환경으로 연결하는 우회 launcher가 아니다. 프로젝트 내부에 web_venv를 생성하고 관련 코드와 저장 GP를 반영한다. 인증 파일은 기존 저장소 밖 로컬 경로를 그대로 사용한다.

기존 86개 시각 자산과 그 catalog/schema 및 기존 Unreal/FastPhysics 소스는 덮어쓰지 않는다. 웹 렌더러 DTO는 model_library의 read-only projection에서 생성한다. public_export=false인 자산은 목록에 노출하지 않는다. procedural fallback은 별도 하위 영역/스키마로 분리해 원본 자산 검사 도구의 계약을 유지한다. /api/visual-assets의 schema_version=1 wire shape는 유지한다.

GUI 이외의 별도 작업 폴더 변경을 일괄 복사하거나 원본 git index를 바꾸지 않는다. 웹 46개, Node 30개, 기존 자산 15개 및 architecture 시험으로 통합을 확인한다.
