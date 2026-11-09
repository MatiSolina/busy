# Bot base image

Every bot computer starts from a digest-pinned Linux image. The image is
operator-owned infrastructure: a public Busy clone must publish its own image
and configure the hub to use it. The repository never falls back to a private
image from another Busy deployment.

## Build and publish an image

The script requires the destination repository explicitly. Log in to the
Vercel Container Registry for the team that owns the hub, then run:

```sh
BOT_BASE_IMAGE_REPOSITORY='vcr.vercel.com/your-team/busy-hub/bot-base' \
  images/bot-base/push.sh v9
```

The command prints a digest-pinned `BOT_BASE_IMAGE` value. Grant the bot
projects read access to that registry repository as required by your Vercel
team. Keep the previous digest available until existing bot sessions have been
recreated; a running session keeps the image it was created with.

## Configure the hub

Set `BOT_BASE_IMAGE` in the hub's deployment environment to the complete digest
printed by the image push, for example:

```text
BOT_BASE_IMAGE=vcr.vercel.com/<team>/<project>/bot-base@sha256:<64-hex-digest>
```

The hub copies this value into each bot project before its deployment build.
Missing configuration fails the bot build with an actionable error instead of
silently using an image from another operator. The image must contain the
runtime wrappers checked by `templates/bot/agent/sandbox.ts` and the ABI marker
expected by `templates/bot/agent/lib/computer-image.ts`.

The image push is an explicit operator action. Nothing in a normal hub build,
bot creation, or public clone uploads an image to a registry automatically.
