# AerODT Physical UAM

## 작은 실행 창

워크스테이션 폴더의 **AerODT Physical.exe**를 더블클릭하면 서버/터널을 시작하거나
재사용하고 주소창 없는 운용 콘솔을 엽니다. 새 서버는 Play 대기로 시작합니다.
실행 파일 옆의 `Start-UAM-Physical.ps1`과 `physical_uam` 폴더를 유지하세요.
현재 PC의 Python 환경을 사용하는 작은 런처이며 단독 배포용 전체 시뮬레이터 EXE는 아닙니다.

- **계획·환경**: CSV 또는 해석된 비행 JSON 가져오기, 비행 검색/선택, 경로/고도 미리보기.
- **실행 범위**: CSV의 전체 운항이 기본입니다. 모든 기체의 연속 운항을 같은 PSU·버티포트·기체별 조종사로 실행합니다. 단일 기체 시험도 선택할 수 있습니다.
- **지금부터 처음 시작**: 전체 일정의 출발 준비부터 지금 시각에 시작하며 편간 간격을 유지합니다. 단일 시험은 선택 편의 이륙부터 시작합니다.
- **계획 처음부터**: 전체 일정의 첫 출발 준비 시각부터 1배속. 센서 UTC는 현재 시각 유지.
- **지정한 계획 시각부터**: KST 날짜/시각을 입력. 이륙 전이면 대기하고,
  전체 운항은 일정 시작부터 해당 시각까지 공유 엔진으로 계산한 뒤 실시간 송신합니다. 계산 진행률을 표시하며 중지할 수 있습니다.
- **지도 환경**: 가져온 프로젝트 DEM 또는 평탄 시험 지면 선택, 환경 JSON 가져오기/저장.
- **버티포트**: 지도에서 선택하여 이름·좌표·데크 높이·방향 수정. 초안 반영 후 Play로 저장/적용.
  CSV 계획은 변경 환경으로 재계산하며, 해석된 JSON은 포함된 경로와 고도를 유지합니다.
- **일시정지/이어가기/중지**: native 진행과 센서 송신을 함께 제어합니다. 중지는 서버 자체를 종료하지 않습니다.
- **운항 현황**: 전체 비행/지상/대기 수, 편별 지시와 PSU 순서, 18개 버티포트 점유, 최근 의사결정. 기체를 누르면 해당 센서 관측으로 이동합니다.
- **센서 관측**: 기체 선택, 측정 주기/경과/순번, 원본 패킷, 전체 GNSS 누락 시험, 실행 JSON 저장.

환경 변경은 이 PC의 Physical 사본에 저장되며 원격 Twin의 지도/시설 데이터는 자동 수정하지 않습니다.
지도는 위경도 기반 항로도입니다. 실제 3D 시각화는 **Digital Twin ↗**에서 확인하세요.
서버와 터널까지 종료하려면 PowerShell에서 `./Start-UAM-Physical.ps1 -Stop`을 실행합니다.
창만 닫으면 송신은 유지됩니다. `-Idle`은 직접 스크립트 실행 시에도 Play 대기로 시작합니다.

콘솔 저장 위치: `data/workspace/physical_uam/console`. 지형 사본: `data/workspace/terrain/user_dem`.
API/시계 계약: `project_support/docs/adr/0062_physical_desktop_console.md`.

별도 컴퓨터에서 native AirTaxi를 1배속으로 실행하고 센서를 생성하는 서버입니다.
Digital Twin은 전송된 센서와 임무 의도만 받아 현재 상태와 미래 궤적을 계산합니다.

```powershell
python -m user_application.apps.physical_uam --flight data/workspace/physical_uam/flight.json
```

기본 주소는 `http://127.0.0.1:8770`입니다. 페이지에서 현재 비행, 센서별 주기/시각,
전송 JSON을 볼 수 있습니다. **새 비행 시작**과 **GNSS 10초 누락 시험**도 제공합니다.
전체 운항의 반복은 모든 일정이 끝난 뒤 30초 후 전체를 다시 시작합니다. 단일 시험은
착륙 후 반복합니다. GUI에서 반복을 끌 수 있습니다. `--once`와 `--seed`는 최초 단일 CLI 실행의 반복과 잡음 재현성을 제어하며 저장한 GUI 설정이 있으면 그 설정을 사용합니다.

## 연결 PC 설정

**연결 PC** 탭에서 Twin PC의 IP/DNS, 웹 포트(기본 8766), SSH 포트(22),
SSH 사용자, 이 PC의 개인 키 파일 경로, Twin 센서 터널 포트(18770)를 입력합니다.
키 본문은 저장하거나 보내지 않고 로컬 SSH가 파일을 읽습니다. 대상 서버에 공개 키가
등록되어 있고 서버 지문이 Windows SSH known_hosts에 확인되어 있어야 합니다.

- **적용 · 연결**: SSH 연결 후 해당 Twin의 loopback 센서 API 주소도 저장·적용합니다.
  연결 실패 시 마지막 설정을 유지하고 이전 터널이 있었다면 복구를 시도합니다.
- **연결 확인**: 저장된 연결을 확인합니다. 터널, Twin API 응답, 이 PC의 process ID와
  일치하는 관측, 2초 이내 센서 경과를 구분해서 표시합니다. 다른 송신기 관측은 수신 성공이 아닙니다.
- **연결 해제**: 이 연결만 닫고 자동 연결을 끕니다. 비행과 센서 생성은 유지됩니다.
- **자동 연결**: 콘솔 시작 및 SSH 연결 단절 후 재연결합니다. 자동 재연결은
  Twin 설정을 재작성하지 않습니다. 새 주소 적용은 버튼으로 명시적으로 실행합니다.

센서 데이터는 **HTTP/JSON over TCP, SSH 암호화 reverse tunnel**입니다.
Twin이 `/api/v1/telemetry?after=...&process=...`를 약 0.1초 간격으로 조회합니다.
기본 흐름: `Twin 127.0.0.1:18770 → SSH → Physical 127.0.0.1:8770`.
`8766`은 Twin 화면/API 포트이고 센서 터널 포트와 다릅니다.
Twin 상태 확인·주소 변경도 별도의 로컬 forward를 통해 같은 SSH 연결을 사용합니다.

연결 설정은 로컬 `data/workspace/physical_uam/console/connection.json`에 저장합니다.
Twin의 수신 주소는 대상 PC `data/workspace/settings/physical_uam.json`에 저장됩니다.
새 설정 API가 포함된 Twin 서버가 필요합니다. 해당 API는 Twin loopback에서만 변경할 수 있습니다.

## 송신과 수신

- Physical: HTTP `/api/v1/status`, `/api/v1/telemetry`, `/api/v1/flight-plan`, `/docs`.
- 기체마다 독립된 GNSS 5 Hz, AHRS/기압계 20 Hz, IMU 50 Hz 샘플링. 이동 기체의 패킷 보고는 10 Hz, 주기 기체는 최신 관측을 1 Hz로 보고합니다.
- 전체 운항에서 기체별 바이어스·누락·지연이 적용됩니다. 단일 HTTP 배치는 최대 256패킷이며 후속 페이지와 gzip으로 다기체 수신을 지원합니다.
- Twin은 `delivery=latest`로 기체별 최신 관측을 받습니다. 느린 회선에서 오래된 패킷을 순서대로 재생하지 않으며, 합쳐서 생략한 중간 보고는 `coalesced_packets`로 구분합니다. 샘플 시각과 명목 센서 주기는 그대로입니다. 전체 원시 샘플은 기본 `delivery=ordered` API와 콘솔에서 확인합니다.
- 측정 잡음/바이어스/누락은 `digital_twin/model_library/packages/physical_uam_sensors/v1/model.json`.
- 잡음 모형은 합성 모사값입니다. 실제 장비 교정값/인증 규격으로 주장하지 않습니다.
- Digital 초기값: `user_application/configs/web_dashboard/default.json`의 `physical_uam_url`. GUI 저장값이 우선합니다.
- 짧은 상태 요청 3회 중 가장 빠른 왕복 시간을 사용해 송신 시계를 정렬합니다. 원본 센서 UTC는 보존하며
  보정값과 RTT/2의 시간 불확실성을 상세에 표시합니다. 양방향 지연이 비슷하다는 가정입니다.
- Twin은 GNSS+기압 고도+AHRS를 사용합니다. IMU는 조회용이며 INS 위치 적분은 하지 않습니다.
- GNSS 2초 초과: 현재 위치 외삽 중단/오래됨 표시. 30초 초과: 기체 만료.
- 비행체 선택: 센서 상세, 최근 약 40초 관측 항적, 기존 임무 예측/학습 모델 비교.
- Live Twinning의 **실시간 UAM 센서 수신**을 끌 수 있습니다. Simulation 재생 동안은
  자동으로 수신을 멈추고, 종료 후 현재 시간 자료로 다시 시작합니다.

## 이 워크스테이션 배포

프로젝트 루트의 `Start-UAM-Physical.ps1`을 실행하면 Physical 서버와 SSH reverse
tunnel을 시작하거나 기존 실행을 재사용합니다. `-Stop`은 이 도구가 기록한 프로세스만
종료합니다. GUI의 자동 연결이 켜져 있으면 터널을 다시 엽니다. 원격 Twin은
연결 실패 시 자동 재시도합니다. 재부팅 자동 실행은 등록하지 않습니다.

두 컴퓨터 사이 경로는 `Digital 127.0.0.1:18770 → SSH → 이 PC 127.0.0.1:8770`입니다.
SSH 비밀키 본문은 사용자 SSH 폴더에 남습니다. GUI에는 파일 경로만 표시합니다.
종료하면 Digital에는 수신 지연 상태가 표시됩니다. 이 PC를 꺼도 Digital의 별도
Simulation은 사용할 수 있습니다.

가져온 CSV는 100기체·1,825편이며 송수신 최대치는 128기체입니다. 전체 운항은 기존
ScenarioEngine, PSU 예측 접근·이착륙 허가, 버티포트 주기장/FATO 점유와 지상 이동,
운항사 회항 절차, 기체별 FlightPilot을 그대로 사용합니다. 항로·DEM·시설·정책은 가져온
시점의 사본이며 원격에서 이후 바꾼 설정은 자동 동기화되지 않습니다.

공중 상태는 동일한 native DLL에서 계산합니다. 지상 이동은 기존 시뮬레이터의 운동학
모형입니다. 센서 관측을 위해 공중 native 상태를 0.02초마다 읽으며 별도 비행 제어법은
추가하지 않습니다. UI의 실효 배속과 지연을 확인하세요. 호스트가 밀리면 운항 상태를
보존하고 센서 시계를 현재 UTC로 재정렬하며 `fleet_clock_rebased`를 기록합니다.
계획 시계는 실제 계산을 완료한 만큼만 진행하므로 과부하 시 실제 시간보다 느려질 수 있습니다.
DLL/계획/정책/센서 패키지를 같은 버전으로 보관하세요.

API/계층 경계: `project_support/docs/adr/0061_physical_uam_sensor_twinning.md`.
전체 운항 계약: `project_support/docs/adr/0064_physical_fleet_operations.md`.
