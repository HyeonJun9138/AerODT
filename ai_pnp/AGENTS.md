# AI PnP 도메인 배치 규칙

루트 `AGENTS.md`를 먼저 따른다. 이 계층은 미래 상태와 계획 결과를 계산하며 runtime의 현재 상태를 소유하거나 수정하지 않는다.

- UAM 전용 feature, 학습 궤적, 위험 예측과 카메라 탐지는 `domains/uam`에 둔다.
- Satellite 예측·계획 기능은 실제 계약과 검증 자료가 생길 때 `domains/satellite`에 추가한다. UAM 모델을 이름만 바꾸어 재사용하지 않는다.
- 도메인 입력은 불변 snapshot 또는 명시적인 history이며, 결과는 runtime 제어 명령으로 암묵 변환하지 않는다.
- 루트의 기존 Python 파일은 import 및 `python -m` 호환 진입점이다. 새 production 코드는 실제 도메인 경로를 사용한다.
- 모델 artifact 경로, feature 순서와 checksum을 이동 과정에서 바꾸지 않는다.
- 예외로 `ai_pnp/uam_route_model.py`는 배포된 manifest가 파일 경로와 SHA-256을 함께 고정한다. 검증된 manifest를 버전 변경하기 전에는 이 파일을 이동하거나 다시 포맷하지 않는다. `domains/uam/uam_route_model.py`는 이 감사된 구현을 가리키는 도메인 진입점이다.
