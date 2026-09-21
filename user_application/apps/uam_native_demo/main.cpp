#include <chrono>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <variant>

#include "aerodt/data/run_recorder.hpp"
#include "aerodt/data/sensor_telemetry_writer.hpp"
#include "aerodt/digital_twin/runtime/uam_vehicle_runtime.hpp"
#include "aerodt/digital_twin/simulation/environment/flat_ground_contact_model.hpp"
#include "aerodt/user_application/uam_mission/uam_mission_sequencer.hpp"

namespace {

using aerodt::data::RunRecorder;
using aerodt::data::RunStatus;
using aerodt::digital_twin::contracts::StateSnapshot;
using aerodt::digital_twin::runtime::LoadAeroDTAirTaxiRuntimeConfig;
using aerodt::digital_twin::runtime::UamTickResult;
using aerodt::digital_twin::runtime::UamVehicleRuntime;
using aerodt::digital_twin::simulation::environment::FlatGroundContactModel;
using aerodt::digital_twin::simulation::control::simple_flight::
    PositionYawRateGoalNed;
using aerodt::digital_twin::simulation::control::simple_flight::
    VelocityYawAngleGoalNed;
using aerodt::user_application::uam_mission::ToString;
using aerodt::user_application::uam_mission::UamMissionProfile;
using aerodt::user_application::uam_mission::UamMissionSequencer;
using aerodt::user_application::uam_mission::UamMissionStage;

struct Arguments {
  bool short_mission{};
  double timeout_seconds{300.0};
  std::filesystem::path workspace{"data/workspace"};
};

Arguments ParseArguments(int argc, char** argv) {
  Arguments result;
  for (int index = 1; index < argc; ++index) {
    const std::string argument = argv[index];
    if (argument == "--short") {
      result.short_mission = true;
    } else if (argument == "--timeout-seconds" && index + 1 < argc) {
      result.timeout_seconds = std::stod(argv[++index]);
    } else if (argument == "--workspace" && index + 1 < argc) {
      result.workspace = argv[++index];
    } else {
      throw std::invalid_argument("Unknown or incomplete argument: " + argument);
    }
  }
  if (!(result.timeout_seconds > 0.0)) {
    throw std::invalid_argument("Timeout must be greater than zero.");
  }
  return result;
}

std::string StateMessage(const StateSnapshot& snapshot) {
  const auto& state = snapshot.vehicle;
  std::ostringstream message;
  message << std::fixed << std::setprecision(3)
          << "t=" << std::chrono::duration<double>(state.time.elapsed).count()
          << " p_ned=[" << state.position_ned_m.x << ',' << state.position_ned_m.y
          << ',' << state.position_ned_m.z << "] v_ned=["
          << state.linear_velocity_ned_mps.x << ','
          << state.linear_velocity_ned_mps.y << ','
          << state.linear_velocity_ned_mps.z << "] grounded="
          << (snapshot.is_grounded ? "true" : "false");
  return message.str();
}

UamTickResult ExecuteCommand(UamVehicleRuntime& runtime,
                             const aerodt::user_application::uam_mission::
                                 UamMissionCommand& command,
                             const aerodt::digital_twin::contracts::
                                 ContactObservation& contact) {
  if (const auto* position = std::get_if<PositionYawRateGoalNed>(&command.goal)) {
    return runtime.AdvancePositionGoal(*position, contact);
  }
  return runtime.AdvanceVelocityGoal(
      std::get<VelocityYawAngleGoalNed>(command.goal),
      command.fixed_wing_requested, contact);
}

int Run(const Arguments& arguments) {
  auto config = LoadAeroDTAirTaxiRuntimeConfig();
  RunRecorder recorder(
      arguments.workspace,
      "uam_native_demo",
      {
          {"airframe", "vtol-quad-tiltrotor"},
          {"controller", "simple-flight"},
          {"mission", arguments.short_mission ? "short" : "standard"},
          {"model_package_id", config.package_id},
          {"model_package_version", config.package_version},
          {"physics", "fast-physics"},
          {"sensor_source", "aerodt-native"},
      });
  recorder.Write({
      .component = "user_application.uam_native_demo",
      .event = "run_started",
      .message = "Native FastPhysics + SimpleFlight UAM run " + recorder.RunId(),
  });
  aerodt::data::SensorTelemetryWriter telemetry(
      recorder.RunDirectory() / "sensor_telemetry.jsonl");

  UamVehicleRuntime runtime(std::move(config));
  StateSnapshot snapshot{
      .entity_id = runtime.Config().entity_id,
      .vehicle = runtime.State(),
      .is_grounded = runtime.IsGrounded(),
  };
  FlatGroundContactModel flat_ground({
      .ground_plane_down_m = 0.0,
      .body_ground_clearance_m = runtime.Config().body_ground_clearance_m,
  });
  aerodt::digital_twin::contracts::ContactObservation pending_contact;
  UamMissionSequencer mission(UamMissionProfile::Standard(arguments.short_mission));
  mission.Reset(snapshot);
  aerodt::digital_twin::simulation::control::simple_flight::
      FlightModeTransitionOutput transition;
  UamMissionStage logged_stage = UamMissionStage::completed;
  std::chrono::nanoseconds next_state_log{};
  const auto timeout = std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::duration<double>(arguments.timeout_seconds));

  while (!mission.IsComplete() && snapshot.vehicle.time.elapsed < timeout) {
    const auto command = mission.Update(snapshot, transition);
    if (command.stage != logged_stage) {
      logged_stage = command.stage;
      recorder.Write({
          .component = "user_application.uam_mission",
          .event = ToString(logged_stage),
          .message = StateMessage(snapshot),
      });
    }
    const auto tick = ExecuteCommand(runtime, command, pending_contact);
    telemetry.Write(tick.sensors);
    snapshot = tick.state;
    transition = tick.transition;
    pending_contact = flat_ground.Observe(snapshot.vehicle);
    if (snapshot.vehicle.time.elapsed >= next_state_log) {
      recorder.Write({
          .component = "digital_twin.runtime",
          .event = "state_snapshot",
          .message = StateMessage(snapshot),
      });
      next_state_log += std::chrono::seconds(1);
    }
  }

  // Let the sequencer observe the final tick before deciding the result.
  if (!mission.IsComplete()) {
    static_cast<void>(mission.Update(snapshot, transition));
  }
  if (mission.IsComplete() && snapshot.is_grounded) {
    telemetry.Flush();
    const auto sensor_counts = telemetry.Counts();
    if (sensor_counts.imu == 0 || sensor_counts.gps == 0 ||
        sensor_counts.cameras == 0) {
      throw std::runtime_error("Native UAM mission produced incomplete sensor telemetry.");
    }
    recorder.Write({
        .component = "digital_twin.sensors",
        .event = "native_sensor_publication_completed",
        .message = "imu=" + std::to_string(sensor_counts.imu) +
                   " gps=" + std::to_string(sensor_counts.gps) +
                   " cameras=" + std::to_string(sensor_counts.cameras),
    });
    recorder.Write({
        .component = "user_application.uam_native_demo",
        .event = "uam_mission_passed",
        .message = StateMessage(snapshot),
    });
    recorder.Finish(RunStatus::passed);
    std::cout << "AERODT_NATIVE_UAM_DEMO=PASS RUN_ID=" << recorder.RunId() << '\n';
    return 0;
  }

  const std::string failure = std::string("stage=") + ToString(mission.Stage()) +
                              " " + StateMessage(snapshot);
  recorder.Write({
      .level = aerodt::foundation::diagnostics::LogLevel::error,
      .component = "user_application.uam_native_demo",
      .event = "uam_mission_timeout",
      .message = failure,
  });
  recorder.Finish(RunStatus::failed, failure);
  std::cerr << "AERODT_NATIVE_UAM_DEMO=FAIL stage=" << ToString(mission.Stage())
            << " RUN_ID=" << recorder.RunId() << '\n';
  return 2;
}

}  // namespace

int main(int argc, char** argv) {
  try {
    return Run(ParseArguments(argc, argv));
  } catch (const std::exception& exception) {
    std::cerr << "AERODT_NATIVE_UAM_DEMO=ERROR " << exception.what() << '\n';
    return 1;
  }
}
