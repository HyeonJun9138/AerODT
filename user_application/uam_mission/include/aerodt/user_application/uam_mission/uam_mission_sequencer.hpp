#pragma once

#include <chrono>
#include <variant>

#include "aerodt/digital_twin/contracts/state_snapshot.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/flight_mode_transition.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/simple_flight_goal.hpp"

namespace aerodt::user_application::uam_mission {

enum class UamMissionStage {
  vertical_takeoff,
  climb,
  transition_fixed_wing,
  fixed_wing_cruise,
  transition_multirotor,
  return_home,
  approach,
  vertical_landing,
  completed,
};

[[nodiscard]] const char* ToString(UamMissionStage stage) noexcept;

struct UamMissionProfile {
  double takeoff_height_m{5.0};
  double cruise_altitude_down_m{-25.0};
  double cruise_speed_mps{18.0};
  std::chrono::nanoseconds cruise_duration{std::chrono::seconds(10)};
  // A small climb request gives the level-flight multirotor controller enough
  // thrust margin to cross the AirTaxi's strict fixed-wing speed threshold.
  double transition_vertical_velocity_ned_mps{-1.0};
  double transition_return_speed_mps{5.0};
  double approach_height_m{5.0};
  double position_tolerance_m{0.75};
  double waypoint_speed_tolerance_mps{0.5};
  double landing_speed_tolerance_mps{0.5};
  double landing_descent_speed_mps{0.5};
  double fixed_wing_blend_tolerance{1e-3};

  [[nodiscard]] static UamMissionProfile Standard(bool short_mission) noexcept;
};

using UamGoal = std::variant<
    digital_twin::simulation::control::simple_flight::PositionYawRateGoalNed,
    digital_twin::simulation::control::simple_flight::VelocityYawAngleGoalNed>;

struct UamMissionCommand {
  UamMissionStage stage{UamMissionStage::vertical_takeoff};
  UamGoal goal{};
  bool fixed_wing_requested{};
};

// Generates typed SimpleFlight goals only. The authoritative vehicle state
// remains in UamVehicleRuntime and the caller owns tick execution and logging.
class UamMissionSequencer final {
 public:
  explicit UamMissionSequencer(UamMissionProfile profile);

  void Reset(const digital_twin::contracts::StateSnapshot& initial_state);
  [[nodiscard]] UamMissionCommand Update(
      const digital_twin::contracts::StateSnapshot& state,
      const digital_twin::simulation::control::simple_flight::
          FlightModeTransitionOutput& transition);

  [[nodiscard]] UamMissionStage Stage() const noexcept;
  [[nodiscard]] bool IsComplete() const noexcept;

 private:
  void ValidateProfile() const;
  void EnterStage(UamMissionStage stage, std::chrono::nanoseconds now) noexcept;
  [[nodiscard]] UamMissionCommand CommandForCurrentStage() const;
  [[nodiscard]] bool IsNear(
      const foundation::math::Vector3& actual,
      const foundation::math::Vector3& target) const noexcept;
  [[nodiscard]] bool IsSettledAt(
      const digital_twin::contracts::VehicleState& state,
      const foundation::math::Vector3& target) const noexcept;

  UamMissionProfile profile_;
  foundation::math::Vector3 home_position_ned_m_{};
  UamMissionStage stage_{UamMissionStage::vertical_takeoff};
  std::chrono::nanoseconds stage_started_at_{};
  bool initialized_{};
};

}  // namespace aerodt::user_application::uam_mission
