# ADR-0510: batch-jobs agent tool-ification (GAP7)

- **상태**: Accepted
- **날짜**: 2026-06-08
- **관련**:
  - `src/agent/batch-jobs/` (cap + resume), `src/agent/batch-jobs-dispatch.ts` (subagent bridge)
  - `src/host/runtime/batch-jobs-sqlite-store.ts` (durable store)
  - `src/tool/spawn-agents-csv/` (LLM tool) + tier-1 wiring `src/agent/tier1/subagent.ts`
  - Tests: `tests/unit/{agent-batch-jobs,batch-jobs-sqlite-store,spawn-agents-csv}-hellgate.test.ts`
  - Extends ADR-0463 (batch-jobs domain). Absorbs Codex `spawn_agents_on_csv` + sqlite `agent_jobs`.

## Context

ADR-0463 landed the batch-jobs domain (CSV fan-out, retry, schema, export) but only as a
human `quanta batch` CLI over an `InMemoryJobStore` — no agent tool, no durable store, no
resume, and `poolSize` was unbounded (a 1000-row CSV would fan out 1000 concurrent children).

## Decision

Five increments, each default-OFF + TDD:
1. **Concurrency cap** — `MAX_POOL_SIZE=32`; `validateSpec` rejects `poolSize>cap` (fan-out DoS guard).
2. **sqlite store** — `SqliteJobStore` (`bun:sqlite`, `agent_jobs`/`agent_job_items` + `(job_id,row_index)` index), a structural drop-in for `InMemoryJobStore` that survives restart.
3. **resume** — `BatchJobRunner.resume()` resets stranded `running` items (rolled-back attempt) then drives to completion (durable-store crash recovery).
4. **`spawn_agents_on_csv` tool** — agent-callable fan-out over a `BatchRunPort`; wired in the tier-1 subagent block (ephemeral in-memory store) behind `QUANTA_SPAWN_AGENTS_CSV`. Each row's child runs at `parentDepth+1` so the runner's `maxDepth` guard bounds a batch-of-batches (audit F1); an abort surfaces as `ok:false` (audit F3). `hitlTier:always-confirm` (cost-bearing).
5. The `RowDispatchPort`-over-`SubagentRunner` adapter moved to `batch-jobs-dispatch.ts` so the human CLI + the agent tool share ONE adapter (no duplication).

## Consequences

The agent can run bounded CSV batches; the human CLI keeps the durable sqlite path
(`--db`/`--resume`). The per-row `report_agent_job_result` worker tool is wired via a NEW
`SubagentRequest.extraTools` seam (the runner's `filterRegistry` appends per-dispatch tools
to the child registry AFTER the allowlist filter, byte-identical when absent): the dispatch
adapter mints a capture-once reporter per row, injects the tool, and PREFERS the reported
structured value over `parseChildValue(finalText)` (text parse remains the fallback). The
`extraTools` seam is generic — any future per-dispatch child tool reuses it.
