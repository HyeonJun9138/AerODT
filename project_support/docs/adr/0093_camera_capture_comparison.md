# ADR 0093: 명시적 카메라 원본 수집과 오프라인 모델 비교

상태: 2026-09-15 사용자 요청으로 철회. 수집 UI, 캡처 모듈, 비교 CLI를 제거했다.
아래 내용은 철회된 구현의 이력이며 현재 사용 가능한 기능 설명이 아니다.

기체 카메라의 탐지 입력 canvas를 JPEG 품질 .82로 수집한다. 탐지 박스가
그려진 화면 canvas는 사용하지 않는다. 원래 해상도와 RGB 전처리를 유지한다.
한 번의 사용자 요청은 1장 또는 10초간 최대 20장, 간격 500ms 이상이다.
인코딩은 하나만 진행하며 화면 숨김, 기체/방향 변경, 닫기에서 수집을 중지한다.
이미 수집한 프레임은 패널을 닫아도 페이지 메모리에 남으며, 새 수집으로
덮어쓰기 전에 JSON 내보내기를 요구한다. 페이지 새로고침 시에는 소실된다.
파일 다운로드 성공 여부는 브라우저가 관리한다.

JSON 형식: schema_version=1, kind=aerodt_camera_capture, frames[1..20].
각 frame은 image_base64(JPEG, 1MiB 이하), width, height, captured_at(캡처 시작
시각 epoch ms), entity_id, camera, frame_number, scene_label을 가진다.
scene_label은 unknown/bird/drone/airplane/empty 중 운영자의 장면 메모이며
정답 박스나 검출 결과가 아니다. 외부 송신/API 변경/World 상태 변경은 없다.

비교 CLI는 수집 파일 22MiB, 프레임20장, JPEG 최대1280x720 상한을 검사하고
기존 모델과 별도로 보존한 두 후보를 같은 입력과 NMS로 실행한다. 후보는
고정 SHA256과 검토한 공식 모듈의 weights_only=True 로딩만 허용한다.
결과는 새 출력 디렉터리의 JSON과 정적 HTML로 보관한다. 기존 파일을
덮어쓰지 않는다. 실시간 모델/추적/회피 제어는 변경하지 않는다.

후보는 모든 요구 클래스를 지원하지 않는다. WingID는 bird/airplane을 포함한
80클래스, AeroYOLO는 aircraft/drone/helicopter3클래스다. 라이선스 검토는
완료되지 않았다. 후보 CPU와 기존 ONNX/GPU 실행 시간은 공정한 속도 비교가
아니며 최초 준비 시간도 포함될 수 있다. 정답 없는 이미지에서 정확도,
재현율 또는 mAP를 산출하거나 신뢰도 점수만으로 우열을 결정하지 않는다.
