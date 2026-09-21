#include "aerodt/user_application/uam_mission/uam_mission_sequencer.hpp"

#include <cmath>
#include <stdexcept>

namespace aerodt::user_application::uam_mission {
namespace {

using digital_twin::simulation::control::simple_flight::FlightMode;
using digital_twin::simulation::control::simple_flight::PositionYawRateGoalNed;
using digital_twin::simulation::control::simple_flight::VelocityYawAngleGoalNed;
using foundation::math::Vector3;

bool IsFinitePositive(double value) {
  return std::isfinite(value) && value > 0.0;
}

}  // namespace

const char* ToString(UamMissionStage stage) noexcept {
  switch (stage) {
    case UamMissionStage::vertical_takeoff: return "vertical_takeoff";
    case UamMissionStage::climb: return "climb";
    case UamMissionStage::transition_fixed_wing: return "transition_fixed_wing";
    case UamMissionStage::fixed_wing_cruise: return "fixed_wing_cruise";
    case UamMissionStage::transition_multirotor: return "transition_multirotor";
    case UamMissionStage::return_home: return "return_home";
    case UamMissionStage::approach: return "approach";
    case UamMissionStage::vertical_landing: return "vertical_landing";
    case UamMissionStage::completed: return "completed";
  }
  return "unknown";
}

UamMissionProfile UamMissionProfile::Standard(bool short_mission) noexcept {
  UamMissionProfile result;
  if (short_mission) {
    // Blocks contains a 25 m obstacle on the positive-X departure corridor.
    // Keep the short validation mission above the city geometry while still
    // exercising the same controller, transition, return, and landing path.
    result.cruise_altitude_down_m = -50.0;
    result.cruise_speed_mps = 10.0;
    result.cruise_duration = std::chrono::seconds(4);
  }
  return result;
}

UamMissionSequencer::UamMissionSequencer(UamMissionProfile profile)
    : profile_(profile) {
  ValidateProfile();
}

void UamMissionSequencer::Reset(
    const digital_twin::contracts::StateSnapshot& initial_state) {
  if (!initial_state.vehicle.position_ned_m.IsFinite()) {
    throw std::invalid_argument("UAM mission home position must be finite.");
  }
  home_position_ned_m_ = initial_state.vehicle.position_ned_m;
  stage_ = UamMissionStage::vertical_takeoff;
  stage_started_at_ = initial_state.vehicle.time.elapsed;
  initialized_ = true;
}

UamMissionCommand UamMissionSequencer::Update(
    const digital_twin::contracts::StateSnapshot& state,
    const digital_twin::simulation::control::simple_flight::
        FlightModeTransitionOutput& transition) {
  if (!initialized_) {
    throw std::logic_error("UAM mission must be reset before update.");
  }
  const auto& vehicle = state.vehicle;
  if (!vehicle.position_ned_m.IsFinite() ||
      !vehicle.linear_velocity_ned_mps.IsFinite()) {
    throw std::invalid_argument("UAM mission state must be finite.");
  }

  const Vector3 takeoff_target{
      home_position_ned_m_.x,
      home_position_ned_m_.y,
      home_position_ned_m_.z - profile_.takeoff_height_m,
  };
  const Vector3 cruise_home{
      home_position_ned_m_.x,
      home_position_ned_m_.y,
      profile_.cruise_altitude_down_m,
  };
  const Vector3 approach_target{
      home_position_ned_m_.x,
      home_position_ned_m_.y,
      home_position_ned_m_.z - profile_.approach_height_m,
  };

  switch (stage_) {
    case UamMissionStage::vertical_takeoff:
      if (IsSettledAt(vehicle, takeoff_target)) {
        EnterStage(UamMissionStage::climb, vehicle.time.elapsed);
      }
      break;
    case UamMissionStage::climb:
      if (IsSettledAt(vehicle, cruise_home)) {
        EnterStage(UamMissionStage::transition_fixed_wing, vehicle.time.elapsed);
      }
      break;
    case UamMissionStage::transition_fixed_wing:
      if (transition.mode == FlightMode::fixed_wing &&
          transition.fixed_wing_blend >=
              1.0 - profile_.fixed_wing_blend_tolerance) {
        EnterStage(UamMissionStage::fixed_wing_cruise, vehicle.time.elapsed);
      }
      break;
    case UamMissionStage::fixed_wing_cruise:
      if (vehicle.time.elapsed - stage_started_at_ >= profile_.cruise_duration) {
        EnterStage(UamMissionStage::transition_multirotor, vehicle.time.elapsed);
      }
      break;
    case UamMissionStage::transition_multirotor:
      if (transition.mode == FlightMode::multirotor &&
          transition.fixed_wing_blend <= profile_.fixed_wing_blend_tolerance) {
        EnterStage(UamMissionStage::return_home, vehicle.time.elapsed);
      }
      break;
    case UamMissionStage::return_home:
      if (IsSettledAt(vehicle, cruise_home)) {
        EnterStage(UamMissionStage::approach, vehicle.time.elapsed);
      }
      break;
    case UamMissionStage::approach:
      if (IsSettledAt(vehicle, approach_target)) {
        EnterStage(UamMissionStage::vertical_landing, vehicle.time.elapsed);
      }
      break;
    case UamMissionStage::vertical_landing:
      if (state.is_grounded &&
          vehicle.linear_velocity_ned_mps.Norm() <=
              profile_.landing_speed_tolerance_mps) {
        EnterStage(UamMissionStage::completed, vehicle.time.elapsed);
      }
      break;
    case UamMissionStage::completed:
      break;
  }
  return CommandForCurrentStage();
}

UamMissionStage UamMissionSequencer::Stage() const noexcept { return stage_; }

bool UamMissionSequencer::IsComplete() const noexcept {
  return stage_ == UamMissionStage::completed;
}

void UamMissionSequencer::ValidateProfile() const {
  if (!IsFinitePositive(profile_.takeoff_height_m) ||
      !std::isfinite(profile_.cruise_altitude_down_m) ||
      !IsFinitePositive(profile_.cruise_speed_mps) ||
      profile_.cruise_duration.count() <= 0 ||
      !std::isfinite(profile_.transition_vertical_velocity_ned_mps) ||
      profile_.transition_vertical_velocity_ned_mps > 0.0 ||
      !IsFinitePositive(profile_.transition_return_speed_mps) ||
      !IsFinitePositive(profile_.approach_height_m) ||
      !IsFinitePositive(profile_.position_tolerance_m) ||
      !IsFinitePositive(profile_.waypoint_speed_tolerance_mps) ||
      !IsFinitePositive(profile_.landing_speed_tolerance_mps) ||
      !IsFinitePositive(profile_.landing_descent_speed_mps) ||
      !std::isfinite(profile_.fixed_wing_blend_tolerance) ||
      profile_.fixed_wing_blend_tolerance < 0.0 ||
      profile_.fixed_wing_blend_tolerance >= 0.5) {
    throw std::invalid_argument("UAM mission profile is invalid.");
  }
}

void UamMissionSequencer::EnterStage(
    UamMissionStage stage, std::chrono::nanoseconds now) noexcept {
  stage_ = stage;
  stage_started_at_ = now;
}

UamMissionCommand UamMissionSequencer::CommandForCurrentStage() const {
  const PositionYawRateGoalNed takeoff_goal{
      .position_ned_m = {
          home_position_ned_m_.x,
          home_position_ned_m_.y,
          home_position_ned_m_.z - profile_.takeoff_height_m,
      },
      .yaw_rate_body_radps = 0.0,
  };
  const PositionYawRateGoalNed cruise_home_goal{
      .position_ned_m = {
          home_position_ned_m_.x,
          home_position_ned_m_.y,
          profile_.cruise_altitude_down_m,
      },
      .yaw_rate_body_radps = 0.0,
  };
  const VelocityYawAngleGoalNed cruise_goal{
      .velocity_ned_mps = {profile_.cruise_speed_mps, 0.0, 0.0},
      .yaw_angle_ned_rad = 0.0,
  };
  const VelocityYawAngleGoalNed transition_goal{
      .velocity_ned_mps = {
          profile_.cruise_speed_mps,
          0.0,
          profile_.transition_vertical_velocity_ned_mps,
      },
      .yaw_angle_ned_rad = 0.0,
  };

  switch (stage_) {
    case UamMissionStage::vertical_takeoff:
      return {.stage = stage_, .goal = takeoff_goal};
    case UamMissionStage::climb:
      return {.stage = stage_, .goal = cruise_home_goal};
    case UamMissionStage::transition_fixed_wing:
      return {.stage = stage_, .goal = transition_goal, .fixed_wing_requested = true};
    case UamMissionStage::fixed_wing_cruise:
      return {.stage = stage_, .goal = cruise_goal, .fixed_wing_requested = true};
    case UamMissionStage::transition_multirotor:
      return {
          .stage = stage_,
          .goal = VelocityYawAngleGoalNed{
              .velocity_ned_mps = {profile_.transition_return_speed_mps, 0.0, 0.0},
              .yaw_angle_ned_rad = 0.0,
          },
          .fixed_wing_requested = false,
      };
    case UamMissionStage::return_home:
      return {.stage = stage_, .goal = cruise_home_goal};
    case UamMissionStage::approach:
      return {
          .stage = stage_,
          .goal = PositionYawRateGoalNed{
              .position_ned_m = {
                  home_position_ned_m_.x,
                  home_position_ned_m_.y,
                  home_position_ned_m_.z - profile_.approach_height_m,
              },
              .yaw_rate_body_radps = 0.0,
          },
      };
    case UamMissionStage::vertical_landing:
      return {
          .stage = stage_,
          .goal = VelocityYawAngleGoalNed{
              .velocity_ned_mps = {0.0, 0.0, profile_.landing_descent_speed_mps},
              .yaw_angle_ned_rad = 0.0,
          },
      };
    case UamMissionStage::completed:
      return {
          .stage = stage_,
          .goal = VelocityYawAngleGoalNed{
              .velocity_ned_mps = {},
              .yaw_angle_ned_rad = 0.0,
          },
      };
  }
  throw std::logic_error("Unknown UAM mission stage.");
}

bool UamMissionSequencer::IsNear(
    const foundation::math::Vector3& actual,
    const foundation::math::Vector3& target) const noexcept {
  return (actual - target).Norm() <= profile_.position_tolerance_m;
}

bool UamMissionSequencer::IsSettledAt(
    const digital_twin::contracts::VehicleState& state,
    const foundation::math::Vector3& target) const noexcept {
  return IsNear(state.position_ned_m, target) &&
         state.linear_velocity_ned_mps.Norm() <=
             profile_.waypoint_speed_tolerance_mps;
}

}  // namespace aerodt::user_application::uam_mission
