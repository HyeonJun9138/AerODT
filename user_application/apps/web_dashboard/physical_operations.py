"""Compatibility import for the UAM dashboard operations implementation.

New code imports ``user_application.apps.web_dashboard.domains.uam.operations.physical_operations`` directly.  This alias preserves the historical
module object as well as its monkey-patching behaviour during migration.
"""
from importlib import import_module as _import_module
import sys as _sys

_implementation = _import_module("user_application.apps.web_dashboard.domains.uam.operations.physical_operations")
_sys.modules[__name__] = _implementation
