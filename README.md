# AeroDT
## 웹 GUI 실행

최상위 `main.py`를 실행한다. 현재 실제 프로젝트 위치는 `D:\AeroDT`이다.

```powershell
cd D:\AeroDT
python main.py
```

프로젝트 안의 전용 Python 환경을 자동 사용하고, 서버가 준비되면 브라우저를 연다. 이미 켜진 AeroDT는 재사용한다. 종료는 `Ctrl+C`. 현재 기본은 저장 위성 GP, 로컬 인증 OpenSky 항공기, Cesium 3D 건물이며 CelesTrak 외부 요청은 중지한다. 세부 설명은 `user_application/apps/web_dashboard/README.md`.


AeroDT는 항공우주 시스템을 대상으로 하는 디지털 트윈 실행 환경이다. 현재 기준선은 ProjectAirSim에서 검증된 FastPhysics와 SimpleFlight를 이용하는 쿼드 틸트로터 UAM 시뮬레이션이다.

## 저장소 구조

최상위 소스 폴더는 `foundation`, `communication`, `data`, `digital_twin`,
`ai_eng`, `ai_pnp`, `user_application`의 일곱 계층으로 제한한다. 문서, 저장소 전체
시험, 도구, 빌드 산출물과 참조 구현은 `project_support`에 모은다. 실행 데이터는
Data Layer 아래 `data/workspace`에 저장한다.

## 개발 및 Agent 작업 규칙

이 저장소를 수정하는 개발자와 자동화 Agent는 작업 전에 루트
[`AGENTS.md`](AGENTS.md)를 읽어야 한다. 이 문서는 계층 의존성, 상태 소유권,
모델 패키지 위치, FastPhysics 이산 실행 순서, ADR 작성 대상, 로그와 완료 기록
규칙을 정한다. 코드 경계의 상세 설명은
[`project_support/docs/architecture/BOUNDARIES.md`](project_support/docs/architecture/BOUNDARIES.md)에 있다.

웹 GUI 또는 도메인 코드를 변경할 때는 루트 규칙에 더해
[`user_application/web/AGENTS.md`](user_application/web/AGENTS.md)를 반드시 적용한다.
특히 다음을 지킨다.

- 공용 셸과 UAM·Satellite 도메인 코드를 분리하고, 다른 도메인의 내부 구현을 직접 import하지 않는다.
- 도메인을 선택하기 전에는 네트워크 요청, 폴링, 타이머, 오디오, 무거운 계산을 시작하지 않으며, 비활성화·`pagehide` 때 모두 정리한다.
- 브라우저는 불변 `StateSnapshot`을 표현만 하며 현재 물리 상태를 소유하거나 별도 상태 저장소를 만들지 않는다.
- GUI는 저채도 청회색 항공·관제 스타일과 기존 CSS 토큰, `.glass` 패널, 반경·간격 체계를 따른다. 상태는 색상만으로 전달하지 않는다.
- 1280×720과 1920×1080, 작은 화면 breakpoint, 키보드 접근성, `prefers-reduced-motion`을 확인한다.
- GUI 변경은 관련 자동 시험과 브라우저 전체 시험의 기존 실패 baseline 비교, 별도 탭에서의 실제 화면 확인을 거친다. 실행 중인 사용자 비행 탭을 임의로 새로고침하거나 reset하지 않는다.

인증정보, 실행 로그, 공급자 캐시, 원본 DEM과 임시 자료는 저장소에 넣지 않는다.
GLB·ONNX·PyTorch 가중치는 Git LFS로 관리한다.

## Native UAM 검증

FastPhysics + SimpleFlight native 구성과 회귀시험은 renderer 없이 빌드한다.

```powershell
.\project_support\tools\test_structure.ps1
```

실행별 manifest, 단계 event와 sensor sample은 로컬
`data/workspace/logs/runs`에 저장되며 Git에는 포함되지 않는다.
현재 개발 상태와 영구 검증 요약은 `data/development_log/CURRENT.md`와
`data/development_log/evidence`에서 확인한다.

시각화와 조종석은 `python main.py`로 실행하는 CesiumJS Web Dashboard가 담당한다.
외부 원본, 실행 로그, 빌드 산출물과 DEM은 저장소에 포함하지 않는다.

## 라이선스

프로젝트는 루트 `LICENSE`의 MIT 조건을 따른다. ProjectAirSim과 제3자 구성요소의
고지는 `NOTICE.txt`에 유지한다.
