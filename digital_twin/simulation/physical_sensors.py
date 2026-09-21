"""Scheduled synthetic sensors over native observations, never aircraft state ownership.

NED navigation, FRD body axes. IMU is specific force and body angular rate;
AHRS is an emulated onboard attitude solution, not a second raw IMU.
"""
import math
import random
from digital_twin.model_library.sensor_calibration import validate_profile
from .physical_sensor_bias import biased_measurement


def body_from_ned(vector, roll, pitch, yaw):
    r,p,y=map(math.radians,(roll,pitch,yaw))
    cr,sr,cp,sp,cy,sy=math.cos(r),math.sin(r),math.cos(p),math.sin(p),math.cos(y),math.sin(y)
    n,e,d=vector
    return (cp*cy*n+cp*sy*e-sp*d,
            (sr*sp*cy-cr*sy)*n+(sr*sp*sy+cr*cy)*e+sr*cp*d,
            (cr*sp*cy+sr*sy)*n+(cr*sp*sy-sr*cy)*e+cr*cp*d)


class PhysicalSensors:
    def __init__(self, model, seed=42):
        self.model=model; self.random=random.Random(seed)
        self.next={key:0.0 for key in model if isinstance(model[key],dict)}
        self.sequence={key:0 for key in self.next}; self.latest={}; self.previous=None
        self.gnss_bias=[self.random.gauss(0,model['gnss']['bias_sigma_m']) for _ in range(3)]
        self.baro_bias=self.random.gauss(0,model['barometer']['bias_sigma_m'])
        self.gnss_outage_until=-1.0
        self.profile=validate_profile(model.get('sensor_profile','stochastic'))

    def sample(self, state, elapsed, utc, phase):
        profile=validate_profile(self.model.get('sensor_profile','stochastic'))
        if profile!=self.profile:
            self.profile=profile;self.latest.clear()
            self.next={key:0.0 for key in self.next}
        demo=profile=='known_bias_v1'
        output=[]; rand=self.random; prior=self.previous
        dt=elapsed-prior[0] if prior else 0.0
        acceleration=[(a-b)/dt for a,b in zip(state['velocity_ned_mps'],prior[1]['velocity_ned_mps'])] if dt>0 else [0.,0.,0.]
        rates=[math.radians((state[k]-prior[1][k]+180)%360-180)/dt for k in ('roll_deg','pitch_deg','heading_deg')] if dt>0 else [0.,0.,0.]
        r,p=math.radians(state['roll_deg']),math.radians(state['pitch_deg'])
        rr,pr,yr=rates
        body_rates=(rr-yr*math.sin(p),pr*math.cos(r)+yr*math.sin(r)*math.cos(p),-pr*math.sin(r)+yr*math.cos(r)*math.cos(p))
        force=body_from_ned((acceleration[0],acceleration[1],acceleration[2]-9.80665),state['roll_deg'],state['pitch_deg'],state['heading_deg'])
        for sensor,due in self.next.items():
            spec=self.model[sensor]
            if elapsed+1e-7<due: continue
            self.next[sensor]=(math.floor((elapsed+1e-7)*spec['hz'])+1)/spec['hz']; self.sequence[sensor]+=1
            if (sensor=='gnss' and elapsed<self.gnss_outage_until) or (not demo and rand.random()<spec['dropout']): continue
            if sensor=='gnss':
                sigma=spec['position_sigma_m']; noise=[rand.gauss(0,s)+b for s,b in zip(sigma,self.gnss_bias)]
                values={'latitude_deg':state['latitude_deg']+noise[0]/111320,
                        'longitude_deg':state['longitude_deg']+noise[1]/(111320*math.cos(math.radians(state['latitude_deg']))),
                        'altitude_ellipsoid_m':state['altitude_m']-noise[2],
                        'velocity_ned_mps':[v+rand.gauss(0,spec['velocity_sigma_mps']) for v in state['velocity_ned_mps']],
                        'fix_type':3,'satellites':18}
                uncertainty={'position_variance_ned_m2':[s*s+spec['bias_sigma_m']**2 for s in sigma],
                             'velocity_variance_m2ps2':[spec['velocity_sigma_mps']**2]*3}
                frame='WGS84_ellipsoid/NED'; units='deg,m,m/s'
            elif sensor=='ahrs':
                values={k:state[k]+rand.gauss(0,spec['sigma_deg']) for k in ('heading_deg','pitch_deg','roll_deg')}
                values['heading_deg']%=360
                uncertainty={'attitude_variance_deg2':[spec['sigma_deg']**2]*3};frame='body_FRD_to_NED';units='deg'
            elif sensor=='barometer':
                height=state['altitude_m']+self.baro_bias+rand.gauss(0,spec['sigma_m'])
                values={'altitude_ellipsoid_m':height,'pressure_pa':101325*(1-height/44330)**5.255,
                        'altitude_method':'emulated datum-calibrated barometric altitude'}
                uncertainty={'altitude_variance_m2':spec['sigma_m']**2+spec['bias_sigma_m']**2};frame='WGS84_ellipsoid_calibrated';units='m,Pa'
            elif sensor=='imu':
                values={'specific_force_mps2':[v+rand.gauss(0,spec['accel_sigma_mps2']) for v in force],
                        'angular_rate_radps':[v+rand.gauss(0,spec['gyro_sigma_radps']) for v in body_rates]}
                uncertainty={'accel_variance_m2ps4':[spec['accel_sigma_mps2']**2]*3,
                             'gyro_variance_rad2ps2':[spec['gyro_sigma_radps']**2]*3};frame='body_FRD';units='m/s^2,rad/s'
            else:
                values={'flight_phase':phase,'tilt_deg':state['tilt_deg'],'rotor_radps':state['rotor_radps'],
                        'grounded':state['grounded'],'route_target_index':state['route_target_index']}
                uncertainty={};frame='onboard_report';units='deg,rad/s'
            if demo:
                biased=biased_measurement(sensor,state,force,body_rates)
                if biased:values,uncertainty=biased
            item={'sensor_id':sensor,'sequence':self.sequence[sensor],'sample_time':utc,'sample_monotonic_s':elapsed,
                  'frame':frame,'units':units,'quality':'valid','values':values,'uncertainty':uncertainty,'nominal_hz':spec['hz']}
            if demo:item['calibration_profile']=profile
            self.latest[sensor]=item;output.append(item)
        self.previous=(elapsed,dict(state))
        return output
