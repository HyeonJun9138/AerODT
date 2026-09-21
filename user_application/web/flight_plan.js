const {interpolateSurfaceAngles}=await import(import.meta.url.startsWith('file:')
  ? '../../digital_twin/visualization/web/control_surface_pose.js' : '/visualization/control_surface_pose.js');
// User/Application: where the aircraft is at a given second of a flight plan.
//
// The server answers a plan as timed legs, each with its path, its duration
// and what it costs the battery. Playing that back is not a simulation: any
// second of the flight is a position along one leg, so scrubbing backwards is
// as cheap as playing forwards and nothing drifts. This module is the only
// place that reads a leg, so the panel and the map always agree on where the
// aircraft is.
//
// The heights the server sends are the designed ones and say what they were
// measured from: `msl` stands as it is, `agl` is over the terrain under the
// point, and `deck:<vertiport>` is over that vertiport's platform. Resolving
// them needs the ground, which only the display has, so `resolvePlan` does it
// once — the same arithmetic the route layer already does for the waypoints
// this flight follows, so the aircraft flies the route as it was drawn rather
// than at sea level over a hill.
export const STAGE_COLORS = {
  gate_out: '#7fe0a3', takeoff: '#6edc96', climb: '#ffb457', cruise: '#7fe9f5',
  descent: '#a5c8ff', landing: '#78beff', gate_in: '#7fe0a3', charge: '#ffd166',
};
export const EARTH_RADIUS_M = 6371000;

export const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// The vertiport a `deck:<id>` datum names, or null for msl and agl.
export const deckOf = datum => (typeof datum === 'string' && datum.startsWith('deck:') ? datum.slice(5) : null);

// The designed heights become real ones. `groundHeights(points)` answers the
// terrain under each point and `deckTop(vertiportId)` the top of a placed
// platform; a deck that has not been placed yet falls back to the terrain
// under it plus the platform height the plan carries, so a flight is never
// left at sea level waiting for a layer.
export async function resolvePlan(plan, {groundHeights = async () => null, deckTop = () => null} = {}) {
  if (!plan?.legs?.length) return plan ?? null;
  const points = [];
  for (const leg of plan.legs) for (const point of leg.path ?? []) points.push({longitude: point[0], latitude: point[1]});
  let grounds = null;
  try {grounds = await groundHeights(points);} catch {grounds = null;}
  const deckHeights = new Map();
  for (const end of [plan.departure, plan.arrival]) {
    if (end?.vertiport) deckHeights.set(end.vertiport, Number(end.deck_height_m) || 0);
  }
  let index = 0;
  const legs = plan.legs.map(leg => ({...leg, path: (leg.path ?? []).map(point => {
    const [longitude, latitude, designed, datum] = point;
    const ground = Number.isFinite(grounds?.[index]) ? grounds[index] : 0;
    index++;
    const deck = deckOf(datum);
    if (deck !== null) {
      const placed = deckTop(deck);
      const base = Number.isFinite(placed) ? placed : ground + (deckHeights.get(deck) ?? 0);
      return [longitude, latitude, base + designed, datum];
    }
    return [longitude, latitude, datum === 'msl' ? designed : ground + designed, datum];
  })}));
  return {...plan, legs, resolved: true};
}

// Metres between two {latitude, longitude}; the same haversine the plan was
// measured with, so a readout never disagrees with the leg it came from.
export function distanceM(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad, dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Degrees clockwise from north, for pointing the aircraft along its path.
export function bearingDeg(a, b) {
  const rad = Math.PI / 180;
  const dLon = (b.longitude - a.longitude) * rad;
  const y = Math.sin(dLon) * Math.cos(b.latitude * rad);
  const x = Math.cos(a.latitude * rad) * Math.sin(b.latitude * rad)
    - Math.sin(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

const place = point => ({longitude: point[0], latitude: point[1], altitude_m: point[2]});

// How far along each point of a leg's path is, and the whole length. A leg
// that stands still — a vertical climb, a charge — has no length, so its
// points are spread evenly in time instead.
export function legMarks(leg) {
  const path = leg?.path ?? [];
  const marks = [0];
  for (let index = 1; index < path.length; index++) {
    marks.push(marks[index - 1] + distanceM(place(path[index - 1]), place(path[index])));
  }
  const total = marks[marks.length - 1] ?? 0;
  return {marks, total};
}

// The point a fraction (0..1) of the way through one leg, and the direction of
// travel there.
export function alongLeg(leg, fraction) {
  const path = leg?.path ?? [];
  if (!path.length) return null;
  if (path.length === 1) return {...place(path[0]), heading_deg: null, index: 0};
  const {marks, total} = legMarks(leg);
  const eased = clamp(fraction, 0, 1);
  // Standing still: walk the points evenly, so a vertical leg still rises.
  const target = total > 0 ? eased * total : eased * (path.length - 1);
  const scale = total > 0 ? marks : marks.map((_, index) => index);
  let index = 1;
  while (index < scale.length - 1 && scale[index] < target) index++;
  const span = scale[index] - scale[index - 1];
  const within = span > 0 ? (target - scale[index - 1]) / span : 0;
  const from = place(path[index - 1]), to = place(path[index]);
  const moved = distanceM(from, to) > 0.01;
  return {
    latitude: from.latitude + (to.latitude - from.latitude) * within,
    longitude: from.longitude + (to.longitude - from.longitude) * within,
    altitude_m: from.altitude_m + (to.altitude_m - from.altitude_m) * within,
    heading_deg: moved ? bearingDeg(from, to) : null,
    index: index - 1,
  };
}

export function totalSeconds(plan) {
  return Number(plan?.totals?.duration_s) || 0;
}

// The leg a given second falls in, and how far through it. Time past the end
// holds on the last leg rather than falling off it.
export function legAt(plan, seconds) {
  const legs = plan?.legs ?? [];
  if (!legs.length) return null;
  const time = clamp(seconds, 0, totalSeconds(plan));
  const index = legs.findIndex(leg => time < leg.end_s);
  const at = index < 0 ? legs.length - 1 : index;
  const leg = legs[at];
  const span = leg.end_s - leg.start_s;
  return {index: at, leg, fraction: span > 0 ? clamp((time - leg.start_s) / span, 0, 1) : 1};
}

// A recorded run: the states the simulation engine produced, read back and
// placed on the terrain. A state says which leg it belongs to and how far
// through it, so the plan's few points are resolved once and every state is
// placed against them — sampling the ground under thousands of states would
// cost more than the flight.
export function readRun(plan, states) {
  const legs = plan?.legs ?? [];
  return (states ?? []).map((state,index) => {
    const before=states[Math.max(0,index-1)],after=states[Math.min(states.length-1,index+1)];
    const dt=after.t-before.t;
    const rate=(key,wrapped=false)=>{
      if(!(dt>0&&dt<=5) || before.kind!==state.kind || after.kind!==state.kind || !Number.isFinite(before[key]) || !Number.isFinite(after[key]))return 0;
      const delta=after[key]-before[key];return (wrapped?((delta+540)%360)-180:delta)/dt;
    };
    const leg = legs[state.leg] ?? legs[legs.length - 1];
    const placed = leg ? alongLeg(leg, state.f) : null;
    return {
      time_s: state.t, leg_index: state.leg, leg_fraction: state.f,
      stage: state.stage, stage_label: leg?.stage_label ?? state.stage, kind: state.kind,
      segment: leg?.segment ?? '', leg_name: leg?.name ?? '',
      color: STAGE_COLORS[state.stage] ?? '#e6f7fb',
      // Longitude and latitude are the engine's; only the height is stood on
      // the ground the display knows.
      position: {latitude: state.latitude, longitude: state.longitude,
        altitude_m: placed ? placed.altitude_m + (Number.isFinite(state.height_error_m) ? state.height_error_m : 0) : state.altitude_m},
      heading_deg: state.heading_deg, pitch_deg: state.pitch_deg, tilt_deg: state.tilt_deg,
      roll_deg: Number.isFinite(state.roll_deg)?state.roll_deg:0,
      roll_rate_deg_s:rate('roll_deg'),pitch_rate_deg_s:rate('pitch_deg'),yaw_rate_deg_s:rate('heading_deg',true),
      // What the rotors were actually turning at, when an engine measured it.
      // Nothing here invents one: a state without rotors carries none, and the
      // display says so by falling back to an indication.
      control_surface_deg: state.control_surface_deg,
      rotor_radps: state.rotor_radps,
      rotor_visual_radps: state.rotor_visual_radps,
      motor_state: state.motor_state,
      rotor_source: state.rotor_source,
      mode: state.mode, speed_mps: state.speed_mps, battery_pct: state.battery_pct,
      charging: state.stage === 'charge',
      airborne: state.kind === 'air' || state.kind === 'vertical',
      passengers: plan?.vehicle?.passengers ?? 0, capacity: plan?.vehicle?.capacity ?? 0,
      distance_done_m: state.distance_done_m,
      remaining_s: Math.max(0, totalSeconds(plan) - state.t),
      done: state.t >= totalSeconds(plan),
    };
  });
}

// A heading between two headings, turned the way an aircraft would turn it.
// Headings are kept as 0 to 360, so two that straddle north — 359 and 1, or
// the 0 and 360 a hovering airframe reports either side of the seam — are one
// degree apart and not three hundred and fifty nine. Mixing them as plain
// numbers whips the nose all the way round the compass; going the short way
// round turns it the degree it actually turned.
export function mixHeading(before, after, within) {
  const from = Number.isFinite(before) ? before : 0;
  const to = Number.isFinite(after) ? after : from;
  const turn = ((to - from + 540) % 360) - 180;
  return ((from + turn * within) % 360 + 360) % 360;
}

// The recorded state at a given second, interpolated between the two the
// engine produced around it. Reading a run is a lookup, not a simulation, so
// scrubbing backwards costs exactly what playing forwards does.
export function sampleRun(recorded, seconds) {
  if (!recorded?.length) return null;
  const total = recorded[recorded.length - 1].time_s;
  const time = clamp(seconds, 0, total);
  let low = 0, high = recorded.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (recorded[middle].time_s < time) low = middle + 1; else high = middle;
  }
  const after = recorded[low];
  const before = recorded[Math.max(0, low - 1)];
  const span = after.time_s - before.time_s;
  if (span <= 0) return {...after, time_s: time};
  const within = clamp((time - before.time_s) / span, 0, 1);
  const mix = (a, b) => a + (b - a) * within;
  // Between two states the vehicle only moves; what it is doing is the state
  // it is in, so the stage and the mode come from one of them rather than
  // being averaged into something that never happened.
  const source = within < 0.5 ? before : after;
  return {
    ...source, time_s: time,
    position: {latitude: mix(before.position.latitude, after.position.latitude),
      longitude: mix(before.position.longitude, after.position.longitude),
      altitude_m: mix(before.position.altitude_m, after.position.altitude_m)},
    heading_deg: mixHeading(before.heading_deg, after.heading_deg, within),
    pitch_deg: mix(before.pitch_deg, after.pitch_deg),
    roll_deg: mix(before.roll_deg??0,after.roll_deg??0),
    roll_rate_deg_s:mix(before.roll_rate_deg_s??0,after.roll_rate_deg_s??0),
    pitch_rate_deg_s:mix(before.pitch_rate_deg_s??0,after.pitch_rate_deg_s??0),
    yaw_rate_deg_s:mix(before.yaw_rate_deg_s??0,after.yaw_rate_deg_s??0),
    control_surface_deg: interpolateSurfaceAngles(before.control_surface_deg,after.control_surface_deg,within),
    tilt_deg: mix(before.tilt_deg, after.tilt_deg),
    rotor_visual_radps: Number.isFinite(before.rotor_visual_radps ?? before.rotor_radps)
      && Number.isFinite(after.rotor_visual_radps ?? after.rotor_radps)
      ? mix(before.rotor_visual_radps ?? before.rotor_radps, after.rotor_visual_radps ?? after.rotor_radps)
      : source.rotor_visual_radps,
    rotor_radps: Number.isFinite(before.rotor_radps) && Number.isFinite(after.rotor_radps)
      ? mix(before.rotor_radps, after.rotor_radps) : source.rotor_radps,
    speed_mps: mix(before.speed_mps, after.speed_mps),
    battery_pct: mix(before.battery_pct, after.battery_pct),
    distance_done_m: mix(before.distance_done_m, after.distance_done_m),
    remaining_s: Math.max(0, total - time),
    done: time >= total,
  };
}

// Everything a display needs at one second of the flight.
export function sampleFlight(plan, seconds) {
  const found = legAt(plan, seconds);
  if (!found) return null;
  const {index, leg, fraction} = found;
  const total = totalSeconds(plan);
  const time = clamp(seconds, 0, total);
  const ground=leg.ground_motion?groundMotionAt(leg.ground_motion,time-leg.start_s):null;
  const pathFraction=ground?.fraction ?? fraction;
  const point = alongLeg(leg, pathFraction);
  const battery = leg.battery_start_pct + (leg.battery_end_pct - leg.battery_start_pct) * fraction;
  // A leg that does not move keeps the heading it arrived with, so the
  // aircraft does not snap north while it hovers or charges.
  let heading = ground ? groundHeadingAt(leg.ground_motion,pathFraction,time-leg.start_s) ?? point?.heading_deg ?? null : point?.heading_deg ?? null;
  for (let back = index; heading === null && back >= 0; back--) {
    heading = alongLeg(plan.legs[back], 1)?.heading_deg ?? null;
  }
  const speed = leg.kind === 'air' || leg.kind === 'ground'
    ? (leg.distance_m > 0 ? leg.speed_mps : 0) : leg.speed_mps;
  const flown = plan.legs.slice(0, index).reduce((sum, item) => sum + item.distance_m, 0)
    + leg.distance_m * pathFraction;
  // Where the rotors point: up in a hover, forward in the cruise, turning
  // through the climb and the descent as the transition runs.
  const tiltFrom = Number(leg.tilt_start_deg) || 0, tiltTo = Number(leg.tilt_end_deg) || 0;
  const tilt = tiltFrom + (tiltTo - tiltFrom) * fraction;
  // The nose follows the path: a climbing leg is nose up, a descending one down.
  const climb = leg.path?.length >= 2
    ? (leg.path[leg.path.length - 1][2] - leg.path[0][2]) : 0;
  const pitch = leg.kind === 'air' && leg.distance_m > 1
    ? clamp(Math.atan2(climb, leg.distance_m) * 180 / Math.PI, -25, 25) : 0;
  return {
    time_s: time, leg_index: index, leg_fraction: pathFraction,
    stage: leg.stage, stage_label: leg.stage_label, kind: leg.kind, segment: leg.segment,
    leg_name: leg.name, color: STAGE_COLORS[leg.stage] ?? '#e6f7fb',
    position: point ? {latitude: point.latitude, longitude: point.longitude, altitude_m: point.altitude_m} : null,
    heading_deg: heading ?? 0,
    speed_mps: leg.stage === 'charge' ? 0 : (ground?.speed ?? speed),
    tilt_deg: tilt,
    pitch_deg: pitch,
    mode: tilt >= 85 ? 'fixed_wing' : tilt <= 5 ? 'multirotor' : 'transition',
    battery_pct: battery,
    charging: leg.stage === 'charge',
    airborne: leg.kind === 'air' || leg.kind === 'vertical',
    passengers: plan.vehicle?.passengers ?? 0,
    capacity: plan.vehicle?.capacity ?? 0,
    distance_done_m: flown,
    remaining_s: Math.max(0, total - time),
    done: time >= total,
  };
}

// Playback of the library's timestamped taxi profile, not another dynamics solver.
export function groundMotionAt(profile,seconds) {
  const {times_s:t,distances_m:d,speeds_mps:v}=profile;
  if(seconds<=t[0])return {fraction:0,speed:0};
  if(seconds>=t[t.length-1])return {fraction:1,speed:0};
  let lo=0,hi=t.length-1;
  while(hi-lo>1){const mid=(lo+hi)>>1;if(t[mid]<=seconds)lo=mid;else hi=mid;}
  const dt=seconds-t[lo],a=(v[hi]-v[lo])/(t[hi]-t[lo]);
  return {fraction:(d[lo]+v[lo]*dt+.5*a*dt*dt)/d[d.length-1],speed:v[lo]+a*dt};
}

export function groundHeadingAt(profile,fraction,seconds) {
  const h=profile.headings_deg,d=profile.distances_m,a=profile.heading_alignment;
  if(!h?.length)return null;
  if(a && seconds<a.duration_s){const t=Math.max(0,seconds)/a.duration_s;return mixHeading(a.from_deg,h[0],t*t*(3-2*t));}
  const distance=clamp(fraction,0,1)*d.at(-1);let lo=0,hi=d.length-1;
  while(hi-lo>1){const m=(lo+hi)>>1;if(d[m]<=distance)lo=m;else hi=m;}
  return mixHeading(h[lo],h[hi],(distance-d[lo])/(d[hi]-d[lo]));
}

// mm:ss, and h:mm:ss once a flight runs past the hour.
export function clock(seconds) {
  const whole = Math.max(0, Math.round(Number(seconds) || 0));
  const parts = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60];
  const pad = value => String(value).padStart(2, '0');
  return parts[0] ? `${parts[0]}:${pad(parts[1])}:${pad(parts[2])}` : `${parts[1]}:${pad(parts[2])}`;
}

export function metres(value) {
  const number = Number(value) || 0;
  return number >= 1000 ? `${(number / 1000).toFixed(2)} km` : `${Math.round(number)} m`;
}

export const speedKph = mps => `${Math.round((Number(mps) || 0) * 3.6)} km/h`;
