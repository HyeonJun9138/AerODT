# ADR 0012: 건물 시각 자산 접근과 조명

날짜: 2026-09-08. 상태: 사용자 요청 구현.

## 책임

Communication의 Cesium 어댑터는 OSM Buildings 고정 자산 96188의 endpoint를 HTTPS로 요청한다. User Application은 명시적인 --buildings 옵션에서만 로컬 인증정보를 읽어 어댑터를 구성한다. Visualization의 BuildingLayer는 근접 LOD, 표시 여부와 비동기 수명만 소유한다. 건물은 지도 배경용 정적 시각 자산이므로 Physical 관측처럼 Data → Live 경로에 위장 입력하지 않고 TwinWorld 상태도 수정하지 않는다. 기존 모델 package와 FastPhysics 계산은 변경하지 않는다.

## HTTP 계약

GET /api/visualization/buildings/endpoint는 type, url, accessToken, attributions만 반환한다. accessToken은 upstream이 발급한 해당 자산용 임시 토큰이며 계정 토큰은 반환하지 않는다. 응답은 Cache-Control: no-store이다. 교차 출처 Origin/Sec-Fetch-Site를 거부하며 비활성 404, 공급자 실패 503을 사용한다. 인증값과 upstream 오류 본문은 노출하지 않는다. 이 로컬 개발 서버를 인증 없이 공개 인터넷에 배포하지 않는다.

브라우저 IonResource가 자산 토큰과 401 갱신 및 크레딧 처리를 맡는다. 최초 요청은 근접 시에만 발생한다. 현재 Cesium/OSM 출처와 계정 사용 안내는 보존한다.

## 시각화 정책

20km에서 로드, 25km에서 숨기는 카메라 고도 히스테리시스. 전 지구에서 건물 tile을 미리 로딩하지 않는다. 계층별 on/off는 상태 수집과 독립적이다. 태양 토글은 지도 조명에만 적용하며 시스템 현재 시간을 쓴다. 별은 외부 데이터가 아닌 절제된 장식용 정적 cube texture다.

## 검증 범위

Python의 고정 자산/인증/동일 출처/실패 비밀값 비노출 시험과 Node의 LOD/비동기 완료/재시도/조명 시험을 사용한다. 실제 브라우저에서 동일 LiveGlobe 모듈의 뉴욕 3D 건물, 수동 숨김, 전 지구 자동 숨김 및 메인 화면 태양 토글을 확인한다. CelesTrak는 계속 비활성이며 저장 GP 표시를 실시간 수신으로 주장하지 않는다.
