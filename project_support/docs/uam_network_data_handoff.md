# UAM 버티포트·항로 데이터 인계 (스케줄링/비행계획 담당자용)

이 문서는 AeroDT가 만들어 내보내는 **버티포트 형상**과 **node–link 항로망** 데이터를, 받는
쪽에서 바로 읽고 쓸 수 있도록 정리한 것이다. 스케줄링에 필요한데 **이 데이터에 들어 있지
않은 것**도 함께 적었다 — 그게 다음 대화의 출발점이다.

- 기준: `schema_version` 버티포트 layout 2, 항로 1
- 현재 규모: 버티포트 **18**, 항로 지점 **40**, FATO 지점 **24**, 링크 **(아래 5-1 확인)**
- 좌표계·단위는 5장에 한 번에 정리했다. **읽기 전에 5장을 먼저 볼 것.**

---

## 1. 받는 방법

서버는 이 PC에서 돌고 있고, 셋 중 아무 방법이나 쓰면 된다.

### 1-1. HTTP (권장, 항상 최신)

| 목적 | 요청 |
|---|---|
| 버티포트 전체 (형상 포함) | `GET /api/simulation/vertiports` |
| 항로망 전체 (지점·FATO·링크) | `GET /api/simulation/routes` |
| 선택지·기본값·한계 | `GET /api/simulation/vertiports/options`, `GET /api/simulation/routes/options` |
| 데이터가 바뀌었는지만 확인 (88바이트) | `GET /api/simulation/revision` |

`revision`은 저장된 모든 레코드의 해시다. 값이 그대로면 아무것도 안 바뀐 것이니,
주기적으로 가져다 쓸 때 이것만 폴링하면 된다.

### 1-2. 파일

- `data/workspace/simulation/vertiports.json` — 버티포트 **정의만** (형상은 없음)
- `data/workspace/simulation/routes.json` — 지점과 링크

**주의**: 파일에는 형상(layout)이 없다. 정의만 저장하고 읽을 때마다 다시 계산하는 구조라,
형상이 필요하면 1-1의 HTTP를 쓰거나, 저쪽에서 같은 규칙으로 계산해야 한다.

---

## 2. 버티포트

### 2-1. 정의 (사람이 입력한 값)

```json
{
  "id": "VP001",
  "name": "여의도",
  "latitude": 37.526513,
  "longitude": 126.922845,
  "heading_deg": 0.0,
  "pattern": "row",
  "vehicle_class": "medium",
  "vehicle_d_m": 12.0,
  "platform_height_m": 6.0,
  "ground_reference": "highest",
  "gates": 4,
  "fatos": [{ "id": "F1", "role": "both", "side": "front" }],
  "created_at": "2026-09-09T09:43:27+00:00",
  "updated_at": "2026-09-09T09:54:13+00:00"
}
```

| 필드 | 뜻 |
|---|---|
| `id` | 안정적인 식별자. 이름이 바뀌어도 유지된다. **이걸로 참조할 것** |
| `latitude`/`longitude` | 판(deck)의 **중심** |
| `heading_deg` | 판이 향한 방향. **북쪽 기준 시계방향** |
| `pattern` | 배치 형태 — `row`·`column`·`double`·`split` (게이트를 줄 세우고 FATO는 가장자리) · `flank`·`radial`·`court` (FATO가 가운데) |
| `vehicle_class` / `vehicle_d_m` | 설계 기체의 **D값(외접원 지름, m)**. small 8 / medium 12 / large 16 / custom |
| `platform_height_m` | 지면에서 판 상면까지 높이 |
| `ground_reference` | 판 높이의 기준 — `highest`/`mean`/`lowest`(지형에서 자동) 또는 `manual`(이때만 `altitude_m` 존재) |
| `gates` | 게이트(주기장) 수 |
| `fatos[].role` | `takeoff`(이륙 전용) / `landing`(착륙 전용) / `both` |
| `fatos[].side` | FATO가 선 판의 변 — `front`(진입면, 이름이 보이는 쪽) / `back` / `left` / `right`. 버티포트 자체 방향(`heading_deg`) 기준이라 판이 돌면 같이 돈다. FATO가 가운데인 배치(`flank`·`radial`·`court`)에서는 항상 `front`로 저장되고, 레이아웃에는 `center`로 나온다. 없으면 `front` |

### 2-2. 형상 (`layout`, 서버가 계산해서 함께 준다)

`GET /api/simulation/vertiports`의 각 레코드에 `layout`이 붙어 온다.

```json
"layout": {
  "schema_version": 2,
  "pattern": "row", "pattern_label": "가로 일렬",
  "frame":   { "latitude": 37.526513, "longitude": 126.922845, "altitude_m": null, "heading_deg": 0.0 },
  "platform":{ "corners_m": [[-42.8,-38.23],[42.8,-38.23],[42.8,38.23],[-42.8,38.23]],
               "size_m": [85.6, 76.46], "height_m": 6.0 },
  "dimensions": { "vehicle_d_m": 12.0, "fato_radius_m": 9.0, "tlof_radius_m": 4.98,
                  "safety_margin_m": 3.0, "gate_radius_m": 7.2, "taxiway_width_m": 8.4,
                  "gate_pitch_m": 20.4, "charger_radius_m": 1.68, "charger_height_m": 2.64, "...": "..." },
  "fatos":    [{ "id":"F1", "role":"both", "side":"front", "center_m":[0.0,13.43],
                 "radius_m":9.0, "tlof_radius_m":4.98, "safety_radius_m":12.0 }],
  "gates":    [{ "id":"G1", "marking":"G1", "center_m":[-30.6,-20.17], "radius_m":7.2 }],
  "chargers": [{ "id":"C1", "gate":"G1", "center_m":[-30.6,-31.55], "radius_m":1.68 }],
  "nodes":    [{ "id":"G1", "kind":"gate", "position_m":[-30.6,-20.17] }],
  "edges":    [{ "id":"E1", "from":"G1", "to":"J1", "kind":"stand",
                 "length_m":14.4, "width_m":8.4, "points_m":[[-30.6,-20.17],[-30.6,-5.77]] }],
  "bounds_m": { "min":[-42.8,-38.23], "max":[42.8,38.23] }
}
```

**스케줄링에 바로 쓸 만한 것**

- `fatos[]` — 이륙·착륙이 일어나는 자리. `role`로 방향 제한이 걸리고, `side`가 어느 변에 섰는지 말한다 (`center`면 게이트에 둘러싸인 가운데). 앞에 이륙 FATO, 뒤에 착륙 FATO를 둔 판이면 한쪽으로 나가고 반대쪽으로 들어오는 흐름이니 스케줄링에서 그대로 쓰면 된다.
- `gates[]` — 주기 가능한 대수 = 게이트 수. 각 게이트에 `chargers[]`가 1:1로 붙는다(`charger.gate`).
- `nodes[]`/`edges[]` — **버티포트 안의 지상 유도로 그래프**. `kind`는 `gate`·`fato`·`junction`(노드),
  `stand`·`approach`·`spine`(엣지). 게이트↔FATO 지상 이동 시간을 내려면 이 그래프의 `length_m`을 쓰면 된다.
- `dimensions` — 모든 치수는 D값에서 나온다: FATO 지름 1.5 D · 게이트 지름 1.2 D · TLOF 0.83 D ·
  안전구역 max(0.25 D, 3 m) · 유도로 폭 = 착륙장치 폭 × 2.

---

## 3. 항로망 (node–link)

`GET /api/simulation/routes` → `{ "nodes": [...], "fatos": [...], "links": [...], "dropped_links": [...] }`

### 3-1. 지점 (`nodes`) — 사람이 찍은 항로점

```json
{ "id": "WP001", "name": "가양대교 남단",
  "latitude": 37.569391, "longitude": 126.861026,
  "altitude_m": 304.8, "altitude_reference": "agl",
  "created_at": "...", "updated_at": "..." }
```

`altitude_reference`는 `agl`(지면 기준) 또는 `msl`(절대). 현재 40개 전부 `agl` 304.8 m(= 1000 ft).

### 3-2. FATO 지점 (`fatos`) — **저장되지 않고 버티포트에서 유도된다**

```json
{ "id": "fato:VP001:F1", "kind": "fato", "name": "여의도 F1",
  "vertiport": "VP001", "vertiport_name": "여의도", "fato": "F1", "role": "both",
  "latitude": 37.5266336, "longitude": 126.922845,
  "platform_height_m": 6.0, "hover_m": 30.0 }
```

- **항로는 버티포트가 아니라 그 FATO에서 시작·종료한다.** 링크의 끝점 id가 `fato:`로 시작하면 이것이다.
- 실제로 항로가 만나는 높이 = `platform_height_m + hover_m` (판 위 30 m).
- 버티포트를 고치면 이 목록이 다시 계산된다. **id는 `fato:<버티포트id>:<FATO id>` 규칙이라 안정적이다.**

### 3-3. 링크 (`links`) — 지점 사이 구간

```json
{ "id": "LK0001", "name": "여의도 F1 → 선유도 17고지",
  "from": "fato:VP001:F1", "to": "WP001",
  "segment": "C", "width_m": null,
  "created_at": "...", "updated_at": "..." }
```

| | |
|---|---|
| **방향** | `from` → `to` **단방향**이다. 반대로 가려면 반대 방향 링크가 따로 있어야 한다 |
| `segment` | 비행 프로파일 단계 (아래) |
| `width_m` | **순항(F)만** 회랑 폭을 갖는다. 나머지는 `null` |

**비행 프로파일 단계** — 상승과 강하는 **각각 하나의 대각선**으로 본다.
미션 프로파일의 C·D·E는 실제로 한 번에 올라가는 구간이라 `C` 하나로,
G·H·I는 한 번에 내려오는 구간이라 `G` 하나로 합쳤다. 따라서 링크가 가질 수 있는
`segment` 값은 **`C` / `F` / `G` 세 가지뿐이다.**

| id | 뜻 | 포함하는 단계 | 국면 |
|---|---|---|---|
| (A) | 지상 활주 | A | 판 위 — 링크가 아니라 버티포트가 가짐 |
| (B) | 수직 이륙 | B | FATO 위 — 버티포트가 가짐 |
| `C` | **상승** | C 전환 상승 · D 출발 터미널 절차 · E 가속 상승 | 출발 |
| `F` | **순항** (회랑, 폭 있음) | F | 순항 |
| `G` | **강하** | G 감속 강하 · H 도착 터미널 절차 · I 전환 강하 | 도착 |
| (J) | 수직 착륙 | J | FATO 위 — 버티포트가 가짐 |
| (K) | 지상 활주 | K | 판 위 — 버티포트가 가짐 |

일반적인 한 편 = `fato:출발:Fx` →(C)→ … →(F)…(F)→ … →(G)→ `fato:도착:Fy`

> 예전에 받은 파일에 `D`·`E`·`H`·`I`가 들어 있다면 각각 `C`·`C`·`G`·`G`로 읽으면 된다.
> 서버가 저장할 때 자동으로 그렇게 바꾼다(`options.merged_segments`가 이 대응표다).
> 더 잘게 나눈 단계가 스케줄링에 필요하면 알려달라 — 지금은 안 나눠서 보낸다.

`dropped_links`는 끝점이 사라져서 무효가 된 링크다. 정상이면 비어 있다.

---

## 4. 예시 — 한 편의 비행이 데이터에서 어떻게 보이는가

```
fato:VP001:F1   (여의도 F1, 판 6 m + hover 30 m)
   └─(C 상승, 폭 없음)→ WP001 가양대교 남단   304.8 m AGL
   └─(F 순항, 폭 300 m)→ WP002 …
   └─(G 강하, 폭 없음)→ fato:VP012:F2   (광화문 F2, 착륙 전용)
```

- 구간 길이는 두 끝점의 위경도로 직접 계산한다(데이터에 `length_m`은 **없다**).
- 지상 이동은 `layout.edges[].length_m`으로 계산한다(이건 있다).

---

## 5. 좌표계·단위 — 읽기 전에 확인

| | |
|---|---|
| 위경도 | WGS84 십진도. 소수 6~7자리 |
| `*_m` | **전부 미터** |
| `*_deg` | **도(degree)**, 북쪽 기준 **시계방향** |
| `center_m` / `corners_m` / `points_m` / `position_m` | **버티포트 지역 좌표**: 원점 = 그 버티포트의 `frame.latitude/longitude`, **+X = 동, +Y = 북**, 이미 `heading_deg`만큼 회전된 값 |
| 지역 좌표 → 위경도 | `lat = frame.lat + north/111320`, `lon = frame.lon + east/(111320·cos(frame.lat))` |
| 고도 | 항로 지점은 `altitude_m` + `altitude_reference`(agl/msl). 버티포트는 `ground_reference`가 `manual`일 때만 `altitude_m`을 가짐 |
| 시각 | `created_at`/`updated_at`은 **UTC** ISO 8601 |
| 이름 | 한글 UTF-8. **이름은 중복될 수 있다 — 참조는 반드시 `id`로** |

### 5-1. 지금 상태에서 꼭 확인할 것

- **링크가 현재 0개일 수 있다.** 작업 중 전부 지운 상태이며, 지점 40개와 FATO 24개는 그대로다.
  링크가 필요하면 보내기 전에 복구 여부를 확인할 것.
- 버티포트 18개의 **판 설계(배치 형태·게이트 수·FATO 수·판 높이)는 원본 자료에 없어서
  등급(port/hub)별로 일괄 지정한 값**이다. 실제 설계가 아니다.
- 판 방향(`heading_deg`)은 원본의 내부 링 진입 방위를 그대로 쓴 것이다.

---

## 6. 이 데이터에 **없는** 것 (스케줄링에 필요한데 빠진 것)

여기가 제일 중요하다. 아래는 전부 **아직 어디에도 없다.**

**시간**
- 시각표·다이어그램·운항 편 정보 없음. **시간 축 자체가 없다.**
- 게이트/FATO **점유 시간**, 회전(turnaround) 시간 없음
- 이착륙 소요 시간, 최소 이착륙 간격(분리 기준) 없음

**기체**
- 기체 성능 없음 — `vehicle_class`는 **D값(크기)만** 나타낸다. 순항 속도·항속거리·상승률 없음
- 탑재량·좌석 수 없음

**충전**
- 충전 시설은 **위치·크기만** 있다. **출력(kW), 충전 시간, 동시 충전 가능 대수 없음**

**수요·운영**
- OD 수요, 예상 승객 수 없음
- 버티포트 운영 시간, 정비·비가용 시간 없음
- 기상 제약 없음

**항로**
- 링크에 **소요시간·속도 제한·고도 프로파일 없음** (양 끝 고도만 있음)
- 링크는 **단방향**이라 왕복 운용을 보려면 반대 방향 링크가 있어야 한다
- 동시 점유 제약(한 회랑에 몇 대까지) 없음
- 원본 자료에 있던 **접근 링(INR/OTR/MTR, 진입 방위, 선회 방향)은 현재 형식에 담지 못했다**

---

## 7. 스케줄링 담당자가 되물어야 할 것

이대로 스케줄을 짜려면 최소한 아래가 정해져야 한다. **정해지면 이 데이터에 필드로 추가할 수 있다.**

1. **게이트 회전 시간** — 착륙 → 하기 → 충전 → 탑승 → 이륙까지 몇 분으로 볼 것인가
2. **FATO 최소 간격** — 연속 이착륙 사이 몇 초/분
3. **충전 사양** — kW, 1회 충전 시간, 게이트당 동시 충전 가능 여부
4. **기체 제원** — 순항 속도, 상승·강하율, 항속, 좌석 수 (`vehicle_class`별로)
5. **링크 통행 규칙** — 단방향 유지인지, 왕복 허용인지, 회랑당 동시 진입 대수
6. **운영 시간대**와 버티포트별 가용성
7. **수요** — OD 쌍과 시간대별 수요

---

## 8. 요약 한 줄

> **버티포트 18개(위치·판 형상·게이트·FATO·충전 위치·지상 유도로 그래프)와
> 항로 지점 40개 + FATO 지점 24개의 node–link 망을 JSON으로 준다.
> 공간 정보는 완결되어 있고, 시간·용량·기체 성능은 전혀 들어 있지 않다.**
