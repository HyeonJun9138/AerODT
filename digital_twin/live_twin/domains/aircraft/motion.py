"""Compatibility alias for shared ECEF kinematics."""
from importlib import import_module as _import_module
import sys as _sys
_implementation = _import_module("digital_twin.live_twin.kinematics.motion")
_sys.modules[__name__] = _implementation
