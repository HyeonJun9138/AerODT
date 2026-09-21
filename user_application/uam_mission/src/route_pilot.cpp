#include "aerodt/user_application/uam_mission/route_pilot.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <utility>

namespace aerodt::user_application::uam_mission {
namespace {
using foundation::math::Vector3;
constexpr double kLandedRadiusM = 20.0;
constexpr double kGroundIdleThrottle = 0.08;
constexpr double kVerticalLiftRateMps = 2.0;
constexpr double kPi = 3.14159265358979323846;
// Preview distance and waypoint tolerance are different: speed determines
// the former, the caller's capture_m determines the latter (normally 150 m).
constexpr double kPreviewSeconds = 7.0;
constexpr double kMinimumPreviewM = 60.0;
constexpr double kMaximumPreviewM = 360.0;
constexpr double kSharpTurnExtraPreviewM = 200.0;
constexpr double kLateralDampingSeconds = 3.0;
constexpr double kTurnThresholdRad = 0.35;
constexpr double kTurnWingMarginMps = 6.0;
// A wing that is not moving is not flying: the operating figures put the stall
// at 45 kt. Below that, sinking, the rotors have to have it back — whatever the
// route logic wants. Measured: a winged aircraft pinned at 8 m/s descends at a
// steady metre a second until it reaches the ground. The speeds themselves are
// the aircraft's, and live on the profile so an operator can see them; this is
// the one rule on the chart that is not there to be relaxed.
constexpr double kWingSinkMps = 0.5;
// Terminal capture budgets observed controller/rotor response before stopping.
// This is pilot guidance margin, not a physical acceleration override.
constexpr double kCaptureResponseS = 6.0;
constexpr double kCaptureGain = 0.10;
[[nodiscard]] double Length(const Vector3& value) {
  return std::sqrt(value.x * value.x + value.y * value.y + value.z * value.z);
}

[[nodiscard]] double YawDegrees(const aerodt::foundation::math::Quaternion& q) {
  const double degrees = 180.0 / 3.14159265358979323846;
  return std::atan2(2.0 * (q.w * q.z + q.x * q.y),
                    1.0 - 2.0 * (q.y * q.y + q.z * q.z)) *
         degrees;
}

}  // namespace

RoutePilot::RoutePilot(RoutePilotProfile profile)
    : options(std::move(profile)),
      commanded_yaw(options.initial_yaw_deg * 3.14159265358979323846 / 180.0) {
  if (options.waypoints.empty() || !std::isfinite(options.step_seconds) ||
      options.step_seconds <= 0.0)
    throw std::invalid_argument(
        "route pilot requires waypoints and a positive step");
  if (options.landing_yaw_deg && !std::isfinite(*options.landing_yaw_deg))
    throw std::invalid_argument("landing yaw must be finite degrees");
}

bool RoutePilot::LandingYawMutable() const noexcept {
  return !IsComplete() && index + 1 < options.waypoints.size();
}

bool RoutePilot::SetLandingYaw(double degrees) {
  if (!std::isfinite(degrees)) throw std::invalid_argument("landing yaw must be finite degrees");
  if (!LandingYawMutable()) return false;
  options.landing_yaw_deg = std::remainder(degrees, 360.0);
  return true;
}

bool RoutePilot::ReplaceArrival(std::size_t expected_index, std::size_t first,
                               std::vector<RouteWaypoint> suffix, double landing_yaw) {
  if (!std::isfinite(landing_yaw) || suffix.size() < 2 || first + suffix.size() > 4096)
    throw std::invalid_argument("invalid arrival suffix");
  for (const auto& point : suffix)
    if (!point.position_ned_m.IsFinite() || point.fixed_wing ||
        !std::isfinite(point.speed_mps) || point.speed_mps <= 0 || point.speed_mps > 60 ||
        !std::isfinite(point.capture_m) || point.capture_m <= 0)
      throw std::invalid_argument("invalid terminal waypoint");
  const auto column = suffix.back().position_ned_m - suffix[suffix.size()-2].position_ned_m;
  if (std::hypot(column.x, column.y) > 0.01 || column.z <= 0)
    throw std::invalid_argument("arrival must end with a vertical landing column");
  if (index != expected_index || first <= index || first >= options.waypoints.size() ||
      !LandingYawMutable()) return false;
  if (std::any_of(options.waypoints.begin()+first, options.waypoints.end(),
                  [](const auto& point) { return point.fixed_wing; })) return false;
  // Allocate/validate before mutation: allocation failure leaves the old route.
  auto replacement = std::vector<RouteWaypoint>(options.waypoints.begin(), options.waypoints.begin()+first);
  replacement.insert(replacement.end(), suffix.begin(), suffix.end());
  options.waypoints.swap(replacement);
  options.landing_yaw_deg = std::remainder(landing_yaw, 360.0);
  return true;
}

void RoutePilot::SetTraffic(double right_m, double speed_factor) {
  traffic_right_target_m = std::clamp(right_m, 0.0, 80.0);
  traffic_speed_factor = std::clamp(speed_factor, 0.75, 1.0);
}

void RoutePilot::SetHold(std::optional<Vector3> position) {
  if (position && !position->IsFinite()) throw std::invalid_argument("hold position must be finite");
  if (hold_position && !position) {
    approach_hold_down_m.reset();
    descent_ready = false;
    descent_settled_s = 0.0;
  }
  hold_position = position;
}

RoutePilotCommand RoutePilot::Update(
    const digital_twin::contracts::VehicleState& state, bool grounded,
    double blend, double observed_tilt_deg) {
  using digital_twin::simulation::control::simple_flight::
      PositionYawRateGoalNed;
  using digital_twin::simulation::control::simple_flight::
      VelocityYawAngleGoalNed;
  using foundation::math::Vector3;
  if (IsComplete()) return {};
  guidance_reason = "route_tracking";
  const double step_seconds = options.step_seconds;
  const RoutePilotTuning& tune = options.tuning;
  // A clearance changes intent, not vehicle position or mission progress.
  // Slew velocity into a multirotor hold using this pilot's own observation.
  if (hold_position) {
    guidance_reason = "clearance_hold";
    const auto error = *hold_position - state.position_ned_m;
    const double distance = std::hypot(error.x, error.y);
    const double speed = std::min(tune.hold_speed_mps, tune.approach_gain * distance);
    const Vector3 wanted{distance > 1e-6 ? error.x / distance * speed : 0.0,
                         distance > 1e-6 ? error.y / distance * speed : 0.0,
                         std::clamp(tune.approach_gain * error.z, -2.0, 2.0)};
    const auto delta = wanted - commanded_velocity;
    const double flat = std::hypot(delta.x, delta.y);
    const double share = flat > 0 ? std::min(1.0, tune.approach_brake_mps2 * step_seconds / flat) : 1.0;
    commanded_velocity.x += delta.x * share;
    commanded_velocity.y += delta.y * share;
    commanded_velocity.z += std::clamp(delta.z, -0.5 * step_seconds, 0.5 * step_seconds);
    return {VelocityYawAngleGoalNed{.velocity_ned_mps = commanded_velocity,
                                   .yaw_angle_ned_rad = commanded_yaw}, false};
  }
  const auto& origin_ned_m = options.origin_ned_m;
  const RouteWaypoint& target = options.waypoints[index];
  const Vector3 to_target = target.position_ned_m - state.position_ned_m;
  const double range = Length(to_target);
  // A touchdown is reached when the aircraft is on the ground, whatever
  // the remaining range says. The deck is where the wheels stop, and the
  // body sits its own clearance above that, so a waypoint on the deck is
  // always a little below a landed aircraft and could never be closed.
  const bool landed_on_it = grounded && to_target.z >= 0.0 &&
                            std::hypot(to_target.x, to_target.y) <=
                                std::max(target.capture_m, kLandedRadiusM);
  const double horizontal_range = std::hypot(to_target.x, to_target.y);
  const double horizontal_speed = std::hypot(state.linear_velocity_ned_mps.x,
                                             state.linear_velocity_ned_mps.y);
  const bool rotor_ready = blend < 0.001 && std::abs(observed_tilt_deg) < 1.0;
  const bool landing = index + 1 == options.waypoints.size() &&
                       (options.terminal_landing || target.position_ned_m.z >= origin_ned_m.z - 0.01);
  // A terminal hover is a capture-and-settle, never a 60 m fly-through.
  const bool hover = index == 0 || (!target.fixed_wing && !landing);
  // Single and fleet execution use the same fly-through guidance. Only the
  // end of a winged run is a stop; intermediate corridor points are not holds.
  const bool last_winged =
      target.fixed_wing && (index + 1 >= options.waypoints.size() ||
                            !options.waypoints[index + 1].fixed_wing);
  const bool fly_through = index > 0 && target.fixed_wing && !last_winged;
  const auto& previous =
      index > 0 ? options.waypoints[index - 1].position_ned_m : origin_ned_m;
  const auto leg = target.position_ned_m - previous;
  const double leg_length = std::hypot(leg.x, leg.y);
  const bool descending = !target.fixed_wing && target.position_ned_m.z > previous.z + 1.0;
  const bool approaching = index > 0 && !target.fixed_wing && !landing && leg.z >= -1.0 &&
      (descending || reverse_for_approach || descent_ready || options.waypoints[index - 1].fixed_wing);
  const bool has_next = index + 1 < options.waypoints.size();
  const auto outgoing = has_next ? options.waypoints[index + 1].position_ned_m - target.position_ned_m
                                : Vector3{};
  const double outgoing_length = std::hypot(outgoing.x, outgoing.y);
  // Only an ordered, nonvertical approach leg permits a moving handoff.
  // The hover above the FATO and the final vertical touchdown remain exact.
  const bool approach_entry = last_winged && has_next && outgoing.z >= -1.0 && outgoing_length > 1.0;
  const double approach_passage_m = std::min({target.capture_m, leg_length * 0.15, 20.0});
  const bool approach_through = approaching && has_next &&
      !options.waypoints[index + 1].fixed_wing && outgoing.z >= -1.0 && outgoing_length > 1.0;
  const double along = leg_length > 1e-6
      ? ((state.position_ned_m.x - previous.x) * leg.x +
         (state.position_ned_m.y - previous.y) * leg.y) / leg_length : 0.0;
  const double cross = leg_length > 1e-6
      ? std::abs((state.position_ned_m.x - previous.x) * leg.y -
                 (state.position_ned_m.y - previous.y) * leg.x) / leg_length : horizontal_range;
  double lookahead_distance = std::clamp(horizontal_speed * kPreviewSeconds,
                                        kMinimumPreviewM, kMaximumPreviewM);
  if (fly_through && leg_length > 1.0) {
    const auto next = options.waypoints[index + 1].position_ned_m - target.position_ned_m;
    const double length = std::hypot(next.x, next.y);
    if (length > 1.0) {
      const double angle = std::acos(std::clamp(
          (leg.x * next.x + leg.y * next.y) / (leg_length * length), -1.0, 1.0));
      const double sharpness = std::clamp((angle - kPi / 2.0) / (kPi / 4.0), 0.0, 1.0);
      lookahead_distance += sharpness * kSharpTurnExtraPreviewM;
    }
  }
  bool reached = range <= target.capture_m || landed_on_it;
  if (options.smooth_flight) {
    // The relaxed fly-by preference must not widen the final approach stop.
    const bool stable = range <= (hover ? tune.hover_capture_m : std::min(target.capture_m, 60.0)) &&
                        (!hover || (rotor_ready && Length(state.linear_velocity_ned_mps) < 0.4));
    settled_s = stable ? settled_s + step_seconds : 0.0;
    touchdown_s = landing && grounded && horizontal_range < 0.3
                      ? touchdown_s + step_seconds
                      : 0.0;
    reached = landing ? touchdown_s >= 2.0
                      : (hover ? settled_s >= tune.hover_settle_s : stable);
    // A fly-by waypoint advances the lateral route, not the physical height.
    // Keep tracking the next planned altitude instead of turning back to an
    // already passed climb vertex and stalling over it. Hover/landing still
    // require their full 3-D capture and settled observation.
    if (fly_through) {
      // Capture tolerance is not a fixed turn-start distance. Do not consume
      // short consecutive segments before the departure has even aligned.
      const double capture = std::min(target.capture_m, leg_length * 0.45);
      // It is a preferred passage envelope, not a demand to circle back.
      // Allow a bounded fly-by on the ordered corner's bisector when the
      // observed speed needs a little more room. Never select a remote WP.
      const double flyby_envelope = std::min(leg_length * 0.45,
          std::max(capture, lookahead_distance * 0.65));
      reached = (index != 1 || departure_aligned) &&
          (horizontal_range <= capture || (along >= leg_length && cross <= capture));
      // A fly-by crosses the bisector of the incoming/outgoing legs rather
      // than the vertex itself. Only the next ordered leg participates; a
      // nearby crossing or an unrelated route cannot steal progress.
      const auto outgoing = options.waypoints[index + 1].position_ned_m - target.position_ned_m;
      const double next_length = std::hypot(outgoing.x, outgoing.y);
      if (leg_length > 1.0 && next_length > 1.0) {
        const double bx = leg.x / leg_length + outgoing.x / next_length;
        const double by = leg.y / leg_length + outgoing.y / next_length;
        const double passed = -to_target.x * bx - to_target.y * by;
        reached = reached || ((index != 1 || departure_aligned) &&
            std::hypot(bx, by) > 0.2 && passed >= 0.0 && horizontal_range <= flyby_envelope);
      }
    }
    if ((approach_entry || approach_through) && leg_length > 1.0) {
      const double envelope = std::min(leg_length * 0.45,
          std::max(target.capture_m, lookahead_distance * 0.65));
      // A short descending corner must retain enough distance to serve its
      // altitude, rather than consuming almost half the next short segment.
      const double passage = approach_through
          ? approach_passage_m : std::min(envelope, 60.0);
      const double next_along = outgoing_length > 1.0
          ? (-to_target.x * outgoing.x - to_target.y * outgoing.y) / outgoing_length : -1.0;
      const double next_cross = outgoing_length > 1.0
          ? std::abs(-to_target.x * outgoing.y + to_target.y * outgoing.x) / outgoing_length : envelope + 1.0;
      const bool on_next_leg = approach_through && next_along >= passage &&
          next_along <= outgoing_length && next_cross <= passage && along >= leg_length - passage;
      const bool near_passage = horizontal_range <= passage || on_next_leg ||
          (along >= leg_length && cross <= envelope && horizontal_range <= 2.0 * envelope);
      // Do not hand a high-speed winged aircraft directly to a descent. The
      // normal upstream braking/reversal must already have taken control.
      const bool prepared = reverse_for_approach || (approach_through && descent_ready && blend < 0.001) ||
          (blend < 0.001 && std::abs(observed_tilt_deg) < 1.0 &&
           horizontal_speed <= std::max(tune.reverse_speed_mps, tune.approach_horizontal_speed_mps));
      reached = prepared && (index != 1 || departure_aligned) && near_passage;
      // Pilot discretion applies only to an intermediate, ordered approach.
      // A released hold can leave us beyond the old F/G entry, already on G.
      // Reacquiring that vertex is not useful navigation. Accept a bounded
      // portion of the immediate successor, never a nearby unrelated WP.
      const double pilot_radius = std::min({
          std::max(passage, std::clamp(horizontal_speed * 2.0, 5.0, 20.0)),
          approach_entry ? 60.0 : 20.0, leg_length * 0.15, outgoing_length * 0.25});
      const double recovery_length = std::min(outgoing_length * 0.45,
          std::max(120.0, pilot_radius * 3.0) + horizontal_speed * kCaptureResponseS);
      const double forward_next = outgoing_length > 1.0
          ? (state.linear_velocity_ned_mps.x * outgoing.x +
             state.linear_velocity_ned_mps.y * outgoing.y) / outgoing_length : -1.0;
      const bool altitude_in_leg = state.position_ned_m.z >=
          std::min(target.position_ned_m.z, options.waypoints[index + 1].position_ned_m.z) - 10.0 &&
          state.position_ned_m.z <=
          std::max(target.position_ned_m.z, options.waypoints[index + 1].position_ned_m.z) + 10.0;
      const bool moving_ready = rotor_ready &&
          horizontal_speed <= std::max(tune.reverse_speed_mps, tune.approach_horizontal_speed_mps) &&
          std::abs(state.linear_velocity_ned_mps.z) <= tune.descent_rate_mps && forward_next >= -0.2;
      const bool nearby = horizontal_range <= pilot_radius && std::abs(to_target.z) <= 10.0;
      const bool joined_next = next_along >= pilot_radius && next_along <= recovery_length &&
          next_cross <= pilot_radius && along >= leg_length - pilot_radius && altitude_in_leg;
      reached = reached || ((index != 1 || departure_aligned) && moving_ready && (nearby || joined_next));
    }
  }
  if (reached) {
    settled_s = 0.0;
    if (!approach_through) {
      descent_ready = false;
      descent_settled_s = 0.0;
      approach_hold_down_m.reset();
    }
    ++index;
    return {};
  }
  if (options.smooth_flight) {
    const double now =
        std::chrono::duration<double>(state.time.elapsed).count();
    // Spin-up on the pad, using actual actuator dynamics, before lift.
    if (now < 6.0) {
      guidance_reason = "takeoff";
      const double u = std::clamp(now / 6.0, 0.0, 1.0);
      return {
          GroundThrottleGoal{kGroundIdleThrottle * u * u * (3.0 - 2.0 * u)}};
    }
    if (landing && grounded && horizontal_range < 0.3) {
      guidance_reason = "vertical_landing";
      return {GroundThrottleGoal{kGroundIdleThrottle}};
    }
    const bool vertical =
        std::hypot(target.position_ned_m.x - previous.x,
                   target.position_ned_m.y - previous.y) < 1.0;
    double stopping_range = horizontal_range;
    if (target.fixed_wing) {
      for (std::size_t next = index + 1;
           next < options.waypoints.size() && options.waypoints[next].fixed_wing; ++next) {
        const auto leg = options.waypoints[next].position_ned_m -
                         options.waypoints[next - 1].position_ned_m;
        stopping_range += std::hypot(leg.x, leg.y);
      }
    }
    // Look ahead along the existing route, not a straight-line shortcut.
    // Begin reverse transition before the first descending segment. The
    // budget combines braking distance and the actuator's 12 s transition.
    const double reverse_entry_speed = std::max(tune.reverse_speed_mps, tune.wing_recover_mps + 4.0);
    const double transition_room = reverse_entry_speed * tune.reverse_transition_s + tune.reverse_margin_m;
    if (target.fixed_wing && stopping_range < transition_room &&
        horizontal_speed <= reverse_entry_speed)
      reverse_for_approach = true;
    // Look ahead on the supplied polyline. Steering at the next vertex until
    // directly overhead demands an instantaneous yaw change at every corner.
    Vector3 steering = to_target;
    if (target.fixed_wing && leg_length > 1.0 && !reverse_for_approach) {
      double lookahead = lookahead_distance;
      double left = std::max(0.0, leg_length - std::clamp(along, 0.0, leg_length));
      // Aim ahead of the projection on the active leg, not at a distant
      // vertex. This promptly recaptures the right-hand lane after a turn.
      Vector3 aim = previous + leg * std::min(1.0,
          (std::clamp(along, 0.0, leg_length) + lookahead) / leg_length);
      for (std::size_t next = index + 1; lookahead > left &&
           next < options.waypoints.size() && options.waypoints[next].fixed_wing; ++next) {
        lookahead -= left;
        const auto segment = options.waypoints[next].position_ned_m -
                             options.waypoints[next - 1].position_ned_m;
        left = std::hypot(segment.x, segment.y);
        if (left < 1e-6) continue;
        aim = options.waypoints[next - 1].position_ned_m +
              segment * std::min(1.0, lookahead / left);
      }
      // Smooth lateral goal movement (2 m/s); retain waypoint order, altitude,
      // acceleration and yaw limits. Approaches never receive this diversion.
      traffic_right_m += std::clamp(traffic_right_target_m-traffic_right_m,
                                    -2.0*step_seconds, 2.0*step_seconds);
      aim.x -= leg.y/leg_length*traffic_right_m;
      aim.y += leg.x/leg_length*traffic_right_m;
      steering = aim - state.position_ned_m;
      const double forward_speed = (state.linear_velocity_ned_mps.x * leg.x +
                                    state.linear_velocity_ned_mps.y * leg.y) / leg_length;
      // Lead the lateral motion as well as the position. Without this damping
      // the aircraft crosses its lane again after leaving a bend.
      steering.x -= kLateralDampingSeconds *
          (state.linear_velocity_ned_mps.x - forward_speed * leg.x / leg_length);
      steering.y -= kLateralDampingSeconds *
          (state.linear_velocity_ned_mps.y - forward_speed * leg.y / leg_length);
    }
    if (approaching && descent_ready && leg_length > 1.0 && (approach_through || horizontal_range > 80.0)) {
      // Only the active segment and its ordered successor participate. The
      // preview may round a corner, but cannot select a nearby crossing route.
      const double preview = std::clamp(horizontal_speed * 6.0, 35.0, 70.0);
      const double progress = std::clamp(along, 0.0, leg_length);
      Vector3 aim = previous + leg * std::min(1.0, (progress + preview) / leg_length);
      if (approach_through && preview > leg_length - progress) {
        // The preview's equilibrium must remain inside the same passage
        // geometry that permits handoff. A 30%-of-next-leg preview can sit
        // behind an acute corner's 15% incoming capture forever, causing
        // repeated forward/reverse chasing without advancing the route.
        const double next_distance = std::min({outgoing_length * 0.3,
            approach_passage_m * 0.5, preview - (leg_length - progress)});
        aim = target.position_ned_m + outgoing * (next_distance / outgoing_length);
      }
      steering = aim - state.position_ned_m;
      const double forward = (state.linear_velocity_ned_mps.x * leg.x +
                              state.linear_velocity_ned_mps.y * leg.y) / leg_length;
      steering.x -= 1.5 * (state.linear_velocity_ned_mps.x - forward * leg.x / leg_length);
      steering.y -= 1.5 * (state.linear_velocity_ned_mps.y - forward * leg.y / leg_length);
      // Never turn back toward a consumed projection merely to hit the vertex.
      if (along > leg_length && approach_through) {
        steering = outgoing;
      }
    }
    const double steering_range = std::hypot(steering.x, steering.y);
    // First reach the departure hover without changing yaw. Align there, not
    // against the deck altitude: that used to command repeated descents in the
    // fleet-only branch whenever the initial heading differed from the route.
    double desired_yaw = commanded_yaw;
    if (!vertical && horizontal_range > 10.0) {
      desired_yaw = std::atan2(steering.y, steering.x);
    }
    constexpr double pi = 3.14159265358979323846;
    // Only turn for taxi once settled in the arrival column, with reverse
    // transition complete. Keep the descent altitude until actual yaw settles.
    if (landing && options.landing_yaw_deg && horizontal_range < 0.6 &&
        horizontal_speed < 0.4 && blend < 0.01)
      desired_yaw = *options.landing_yaw_deg * pi / 180.0;
    const double actual_yaw =
        YawDegrees(state.orientation_body_to_ned) * pi / 180.0;
    const double yaw_error =
        std::remainder(desired_yaw - commanded_yaw, 2.0 * pi);
    commanded_yaw += std::clamp(yaw_error, -10.0 * pi / 180.0 * step_seconds,
                                10.0 * pi / 180.0 * step_seconds);
    Vector3 wanted{};
    const double limit = vertical ? 1.5 :
        (approaching ? std::min(tune.approach_horizontal_speed_mps, target.speed_mps) : reverse_for_approach
             ? std::min(tune.reverse_speed_mps, target.speed_mps) : target.speed_mps);
    double horizontal_limit = std::min(
        limit, std::sqrt(2.0 * std::max(1e-3, tune.approach_brake_mps2) * stopping_range));
    if (target.fixed_wing && !reverse_for_approach && tune.reverse_brake_span) {
      // Decelerate on the wing before reversing. Requesting multirotor at full
      // cruise speed dumps forward thrust into lift and balloons the aircraft.
      horizontal_limit = std::min(horizontal_limit, std::sqrt(
          reverse_entry_speed * reverse_entry_speed + 2.0 * tune.approach_brake_mps2 *
          std::max(0.0, stopping_range - transition_room)));
    }
    horizontal_limit = std::min(horizontal_limit, tune.approach_gain * stopping_range);
    const bool terminal_capture = approaching && !approach_through;
    if (terminal_capture) guidance_reason = "approach_path_capture";
    if (index == 0) guidance_reason = "takeoff";
    if (terminal_capture) {
      // v*t + v*v/(2*a) <= remaining distance: a zero-delay braking curve
      // reaches the hover point before the real aircraft finishes slowing.
      const double brake = std::max(1e-3, tune.approach_brake_mps2);
      const double lag = brake * kCaptureResponseS;
      const double capture_speed = std::sqrt(lag*lag + 2.0*brake*horizontal_range) - lag;
      horizontal_limit = std::min({horizontal_limit, capture_speed,
          std::min(tune.approach_gain, kCaptureGain)*horizontal_range});
    }
    if (fly_through && !reverse_for_approach) {
      // Slow before a bend, including one just beyond a short merge segment.
      // Keep a wing-speed margin; the flight-mode controller still owns tilt.
      double distance = std::max(0.0, leg_length - along);
      const double braking_horizon = target.speed_mps * target.speed_mps /
          (2.0 * std::max(1e-3, tune.approach_brake_mps2)) +
          kMaximumPreviewM + kSharpTurnExtraPreviewM;
      for (std::size_t corner = index; corner + 1 < options.waypoints.size() &&
           options.waypoints[corner + 1].fixed_wing && distance < braking_horizon; ++corner) {
        const auto incoming = options.waypoints[corner].position_ned_m -
            (corner ? options.waypoints[corner - 1].position_ned_m : origin_ned_m);
        const auto outgoing = options.waypoints[corner + 1].position_ned_m -
                              options.waypoints[corner].position_ned_m;
        const double a = std::hypot(incoming.x, incoming.y), b = std::hypot(outgoing.x, outgoing.y);
        if (a > 1.0 && b > 1.0) {
          const double angle = std::acos(std::clamp(
              (incoming.x * outgoing.x + incoming.y * outgoing.y) / (a * b), -1.0, 1.0));
          if (angle > kTurnThresholdRad) {
            const double turn_speed = std::max(tune.wing_recover_mps + kTurnWingMarginMps,
                                               target.speed_mps * (1.0 - angle / kPi));
            horizontal_limit = std::min(horizontal_limit, std::sqrt(turn_speed * turn_speed +
                2.0 * tune.approach_brake_mps2 * std::max(0.0, distance - lookahead_distance)));
          }
        }
        distance += b;
      }
      // Passing the fly-by bisector is not the end of the physical turn.
      // Keep the corner speed while establishing the outgoing leg, rather
      // than accelerating in the middle of the turn and overshooting its lane.
      if (index > 1 && leg_length > 1.0) {
        const auto incoming = previous - options.waypoints[index - 2].position_ned_m;
        const double length = std::hypot(incoming.x, incoming.y);
        if (length > 1.0) {
          const double angle = std::acos(std::clamp(
              (incoming.x * leg.x + incoming.y * leg.y) / (length * leg_length), -1.0, 1.0));
          if (angle > kTurnThresholdRad) {
            const double turn_speed = std::max(tune.wing_recover_mps + kTurnWingMarginMps,
                target.speed_mps * (1.0 - angle / pi));
            const double recovery_distance = std::min(900.0, horizontal_speed *
                (7.0 + 5.0 * std::tan(std::min(angle, 2.8) * 0.5)));
            horizontal_limit = std::min(horizontal_limit, std::sqrt(turn_speed * turn_speed +
                2.0 * tune.approach_brake_mps2 * std::max(0.0, along - recovery_distance)));
          }
        }
      }
    }
    if (target.fixed_wing && !reverse_for_approach && traffic_speed_factor < 1.0)
      // A route request can exceed the vehicle's achieved speed. Scaling that
      // request alone can leave a tactical slowdown above the current speed.
      horizontal_limit = std::min(horizontal_limit,
          std::max(tune.wing_recover_mps+3.0,
                   std::min(target.speed_mps, horizontal_speed)*traffic_speed_factor));
    if (steering_range > 1e-6) {
      wanted.x = steering.x / steering_range * horizontal_limit;
      wanted.y = steering.y / steering_range * horizontal_limit;
    }
    const double altitude_rate =
        vertical ? (landing ? tune.landing_rate_mps :
                    (leg.z < 0.0 ? std::min(kVerticalLiftRateMps, target.speed_mps) : tune.descent_rate_mps))
                 : (approaching ? tune.descent_rate_mps : tune.climb_rate_mps);
    // The vertical command is acceleration-limited too. Start levelling off
    // with room to shed the climb rate; a pure position gain asked for 8 m/s
    // until only 23 m remained, despite needing at least 64 m to stop at 0.5 m/s2.
    const double altitude_limit = std::min(altitude_rate,
        std::sqrt(2.0 * 0.3 * std::abs(to_target.z)));
    const double altitude_gain = target.fixed_wing && !reverse_for_approach
        ? tune.wing_altitude_gain : tune.approach_gain;
    wanted.z = std::clamp(altitude_gain * to_target.z, -altitude_limit, altitude_limit);
    if (descending && !vertical && horizontal_range > 1e-6) {
      const double slope_speed =
          std::abs(to_target.z) > 1.0
              ? altitude_limit * horizontal_range / std::abs(to_target.z)
              : horizontal_limit;
      const double tracking_limit = std::min(horizontal_limit, slope_speed);
      wanted.x = steering_range > 1e-6 ? steering.x / steering_range * tracking_limit : 0.0;
      wanted.y = steering_range > 1e-6 ? steering.y / steering_range * tracking_limit : 0.0;
      wanted.z = to_target.z / horizontal_range * tracking_limit;
    }
    if (approaching && descent_ready && leg_length > 1.0) {
      // Work backwards from each remaining G altitude on the supplied route.
      // This can slow a level G before a short steep successor, but must not
      // lower that level segment (or the preceding F corridor) to buy room.
      const double down_rate = std::max(0.1, tune.descent_rate_mps);
      const double response_s = (down_rate - std::clamp(
          state.linear_velocity_ned_mps.z, 0.0, down_rate)) / 0.5 + kCaptureResponseS;
      double distance = std::max(0.0, leg_length - std::clamp(along, 0.0, leg_length));
      const double speed = std::hypot(wanted.x, wanted.y);
      double feasible_speed = speed;
      for (std::size_t next = index; next + 1 < options.waypoints.size(); ++next) {
        const auto& point = options.waypoints[next];
        if (point.fixed_wing) break;
        double segment_length = leg_length;
        if (next > index) {
          const auto segment = point.position_ned_m - options.waypoints[next - 1].position_ned_m;
          segment_length = std::hypot(segment.x, segment.y);
          if (segment_length < 1.0) break;
          distance += segment_length;
        }
        const auto after = options.waypoints[next + 1].position_ned_m - point.position_ned_m;
        const double passage = std::hypot(after.x, after.y) > 1.0
            ? std::min(20.0, segment_length * 0.15) : 0.0;
        const double deficit = point.position_ned_m.z - state.position_ned_m.z;
        if (deficit > 1.0) {
          const double vertical_time = deficit / down_rate + response_s;
          feasible_speed = std::min(feasible_speed, std::max(0.0, distance - passage) / vertical_time);
        }
      }
      if (feasible_speed < speed) {
        const double factor = speed > 1e-9 ? feasible_speed / speed : 0.0;
        wanted.x *= factor;
        wanted.y *= factor;
        guidance_reason = "approach_altitude_adjustment";
        // Extra descent only serves the CURRENT permitted target altitude.
        if (to_target.z > 1.0)
          wanted.z = std::clamp(tune.approach_gain * to_target.z, -altitude_limit, altitude_limit);
      }
    }
    if (reverse_for_approach && target.fixed_wing) guidance_reason = "reverse_transition";
    if (approaching && !descent_ready) {
      if (!approach_hold_down_m) approach_hold_down_m = state.position_ned_m.z;
      // Confirm actual reversal while joining the next leg, not by returning
      // to an already passed vertex and stopping within one metre of it.
      const bool stable = blend < 0.001 && std::abs(observed_tilt_deg) < 1.0 &&
          horizontal_speed <= std::max(tune.reverse_speed_mps, tune.approach_horizontal_speed_mps) + 1.0 &&
          std::abs(state.linear_velocity_ned_mps.z) < 0.5;
      descent_settled_s = stable ? descent_settled_s + step_seconds : 0.0;
      descent_ready = stable && descent_settled_s >= tune.descent_settle_s;
      if (!descent_ready) {
        guidance_reason = "reverse_transition";
        // A zero velocity alone can drift under the real rotor controller.
        // Capture an altitude *goal*, but never return horizontally to a WP.
        wanted.z = std::clamp(tune.approach_gain * (*approach_hold_down_m - state.position_ned_m.z),
                              -tune.descent_rate_mps, tune.descent_rate_mps);
      }
    }
    if (landing) {
      guidance_reason = "final_alignment";
      if (options.landing_yaw_deg) {
        const double heading = *options.landing_yaw_deg * pi / 180.0;
        const bool ready = horizontal_range < 0.3 && horizontal_speed < 0.2 &&
            rotor_ready && std::abs(state.linear_velocity_ned_mps.z) < 0.2 &&
            std::abs(std::remainder(heading - actual_yaw, 2.0 * pi)) < 1.5 * pi / 180.0 &&
            std::abs(std::remainder(heading - commanded_yaw, 2.0 * pi)) < 0.5 * pi / 180.0 &&
            std::abs(state.angular_velocity_body_radps.z) < pi / 180.0;
        if (!landing_aligned) {
          landing_yaw_settled_s = ready ? landing_yaw_settled_s + step_seconds : 0.0;
          landing_aligned = landing_yaw_settled_s >= tune.hover_settle_s;
        }
      } else if (!landing_aligned && horizontal_range < 0.3 &&
                 horizontal_speed < 0.2 && rotor_ready) {
        landing_aligned = true;
      }
      // Stay at the arrival hover height until positioned over the FATO.
      if (!landing_aligned || !rotor_ready || horizontal_range > 1.0) {
        wanted.z = std::clamp(tune.approach_gain * (previous.z - state.position_ned_m.z),
                              -1.0, 1.0);
      } else {
        guidance_reason = "vertical_landing";
        wanted.z = std::clamp(0.25 * std::max(0.0, to_target.z), 0.18,
                              tune.landing_rate_mps);
      }
    }
    // Align actual heading before allowing horizontal acceleration.
    const double alignment =
        std::abs(std::remainder(desired_yaw - actual_yaw, 2.0 * pi));
    if (index == 1 && !departure_aligned) {
      const bool aligned = alignment < 2.0 * pi / 180.0 &&
          std::abs(yaw_error) < 0.5 * pi / 180.0 &&
          std::abs(state.angular_velocity_body_radps.z) < pi / 180.0;
      departure_yaw_settled_s = aligned ? departure_yaw_settled_s + step_seconds : 0.0;
      departure_aligned = departure_yaw_settled_s >= tune.hover_settle_s;
    }
    if (index == 1 && !departure_aligned) {
      guidance_reason = "departure_alignment";
      wanted.x = std::clamp(tune.approach_gain * (previous.x - state.position_ned_m.x), -1.0, 1.0);
      wanted.y = std::clamp(tune.approach_gain * (previous.y - state.position_ned_m.y), -1.0, 1.0);
      wanted.z = std::clamp(tune.approach_gain * (previous.z - state.position_ned_m.z), -1.0, 1.0);
    }
    const auto delta = wanted - commanded_velocity;
    const double flat_delta = std::hypot(delta.x, delta.y);
    // Complete the commanded slowdown during the 12 s actuator reversal,
    // rather than asking a now-vertical rotor to keep the old cruise velocity.
    // That incompatible forward demand couples into the body-axis throttle
    // controller and used to cause a large, unintended climb.
    const double acceleration = reverse_for_approach
        ? std::max(tune.approach_brake_mps2, (reverse_entry_speed - tune.reverse_speed_mps) / 10.0)
        : tune.approach_brake_mps2;
    const double share = flat_delta > 0.0
        ? std::min(1.0, acceleration * step_seconds / flat_delta) : 1.0;
    if (target.fixed_wing && departure_aligned && !reverse_for_approach) {
      // Turning must not blend opposite velocity vectors and accidentally
      // erase airspeed. Slew speed separately and keep its heading coherent
      // with the yaw request. This changes intent, never the observed state.
      const double speed = std::hypot(commanded_velocity.x, commanded_velocity.y);
      const double wanted_speed = std::hypot(wanted.x, wanted.y);
      const double next_speed = speed + std::clamp(wanted_speed - speed,
          -acceleration * step_seconds, acceleration * step_seconds);
      commanded_velocity.x = next_speed * std::cos(commanded_yaw);
      commanded_velocity.y = next_speed * std::sin(commanded_yaw);
    } else {
      commanded_velocity.x += delta.x * share;
      commanded_velocity.y += delta.y * share;
    }
    commanded_velocity.z +=
        std::clamp(delta.z, -0.5 * step_seconds, 0.5 * step_seconds);
    VelocityYawAngleGoalNed goal{.velocity_ned_mps = commanded_velocity,
                                 .yaw_angle_ned_rad = commanded_yaw,
                                 .allow_rotor_tilt_assist = approaching && descent_ready && !vertical &&
                                     (!terminal_capture || horizontal_range > std::max(80.0,
                                         horizontal_speed * tune.reverse_transition_s * 0.5))};
    // The wing is kept until the aircraft has actually slowed to the speed the
    // rotors take over at, so the reversal is flown rather than ballooned.
    // The rotors take the aircraft back when the wing has stopped flying, and
    // keep it until it is quick enough for the wing to carry it again. An
    // instantaneous test chatters them in and out while it goes on falling.
    if (blend > 0.5 &&
        horizontal_speed < tune.wing_stall_mps &&
        state.linear_velocity_ned_mps.z > kWingSinkMps)
      wing_lost = true;
    else if (horizontal_speed > tune.wing_recover_mps ||
             (blend < 0.001 && std::abs(observed_tilt_deg) < 1.0))
      // Rearm after a completed rotor recovery. Waiting for wing cruise speed
      // while prohibiting the transition could never recover on this model.
      // SimpleFlight still gates the next transition by its measured speed.
      wing_lost = false;
    return {goal, target.fixed_wing && !vertical && !descending && !wing_lost &&
                      !reverse_for_approach && (index != 1 || departure_aligned)};
  }
  // A waypoint straight above or below is a hover: the position cascade
  // holds the horizontal place while it climbs, which a velocity goal
  // aimed at a vertical line cannot do steadily.
  const double horizontal = std::hypot(to_target.x, to_target.y);
  if (horizontal < std::max(2.0, target.capture_m * 0.5)) {
    return {PositionYawRateGoalNed{.position_ned_m = target.position_ned_m}};
  }
  // Otherwise aim at it: the controller is asked for the velocity that
  // closes the range, and slows inside it so the capture is not a
  // fly-through. Fixed wing is requested where the plan cruises, which
  // is what tilts the rotors forward.
  const double wanted = std::min(target.speed_mps, std::max(3.0, range * 0.5));
  const Vector3 direction{to_target.x / range, to_target.y / range,
                          to_target.z / range};
  VelocityYawAngleGoalNed goal;
  goal.velocity_ned_mps = direction * wanted;
  goal.yaw_angle_ned_rad = std::atan2(to_target.y, to_target.x);
  return {goal, target.fixed_wing};
}

}  // namespace aerodt::user_application::uam_mission
