# ADR 0003: Native UAM goal, transition 및 contact 계약

- 상태: 승인
- 날짜: 2026-09-03

## 배경

Native runtime에는 position/yaw-rate 경로만 있었고 fixed-wing 전환 요청은
정적 model capability와 구분되지 않았다. 또한 충돌 형식이 Simulation 내부에
있어 향후 Unreal adapter가 FastPhysics 구현에 의존할 위험이 있었다.

## 결정

1. SimpleFlight 명령은 단위와 frame이 드러나는 세 타입으로 제공한다.
   - `PositionYawRateGoalNed`
   - `VelocityYawRateGoalNed`
   - `VelocityYawAngleGoalNed`
2. `fixed_wing_capable`은 model package의 정적 특성이고,
   `fixed_wing_requested`는 매 velocity update에 전달하는 운용 입력이다.
3. `TiltrotorCascadeController`는 매 tick multirotor와 fixed-wing branch를 모두
   계산한 뒤 legacy 속도 hysteresis와 5초 비율로 네 control axis를 혼합한다.
   tilt 명령은 같은 fixed-wing blend 값을 사용한다.
4. `UamTickResult`는 flight mode, confirmation count 및 blend를 포함하여 Data
   Layer와 시각화 adapter가 controller 내부 상태를 복제하지 않고 기록할 수
   있게 한다.
5. geometry adapter의 충돌 입력은 Digital Twin Contracts의 불변
   `ContactObservation`으로 전달한다. FastPhysics만 관측을 적용해 현재 상태와
   grounded latch를 갱신한다.
6. 질량과 관성은 FastPhysics 구성의 단일 소스로 유지한다. contact 구성에는
   restitution, friction, landing tolerance 및 collision offset만 둔다.

## 결과

- UAM 순항에서 쓰는 velocity + heading 명령이 native SimpleFlight fixed-wing
  cascade와 전환 blend를 통과한다.
- 호출자는 radians와 radians/second를 같은 숫자 필드로 혼동할 수 없다.
- runtime 전환 진단을 별도 StateStore나 topic cache 없이 snapshot과 함께
  소비할 수 있다.
- Unreal은 향후 public contract만 생성하며 FastPhysics 또는 contact 계산
  헤더를 포함할 필요가 없다.
- raw position goal은 현재 multirotor 전용이다. UAM path follower는 legacy와
  같이 velocity goal을 생성하며, fixed-wing position controller 이식은 현재
  임무 기준선에 포함하지 않는다.
