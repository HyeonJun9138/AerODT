#include "aerodt/digital_twin/simulation/control/simple_flight/simple_flight_parameters.hpp"

#include <cmath>
#include <stdexcept>

namespace aerodt::digital_twin::simulation::control::simple_flight {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kLargePositionLimit = 8.8e26;

PidParameters Pid(double p, double i, double d, double discount = 1.0,
                  double bias = 0.0) {
  return {
      .proportional_gain = p,
      .integral_gain = i,
      .derivative_gain = d,
      .output_bias = bias,
      .integral_discount = discount,
  };
}

CascadeParameters DefaultCascadeParameters() {
  CascadeParameters result;
  result.angle_rate.maximum = {2.5, 2.5, 2.5, 0.0};
  result.angle_rate.pid = {
      Pid(0.25, 0.0, 0.0), Pid(0.25, 0.0, 0.0),
      Pid(0.25, 0.0, 0.0), Pid(1.0, 0.0, 0.0)};

  result.angle_level.maximum = {kPi / 5.5, kPi / 5.5, kPi, 1.0};
  result.angle_level.pid = {
      Pid(2.5, 0.0, 0.0), Pid(2.5, 0.0, 0.0),
      Pid(2.5, 0.0, 0.0), Pid(1.0, 0.0, 0.0)};

  result.position.maximum = {
      kLargePositionLimit, kLargePositionLimit, kLargePositionLimit, 1.0};
  result.position.pid = {
      Pid(0.25, 0.0, 0.0), Pid(0.25, 0.0, 0.0),
      Pid(0.0, 0.0, 0.0), Pid(0.25, 0.0, 0.0)};

  result.velocity.maximum = {6.0, 6.0, 0.0, 6.0};
  result.velocity.pid = {
      Pid(0.2, 0.0, 0.0), Pid(0.2, 0.0, 0.0),
      Pid(0.0, 0.0, 0.0), Pid(2.0, 2.0, 0.0, 0.9999)};
  result.minimum_throttle = 0.3;
  return result;
}

void SetIfPresent(const std::unordered_map<std::string, double>& values,
                  const char* key, double& target) {
  const auto position = values.find(key);
  if (position != values.end()) target = position->second;
}

void SetHorizontalIfPresent(
    const std::unordered_map<std::string, double>& values, const char* key,
    std::array<double, kControlAxisCount>& target) {
  const auto position = values.find(key);
  if (position != values.end()) {
    target[kRollAxis] = position->second;
    target[kPitchAxis] = position->second;
  }
}

void SetHorizontalPidIfPresent(
    const std::unordered_map<std::string, double>& values, const char* key,
    std::array<PidParameters, kControlAxisCount>& target,
    double PidParameters::*member) {
  const auto position = values.find(key);
  if (position != values.end()) {
    target[kRollAxis].*member = position->second;
    target[kPitchAxis].*member = position->second;
  }
}

void SetPidIfPresent(const std::unordered_map<std::string, double>& values,
                     const char* key, PidParameters& target,
                     double PidParameters::*member) {
  const auto position = values.find(key);
  if (position != values.end()) target.*member = position->second;
}

void LoadMultirotorOverrides(
    const std::unordered_map<std::string, double>& values,
    CascadeParameters& target) {
  SetIfPresent(values, "MC_ROLLRATE_MAX", target.angle_rate.maximum[kRollAxis]);
  SetIfPresent(values, "MC_PITCHRATE_MAX", target.angle_rate.maximum[kPitchAxis]);
  SetIfPresent(values, "MC_YAWRATE_MAX", target.angle_rate.maximum[kYawAxis]);
  SetPidIfPresent(values, "MC_ROLLRATE_P", target.angle_rate.pid[kRollAxis],
                  &PidParameters::proportional_gain);
  SetPidIfPresent(values, "MC_ROLLRATE_I", target.angle_rate.pid[kRollAxis],
                  &PidParameters::integral_gain);
  SetPidIfPresent(values, "MC_ROLLRATE_D", target.angle_rate.pid[kRollAxis],
                  &PidParameters::derivative_gain);
  SetPidIfPresent(values, "MC_PITCHRATE_P", target.angle_rate.pid[kPitchAxis],
                  &PidParameters::proportional_gain);
  SetPidIfPresent(values, "MC_PITCHRATE_I", target.angle_rate.pid[kPitchAxis],
                  &PidParameters::integral_gain);
  SetPidIfPresent(values, "MC_PITCHRATE_D", target.angle_rate.pid[kPitchAxis],
                  &PidParameters::derivative_gain);
  SetPidIfPresent(values, "MC_YAWRATE_P", target.angle_rate.pid[kYawAxis],
                  &PidParameters::proportional_gain);
  SetPidIfPresent(values, "MC_YAWRATE_I", target.angle_rate.pid[kYawAxis],
                  &PidParameters::integral_gain);
  SetPidIfPresent(values, "MC_YAWRATE_D", target.angle_rate.pid[kYawAxis],
                  &PidParameters::derivative_gain);

  SetIfPresent(values, "MC_ROLL_MAX", target.angle_level.maximum[kRollAxis]);
  SetIfPresent(values, "MC_PITCH_MAX", target.angle_level.maximum[kPitchAxis]);
  SetIfPresent(values, "MC_YAW_MAX", target.angle_level.maximum[kYawAxis]);
  SetPidIfPresent(values, "MC_ROLL_P", target.angle_level.pid[kRollAxis],
                  &PidParameters::proportional_gain);
  SetPidIfPresent(values, "MC_ROLL_I", target.angle_level.pid[kRollAxis],
                  &PidParameters::integral_gain);
  SetPidIfPresent(values, "MC_ROLL_D", target.angle_level.pid[kRollAxis],
                  &PidParameters::derivative_gain);
  SetPidIfPresent(values, "MC_PITCH_P", target.angle_level.pid[kPitchAxis],
                  &PidParameters::proportional_gain);
  SetPidIfPresent(values, "MC_PITCH_I", target.angle_level.pid[kPitchAxis],
                  &PidParameters::integral_gain);
  SetPidIfPresent(values, "MC_PITCH_D", target.angle_level.pid[kPitchAxis],
                  &PidParameters::derivative_gain);
  SetPidIfPresent(values, "MC_YAW_P", target.angle_level.pid[kYawAxis],
                  &PidParameters::proportional_gain);
  SetPidIfPresent(values, "MC_YAW_I", target.angle_level.pid[kYawAxis],
                  &PidParameters::integral_gain);
  SetPidIfPresent(values, "MC_YAW_D", target.angle_level.pid[kYawAxis],
                  &PidParameters::derivative_gain);

  SetHorizontalPidIfPresent(values, "MPC_XY_P", target.position.pid,
                            &PidParameters::proportional_gain);
  SetHorizontalPidIfPresent(values, "MPC_XY_I", target.position.pid,
                            &PidParameters::integral_gain);
  SetHorizontalPidIfPresent(values, "MPC_XY_D", target.position.pid,
                            &PidParameters::derivative_gain);
  SetPidIfPresent(values, "MPC_Z_P", target.position.pid[kThrottleAxis],
                  &PidParameters::proportional_gain);
  SetPidIfPresent(values, "MPC_Z_I", target.position.pid[kThrottleAxis],
                  &PidParameters::integral_gain);
  SetPidIfPresent(values, "MPC_Z_D", target.position.pid[kThrottleAxis],
                  &PidParameters::derivative_gain);

  SetIfPresent(values, "MPC_MIN_THR", target.minimum_throttle);
  SetHorizontalIfPresent(values, "MPC_XY_VEL_MAX", target.velocity.maximum);
  SetIfPresent(values, "MPC_Z_VEL_MAX", target.velocity.maximum[kThrottleAxis]);
  SetHorizontalPidIfPresent(values, "MPC_XY_VEL_P", target.velocity.pid,
                            &PidParameters::proportional_gain);
  SetHorizontalPidIfPresent(values, "MPC_XY_VEL_I", target.velocity.pid,
                            &PidParameters::integral_gain);
  SetHorizontalPidIfPresent(values, "MPC_XY_VEL_D", target.velocity.pid,
                            &PidParameters::derivative_gain);
  if (const auto it = values.find("MPC_XY_VEL_AW"); it != values.end()) {
    if (it->second != 0.0 && it->second != 1.0)
      throw std::invalid_argument("MPC_XY_VEL_AW must be 0 or 1.");
    target.velocity.pid[kRollAxis].conditional_integration = it->second == 1.0;
    target.velocity.pid[kPitchAxis].conditional_integration = it->second == 1.0;
  }
  SetPidIfPresent(values, "MPC_Z_VEL_P", target.velocity.pid[kThrottleAxis],
                  &PidParameters::proportional_gain);
  SetPidIfPresent(values, "MPC_Z_VEL_I", target.velocity.pid[kThrottleAxis],
                  &PidParameters::integral_gain);
  SetPidIfPresent(values, "MPC_Z_VEL_D", target.velocity.pid[kThrottleAxis],
                  &PidParameters::derivative_gain);
}

void LoadFixedWingOverrides(
    const std::unordered_map<std::string, double>& values,
    CascadeParameters& target) {
  SetIfPresent(values, "FW_R_RMAX", target.angle_rate.maximum[kRollAxis]);
  SetIfPresent(values, "FW_P_RMAX", target.angle_rate.maximum[kPitchAxis]);
  SetIfPresent(values, "FW_Y_RMAX", target.angle_rate.maximum[kYawAxis]);
  const char* rate_keys[3][3] = {
      {"FW_RR_P", "FW_RR_I", "FW_RR_D"},
      {"FW_PR_P", "FW_PR_I", "FW_PR_D"},
      {"FW_YR_P", "FW_YR_I", "FW_YR_D"},
  };
  const char* level_keys[3][3] = {
      {"FW_ROLL_P", "FW_ROLL_I", "FW_ROLL_D"},
      {"FW_PITCH_P", "FW_PITCH_I", "FW_PITCH_D"},
      {"FW_YAW_P", "FW_YAW_I", "FW_YAW_D"},
  };
  double PidParameters::*members[3] = {
      &PidParameters::proportional_gain,
      &PidParameters::integral_gain,
      &PidParameters::derivative_gain,
  };
  for (std::size_t axis = 0; axis < 3; ++axis) {
    for (std::size_t term = 0; term < 3; ++term) {
      SetPidIfPresent(values, rate_keys[axis][term], target.angle_rate.pid[axis],
                      members[term]);
      SetPidIfPresent(values, level_keys[axis][term], target.angle_level.pid[axis],
                      members[term]);
    }
  }

  SetIfPresent(values, "FW_ROLL_MAX", target.angle_level.maximum[kRollAxis]);
  SetIfPresent(values, "FW_PITCH_MAX", target.angle_level.maximum[kPitchAxis]);
  SetIfPresent(values, "FW_YAW_MAX", target.angle_level.maximum[kYawAxis]);

  SetHorizontalPidIfPresent(values, "FW_XY_P", target.position.pid,
                            &PidParameters::proportional_gain);
  SetHorizontalPidIfPresent(values, "FW_XY_I", target.position.pid,
                            &PidParameters::integral_gain);
  SetHorizontalPidIfPresent(values, "FW_XY_D", target.position.pid,
                            &PidParameters::derivative_gain);
  SetPidIfPresent(values, "FW_Z_P", target.position.pid[kThrottleAxis],
                  &PidParameters::proportional_gain);
  SetPidIfPresent(values, "FW_Z_I", target.position.pid[kThrottleAxis],
                  &PidParameters::integral_gain);
  SetPidIfPresent(values, "FW_Z_D", target.position.pid[kThrottleAxis],
                  &PidParameters::derivative_gain);

  SetIfPresent(values, "FW_MIN_THR", target.minimum_throttle);
  SetHorizontalIfPresent(values, "FW_XY_VEL_MAX", target.velocity.maximum);
  SetIfPresent(values, "FW_Z_VEL_MAX", target.velocity.maximum[kThrottleAxis]);
  SetHorizontalPidIfPresent(values, "FW_XY_VEL_P", target.velocity.pid,
                            &PidParameters::proportional_gain);
  SetHorizontalPidIfPresent(values, "FW_XY_VEL_I", target.velocity.pid,
                            &PidParameters::integral_gain);
  SetHorizontalPidIfPresent(values, "FW_XY_VEL_D", target.velocity.pid,
                            &PidParameters::derivative_gain);
  SetPidIfPresent(values, "FW_Z_VEL_P", target.velocity.pid[kThrottleAxis],
                  &PidParameters::proportional_gain);
  SetPidIfPresent(values, "FW_Z_VEL_I", target.velocity.pid[kThrottleAxis],
                  &PidParameters::integral_gain);
  SetPidIfPresent(values, "FW_Z_VEL_D", target.velocity.pid[kThrottleAxis],
                  &PidParameters::derivative_gain);
}

void Validate(const CascadeParameters& parameters) {
  if (!std::isfinite(parameters.minimum_throttle) ||
      parameters.minimum_throttle < 0.0 || parameters.minimum_throttle > 1.0) {
    throw std::invalid_argument("SimpleFlight minimum throttle must be in [0, 1].");
  }
  const AxisPidGroup* groups[] = {
      &parameters.angle_rate, &parameters.angle_level,
      &parameters.position, &parameters.velocity};
  for (const auto* group : groups) {
    for (std::size_t axis = 0; axis < kControlAxisCount; ++axis) {
      if (!std::isfinite(group->maximum[axis]) || group->maximum[axis] < 0.0) {
        throw std::invalid_argument("SimpleFlight axis limit must be finite and non-negative.");
      }
      static_cast<void>(PidController(group->pid[axis]));
    }
  }
}

}  // namespace

SimpleFlightParameters LoadSimpleFlightParameters(
    const std::unordered_map<std::string, double>& source_parameters,
    bool fixed_wing_capable) {
  SimpleFlightParameters result;
  auto& manual = result.manual_vertical;
  SetIfPresent(source_parameters, "MANUAL_Z_VEL_P", manual.velocity_p);
  SetIfPresent(source_parameters, "MANUAL_Z_VEL_I", manual.velocity_i);
  SetIfPresent(source_parameters, "MANUAL_Z_POS_P", manual.position_p);
  SetIfPresent(source_parameters, "MANUAL_Z_ACCEL_MAX", manual.acceleration_limit);
  SetIfPresent(source_parameters, "MANUAL_Z_COMMAND_ACCEL", manual.command_acceleration);
  SetIfPresent(source_parameters, "MANUAL_Z_CLIMB_SPEED", manual.climb_speed);
  SetIfPresent(source_parameters, "MANUAL_Z_DESCENT_SPEED", manual.descent_speed);
  for(double value : {manual.velocity_p, manual.velocity_i, manual.position_p,
                      manual.acceleration_limit, manual.command_acceleration,
                      manual.climb_speed, manual.descent_speed}) {
    if(!std::isfinite(value) || value < 0)
      throw std::invalid_argument("Manual vertical parameters must be finite and non-negative.");
  }
  if(manual.velocity_p>0 && (manual.position_p<=0 || manual.acceleration_limit<=0 ||
      manual.command_acceleration<=0 || manual.climb_speed<=0 || manual.descent_speed<=0))
    throw std::invalid_argument("Enabled manual vertical assistance requires positive limits and position gain.");
  result.multirotor = DefaultCascadeParameters();
  result.fixed_wing = DefaultCascadeParameters();
  result.fixed_wing_minimum_pitch_rad = kPi / 10.0;
  result.fixed_wing_capable = fixed_wing_capable;

  LoadMultirotorOverrides(source_parameters, result.multirotor);
  LoadFixedWingOverrides(source_parameters, result.fixed_wing);
  SetIfPresent(source_parameters, "FW_AIRSPD_STALL",
               result.fixed_wing_stall_speed_mps);
  SetIfPresent(source_parameters, "FW_AIRSPD_FWD",
               result.fixed_wing_forward_speed_mps);
  SetIfPresent(source_parameters, "FW_PITCH_MIN",
               result.fixed_wing_minimum_pitch_rad);
  SetIfPresent(source_parameters, "MC_TILT_ASSIST_MAX", result.rotor_assist_maximum_rad);
  SetIfPresent(source_parameters, "MC_TILT_ASSIST_RATE", result.rotor_assist_rate_radps);

  Validate(result.multirotor);
  Validate(result.fixed_wing);
  if (!std::isfinite(result.fixed_wing_stall_speed_mps) ||
      result.fixed_wing_stall_speed_mps < 0.0 ||
      !std::isfinite(result.fixed_wing_forward_speed_mps) ||
      result.fixed_wing_forward_speed_mps < 0.0 ||
      !std::isfinite(result.fixed_wing_minimum_pitch_rad)) {
    throw std::invalid_argument("SimpleFlight fixed-wing parameters are invalid.");
  }
  return result;
}

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
