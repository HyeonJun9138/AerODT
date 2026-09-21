#pragma once

#include <cmath>

namespace aerodt::foundation::math {

struct Vector3 {
  double x{};
  double y{};
  double z{};

  [[nodiscard]] constexpr Vector3 operator+(const Vector3& other) const noexcept {
    return {x + other.x, y + other.y, z + other.z};
  }

  [[nodiscard]] constexpr Vector3 operator-(const Vector3& other) const noexcept {
    return {x - other.x, y - other.y, z - other.z};
  }

  [[nodiscard]] constexpr Vector3 operator*(double scalar) const noexcept {
    return {x * scalar, y * scalar, z * scalar};
  }

  [[nodiscard]] constexpr Vector3 operator/(double scalar) const noexcept {
    return {x / scalar, y / scalar, z / scalar};
  }

  [[nodiscard]] constexpr double Dot(const Vector3& other) const noexcept {
    return x * other.x + y * other.y + z * other.z;
  }

  [[nodiscard]] constexpr Vector3 Cross(const Vector3& other) const noexcept {
    return {
        y * other.z - z * other.y,
        z * other.x - x * other.z,
        x * other.y - y * other.x,
    };
  }

  [[nodiscard]] constexpr double NormSquared() const noexcept { return Dot(*this); }
  [[nodiscard]] double Norm() const noexcept { return std::sqrt(NormSquared()); }
  [[nodiscard]] bool IsFinite() const noexcept {
    return std::isfinite(x) && std::isfinite(y) && std::isfinite(z);
  }
};

[[nodiscard]] constexpr Vector3 operator*(double scalar, const Vector3& value) noexcept {
  return value * scalar;
}

}  // namespace aerodt::foundation::math
