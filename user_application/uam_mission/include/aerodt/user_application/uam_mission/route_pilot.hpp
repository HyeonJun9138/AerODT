#pragma once

#include <variant>
#include <vector>
#include <optional>

#include "aerodt/digital_twin/contracts/vehicle_state.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/simple_flight_goal.hpp"

namespace aerodt::user_application::uam_mission {

struct RouteWaypoint {
  foundation::math::Vector3 position_ned_m{};
  double speed_mps{20.0};
  bool fixed_wing{};
  double capture_m{40.0};
};

// Shared guidance parameters for batch and incremental execution. These are
// mission intent, not an alternate flight-mode controller or physical state.
struct RoutePilotTuning {
  // Bounded acceleration, in both directions: what the aircraft speeds up at
  // and what it can be relied on to stop in.
  double approach_brake_mps2{0.7};
  // Closing speed is this times the range left. Small is gentle and slow.
  double approach_gain{0.35};
  // Slowdown target during reversal; separate from the following approach.
  double reverse_speed_mps{8.0};
  double reverse_transition_s{20.0};
  double reverse_margin_m{100.0};
  // Reserve wing-borne braking distance before the final reverse transition.
  bool reverse_brake_span{true};
  double climb_rate_mps{8.0};
  double descent_rate_mps{2.54};  // 500 ft/min, vertical only.
  double landing_rate_mps{1.2};
  // What counts as having arrived at a waypoint that must be stopped at.
  double hover_capture_m{0.6};
  double hover_settle_s{1.0};
  double descent_settle_s{1.0};
  double hold_speed_mps{8.0};
  // Recovery guidance thresholds; SimpleFlight owns the resulting flight mode
  // and actuator transition. These are not manufacturer-certified limits.
  double wing_stall_mps{23.0};
  double wing_recover_mps{26.0};
  double approach_horizontal_speed_mps{10.0};
  double wing_altitude_gain{0.7};
};

struct RoutePilotProfile {
  std::vector<RouteWaypoint>
      waypoints;  // Absolute local NED goals, not vehicle state.
  foundation::math::Vector3 origin_ned_m{};
  double step_seconds{0.004};
  double initial_yaw_deg{};
  bool smooth_flight{};
  std::optional<double> landing_yaw_deg;  // Arrival taxi tangent; absent keeps legacy guidance.
  bool terminal_landing{};  // Explicit destination deck may differ from departure elevation.
  RoutePilotTuning tuning{};
};

struct GroundThrottleGoal {
  double throttle{};
};
// monostate: waypoint accepted, no physics tick. Query again for the next goal.
using RoutePilotGoal = std::variant<
    std::monostate, GroundThrottleGoal,
    digital_twin::simulation::control::simple_flight::PositionYawRateGoalNed,
    digital_twin::simulation::control::simple_flight::VelocityYawAngleGoalNed>;
struct RoutePilotCommand {
  RoutePilotGoal goal;
  bool fixed_wing_requested{};
};

// One pilot instance per flight. Owns guidance intent and progress ONLY.
// Reads its aircraft's observation; never owns a Runtime, advances physics,
// grants a clearance, observes another aircraft or writes visualization state.
class RoutePilot final {
 public:
  explicit RoutePilot(RoutePilotProfile profile);
  // observed_tilt_deg is the maximum absolute ACTUAL nacelle angle, not an
  // average: opposite yaw tilts must not cancel into a false vertical-ready.
  [[nodiscard]] RoutePilotCommand Update(
      const digital_twin::contracts::VehicleState& state, bool grounded,
      double fixed_wing_blend, double observed_tilt_deg = 0.0);
  [[nodiscard]] std::size_t WaypointIndex() const noexcept { return index; }
  [[nodiscard]] bool IsComplete() const noexcept {
    return index >= options.waypoints.size();
  }
  // Intent update only; the final alignment/landing column is immutable.
  [[nodiscard]] bool SetLandingYaw(double degrees);
  [[nodiscard]] bool LandingYawMutable() const noexcept;
  // Replace only untouched terminal goals, with compare-and-set progress.
  // The current target, controller and runtime observation remain unchanged.
  [[nodiscard]] bool ReplaceArrival(std::size_t expected_index, std::size_t first,
                                   std::vector<RouteWaypoint> suffix, double landing_yaw);
  [[nodiscard]] const char* GuidanceReason() const noexcept {
    return IsComplete() ? "complete" : guidance_reason;
  }
  void SetHold(std::optional<foundation::math::Vector3> position);
  // Tactical intent within a checked corridor; zero smoothly returns to route.
  void SetTraffic(double right_m, double speed_factor);

 private:
  const char* guidance_reason{"route_tracking"};
  RoutePilotProfile options;
  std::size_t index{};
  foundation::math::Vector3 commanded_velocity{};
  double commanded_yaw{};
  double settled_s{};
  double touchdown_s{};
  bool departure_aligned{};
  double departure_yaw_settled_s{};
  bool landing_aligned{};
  double landing_yaw_settled_s{};
  bool reverse_for_approach{};
  bool descent_ready{};
  double descent_settled_s{};
  // One altitude goal for a moving transition hold; never a copy of runtime state.
  std::optional<double> approach_hold_down_m;
  std::optional<foundation::math::Vector3> hold_position;
  double traffic_right_m{}, traffic_right_target_m{}, traffic_speed_factor{1.0};
  // Hold reversal until speed recovers OR actual reverse tilt completes;
  // rearming then leaves forward-transition speed gating to SimpleFlight.
  bool wing_lost{};
};

}  // namespace aerodt::user_application::uam_mission
