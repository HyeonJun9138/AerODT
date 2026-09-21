"""Compatibility entry point for ``ai_pnp.domains.uam.flying_object_detection``."""
import runpy as _runpy

if __name__ == "__main__":
    _runpy.run_module("ai_pnp.domains.uam.flying_object_detection", run_name="__main__")
else:
    from importlib import import_module as _import_module
    import sys as _sys
    _implementation = _import_module("ai_pnp.domains.uam.flying_object_detection")
    _sys.modules[__name__] = _implementation
