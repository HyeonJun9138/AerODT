# AIPnP 경계

현재 웹 UAM의 단기 10초, 중기 90초, 장기 240초 학습 예측을 읽기 전용으로 계산한다.
`uam_route_model.py`는 검증된 패키지의 순전파, `uam_features.py`는 학습 입력 좌표와
특징 변환, `uam_prediction.py`는 같은 기준 시각의 모델별 결과 조립을 맡는다.

과거 입력 이력은 Data, 현재 물리 상태는 Digital Twin Runtime이 소유한다. 예측은
별도의 미래 결과이며 제어기에 되먹임하지 않는다. 실제 FastPhysics + SimpleFlight
비행 기준선의 실행 순서를 바꾸지 않는다. 입력 근사 및 수치 검증 한계는
`project_support/docs/adr/0058_uam_learned_prediction_comparison.md`에 기록한다.

위험 평가, 임무 계획 및 병렬 rollout은 아직 구현 범위가 아니다.
