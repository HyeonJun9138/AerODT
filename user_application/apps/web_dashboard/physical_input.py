"""Compatibility import for the UAM dashboard input implementation.

New code imports ``user_application.apps.web_dashboard.domains.uam.input.physical_input`` directly.  This alias preserves the historical
module object as well as its monkey-patching behaviour during migration.
"""
from importlib import import_module as _import_module
import sys as _sys

_implementation = _import_module("user_application.apps.web_dashboard.domains.uam.input.physical_input")
_sys.modules[__name__] = _implementation
