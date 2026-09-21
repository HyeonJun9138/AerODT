# Verti-C Ground Operations Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the independent ground-authority and native-guidance tasks. Integrate in this session, with TDD, scoped task reviews, and a final review. The user explicitly requested implementation now; do not ask for another design approval.

**Goal:** 지상 이동 허가와 실제 게이트 점유를 연결하고 공통 이착륙 경로 유도를 개선한다.

**Architecture:** GroundControl은 불변 관측을 받아 이동권만 발급한다. 기존 ScenarioEngine에 주입하여 지상 운동학을 제한하며, native RoutePilot은 공중 목표와 실제 제어를 계속 소유한다. Simulation과 Physical 조립부에 같은 통제를 주입하고 Twin 수신자는 제어하지 않는다.

**Tech Stack:** Python, 기존 native C++/C ABI, pytest, CTest, JavaScript/Node.

**Spec:** `project_support/docs/plans/2026_09_11_ground_operations_and_terminal_guidance_design.md` (사용자가 문서 검토 후 구현 승인).

## Global Constraints

- 현재 사용자가 작업해 온 checkout에서 작업한다. 과거 ProjectAirSim HEAD로 별도 worktree를 만들어 최신 미추적 코드를 누락시키지 않는다. 새 최상위 폴더를 만들지 않는다.
- 작업 기록과 변경 전 사본은 `project_support/ground_control_work`에 둔다. 기존 다른 작업물, staging, 서버, Physical 운항을 건드리지 않는다.
- 공중 물리 상태를 덮어쓰지 않는다. 지상은 기존 운동학 실행이며 실제 바퀴 물리로 주장하지 않는다.
- 순항 150 m는 선호 반경이다. C/G 순서, 지형 높이, 마지막 FATO 정렬과 수직 착륙을 유지한다.
- 접근 수평속도는 상한이다. 사용자 설정 4 m/s도 보존한다. 10 m/s 달성을 위해 공력을 조작하지 않는다.
- 예약은 실제 점유와 별도이며 실제 점유를 시간 만료로 해제하지 않는다. 게이트 변경은 원래 계획을 수정하지 않는다.
- 구현자 파일 소유권을 분리한다. shared 파일은 root 통합 작업만 수정한다. 운영 DLL 대신 별도 빌드 출력으로 시험한다.

## Task 1: 지상 이동 허가와 형상 검사

**Files:** Create `digital_twin/contracts/ground_operations.py`, `digital_twin/model_library/ground_routes.py`, `user_application/uam_mission/ground_control.py`, `project_support/tests/web_live/test_ground_control.py`.

**Interfaces:**
```python
@dataclass(frozen=True)
class GroundObservation:
    aircraft_id: str
    vertiport_id: str
    point_m: tuple[float, float]
    radius_m: float = 7.0

@dataclass(frozen=True)
class GroundRequest:
    aircraft_id: str
    flight_id: str
    vertiport_id: str
    route_id: str
    path_m: tuple[tuple[float, float], ...]
    distance_m: float
    speed_mps: float
    max_speed_mps: float
    radius_m: float
    requested_s: float
    arrival: bool = False

@dataclass(frozen=True)
class MovementAuthority:
    stop_distance_m: float
    speed_limit_mps: float
    reason: str = ''
    blocked_by: tuple[str, ...] = ()
    route_id: str = ''

# VertiportGroundControl.authorize(requests, observations, now_s)
# -> dict[str, MovementAuthority]; reset() clears grants, never observations.
```

- [x] Add tests for same-node and geometric crossings, opposing paths, parked obstruction, request order invariance, safe waiting/egress, release after passed conflict, independent ports/routes, invalid values.
```python
def test_parked_aircraft_keeps_the_crossing_closed():
    request = GroundRequest('A','F','V','R',((0.,0.),(100.,0.)),0.,0.,4.,7.,0.)
    result = VertiportGroundControl().authorize([request], [GroundObservation('B','V',(50.,0.),7.)], 0.)
    assert 0 <= result['A'].stop_distance_m < 36
    assert result['A'].blocked_by == ('B',)
```
- [x] Run `python -m pytest project_support/tests/web_live/test_ground_control.py -q` and capture RED.
- [x] Implement pure arc-length and segment/capsule conflict calculations with cached route geometry. Preserve stable claims while a winner occupies a protected path. Grant losers only a safe prefix outside winner swept space; never clear physical occupancy by expiring a claim.
- [x] Re-run all tests, add a stepped motion fixture that checks separation between ticks, review ownership and deadlock handling.

## Task 2: 地上 실행, 실제 점유 및 게이트 거래

**Files:** Modify `digital_twin/model_library/ground_motion.py`, `digital_twin/simulation/scenario_engine.py`, `psu_sequencing.py`, `user_application/uam_mission/scenario_session.py`, `user_application/apps/physical_uam/fleet.py`; create `project_support/tests/web_live/test_ground_operations.py`.

**Consumes:** Task 1 contracts/authorize. **Produces:** optional `ground_control` constructor dependency, instruction fields action=`ground_wait`/`ground_taxi`, blocker/reason/stop_distance/wait_seconds, actual versus assigned stand reporting.

- [x] Reproduce early gate release and simultaneous ground crossing before implementing.
```python
def test_departure_does_not_free_gate_while_boarding():
    e = engine_of(row('D','A','VP1','VP2','06:30:00'))
    e._maybe_depart(e.aircraft['A'], e.time_s)
    assert e.psu._stands.occupant('VP1','G1') == 'A'
```
- [x] Add a pure movement integrator consuming profile, current distance/speed, authority limit and dt. Compute braking from remaining distance, cap by spatial curve profile, preserve heading tangent and startup/end holds. Test stopped resume acceleration and no stop-line overshoot.
- [x] Preserve taxi_nodes in Phase.detail. Collect all ground observations before motion; invoke authority once per decision step, and never move an aircraft using a stale route_id.
- [x] Separate mission start, actual off-block and observed stand clearance. Gate reservations cannot replace the departing aircraft while it is physically present. Keep phase progress distinct from wall/mission waiting time.
- [x] Split StandTimeline occupancy and reservations without a second authority store. Retarget available/released gates by reachable path and stable preference; preserve original plan and metadata. Validate route, gate reservation and alighting before commit. Mid-taxi changes start at current point, only after stopping.
- [x] Protect arrival egress before final permission. Update heading before final native alignment through Task 3 capability; otherwise align after actual touchdown. Inject the same control in ScenarioSession and PhysicalFleet.
- [x] Run ground/PSU/scenario/session/passenger and Physical tests. Preserve existing non-controller test construction for focused kinematic fixtures while production entry points enable control.

## Task 3: 공통 C/G 유도 및 접근 도달 가능성

**Files:** Modify `user_application/uam_mission/src/route_pilot.cpp`, its header/tests, native C ABI source/header and `communication/python/native_pilot.py`; create focused native approach tests and verification outputs under `project_support/ground_control_work/native`.

**Interfaces:** Existing native state array remains compatible. Add capability-checked `NativePilot.set_landing_yaw(degrees)` (returns whether accepted before final alignment), plus `guidance_status()` returning a reason from the actual native branch. Publish exact schema to root before integration; increment ABI only with old-version tests.

- [x] Add RED tests for short/high multi-segment G approach, ordered projection through a turn and hold reentry, early descent opportunity, configured upper speed 4/10 m/s and actual landing accuracy.
```python
# Same actual native engine; measure real state, not only intent.
assert final_state[13] and final_state[16]
assert maximum_actual_reverse_excursion_m < 5.0
assert maximum_descent_mps < 2.8
assert not source_waypoints_mutated
```
- [x] Use C/G ordered projection/preview rather than steering back to a vertex. Carry vertical deficit through handoff, use remaining routed distance plus actual velocity/transition lag for achievable speed. Never lower F altitude or omit final hover to hide an infeasible G approach.
- [x] Reuse native speed/vertical limits and tilt assistance. Ensure actual controller remains stable through slow/final capture, and yaw change cannot reset physics or turn a descending aircraft sideways.
- [x] Build into a private directory, run CTest and existing shared/right-lane/approach/native tests against that library. Do not replace or restart the operating DLL/server.

## Task 4: 지시 화면과 감사 기록

**Files:** Existing `user_application/web/pilot_decision.js`, role panels, `digital_twin/visualization/web/entity_labels.js` as needed; additive decision-policy/chart contracts; new/updated browser tests.

**Consumes:** Ground instruction + gate assignment/revision + actual native guidance status. **Produces:** specific waiting reason, planned/assigned gate, stale/fresh marker through existing views and stored decision changes.

- [x] Add failing tests that a ground wait does not read as airborne holding, blocker identity is visible, assigned gate differs from plan, and missing reasons are not inferred from speed.
```javascript
const view = describePilotDecision({instruction:{action:'ground_wait',reason:'도착 기체 통과 대기',blocked_by:['UAM0070']}});
assert.match(JSON.stringify(view), /도착 기체/);
```
- [x] Extend existing cards/status and event wiring without new pollers, duplicate state stores or per-frame event spam. Preserve independent name/status visibility.
- [x] Run focused Node/HTTP/Physical contract tests and independent UI validation; keep user replay tab unchanged.

## Task 5: 통합 검증, 리뷰와 기록

- [ ] Compare a fixed saved scenario/environment/policy at 100 aircraft and a full schedule. Measure swept ground overlap, arrivals/holds, deadlock, adverse approach motion and computation time, not just completed count.
- [x] Run focused plus full regressions, native CTest, architecture and actual Unreal mission evidence. Record unavailable tests or pre-existing failures separately.
- [x] Dispatch scoped task reviews and a final cross-component review, resolve load-bearing findings with regression tests.
- [x] Add an ADR for ground authority, actual timing and additive/native public contracts; update CURRENT/HISTORY/evidence with exact commands and limitations.
- [x] Keep active processes intact. Explain verified result and any restart/deployment needed; obtain approval before interrupting an ongoing operation.

## Preflight / Ledger

Baseline: 38 ground/PSU/predictive/approach tests pass before changes. Independent tasks 1 and 3 share no production files. Task 2 is the sole owner of ScenarioEngine and consumes the contracts above; task 4 starts after those fields stabilize. Root retains integration and review responsibility. Task 5 compares implementation against the approved spec, not merely this plan.


## Verification checkpoint (2026-09-11)

Implementation tasks 1–4 are verified within the recorded fixtures. Saved native fleet: 100 aircraft, 3,600 simulated seconds, 129 flights started and 59 completed, no detected ground overlap or pilot failure. This is not a full-day completion. Final-source smoke: native 600 s and rehearsal 300 s; original full-day rehearsal attempt stopped at a 300 s wall budget after 264 simulated seconds. Cold geometry cost improved but remains a large first-use cost in crowded rehearsal.

Final full Python: 1,245 pass, 4 preexisting wall-clock-dependent satellite fixture failures, 1 skip. Same final code and two fixed epochs reproduce the four failures/pass results. Previous full pass before exact cold optimization: 1,246 pass, 1 skip. Final Node: 1,232/1,241, same 9 preexisting failures reproduced with preserved source. Native CTest 18/18 and actual Unreal baseline mission PASS. See ADR0066 and data/development_log/evidence/2026_09_11_ground_operations.json. No operating restart or DLL replacement has been performed. Full-day validation and coordinated operating deployment remain open.
