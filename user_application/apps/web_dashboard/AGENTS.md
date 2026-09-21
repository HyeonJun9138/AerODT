# Web Dashboard 서버 조립 규칙

루트 `AGENTS.md`와 `user_application/web/AGENTS.md`를 함께 따른다.

- `application.py`는 여러 도메인과 공용 transport를 연결하는 composition root다. 도메인 알고리즘을 이 파일에 새로 구현하지 않는다.
- UAM 전용 물리 입력, 운항, 예측 프로세스 조립은 `domains/uam` 아래에 둔다.
- Satellite 서버 기능이 실제로 생기기 전에는 빈 폴더를 만들거나 UAM 기능을 위성 기능으로 재명명하지 않는다.
- 새 코드는 호환 파일이 아니라 `domains/<domain>`의 실제 구현을 import한다.
- 기본 설정은 `configs/web_dashboard/platform.json`과 `configs/web_dashboard/domains/<domain>.json`에서 분리하며, 같은 키를 여러 문서에 두지 않는다.
- domain 모듈 import와 생성자에는 수집 시작, timer 생성, 프로세스 실행 같은 부작용을 넣지 않는다. 시작과 종료는 application lifespan이 명시적으로 조립한다.
