<div align="center">
  <h1>Busy</h1>

  <a href="https://github.com/MatiSolina/busy/actions/workflows/ultracite.yml"><img alt="CI" src="https://github.com/MatiSolina/busy/actions/workflows/ultracite.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg"></a>
</div>

**Your own team of AI bots, each with memory, tools and its own computer.**

Busy is a self-hosted application for working with durable AI agents from a
browser or a native macOS window. Bots can use files, browse the web, work on a
visible Linux desktop, remember context, run routines and collaborate.

## A computer for every bot

The application has four parts:

```text
busy/
├── apps/hub/            # Web application, APIs and orchestration
├── apps/desktop/        # Electron macOS client
├── templates/bot/       # Eve agent deployed for each bot
├── images/bot-base/     # Linux desktop, browser and document tools
└── skills/busy-setup/   # Self-hosting guide for coding assistants
```

The Hub owns shared application state. Each bot runs as a separate
[Eve](https://github.com/vercel/eve) project on Vercel, with a
[Sandbox](https://vercel.com/docs/sandbox) computer and a persistent
[Drive](https://vercel.com/docs/sandbox/concepts/drives). Desktop loads the same
Hub as the browser.

Read the [architecture guide](docs/architecture.md) for the design decisions
and Vercel components, or the [handbook](docs/handbook.md) for the full setup,
configuration and development reference.

## Quick start

Use Node.js 24.15 or later, the pinned pnpm version and Docker for the local
Postgres example. Fork first if you want to maintain your own installation.

```sh
git clone https://github.com/MatiSolina/busy.git
cd busy
corepack enable
pnpm install --frozen-lockfile
pnpm --filter hub setup:local
pnpm --filter hub hash-password
```

Paste the printed hash into `BUSY_PASSWORD_HASH` in `apps/hub/.env.local`.
`setup:local` generates fresh session secrets; the example username is `owner`.
Keep the hash literal and the environment file private.

Start the disposable database matching the example configuration:

```sh
docker run --name busy-postgres \
  -e POSTGRES_USER=busy -e POSTGRES_PASSWORD=busy -e POSTGRES_DB=busy \
  -p 127.0.0.1:5432:5432 -d postgres:16

cd apps/hub
NODE_OPTIONS=--env-file=.env.local pnpm db:init
cd ../..
pnpm dev
```

Open <http://localhost:3000> and sign in with your configured account.
`db:init` is for a new empty database; see the handbook for upgrades.

> [!NOTE]
> This starts the local Hub. Running bots also requires your own Vercel
> resources, model connection and bot computer image, as described below.

### Deploy your bots

Follow the [setup guide](skills/busy-setup/SKILL.md) to provision a `busy-hub`
project, Postgres, private Blob storage, domains and your own digest-pinned bot
image. The guide covers Sandbox/Drives, Queues, Schedules, AI Gateway and the
required credentials in your Vercel account.

After deploying the Hub, choose your model connection in Settings, create a
bot and verify its first response and computer. Resource usage is billed to
your own accounts. The application uses one shared workspace.

### Run Desktop

With your Hub running:

```sh
BUSY_URL=http://localhost:3000 pnpm --filter busy-desktop start
```

Set `BUSY_URL` to your deployed Hub when using it remotely. The native package
targets macOS on Apple Silicon; see the [Desktop guide](docs/desktop.md) for
packaging and updates.

## Documentation

- [Handbook](docs/handbook.md): installation, configuration, development and operations.
- [Architecture](docs/architecture.md): components, decisions and data flows.
- [Testing](docs/testing.md): local checks, fork CI and optional live evaluations.
- [Hub](apps/hub/README.md): package layout and scripts.

## Community

Use [GitHub Issues](https://github.com/MatiSolina/busy/issues) to report bugs,
share ideas and discuss improvements.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and
[AGENTS.md](AGENTS.md) for development conventions and checks. Bot instructions,
tools and built-in skills live in `templates/bot/agent`.

## Security

Report vulnerabilities through the private channel described in
[SECURITY.md](SECURITY.md). Keep credentials and `.env.local` out of commits.

## License

[Apache 2.0](LICENSE). Third-party material retains its own terms; see
[NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Acknowledgements

Special thanks to **Esteban Suárez ([@EstebanSuarez](https://x.com/EstebanSuarez))**
at **Vercel** for all his support in helping launch Busy.
