# Korea UAM example network

This directory contains the versioned inputs used by the default AeroDT UAM
demonstration. They are source fixtures, not runtime logs.

- `vertiports.json`: 19 vertiports grouped as 18 Seoul metropolitan-area sites and 1 Ulsan test site
- `routes.json`: 138 route nodes and 270 directed links
- `examples/fpl_all.csv`: 1,825-flight example schedule

The directory keeps its historical `seoul_uam` name for compatibility with
existing first-start seeding code. The restored definitions themselves retain
the authored `수도권` and `울산` groups.

The dashboard copies a file to `data/workspace/simulation` only when the
corresponding workspace file is absent. Existing operator edits are never
overwritten. Runtime recordings, caches and generated runs remain in the
ignored workspace.
