#include "aerodt/user_application/uam_mission/route_pilot.hpp"

#include <cmath>
#include <iostream>
#include <stdexcept>

using namespace aerodt::user_application::uam_mission;
using aerodt::digital_twin::contracts::VehicleState;
using aerodt::digital_twin::simulation::control::simple_flight::
    PositionYawRateGoalNed;
using aerodt::digital_twin::simulation::control::simple_flight::
    VelocityYawAngleGoalNed;

void Require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

int main() {
  try {
    {
      RoutePilotProfile p{.waypoints={
          {.position_ned_m={0,0,-30},.capture_m=1},
          {.position_ned_m={200,0,-100},.fixed_wing=true},
          {.position_ned_m={400,0,-30}},
          {.position_ned_m={400,0,0}}}};
      RoutePilot live(p);
      VehicleState observation{};
      observation.position_ned_m={0,0,-30};
      (void)live.Update(observation,false,0);
      const std::vector<RouteWaypoint> alternate={
          {.position_ned_m={400,100,-30}}, {.position_ned_m={400,100,0}}};
      Require(live.WaypointIndex()==1,"arrival update fixture at shared prefix");
      Require(!live.ReplaceArrival(0,2,alternate,90),"stale progress refuses update");
      Require(!live.ReplaceArrival(1,1,alternate,90),"cannot replace current target");
      Require(live.ReplaceArrival(1,2,alternate,90),"future arrival may be replaced");
      Require(live.WaypointIndex()==1 && observation.position_ned_m.z==-30,
              "arrival replacement cannot reset progress or pose");
      observation.position_ned_m={200,0,-100};
      (void)live.Update(observation,false,0);
      Require(!live.ReplaceArrival(2,2,alternate,0),"entered approach cannot be redirected");
    }
    RoutePilotProfile profile{
        .waypoints = {{.position_ned_m = {0, 0, -10}, .capture_m = 1},
                      {.position_ned_m = {100, 0, -10},
                       .fixed_wing = true,
                       .capture_m = 1},
                      {.position_ned_m = {100, 0, 0}, .capture_m = 1}}};
    RoutePilot pilot(profile), other(profile);
    VehicleState state{};
    const auto command = pilot.Update(state, false, 0);
    Require(std::holds_alternative<PositionYawRateGoalNed>(command.goal),
            "vertical goal must hold position");
    Require(state.position_ned_m.z == 0, "pilot must not move its observation");
    state.position_ned_m.z = -10;
    Require(std::holds_alternative<std::monostate>(
                pilot.Update(state, false, 0).goal),
            "capture must not tick physics");
    Require(pilot.WaypointIndex() == 1 && other.WaypointIndex() == 0,
            "pilots must have isolated progress");
    const auto cruise = pilot.Update(state, false, 0);
    Require(
        cruise.fixed_wing_requested &&
            std::get<VelocityYawAngleGoalNed>(cruise.goal).velocity_ned_mps.x >
                0,
        "pilot requests mode, actuator/runtime decides resulting tilt");
    state.position_ned_m.x = 100;
    (void)pilot.Update(state, false, 1);
    Require(!pilot.Update(state, false, 1).fixed_wing_requested,
            "landing must request multirotor");
    state.position_ned_m.z = 0;
    (void)pilot.Update(state, true, 0);
    Require(pilot.IsComplete() && std::holds_alternative<std::monostate>(
                                      pilot.Update(state, true, 0).goal),
            "complete pilot must not issue extra ticks");

    profile.smooth_flight = true;
    profile.step_seconds = 0.1;
    RoutePilot smooth(profile);
    state = {};
    Require(std::get<GroundThrottleGoal>(smooth.Update(state, true, 0).goal)
                    .throttle == 0,
            "spin-up begins from rest");
    state.time.elapsed = std::chrono::seconds(3);
    Require(std::abs(
                std::get<GroundThrottleGoal>(smooth.Update(state, true, 0).goal)
                    .throttle -
                .04) < 1e-12,
            "spin-up profile must be preserved");
    state.time.elapsed = std::chrono::seconds(6);
    state.position_ned_m.z = -10;
    state.linear_velocity_ned_mps.x = 1;
    for (int i = 0; i < 20; ++i) (void)smooth.Update(state, false, 0);
    Require(smooth.WaypointIndex() == 0,
            "passing through hover is not stable arrival");
    state.linear_velocity_ned_mps = {};
    for (int i = 0; i < 11; ++i) (void)smooth.Update(state, false, 0);
    Require(smooth.WaypointIndex() == 1,
            "settled own observation must advance pilot");

    RoutePilotProfile arrival{
        .waypoints = {{.position_ned_m = {0, 0, -30}, .capture_m = 1},
                      {.position_ned_m = {0, 0, 0}, .capture_m = 1}},
        .step_seconds = 0.1, .smooth_flight = true, .landing_yaw_deg = 180.0};
    RoutePilot aligned(arrival);
    state = {};
    state.time.elapsed = std::chrono::seconds(10);
    state.position_ned_m.z = -30;
    for (int i = 0; i < 11; ++i) (void)aligned.Update(state, false, 0);
    Require(aligned.WaypointIndex() == 1, "arrival is captured over the FATO");
    auto velocity = [&](double blend, double tilt = 0.0) {
      const auto result = aligned.Update(state, false, blend, tilt);
      Require(!result.fixed_wing_requested, "alignment cannot request forward tilt");
      return std::get<VelocityYawAngleGoalNed>(result.goal);
    };
    for (int i = 0; i < 220; ++i)
      Require(std::abs(velocity(0).velocity_ned_mps.z) < 1e-12,
              "commanded yaw alone must not authorize descent");
    state.orientation_body_to_ned = {0, 0, 0, 1};  // Actual 180-degree yaw.
    state.angular_velocity_body_radps.z = .2;
    for (int i = 0; i < 20; ++i)
      Require(std::abs(velocity(0).velocity_ned_mps.z) < 1e-12,
              "passing through target yaw while rotating is not stable alignment");
    state.angular_velocity_body_radps.z = 0;
    for (int i = 0; i < 20; ++i)
      Require(std::abs(velocity(1).velocity_ned_mps.z) < 1e-12,
              "unfinished reverse transition must block descent");
    for (int i = 0; i < 20; ++i)
      Require(std::abs(velocity(0, 15).velocity_ned_mps.z) < 1e-12,
              "actual rotor tilt must also block final vertical landing at the FATO");
    for (int i = 0; i < 9; ++i)
      Require(std::abs(velocity(0).velocity_ned_mps.z) < 1e-12,
              "heading needs one second of stable observation");
    (void)velocity(0);
    Require(velocity(0).velocity_ned_mps.z > 0,
            "aligned multirotor may begin bounded vertical descent");
    Require(state.position_ned_m.z == -30,
            "alignment guidance must not overwrite observed pose");
    // Same descent height with both a short and a long horizontal approach.
    for (double approach_m : {100.0, 2000.0}) {
      RoutePilot approach({
          .waypoints = {{{0, 0, -300}, 20, false, 1},
                        {{1000, 0, -300}, 20, true, 1},
                        {{1000 + approach_m, 0, -30}, 20, false, 1},
                        {{1000 + approach_m, 0, 0}, 2, false, 1}},
          .step_seconds = 0.1, .smooth_flight = true});
      state = {};
      state.time.elapsed = std::chrono::seconds(10);
      state.position_ned_m = {0, 0, -300};
      for (int i = 0; i < 11; ++i) (void)approach.Update(state, false, 0);
      // Departure alignment is measured and settled before acceleration.
      for (int i = 0; i < 11; ++i) (void)approach.Update(state, false, 0);
      state.linear_velocity_ned_mps.x = 20;
      Require(approach.Update(state, false, 1, 90).fixed_wing_requested,
              "distant descent must not reverse prematurely");
      state.position_ned_m.x = 700;
      Require(!approach.Update(state, false, 1, 90).fixed_wing_requested,
              "braking and transition must begin before descending segment");
      state.position_ned_m.x = 1000;
      state.linear_velocity_ned_mps = {};
      (void)approach.Update(state, false, 0);
      Require(approach.WaypointIndex() == 2, "arrived at descent entry");
      for (int i = 0; i < 20; ++i) {
        auto command = approach.Update(state, false, 0, 15);
        Require(!command.fixed_wing_requested &&
                std::abs(std::get<VelocityYawAngleGoalNed>(command.goal).velocity_ned_mps.z) < 1e-9,
                "actual tilt must settle even when transition blend is zero");
      }
      for (int i = 0; i < 9; ++i)
        Require(std::abs(std::get<VelocityYawAngleGoalNed>(
                    approach.Update(state, false, 0, 0).goal).velocity_ned_mps.z) < 1e-9,
                "descent needs consecutive stable observations");
      double down = 0;
      for (int i = 0; i < 100; ++i) {
        down = std::get<VelocityYawAngleGoalNed>(
                   approach.Update(state, false, 0, 0).goal).velocity_ned_mps.z;
        Require(down <= 2.54 + 1e-9, "500 ft/min descent speed is bounded regardless of slope");
      }
      Require(down > 0, "stable multirotor must resume descent");
      Require(state.position_ned_m.z == -300, "pilot never teleports observation");
    }

    // A passed approach entry is a handoff, not a mandatory hover at the old WP.
    RoutePilot flowing({
        .waypoints = {{{0, 0, -300}, 20, false, 1},
                      {{1000, 0, -300}, 30, true, 60},
                      {{3000, 0, -30}, 20, false, 60},
                      {{3000, 0, 0}, 2, false, 1}},
        .step_seconds = 0.1, .smooth_flight = true});
    state = {};
    state.time.elapsed = std::chrono::seconds(10);
    state.position_ned_m = {0, 0, -300};
    for (int i = 0; i < 22; ++i) (void)flowing.Update(state, false, 0);
    state.position_ned_m.x = 700;
    state.linear_velocity_ned_mps.x = 20;
    (void)flowing.Update(state, false, 1, 90);  // Start the planned reversal.
    state.position_ned_m = {1080, 0, -295};
    state.linear_velocity_ned_mps.x = 8;
    (void)flowing.Update(state, false, 0, 0);
    Require(flowing.WaypointIndex() == 2,
            "passed approach entry must hand off instead of turning back to capture it");
    RoutePilot interrupted = flowing;
    (void)interrupted.Update(state, false, 0, 0);  // Establish moving hold altitude intent.
    interrupted.SetHold(aerodt::foundation::math::Vector3{1080, 0, -260});
    auto held_state = state;
    held_state.position_ned_m.z = -260;
    (void)interrupted.Update(held_state, false, 0, 0);
    interrupted.SetHold(std::nullopt);
    Require(std::get<VelocityYawAngleGoalNed>(interrupted.Update(held_state, false, 0, 0).goal)
                .velocity_ned_mps.z >= 0,
            "resuming an approach must not climb back to a pre-clearance hold altitude");
    for (int i = 0; i < 100; ++i) {
      const auto goal = std::get<VelocityYawAngleGoalNed>(
          flowing.Update(state, false, 0, 0).goal);
      Require(goal.velocity_ned_mps.x >= 0,
              "a moving multirotor must not return to the old descent entry");
    }
    auto flowing_goal = std::get<VelocityYawAngleGoalNed>(flowing.Update(state, false, 0, 0).goal);
    Require(flowing_goal.velocity_ned_mps.x > 9.9 && flowing_goal.velocity_ned_mps.z > 0,
            "long approach uses independent 10 m/s horizontal intent while descending");
    Require(flowing_goal.allow_rotor_tilt_assist,
            "settled moving approach permits package-bounded forward rotor assistance");
    flowing.SetHold(state.position_ned_m);
    Require(!std::get<VelocityYawAngleGoalNed>(flowing.Update(state, false, 0, 14).goal)
                 .allow_rotor_tilt_assist,
            "external hold withdraws rotor assistance");
    flowing.SetHold(std::nullopt);
    Require(!std::get<VelocityYawAngleGoalNed>(flowing.Update(state, false, 0, 14).goal)
                 .allow_rotor_tilt_assist,
            "resumed approach waits for actual vertical alignment before assisting again");
    Require(state.position_ned_m.x == 1080 && state.position_ned_m.z == -295,
            "handoff must not rewrite observed flight state");

    RoutePilot level_approach({
        .waypoints = {{{0, 0, -300}, 20, false, 1},
                      {{1000, 0, -300}, 30, true, 60},
                      {{1500, 0, -100}, 20, false, 150},
                      {{2500, 0, -100}, 20, false, 150},
                      {{2500, 0, 0}, 2, false, 1}},
        .step_seconds = 0.1, .smooth_flight = true});
    state = {};
    state.time.elapsed = std::chrono::seconds(10);
    state.position_ned_m = {0, 0, -300};
    for (int i = 0; i < 22; ++i) (void)level_approach.Update(state, false, 0);
    state.position_ned_m.x = 700;
    state.linear_velocity_ned_mps.x = 20;
    (void)level_approach.Update(state, false, 1, 90);
    state.position_ned_m.x = 1000;
    (void)level_approach.Update(state, false, 0, 0);
    state.position_ned_m = {1580, 0, -110};
    state.linear_velocity_ned_mps.x = 8;
    (void)level_approach.Update(state, false, 0, 0);
    Require(level_approach.WaypointIndex() == 3,
            "passed intermediate descent WP must flow into a level approach too");
    state.position_ned_m = {2000, 0, -100};
    for (int i = 0; i < 100; ++i) (void)level_approach.Update(state, false, 0, 0);
    Require(std::get<VelocityYawAngleGoalNed>(level_approach.Update(state, false, 0, 0).goal)
                .velocity_ned_mps.x > 9.9, "level approach uses independent horizontal speed");
    state.position_ned_m.x = 2480;
    (void)level_approach.Update(state, false, 0, 0);
    Require(level_approach.WaypointIndex() == 3,
            "final FATO hover must not be consumed as an intermediate passage");

    // An ordered G corner must be anticipated, not acquired and then reversed.
    RoutePilot corner({
        .waypoints = {{{0, 0, -300}, 20, false, 1},
                      {{1000, 0, -300}, 30, true, 60},
                      {{1100, 0, -150}, 10, false, 60},
                      {{1100, 100, -30}, 10, false, 60},
                      {{1100, 100, 0}, 2, false, 1}},
        .step_seconds = 0.1, .smooth_flight = true});
    state = {};
    state.time.elapsed = std::chrono::seconds(10);
    state.position_ned_m = {0, 0, -300};
    for (int i = 0; i < 22; ++i) (void)corner.Update(state, false, 0);
    state.position_ned_m = {1000, 0, -300};
    (void)corner.Update(state, false, 0);
    Require(corner.WaypointIndex() == 2, "entered ordered G path");
    for (int i = 0; i < 12; ++i) (void)corner.Update(state, false, 0);
    state.position_ned_m = {1070, 0, -190};
    state.linear_velocity_ned_mps = {4, 0, 2};
    auto anticipated = corner.Update(state, false, 0);
    Require(corner.WaypointIndex() == 2,
            "short high G must budget descent before prematurely consuming its corner");
    Require(std::get<VelocityYawAngleGoalNed>(anticipated.goal).yaw_angle_ned_rad > 0,
            "G guidance previews the next ordered leg before the vertex");

    // Clearance release can leave the aircraft on the NEXT ordered G leg.
    // It must not insist on revisiting the old corner's capture disk.
    corner.SetHold(aerodt::foundation::math::Vector3{1105, 60, -100});
    state.position_ned_m = {1105, 60, -100};
    state.linear_velocity_ned_mps = {};
    (void)corner.Update(state, false, 0);
    corner.SetHold(std::nullopt);
    (void)corner.Update(state, false, 0);
    Require(corner.WaypointIndex() == 3,
            "hold release already on next ordered G leg must not reacquire old vertex");
    Require(std::get<VelocityYawAngleGoalNed>(corner.Update(state, false, 0).goal)
                .velocity_ned_mps.z >= 0,
            "handoff from hold cannot reset altitude to an earlier high waypoint");

    // A released approach clearance must not reacquire a passed F/G vertex
    // when the observed aircraft is already inside the next ordered leg.
    RoutePilot released_entry({
        .waypoints = {{{0, 0, -300}, 20, false, 1},
                      {{1000, 0, -300}, 30, true, 60},
                      {{1600, 0, -150}, 10, false, 1},
                      {{1800, 0, -30}, 10, false, 60},
                      {{1800, 0, 0}, 2, false, 1}},
        .step_seconds = 0.1, .smooth_flight = true});
    state = {};
    state.time.elapsed = std::chrono::seconds(10);
    state.position_ned_m = {0, 0, -300};
    for (int i = 0; i < 22; ++i) (void)released_entry.Update(state, false, 0);
    state.position_ned_m = {1150, 20, -290};
    state.linear_velocity_ned_mps = {8, 0, 0};
    released_entry.SetHold(state.position_ned_m);
    for (int i = 0; i < 20; ++i) (void)released_entry.Update(state, false, 0, 0);
    Require(released_entry.WaypointIndex() == 1, "active clearance hold must not consume approach entry");
    released_entry.SetHold(std::nullopt);
    for (int invalid = 0; invalid < 6; ++invalid) {
      RoutePilot guarded = released_entry;
      auto observation = state;
      if (invalid == 0) observation.linear_velocity_ned_mps.x = 35;
      if (invalid == 1) observation.position_ned_m.y = 90;
      if (invalid == 2) observation.position_ned_m.z = -350;
      if (invalid == 3) observation.position_ned_m.x = 1550;
      if (invalid == 4) observation.linear_velocity_ned_mps.x = -8;
      if (invalid == 5) observation.linear_velocity_ned_mps.z = 4;
      (void)guarded.Update(observation, false, 0, 0);
      Require(guarded.WaypointIndex() == 1,
              "entry relaxation excludes overspeed, off-route, altitude error, remote points and reverse motion");
    }
    RoutePilot tilting = released_entry;
    (void)tilting.Update(state, false, 0.5, 45);
    Require(tilting.WaypointIndex() == 1, "relaxed entry requires observed rotor readiness");
    (void)tilting.Update(state, false, 0, 10);
    Require(tilting.WaypointIndex() == 1, "zero blend alone does not confirm actual rotor alignment");
    (void)released_entry.Update(state, false, 0, 0);
    Require(released_entry.WaypointIndex() == 2,
            "released approach already on next ordered leg must not turn back to hit the entry point");
    Require(state.position_ned_m.x == 1150 && state.position_ned_m.z == -290,
            "relaxed passage cannot rewrite physical state");
    state.position_ned_m = {1588, 5, -150};
    RoutePilot high_corner = released_entry;
    auto high_observation = state;
    high_observation.position_ned_m.z = -180;
    (void)high_corner.Update(high_observation, false, 0, 0);
    Require(high_corner.WaypointIndex() == 2, "near-corner relaxation must still respect altitude tolerance");
    (void)released_entry.Update(state, false, 0, 0);
    Require(released_entry.WaypointIndex() == 3,
            "a slow aligned intermediate approach need not acquire a one-metre point exactly");

    RoutePilot departure({
        .waypoints = {{{0, 0, -30}, 2, false, 8},
                      {{700, 0, -300}, 45, true, 60},
                      {{5000, 0, -300}, 60, true, 60},
                      {{6000, 0, -30}, 8, false, 60},
                      {{6000, 0, 0}, 2, false, 8}},
        .step_seconds = 0.1, .initial_yaw_deg = 180, .smooth_flight = true});
    state = {};
    state.time.elapsed = std::chrono::seconds(10);
    state.orientation_body_to_ned = {0, 0, 0, 1};
    state.position_ned_m.z = -15;
    const auto lifting = std::get<VelocityYawAngleGoalNed>(departure.Update(state, false, 0).goal);
    Require(lifting.velocity_ned_mps.z < 0 &&
            std::abs(lifting.yaw_angle_ned_rad - 3.141592653589793) < 1e-9,
            "lift vertically first; a different route yaw must not send it back to the deck");
    state.position_ned_m.z = -30;
    for (int i = 0; i < 11; ++i) (void)departure.Update(state, false, 0);
    for (int i = 0; i < 220; ++i) {
      auto c = departure.Update(state, false, 0);
      Require(!c.fixed_wing_requested &&
              std::abs(std::get<VelocityYawAngleGoalNed>(c.goal).velocity_ned_mps.z) < 1e-9,
              "yaw alignment holds the achieved departure altitude until actually aligned");
    }
    state.orientation_body_to_ned = {};
    for (int i = 0; i < 11; ++i) (void)departure.Update(state, false, 0);
    Require(departure.Update(state, false, 0).fixed_wing_requested,
            "aligned departure may accelerate and request forward transition");
    state.position_ned_m = {700, 0, -240};
    state.linear_velocity_ned_mps = {30, 0, -4};
    (void)departure.Update(state, false, 1, 90);
    Require(departure.WaypointIndex() == 2,
            "passed climb vertex continues laterally; it must not turn back for a height error");
    auto correction = std::get<VelocityYawAngleGoalNed>(departure.Update(state, false, 1, 90).goal);
    Require(correction.velocity_ned_mps.x > 0 && correction.velocity_ned_mps.z < 0,
            "the remaining planned altitude is still tracked after lateral capture");
    state.linear_velocity_ned_mps = {15, 0, 1};
    Require(!departure.Update(state, false, 1, 90).fixed_wing_requested,
            "a sinking slow wing initiates rotor recovery");
    Require(!departure.Update(state, false, 0.2, 20).fixed_wing_requested,
            "recovery does not chatter during reverse tilt");
    Require(departure.Update(state, false, 0, 0).fixed_wing_requested,
            "completed recovery rearms the controller instead of deadlocking below wing speed");
    for (double side : {-1.0, 1.0}) {
      RoutePilot turns({
          .waypoints = {{{0, 0, -30}, 2, false, 1},
                        {{1000, 0, -300}, 47, true, 150},
                        {{4000, 0, -300}, 60, true, 150},
                        {{4000, side * 3000, -300}, 60, true, 150},
                        {{2000, 0, -300}, 60, true, 150},
                        {{6000, 0, -300}, 60, true, 150},
                        {{7000, 0, -30}, 20, false, 60}},
          .step_seconds = 0.1, .smooth_flight = true});
      state = {};
      state.time.elapsed = std::chrono::seconds(10);
      state.position_ned_m = {0, 0, -30};
      for (int i = 0; i < 25; ++i) (void)turns.Update(state, false, 0);
      state.position_ned_m = {1000, 0, -300};
      state.linear_velocity_ned_mps = {40, 0, 0};
      (void)turns.Update(state, false, 1, 90);
      Require(turns.WaypointIndex() == 2, "departure joins the ordered route");
      state.position_ned_m.x = 2000;  // A future crossing point, NOT the active WP.
      (void)turns.Update(state, false, 1, 90);
      Require(turns.WaypointIndex() == 2, "crossings must not jump to a future waypoint");
      state.position_ned_m.x = 3750;
      for (int i = 0; i < 10; ++i) {
        const auto turn = turns.Update(state, false, 1, 90);
        const auto goal = std::get<VelocityYawAngleGoalNed>(turn.goal);
        Require(turn.fixed_wing_requested, "ordinary turn keeps forward-flight intent");
        Require(side * goal.yaw_angle_ned_rad > 0, "turn starts before entering capture tolerance");
        Require(std::abs(std::remainder(std::atan2(goal.velocity_ned_mps.y, goal.velocity_ned_mps.x) -
            goal.yaw_angle_ned_rad, 6.283185307179586)) < 1e-9,
            "turning must not cancel velocity through vector blending");
      }
      Require(turns.WaypointIndex() == 2, "150 m is not a fixed early-turn switch");
      state.position_ned_m = {4300, side * 151, -300};
      (void)turns.Update(state, false, 1, 90);
      Require(turns.WaypointIndex() == 2, "passing beyond the WP outside lateral tolerance is not capture");
      const auto passage = side > 0
          ? aerodt::foundation::math::Vector3{3880, 160, -300}
          : aerodt::foundation::math::Vector3{4000, -149, -300};
      state.position_ned_m = passage;
      state.linear_velocity_ned_mps.x = 60;
      (void)turns.Update(state, false, 1, 90);
      Require(turns.WaypointIndex() == 3,
              "preferred passage or bounded wider bisector fly-by captures only the next WP");
      Require(state.position_ned_m.x == passage.x && state.position_ned_m.y == passage.y,
              "lane guidance never overwrites physical state");
    }

    std::cout << "RoutePilot typed goals, observation ownership and "
                 "independent progress PASS\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
