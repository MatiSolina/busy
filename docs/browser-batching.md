# Visible browser batching

Busy exposes the deferred `browser__batch` tool for short, already-known sequences over the one
managed, headed Chrome session. A batch is declarative: it contains a bounded
list of supported actions (`open`, navigation, `snapshot`, `click`, `fill`,
typing, selection, waits, reads from the visible page, tabs and screenshots).
It cannot contain JavaScript, direct URL reads, shell commands, storage access,
or arbitrary agent-browser arguments. The standalone `browser__eval` and
`browser__read` tools remain disabled.

Because the batch schema is intentionally deferred, discover the exact tool
with `eve__search` and invoke it through `eve__tool` when a short sequence is
already known.

The input is validated in Eve and again by `/usr/local/bin/browser` before the
desktop lease or Chrome is touched. The wrapper accepts at most 12 steps, 30
seconds by default (120 seconds hard maximum), and 24,000 response characters.
The wrapper owns the `busy-live` session and forces the headed CDP handoff; a
batch cannot select another endpoint or hidden browser.

Each step runs while the existing desktop action lock is held. Before every
step the wrapper checks the managed-browser generation, the desktop-control
generation and an active human lease. A changed generation or takeover stops
the batch before another action is sent. Ref-based actions still require a
fresh snapshot; navigation and waits invalidate the observation boundary.

The response includes the requested and executed counts, every attempted step's
status, `partialSideEffects`/`sideEffectsPossible`, the stop reason, limits and
a separately reported final snapshot. The final snapshot is not counted as a
requested step. If it fails, successful evidence is retained and the recovery
message tells the model to snapshot first and not repeat successful or unknown
actions. Output truncation is explicit; screenshot paths and inline image files
are retained for the channel while the model receives a bounded projection.

The wrapper is part of the bot-base image. Publish the image containing the
batch-capable `/usr/local/bin/browser` before rolling out this template; an old
image returns `BROWSER_BATCH_UNSUPPORTED`, and the agent must not replay the
sequence or fall back to individual side-effecting calls.

Use a batch only when the next actions are already known and short. For an
uncertain flow, take a snapshot, act once, inspect the result, and take another
snapshot before continuing.
