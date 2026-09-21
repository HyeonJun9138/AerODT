#pragma once

#include <array>
#include <cmath>
#include <stdexcept>

#include "aerodt/foundation/math/vector3.hpp"

namespace aerodt::foundation::math {

struct Matrix3 {
  std::array<double, 9> values{};

  [[nodiscard]] static constexpr Matrix3 Identity() noexcept {
    return {{{1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0}}};
  }

  [[nodiscard]] static constexpr Matrix3 Diagonal(
      double xx, double yy, double zz) noexcept {
    return {{{xx, 0.0, 0.0, 0.0, yy, 0.0, 0.0, 0.0, zz}}};
  }

  [[nodiscard]] constexpr double operator()(int row, int column) const noexcept {
    return values[static_cast<std::size_t>(row * 3 + column)];
  }

  [[nodiscard]] constexpr Vector3 operator*(const Vector3& vector) const noexcept {
    return {
        (*this)(0, 0) * vector.x + (*this)(0, 1) * vector.y + (*this)(0, 2) * vector.z,
        (*this)(1, 0) * vector.x + (*this)(1, 1) * vector.y + (*this)(1, 2) * vector.z,
        (*this)(2, 0) * vector.x + (*this)(2, 1) * vector.y + (*this)(2, 2) * vector.z,
    };
  }

  [[nodiscard]] double Determinant() const noexcept {
    return (*this)(0, 0) * ((*this)(1, 1) * (*this)(2, 2) - (*this)(1, 2) * (*this)(2, 1))
         - (*this)(0, 1) * ((*this)(1, 0) * (*this)(2, 2) - (*this)(1, 2) * (*this)(2, 0))
         + (*this)(0, 2) * ((*this)(1, 0) * (*this)(2, 1) - (*this)(1, 1) * (*this)(2, 0));
  }

  [[nodiscard]] Matrix3 Inverse() const {
    const double determinant = Determinant();
    if (std::abs(determinant) <= 1e-12) {
      throw std::invalid_argument("Inertia matrix must be invertible.");
    }
    const double inverse = 1.0 / determinant;
    return {{{
        ((*this)(1, 1) * (*this)(2, 2) - (*this)(1, 2) * (*this)(2, 1)) * inverse,
        ((*this)(0, 2) * (*this)(2, 1) - (*this)(0, 1) * (*this)(2, 2)) * inverse,
        ((*this)(0, 1) * (*this)(1, 2) - (*this)(0, 2) * (*this)(1, 1)) * inverse,
        ((*this)(1, 2) * (*this)(2, 0) - (*this)(1, 0) * (*this)(2, 2)) * inverse,
        ((*this)(0, 0) * (*this)(2, 2) - (*this)(0, 2) * (*this)(2, 0)) * inverse,
        ((*this)(0, 2) * (*this)(1, 0) - (*this)(0, 0) * (*this)(1, 2)) * inverse,
        ((*this)(1, 0) * (*this)(2, 1) - (*this)(1, 1) * (*this)(2, 0)) * inverse,
        ((*this)(0, 1) * (*this)(2, 0) - (*this)(0, 0) * (*this)(2, 1)) * inverse,
        ((*this)(0, 0) * (*this)(1, 1) - (*this)(0, 1) * (*this)(1, 0)) * inverse,
    }}};
  }
};

}  // namespace aerodt::foundation::math
