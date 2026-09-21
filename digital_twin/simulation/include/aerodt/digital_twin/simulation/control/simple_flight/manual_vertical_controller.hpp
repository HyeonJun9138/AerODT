#pragma once

#include <algorithm>
#include <cmath>
#include "aerodt/digital_twin/simulation/control/simple_flight/simple_flight_parameters.hpp"

namespace aerodt::digital_twin::simulation::control::simple_flight {

// Controller memory only: reads runtime observations and returns thrust intent.
// Neutral first brakes vertical motion, then captures the settled altitude.
class ManualVerticalController {
 public:
  void Reset() { active_=false; holding_=false; integral_=0; }

  double Update(double desired_down_speed, bool neutral, double down,
                double down_speed, double vertical_fraction, double hover,
                double gravity, double step, const ManualVerticalParameters& p) {
    if(!active_) { commanded_speed_=down_speed; active_=true; }
    if(!neutral) holding_=false;
    if(neutral && !holding_ && std::abs(commanded_speed_)<.01 && std::abs(down_speed)<.1) {
      hold_down_=down; holding_=true;
    }
    if(holding_) desired_down_speed=std::clamp((hold_down_-down)*p.position_p,
                                             -p.climb_speed,p.descent_speed);
    commanded_speed_+=std::clamp(desired_down_speed-commanded_speed_,
                                -p.command_acceleration*step,p.command_acceleration*step);
    const double error=commanded_speed_-down_speed;
    const double candidate=std::clamp(integral_+error*p.velocity_i*step,
                                      -p.acceleration_limit,p.acceleration_limit);
    const double acceleration=std::clamp(error*p.velocity_p+candidate,
                                         -p.acceleration_limit,p.acceleration_limit);
    const double unsaturated=hover*(1-acceleration/gravity)/std::max(.5,vertical_fraction);
    // Do not wind up at acceleration or collective limits.
    if((error<=0 || (error*p.velocity_p+candidate<p.acceleration_limit && unsaturated>.02)) &&
       (error>=0 || (error*p.velocity_p+candidate>-p.acceleration_limit && unsaturated<.35)))
      integral_=candidate;
    return std::clamp(unsaturated,.02,.35);
  }
 private:
  bool active_{},holding_{};
  double commanded_speed_{},hold_down_{},integral_{};
};
}  // namespace aerodt::digital_twin::simulation::control::simple_flight
