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
