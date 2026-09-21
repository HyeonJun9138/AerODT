# ADR 0005: Native 실행 기록의 Data Layer 소유권

- 상태: 승인
- 날짜: 2026-09-03

## 배경

Native UAM 실행 프로그램이 실행 ID와 로그 폴더를 직접 만들면 Python 호환
실행과 같은 `data/workspace/logs/runs/<run-id>` 규칙을 반복 구현하게 된다. JSONL
event만 있고 최종 상태 manifest가 없으면 중단된 실행과 성공한 실행도 안정적으로
구분할 수 없다.

## 결정

Data Layer에 `RunRecorder`를 추가한다. recorder는 다음만 소유한다.

- 충돌 가능성이 낮은 실행 ID와 실행별 폴더 생성
- append-only `events.jsonl`
- `running`, `passed`, `failed`, `aborted` 상태의 `manifest.json`
- 임시 파일 뒤 교체하는 manifest 게시
- 정상 `Finish` 없이 파괴된 실행의 `aborted` 표시

시뮬레이션 상태와 임무 판정은 Data Layer에 넣지 않는다. 응용프로그램이 typed
event와 최종 상태만 recorder에 전달한다.

## 결과

- Native 실행도 Python 호환 실행과 같은 workspace 배치를 사용한다.
- 불완전한 실행을 성공 로그로 오인하지 않는다.
- FastPhysics, SimpleFlight 및 runtime은 파일 시스템에 의존하지 않는다.
