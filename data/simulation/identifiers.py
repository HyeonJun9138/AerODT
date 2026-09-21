"""How a newly created record is named.

The stored sets are numbered — VP001 for a vertiport, WP001 for a route
waypoint — and a new record carries on that numbering rather than starting a
second, unreadable style beside it.

A number is never handed out twice, even after the record holding it is
deleted. The id is the thread every other stored thing hangs from: a saved
flight names `deck:VP007`, a route link names `fato:VP007:F1`, a demand setup
names VP007 in its pairs and its fleet. Give VP007 to a different vertiport and
all of those quietly point somewhere else. So each store keeps the highest
number it has ever issued and counts on from there, which is why the count is
saved to disk alongside the records rather than worked out from them.

Ids already on disk are never rewritten. A set imported from elsewhere keeps
whatever it brought; this only decides what the next locally made record is
called.
"""
import re
import secrets

# The width the existing sets are written at; a set that outgrows it simply gets
# longer (VP1000) rather than being renumbered.
DIGITS = 3


def number_of(prefix, identifier):
    """The number in `prefix`+digits, or 0 for an id written any other way."""
    found = re.match(rf"^{re.escape(prefix)}(\d+)$", str(identifier or ""))
    return int(found.group(1)) if found else 0


def highest(prefix, existing):
    return max((number_of(prefix, item) for item in existing), default=0)


def numbered(prefix, existing, *, issued=0, digits=DIGITS):
    """The next `prefix` + number, above every one in `existing` and above
    `issued` — the highest the store has ever handed out, including numbers
    whose records have since been deleted."""
    taken = {str(item or "") for item in existing}
    candidate = max(highest(prefix, taken), issued) + 1
    # Nothing should already hold the next number, but a hand-edited file could;
    # step past anything that is there rather than handing out a duplicate.
    while f"{prefix}{candidate:0{digits}d}" in taken:
        candidate += 1
    return f"{prefix}{candidate:0{digits}d}"


def random_id(prefix):
    """The old style, kept for the sets that have no numbering to carry on."""
    return f"{prefix}-{secrets.token_hex(4)}"
