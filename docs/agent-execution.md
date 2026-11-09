# Agent execution and recovery

Busy owns the identity of user messages, replacement sessions, and planned work.
Eve continues to own durable agent turns, child tasks, context compaction, and
tool execution. These controls extend those existing boundaries.

## Context budget

`pnpm check:context-budget` measures the authored bot instructions, browser
guidance, and tool definitions for the default, lazy, and core configurations.
It uses local fixtures and does not call a provider. CI rejects growth above
the checked-in ceilings. Review an intentional increase before running
`pnpm update:context-budget` and committing the updated baseline.

The measurements are serialized bytes, not billed tokens or a latency benchmark.
User history, recalled memory, external MCP schemas, provider framing, and
provider caching must be measured separately.

## Browser sequences

The browser batch accepts a bounded list of supported actions. It uses the
existing visible Chrome and desktop-control lease. The wrapper validates the
whole list before executing it, checks control ownership between actions, and
stops on an error, changed browser generation, takeover, or deadline.

An attempted action can have effects even when its acknowledgement is lost.
The result therefore separates attempted actions, confirmed actions, and the
final observation. Failure to obtain the final snapshot must not erase evidence
of completed steps. Recover by inspecting the current page before deciding what
to do next. See [Browser batching](browser-batching.md).

## Message identity and replacement sessions

A message ID is also the Eve idempotency key. Its persisted delivery record
pins the target session before a send can occur. A lost acknowledgement does
not authorize replay in a different session. An accepted receipt remains
authoritative even if a later query has not observed the delivery yet.

A replacement session receives a bounded record of recent conversation and
execution metadata. The complete event history remains outside the prompt.
Tool names, statuses, and source IDs provide pointers to evidence; they do not
prove that an external business action succeeded. Tool arguments, raw tool
results, and model reasoning are not execution summaries.

Restoring plan state requires a server-owned record bound to the bot and the
source and target sessions. Conversation text cannot supply this authority.
Work whose earlier result is unknown must retain its identity and remain
blocked for inspection rather than become an automatically restarted task.

Recovery does not change the selected provider, connection, or billing path.

## Planned delegation

The plan remains an internal tool for complex work. A step has dependencies,
an expected result, and a responsible agent. Its execution binding records the
actual task and owning session. Runtime observations can update technical
execution state; the root still inspects the result before completing the step
with evidence. See [Agent plans](agent-plans.md).

## Release verification

Apply the additive session-recovery migration through the existing Drizzle
release process before deploying the hub code that uses it. The new internal
tables have RLS enabled and no public, anonymous, or authenticated Data API
grants. Preparing this change does not apply a production migration.

Release the updated bot base image before rolling out the bot template's new
browser tool. An older image cannot execute the batch protocol and returns an
unsupported-runtime result. Use the existing image release process; this change
does not publish an image or replace any deployed bot computer.

Local verification covers the context budget, browser subprocess contract,
message replay and concurrency, recovery data bounds, and plan execution
ownership. These checks do not establish production latency improvements or
exercise a real provider outage. After release, verify one disposable workflow
with a browser takeover and one interrupted session using the normal deployment
and acceptance process.
