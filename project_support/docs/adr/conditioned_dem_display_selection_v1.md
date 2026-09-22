# 보정 DEM 표시 공급자 선택

날짜: 2026-09-21

## 결정

기존 지형 공급자 `world_terrain`, `local_dem`을 유지하고 표시 설정의 허용 값에 `conditioned_dem`을 추가한다. 사용자 표시 이름은 `보정 DEM 사용`이다. 초기 선택을 강제로 바꾸지 않으며 브라우저별 표시 설정의 기존 저장 방식을 따른다.

서버는 배포 설정 `conditioned_dem_directory`로 지정한 LocalDem schema_version 1 패키지를 별도로 읽는다. 상대 경로는 저장소 루트 기준이다. 원본 로컬 DEM, 수동 비행의 지면 높이 제공자와 보정 패키지를 서로 대체하지 않는다. 운영 데이터 경로는 플랫폼 설정에만 두고 클라이언트에 노출하지 않는다.

## 추가 HTTP 계약

- `GET /api/visualization/terrain/conditioned`: 기존 `/local`과 같은 버전 1 metadata. 패키지가 없거나 잘못되면 `enabled: false`.
- `GET /api/visualization/terrain/conditioned/{level}/{x}/{y}`: 기존 높이/혼합 가중치 float32 wire layout과 같은 65×65 payload. level 6~14, 경계 및 same-origin 검증을 그대로 적용한다.
- 새로운 URL은 다른 지형 자료의 캐시와 섞이지 않으며 요청의 버전 키는 패키지 manifest version이다.
- 2026-09-21 강화 보정본 배포부터, 명시한 `v`가 현재 패키지 버전과 다르면 tile endpoint는 HTTP 409와 `Cache-Control: no-store`를 반환한다. 구 버전 URL로 새 높이를 전송하여 브라우저에 신구 자료가 혼합되는 것을 막는다. 버전 없는 기존 직접 요청은 호환성을 유지한다. 새 패키지 적용 후 기존 탭은 새로고침해야 한다.

기존 URL, 공급자 ID, 패키지 형식은 변경하지 않는다. 클라이언트는 공급자마다 별도의 로딩 Promise와 객체를 보관하며, 선택 세대 번호를 통해 늦게 완료된 요청이 최신 선택을 덮어쓰지 않게 한다. 자료 범위 밖과 실패 시에는 기존 World Terrain 경로를 사용한다.

## 범위 및 위험

이 선택은 Cesium 지형 mesh와 화면용 지표 샘플링을 바꾼다. native physics의 접촉 모델, 운항 중 현재 상태 또는 수동 비행의 서버 지표면 입력을 변경하지 않는다. 실제 버티포트/물리 높이 정합 및 UAM 임무 검증은 별도 과제다. World Terrain의 인증/연결이 없을 때 전 세계 fallback은 제공할 수 없다. 제공자 연결 실패를 정상 적용이라고 표시하지 않는다.

서버의 패키지는 시작 시 읽으므로 경로를 변경하거나 새 공급자를 배포하면 서버 재시작이 필요하다. 패키지 바이트를 운용 중 덮어쓰지 않는다.
