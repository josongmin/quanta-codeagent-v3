# ADR-0539 — Bench tracing/observability architecture: layers, SSOT, correlation tuple

Status: Accepted (2026-07-12)
Supersedes the folklore "RFC-0002" reference cited in `src/shared/trajectory.ts` (no such file exists; this ADR is the governing document).

## Context

An adversarial + objective audit (2026-07) of the bench tracing stack found FOUR
parallel trace layers with no single owner, no shared correlation key, and
several consequential actions traced nowhere. Symptoms: the run verdict buried at
the bottom of the viewer; OTEL spans un-joinable to the trajectory; the repo
file-tree build (which can silently drop the gold file via truncation) emitting
no trace; the agent-stream tail lost on box crash.

## The four layers (as-built)

| Layer | Captures | Model | File | Default |
|---|---|---|---|---|
| **TRAJECTORY cassette** | one `RecordedInteraction {id,request,events,metadata}` per LLM `stream()` call — for deterministic REPLAY / fork-from-failure | `RecordedInteraction` (own) | `src/llm/replay/recording-llm.ts`, `src/apps/bench/trajectory.ts` | ON |
| **OBSERVE stream** | the normalized agent-event stream + the scaffold's own evidence (`sandbox / localize / patch_generated / verify / tool_* / recovery / error / session_* / turn_start / llm_*`) | `TrajectoryEvent` via `makeEvent` | `src/runner/batch/observe.ts` (+ `JsonlRecorder`), `src/shared/trajectory.ts` | ON |
| **DEBUG-sink** | keyed slices enriched into `metadata.debug` (only `toolExec` wired) | free `Record` in cassette metadata | `src/apps/bench/trajectory-debug-sink.ts` | OFF (`RECORD=debug`) |
| **OTEL spans** | a 4-span tree (session/turn/sampling/tool) | OTLP span (own) | `src/observability/*`, `src/apps/bench/otel-trace-sink.ts` | OFF (`QUANTA_OTEL_ENDPOINT`) |

## Decision

1. **SSOT = the OBSERVE stream.** It is the only layer that already shares one
   event model (`TrajectoryEvent`/`makeEvent`/`RunContext`) across its two
   producers (`JsonlRecorder` + `BenchObserver`) and applies `redactValue`
   consistently. All NEW scaffold-action tracing MUST be an OBSERVE `kind` with a
   declared `data` contract in `src/shared/trajectory.ts` (`TrajectoryKind` +
   `TRAJECTORY_KINDS` + a `*Data` interface). The trajectory cassette and OTEL
   are DERIVED/adjunct layers, not competing sources of truth.

2. **Correlation tuple (mandatory on every layer): `{runId, instanceId, attempt, turn}`** plus a span id where spans exist.
   - OBSERVE stamps it via `RunContext` (already).
   - TRAJECTORY carries `runId/instanceId/attempt/lane` in `metadata` (already).
   - OTEL now stamps `quanta.run.id` (resource) + `quanta.instance.id` (session span). `quanta.attempt` is supported end-to-end but not yet threaded by the driver (residual gap — same-instance discriminator only).
   - The join key across all layers is therefore `{runId, instanceId}` → the file `<runId>/<instanceId>.<attempt>.jsonl`.

3. **Redaction contract.** OBSERVE + metrics/summary are redacted via the shared
   `redactValue`. The TRAJECTORY cassette is deliberately NOT redacted — its
   match key is the request-hash and redaction would break cross-box replay
   determinism (fork-from-failure). Treat the cassette as a SECRET artifact:
   never share it outside the operator boundary. (Audit F5: this is an accepted
   trade-off, not a bug — do not "fix" it by scrubbing the cassette.)

## Audit fixes landed under this ADR

- **F1** (CRIT) — file-tree build + truncation now emit an OBSERVE `localize`
  event `{treeFileCount, truncated, truncatedChars?, rankedCandidateCount}`
  (`agentless-localize.ts` → `localize-prep.ts` `onLocalize` → `emitLocalize`),
  wired at the driver via `wiring.observer`.
- **F2** (CRIT) — the OBSERVE agent-stream recorder (`jsonl-recorder`) now flushes
  at TURN BOUNDARIES (`turn_start`/`done`/`error`) and on `SIGTERM`/`SIGINT`, so a
  box crash (OOM/exit137/spot-reclaim) no longer loses the last completed turns.
- **F3** (HIGH) — OTEL session span now carries `quanta.instance.id` (join key);
  `quanta.run.id` already on the resource.
- **F7** (MED) — a successful-turn commit failure in the cassette recorder now
  `logger.warn`s + writes a degraded sentinel instead of silently vanishing.
- **Surfacing** — the viewer pins a RUN SUMMARY (verify verdict / patch / sandbox
  / errors) at the top, out of ts order.
- **Honesty** — debug-sink docstring corrected (only `toolExec` wired); the stale
  "observe default-OFF" comment fixed (observe is default-ON).

## Residual gaps (tracked, not yet fixed)

- `quanta.attempt` not threaded onto spans (needs a multi-hop driver param).
- Dead trajectory kinds `patch_applied` / `patch_rejected` are declared but never
  emitted — RESERVED for a future patch-apply tracer; keep or emit, don't leave
  as silent no-ops without this note.
- `onSelection` per-round acceptance observer is declared but bound nowhere —
  wire at the driver or delete.
- Phase-gate blocks (`consultLocalizePhase`) return a synthetic tool_result but
  emit no `decision` event despite the kind being wired — should emit a
  `decision {kind:"gate", ruleId, outcome:"deny"}`.
- DEBUG-sink promised contributors (grader/edit/phase-gate) remain unwired; only
  `toolExec` is live.

## Amendment (2026-07-13) — OTel GenAI unified tracing (P0)

Plan: `docs/plans/jul-12-otel-genai-unified-tracing.md` (+ parallel-execution companion).

1. **SSOT split (supersedes the "OBSERVE is SSOT" wording above).** OBSERVE
   remains the typed, redacted EVIDENCE ssot; the replay cassette remains the
   unredacted REPLAY ssot (secret artifact); **OTel span context becomes the
   IDENTITY + CAUSALITY ssot.** These are three authorities, not one.
2. **Correlation authority = `TraceRef {traceId, spanId, parentSpanId?}`** — reuse
   `src/observability/tracing/port.ts` `SpanContext` + optional `parentSpanId`.
   Full cross-layer tuple: `{traceId, spanId, runId, instanceId, attempt,
   conversationId}`. `TrajectoryEvent.traceId?` (added 2026-07-13) carries it;
   `spanId` alone is NOT a sufficient join key.
3. **Trace scope = one trace per instance ATTEMPT.** Best-of-N/retry attempts get
   distinct trace ids and share `{runId, instanceId}` with distinct `attempt`.
4. **Runtime modes** `off | context | export` — only `off` is byte-identical /
   zero-alloc. `context` allocates ids + async context (NOT "zero cost").
5. **No per-event legacy fallback in unified mode (DESIGN INTENT — NOT yet
   enforced).** The end-state: a missing active context in `context`/`export`
   mode is a correlation DEFECT → one `observability_degraded` record + failed
   strict rail, never a synthesized `t<turn>` id. As-built the recorder STILL
   synthesizes the deterministic `t<turn>`/`llm:t<turn>`/`tool:<id>` id on a
   missing ref and emits no `observability_degraded` for it — because it carries
   no runtime-mode flag to tell "context expected but missing" (a defect) from
   "context never wired" (the legitimate byte-identical `off`/unwired case). See
   the amendment-status note below; the recorder's own comment (`"Full no-fallback
   is C7"`) is the honest status. Enforcing this needs the mode threaded into the
   recorder — tracked as a residual, not shipped.
6. **GenAI semconv snapshot is PINNED** (Development, not Stable) — the plan's
   commit SHA is the normative contract; `main` is not.
7. **Cassette stays unredacted** (request-hash/replay depends on exact content) —
   outside the content-capture policy, inside the operator boundary. Unchanged.

### Amendment status (landed 2026-07-13)

The unification shipped in waves W0–W3 + a C7-core id-unification, all on `main`:

- **W0/C1** — `active-context.ts` (`AsyncLocalStorage<TraceRef>`, `getActiveTraceRef`),
  `TrajectoryEvent.traceId?`, OTLP `arrayValue`, +5 gen_ai keys.
- **C2** — loop spans carry gen_ai semconv attrs (`invoke_agent`/`chat`/
  `execute_tool`, `finish_reasons` array); orphan sites nest via caller context.
- **C3/C4** — jsonl-recorder + cassette stamp the active `TraceRef`; replay-hash
  invariant PROVEN (metadata never hashed).
- **C5** — one run-id authority (`QUANTA_RUN_ID`≡`QUANTA_OTEL_RUN_ID`), attempt
  threading, per-attempt `quanta.bench.instance` INTERNAL root (one trace/attempt).
- **C6** — viewer projects the span tree by joining OBSERVE+cassette on
  `{traceId,spanId,parentSpanId}`; 🌲/💬 toggle.
- **C7-core (id unification)** — the EXPORTER's issued id IS the active-context
  id: `SpanSink.onStart` returns a `TraceRef`, and `withActiveSpanScope` installs
  `span.ref` verbatim. Parentage derives PURELY from the enclosing async-local
  active ref (`getActiveTraceRef()`); the exporter's LIFO stack is the direct-path
  (unscoped `startSpan`/`endSpan`) fallback ONLY, gated per-context on
  `activeParent===undefined`. Scoped spans are evicted from that shared stack the
  instant they become scoped (`SpanSink.onScoped`/`markSpanScoped`), so concurrent
  scoped sessions can never adopt each other's frame. **This CLOSES the audit's
  "OTEL spans un-joinable to the trajectory" finding** — OTLP ≡ OBSERVE ≡ cassette
  now share one `{traceId, spanId}`. Acceptance:
  `spans-otlp-active-context-unification.test.ts` +
  `spans-direct-path-concurrent-scope.test.ts` (direct-path-vs-concurrent-scope).
  - A hell-audit (2026-07-13) first shipped this with a PROCESS-GLOBAL
    `isActiveContextRegime()` counter gating the async-local fallback — a
    global-mutable-state hazard that orphaned direct-path spans whenever an
    unrelated scope was live. The counter was removed in the same day's
    remediation (the async-local gate + `onScoped` eviction above).

Everything is `off ⇒ byte-identical`. Remaining (optional): a production full-remote
box run to re-prove the tuple over a real OTLP network hop with a live LLM (the
unit acceptance already exercises a real exporter sink over `runAgent`). C7 legacy
DELETION (deterministic `t<turn>` synthetic ids, SpanSink compat adapter) stays
deferred behind the declared compat window — the recorder's `t<turn>` fallback
fires on ANY missing active ref (OFF/unwired, AND — until rule 5 above is enforced
— an orphan emit outside any `withActiveSpanScope`), not strictly when OFF.

## Rule for new observability features

Add to the SSOT (OBSERVE) as a typed `kind`, stamp the correlation tuple, and —
if the data is a low-frequency HIGH-VALUE decision (verdict, gate, knob posture) —
also surface it in the viewer's pinned summary, not just the ts-sorted stream.
Do NOT bolt a new event onto whichever layer is convenient.
