"""Compatibility import; UAM routes now live in ``communication.web.domains.uam.operating_context_routes``."""
from importlib import import_module as _import_module
import sys as _sys

_implementation = _import_module("communication.web.domains.uam.operating_context_routes")
_sys.modules[__name__] = _implementation
