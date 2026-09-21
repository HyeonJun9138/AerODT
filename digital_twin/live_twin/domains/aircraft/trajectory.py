"""Compatibility alias for shared observation-based projection."""
from importlib import import_module as _import_module
import sys as _sys
_implementation = _import_module("digital_twin.live_twin.kinematics.observed_trajectory")
_sys.modules[__name__] = _implementation
