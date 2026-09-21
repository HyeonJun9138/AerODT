"""Compatibility alias for ``ai_pnp.domains.uam.risk_prediction``."""
from importlib import import_module as _import_module
import sys as _sys
_implementation = _import_module("ai_pnp.domains.uam.risk_prediction")
_sys.modules[__name__] = _implementation
