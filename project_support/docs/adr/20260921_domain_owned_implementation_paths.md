# ADR: 계층 내부의 도메인 소유 구현 경로

## 결정

최상위 계층은 유지하고, 혼재하던 구현을 해당 계층 내부의 `aircraft`, `uam`, `satellite` 소유 경로로 이동한다. 두 비행 도메인이 동일하게 사용하는 ECEF 운동 계산은 `digital_twin/live_twin/kinematics`, 여러 도메인의 결과를 합치는 코드는 `digital_twin/live_twin/composition`에 둔다.

외부 공급자는 `communication/external/aircraft`와 `communication/external/satellite`로 나눈다. UAM 전용 웹 route는 `communication/web/domains/uam`, 웹 서버의 UAM 물리 입력·운항·예측 조립은 `user_application/apps/web_dashboard/domains/uam`에 둔다. 기본 웹 설정은 platform, UAM, Satellite 문서로 나누되 `load_config()`의 결과는 이전과 동일하게 유지한다.

현재 AI PnP 구현은 모두 UAM용이므로 `ai_pnp/domains/uam`이 소유한다. 기존 import와 `python -m` 실행 파일은 호환 진입점으로 유지한다.

단, `ai_pnp/uam_route_model.py`는 배포 manifest가 경로와 파일 hash를 고정하므로 원래 위치와 바이트를 유지한다. 도메인 경로는 이를 참조한다. 이 파일을 실제로 옮기려면 모델 package와 검증 증거를 새 버전으로 갱신하는 별도 변경이 필요하다.

## 호환성

기존 Python import 경로는 같은 module 또는 같은 class/function 객체를 내보내는 호환 진입점으로 남긴다. 새 production import만 실제 소유 경로를 사용한다. wire schema, HTTP 경로, StateSnapshot, 시뮬레이션 순서와 설정 결과는 변경하지 않는다.

## 이유

도메인 개발자가 UAM 코드를 수정하다 위성 공급자나 궤도 계산을 함께 건드리는 상황을 줄이고, Satellite 기능을 추가할 때 UAM 구현을 복제하거나 재명명하지 않도록 하기 위해서다. 동시에 최상위 도메인 폴더를 만들지 않아 기존 계층 경계와 상태 소유권을 보존한다.

## 검증

호환 module identity, 도메인 간 직접 import 금지, 분리 설정 병합 결과, production import 경로를 구조 시험으로 고정한다. 기존 Python 회귀시험과 브라우저 시험은 이동 전 실패 목록과 비교한다.
