#include "aerodt/digital_twin/simulation/fast_physics/fast_physics_engine.hpp"

#include <cmath>
#include <algorithm>
#include <stdexcept>

namespace aerodt::digital_twin::simulation::fast_physics {
namespace {

using foundation::math::Quaternion;
using foundation::math::Vector3;

Vector3 LimitMagnitude(Vector3 value, double maximum, bool* limited) {
  const double norm = value.Norm();
  if (norm <= maximum) {
    *limited = false;
    return value;
  }
  *limited = true;
  return value * (maximum / norm);
}

void RequireFinite(const contracts::VehicleState& state) {
  if (!state.position_ned_m.IsFinite() || !state.orientation_body_to_ned.IsFinite() ||
      !state.linear_velocity_ned_mps.IsFinite() ||
      !state.angular_velocity_body_radps.IsFinite() ||
      !state.linear_acceleration_ned_mps2.IsFinite() ||
      !state.angular_acceleration_body_radps2.IsFinite()) {
    throw std::runtime_error("FastPhysics produced a non-finite vehicle state.");
  }
}

void ValidateContactInput(
    const contracts::ContactObservation& observation,
    const contact::ContactParameters& parameters) {
  if (!std::isfinite(parameters.restitution) ||
      parameters.restitution < 0.0 || !std::isfinite(parameters.friction) ||
      parameters.friction < 0.0 ||
      !std::isfinite(parameters.landing_axis_tolerance) ||
      parameters.landing_axis_tolerance < 0.0 ||
      !std::isfinite(parameters.collision_offset_m) ||
      parameters.collision_offset_m < 0.0) {
    throw std::invalid_argument("FastPhysics contact parameters are invalid.");
  }
  if (observation.has_collided &&
      (!observation.normal_ned.IsFinite() ||
       observation.normal_ned.Norm() <= 1e-12 ||
       !observation.collision_position_ned_m.IsFinite() ||
       !observation.impact_point_ned_m.IsFinite() ||
       !std::isfinite(observation.penetration_depth_m) ||
       observation.penetration_depth_m < 0.0)) {
    throw std::invalid_argument("FastPhysics contact observation is invalid.");
  }
}

}  // namespace

FastPhysicsEngine::FastPhysicsEngine(FastPhysicsParameters parameters)
    : parameters_(parameters), inverse_inertia_(parameters.inertia_body_kg_m2.Inverse()) {
  if (!std::isfinite(parameters_.mass_kg) || parameters_.mass_kg <= 0.0) {
    throw std::invalid_argument("FastPhysics mass must be finite and greater than zero.");
  }
  if (!std::isfinite(parameters_.speed_limit_mps) || parameters_.speed_limit_mps <= 0.0) {
    throw std::invalid_argument("FastPhysics speed limit must be finite and greater than zero.");
  }
}

void FastPhysicsEngine::Reset(const contracts::VehicleState& state) {
  RequireFinite(state);
  state_ = state;
  state_.orientation_body_to_ned = state_.orientation_body_to_ned.Normalized();
  is_grounded_ = false;
}

const contracts::VehicleState& FastPhysicsEngine::AdvanceGroundAssist(
    std::chrono::nanoseconds step, double forward, double right, double yaw_rate, double down) {
  const double dt=std::chrono::duration<double>(step).count();
  if(dt<=0||dt>.1||!std::isfinite(forward)||!std::isfinite(right)||!std::isfinite(yaw_rate)||!std::isfinite(down))
    throw std::invalid_argument("ground assist command");
  if(std::abs(state_.position_ned_m.z-down)>.2||state_.linear_velocity_ned_mps.z<-.5)
    throw std::invalid_argument("ground assist requires ground contact");
  const auto&q=state_.orientation_body_to_ned;
  double yaw=std::atan2(2*(q.w*q.z+q.x*q.y),1-2*(q.y*q.y+q.z*q.z));
  auto previous=state_.linear_velocity_ned_mps;
  const double magnitude=std::max(1.,std::hypot(forward,right)/3.0);forward/=magnitude;right/=magnitude;
  const double north=std::cos(yaw)*forward-std::sin(yaw)*right,east=std::sin(yaw)*forward+std::cos(yaw)*right;
  auto delta=Vector3{north-previous.x,east-previous.y,0};const double length=delta.Norm();
  if(length>dt*.8)delta=delta*(dt*.8/length);
  state_.linear_velocity_ned_mps={previous.x+delta.x,previous.y+delta.y,0};
  state_.position_ned_m.x+=(previous.x+state_.linear_velocity_ned_mps.x)*.5*dt;
  state_.position_ned_m.y+=(previous.y+state_.linear_velocity_ned_mps.y)*.5*dt;
  state_.position_ned_m.z=down;
  const double rate=state_.angular_velocity_body_radps.z+std::clamp(std::clamp(yaw_rate,-.21,.21)-state_.angular_velocity_body_radps.z,-dt*.4,dt*.4);
  yaw+=rate*dt;state_.orientation_body_to_ned={.w=std::cos(yaw/2),.x=0,.y=0,.z=std::sin(yaw/2)};
  state_.angular_velocity_body_radps={0,0,rate};state_.angular_acceleration_body_radps2={};
  state_.linear_acceleration_ned_mps2=(state_.linear_velocity_ned_mps-previous)*(1/dt);
  state_.time.elapsed+=step;++state_.time.step;is_grounded_=true;return state_;
}

const contracts::VehicleState& FastPhysicsEngine::Advance(
    std::chrono::nanoseconds step, const contracts::Wrench& previous_step_wrench) {
  if (contact::ShouldRemainGrounded(is_grounded_, state_, previous_step_wrench,
                                    parameters_.gravity_ned_mps2,
                                    parameters_.mass_kg)) {
    state_ = CalculateGroundedNext(step, state_.position_ned_m);
  } else {
    is_grounded_ = false;
    state_ = CalculateFreeFlightNext(step, previous_step_wrench);
  }
  return state_;
}

const contracts::VehicleState& FastPhysicsEngine::Advance(
    std::chrono::nanoseconds step,
    const contracts::Wrench& previous_step_wrench,
    const contracts::ContactObservation& contact_observation,
    const contact::ContactParameters& contact_parameters) {
  ValidateContactInput(contact_observation, contact_parameters);
  if (contact::ShouldRemainGrounded(is_grounded_, state_, previous_step_wrench,
                                    parameters_.gravity_ned_mps2,
                                    parameters_.mass_kg)) {
    state_ = CalculateGroundedNext(step, state_.position_ned_m);
    return state_;
  }

  is_grounded_ = false;
  const auto candidate = CalculateFreeFlightNext(step, previous_step_wrench);
  if (!contact::NeedsCollisionResponse(contact_observation, candidate)) {
    state_ = candidate;
    return state_;
  }

  if (contact::IsLandingCollision(contact_observation, state_,
                                  contact_parameters.landing_axis_tolerance)) {
    is_grounded_ = true;
    const auto normal = contact_observation.normal_ned /
                        contact_observation.normal_ned.Norm();
    const auto landed_position =
        contact_observation.collision_position_ned_m +
        normal * (contact_observation.penetration_depth_m +
                  contact_parameters.collision_offset_m);
    state_ = CalculateGroundedNext(step, landed_position);
  } else {
    state_ = contact::CalculateCollisionResponse(
        step, state_, contact_observation, parameters_.mass_kg,
        parameters_.inertia_body_kg_m2, contact_parameters);
  }
  RequireFinite(state_);
  return state_;
}

contracts::VehicleState FastPhysicsEngine::CalculateFreeFlightNext(
    std::chrono::nanoseconds step,
    const contracts::Wrench& previous_step_wrench) const {
  const double dt = std::chrono::duration<double>(step).count();
  if (!std::isfinite(dt) || dt <= 0.0) {
    throw std::invalid_argument("FastPhysics step must be greater than zero.");
  }

  const Vector3 average_linear_velocity =
      state_.linear_velocity_ned_mps + state_.linear_acceleration_ned_mps2 * (0.5 * dt);
  const Vector3 average_angular_velocity =
      state_.angular_velocity_body_radps +
      state_.angular_acceleration_body_radps2 * (0.5 * dt);

  const contracts::Wrench drag_wrench = aerodynamics::CalculateDragFaceWrench(
      average_linear_velocity, parameters_.drag_faces, state_.orientation_body_to_ned,
      parameters_.aerodynamic_environment);
  const contracts::Wrench lift_drag_wrench = aerodynamics::CalculateLiftDragWrench(
      parameters_.lifting_surfaces, state_.orientation_body_to_ned, average_linear_velocity,
      parameters_.aerodynamic_environment);
  const contracts::Wrench total_wrench{
      .force_ned_n = previous_step_wrench.force_ned_n + drag_wrench.force_ned_n +
                     lift_drag_wrench.force_ned_n,
      .torque_body_nm = previous_step_wrench.torque_body_nm + drag_wrench.torque_body_nm +
                        lift_drag_wrench.torque_body_nm,
  };

  contracts::VehicleState next = state_;
  next.time.elapsed += step;
  ++next.time.step;
  next.linear_acceleration_ned_mps2 =
      total_wrench.force_ned_n / parameters_.mass_kg + parameters_.gravity_ned_mps2;

  const Vector3 angular_momentum = parameters_.inertia_body_kg_m2 * average_angular_velocity;
  const Vector3 angular_momentum_rate =
      total_wrench.torque_body_nm - average_angular_velocity.Cross(angular_momentum);
  next.angular_acceleration_body_radps2 = inverse_inertia_ * angular_momentum_rate;

  next.linear_velocity_ned_mps =
      state_.linear_velocity_ned_mps +
      (state_.linear_acceleration_ned_mps2 + next.linear_acceleration_ned_mps2) * (0.5 * dt);
  next.angular_velocity_body_radps =
      state_.angular_velocity_body_radps +
      (state_.angular_acceleration_body_radps2 + next.angular_acceleration_body_radps2) *
          (0.5 * dt);

  bool limited = false;
  next.linear_velocity_ned_mps =
      LimitMagnitude(next.linear_velocity_ned_mps, parameters_.speed_limit_mps, &limited);
  if (limited) next.linear_acceleration_ned_mps2 = {};
  next.angular_velocity_body_radps =
      LimitMagnitude(next.angular_velocity_body_radps, parameters_.speed_limit_mps, &limited);
  if (limited) next.angular_acceleration_body_radps2 = {};

  next.position_ned_m = state_.position_ned_m + average_linear_velocity * dt;
  const double angular_speed = average_angular_velocity.Norm();
  if (angular_speed > 1e-12) {
    const Quaternion delta =
        Quaternion::FromAxisAngle(average_angular_velocity / angular_speed, angular_speed * dt);
    next.orientation_body_to_ned = (state_.orientation_body_to_ned * delta).Normalized();
  }

  RequireFinite(next);
  return next;
}

contracts::VehicleState FastPhysicsEngine::CalculateGroundedNext(
    std::chrono::nanoseconds step,
    const foundation::math::Vector3& position_ned_m) const {
  if (step.count() <= 0) {
    throw std::invalid_argument("FastPhysics step must be greater than zero.");
  }
  auto next = contact::CalculateGroundedState(state_, position_ned_m);
  next.time.elapsed += step;
  ++next.time.step;
  RequireFinite(next);
  return next;
}

const contracts::VehicleState& FastPhysicsEngine::State() const noexcept { return state_; }

bool FastPhysicsEngine::IsGrounded() const noexcept { return is_grounded_; }

void FastPhysicsEngine::SetAerodynamicEnvironment(
    const aerodynamics::AerodynamicEnvironment& environment) {
  if (!std::isfinite(environment.air_density_kgpm3) || environment.air_density_kgpm3 < 0.0 ||
      !environment.wind_velocity_ned_mps.IsFinite()) {
    throw std::invalid_argument("Aerodynamic environment must be finite and non-negative.");
  }
  parameters_.aerodynamic_environment = environment;
}

void FastPhysicsEngine::SetControlSurfaceAngle(std::size_t surface_index, double angle_rad) {
  if (surface_index >= parameters_.lifting_surfaces.size()) {
    throw std::out_of_range("Lifting-surface index is out of range.");
  }
  if (!std::isfinite(angle_rad)) {
    throw std::invalid_argument("Control-surface angle must be finite.");
  }
  parameters_.lifting_surfaces[surface_index].control_angle_rad = angle_rad;
}

}  // namespace aerodt::digital_twin::simulation::fast_physics
