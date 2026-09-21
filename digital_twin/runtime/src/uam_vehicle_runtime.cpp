#include "aerodt/digital_twin/runtime/uam_vehicle_runtime.hpp"

#include <cmath>
#include <stdexcept>
#include <unordered_set>
#include <utility>

namespace aerodt::digital_twin::runtime {
namespace {

constexpr double kSeaLevelAirDensityKgM3 = 1.225;

}  // namespace

UamVehicleRuntime::UamVehicleRuntime(UamRuntimeConfig config)
    : config_(std::move(config)),
      physics_(config_.fast_physics),
      mixer_(config_.airframe, config_.mixer),
      multirotor_controller_(config_.simple_flight.multirotor),
      tiltrotor_controller_(config_.simple_flight),
      sensors_(config_.sensors) {
  ValidateAndIndexTopology();
  rotors_.reserve(config_.rotors.size());
  for (const auto& rotor : config_.rotors) rotors_.emplace_back(rotor.parameters);
  tilts_.reserve(config_.tilts.size());
  for (const auto& tilt : config_.tilts) tilts_.emplace_back(tilt.parameters);
  control_surfaces_.reserve(config_.lifting_surfaces.size());
  for (const auto& surface : config_.lifting_surfaces) {
    control_surfaces_.emplace_back(surface.control_parameters);
  }
  Reset();
}

UamTickResult UamVehicleRuntime::AdvanceGroundAssist(double forward,double right,double yaw_rate,double down,double collective) {
  if (!std::isfinite(collective) || collective < 0 || collective > 1)
    throw std::invalid_argument("ground assist collective must be in [0, 1]");
  const auto& state=physics_.AdvanceGroundAssist(config_.step,forward,right,yaw_rate,down);
  auto sensors=sensors_.Update(config_.entity_id,state);
  PrepareControllerPath(ControllerPath::direct);
  // Preserve actuator spool-up during the ground-motion assist.
  // The next airborne tick receives this same physical rotor state.
  simulation::control::simple_flight::ControlAxes controls;
  controls.throttle = collective;
  return FinishTick(controls,tiltrotor_controller_.TransitionState(),state,std::move(sensors));
}

void UamVehicleRuntime::Reset() {
  contracts::VehicleState initial;
  initial.position_ned_m = config_.initial_position_ned_m;
  initial.orientation_body_to_ned = config_.initial_orientation_body_to_ned;
  Reset(initial);
}

void UamVehicleRuntime::Reset(const contracts::VehicleState& state) {
  physics_.Reset(state);
  sensors_.Reset(state);
  multirotor_controller_.Reset();
  tiltrotor_controller_.Reset();
  controller_path_ = ControllerPath::none;
  pending_wrench_ = {};
  for (auto& rotor : rotors_) rotor.Reset();
  for (auto& tilt : tilts_) tilt.Reset();
  for (std::size_t index = 0; index < control_surfaces_.size(); ++index) {
    control_surfaces_[index].Reset();
    physics_.SetControlSurfaceAngle(index, 0.0);
  }
}

UamTickResult UamVehicleRuntime::Advance(
    const simulation::control::simple_flight::ControlAxes& controls,
    const contracts::ContactObservation& contact_observation) {
  // The pending wrench was produced after the preceding physics step.
  const auto& state = physics_.Advance(
      config_.step, pending_wrench_, contact_observation, config_.contact);
  auto sensors = sensors_.Update(config_.entity_id, state);
  PrepareControllerPath(ControllerPath::direct);
  return FinishTick(controls, tiltrotor_controller_.TransitionState(), state,
                    std::move(sensors));
}

UamTickResult UamVehicleRuntime::AdvancePositionGoal(
    const simulation::control::simple_flight::PositionYawRateGoalNed& goal,
    const contracts::ContactObservation& contact_observation) {
  // Preserve the legacy firmware order: physics and its ground-truth estimate
  // are updated before SimpleFlight calculates this tick's actuator command.
  const auto& state = physics_.Advance(
      config_.step, pending_wrench_, contact_observation, config_.contact);
  auto sensors = sensors_.Update(config_.entity_id, state);
  PrepareControllerPath(ControllerPath::position);
  const auto controller_output =
      multirotor_controller_.Update(goal, state, config_.step);
  return FinishTick(controller_output.controls,
                    tiltrotor_controller_.TransitionState(), state,
                    std::move(sensors));
}

UamTickResult UamVehicleRuntime::AdvanceVelocityGoal(
    const simulation::control::simple_flight::VelocityYawRateGoalNed& goal,
    bool fixed_wing_requested,
    const contracts::ContactObservation& contact_observation) {
  const auto& state = physics_.Advance(
      config_.step, pending_wrench_, contact_observation, config_.contact);
  auto sensors = sensors_.Update(config_.entity_id, state);
  PrepareControllerPath(ControllerPath::velocity);
  const auto controller_output = tiltrotor_controller_.Update(
      goal, FixedWingAllowed(fixed_wing_requested), state, config_.step);
  return FinishTick(controller_output.controls, controller_output.transition,
                    state, std::move(sensors));
}

UamTickResult UamVehicleRuntime::AdvanceVelocityGoal(
    const simulation::control::simple_flight::VelocityYawAngleGoalNed& goal,
    bool fixed_wing_requested,
    const contracts::ContactObservation& contact_observation) {
  const auto& state = physics_.Advance(
      config_.step, pending_wrench_, contact_observation, config_.contact);
  auto sensors = sensors_.Update(config_.entity_id, state);
  PrepareControllerPath(ControllerPath::velocity);
  const auto controller_output = tiltrotor_controller_.Update(
      goal, FixedWingAllowed(fixed_wing_requested), state, config_.step);
  return FinishTick(controller_output.controls, controller_output.transition,
                    state, std::move(sensors));
}

UamTickResult UamVehicleRuntime::FinishTick(
    const simulation::control::simple_flight::ControlAxes& controls,
    const simulation::control::simple_flight::FlightModeTransitionOutput& transition,
    const contracts::VehicleState& state,
    contracts::SensorFrame sensors) {
  const auto commands = mixer_.Mix(controls);

  std::vector<NamedTiltOutput> tilt_outputs;
  tilt_outputs.reserve(tilts_.size());
  for (std::size_t index = 0; index < tilts_.size(); ++index) {
    const auto& named_tilt = config_.tilts[index];
    const auto output = tilts_[index].Update(
        commands[CommandIndex(named_tilt.id)], config_.step);
    const auto rotor_position = rotor_index_by_id_.find(named_tilt.target_rotor_id);
    if (rotor_position == rotor_index_by_id_.end()) {
      throw std::logic_error("Tilt target disappeared after topology validation.");
    }
    rotors_[rotor_position->second].SetTilt(output.rotation);
    tilt_outputs.push_back({.id = named_tilt.id, .value = output});
  }

  const double density_ratio =
      config_.fast_physics.aerodynamic_environment.air_density_kgpm3 /
      kSeaLevelAirDensityKgM3;
  std::vector<simulation::actuation::RotorOutput> raw_rotor_outputs;
  std::vector<NamedRotorOutput> rotor_outputs;
  raw_rotor_outputs.reserve(rotors_.size());
  rotor_outputs.reserve(rotors_.size());
  for (std::size_t index = 0; index < rotors_.size(); ++index) {
    const auto& named_rotor = config_.rotors[index];
    rotors_[index].SetAirDensityRatio(density_ratio);
    auto output = rotors_[index].Update(
        commands[CommandIndex(named_rotor.id)], config_.step);
    raw_rotor_outputs.push_back(output);
    rotor_outputs.push_back({.id = named_rotor.id, .value = std::move(output)});
  }

  std::vector<NamedControlSurfaceOutput> surface_outputs;
  surface_outputs.reserve(control_surfaces_.size());
  for (std::size_t index = 0; index < control_surfaces_.size(); ++index) {
    const auto& named_surface = config_.lifting_surfaces[index];
    const auto output = control_surfaces_[index].Update(
        commands[CommandIndex(named_surface.control_actuator_id)], config_.step);
    physics_.SetControlSurfaceAngle(index, output.angle_rad);
    surface_outputs.push_back(
        {.id = named_surface.control_actuator_id, .value = output});
  }

  pending_wrench_ = simulation::actuation::AggregateRotorWrench(
      raw_rotor_outputs.data(), raw_rotor_outputs.size(),
      state.orientation_body_to_ned);

  return {
      .state = {
          .entity_id = config_.entity_id,
          .vehicle = state,
          .is_grounded = physics_.IsGrounded(),
      },
      .sensors = std::move(sensors),
      .controller_output = controls,
      .transition = transition,
      .actuator_commands = commands,
      .rotors = std::move(rotor_outputs),
      .tilts = std::move(tilt_outputs),
      .control_surfaces = std::move(surface_outputs),
      .next_step_wrench = pending_wrench_,
  };
}

// A multirotor airframe has no wing to fly on: a fixed-wing request is an
// operational input it cannot honour, so it keeps the multirotor blend.
bool UamVehicleRuntime::FixedWingAllowed(bool fixed_wing_requested) const noexcept {
  return fixed_wing_requested && config_.simple_flight.fixed_wing_capable;
}

void UamVehicleRuntime::PrepareControllerPath(ControllerPath path) {
  if (controller_path_ == path) return;
  if (path == ControllerPath::velocity) {
    tiltrotor_controller_.Reset();
  } else {
    multirotor_controller_.Reset();
    tiltrotor_controller_.Reset();
  }
  controller_path_ = path;
}

const UamRuntimeConfig& UamVehicleRuntime::Config() const noexcept { return config_; }

const contracts::VehicleState& UamVehicleRuntime::State() const noexcept {
  return physics_.State();
}

const contracts::Wrench& UamVehicleRuntime::PendingWrench() const noexcept {
  return pending_wrench_;
}

bool UamVehicleRuntime::IsGrounded() const noexcept {
  return physics_.IsGrounded();
}

std::size_t UamVehicleRuntime::CommandIndex(const std::string& actuator_id) const {
  const auto position = command_index_by_id_.find(actuator_id);
  if (position == command_index_by_id_.end()) {
    throw std::logic_error("Actuator disappeared after topology validation.");
  }
  return position->second;
}

void UamVehicleRuntime::ValidateAndIndexTopology() {
  if (config_.entity_id.empty() || config_.step.count() <= 0) {
    throw std::invalid_argument("UAM runtime identity and step must be configured.");
  }
  if (config_.mixer.actuator_count != config_.actuator_order.size() ||
      config_.mixer.rotor_count != config_.rotors.size() ||
      config_.fast_physics.lifting_surfaces.size() !=
          config_.lifting_surfaces.size()) {
    throw std::invalid_argument("UAM runtime topology sizes are inconsistent.");
  }
  const auto topology = simulation::control::simple_flight::TopologyOf(config_.airframe);
  if (config_.rotors.size() != topology.rotor_count ||
      config_.tilts.size() != topology.tilt_count ||
      (!topology.lifting_surfaces_allowed && !config_.lifting_surfaces.empty())) {
    throw std::invalid_argument("UAM actuator topology does not match the declared airframe.");
  }
  if (config_.simple_flight.fixed_wing_capable != topology.fixed_wing_capable) {
    throw std::invalid_argument("UAM fixed-wing capability does not match the declared airframe.");
  }

  std::unordered_set<std::string> declared_ids;
  for (std::size_t index = 0; index < config_.actuator_order.size(); ++index) {
    const auto& id = config_.actuator_order[index];
    if (id.empty() || !command_index_by_id_.emplace(id, index).second) {
      throw std::invalid_argument("UAM actuator order contains an empty or duplicate ID.");
    }
  }
  for (std::size_t index = 0; index < config_.rotors.size(); ++index) {
    const auto& id = config_.rotors[index].id;
    if (!declared_ids.insert(id).second || command_index_by_id_.count(id) == 0 ||
        !rotor_index_by_id_.emplace(id, index).second) {
      throw std::invalid_argument("UAM rotor topology contains an invalid ID.");
    }
    if (CommandIndex(id) >= config_.mixer.rotor_count) {
      throw std::invalid_argument("UAM rotor must occupy the rotor prefix of actuator order.");
    }
  }
  for (const auto& tilt : config_.tilts) {
    if (!declared_ids.insert(tilt.id).second ||
        command_index_by_id_.count(tilt.id) == 0 ||
        rotor_index_by_id_.count(tilt.target_rotor_id) == 0) {
      throw std::invalid_argument("UAM tilt topology contains an invalid reference.");
    }
  }
  for (const auto& surface : config_.lifting_surfaces) {
    if (surface.control_actuator_id.empty() ||
        !declared_ids.insert(surface.control_actuator_id).second ||
        command_index_by_id_.count(surface.control_actuator_id) == 0) {
      throw std::invalid_argument("UAM control-surface topology contains an invalid ID.");
    }
  }
  if (declared_ids.size() != config_.actuator_order.size()) {
    throw std::invalid_argument("UAM actuator order contains unsupported actuator IDs.");
  }
}

}  // namespace aerodt::digital_twin::runtime
