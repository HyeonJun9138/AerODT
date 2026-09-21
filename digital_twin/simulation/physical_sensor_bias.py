"""Simple physical-side measurement errors over an immutable native observation."""
import math
from digital_twin.model_library.sensor_calibration import MODEL as B


def biased_measurement(sensor,state,force,rates):
    floor=B['numerical_variance_floor']
    if sensor=='gnss':
        values={'latitude_deg':state['latitude_deg']+B['north_m']/B['metres_per_degree'],
            'longitude_deg':state['longitude_deg']+B['east_m']/(B['metres_per_degree']*math.cos(math.radians(state['latitude_deg']))),
            'altitude_ellipsoid_m':state['altitude_m']+B['height_m'],
            'velocity_ned_mps':list(state['velocity_ned_mps']),'fix_type':3,'satellites':18}
        uncertainty={'position_variance_ned_m2':[B[k]**2 for k in ('north_m','east_m','height_m')],
            'velocity_variance_m2ps2':[floor]*3}
    elif sensor=='ahrs':
        values={k:state[k]+B[k] for k in ('heading_deg','pitch_deg','roll_deg')};values['heading_deg']%=360
        uncertainty={'attitude_variance_deg2':[B[k]**2 for k in ('heading_deg','pitch_deg','roll_deg')]}
    elif sensor=='barometer':
        height=state['altitude_m']+B['height_m']
        values={'altitude_ellipsoid_m':height,'pressure_pa':101325*(1-height/44330)**5.255,
            'altitude_method':'known_bias_v1 demonstration'}
        uncertainty={'altitude_variance_m2':B['height_m']**2}
    elif sensor=='imu':
        values={'specific_force_mps2':list(force),'angular_rate_radps':list(rates)}
        uncertainty={'accel_variance_m2ps4':[floor]*3,'gyro_variance_rad2ps2':[floor]*3}
    else:return None
    return values,uncertainty
