# Busy agent evals

These evals exercise the behavior that sits on top of eve 0.91.0's existing
durable sessions, tasks, subagents, Workflow checkpoints, and HITL protocol.
They do not replace or modify the runtime.

The default local test suite runs the deterministic contract checks. Run the
provider-backed cases explicitly after authenticating the target:

```sh
eve eval durable-conversation
eve eval human-in-the-loop
eve eval cancellation
eve eval --strict durable-conversation
```

`calledAgent`, `t.succeeded()`, event assertions, and interaction schemas are
deterministic protocol checks. `t.judge(...)` is a soft semantic signal and
requires the configured Decision API model (`typesafe-ai/jev` through AI
Gateway). The provider-backed cases skip themselves when no linked Vercel
project or Gateway/OIDC credential is available. A provider outage after
authentication is reported separately; it is not evidence that the agent
failed the behavior.

The evals deliberately avoid real client files, credentials, uploads, browser
accounts, and live bot-to-bot content. The production `send_file`, consultation,
and sandbox contracts remain covered by their focused unit tests.

For a provider transport smoke check without starting a sandbox, run the AI SDK
Decision API against a synthetic state with a fresh Vercel OIDC environment:

```sh
node --env-file=/absolute/path/to/gateway.env --input-type=module \
  -e 'import { experimental_decide } from "ai"; await experimental_decide({ model: "typesafe-ai/jev", state: { message: "delegate file work" }, questions: { delegate: { type: "boolean", instructions: "Should this be delegated?" } } })'
```

This only verifies transport and response shape. A local full eval also needs a
bot-authenticated Hub for dynamic directory and memory reads; a user OIDC token
alone can produce `401` there even when the Decision API works.
