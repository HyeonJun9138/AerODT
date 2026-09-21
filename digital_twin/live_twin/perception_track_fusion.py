"""Reserved contract. Single-source ID association is not perception/fusion."""
from digital_twin.contracts.live import ExtensionOutcome


def process(observations):
    return ExtensionOutcome()
