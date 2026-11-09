# Vercel CI

Vercel CI validates the repository on the Vercel team where you enable it.
Turborepo remains the source of truth for dependencies and affected-task
selection.

## Enabled checks

- Repository: strict Ultracite check, tooling configuration, Ultracite Doctor, and the GitHub CI planning/result-policy tests.
- Hub: lint, Next.js lint, tests, typecheck, production build, and the traced-runtime check.
- Landing: lint, typecheck, and build.
- Bot template: lint, tests, typecheck, and `eve build --skip-sandbox-prewarm`.
- Bot base image: its existing shell/Python contract tests through `test:ci`. The CI wrapper uses checksum-pinned Tini 0.19.0 as a Linux subreaper, so orphaned fixture daemons are reaped even when the container PID 1 does not reap them. Test assertions and timeouts are unchanged. This does not build or push the Docker image.

The tagged tasks use Ubuntu 24.04, matching the Linux assumptions in the existing workflows and providing Python for the image contract tests. Vercel CI installs dependencies once with `pnpm install --frozen-lockfile --ignore-scripts`, as the GitHub setup does, then downloads the checksum-pinned subreaper into the repository snapshot. The lockfile and package-manager version stay pinned.

The Hub build and runtime check receive the same non-secret `VERCEL=1` and synthetic `VERCEL_DEPLOYMENT_ID=dpl_ci_runtime_check` values as GitHub Actions. No production credentials, database, provider keys, or deployment permissions are required. The runtime check depends on the build and remains uncached so it checks the traced files even when a build is restored from cache.

## Checks retained outside Vercel CI

- Desktop tests remain in the existing macOS GitHub Actions job; `busy-desktop#test` explicitly opts out with `!ci`. Vercel CI currently provides Linux only.
- UI performance comparison remains in GitHub Actions. It starts PostgreSQL and Chromium, checks out and builds a baseline, and compares two running servers; that service-based setup is a separate migration.
- The manually dispatched CI benchmark remains in GitHub Actions.
- Persistent development servers, desktop packaging, production deployment, evaluations that call providers, and working-tree/staged-file checks are not CI targets.

Existing GitHub workflows and required-check rules are unchanged. Keep them while comparing Vercel CI coverage; switch required checks only after reviewing successful Vercel CI runs. A successful build preview alone is not a successful test run.

## Inspect a run

From a clone of this repository:

```sh
pnpm exec vercel ci list --scope <team-slug>
pnpm exec vercel ci inspect <run-id> --scope <team-slug>
pnpm exec vercel ci logs <run-id> --failed --scope <team-slug>
```

CI is enabled before pushing the setup branch, because a push is what creates the run. Each task's status and logs must be inspected before treating the pipeline as passed.

References: [Vercel CI](https://vercel.com/docs/ci), [migration guide](https://vercel.com/kb/guide/github-actions-to-vercel-ci), [images](https://vercel.com/docs/ci/image).
