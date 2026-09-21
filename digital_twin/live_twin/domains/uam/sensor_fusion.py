"""Received sensor state estimation; the World snapshot owns the filter posterior."""
from digital_twin.contracts.live import TwinEntity,SurfaceReference,DisplayObservation
from digital_twin.live_twin.domains.uam.sensor_covariance import expand
from hashlib import sha256
from digital_twin.contracts.prediction import PredictionWaypoint,UamPredictionIntent
from digital_twin.live_twin.domains.uam.sensor_alignment import aligned_state


def estimate(record,target,previous=None,settings=None):
    result=aligned_state(record,target,previous,settings)
    if result is None:return None
    p=record['packet'];sensors=record.get('aligned_sensors',p['sensors']);vehicle=sensors.get('vehicle',{}).get('values',{})
    lat,lon,alt=result['geodetic'];angles=result['attitude'];ref=p.get('surface_reference')
    operations=p.get('operations') or {};instruction=operations.get('instruction') or {}
    state=result['posterior'];surface=SurfaceReference(ref['vertiport_id'],ref['altitude_m']) if ref else None
    # Publish the accepted observation separately from current-time extrapolation.
    # Held/rejected fixes keep their identity; no truth or extra navigation state.
    observed_position=tuple(a+b for a,b in zip(state.anchor,expand(state.position,state.axes)))
    signature=sha256(repr(state.signature).encode()).hexdigest()[:12]
    context=p['process_id']+':'+p['mission_id']+':'+str(record['continuity'])+':'+signature+':'+str(state.display_epoch)
    pose=DisplayObservation(state.motion_time_s if state.motion_time_s is not None else state.time-state.clock_offset_s,state.time,context,
        'physical' if state.motion_time_s is not None else 'utc',observed_position,expand(state.velocity,state.axes),
        *(state.attitude if state.attitude else (None,None,None)),vehicle.get('tilt_deg'),vehicle.get('rotor_radps'),surface)
    return TwinEntity(entity_id='physical:'+p['aircraft_id'],name=p['aircraft_id'],kind='uam',
        position_ecef_m=result['position'],velocity_ecef_mps=result['velocity'],latitude_deg=lat,longitude_deg=lon,altitude_m=alt,
        heading_deg=angles[0] if angles else None,state_time=target,observation_time=result['observed'],
        received_time=record['received_time'],orbit_epoch=None,derivation='estimated',quality=result['quality'],
        source='physical_uam',model_id='uam_covariance_alignment_v1',visual_asset_id='projectairsim_airtaxi',
        provenance='physical_emulation',orientation_source='attitude' if angles else 'unavailable',
        valid_until=result['valid_until'],continuity_id=record['continuity'],discontinuity=result['discontinuity'],
        pitch_deg=angles[1] if angles else None,roll_deg=angles[2] if angles else None,
        tilt_deg=vehicle.get('tilt_deg'),rotor_radps=vehicle.get('rotor_radps'),flight_phase=vehicle.get('flight_phase'),
        ground_waiting=operations.get('ground_waiting') is True,
        ground_action=instruction.get('action') if instruction.get('action') in ('ground_wait','ground_taxi') else None,
        surface_reference=surface,display_observation=pose,
        estimation=result['diagnostics'],estimation_state=result['posterior'])


def prediction_intent(entity,record):
    p=record['packet'];raw=p['intent'];policy=raw.get('policy',{})
    points=tuple(PredictionWaypoint(tuple(w['start']),tuple(w['end']),w['speed_mps'],w['phase']) for w in raw['waypoints'])
    fields={'approach_speed_mps':'approach_horizontal_speed_mps','brake_mps2':'approach_brake_mps2'}
    for name in ('max_speed_mps','climb_rate_mps','descent_rate_mps','landing_rate_mps','hold_speed_mps','reverse_speed_mps','reverse_transition_s','reverse_margin_m','wing_recover_mps'):fields[name]=name
    return UamPredictionIntent(entity.entity_id,entity.state_time,p['mission_id'],raw['phase'],points,int(raw['target_index']),
                               **{key:policy[value] for key,value in fields.items() if value in policy})
