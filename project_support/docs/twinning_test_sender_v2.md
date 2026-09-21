# Twinning Test 송신 규칙 v2

다른 PC의 ZIG SIM 수신/중계 프로그램이 AeroDT 수신 PC로 TCP 연결한다.
기존 v1 자세 패킷도 계속 지원한다. v2는 자세, 가속도, GPS를 독립적으로 보낼 수 있다.

## 연결과 프레이밍
- UI에서 Test Mode를 켜고 수신 IP, TCP 포트와 비행체를 선택한 뒤 수신 시작.
- 중계 PC는 수신 PC의 접근 가능한 LAN 또는 VPN IPv4와 같은 포트로 연결한다.
- UTF-8 JSON 한 개마다 LF(\n). 줄바꿈 포함 최대 4096바이트. 연결당 장치 하나.
- seq는 연결 내 엄격히 증가하는 정수. 재연결 시 초기화 가능.
- 이 프로토콜은 인증/암호화가 없다. 인터넷에 직접 노출하거나 공인 IP 포트를 열지 않는다.
- 수신 확인 ACK나 폰으로의 목표값 전송은 이번 구현에 포함하지 않는다.

## 예시
아래 JSON을 한 줄로 직렬화하고 마지막에 LF를 붙인다.

```json
{"version":2,"device_id":"iphone_01","seq":1,"sent_at_unix_ms":1789372800000,"attitude":{"observed_at_unix_ms":1789372800000,"roll_deg":0,"pitch_deg":0,"yaw_deg":25},"acceleration":{"observed_at_unix_ms":1789372800000,"x_mps2":0,"y_mps2":0,"z_mps2":0,"includes_gravity":false,"frame":"body_frd"},"gps":{"observed_at_unix_ms":1789372800000,"latitude_deg":37.5665,"longitude_deg":126.978,"altitude_m":50,"altitude_reference":"msl","horizontal_accuracy_m":4,"vertical_accuracy_m":6}}
```

## 센서 계약
- attitude, acceleration, gps 중 최소 하나가 필요하다. 새 관측이 없는 블록은 생략한다.
- 각 블록의 observed_at_unix_ms는 중계 PC 시계 영역으로 정규화한 실제 관측 시각이다. sent_at_unix_ms는 전송 시각이다. 오래된 GPS를 재전송할 때 관측 시각을 현재 시각으로 바꾸지 않는다. 동일하거나 과거인 관측 시각은 센서 갱신으로 취급하지 않는다.
- 시각과 seq는 0 이상 2^53-1 이하 정수. 관측 시각은 전송 시각보다 1초 초과 미래일 수 없다.
- device_id는 영문, 숫자, _, ., -로 1~64자.
- 자세: degree, 각 축 -360~360. Body FRD(X 전방/Y 우측/Z 아래), body-to-reference Rz(yaw) Ry(pitch) Rx(roll). ZIG SIM 원본 축과 단위를 중계부에서 변환한다.
- 가속도: m/s², FRD, 유한값 ±10000. includes_gravity는 실제 데이터에 따라 true/false. g 단위라면 9.80665를 곱한다. 중력 포함 데이터를 임의로 제외라고 표기하지 않는다.
- GPS: 위도 ±90, 경도 ±180 degree. altitude_m는 -12000~100000m 또는 null. 수치 고도에는 altitude_reference가 msl 또는 wgs84_ellipsoid여야 한다. 원본 datum을 모르면 추측하지 말고 고도를 null로 보낸다.
- horizontal_accuracy_m 필수, vertical_accuracy_m 선택/null. 값은 0~100000m. 원본의 음수 invalid 표식을 0으로 바꾸지 말고 해당 GPS 관측을 보내지 않는다.
- 자세/가속도는 약 20~60Hz, GPS는 실제 갱신 주기대로 보낸다. 센서를 같은 빈도로 복제하지 않는다.

## 화면 해석
첫 신선한 유효 GPS 고도가 지면 기준이다. 이후 같은 datum의 고도 차이를 표시한다.
예: 최초 50m, 이후 90m이면 시작점 대비 40m. 재연결/새 세션은 기준 초기화.
GPS가 5초, 자세/가속도가 2초 이상 오래되면 각각 지연으로 표시한다.
고도 datum 변경/미확정이면 지도 위치를 유지한다. GPS 없이는 가짜 위치를 만들지 않는다.
음수 상대 높이는 숫자에는 그대로 표시하되 기체의 지하 렌더링은 막는다.
지도는 위성 영상과 평탄 타원체 표면이며 3D 건물과 지형 기복은 없다. 영상 속 건물 사진은 남는다.
시각적 지면 여유 높이는 모델 크기에 따른 근사값으로 실제 랜딩기어 접촉이나 물리 시뮬레이션이 아니다.
가속도는 계기와 그래프에 표시하며 적분해서 위치를 만들지 않는다.
하단은 실제 수신량, 해석한 패킷 수, seq 건너뜀, 오류와 최근 60초 센서 추이를 표시한다.
seq 건너뜀은 네트워크 손실률이 아니다. 해석된 수신값은 원본 wire 문자열이 아니다.
중계 내부 처리나 아이폰 송신 성공을 원격 확인한 것으로 표시하지 않는다.
