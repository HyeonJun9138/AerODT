"""Versioned representative energy parameters, independent of runtime state."""
import json
from functools import lru_cache
from pathlib import Path
from copy import deepcopy


@lru_cache(maxsize=1)
def _definition():
    path = Path(__file__).parent / 'packages/vehicles/air/tiltrotor_uam/aerodt_airtaxi/energy.json'
    return json.loads(path.read_text(encoding='utf-8'))


def energy_profile(seats=4):
    profile = deepcopy(_definition())
    cabin = next((size for size in (2, 4, 6, 8) if size >= seats), 8)
    profile['capacity_kwh'] = profile['capacity_kwh_by_seats'][str(cabin)]
    return profile
