import pytest

from digital_twin.model_library.uam_energy import energy_profile
from digital_twin.simulation.uam_energy import BatteryState, demand_kw, charge_step


def test_hover_load_and_size_cost_more_than_cruise():
    small, large = energy_profile(2), energy_profile(8)
    cruise = demand_kw(small, 'cruise', 50, 0, 90, 1)
    assert demand_kw(small, 'hold', 0, 0, 0, 1) > cruise
    assert demand_kw(large, 'hold', 0, 0, 0, 8) > demand_kw(small, 'hold', 0, 0, 0, 2)
    assert demand_kw(small, 'takeoff', 0, 3, 0, 2) > demand_kw(small, 'takeoff', 0, 3, 0, 0)


def test_consumption_and_shortfall_balance_without_negative_soc():
    battery = BatteryState(energy_profile(4), soc_pct=1)
    battery.discharge(360, 60)
    assert battery.soc_pct == 0
    assert battery.used_kwh == pytest.approx(6)
    assert battery.deficit_kwh == pytest.approx(4.9)
    assert battery.snapshot()['policy'] == 'record_only'


def test_charge_tapers_conserves_energy_and_is_step_invariant():
    profile = energy_profile(4)
    low, grid_low = charge_step(profile, 40, 60, target=100)
    high, grid_high = charge_step(profile, 95, 60, target=100)
    assert low - 40 > high - 95 > 0
    assert grid_low > (low-40)/100*profile['capacity_kwh']
    whole, grid = charge_step(profile, 75, 1000, target=100)
    soc, total = 75, 0
    for _ in range(1000):
        soc, energy = charge_step(profile, soc, 1, target=100)
        total += energy
    assert whole == pytest.approx(soc, abs=1e-8)
    assert grid == pytest.approx(total, abs=1e-8)
    assert charge_step(profile, 100, 100, target=95) == (100, 0)
    assert charge_step(profile, 0, 100000, target=95)[0] == 95


def test_charging_uses_pack_limit_and_does_not_erase_discharge_history():
    battery = BatteryState(energy_profile(2), soc_pct=20)
    battery.discharge(100, 60)
    used = battery.used_kwh
    battery.charge(60)
    assert battery.used_kwh == used
    assert 0 < battery.charged_kwh < battery.grid_kwh
    assert battery.charge_power_kw <= battery.profile['capacity_kwh'] * battery.profile['max_charge_c']
