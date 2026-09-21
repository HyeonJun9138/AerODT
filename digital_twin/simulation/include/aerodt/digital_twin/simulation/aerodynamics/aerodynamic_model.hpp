#pragma once

#include <vector>

#include "aerodt/digital_twin/contracts/wrench.hpp"
#include "aerodt/foundation/math/quaternion.hpp"

namespace aerodt::digital_twin::simulation::aerodynamics {

struct AerodynamicEnvironment {
  double air_density_kgpm3{1.225};
  foundation::math::Vector3 wind_velocity_ned_mps{};
};

// One outward-facing side of the vehicle's equivalent drag body.
struct DragFace {
  foundation::math::Vector3 position_body_m{};
  foundation::math::Vector3 outward_normal_body{};
  double area_m2{};
  // ProjectAirSim convention: drag_factor = 0.5 * drag coefficient.
  double drag_factor{};
};

struct LiftDragParameters {
  double alpha_zero_rad{};
  double alpha_stall_rad{};
  double lift_slope_per_rad{};
  double lift_stall_slope_per_rad{};
  double drag_slope_per_rad{};
  double drag_stall_slope_per_rad{};
  double moment_slope_per_rad{};
  double moment_stall_slope_per_rad{};
  double area_m2{};
  double control_lift_per_rad{};
  double control_drag_per_rad{};
  double control_moment_per_rad{};
  foundation::math::Vector3 center_of_pressure_surface_m{};
  foundation::math::Vector3 forward_surface{1.0, 0.0, 0.0};
  foundation::math::Vector3 upward_surface{0.0, 0.0, -1.0};
};

struct LiftingSurface {
  foundation::math::Vector3 origin_body_m{};
  foundation::math::Quaternion orientation_surface_to_body{};
  LiftDragParameters parameters{};
  double control_angle_rad{};
};

// Reproduces ProjectAirSim FastPhysics' six-face body-drag calculation.
[[nodiscard]] contracts::Wrench CalculateDragFaceWrench(
    const foundation::math::Vector3& average_linear_velocity_ned_mps,
    const std::vector<DragFace>& drag_faces,
    const foundation::math::Quaternion& orientation_body_to_ned,
    const AerodynamicEnvironment& environment);

// Reproduces ProjectAirSim FastPhysics' piecewise-linear wing lift/drag model.
[[nodiscard]] contracts::Wrench CalculateLiftDragWrench(
    const std::vector<LiftingSurface>& surfaces,
    const foundation::math::Quaternion& orientation_body_to_ned,
    const foundation::math::Vector3& body_velocity_ned_mps,
    const AerodynamicEnvironment& environment);

}  // namespace aerodt::digital_twin::simulation::aerodynamics
