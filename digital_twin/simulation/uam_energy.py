"""Read-only flight coupling: energy demand never changes propulsion or goals.

SOC-domain charge taper is analytically integrated so results do not depend on
UI refresh rate or time acceleration. The owner calls it once per scenario step.
"""
import math


def demand_kw(profile, phase, speed_mps, climb_mps, tilt_deg, passengers):
    if phase == 'parked':
        return 0.0  # Powered down; connected ground loads belong to charging.
    scale = profile['capacity_kwh'] / profile['reference_capacity_kwh']
    power = profile['power_kw'].get(phase, profile['power_kw']['hold']) * scale
    if phase in ('gate_in', 'gate_out'):
        return power if speed_mps > .05 else profile['auxiliary_kw']
    mass = profile['reference_mass_kg'] * scale
    load = max(.7, (mass + profile['passenger_mass_kg'] *
                   (passengers-profile['reference_passengers']*scale)) / mass)
    # A slow/rotors-up cruise or approach is not an efficient wingborne cruise.
    if phase in ('cruise', 'descent', 'climb'):
        wing = min(1.0, max(0.0, tilt_deg/90)) * min(1.0, max(0.0, speed_mps/25))
        drag = max(.6, min(2.0, .4+.6*(max(0, speed_mps)/profile['reference_cruise_mps'])**3))
        power = wing*power*drag + (1-wing)*profile['power_kw']['hold']*scale
    # The reference takeoff/climb powers already include nominal ascent.
    excess_climb = max(0.0, climb_mps-3.0)
    return power * load**1.5 + mass*9.80665*excess_climb/850


def charge_step(profile, soc, seconds, target=None):
    """Return (SOC, grid kWh); gross charging less onboard auxiliary load.

    Constant power below knee, linearly tapering power in SOC above it (an
    approximation of CC/CV, not a cell-voltage/BMS model). Stops at target.
    """
    target = profile['charge_target_pct'] if target is None else min(100, max(0, target))
    if seconds <= 0 or soc >= target:
        return soc, 0.0
    capacity, eta = profile['capacity_kwh'], profile['charge_efficiency']
    gross = min(profile['charger_kw'] * eta, capacity * profile['max_charge_c'])
    aux = profile['auxiliary_kw']
    if gross * profile['taper_end_fraction'] <= aux:
        return soc, 0.0
    rate = 100/(capacity*3600)
    start, active_s = soc, 0.0
    knee = profile['taper_start_pct']
    if soc < knee:
        dt = min(seconds, (min(knee, target)-soc)/(rate*(gross-aux)))
        soc += dt*rate*(gross-aux)
        seconds -= dt
        active_s += dt
    if seconds > 0 and soc < target:
        slope = (1-profile['taper_end_fraction'])/(100-knee)
        equilibrium = knee+(1-aux/gross)/slope
        k = rate*gross*slope
        dt = min(seconds, math.log((equilibrium-soc)/(equilibrium-target))/k)
        soc = equilibrium-(equilibrium-soc)*math.exp(-k*dt)
        active_s += dt
    soc = min(target, soc)
    grid_kwh = ((soc-start)/100*capacity+aux*active_s/3600)/eta
    return soc, grid_kwh


class BatteryState:
    def __init__(self, profile, soc_pct=100):
        self.profile = profile
        self.soc_pct = max(0.0, min(100.0, soc_pct))
        self.used_kwh = self.charged_kwh = self.grid_kwh = self.deficit_kwh = 0.0
        self.power_kw = self.charge_power_kw = 0.0
        self.charge_state = 'disconnected'
        self.connection = None
        self.parked_at = None
        self.flight_id = None
        self.last_sample_s = -math.inf
        self.last_phase = None
        self.warned = set()
        self.flight_start_used = self.flight_start_deficit = 0.0
        self.flight_start_charged = self.flight_start_grid = 0.0

    def discharge(self, power_kw, seconds):
        demand = max(0, power_kw)*max(0, seconds)/3600
        remaining = self.soc_pct/100*self.profile['capacity_kwh']
        self.used_kwh += demand
        self.deficit_kwh += max(0, demand-remaining)
        self.soc_pct = max(0, remaining-demand)/self.profile['capacity_kwh']*100
        self.power_kw, self.charge_power_kw = max(0, power_kw), 0.0

    def charge(self, seconds):
        previous = self.soc_pct
        self.soc_pct, grid = charge_step(self.profile, previous, seconds)
        stored = (self.soc_pct-previous)/100*self.profile['capacity_kwh']
        self.charged_kwh += stored
        self.grid_kwh += grid
        self.charge_power_kw = stored*3600/seconds if seconds > 0 else 0.0
        self.power_kw = -self.charge_power_kw

    def snapshot(self):
        p = self.profile
        return {'model_id': p['model_id'], 'basis': 'representative_estimate', 'policy': 'record_only',
                'soc_pct': round(self.soc_pct, 3), 'capacity_kwh': p['capacity_kwh'],
                'remaining_kwh': round(self.soc_pct/100*p['capacity_kwh'], 4),
                'power_kw': round(self.power_kw, 3), 'charge_power_kw': round(self.charge_power_kw, 3),
                'used_kwh': round(self.used_kwh, 5), 'charged_kwh': round(self.charged_kwh, 5),
                'grid_kwh': round(self.grid_kwh, 5), 'deficit_kwh': round(self.deficit_kwh, 5),
                'flight_used_kwh': round(self.used_kwh-self.flight_start_used, 5),
                'flight_deficit_kwh': round(self.deficit_kwh-self.flight_start_deficit, 5),
                'flight_charged_kwh': round(self.charged_kwh-self.flight_start_charged, 5),
                'flight_grid_kwh': round(self.grid_kwh-self.flight_start_grid, 5),
                'charge_state': self.charge_state, 'target_pct': p['charge_target_pct'],
                'warning': 'depleted' if self.soc_pct <= 0 else 'critical' if self.soc_pct <= p['critical_pct']
                           else 'low' if self.soc_pct <= p['low_pct'] else 'normal'}
