"""Compatibility import for the aircraft live-twin implementation.

New code imports ``digital_twin.live_twin.domains.aircraft.gru_prediction`` directly.  This alias preserves the historical
module object as well as its monkey-patching behaviour during migration.
"""
from importlib import import_module as _import_module
import sys as _sys

_implementation = _import_module("digital_twin.live_twin.domains.aircraft.gru_prediction")
_sys.modules[__name__] = _implementation
