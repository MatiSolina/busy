# Contributing to Busy

Start with [README.md](README.md) and [AGENTS.md](AGENTS.md). Package-specific
instructions also live in `apps/hub/AGENTS.md`.
The setup skill is included at [skills/busy-setup/SKILL.md](skills/busy-setup/SKILL.md).

Use Node.js 24.15 or later and the pnpm version pinned in `package.json`:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm quality:doctor
pnpm check:tooling
pnpm check
pnpm lint:next
pnpm typecheck
pnpm test -- --maxWorkers=2
pnpm test:ci-policy
pnpm build
pnpm --filter hub check:runtime
```

Keep changes focused, explain the resulting behavior, and describe the checks
you ran. Use synthetic data in tests and screenshots. Keep environment files,
credentials, generated artifacts, and local agent worktrees out of commits.
Run a secret scan before publishing:

```sh
gitleaks git --redact --no-banner
```

See [docs/code-quality.md](docs/code-quality.md) for scoped checks and database
change rules. Security reports should follow [SECURITY.md](SECURITY.md).

Contributions are provided under the repository's Apache 2.0 license.
