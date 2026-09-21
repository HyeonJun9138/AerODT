#include "aerodt/digital_twin/simulation/aerodynamics/aerodynamic_model.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>
#include <stdexcept>

namespace aerodt::digital_twin::simulation::aerodynamics {
namespace {

using contracts::Wrench;
using foundation::math::Quaternion;
using foundation::math::Vector3;

constexpr double kMinimumAerodynamicSpeedMps = 0.1;
constexpr double kDirectionTolerance = 1e-12;

Vector3 NormalizeOrZero(const Vector3& value) {
  const double norm = value.Norm();
  return norm > kDirectionTolerance ? value / norm : Vector3{};
}

double PiecewiseCoefficient(double alpha, double stall_alpha, double base_slope,
                            double stall_slope) {
  if (alpha > stall_alpha) {
    return std::max(base_slope * stall_alpha + stall_slope * (alpha - stall_alpha), 0.0);
  }
  if (alpha < -stall_alpha) {
    return std::min(-base_slope * stall_alpha + stall_slope * (alpha + stall_alpha), 0.0);
  }
  return base_slope * alpha;
}

void ValidateEnvironment(const AerodynamicEnvironment& environment) {
  if (!std::isfinite(environment.air_density_kgpm3) || environment.air_density_kgpm3 < 0.0 ||
      !environment.wind_velocity_ned_mps.IsFinite()) {
    throw std::invalid_argument("Aerodynamic environment must be finite and non-negative.");
  }
}

void ValidateDirection(const Vector3& direction, const char* name) {
  if (!direction.IsFinite() || direction.Norm() <= kDirectionTolerance) {
    throw std::invalid_argument(name);
  }
}

}  // namespace

Wrench CalculateDragFaceWrench(const Vector3& average_linear_velocity_ned_mps,
                               const std::vector<DragFace>& drag_faces,
                               const Quaternion& orientation_body_to_ned,
                               const AerodynamicEnvironment& environment) {
  ValidateEnvironment(environment);
  if (!average_linear_velocity_ned_mps.IsFinite() || !orientation_body_to_ned.IsFinite()) {
    throw std::invalid_argument("Drag inputs must be finite.");
  }

  const Vector3 relative_velocity_ned =
      average_linear_velocity_ned_mps - environment.wind_velocity_ned_mps;
  const Vector3 relative_velocity_body =
      orientation_body_to_ned.Conjugate().Rotate(relative_velocity_ned);
  const Vector3 drag_direction_body = NormalizeOrZero(relative_velocity_body) * -1.0;

  Vector3 force_body{};
  for (const DragFace& face : drag_faces) {
    ValidateDirection(face.outward_normal_body, "Drag face normal must be finite and non-zero.");
    if (!face.position_body_m.IsFinite() || !std::isfinite(face.area_m2) || face.area_m2 < 0.0 ||
        !std::isfinite(face.drag_factor) || face.drag_factor < 0.0) {
      throw std::invalid_argument("Drag face parameters must be finite and non-negative.");
    }

    const Vector3 normal = NormalizeOrZero(face.outward_normal_body);
    const double normal_speed = normal.Dot(relative_velocity_body);
    if (normal_speed > kMinimumAerodynamicSpeedMps) {
      const double magnitude =
          face.drag_factor * face.area_m2 * environment.air_density_kgpm3 *
          normal_speed * normal_speed;
      force_body = force_body + drag_direction_body * magnitude;
    }
  }

  return {.force_ned_n = orientation_body_to_ned.Rotate(force_body), .torque_body_nm = {}};
}

Wrench CalculateLiftDragWrench(const std::vector<LiftingSurface>& surfaces,
                               const Quaternion& orientation_body_to_ned,
                               const Vector3& body_velocity_ned_mps,
                               const AerodynamicEnvironment& environment) {
  ValidateEnvironment(environment);
  if (!body_velocity_ned_mps.IsFinite() || !orientation_body_to_ned.IsFinite()) {
    throw std::invalid_argument("Lift-drag inputs must be finite.");
  }

  Wrench result{};
  const Vector3 relative_velocity_ned = body_velocity_ned_mps - environment.wind_velocity_ned_mps;
  if (relative_velocity_ned.Norm() <= kMinimumAerodynamicSpeedMps) return result;

  for (const LiftingSurface& surface : surfaces) {
    const LiftDragParameters& parameters = surface.parameters;
    ValidateDirection(parameters.forward_surface,
                      "Lifting-surface forward direction must be finite and non-zero.");
    ValidateDirection(parameters.upward_surface,
                      "Lifting-surface upward direction must be finite and non-zero.");
    if (!surface.origin_body_m.IsFinite() || !surface.orientation_surface_to_body.IsFinite() ||
        !parameters.center_of_pressure_surface_m.IsFinite() ||
        !std::isfinite(parameters.area_m2) || parameters.area_m2 < 0.0 ||
        !std::isfinite(parameters.alpha_stall_rad) || parameters.alpha_stall_rad < 0.0 ||
        !std::isfinite(surface.control_angle_rad)) {
      throw std::invalid_argument("Lifting-surface parameters must be finite and valid.");
    }

    const Quaternion orientation_surface_to_ned =
        (orientation_body_to_ned * surface.orientation_surface_to_body).Normalized();
    const Vector3 forward_ned =
        NormalizeOrZero(orientation_surface_to_ned.Rotate(parameters.forward_surface));
    if (forward_ned.Dot(relative_velocity_ned) <= 0.0) continue;

    const Vector3 upward_ned =
        NormalizeOrZero(orientation_surface_to_ned.Rotate(parameters.upward_surface));
    const Vector3 plane_normal_ned = NormalizeOrZero(forward_ned.Cross(upward_ned));
    if (plane_normal_ned.Norm() <= kDirectionTolerance) {
      throw std::invalid_argument("Lifting-surface forward and upward directions must not align.");
    }

    const Vector3 velocity_in_plane =
        relative_velocity_ned - plane_normal_ned * relative_velocity_ned.Dot(plane_normal_ned);
    const double speed_in_plane = velocity_in_plane.Norm();
    if (speed_in_plane <= kMinimumAerodynamicSpeedMps) continue;

    const Vector3 lift_direction_ned =
        NormalizeOrZero(plane_normal_ned.Cross(velocity_in_plane));
    const Vector3 drag_direction_ned = NormalizeOrZero(velocity_in_plane) * -1.0;
    const double cos_alpha = std::clamp(lift_direction_ned.Dot(upward_ned), -1.0, 1.0);
    double alpha = parameters.alpha_zero_rad +
                   (lift_direction_ned.Dot(forward_ned) >= 0.0 ? std::acos(cos_alpha)
                                                               : -std::acos(cos_alpha));
    while (std::abs(alpha) > 0.5 * std::numbers::pi) {
      alpha += alpha > 0.0 ? -std::numbers::pi : std::numbers::pi;
    }

    const double dynamic_pressure =
        0.5 * environment.air_density_kgpm3 * speed_in_plane * speed_in_plane;
    double lift_coefficient =
        PiecewiseCoefficient(alpha, parameters.alpha_stall_rad, parameters.lift_slope_per_rad,
                             parameters.lift_stall_slope_per_rad);
    lift_coefficient += parameters.control_lift_per_rad * surface.control_angle_rad;

    double drag_coefficient =
        std::abs(PiecewiseCoefficient(alpha, parameters.alpha_stall_rad,
                                      parameters.drag_slope_per_rad,
                                      parameters.drag_stall_slope_per_rad));
    drag_coefficient +=
        std::abs(parameters.control_drag_per_rad * surface.control_angle_rad);

    double moment_coefficient =
        PiecewiseCoefficient(alpha, parameters.alpha_stall_rad,
                             parameters.moment_slope_per_rad,
                             parameters.moment_stall_slope_per_rad);
    moment_coefficient += parameters.control_moment_per_rad * surface.control_angle_rad;

    const Vector3 lift_ned =
        lift_direction_ned * (lift_coefficient * dynamic_pressure * parameters.area_m2);
    const Vector3 drag_ned =
        drag_direction_ned * (drag_coefficient * dynamic_pressure * parameters.area_m2);
    const Vector3 total_force_ned = lift_ned + drag_ned;

    const Vector3 moment_ned =
        plane_normal_ned * (moment_coefficient * dynamic_pressure * parameters.area_m2);
    const Vector3 moment_body = orientation_body_to_ned.Conjugate().Rotate(moment_ned);
    const Vector3 force_body = orientation_body_to_ned.Conjugate().Rotate(total_force_ned);
    const Vector3 center_of_pressure_body =
        surface.origin_body_m +
        surface.orientation_surface_to_body.Rotate(parameters.center_of_pressure_surface_m);

    result.force_ned_n = result.force_ned_n + total_force_ned;
    result.torque_body_nm = result.torque_body_nm + center_of_pressure_body.Cross(force_body) +
                            moment_body;
  }

  if (!result.force_ned_n.IsFinite() || !result.torque_body_nm.IsFinite()) {
    throw std::runtime_error("Aerodynamic model produced a non-finite wrench.");
  }
  return result;
}

}  // namespace aerodt::digital_twin::simulation::aerodynamics
