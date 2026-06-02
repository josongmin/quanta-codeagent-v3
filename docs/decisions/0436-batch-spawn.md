# ADR-0436 — `spawn_batch` structured subagent fan-out

- Status: Accepted
- Date: 2026-06-02
- RFC: `docs/plans/jun-2-misc/02-batch-spawn.md`
- Slice: `src/tool/subagent-batch/**` (new) + `src/agent/tier1/subagent-batch.ts` (composition root)
- Absorbs: Codex `spawn_agents_on_csv` (codex-rs 0.135, `core/src/tools/handlers/agent_jobs/`)

## Context

Bulk "do X for each of these N items" work currently forces the model to
hand-roll N `agent` / `subagent_fork` calls. That wastes tokens (one near-
identical prompt per item), drops/duplicates items non-deterministically as N
grows, and gives no structural concurrency control or partial-failure
isolation — the model has to write a fragile backoff loop against the
scheduler's hard `cap-exceeded` throw.

Codex absorbed this as a single structured tool, `spawn_agents_on_csv`. quanta
already owns a concurrency-capped scheduler and a `TaskRegistry`, so we add a
structured fan-out tool on top instead of reinventing a worker pool.

## Decision

Add a single LLM tool `spawn_batch` (new slice `src/tool/subagent-batch/`):

- Input: `items[]` (inline) **XOR** `items_path` (`.csv` / `.jsonl` / `.json`,
  parsed inline — no CSV dependency), `prompt_template` with `{{key}}`
  placeholders (`{{item}}` for string items, `{{{{ }}}}` for literal braces),
  `max_concurrency`, `per_item_timeout_ms`, `id_field`, `max_turns`,
  `output_schema`.
- Execution: a self-contained one-shot worker pool — an inline FIFO admission
  semaphore bounded by `min(max_concurrency ?? schedulerCap, schedulerCap)`
  over the **injected** runner. Each item: template-render (missing placeholder
  ⇒ that item only is `error`, no spawn) → admit → run with a per-item timeout
  race → collect. Partial failures are isolated; one item failing never stops
  the rest.
- Output: deterministic index-ordered `BatchItemResult[]` + a `BatchSummary`
  (`total/ok/failed/cancelled/durationMs`) on `result.structured`, plus a
  human-readable text body and per-item `progress` events. All items failing ⇒
  `ok:false` (so the model clearly sees total failure); otherwise `ok:true`.

### Deliberately NOT absorbed (negative invariants)

- **CSV-only input** → generalized to inline array OR `.csv`/`.jsonl`/`.json`.
- **`report_agent_job_result` worker-side tool** → workers just return their
  `finalText`; `output_schema` is validated parent-side.
- **Automatic `output_csv_path` export** → no implicit disk side-effect; the
  model uses `write` if it wants a file (slice-clean).
- **New worker pool / scheduler** → reuses the `TaskRegistry` cap philosophy +
  NO-THROW + injected-clock patterns; the pool is a thin inline semaphore.

## Determinism / safety

- No `Date.now` / `Math.random` / real timers in the slice — the clock, file
  reader, and runner are all injected. The only `setTimeout` is the per-item
  timeout race, unconditionally cleared.
- Templating is pure doubling-escape + flat-key substitution: no `eval`, no
  `Function`, no nested access (injection surface 0).
- Explicit injected caps (`maxItems`, `schedulerCap`, `timeoutPolicy`) — no
  inlined heuristics. `maxItems` defaults to 256 (aligned with the
  `TaskRegistry` settled-LRU); `per_item_timeout_ms` defaults to 1800s (Codex
  parity), clamped into the policy band.

## Default-OFF

Triple-gated: (1) `buildSubagentBatchBlock` returns `[]` unless
`config.subagent.enableBatchSpawn === true`; (2) the tool itself returns
`ok:false` (never throws) on cap/XOR violations; (3) the tool is absent from
the `ToolRegistry` until wired ⇒ byte-identical to today.

## Knobs

- `QUANTA_SUBAGENT_BATCH=on` — composition-root env knob (strict `=on`).
  Resolved in `wireOptionalAgentPorts` (`src/agent/optional-ports.ts`), the
  single env→optional-port wire every surface (unified-agent mode-presets, CLI
  via `host/runtime/internal/context-binding.ts`) calls. Sets
  `config.subagent.enableBatchSpawn = true` (and ensures the `subagent` runner
  block exists). Unset / typo ⇒ slot absent ⇒ byte-identical. Mirrors the
  `QUANTA_SUBAGENT_MAILBOX` / `QUANTA_MCP_AUTORESTART` knob idiom.
- `config.subagent.enableBatchSpawn: boolean` — the underlying gate.
- `config.subagent.maxBatchItems?: number` — hard item cap (default 256).
- Reuses `config.subagent.maxConcurrent` (concurrency ceiling) and
  `config.subagent.waitTimeoutPolicy` (per-item timeout band) when present.

> **2026-06-02 follow-up — limitation CLOSED.** Previously the gate was
> fully implemented + tested but NO composition root ever set
> `enableBatchSpawn`, so `spawn_batch` never reached the registry in a real
> session (dead seam). `QUANTA_SUBAGENT_BATCH=on` now turns it on end-to-end.

## Tests

`tests/unit/subagent-batch-hellgate.test.ts` (RFC §9's 12 cases + all-failed +
jsonl/json loaders, all through `Tool.execute`),
`tests/unit/subagent-batch-template.test.ts` (renderTemplate units), and
`tests/unit/subagent-knobs-wire-hellgate.test.ts` (the env→flag→tool wire:
knob on ⇒ `spawn_batch` registered; unset ⇒ absent + byte-identical). 35 tests.

## Consequences

- The model gets one deterministic, partial-failure-isolated fan-out primitive.
- The slice is fenced (`@/tool/subagent-batch` never imports `@/agent`); the
  composition root is the only place `Date.now` / `fs.readFile` are supplied.
