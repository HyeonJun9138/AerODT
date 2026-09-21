# ADR 0081: Choose nearby resource holding positions

Date: 2026-09-14
Status: source updated; existing server processes are not restarted

## Decision

The resource-hold radius defaults to a 400–600 m region around the destination
vertiport, replacing the 1,500 m default. `hold_radius_m` is the upper bound of
the preferred inner region, rather than a mandatory excursion to its rim.
The native call now reads that policy value instead of a bound function default.
An explicit wait-scaled radius uses the same selection rule. The existing
400 m hard floor and operator minimum are both respected.

On each allowed bearing, project the approach-entry position onto the permitted
radial interval. Rank available positions by estimated horizontal/vertical
transfer time. Keep existing corridor-bearing exclusions, slot ownership,
altitude tiers and 600 m outer-ring fallback. Also compare reserved coordinates
using the existing horizontal/vertical traffic margins; a different slot ID or
requested radius must not hide an occupied physical position.

This does not change the short-final tactical separation manoeuvre, native
controller, actual aircraft pose, PSU clearance gates, or any wire/API shape.
Existing saved 1,500 m settings on both deployments are changed to 600 m;
other settings and unrelated source changes are retained.

## Evidence and limits

Six regressions cover nearby selection, policy values, corridor exclusion,
geometric reservations, 80 distinct waiting positions and the hard floor.
Canonical remote related tests: 99 passed. Local Physical mirror: 97 passed;
two dashboard tests cannot open its missing visual-assets catalog.

With native physics and the same 240 s temporary approach closure, both
versions complete the flight. The hold radius changes from 1,500 to 600 m;
touchdown and gate arrival occur 80 s earlier (gate completion 932 → 852 s).
The aircraft reaches the holding point 6 s later in this fixture; this is a
measured return improvement, not a universal reduction of every manoeuvre.

Allocated waiting-point separation does not prove clearance along all transfer
paths. No new full-fleet replay or actual Unreal mission evidence is claimed.
The repository's complete mission-validation requirement remains outstanding.
Source/settings updates require a subsequent Python server restart to take
effect; this change does not interrupt an active Simulation or Physical run.
