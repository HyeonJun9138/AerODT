# 아이폰 중계 컴퓨터 → AeroDT 송신 규칙 v1

## 연결

아이폰 ZIG SIM → Wi-Fi 중계 컴퓨터 → TCP → AeroDT 컴퓨터.

중계 컴퓨터가 TCP 클라이언트다. AeroDT에서 Live Twinning → Twinning Test를
열고 Test Mode를 켠 뒤 모델과 수신 IP/포트를 선택하고 수신 시작을 누른다.
기본 수신 IP `0.0.0.0`은 서버의 모든 로컬 IPv4 주소를 뜻한다.
**송신 대상에 0.0.0.0을 넣지 않는다.** 송신 대상은 수신 컴퓨터의 접근 가능한
LAN/VPN IPv4 주소와 화면에 설정한 TCP 포트(기본 5005)다.
HTTP 대시보드 포트(예: 8766)와 TCP 센서 포트는 다르다.

신뢰하는 LAN/VPN 전용이다. 이 프로토콜은 인증/암호화가 없으므로 공인 IP로
직접 노출하지 않는다. 필요하면 방화벽 인바운드를 승인된 송신 IP에만 제한한다.
인터넷 포트포워딩 또는 방화벽 전체 해제는 하지 않는다.

## TCP 프레이밍

- UTF-8 JSON 한 줄, 마지막 바이트는 LF (`\n`). CRLF도 허용한다.
- 한 메시지는 줄바꿈을 포함해 최대 4096 byte다.
- TCP 연결을 유지한다. recv 단위는 메시지 경계가 아니므로 JSONL로 구분한다.
- 권장 30 Hz, 송신 최대 60 Hz. 새로운 센서 관측이 있을 때만 보낸다.
- 아이폰 입력이 멈추면 마지막 값을 새 seq로 반복 전송하지 않는다.
- TCP 수신 성공 ACK 메시지는 별도로 보내지 않는다. ACK를 기다리지 않는다.
- 동시에 한 중계 연결만 허용한다. 끊어지면 간격을 두고 재접속한다.

```json
{"version":1,"device_id":"iphone_01","seq":1,"sent_at_unix_ms":1789372800000,"attitude":{"roll_deg":0.0,"pitch_deg":0.0,"yaw_deg":0.0}}
```

예시 JSON 뒤에 실제 `\n` 바이트를 추가한다. timestamp는 예시 상수를 복사하지 말고
전송 시점에 생성한다.

| 필드 | 형식 |
|---|---|
| version | 정수 1 |
| device_id | 1~64자, 영문/숫자/밑줄/마침표/하이픈. 연결 중 변경 금지 |
| seq | 0 이상의 정수, 메시지마다 증가. 재접속 시 초기화 가능 |
| sent_at_unix_ms | 중계 PC 전송 시각, Unix 밀리초 정수 |
| attitude.roll_deg | 도 단위, 오른쪽 날개가 내려가는 방향이 양수 |
| attitude.pitch_deg | 도 단위, 기수가 올라가는 방향이 양수 |
| attitude.yaw_deg | 도 단위, 위에서 볼 때 오른쪽으로 회전하면 양수 |

정수는 JavaScript 안전 정수 범위(0~9007199254740991), 각은 유한한 숫자여야 한다.
수신기는 각의 절댓값 360 초과, NaN/Infinity, 필수 필드 누락, JSON 오류,
중복/역행 seq, 연결 도중 device_id 변경을 거부한다.
권장 정규 표현은 roll/yaw ±180°, pitch ±90°다. radians로 보내지 않는다.

## 축과 회전 정의

기체 body 축은 X=앞, Y=오른쪽, Z=아래(FRD).
Body-to-reference 회전 행렬은 `Rz(yaw) Ry(pitch) Rx(roll)`이다.
ZIG SIM 원본 축/단위를 추측하지 말고 송신부에서 위 정의로 변환한다.
폰 설치 자세는 `현재 자세를 기준으로 설정` 버튼으로 초기 기준을 잡을 수 있다.
이 보정은 고정된 기준 회전을 제거할 뿐 잘못된 축 매핑을 자동으로 찾지 않는다.

한 축씩 시험한다: +Roll 20° → 오른쪽 날개 하강,
+Pitch 20° → 기수 상승, +Yaw 20° → 오른쪽 회전.
모델 기수 정렬은 모델 형상의 초기 방향만 맞추는 표시 설정이다.

## Python 송신 형태 (중계 코드에 적용)

```python
import json
import socket
import time

def send_attitude(sock, seq, roll_deg, pitch_deg, yaw_deg):
    message = {
        "version": 1, "device_id": "iphone_01", "seq": seq,
        "sent_at_unix_ms": int(time.time() * 1000),
        "attitude": {"roll_deg": float(roll_deg),
                     "pitch_deg": float(pitch_deg), "yaw_deg": float(yaw_deg)},
    }
    sock.sendall((json.dumps(message, allow_nan=False) + "\n").encode("utf-8"))

# 연결은 한 번 열고 새로운 ZIG SIM 관측마다 send_attitude를 호출한다.
# with socket.create_connection((receiver_lan_ip, 5005), timeout=5) as sock:
#     send_attitude(sock, seq, roll_deg, pitch_deg, yaw_deg)
```

## 수신부 동작과 검증 한계

마지막 정상 메시지 이후 2초 이상 지나면 센서 수신 중단으로 표시하고 마지막
자세를 유지한다. TCP 연결 여부는 별도로 표시한다. 재접속은 관측과 기준 자세를
초기화하므로 폰을 원하는 기준 자세에 놓고 다시 보정한다.

전송 시각은 참고 정보다. 두 컴퓨터의 시계 동기화를 확인하지 않은 상태에서
통신 지연으로 해석하지 않는다. 수신 Hz는 서버가 실제로 받은 정상 메시지 기준이다.
회전 화면은 최신 snapshot을 최대 약 20 Hz로 조회하고 센서 수신은 별도로 동작한다.
시험 데이터는 실제 운항 World, 임무, 예측 입력으로 들어가지 않는다.

종료는 `테스트 종료 · 닫기` 또는 `수신 중지`를 사용한다. 브라우저 강제 종료나
네트워크 단절로 종료 요청이 전달되지 않으면 다시 열어 중지한다.
본 구현에서 자동 방화벽 설정, 운영 서버 재시작, 실제 아이폰 연결은 수행하지 않았다.


GPS/가속도 확장: [송신 규칙 v2](twinning_test_sender_v2.md). v1 자세 전송은 계속 지원한다.
