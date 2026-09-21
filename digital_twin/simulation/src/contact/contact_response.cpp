#include "aerodt/digital_twin/simulation/contact/contact_response.hpp"

#include <cmath>
#include <stdexcept>

namespace aerodt::digital_twin::simulation::contact {
namespace {

using contracts::VehicleState;
using foundation::math::Matrix3;
using foundation::math::Quaternion;
using foundation::math::Vector3;

constexpr double kEpsilon = 1e-12;

Vector3 NormalizeOrZero(const Vector3& value) {
  const double norm = value.Norm();
  return norm > kEpsilon ? value / norm : Vector3{};
}

double YawFromQuaternion(const Quaternion& orientation) {
  const Quaternion q = orientation.Normalized();
  return std::atan2(2.0 * (q.w * q.z + q.x * q.y),
                    1.0 - 2.0 * (q.y * q.y + q.z * q.z));
}

void ValidateParameters(const ContactParameters& parameters) {
  if (!std::isfinite(parameters.restitution) || parameters.restitution < 0.0 ||
      !std::isfinite(parameters.friction) || parameters.friction < 0.0 ||
      !std::isfinite(parameters.landing_axis_tolerance) ||
      parameters.landing_axis_tolerance < 0.0 ||
      !std::isfinite(parameters.collision_offset_m) ||
      parameters.collision_offset_m < 0.0) {
    throw std::invalid_argument("Contact parameters must be finite and non-negative.");
  }
}

}  // namespace

bool ShouldRemainGrounded(bool currently_grounded, const VehicleState& state,
                          const contracts::Wrench& external_wrench,
                          const Vector3& gravity_ned_mps2, double mass_kg) {
  if (!std::isfinite(mass_kg) || mass_kg <= 0.0 || !gravity_ned_mps2.IsFinite() ||
      !external_wrench.force_ned_n.IsFinite()) {
    throw std::invalid_argument("Ground-state inputs must be finite and mass must be positive.");
  }
  const double applied_force_squared = external_wrench.force_ned_n.NormSquared();
  const double weight_squared = (gravity_ned_mps2 * mass_kg).NormSquared();
  return currently_grounded && applied_force_squared < weight_squared &&
         state.linear_velocity_ned_mps.z >= 0.0;
}

bool NeedsCollisionResponse(const contracts::ContactObservation& contact,
                            const VehicleState& candidate_state) {
  return contact.has_collided &&
         contact.normal_ned.Dot(candidate_state.linear_velocity_ned_mps) < 0.0;
}

bool IsLandingCollision(const contracts::ContactObservation& contact,
                        const VehicleState& current_state,
                        double axis_tolerance) {
  if (!contact.has_collided) return false;
  if (!std::isfinite(axis_tolerance) || axis_tolerance < 0.0) {
    throw std::invalid_argument("Landing axis tolerance must be finite and non-negative.");
  }
  const Vector3 normal_body =
      current_state.orientation_body_to_ned.Conjugate().Rotate(contact.normal_ned);
  const bool ground_normal = std::abs(normal_body.z + 1.0) <= axis_tolerance;
  const Vector3 velocity = current_state.linear_velocity_ned_mps;
  const bool moving_downward = velocity.z > std::abs(velocity.x) &&
                               velocity.z > std::abs(velocity.y);
  return ground_normal && moving_downward;
}

VehicleState CalculateGroundedState(const VehicleState& current_state,
                                    const Vector3& grounded_position_ned_m) {
  if (!grounded_position_ned_m.IsFinite()) {
    throw std::invalid_argument("Grounded position must be finite.");
  }
  VehicleState grounded = current_state;
  grounded.position_ned_m = grounded_position_ned_m;
  grounded.linear_velocity_ned_mps = {};
  grounded.angular_velocity_body_radps = {};
  grounded.linear_acceleration_ned_mps2 = {};
  grounded.angular_acceleration_body_radps2 = {};
  const double yaw = YawFromQuaternion(current_state.orientation_body_to_ned);
  grounded.orientation_body_to_ned =
      Quaternion::FromAxisAngle({0.0, 0.0, 1.0}, yaw).Normalized();
  return grounded;
}

VehicleState CalculateCollisionResponse(std::chrono::nanoseconds step,
                                        const VehicleState& current_state,
                                        const contracts::ContactObservation& contact,
                                        double mass_kg,
                                        const Matrix3& inertia_body_kg_m2,
                                        const ContactParameters& parameters) {
  ValidateParameters(parameters);
  const double dt = std::chrono::duration<double>(step).count();
  if (!std::isfinite(mass_kg) || mass_kg <= 0.0 || !std::isfinite(dt) ||
      dt <= 0.0 || !contact.normal_ned.IsFinite() ||
      contact.normal_ned.Norm() <= kEpsilon || !contact.collision_position_ned_m.IsFinite() ||
      !contact.impact_point_ned_m.IsFinite() || !std::isfinite(contact.penetration_depth_m) ||
      contact.penetration_depth_m < 0.0) {
    throw std::invalid_argument("Collision response inputs must be finite and valid.");
  }

  const Matrix3 inertia_inverse = inertia_body_kg_m2.Inverse();
  const double inverse_mass = 1.0 / mass_kg;
  const Vector3 normal_ned = NormalizeOrZero(contact.normal_ned);
  const Vector3 normal_body =
      current_state.orientation_body_to_ned.Conjugate().Rotate(normal_ned);
  const Vector3 average_linear_velocity_ned =
      current_state.linear_velocity_ned_mps + current_state.linear_acceleration_ned_mps2 * dt;
  const Vector3 average_angular_velocity_body =
      current_state.angular_velocity_body_radps +
      current_state.angular_acceleration_body_radps2 * dt;
  const Vector3 average_linear_velocity_body =
      current_state.orientation_body_to_ned.Conjugate().Rotate(average_linear_velocity_ned);
  const Vector3 contact_offset = contact.impact_point_ned_m - contact.collision_position_ned_m;
  const Vector3 contact_velocity_body =
      average_linear_velocity_body + average_angular_velocity_body.Cross(contact_offset);

  const Vector3 radius_cross_normal = contact_offset.Cross(normal_body);
  const double restitution_denominator =
      inverse_mass + (inertia_inverse * radius_cross_normal).Cross(contact_offset).Dot(normal_body);
  if (std::abs(restitution_denominator) <= kEpsilon) {
    throw std::runtime_error("Collision restitution impulse is singular.");
  }
  const double restitution_impulse =
      -contact_velocity_body.Dot(normal_body) * (1.0 + parameters.restitution) /
      restitution_denominator;

  VehicleState next = current_state;
  next.time.elapsed += step;
  ++next.time.step;
  next.linear_velocity_ned_mps =
      average_linear_velocity_ned + normal_ned * (restitution_impulse * inverse_mass);
  next.angular_velocity_body_radps =
      average_angular_velocity_body + radius_cross_normal * restitution_impulse;

  const Vector3 tangent_velocity_body =
      contact_velocity_body - normal_body * normal_body.Dot(contact_velocity_body);
  const Vector3 tangent_unit_body = NormalizeOrZero(tangent_velocity_body);
  if (tangent_unit_body.Norm() > kEpsilon) {
    const Vector3 radius_cross_tangent = contact_offset.Cross(tangent_unit_body);
    const double friction_denominator =
        inverse_mass +
        (inertia_inverse * radius_cross_tangent).Cross(contact_offset).Dot(tangent_unit_body);
    if (std::abs(friction_denominator) <= kEpsilon) {
      throw std::runtime_error("Collision friction impulse is singular.");
    }
    const double friction_impulse =
        -tangent_velocity_body.Norm() * parameters.friction / friction_denominator;
    const Vector3 tangent_unit_ned =
        current_state.orientation_body_to_ned.Rotate(tangent_unit_body);
    // Preserve ProjectAirSim's original linear and angular friction scaling.
    next.linear_velocity_ned_mps =
        next.linear_velocity_ned_mps + tangent_unit_ned * friction_impulse;
    next.angular_velocity_body_radps =
        next.angular_velocity_body_radps +
        radius_cross_tangent * (friction_impulse * inverse_mass);
  }

  next.linear_acceleration_ned_mps2 = {};
  next.angular_acceleration_body_radps2 = {};
  next.position_ned_m = contact.collision_position_ned_m +
                        normal_ned * contact.penetration_depth_m +
                        next.linear_velocity_ned_mps * dt;
  next.orientation_body_to_ned = current_state.orientation_body_to_ned;
  return next;
}

}  // namespace aerodt::digital_twin::simulation::contact
