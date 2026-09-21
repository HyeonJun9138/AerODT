# ADR 0085: Scheduling 준비 단계 진행 상태

날짜: 2026-09-14

## 원인과 결정

파일 생성 완료와 시뮬레이션 적용 완료는 다르다. 기존 PlanGenerator는 파일 단계에서 100%를 공개한 뒤 동기적인 ScenarioSession.load 및 초기 예측 준비를 수행했다.

PlanGenerator의 실행 중 진행률은 99% 이하로 제한한다. 파일 생성은 0–70%, 초기화는 70–80%, 첫 비행 예측 준비는 80–98%, 공개/적용은 99%로 표시하고 apply 반환 후에만 done/100을 공개한다. 이 비율은 작업 단계 구분이며 남은 시간의 추정값이 아니다. 독립 generate 함수의 기존 0–100 계약은 유지한다.

## 추가 계약

기존 status 필드를 유지하고 실행 시작 후 elapsed_s, phase_elapsed_s, phase_seconds 및 완료/오류 시 finished_at을 추가한다. 시간은 단조 시계 기준 초이며 종료 후 고정된다. phase_seconds는 단계별 누적 시간이고 현재 단계의 경과 시간도 포함한다. 기존 phase에 initialize, forecast, publish가 추가된다.

ScenarioSession.load(on_progress=None)와 ScenarioEngine(on_prepare=None)은 선택적 (phase, completed, total) 콜백을 받는다. forecast 개수는 예측 시도를 처리한 기체 수이며 예측 성공 수가 아니다. 실패 시 기존 보수적 대체 동작을 그대로 유지한다. 콜백은 짧고 예외를 발생시키지 않아야 한다.

PlanGenerator의 apply는 on_progress 키워드를 선언하거나 **kwargs를 수용할 때만 콜백을 받는다. 기존 두 인자 호출은 유지하며 예외 후 재호출하지 않는다.

## 범위와 검증

FastPhysics 계산, 비행 경로, 예측 횟수 및 순서는 변경하지 않았다. 시간 제한으로 준비를 생략하거나 가짜 완료로 전환하지 않는다. 프런트엔드는 전체/현재 단계 경과 초와 기체 처리 수를 표시한다.

Python 관련 회귀시험 65개, Scheduling DOM 시험 11개 통과. 예측 실패 시에도 후속 기체 처리 보고, 준비 중 시뮬레이션 시간 불변, 적용 오류 단일 호출 및 시간 고정 확인. 실제 운영 서버 재시작/재생성 및 Unreal 실행은 수행하지 않았다. 전체 준비 시간 단축은 이 변경의 검증 결과가 아니다.
