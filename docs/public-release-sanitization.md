# Public release boundary

This tree is the first public release snapshot. It contains the application
source, tests, migrations, setup instructions, and reusable skills. Private
deployment evidence and local machine artifacts are intentionally omitted from
the public snapshot.

The source checkout may contain local files that must never be copied into this
tree, including `.env.local`, `.vercel/`, `.deepsec/`, `node_modules/`, build
outputs, browser profiles, and generated audit reports. Recreate credentials in
your own environment by following the setup guide; no credentials or connection
strings for the maintainer's deployment are part of this release.

Historical production QA, deployment identifiers, internal review threads,
private worktree paths, and screenshots captured from an authenticated account
are not part of the public release. They remain available only in the private
repository when needed for internal maintenance.

## Sanitization manifest

- 13 private evidence, review, planning, audit, screenshot, and historical
  performance artifacts were omitted.
- 1 acceptance document was rewritten as a reproducible local checklist.
- 7 operational documents were generalized to use the cloner's own hub,
  deployment, provider, and synthetic test values.

The omission is intentional: these artifacts describe one private account or
one local machine and do not help a new operator install or run the software.
The source repository retains them for private maintenance; this public tree
contains no copy of their identifiers or contents.
