#pragma once

#include "aerodt/foundation/math/vector3.hpp"

namespace aerodt::digital_twin::contracts {

struct Wrench {
  foundation::math::Vector3 force_ned_n{};
  foundation::math::Vector3 torque_body_nm{};
};

}  // namespace aerodt::digital_twin::contracts
