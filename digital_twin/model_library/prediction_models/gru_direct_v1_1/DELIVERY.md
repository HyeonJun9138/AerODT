# GRU V1.1 디지털 트윈 연동 명세

문서 기준: 2026-09-10, `gru_direct_v1_1`의 현재 Python 구현.
대상 독자: 외부 센서 또는 디지털 트윈의 추적 데이터를 모델에 연결하는 개발자.

## 1. 모델이 하는 일

**한 물체의 최근 3초간 위치·시간 16개를 받아, 앞으로 15초의 위치 75개를 한 번에 예측합니다.**
입력과 출력은 모두 3차원이며, 출력은 하나의 경로입니다. 확률 분포·신뢰구간·충돌 여부는 출력하지 않습니다.

### 입출력 개수 — 물체 한 개, 한 번의 예측 기준

| 구분 | 시점 수 | 시점당 값 | 총 숫자 개수 | 모델 내부 shape |
|---|---:|---|---:|---|
| 입력 | 16개 | x, y, z, t의 4개 | **64개 = 위치 48개 + 시간 16개** | `[1,16,4]` |
| 출력 | 75개 | x, y, z의 3개 | **225개 = 예측 위치 75점 × 3축** | `[1,75,3]` |

여기서 64개 입력은 시간순 16개 묶음으로 처리하며, 길이 64의 평탄한 배열로 전달하지 않습니다.
외부 API에서는 위치 `[1,16,3]`와 시간 `[1,16]`을 분리해 전달합니다.
추가 필수 필드 `valid_mask`에는 **bool 16개**를 전달하지만, 이는 유효성 검사 정보로 모델의 4개 feature에 포함되지 않습니다.

외부 API 반환값은 **3개 필드**입니다. 예측 위치 225개(`position_enu_m`), 같은 경로의
상대 변위 225개(`relative_position_m`), 시간 간격 75개(`horizon_s`)로 총 525개 숫자를 반환합니다.
이 중 **모델이 예측하는 값은 위치 225개**이며, 상대·원좌표 출력은 같은 경로의 두 표현이고
시간 간격 75개는 고정된 값입니다. 미래 경로가 두 개인 것은 아닙니다.

B개 구간을 함께 처리하면 모델 입력은 64B개, 예측 위치 출력은 225B개입니다.
`horizon_s` 75개는 batch 전체에서 공유합니다. 학습 시에만 사용하는 행동 정답은 구간당 16개이며 추론 입력에는 없습니다.

```text
외부 센서 / 추적기
  → 물체 ID별 관측 분리
  → 공통 ENU 좌표·m·s·5 Hz로 준비
  → 최근 16개 유효 관측
  → Predictor.predict(batch)
  → 미래 75개 위치 + 예측 시간
  → 디지털 트윈 좌표로 변환해 표시
```

V1.1은 고정 3초 입력입니다. 관측이 오래 쌓여도 최근 16개만 사용합니다.
물체 간 상호작용을 함께 예측하지 않으며, batch의 각 행은 독립된 물체 또는 관측 구간입니다.

## 2. 좌표와 시간 계약

| 항목 | 연동 규칙 |
|---|---|
| 좌표계 | Local ENU: x=East(동쪽), y=North(북쪽), z=Up(위쪽) |
| 위치 단위 | m |
| 시간 단위 | s, 관측이 발생한 시각 |
| 주기 | 5 Hz, 인접 관측 간격 0.2초 |
| 기준 시각 | 입력의 마지막 timestamp를 예측 기준 시각 t₀로 사용 |
| 입력 시각 | t₀−3.0, t₀−2.8, …, t₀: 양 끝 포함 16개 |
| 출력 시각 | t₀+0.2, t₀+0.4, …, t₀+15.0: 현재 시각 제외 75개 |

디지털 트윈이 NED, z-down, 다른 축 순서 또는 cm 단위를 사용한다면 **호출 전에 ENU·m로 변환**하고,
출력을 표시할 때 역변환해야 합니다. 관측 구간 내에서 좌표 원점·축을 바꾸면 안 됩니다.
현재 모델에는 heading 기준 회전이나 지도 좌표 변환 기능이 없습니다.
GPS 위경도, 영상, 거리·방위각을 직접 받지 않습니다. upstream에서 수치 XYZ를 준비해야 합니다.

Unix timestamp 또는 일관된 시뮬레이션 상대 시각을 사용할 수 있습니다.
절대 timestamp는 float64로 유지하십시오. float32로 미리 바꾸면 큰 시각값에서 0.2초 간격이 소실될 수 있습니다.
통신 수신 시각보다 **측정 시각**을 사용하고, 출력 시각에도 같은 시간 기준을 적용합니다.

## 3. 외부 호출 입력

호출: `predictor.predict(batch)` — NumPy 배열을 담은 Python dictionary.
B는 한 번에 예측할 구간 수이며 B≥1입니다.

| key | 필수 | shape | 권장 dtype | 의미 |
|---|---|---|---|---|
| `position_enu_m` | 예 | `[B,16,3]` | float64 | 시간순 관측 XYZ, m |
| `timestamp_s` | 예 | `[B,16]` | float64 | 각 위치의 관측 시각, s |
| `valid_mask` | 예 | `[B,16]` | bool | 모든 값이 True여야 함 |
| `sigma_m` | 아니오 | 고정 shape 규정 없음 | float64 | 현재 validator는 유한한 1·3·5 값만 허용. V1.1 예측 feature에는 사용하지 않음 |

최소 연동에서는 `sigma_m`을 생략합니다. B·시간·축 순서를 바꾸거나 마지막 batch 차원을 생략하면 안 됩니다.
NaN·Inf, 길이 부족, 무효 관측, 불규칙 시간 간격은 거부합니다. 시간 간격 검사 허용오차는 1e−6초입니다.
추가 key는 허용되지 않습니다. `object_id`, 행동 라벨, 센서 명령 등은 batch 밖에서 관리합니다.

예: 현재 시각이 10초인 물체 한 개의 위치 shape는 `[1,16,3]`, 시간은 `[7.0,7.2,…,10.0]`입니다.

## 4. 출력과 표시

반환값도 NumPy 배열을 담은 dictionary입니다.

| key | shape | 단위 / 의미 |
|---|---|---|
| `position_enu_m` | `[B,75,3]` | 입력과 같은 ENU 좌표계의 미래 위치, m |
| `relative_position_m` | `[B,75,3]` | 마지막 관측 위치로부터의 미래 변위, m |
| `horizon_s` | `[75]` | 공통 예측 시간 간격 `[0.2,0.4,…,15.0]`, s |

배치 b의 미래 시각은 `timestamp_s[b,-1] + horizon_s`입니다.
`position_enu_m`은 이미 정규화가 해제된 결과이므로 scale이나 현재 위치를 다시 더하지 마십시오.
배치 입력 순서와 출력 순서는 같습니다. 물체 ID는 호출자가 같은 순서의 별도 목록으로 연결합니다.

디지털 트윈에는 입력 관측 경로와 미래 예측 경로를 구분해서 그립니다.
새 관측이 오면 최근 16개로 다시 호출하여 이전 예측을 교체할 수 있습니다.
비동기 처리 시 늦게 도착한 과거 예측이 최신 예측을 덮지 않도록 물체 ID와 t₀를 함께 보관합니다.
출력 시각은 응답 수신 시각이 아니라 **입력 마지막 관측 시각**에 연결됩니다.

## 5. 모델 파일과 실행 환경

현재는 프로젝트 내부 Python API입니다. 독립 wheel, ONNX, REST/WebSocket 추론 서버는 이 문서에서 제공하는 기능이 아닙니다.
다른 언어의 디지털 트윈은 Python 프로세스와의 통신 계층을 별도로 구현해야 합니다.
8088 Dash 화면은 viewer이며, 외부용 추론 API endpoint로 가정하지 마십시오.

첫 연동은 이 프로젝트 checkout과 `pyproject.toml`·`uv.lock` 환경을 사용하는 방식입니다.
Python 3.12에서 프로젝트 루트에서 `uv sync --locked` 후 `uv run python ...`으로 실행합니다.
현재 lock은 PyTorch cu128 배포 경로를 사용합니다. 다른 장비에서는 해당 GPU·드라이버 호환성을 확인해야 합니다.
추론 장치는 `cpu` 또는 명시적 `cuda:0` 등을 선택합니다. 기본값은 CPU이며 CUDA 불가 시 자동 CPU fallback은 없습니다.

명시적으로 선택한 실행 폴더를 원래 구조대로 전달합니다.

```text
<project_root>/outputs/models/gru/v1_1/<run_id>/
  manifest.csv
  run.json
  status.json
  effective_config.yaml
  normalization.json
  checkpoints/best/model.safetensors
  checkpoints/last/model.safetensors   # last를 선택하는 경우 필요
```

`load_predictor`는 선택한 weights와 위 metadata의 manifest hash를 검사합니다.
실행 상태는 `completed` 또는 `stopped`여야 합니다. 실행 중이거나 실패한 run은 로딩하지 않습니다.
정상 중지되었더라도 유효한 manifest와 선택한 weights가 있어야 합니다.
따라서 임의로 status를 바꾸거나 weights 파일 하나만 복사해서는 연동되지 않습니다.
가장 안전한 전달 단위는 **정상 종료된 run 폴더 전체와 그 실행에 대응하는 소스·의존성 환경**입니다.
추론에는 학습용 원본 CSV나 optimizer 상태를 입력하지 않습니다.
`best`는 Validation ADE 기준 checkpoint이며 `last`와 구분됩니다. 자동 latest 선택은 없습니다.

## 6. 실제 Python 호출 예제

아래 코드는 가용한 V1.1 checkpoint를 확인하고 **선택한 run만** 로딩합니다.
`project_root`와 `run_id`는 전달받은 실제 값으로 바꾸십시오. checkpoint마다 한 번 로딩한 객체를 재사용합니다.

```python
from pathlib import Path
import numpy as np
from models.runtime.v1.simulation_inference import checkpoint_catalog, load_predictor

project_root = Path("/path/to/project")
run_id = "REPLACE_WITH_TERMINAL_RUN_ID"

available = [
    item for item in checkpoint_catalog(project_root)
    if item["plugin_id"] == "gru_direct_v1_1"
]
print(available)  # 선택 가능한 run_id / checkpoint / hash 확인

predictor = load_predictor(project_root, {
    "plugin_id": "gru_direct_v1_1",
    "run_id": run_id,
    "checkpoint": "best",
    "device": "cpu",  # CUDA 사용 시 "cuda:0"
})

# 연결 형식 확인용 직선 운동 샘플. 정확도 검증용 데이터가 아닙니다.
time_s = 7.0 + np.arange(16, dtype=np.float64) * 0.2
position = np.column_stack([
    100.0 + 5.0 * (time_s - time_s[0]),
    np.full(16, 20.0),
    np.full(16, 50.0),
])
batch = {
    "position_enu_m": position[None, :, :],
    "timestamp_s": time_s[None, :],
    "valid_mask": np.ones((1, 16), dtype=bool),
}
result = predictor.predict(batch)
future_times = time_s[-1] + result["horizon_s"]
future_positions = result["position_enu_m"][0]
assert future_positions.shape == (75, 3)
assert future_times.shape == (75,)
# 디지털 트윈의 좌표계로 변환 후 (future_times, future_positions)를 표시
```

이 API는 정규화, `eval()` 모드, gradient 없는 추론, 출력의 m 단위 복원을 처리합니다.
외부에서 입력을 미리 정규화하면 중복 정규화되므로 원래 m·s 값을 전달합니다.

## 7. 물체별 관측 누적 예제

아래는 디지털 트윈 쪽 adapter의 예시이며, 기존 V1.1 API가 자동 수행하는 기능은 아닙니다.
한 물체당 deque를 유지하고, 결측·시간 불연속이면 이전 이력을 버리고 새로 모읍니다.
이 예시는 늦게 도착한 관측의 재정렬이나 보간을 하지 않는 단순한 정책입니다.

```python
from collections import deque
import numpy as np

class TrackAdapter:
    def __init__(self, predictor):
        self.predictor = predictor
        self.histories = {}

    def remove(self, object_id):
        self.histories.pop(object_id, None)

    def observe(self, object_id, position_enu_m, timestamp_s, valid=True):
        history = self.histories.setdefault(object_id, deque(maxlen=16))
        point = np.asarray(position_enu_m, dtype=np.float64)
        if (not valid or point.shape != (3,) or not np.isfinite(point).all()
                or not np.isfinite(timestamp_s)):
            history.clear()
            return None
        if history and not np.isclose(
            timestamp_s - history[-1][0], 0.2, atol=1e-6, rtol=0
        ):
            history.clear()
        history.append((float(timestamp_s), point.copy()))
        if len(history) < 16:
            return None
        times = np.array([row[0] for row in history], dtype=np.float64)
        positions = np.stack([row[1] for row in history])
        result = self.predictor.predict({
            "position_enu_m": positions[None],
            "timestamp_s": times[None],
            "valid_mask": np.ones((1, 16), dtype=bool),
        })
        return {
            "object_id": object_id,
            "anchor_s": times[-1],
            "future_timestamp_s": times[-1] + result["horizon_s"],
            "position_enu_m": result["position_enu_m"][0],
        }
```

트랙 종료·ID 재사용·시뮬레이션 시간 되감기·좌표 원점 변경 시 이력을 초기화하십시오.
입력 주기가 불규칙하면 upstream에서 5 Hz 정렬 정책이 필요합니다.
이 모델은 누락값을 자체 복원하지 않으며, 보간 데이터를 사용할 경우 별도 성능 검증이 필요합니다.
다중 스레드에서 이 예제를 공유할 경우 이력 접근과 추론 호출의 동기화는 연동자가 구현해야 합니다.

## 8. 학습 전용 정보와 내부 텐서

모델 내부 입력은 `[B,16,4]`의 상대 XYZ·시간이며, 출력은 `[B,75,3]`의 정규화된 상대 위치입니다.
위치는 `(관측 위치−마지막 관측 위치)/scale_m`, 시간은 `(timestamp−t₀)/3초`입니다.
`scale_m`은 해당 run의 Train 미래 상대 거리 95백분위로 구하며 `normalization.json`에서 로딩합니다.
다른 run의 scale을 섞거나 디지털 트윈 입력마다 새로 계산하지 않습니다.

학습 궤적 정답은 미래 75개 **관측 위치**입니다. 추가로 입력 16개 시점 각각의 행동 정답을
보조 loss에 사용해 GRU의 행동 특징 학습을 돕습니다. 이륙·호버링·선회·착륙 등 19개 class를 사용합니다.
행동 라벨은 **학습용 정답**이며 외부 추론 입력이나 사용자용 출력이 아닙니다.
현재 class는 선회의 좌·우 방향을 별도 구분하지 않습니다.

## 9. 연동 확인과 운영 범위

| 확인 항목 | 확인 방법 |
|---|---|
| 좌표 변환 | 동쪽·북쪽·상향 이동 샘플로 XYZ 축·부호·단위 확인 |
| 시간 연결 | 마지막 입력 10초일 때 출력 시각이 10.2~25.0초인지 확인 |
| 모델 식별 | run_id, best/last, checkpoint SHA-256 기록 |
| 입력 유효성 | 16개 미만·NaN·시간 역전·결측은 추론하지 않거나 오류 처리 |
| 물체 분리 | 서로 다른 object_id가 같은 이력을 공유하지 않는지 확인 |
| 결과 갱신 | 과거 t₀의 늦은 응답이 최신 경로를 덮지 않는지 확인 |
| 지연 | 대상 장비에서 로딩 시간과 추론 시간 분리 측정, 첫 호출 이후 p50/p95 확인 |
| 정확도 | 실제 사용할 센서 잡음·좌표 방향·운동 조건에서 별도 평가 |

5 Hz마다 예측을 요청하려면 전체 전달·추론·표시가 0.2초 갱신 주기에 맞는지 측정해야 합니다.
현재 문서는 그 처리시간을 보장하지 않습니다. GUI thread에서 동기 추론하면 화면이 멈출 수 있으므로
별도 실행 경로를 권장합니다. 프로젝트의 `AsyncPredictor`가 있지만, 외부 통신 서버 자체는 아닙니다.

현재 학습 데이터는 합성 VTOL 관측 데이터입니다. 학습의 기본 관측 variant는 `sigma_1m`이며,
다른 센서 오차·실기체·다른 기체에서 같은 정확도가 나온다고 보장하지 않습니다.
예측 경로는 안전 보장 영역이나 비행 제어 명령이 아닙니다.

구현 근거: [public 입력 validator](../../../contracts/v1/simulation.py),
[checkpoint 로딩·Predictor](../../runtime/v1/simulation_inference.py),
[V1.1 모델·정규화 복원](model.py), [학습 데이터 처리](data.py).
