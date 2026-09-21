"""Select definitions supplied by application composition, not runtime state.

This is the Model Setup step: which model the twin runs for a kind of object,
and with which parameters. The estimation models an operator may choose are
declared in the model library beside the parameters they share; choosing one is
the application's decision and arrives here as an id.
"""
import json
from pathlib import Path

# What the twin does with aircraft observations when nothing has been chosen:
# fill the gaps between them with the default model, and offer no predicted
# path until a display asks for one.
DEFAULT_ESTIMATION = {"enabled": True, "model": None, "prediction": False, "prediction_seconds": 15.0,
                      # None means the prediction follows whatever the estimator runs.
                      "prediction_model": None,
                      # A UAM is a different prediction with its own models and its
                      # own horizon; off unless the operator asks for it.
                      "uam_prediction": False, "uam_prediction_seconds": 60.0,
                      "uam_prediction_model": None}


def load_definitions():
    path = Path(__file__).resolve().parents[3] / "model_library/motion_models/catalog.json"
    return json.loads(path.read_text(encoding="utf-8"))


def select_model(kind, definitions):
    return definitions[kind], definitions[kind].get('visual_asset_id', f"generic_{kind}")


def aircraft_models(definitions):
    """The estimation models an operator may choose for aircraft, in order."""
    declared = definitions.get("aircraft_models") or []
    return [dict(model) for model in declared if model.get("model_id")]


def aircraft_model(definitions, model_id=None):
    """Aircraft parameters with the chosen model's own values applied.

    An unknown or missing id falls back to the model the definitions name, so a
    stored choice that no longer exists still produces a working estimator
    rather than an error at the tick.
    """
    base = dict(definitions["aircraft"])
    declared = aircraft_models(definitions)
    chosen = next((model for model in declared if model["model_id"] == model_id), None)
    if chosen is None:
        chosen = next((model for model in declared if model["model_id"] == base.get("model_id")), None)
    return {**base, **(chosen or {})}


def estimation_policy(policy=None):
    """A complete estimation policy from whatever part of one was given."""
    given = policy() if callable(policy) else policy
    return {**DEFAULT_ESTIMATION, **(given or {})}
