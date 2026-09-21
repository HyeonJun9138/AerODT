# Live Twin 도메인 배치 규칙

루트 `AGENTS.md`를 먼저 따른다. 이 폴더는 현재 상태를 소유하지 않고, 수집 자료를 불변 스냅샷으로 정렬하고 표시용 예측을 계산한다.

- 항공기 전용 구현은 `domains/aircraft`, UAM 전용 구현은 `domains/uam`, 위성 전용 구현은 `domains/satellite`에 둔다.
- 두 도메인이 같은 의미로 사용하는 ECEF 운동 계산은 `kinematics`에 둔다. 도메인 폴더가 다른 도메인 폴더를 직접 import하지 않는다.
- 여러 도메인의 자료를 하나의 스냅샷으로 합치는 코드만 `composition`에 둔다. 이곳에서 별도 현재 상태 저장소를 만들지 않는다.
- `weather_conditions.py`, `twin_models.py`처럼 역할이 명확한 범용 기능은 억지로 도메인 폴더에 복제하지 않는다.
- 루트의 옛 모듈은 이전 import를 위한 호환 진입점이다. 새 코드는 반드시 실제 구현 경로를 import한다.
- 파일 이동 시 `__file__` 기반 자원 경로, module monkey-patching, 지연 import를 시험한다.
