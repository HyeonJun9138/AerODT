// Flies a planned route with the native UAM stack -- FastPhysics for the
// dynamics and SimpleFlight's tiltrotor cascade for the controller -- and
// reports what the aircraft actually did, one line per physics tick.
//
// The web dashboard plans a flight in latitude and longitude; this runs the
// airborne part of it in the local north-east-down frame the simulation works
// in and hands the states back. That frame is anchored where the flight
// begins: the aircraft's own starting position is the origin, so a waypoint
// 30 metres up is 30 metres above the deck it lifted off, whatever height the
// vehicle configuration happens to spawn its body at. Everything crossing the process boundary is
// plain numbers, so neither side needs a JSON library and the protocol is
// readable in a terminal.
//
// The application RoutePilot emits typed goals from this aircraft's observation.
// This executable only adapts stdin/stdout, contact and runtime ticks. Physical
// state remains owned by UamVehicleRuntime, never by the pilot or the display.
//
//   input  (stdin)
//     step <seconds>                     physics step, optional
//     emit <seconds>                     report at most this often, optional
//     capture <metres>                   how near counts as reached
//     smooth_flight <0|1>                optional bounded guidance, default 0
//     timeout <seconds>                  give up after this much simulated time
//     waypoint <north_m> <east_m> <down_m> <speed_mps> <fixed_wing 0|1> <capture_m>
//     ...
//     run
//
//   output (stdout)
//     state <t> <n> <e> <d> <vn> <ve> <vd> <yaw_deg> <pitch_deg> <roll_deg>
//           <tilt_deg> <blend> <speed_mps> <grounded> <waypoint_index> <rotor_radps>
//     done <reached> <total> <elapsed_s>
//     error <reason>
#include "surface_telemetry.hpp"
#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdio>
#include <iomanip>
#include <iostream>
#include <numeric>
#include <sstream>
#include <string>
#include <vector>
#include <type_traits>
#include "aerodt/user_application/uam_mission/route_pilot.hpp"

#include "aerodt/digital_twin/runtime/uam_vehicle_runtime.hpp"
#include "aerodt/digital_twin/simulation/environment/flat_ground_contact_model.hpp"

namespace {

using aerodt::digital_twin::contracts::ContactObservation;
using aerodt::digital_twin::contracts::VehicleState;
using aerodt::digital_twin::runtime::LoadAeroDTAirTaxiRuntimeConfig;
using aerodt::digital_twin::runtime::UamVehicleRuntime;
using aerodt::digital_twin::simulation::environment::FlatGroundContactModel;
using aerodt::digital_twin::simulation::control::simple_flight::PositionYawRateGoalNed;
using aerodt::digital_twin::simulation::control::simple_flight::VelocityYawAngleGoalNed;
using aerodt::foundation::math::Vector3;

using aerodt::user_application::uam_mission::RoutePilot;
using aerodt::user_application::uam_mission::GroundThrottleGoal;
using Waypoint = aerodt::user_application::uam_mission::RouteWaypoint;
constexpr double kGroundIdleThrottle = 0.08;

struct Options {
  double step_seconds{};          // zero: the vehicle configuration's own step
  // How often a state is reported. The physics steps far faster than any
  // reader needs, so reporting every tick would send tens of megabytes to say
  // what a few thousand lines already say. Zero reports every tick.
  double emit_seconds{};
  double capture_m{40.0};
  double timeout_seconds{1800.0};
  double initial_yaw_deg{0.0};
  bool smooth_flight{false};
  std::optional<double> landing_yaw_deg;
  std::vector<Waypoint> waypoints;
};

[[nodiscard]] double Length(const Vector3& value) {
  return std::sqrt(value.x * value.x + value.y * value.y + value.z * value.z);
}

// Yaw, pitch and roll of a body-to-NED quaternion, in degrees.
struct Attitude {
  double yaw_deg{};
  double pitch_deg{};
  double roll_deg{};
};

[[nodiscard]] Attitude AttitudeOf(const aerodt::foundation::math::Quaternion& q) {
  const double sin_pitch = std::clamp(2.0 * (q.w * q.y - q.z * q.x), -1.0, 1.0);
  const double degrees = 180.0 / 3.14159265358979323846;
  return {
      .yaw_deg = std::atan2(2.0 * (q.w * q.z + q.x * q.y),
                            1.0 - 2.0 * (q.y * q.y + q.z * q.z)) * degrees,
      .pitch_deg = std::asin(sin_pitch) * degrees,
      .roll_deg = std::atan2(2.0 * (q.w * q.x + q.y * q.z),
                             1.0 - 2.0 * (q.x * q.x + q.y * q.y)) * degrees,
  };
}

Options ReadOptions(std::istream& input) {
  Options options;
  std::string line;
  bool first = true;
  while (std::getline(input, line)) {
    // A byte order mark at the head of the stream is not a keyword. Whoever
    // wrote the input may not have had a say in it, so it is skipped rather
    // than reported as a mistake in the plan.
    if (first) {
      first = false;
      if (line.rfind("\xEF\xBB\xBF", 0) == 0) {
        line.erase(0, 3);
      }
    }
    if (!line.empty() && line.back() == '\r') {
      line.pop_back();
    }
    std::istringstream fields(line);
    std::string keyword;
    if (!(fields >> keyword) || keyword.empty() || keyword[0] == '#') {
      continue;
    }
    if (keyword == "run") {
      break;
    }
    if (keyword == "step") {
      fields >> options.step_seconds;
    } else if (keyword == "emit") {
      fields >> options.emit_seconds;
    } else if (keyword == "capture") {
      fields >> options.capture_m;
    } else if (keyword == "timeout") {
      fields >> options.timeout_seconds;
    } else if (keyword == "initial_yaw") {
      if (!(fields >> options.initial_yaw_deg) || !std::isfinite(options.initial_yaw_deg)) {
        throw std::invalid_argument("initial_yaw must be finite degrees");
      }
    } else if (keyword == "landing_yaw") {
      double degrees = 0.0;
      if (!(fields >> degrees) || !std::isfinite(degrees)) {
        throw std::invalid_argument("landing_yaw must be finite degrees");
      }
      options.landing_yaw_deg = degrees;
    } else if (keyword == "smooth_flight") {
      int enabled = 0;
      if (!(fields >> enabled) || (enabled != 0 && enabled != 1)) {
        throw std::invalid_argument("smooth_flight must be 0 or 1");
      }
      options.smooth_flight = enabled != 0;
    } else if (keyword == "waypoint") {
      Waypoint point;
      int fixed_wing = 0;
      double capture = 0.0;
      fields >> point.position_ned_m.x >> point.position_ned_m.y >> point.position_ned_m.z
          >> point.speed_mps >> fixed_wing >> capture;
      point.fixed_wing = fixed_wing != 0;
      point.capture_m = capture > 0.0 ? capture : options.capture_m;
      options.waypoints.push_back(point);
    } else {
      throw std::invalid_argument("unknown keyword: " + keyword);
    }
  }
  if (options.waypoints.empty()) {
    throw std::invalid_argument("no waypoints given");
  }
  if (!(options.timeout_seconds > 0.0)) {
    throw std::invalid_argument("timeout must be greater than zero");
  }
  return options;
}

// The rotor actuators' own turning speed, averaged. What the mixer commanded
// and the actuators reached, so a display can turn the propellers at the speed
// the aircraft is really turning them rather than at an invented one.
[[nodiscard]] double RotorSpeedRadps(const aerodt::digital_twin::runtime::UamTickResult& tick) {
  if (tick.rotors.empty()) {
    return 0.0;
  }
  const double total = std::accumulate(
      tick.rotors.begin(), tick.rotors.end(), 0.0,
      [](double sum, const auto& rotor) { return sum + rotor.value.rotating_speed_radps; });
  return total / static_cast<double>(tick.rotors.size());
}

// The tilt actuators' own angle, averaged over the rotors that have one. This
// is what the mixer commanded and the actuator reached, not a stage's nominal.
[[nodiscard]] double TiltDegrees(const aerodt::digital_twin::runtime::UamTickResult& tick) {
  if (tick.tilts.empty()) {
    return 0.0;
  }
  const double total = std::accumulate(
      tick.tilts.begin(), tick.tilts.end(), 0.0,
      [](double sum, const auto& tilt) { return sum + tilt.value.angle_rad; });
  return total / static_cast<double>(tick.tilts.size()) * (180.0 / 3.14159265358979323846);
}

void WriteState(const VehicleState& state, const Vector3& origin_ned_m, double tilt_deg,
                double blend, bool grounded, std::size_t waypoint_index,
                double rotor_radps = 0.0, const SurfaceTelemetry& surfaces = {}) {
  const auto attitude = AttitudeOf(state.orientation_body_to_ned);
  const double speed = Length(state.linear_velocity_ned_mps);
  const Vector3 place = state.position_ned_m - origin_ned_m;
  std::cout << "state " << std::fixed << std::setprecision(4)
            << std::chrono::duration<double>(state.time.elapsed).count() << ' '
            << place.x << ' ' << place.y << ' ' << place.z << ' '
            << state.linear_velocity_ned_mps.x << ' ' << state.linear_velocity_ned_mps.y << ' '
            << state.linear_velocity_ned_mps.z << ' '
            << attitude.yaw_deg << ' ' << attitude.pitch_deg << ' ' << attitude.roll_deg << ' '
            << tilt_deg << ' ' << blend << ' ' << speed << ' '
            << (grounded ? 1 : 0) << ' ' << waypoint_index << ' ' << rotor_radps;
  if(surfaces.valid)for(double angle:surfaces.degrees)std::cout << ' ' << angle;
  std::cout << '\n';
}

}  // namespace

int main() {
  try {
    std::ios::sync_with_stdio(false);
    Options options = ReadOptions(std::cin);
    auto config = LoadAeroDTAirTaxiRuntimeConfig();
    if (options.step_seconds > 0.0) {
      config.step = std::chrono::duration_cast<std::chrono::nanoseconds>(
          std::chrono::duration<double>(options.step_seconds));
    }
    const double step_seconds =
        std::chrono::duration<double>(config.step).count();
    const double half_yaw = options.initial_yaw_deg * 3.14159265358979323846 / 360.0;
    config.initial_orientation_body_to_ned = {.w = std::cos(half_yaw), .x = 0.0,
                                             .y = 0.0, .z = std::sin(half_yaw)};
    if (options.smooth_flight) {
      config.simple_flight.transition_duration = std::chrono::seconds(12);
      config.initial_position_ned_m.z = -config.body_ground_clearance_m;
      config.simple_flight.startup_initial_throttle = kGroundIdleThrottle;
      config.simple_flight.startup_ramp = std::chrono::seconds(4);
    }
    UamVehicleRuntime runtime(std::move(config));
    FlatGroundContactModel flat_ground({
        .ground_plane_down_m = 0.0,
        .body_ground_clearance_m = runtime.Config().body_ground_clearance_m,
    });
    ContactObservation contact = options.smooth_flight ? flat_ground.Observe(runtime.State()) : ContactObservation{};
    VehicleState state = runtime.State();
    // Where the flight begins is the origin every waypoint is measured from.
    const Vector3 origin_ned_m = state.position_ned_m;
    for (Waypoint& point : options.waypoints) {
      point.position_ned_m = point.position_ned_m + origin_ned_m;
    }
    double blend = 0.0;
    double tilt_deg = 0.0;
    double rotor_radps = 0.0;
    SurfaceTelemetry surfaces;
    bool reported = true;      // the state on the line just written
    double next_report_s = options.emit_seconds;
    RoutePilot pilot({.waypoints = options.waypoints, .origin_ned_m = origin_ned_m,
                      .step_seconds = step_seconds, .initial_yaw_deg = options.initial_yaw_deg,
                      .smooth_flight = options.smooth_flight,
                      .landing_yaw_deg = options.landing_yaw_deg});
    const auto timeout = std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::duration<double>(options.timeout_seconds));

    WriteState(state, origin_ned_m, 0.0, 0.0, runtime.IsGrounded(), pilot.WaypointIndex());
    double maximum_tilt_deg = 0.0;
    while (!pilot.IsComplete() && state.time.elapsed < timeout) {
      const auto command = pilot.Update(state, runtime.IsGrounded(), blend, maximum_tilt_deg);
      if (std::holds_alternative<std::monostate>(command.goal)) continue;
      aerodt::digital_twin::runtime::UamTickResult tick = std::visit([&](const auto& goal) -> aerodt::digital_twin::runtime::UamTickResult {
        using T = std::decay_t<decltype(goal)>;
        if constexpr (std::is_same_v<T, GroundThrottleGoal>)
          return runtime.Advance({.throttle = goal.throttle}, contact);
        else if constexpr (std::is_same_v<T, PositionYawRateGoalNed>)
          return runtime.AdvancePositionGoal(goal, contact);
        else if constexpr (std::is_same_v<T, VelocityYawAngleGoalNed>)
          return runtime.AdvanceVelocityGoal(goal, command.fixed_wing_requested, contact);
        else
          throw std::logic_error("a waypoint report is not a physics command");
      }, command.goal);
      state = tick.state.vehicle;
      if (options.smooth_flight && (!state.position_ned_m.IsFinite() ||
          !state.linear_velocity_ned_mps.IsFinite() || Length(state.linear_velocity_ned_mps) > 150.0)) {
        throw std::runtime_error("flight diverged beyond the guidance envelope");
      }
      blend = tick.transition.fixed_wing_blend;
      tilt_deg = TiltDegrees(tick);
      maximum_tilt_deg = 0.0;
      for (const auto& tilt : tick.tilts)
        maximum_tilt_deg = std::max(maximum_tilt_deg,
            std::abs(tilt.value.angle_rad) * 180.0 / 3.14159265358979323846);
      rotor_radps = RotorSpeedRadps(tick);
      surfaces.Capture(tick);
      contact = flat_ground.Observe(state);
      const double now = std::chrono::duration<double>(state.time.elapsed).count();
      reported = false;
      if (now >= next_report_s) {
        WriteState(state, origin_ned_m, tilt_deg, blend, tick.state.is_grounded, pilot.WaypointIndex(), rotor_radps, surfaces);
        reported = true;
        next_report_s = now + options.emit_seconds;
      }
    }
    // Where it ended, whichever tick that fell on. A flight that stopped
    // between two reports still says where it stopped.
    if (!reported) {
      WriteState(state, origin_ned_m, tilt_deg, blend, runtime.IsGrounded(), pilot.WaypointIndex(), rotor_radps, surfaces);
    }
    std::cout << "done " << pilot.WaypointIndex() << ' ' << options.waypoints.size() << ' '
              << std::fixed << std::setprecision(4)
              << std::chrono::duration<double>(state.time.elapsed).count()
              << ' ' << step_seconds << '\n';
    std::cout.flush();
    return pilot.IsComplete() ? 0 : 2;
  } catch (const std::exception& error) {
    std::cout << "error " << error.what() << '\n';
    std::cout.flush();
    return 1;
  }
}

