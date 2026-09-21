"""Domain import for the checksum-bound UAM route runtime.

The audited implementation remains at ``ai_pnp/uam_route_model.py`` because
released model manifests bind both that path and its exact file hash.
"""
from importlib import import_module as _import_module
import sys as _sys
_implementation = _import_module("ai_pnp.uam_route_model")
_sys.modules[__name__] = _implementation
