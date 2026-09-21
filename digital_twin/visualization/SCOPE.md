# Visualization 경계

현재 시각화 구현은 `digital_twin/visualization/web`의 CesiumJS 모듈이다. Web
Dashboard가 불변 snapshot을 브라우저 전송 형식으로 조립하고, 시각화는 그 값을
읽어 기체, 위성, 항로, 버티포트와 지형을 표현한다. 시각화 코드는 물리 상태를
소유하거나 simulation tick을 실행하지 않는다.

지형 기본값은 Cesium World Terrain이다. 로컬 DEM adapter는 자료가 명시적으로
설치된 경우에만 선택 가능한 확장 경계이며, 저장소에는 DEM 원본이나 변환 타일을
포함하지 않는다. 카메라 픽셀, 실행 로그와 공급자 캐시는 `data/workspace`의 로컬
생성물이며 Git 입력이 아니다.
