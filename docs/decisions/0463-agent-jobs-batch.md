# ADR-0463 — CSV batch-job runner (`agent_jobs`): row-indexed fan-out over subagents

**Status:** Accepted (2026-06-03)
**Type:** New default-OFF domain slice (`src/agent/batch-jobs/`).
**Scope:** A self-contained slice: `types.ts` (domain types), `port.ts`
(`JobStorePort` + `InMemoryJobStore` + `RowDispatchPort`), `csv.ts` (parse via
the vendored `csv-parse` lib + RFC-4180 export), `schema.ts` (zod-backed
`RowSchemaValidator` factory), `runner.ts` (the state machine + bounded pool +
retry + export), `index.ts` (barrel) + the hellgate
`tests/unit/agent-batch-jobs-hellgate.test.ts`. No shared files edited.
**Default-OFF:** opt-in — a batch job runs ONLY when a caller explicitly
constructs a `BatchJobRunner` and calls `submit()` + `runToEnd()`. There is no
auto-trigger, env flag, or background scheduler. A deployment that never imports
this slice sees zero behaviour change (byte-identical).

ADR-number note: 0462 was the highest existing decision; this slice took the
next free number, 0463.

## Context

Codex ships an `agent_jobs` feature: a CSV (or row list) is fanned out over
subagents, one row = one subagent task, with structured-result collection,
retry, and an exported results CSV. Cursor ships an equivalent batch fan-out.
**2-vendor convergence — the strongest absorption signal.** Codex's on-disk
sqlite schema (verbatim) is the design anchor:

```
agent_jobs(id, name, status, instruction, output_schema_json,
  input_headers_json, input_csv_path, output_csv_path, auto_export,
  max_runtime_seconds, created_at, updated_at, started_at, completed_at,
  last_error)
agent_job_items(job_id, item_id, row_index, source_id, row_json, status,
  assigned_thread_id, attempt_count, result_json, last_error, created_at,
  updated_at, completed_at, reported_at)
index on (job_id, status, row_index)
```

quanta has a subagent dispatcher (`@/subagent` `SubagentRunner`) and the
`csv-parse` lib already vendored — but no batch fan-out. The risk in adding one
is coupling the domain logic to the concrete subagent runner + a concrete sqlite
handle, which would make it untestable and would drag `@/subagent`/`@/storage`
into a module that should be pure state-machine logic.

## Decision

Build the runner as **port-free domain logic** (`@/agent` slice, but importing
only `@/shared` + own modules) with two **inverted ports**:

1. **`JobStorePort`** — persist jobs + items (no-throw `Result`). Fine-grained
   (per-item `putItem`) so a sqlite adapter writes one row without
   re-serialising the job. `listItems` returns `rowIndex`-ascending (mirrors the
   Codex `(job_id, status, row_index)` index). An `InMemoryJobStore` ships as
   the test fake AND a valid production store for ephemeral jobs.

2. **`RowDispatchPort`** — `(instruction, rowJson, rowIndex, attempt, signal) →
   Result<RowDispatchResult>`. ONE call = ONE row's subagent task. The
   composition root wraps the real `SubagentRunner`; the domain never imports
   `@/subagent`. This mirrors the `Phase2Summarizer` / `ClassifierPort`
   port-inversion pattern.

The domain types mirror the Codex schema field-for-field (`BatchJob` ≈
`agent_jobs`, `BatchJobItem` ≈ `agent_job_items`), with closed status unions
(`JobStatus`, `ItemStatus`) so consumers branch exhaustively.

### State machine + semantics

- Item: `pending → running → {done | failed}`. `done` requires a successful
  dispatch AND (when a schema is set) a passing schema validation.
- **Retry**: a `dispatch-failed` row re-queues (`→ pending`) until
  `attemptCount` reaches the job's `maxAttempts`, then it is sticky `failed`.
  `maxAttempts` is a **required spec field** (≥ 1), not a magic constant.
- **Schema enforcement is per-row**: a row whose dispatched result fails the
  output schema is marked `failed` (`schema-rejected`) and does **NOT** abort
  the whole job (Codex semantics). A schema reject is NOT retried (it would fail
  identically). A malformed/unsupported schema descriptor compiles to a
  **fail-closed** validator (rejects every value) — bad config can never
  silently admit unvalidated rows.
- **Bounded pool**: at most `poolSize` dispatches in flight. `poolSize` is a
  **required spec field**, not a magic constant. `DEFAULT_POOL_SIZE = 4` is a
  documented named constant offered for callers who want a default — rationale:
  Codex's batch worker and Cursor's fan-out both default to a small single-digit
  bounded pool to cap provider rate-limit pressure and local memory; 4 is the
  midpoint both vendors land near. It is never used as a silent fallback.
- **Abort**: a fired `AbortSignal` cancels in-flight dispatches (the port
  receives the signal) and marks the job `cancelled`; `runToEnd` resolves
  `Err({kind:"aborted"})` with the job already persisted as `cancelled`.

### Schema validator inversion

`schema.ts` is the **only** file that imports zod's runtime. It compiles the
job's `output_schema_json` (a small flat `{type:"object", fields:{name:"string"
|"number"|"boolean"}, required:[...]}` descriptor — Codex schemas are flat field
maps, not arbitrary JSON-Schema) into a `RowSchemaValidator` (a no-throw
functional port). The runner receives the compiled validator and never imports
zod. This keeps the runner pure and mirrors `@/permission/classifier`'s
functional-port inversion.

### CSV

Parse reuses the vendored **`csv-parse/sync`** lib (`columns: true`,
`relax_column_count: false` so a ragged row is a hard `Err`, not silent data
loss). We do NOT hand-roll CSV parsing. Export is a small RFC-4180 quote-emitter
(no `csv-stringify` dep is vendored — documented trade-off; it quotes only when
a cell contains `" , \r \n` and escapes `"` → `""`).

## Default-OFF / byte-identical proof

- Nothing imports this barrel from `apps/agent` or `apps/cli` today. No env flag
  reads it. The slice is inert until a caller explicitly `submit()`s a job.
- Hellgate `default-OFF` group: constructing an `InMemoryJobStore` with no
  submit leaves it empty (`getJob` → `job-not-found`); `runToEnd` on an unknown
  job → `job-not-found`, no crash.

## Consequences

- A new domain slice with two clean inverted ports + an in-memory store. The
  real subagent runner + sqlite store are wired at the composition root (see
  integration TODOs) — NOT in this slice.
- The runner is fully deterministic-testable (injected clock + id-gen + scripted
  dispatch). 26-case hellgate, zero network.

## Negative invariants

1. The runner imports neither `@/subagent` nor `@/storage` — both are inverted
   behind ports. Adding such an import is a regression.
2. Only `schema.ts` imports zod's runtime; the runner stays zod-free.
3. A schema-rejected row marks ONE item `failed` and never aborts the job.
4. `poolSize` and `maxAttempts` are required spec fields — never silently
   defaulted to a magic constant inside the runner.
5. A malformed output-schema descriptor fails CLOSED (rejects every row), never
   open.
6. Every port method is no-throw `Result`; a programmer-bug input (bad spec,
   non-string CSV) is an `Err`, never a throw past the boundary.

## Honest deferred

- **No sqlite adapter** for `JobStorePort` yet — only `InMemoryJobStore` ships.
  A sqlite-backed adapter mirroring the Codex tables is a composition-root
  follow-up (the port shape + index ordering are already designed for it).
- **No real `RowDispatchPort` adapter** — wiring `SubagentRunner` into it is a
  composition-root step (see integration TODOs). The adapter is responsible for
  parsing the child's final assistant text into the structured `value`.
- **No CLI surface** (`/agent-jobs submit/status/export`) — `src/apps/cli/**` is
  out of this slice's scope; listed as an integration TODO.
- **No `auto_export` / `max_runtime_seconds`** wiring — the Codex columns are
  modelled conceptually (auto-export is the caller calling `exportCsv` after
  `runToEnd`; a runtime cap would be an `AbortSignal` driven by the caller's
  timer) but not auto-driven here.

## Test

`tests/unit/agent-batch-jobs-hellgate.test.ts` — 26 cases:
- CSV parse: headers+rows, empty, header-only, malformed-ragged (Err),
  non-string (Err);
- happy path: all rows done + completed, empty row list, rowIndex order;
- schema: reject row → failed while siblings done, validated value stored,
  malformed descriptor fail-closed, strict unknown-key reject;
- retry: flaky row recovered, retry exhaustion sticky-failed at cap, partial
  failure mix;
- abort: pre-aborted signal → cancelled, mid-job abort → cancelled;
- bounded pool: peak in-flight ≤ poolSize over 10 rows;
- default-OFF: empty store, unknown-job no-op;
- spec validation: poolSize<1, maxAttempts<1, empty name → invalid-spec;
- export CSV: deterministic columns/rows, RFC-4180 escaping, unknown-job Err.
