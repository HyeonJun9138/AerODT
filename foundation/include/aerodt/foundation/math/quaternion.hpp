#pragma once

#include <cmath>
#include <stdexcept>

#include "aerodt/foundation/math/vector3.hpp"

namespace aerodt::foundation::math {

struct Quaternion {
  double w{1.0};
  double x{};
  double y{};
  double z{};

  [[nodiscard]] constexpr Quaternion operator*(const Quaternion& other) const noexcept {
    return {
        w * other.w - x * other.x - y * other.y - z * other.z,
        w * other.x + x * other.w + y * other.z - z * other.y,
        w * other.y - x * other.z + y * other.w + z * other.x,
        w * other.z + x * other.y - y * other.x + z * other.w,
    };
  }

  [[nodiscard]] Quaternion Normalized() const {
    const double norm = std::sqrt(w * w + x * x + y * y + z * z);
    if (norm <= 1e-15) {
      throw std::invalid_argument("Quaternion norm must be non-zero.");
    }
    return {w / norm, x / norm, y / norm, z / norm};
  }

  [[nodiscard]] constexpr Quaternion Conjugate() const noexcept {
    return {w, -x, -y, -z};
  }

  [[nodiscard]] Vector3 Rotate(const Vector3& vector) const {
    const Quaternion unit = Normalized();
    const Quaternion pure{0.0, vector.x, vector.y, vector.z};
    const Quaternion rotated = unit * pure * unit.Conjugate();
    return {rotated.x, rotated.y, rotated.z};
  }

  [[nodiscard]] bool IsFinite() const noexcept {
    return std::isfinite(w) && std::isfinite(x) && std::isfinite(y) && std::isfinite(z);
  }

  [[nodiscard]] static Quaternion FromAxisAngle(
      const Vector3& unit_axis, double angle_rad) noexcept {
    const double half_angle = angle_rad * 0.5;
    const double sine = std::sin(half_angle);
    return {std::cos(half_angle), unit_axis.x * sine, unit_axis.y * sine, unit_axis.z * sine};
  }

  // Body-to-NED rotation from roll, pitch and yaw applied in ZYX order: the
  // inverse of the roll/pitch/yaw read back by the SimpleFlight ground-truth
  // estimator, and the same formula the model package compiler uses.
  [[nodiscard]] static Quaternion FromRollPitchYaw(
      double roll_rad, double pitch_rad, double yaw_rad) noexcept {
    const double cr = std::cos(roll_rad * 0.5), sr = std::sin(roll_rad * 0.5);
    const double cp = std::cos(pitch_rad * 0.5), sp = std::sin(pitch_rad * 0.5);
    const double cy = std::cos(yaw_rad * 0.5), sy = std::sin(yaw_rad * 0.5);
    return {cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy,
            cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy};
  }
};

}  // namespace aerodt::foundation::math
