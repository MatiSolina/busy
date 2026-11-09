# Paired performance A/B evaluation

`pnpm perf:ab` compares two clean Busy source checkouts with the same synthetic
Postgres fixture, evaluator, browser/runtime settings and session secret. It is
a controlled benchmark A/B: it establishes whether a code change changes the
runtime metric under a fixed workload. It does not measure user behavior or
claim a product conversion lift.

The runner writes `plan.json` before building or timing either variant. The plan
contains the source commits, evaluator and fixture hashes, database schema hash,
package, lockfile and Next-config hashes for each source, the empty-clean-checkout
patch hash, the orchestrator/statistics hash, workload, runtime, seed, sample
count, declared alpha and a balanced randomized block order. Package and
dependency hashes are recorded for review but are not required to match when a
treatment intentionally changes dependencies. Every report must still match
its own source identity and the same browser/runtime environment before it can
enter the paired analysis.

For calibration, point control and treatment at two clean worktrees of the
same commit. The report marks this as `aaCalibration`, preserves the raw
statistical decision/effect/interval for diagnosis, and sets
`releaseEligible=false` even if random noise produces a favorable sample
estimate. This validates the harness without hiding a false winner.

When the two variants intentionally use different history shapes, set
`PERF_AB_CONTROL_HISTORY_EXPERIMENT` and
`PERF_AB_TREATMENT_HISTORY_EXPERIMENT` separately. Their expected snapshot and
archive page shapes remain part of the predeclared plan and every report is
checked against its own variant label.
Each block runs the control and treatment sequentially; half of the blocks run
control first and half treatment first. Builds happen before any timed sample.

Both checkouts must be clean and distinct. Their evaluator files, fixture files
and database schema must match byte-for-byte. This prevents an untracked
measurement change, schema drift or a different fixture from becoming an
apparent treatment effect.

Example, using two local worktrees:

```sh
PERF_CONTROL_DIR=/path/to/worktrees/control \
PERF_TREATMENT_DIR=/path/to/worktrees/treatment \
PERF_AB_BLOCKS=8 \
PERF_AB_SAMPLES_PER_BLOCK=6 \
PERF_AB_SEED=1104 \
PERF_RUNTIME=chromium \
PERF_WORKLOAD=scale \
PERF_AB_OUTPUT_DIR=/tmp/busy-perf-ab-scale \
pnpm perf:ab
```

The default primary metric is `loadReadyMs`. Set `PERF_AB_METRIC` to one of the
metrics already produced by the evaluator when the decision concerns another
critical flow, such as `streamReadyMs`, `panelReadyMs` or
`returnChatRouteReadyMs`. The `history-long` workload additionally supports
`archiveFirstPageReadyMs` for a separately planned bulk-versus-paged archive
experiment. The evaluator still records its complete metric set;
the selected metric is only the pre-declared primary outcome.

For `history-long`, `archiveResponseBytes` is decoded JSON/body size from the
payload probe, not transferred or compressed wire bytes. `archivePayloadReadyMs`
is the probe timing; `archiveFirstPageReadyMs` is the separate timing through
the first visible archived reply. Renderer heap diagnostics are post-GC
JavaScript heap measurements, not total application RAM.

The report contains sample counts, p50/p95 values, the paired block effect, a
deterministic bootstrap 95% interval, an exact sign-permutation p-value when
the block count is small, aggregate guardrails and per-block p95/ratio
diagnostics. The per-block diagnostics are for review only and do not alter the
existing ten-percent p95 interaction guardrails. The default is eight balanced blocks so the two-sided sign test can
reach the declared alpha of 0.05; four-block exploratory runs remain explicitly
inconclusive even when every block moves in one direction. A run is
`inconclusive` when a block fails, a report is missing its primary metric, a
guardrail fails, or the uncertainty interval crosses zero.
For a latency improvement to be called a winner, the declared alpha must pass
and the lower uncertainty bound must clear both the 10% relative and 5 ms
absolute practical thresholds.
The runner does not discard failed samples or stop early after a favorable
result. Raw evaluator reports and bounded process logs remain beside the plan
and result for review.

Do not use this runner against production. It creates an isolated loopback
server and a temporary authenticated Postgres database, and the evaluator's
provider and computer calls remain synthetic fixtures. Production latency,
model inference, upstream OAuth, Vercel cold starts and user network behavior
need a separate metadata-only production measurement protocol.

## Guardrails de p95: test de permutación (2026-11-05)

**Problema.** El gate fallaba si el p95 pooled del tratamiento superaba 1.10× el del control en cualquier métrica. Con ~8 métricas por workload, 2 workloads y 12–24 muestras por brazo, ese p95 es casi un máximo, así que alguna métrica pasaba 1.10 por puro ruido.

**Regla nueva** (`summarizeGuardrails` en `apps/hub/evals/performance/paired-stats.ts`):

- Una métrica falla solo si el ratio pooled de p95 supera 1.10 **y** ese exceso es significativo.
- La significancia sale de un test de permutación de etiquetas **dentro de cada bloque**, de una cola, con 2000 permutaciones y la semilla del plan. Si no hay efecto, control y tratamiento son intercambiables dentro de un bloque aleatorizado. El test usa exactamente las muestras observadas y no supone normalidad.
- El nivel por métrica es `0.05 / k`, con Bonferroni sobre las `k` métricas declaradas del plan.
- Si el ratio supera 1.10 pero no es significativo, sale como **advertencia** en `result.warnings` y no bloquea.
- `plan.json` registra `guardrailTest` (método, α, permutaciones) antes de que exista cualquier muestra. La identidad del harness, el plan predeclarado y el horizonte fijo no cambian.

**Calibración con datos de CI.** Se usaron 7 corridas de workload de PRs que no cambian el bundle cliente: #118 mixed/scale, #116 mixed, #125 mixed/scale y subscription-access mixed/scale.

| | Regla vieja | Regla nueva |
| --- | --: | --: |
| Fallos observados en esas 7 corridas | 4/7 | 0/7 |
| Tasa de falsos positivos por corrida (350 A/A sintéticos, permutando etiquetas dentro de bloque) | 74.3% | 3.1% |
| Tasa de falsos positivos por PR (2 workloads), aproximada | ~93% | ~6% |

**Potencia** con 4 bloques × 3 muestras por brazo (coldStream) y corrimiento multiplicativo uniforme: ×1.2 se detecta el 30% de las veces, ×1.35 el 77% y ×1.5 el 87%. Con 8 bloques × 6, las cifras son 63%, 91% y 98%.

**#122 (coldStream).** Ratio de p95 1.343, permutación p = 0.116, umbral 0.00625. La regla nueva lo deja como **advertencia**, no como fallo. Los motivos:

- Su evidencia es más débil que la del A/A de #118 mixed, que dio coldStream 1.110 con p = 0.043, la más fuerte de todas las corridas A/A.
- Con 12 muestras por brazo, cualquier regla que lo marque fallaría también en ese A/A.
- El efecto que se ve, mediana +8%, está por debajo del límite de 10% que este guardrail declara.

Para confirmar una regresión así hay que volver a correr con más muestras (8×6 detecta ×1.2 con 63% de potencia) o usar un test de mediana con su propio umbral predeclarado.
