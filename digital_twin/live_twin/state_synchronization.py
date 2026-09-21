"""Compatibility import for the cross-domain live-twin composer.

New code imports ``digital_twin.live_twin.composition.state_synchronization``
directly. This alias preserves the historical module object during migration.
"""
from importlib import import_module as _import_module
import sys as _sys

_implementation = _import_module("digital_twin.live_twin.composition.state_synchronization")
_sys.modules[__name__] = _implementation
