"""Create immutable update values; the caller commits them to the runtime."""
def prepare(entities):
    values = tuple(entities)
    if len({entity.entity_id for entity in values}) != len(values):
        raise ValueError("Duplicate entity IDs in twin update")
    return values
