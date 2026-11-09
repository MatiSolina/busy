# Agent plans

`manage_plan` is an internal tool for complex work. The bot chooses it when a
task has dependencies, substantial deliverables or coordination across agents;
simple requests run directly. There is no planning mode, composer switch or
additional approval to create a plan. Existing action approvals still apply.

The tool supports `create`, `get`, `update` and `cancel`. A plan contains up to
20 steps with stable IDs, expected results, responsible agents, dependencies,
status, optional task IDs and evidence/blocker notes. Updates send the full
step list with the current plan ID and revision. Revision checks reject stale
writes; dependencies must exist, be acyclic, and be complete before a dependent
step starts or completes. Completed, blocked and failed steps require a note.

Delegated execution is server-bound. `dispatch_plan_step` reserves a bounded
root-turn budget before opening Eve's existing `agent` or `peer-N` task. If a
native agent/peer or remote code task was already started, the root calls
`bind_plan_execution`; the server checks that the task was observed in this
root session (code-task UUIDs are accepted only through the code-task path),
and derives the owner, stable execution ID and plan revision. A pre-dispatch
reservation has no task ID until Eve records `task.started`; synthetic IDs are
never presented as task IDs. The limits are 4 dispatches per root turn, 8
active executions and 20 total dispatch attempts per plan.
The dispatcher is a resumable Eve task; its actual receipt task ID remains the
source of truth for corrections and cancellation, and a running task is never
replaced automatically.

Eve's `defineState` checkpoints the current plan in the existing durable
session. It survives turns, crashes and redeploys in that session. It is not
stored in the sandbox, does not require a new database migration, and does not
automatically transfer to a replacement session. One active plan is allowed
per session; finish or cancel it before starting another. Finished plans remain
in chat history after the current slot is replaced.

Dynamic user-role instructions recall the active plan as data before model
calls, including after compaction. They do not authorize unrelated work or
change the stable system prompt. The agent can also retrieve the latest plan
with `get`.

The user-facing root agent owns the plan. Delegated children, peer consultations,
scheduled routine deliveries and code-task completion deliveries cannot mutate
it. The tool is hidden in those contexts and checks the identity again when
executed. No model-supplied session or bot ID selects the state being changed.
Root hooks observe `task.started`, `child.opened`, `call.started`,
`call.settled` and `task.ended` for the exact owner session. They mark
execution `running`, `failed`, `blocked` or settled and retain bounded result
availability metadata; replayed event positions are idempotent. A settled
execution never completes a business step by itself: the root must inspect the
actual Eve/code-task result and update the step with evidence. Failed or
blocked dependencies block pending dependents, and no hook starts a retry.

Assignments describe responsibility. They do not grant permissions. The root
uses the bounded dispatcher or the existing durable `agent`/peer/code tools,
records the actual task IDs and checks the results. Peer assignments never
grant write access; peer tools remain one-hop read-only consultations. The root
remains responsible for the result, approval requests, and file delivery.
Cancelling a plan records its unfinished steps as cancelled; the root must stop
any running children with their existing task controls first.

Chat renders a compact, collapsible card from successful root `manage_plan`
results. New revisions update the same card; history replay restores it without
another fetch. Failed calls, invalid results and unrelated tool output cannot
replace the plan. A stopped or failed turn displays in-progress steps as paused
until a newer plan revision arrives; it never fabricates completion.

When Eve replaces a root session, the hub may provide a structured,
authenticated recovery packet from the bot-authenticated
`/api/bot/recovery?sessionId=<new-root-session>` route. The packet includes the
plan and exact predecessor/root lineage and is schema-validated; arbitrary
`clientContext`, `prior_history` or XML text is never parsed as a plan. Active
predecessor bindings remain historical and blocked with their task IDs, rather
than being resumed or automatically re-dispatched. The replacement root must
inspect or cancel old work before an explicit new binding.

Deployment requires the updated hub and bot template. Existing bots receive the
tool and instructions when redeployed through the normal bot deployment path.
