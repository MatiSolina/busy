# Performance seam routing

The UI performance workflow measures browser and client/data changes. Its
synthetic EventSource fixture does not execute the durable SSE saver, provider
transports, routine workers, Fireside runtimes, Live controls, or Library
promotion workflow.

The workflow therefore classifies each pull request before starting a timing
job:

- `ui`: browser performance is required.
- `backend`: focused backend contract tests are required and the UI seam is
  recorded as `unexercised_seam`.
- `mixed`: both contract tests and the browser comparison are required.
- `docs`: no performance job is required for the changed paths.
- `full`: manual or non-pull-request execution runs the complete suite.

The generated `performance-scope.json` artifact retains the changed paths,
classification reason, `uiMeasurement`, and `unexercisedSeam` fields. A backend
classification never turns an earlier red UI guard into a pass; prior UI
reports remain the evidence for the UI seam and are retained with their
original failure state. Unknown paths and client-visible data contracts fail
closed to `mixed` or `ui` so a new surface cannot bypass browser measurement.

The pull-request workflow runs the evaluator driver from the checked-out PR
head for both local servers. `PERF_SOURCE_DIR` points separately at the base and
candidate product trees, so reports retain distinct product `sourceRef` and
patch identities while evaluator, fixture, runtime, schema, and environment
hashes remain comparable. A change to the evaluator itself therefore changes
the shared driver identity and cannot be presented as a product-only result.

The classification is intentionally conservative for chat stores and Fireside
state, projection, and type modules because those modules can change the data
shape consumed by the browser. Server-only classification is limited to the
allowlisted transport, metadata endpoint, provider, lifecycle, persistence,
and workflow seams with focused tests.
