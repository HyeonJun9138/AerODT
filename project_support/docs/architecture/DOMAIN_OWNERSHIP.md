# 도메인 소유권과 공유 경계

## 원칙

AeroDT는 최상위 계층 구조를 유지한 채 각 계층 내부에서 UAM, Satellite와 일반 항공기 구현을 구분한다. 도메인을 최상위 폴더로 올리면 통신, 상태, 물리와 응용 책임이 다시 섞이므로 그렇게 하지 않는다. 공유 코드는 `common` 같은 포괄 폴더가 아니라 `kinematics`, `composition`, `visualization`처럼 실제 책임이 드러나는 이름으로 둔다.

## 현재 코드 배치

```text
communication/
  external/
    aircraft/opensky_source.py
    satellite/celestrak_source.py
  web/
    domains/uam/*_routes.py
    live_routes.py, wire_snapshot.py, cesium_routes.py ...

digital_twin/live_twin/
  domains/
    aircraft/       # 일반 항공기 관측 모델과 GRU 예측
    uam/            # UAM 센서 정렬·융합과 임무 의도 궤적
    satellite/      # 위성 가시성 및 SGP4 표시 궤적
  kinematics/       # UAM과 항공기가 같은 의미로 쓰는 ECEF 운동 계산
  composition/      # 여러 도메인의 읽기 전용 결과를 스냅샷으로 조립

ai_pnp/
  domains/uam/      # UAM feature·학습 궤적·위험 예측·카메라 탐지
  uam_route_model.py # 배포 manifest가 경로·hash를 고정한 감사 구현

user_application/
  uam_mission/      # UAM 임무 단계와 goal 생성
  apps/
    uam_*           # UAM 실행 프로그램
    web_dashboard/
      domains/uam/  # 물리 입력·운항·예측 프로세스 조립
  web/domains/
    uam/            # 조종석·운항·계획·예측·분석·음향 GUI
    satellite/      # 현재 구현된 위성 workspace GUI
  configs/web_dashboard/
    platform.json
    domains/uam.json
    domains/satellite.json
```

`digital_twin/model_library`, `digital_twin/runtime`, `data`는 책임 기준 구조를 유지한다. 기체 패키지는 이미 버전 가능한 모델 단위이고, runtime의 World가 현재 상태를 소유하며, data는 과거 기록을 소유한다. 이를 도메인별로 복제하지 않는다.

`ai_pnp/uam_route_model.py`는 예외다. 배포된 학습 모델 manifest가 구현 경로와 SHA-256을 검증 계약으로 사용하므로, 경로 이동은 구조 정리가 아니라 모델 package 버전 변경이다. 현재는 도메인 진입점이 이 감사 구현을 참조하도록 두어 기존 검증 증거를 보존한다.

## 공유 여부 판단

다음 조건을 모두 만족할 때만 공유 위치에 둔다.

1. 두 도메인이 같은 단위, 좌표계와 의미로 사용한다.
2. 특정 도메인의 단계, 공급자 이름, UI 용어가 없다.
3. 한 도메인을 선택하지 않아도 안전하게 import하고 생성할 수 있다.
4. 공유를 위해 현재 상태나 설정 사본을 새로 만들지 않는다.

조건을 만족하지 않으면 해당 도메인이 소유한다. 여러 도메인을 연결해야 하는 코드는 공유 알고리즘이 아니라 composition root로 분류한다.

## 호환 경로

이번 이동 전의 Python module 경로는 기존 개발자 코드와 시험을 위해 얇은 호환 진입점으로 유지한다. 새 production 코드는 호환 경로를 사용하지 않는다. 호환 진입점은 기능을 추가하는 장소가 아니며, 제거하려면 사용처 조사와 별도 마이그레이션 공지가 필요하다.

## Satellite 확장 순서

위성 도메인은 현재 수집, 표시 궤도와 GUI workspace까지만 존재한다. 위성 임무계획이나 우주 동역학을 추가할 때는 계약과 검증 기준을 먼저 정의하고, 그 기능이 생기는 계층 안에 최소 폴더를 만든다. UAM 임무계획, 예측, 설정을 이름만 바꾸어 재사용하지 않는다.
