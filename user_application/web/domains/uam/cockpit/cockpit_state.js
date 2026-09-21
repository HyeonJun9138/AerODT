import {flightClock,flightTiming,groundSpeed} from './cockpit_flight_progress.js';
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const identifier=value=>typeof value==='string'?value.replace(/^(scenario|physical):/,''):null;
const text=value=>typeof value==='string'&&value?value:undefined;

// Pure display adapter. The caller supplies the displayed, unlifted geodetic
// position and sampled attitude. Operational detail and velocity have distinct
// clocks and are deliberately not passed off as that interpolated snapshot.
export function cockpitInstrumentState({entity={},display={},stateTime,epoch,missionDetail,nearby,stale,resolveWaypoint,clock}={}) {
  const output={...entity};
  for(const key of ['latitude_deg','longitude_deg','altitude_m','heading_deg'])output[key]=finite(display[key])?display[key]:undefined;
  for(const key of ['pitch_deg','roll_deg','tilt_deg','rotor_radps'])output[key]=finite(entity[key])&&finite(display[key])?display[key]:undefined;
  output.velocity_reference='latest_observation';
  output.vertical_speed_mps=finite(entity.vertical_speed_mps)?entity.vertical_speed_mps:undefined;
  const velocity=entity.velocity_ecef_mps;
  if(!finite(output.vertical_speed_mps)&&Array.isArray(velocity)&&velocity.length===3&&velocity.every(finite)&&finite(entity.latitude_deg)&&finite(entity.longitude_deg)){
    const lat=entity.latitude_deg*Math.PI/180,lon=entity.longitude_deg*Math.PI/180;
    output.vertical_speed_mps=velocity[0]*Math.cos(lat)*Math.cos(lon)+velocity[1]*Math.cos(lat)*Math.sin(lon)+velocity[2]*Math.sin(lat);
  }
  const detailId=identifier(missionDetail?.state?.aircraft_id);
  const detail=detailId&&detailId===identifier(entity.entity_id)?missionDetail:null;
  const state=detail?.state??{},flight=detail?.flight??{};
  output.airborne=typeof state.airborne==='boolean'?state.airborne:entity.airborne;
  output.ground_speed_mps=groundSpeed(entity);
  const telemetry={rotor_radps:output.rotor_radps,tilt_deg:output.tilt_deg,
    flight_phase:text(entity.flight_phase),mode:text(state.flight_mode_label)||text(state.flight_mode),
    battery_soc_pct:finite(state.battery_pct)?state.battery_pct:undefined};
  const mission={origin:text(flight.origin_name)||text(flight.origin)||text(state.origin),origin_id:text(flight.origin)||text(state.origin),origin_name:text(flight.origin_name),
    timing:flightTiming(detail,flightClock(clock,stateTime)),destination:text(flight.destination_name)||text(flight.destination)||text(state.destination),destination_id:text(flight.destination)||text(state.destination),destination_name:text(flight.destination_name),
    next_waypoint:text(state.next_waypoint),phase:text(state.phase),holding:state.holding===true||state.instruction?.clearance==='hold',route_points:[]};
  const ids=flight.route_path;
  if(Array.isArray(ids)&&ids.length>=2&&ids.length<=4096&&typeof resolveWaypoint==='function'){
    const points=ids.map(id=>typeof id==='string'?resolveWaypoint(id):null);
    if(points.every(p=>finite(p?.latitude_deg)&&finite(p?.longitude_deg)))mission.route_points=points.map((p,i)=>({id:ids[i],name:/^rn-/.test(p.name??ids[i])?`WP ${i+1}`:(p.name??ids[i]).replace(/^fato:/,'FATO ').replaceAll(':',' / '),latitude_deg:p.latitude_deg,longitude_deg:p.longitude_deg}));
  }
  const observation=entity.observation_time;
  return {entity:output,telemetry,mission,stateTime,epoch,nearby,
    stale:Boolean(stale||entity.stale||entity.quality==='stale'),
    speedNote:`최신 관측${finite(observation)?` ${observation.toFixed(1)}s`:' 시각 미수신'}`,
    systemNote:detail?'모드 / 임무: 최근 조회':'모드 / 임무: 미수신',
    nearbyNote:'주변 교통: 최신 관측'};
}
