#include <iostream>
#include <stdexcept>
#include <variant>

#include "aerodt/user_application/uam_mission/uam_mission_sequencer.hpp"

namespace {

using aerodt::digital_twin::contracts::StateSnapshot;
using aerodt::digital_twin::simulation::control::simple_flight::FlightMode;
using aerodt::digital_twin::simulation::control::simple_flight::
    FlightModeTransitionOutput;
using aerodt::digital_twin::simulation::control::simple_flight::
    PositionYawRateGoalNed;
using aerodt::digital_twin::simulation::control::simple_flight::
    VelocityYawAngleGoalNed;
using aerodt::user_application::uam_mission::UamMissionProfile;
using aerodt::user_application::uam_mission::UamMissionSequencer;
using aerodt::user_application::uam_mission::UamMissionStage;

void RequireStage(const UamMissionSequencer& mission, UamMissionStage expected) {
  if (mission.Stage() != expected) {
    throw std::runtime_error("UAM mission entered an unexpected stage.");
  }
}

void TestFullMissionSequenceAndTypedGoals() {
  UamMissionSequencer mission(UamMissionProfile::Standard(true));
  StateSnapshot state{.entity_id = "UAM1"};
  state.vehicle.position_ned_m = {2.0, 3.0, -4.0};
  mission.Reset(state);

  auto command = mission.Update(state, {});
  RequireStage(mission, UamMissionStage::vertical_takeoff);
  const auto& takeoff = std::get<PositionYawRateGoalNed>(command.goal);
  if (takeoff.position_ned_m.x != 2.0 || takeoff.position_ned_m.y != 3.0 ||
      takeoff.position_ned_m.z != -9.0 || command.fixed_wing_requested) {
    throw std::runtime_error("Takeoff goal did not preserve the reset home position.");
  }

  state.vehicle.position_ned_m = takeoff.position_ned_m;
  command = mission.Update(state, {});
  RequireStage(mission, UamMissionStage::climb);
  if (std::get<PositionYawRateGoalNed>(command.goal).position_ned_m.z != -50.0) {
    throw std::runtime_error("Climb goal did not use the short mission altitude.");
  }

  state.vehicle.position_ned_m = {2.0, 3.0, -50.0};
  command = mission.Update(state, {});
  RequireStage(mission, UamMissionStage::transition_fixed_wing);
  const auto& transition_goal = std::get<VelocityYawAngleGoalNed>(command.goal);
  if (transition_goal.velocity_ned_mps.x != 10.0 ||
      transition_goal.velocity_ned_mps.z != -1.0 ||
      !command.fixed_wing_requested) {
    throw std::runtime_error("Fixed-wing transition did not emit a velocity goal.");
  }

  FlightModeTransitionOutput transition{
      .mode = FlightMode::fixed_wing,
      .fixed_wing_blend = 1.0,
  };
  command = mission.Update(state, transition);
  RequireStage(mission, UamMissionStage::fixed_wing_cruise);

  state.vehicle.time.elapsed += std::chrono::seconds(4);
  command = mission.Update(state, transition);
  RequireStage(mission, UamMissionStage::transition_multirotor);
  if (command.fixed_wing_requested ||
      std::get<VelocityYawAngleGoalNed>(command.goal).velocity_ned_mps.x != 5.0) {
    throw std::runtime_error("Multirotor transition command is invalid.");
  }

  transition = {.mode = FlightMode::multirotor, .fixed_wing_blend = 0.0};
  command = mission.Update(state, transition);
  RequireStage(mission, UamMissionStage::return_home);
  const auto& return_goal = std::get<PositionYawRateGoalNed>(command.goal);
  if (return_goal.position_ned_m.x != 2.0 || return_goal.position_ned_m.y != 3.0 ||
      return_goal.position_ned_m.z != -50.0) {
    throw std::runtime_error("Return goal did not use home horizontal coordinates.");
  }

  state.vehicle.position_ned_m = return_goal.position_ned_m;
  command = mission.Update(state, transition);
  RequireStage(mission, UamMissionStage::approach);
  state.vehicle.position_ned_m =
      std::get<PositionYawRateGoalNed>(command.goal).position_ned_m;
  command = mission.Update(state, transition);
  RequireStage(mission, UamMissionStage::vertical_landing);
  const auto& landing_goal = std::get<VelocityYawAngleGoalNed>(command.goal);
  if (landing_goal.velocity_ned_mps.z != 0.5) {
    throw std::runtime_error("Landing did not request a vertical descent.");
  }

  state.vehicle.position_ned_m = {2.0, 3.0, -1.341};
  state.vehicle.linear_velocity_ned_mps = {};
  state.is_grounded = true;
  command = mission.Update(state, transition);
  RequireStage(mission, UamMissionStage::completed);
  if (!mission.IsComplete() ||
      !std::holds_alternative<VelocityYawAngleGoalNed>(command.goal)) {
    throw std::runtime_error("Landing did not complete after grounded state.");
  }
}

void TestRequiresResetAndRejectsInvalidProfile() {
  UamMissionSequencer mission(UamMissionProfile::Standard(true));
  bool update_threw = false;
  try {
    static_cast<void>(mission.Update({}, {}));
  } catch (const std::logic_error&) {
    update_threw = true;
  }
  if (!update_threw) throw std::runtime_error("Mission accepted update before reset.");

  auto invalid = UamMissionProfile::Standard(true);
  invalid.cruise_speed_mps = 0.0;
  bool profile_threw = false;
  try {
    UamMissionSequencer rejected(invalid);
  } catch (const std::invalid_argument&) {
    profile_threw = true;
  }
  if (!profile_threw) throw std::runtime_error("Mission accepted an invalid profile.");
}

}  // namespace

int main() {
  try {
    TestFullMissionSequenceAndTypedGoals();
    TestRequiresResetAndRejectsInvalidProfile();
    std::cout << "AERODT_UAM_MISSION=PASS\n";
    return 0;
  } catch (const std::exception& exception) {
    std::cerr << "AERODT_UAM_MISSION=FAIL: " << exception.what() << '\n';
    return 1;
  }
}
