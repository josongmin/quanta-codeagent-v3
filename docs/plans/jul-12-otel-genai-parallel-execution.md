# Parallel execution breakdown — OTel GenAI unified tracing

Companion to `jul-12-otel-genai-unified-tracing.md`. Maps its P0–P6 phases onto
**file-disjoint clusters** and **dependency waves** so the work can be fanned out
without merge conflicts. Principle: **freeze the cross-cutting contracts first**
(Wave 0), then every cluster owns a disjoint file set and codes against the frozen
interfaces. No two concurrent clusters share a file.

## Dependency graph (what gates what)

```
Wave 0  CONTRACTS  ──────────────► gates everything
          │
   ┌──────┼───────────────────────────────┐
   ▼                                       ▼
Wave 1  C1 core runtime  ‖  C6 viewer   (viewer needs only the data contract)
          │
   ┌──────┼──────────┬───────────┐
   ▼      ▼          ▼            (all need C1's getActiveTraceRef/withSpan impl)
Wave 2  C2 loop  ‖  C3 observe ‖ C4 cassette   (file-disjoint)
          │
          ▼
Wave 3  C5 bench identity/root   (needs C2 span identity threading)
          │
          ▼
Wave 4  C7 cutover + ratchets + fixtures   (after everything green)
```

Critical path: **Wave 0 → C1 → C2 → C5 → C7**. C3, C4, C6 hang off it in parallel.

## Verification pass — grounded corrections (2026-07-12)

3 read-only audits against real code. Corrections folded into the clusters below.

### DUPLICATE — reuse, do NOT rebuild
- `src/observability/tracing/` is ~80% of C1's "async-safe runtime" **and already
  exists**: `port.ts` (`SpanKind`, `SpanContext`={traceId,spanId,traceFlags},
  `Tracer`, propagator), `otel-tracer.ts` (TracerProvider bridge, WeakMap span
  cache, explicit-parent lifting, W3C extract), `noop-tracer.ts` (mints valid
  W3C ids per span), `w3c-propagator.ts` (cross-process traceparent). **C1 EXTENDS
  this.** `TraceRef` = reuse `SpanContext` + optional `parentSpanId` (do NOT
  redeclare). The genuinely-missing deltas are ONLY: (a) AsyncLocalStorage
  active-span install in `withSpan`, (b) `getActiveTraceRef()`, (c) OTLP
  `arrayValue` in `otel-exporter.ts:265` `otlpAttributes`, (d) migrate the 4
  `spans.ts` literals + SpanSink call sites onto the port, (e) the 5 missing
  `gen_ai.*` keys. Also: `attrs.ts` builder ALREADY accepts homogeneous arrays
  (`vocabulary.ts:373`, `attrs.ts:74`) — only the exporter drops them.
  `otel-exporter.ts:692 buildExportingTracer` is a 2nd Tracer impl with
  kind/status → reconcile, don't add a 3rd path.
- DI seam: `JsonlRecorderOpts` already injects structural `now`/`monotonic`
  callbacks (`jsonl-recorder.ts:13-16`) — add `getActiveTraceRef?: ()=>TraceRef`
  the same way (no `@/observability` import ⇒ slice boundary satisfied).
- `RunContext` deliberately has no span/trace field — add `traceId` to the
  envelope + cassette metadata, NOT to RunContext.

### WRONG claims to fix
- `gen_ai.tool.call.id` **already exists** (`vocabulary.ts:330`). Only FIVE keys
  are truly missing: `operation.name`, `provider.name`, `conversation.id`,
  `agent.name`, `input.messages`/`output.messages`.
- Cache keys are `gen_ai.usage.cache_creation_input_tokens` (flat) — target is
  the dotted `cache_creation.input_tokens`; not "no prefix".

### GAPS (missed files/consumers) — folded into clusters
1. **3 missed span-emit sites** (legacy `handle_tool_call` via flat SpanSink →
   would orphan under the new tree): `src/agent/admissibility-gate/hitl.ts:358`,
   `src/agent/admissibility-gate/shared.ts:622`, and
   `src/observability/patch-trace/otel-patch-trace.ts:54,64` (+ caller
   `src/tool/apply-patch.ts:64`). → added to C2/C1.
2. **#1 SILENT BREAKER — `src/apps/probe/render.ts:28-32` `turnKey()`** groups
   turns by `parentSpanId.startsWith("t")` / `"tool:"`. Real OTel spanIds are hex
   (`0-9a-f`) → NEVER start with `t` → the timeline silently mis-groups every
   turn (no throw). MUST re-key on `kind:"turn_start"` identity. → added to C3.
3. **C5 run-id writers missed**: `src/apps/bench/default-trace-sink.ts:51` (THIRD
   `QUANTA_OTEL_RUN_ID` writer) and `src/apps/bench/remote/box-session.ts:153`
   (forwards the OTel run-id to full-remote boxes — must forward the unified id
   or boxes lose correlation). → added to C5.
4. Read-side run-id consumers `src/apps/bench/{commands/trace.ts,otel-trace-sink.ts}`
   → swept in C7.
5. `report.ts` + the 4 emit-caller driver files need NO edits **iff** C3's
   recorder pulls the active ref via DI (confirmed approach) — not per-call-site.
   `src/apps/bench/observe.ts` is an inert 2-line barrel; real wiring is
   `src/runner/batch/observe.ts`.

### Tests that HARD-ASSERT the legacy id scheme (loud fail at C7 cutover)
`tests/unit/jsonl-recorder.test.ts` (`llm:${turnSpan}`, `tool:tu1`),
`tests/unit/trajectory.test.ts` (§11 span-pair golden), `tests/unit/probe.test.ts`
(`t0`/`llm0`/`tool:bash:1` fixtures). Update at cutover, not mid-flight.

### COLLISION risk (sequencing)
Main already landed `1e7ad280f` (ADR-0539 remediation) touching the SAME
C2/C3/C5 files — so Wave 0 is an **amendment**, not greenfield. **5 feature
branches predate it and will hard-conflict** on the identical file set:
`feat/{observation-providers,trajectory-debug-sink,trajectory-parallel-lane,
trajectory-per-instance-sessions}`, `fix/debug-sink-parallel-safe`. Land/rebase
or abandon these BEFORE starting C2/C3/C5, or the wave merges will fight them.

## Wave 0 — CONTRACT FREEZE (solo, blocks all) · Phase 0

Additive types/constants + ADR decisions ONLY. No behavior change. This is the
interface every cluster compiles against.

| File | Action | What |
|---|---|---|
| `docs/decisions/0539-tracing-observability-architecture.md` | MODIFY | amend: SSOT split (OBSERVE=evidence, OTel-context=correlation), trace scope=per-instance-attempt, runtime modes, compat window, pinned semconv SHA |
| `docs/decisions/0074-otel-span-tree.md` | MODIFY (or ADD) | the target span tree + kinds |
| `src/observability/tracing/port.ts` | ADD | `TraceRef`, `TracingMode='off'\|'context'\|'export'`, `getActiveTraceRef(): TraceRef\|undefined`, `withSpan(...)` activation signature, `SpanKind`, `ContentCapturePolicy` type |
| `src/shared/trajectory.ts` | MODIFY (additive) | optional `traceId?` on `TrajectoryEvent`; validator tolerates it; **do NOT** touch kinds/redaction |

Exit gate (P0 acceptance): ADR no longer calls both layers undifferentiated SSOT;
no "stable"/"zero-cost" claims; `TraceRef`+`traceId` frozen. **Nothing else starts
until this lands.**

## Wave 1 (parallel ×2)

### C1 — one async-safe tracing runtime (CRITICAL PATH) · Phase 1
Owns all of `src/observability/` except the shared `port.ts` types frozen in W0.

| File | Action | What |
|---|---|---|
| `src/observability/spans.ts` | MODIFY | delegate the 4 live helpers to the typed `Tracer`; keep `SpanSink` as a compat adapter only |
| `src/observability/tracing/noop-tracer.ts` | MODIFY | `context` mode: allocate valid IDs + async-context WITHOUT export |
| `src/observability/tracing/otel-tracer.ts` | MODIFY | real spans, `SpanKind`, explicit parent, active async context (AsyncLocalStorage), `getActiveTraceRef()` impl |
| `src/observability/otel-span-export.ts` | MODIFY | carry kind/parent/status/error-type; drop LIFO-stack parent authority |
| `src/observability/otel-exporter.ts` | MODIFY | serialize `SpanKind` + **homogeneous arrays** (finish_reasons) + error.type |
| `src/observability/index.ts` | MODIFY | export the unified runtime + `getActiveTraceRef` |
| `src/observability/vocabulary.ts` | MODIFY | ADD canonical gen_ai.* keys (operation.name, provider.name, tool.call.id, conversation.id, agent.name, usage.cache_read/creation.input_tokens, input/output.messages); keep legacy aliases for the compat window |
| `src/observability/attrs.ts` | KEEP | builder ALREADY accepts homogeneous arrays — no change; array fix is exporter-only |
| `src/observability/patch-trace/otel-patch-trace.ts` | MODIFY | emits `handle_tool_call` recordAttrs (`:54,64`); migrate to new name/active-context so patch ops don't orphan |
| `src/tool/apply-patch.ts` | MODIFY | `:64` `PATCH_TRACE = otelPatchTracePort()` caller — re-point to the migrated span |

REUSE (do not rebuild): extend `src/observability/tracing/{port,otel-tracer,noop-tracer,w3c-propagator}.ts`; only add active-context + `getActiveTraceRef` + OTLP `arrayValue`. Reconcile `buildExportingTracer` rather than adding a 3rd export path.

Acceptance: two interleaved roots never cross-link; concurrent tool calls are
siblings; `CLIENT` on sampling, `INTERNAL` on agent/tool/turn; `context` mode
yields valid IDs with zero exporter calls.

### C6 — viewer projection · Phase 5 (parallel — needs only W0 data contract)
| File | Action | What |
|---|---|---|
| `tools/trajectory-viewer/index.html` | MODIFY | render span TREE (invoke_agent→chat/execute_tool); join OBSERVE/cassette on `{traceId,spanId}`; badges for legacy/redacted/truncated/degraded; keep the pinned run summary |
| `src/apps/bench/trace-viewer.html` | MODIFY | same tree projection for the OTLP sink UI |
| `src/apps/bench/otel-trace-sink.ts` | MODIFY | expose the joinable `{traceId,spanId}` + attrs it already ring-buffers |

Build against fixtures until C3/C4 emit real `traceId`.

## Wave 2 (parallel ×3, after C1 lands) — all consume `getActiveTraceRef`/`withSpan`

### C2 — agent-loop instrumentation · Phase 1 activation + Phase 2 attrs + Phase 4 hooks
Owns `src/agent/` loop call sites. (One cluster owns these files end-to-end so
activation+attrs+content don't collide.)

| File | Action | What |
|---|---|---|
| `src/agent/loop/entry.ts` | MODIFY | `withSpan(invoke_agent)` active around the session; stamp `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name`, `gen_ai.conversation.id` |
| `src/agent/loop/turn-loop.ts` | MODIFY | activate the `session_task.turn` structural span |
| `src/agent/loop/stream-consume.ts` | MODIFY | `chat {model}` CLIENT span active over the sampling; `gen_ai.request.model`/`provider.name`/usage/finish_reasons(array) |
| `src/agent/dispatch.ts` | MODIFY | `execute_tool {name}` INTERNAL span; `gen_ai.tool.name`/`tool.call.id`/`tool.type` |
| `src/agent/loop-helpers.ts` | MODIFY | content-capture hook points (Phase 4), gated |
| `src/agent/session-resources.ts` | MODIFY | fold instance/attempt/conversation attrs onto the session span (already partly there) |
| `src/agent/types.ts` | MODIFY | thread `spanIdentity`/capture-policy config through `AgentConfig` |
| `src/agent/admissibility-gate/hitl.ts` | MODIFY | `:358` recordAttrs `handle_tool_call` (HITL tier) — re-point to `execute_tool`/active context (GAP) |
| `src/agent/admissibility-gate/shared.ts` | MODIFY | `:622` recordAttrs `handle_tool_call` (HITL handoff) — same (GAP) |

### C3 — OBSERVE join to active context · Phase 3
| File | Action | What |
|---|---|---|
| `src/stream/adapters/jsonl-recorder.ts` | MODIFY | inject `getActiveTraceRef` callback (DI — no `@/observability` import from `@/stream`); stamp `traceId/spanId/parentSpanId`; fill `monotonicNs` from a run-local `hrtime` origin |
| `src/runner/batch/observe.ts` | MODIFY | `BenchObserver` events carry the active span or instance-root TraceRef; provide the monotonic clock |
| `src/apps/bench/observe.ts` | (inert barrel) | 2-line re-export — no real work here |
| `src/apps/probe/render.ts` | MODIFY | **GAP/silent-breaker**: `turnKey()` (`:28-32`) groups turns by `parentSpanId.startsWith("t")`/`"tool:"` — real OTel hex ids never start with `t`; re-key on `kind:"turn_start"` so the timeline doesn't silently scramble |

### C4 — cassette join to active context · Phase 3
| File | Action | What |
|---|---|---|
| `src/llm/replay/recording-llm.ts` | MODIFY | capture the active `chat` TraceRef at `stream()` start → `RecordedInteraction.metadata` (with run/instance/attempt); **excluded from the request hash** |
| `src/llm/replay/types.ts` | MODIFY | metadata carries `TraceRef` |
| `src/apps/bench/trajectory.ts` | MODIFY | supply `callCtx` + TraceRef provider on the record path (today `maybeRecordTrajectory` omits it) |

## Wave 3 (after C2) — C5 bench identity + root · Phase 2 identity + Phase 1 root
| File | Action | What |
|---|---|---|
| `src/apps/bench/otel.ts` | MODIFY | resolve ONE run id before OTel boot; feed both `QUANTA_RUN_ID` compat and the OTLP resource from it (kills the `QUANTA_OTEL_RUN_ID` divergence) |
| `src/apps/bench/run-main.ts` | MODIFY | seed run id before OTel attach; open the `quanta.bench.instance` INTERNAL root per attempt; thread root parent into `runAgent` |
| `src/apps/bench/run-main-helpers.ts` | MODIFY | root/observe wiring |
| `src/runner/batch/eval/driver/config-build.ts` | MODIFY | send `spanIdentity.{instanceId,attempt}` (today instanceId only, `:546`); `attempt` owned by `runRetryLoop` (`retry-policy.ts:370`) — thread it down |
| `src/apps/bench/default-trace-sink.ts` | MODIFY | **GAP**: `:51` is a THIRD `QUANTA_OTEL_RUN_ID` writer — must consume the single unified run id, not re-mint |
| `src/apps/bench/remote/box-session.ts` | MODIFY | **GAP**: `:153` forwards `QUANTA_OTEL_RUN_ID` to full-remote boxes — forward the unified id or boxes lose correlation |

## Wave 4 (last, solo) — C7 cutover + ratchets · Phase 6 + rails
| File | Action | What |
|---|---|---|
| `src/observability/vocabulary.ts` | MODIFY (DELETE aliases) | remove deprecated keys after the compat window |
| `src/observability/spans.ts` | MODIFY (DELETE) | remove the `SpanSink` compat adapter + LIFO stack |
| `src/stream/adapters/jsonl-recorder.ts` | MODIFY (DELETE) | stop writing `t<turn>`/`llm:t<turn>`/`tool:<id>` in unified mode |
| `tests/**` | ADD | the new mandatory rails (async interleave, context-only, unified-tuple box fixture, run-id authority, Best-of-N, semconv byte fixture, content-off negative, legacy-read/new-write + final legacy-write ratchet) |
| `src/apps/bench/commands/trace.ts` | MODIFY | `:93` read-side `QUANTA_OTEL_RUN_ID` consumer — sweep to unified id |
| `src/apps/bench/otel-trace-sink.ts` | MODIFY | `:209-211` read-side run-id/`quanta.run.id` consumer — sweep |
| `tests/unit/{jsonl-recorder,trajectory,probe}.test.ts` | MODIFY | update the golden `llm:`/`tool:` prefix + probe fixtures to the unified ids |
| `docs/10.feature-catalog.md` (via `bun fc build`) | REGEN | never hand-edit |
| `docs/decisions/{0074,0539}.md` | MODIFY | finalize |

## New files to ADD (not just modify)

- `tests/unit/observability/async-interleave-hellgate.test.ts` — two roots / overlapping tools / exact parent tree.
- `tests/unit/observability/context-mode.test.ts` — valid IDs, zero exporter calls.
- `tests/integration/unified-tuple-box.test.ts` — OTLP≡OBSERVE≡cassette `{traceId,spanId}` from one fixture.
- `tests/unit/observability/genai-semconv-bytes.test.ts` — asserts exact names/kinds/keys/array-types/units/error.type from serialized OTLP.
- `tests/unit/observability/content-capture-off.test.ts` — no prompt/message/tool content in OTLP when off; redaction before buffer.
- (optional) `src/observability/tracing/active-context.ts` — the AsyncLocalStorage active-span store, if C1 wants it separate from `otel-tracer.ts`.

## Fan-out summary (who runs when)

| Wave | Concurrent clusters | Gate to next |
|---|---|---|
| pre | **branch reconciliation** (land/rebase/abandon the 5 pre-`1e7ad280f` trajectory/observation branches) | none conflict on C2/C3/C5 files |
| 0 | contracts (solo) | ADR accepted + types frozen |
| 1 | **C1 core** (extend existing `tracing/` port), C6 viewer | C1 runtime + `getActiveTraceRef` green (async-interleave rail) |
| 2 | **C2 loop** (+ hitl/admissibility/patch-trace sites), C3 observe (+ probe/render fix), C4 cassette | unified-tuple box fixture green + probe timeline correct |
| 3 | C5 bench identity/root (+ default-trace-sink/box-session run-id) | run-id-authority + Best-of-N rails green |
| 4 | C7 cutover (solo) | closeout gates (typecheck/lint/god-code/full suite) |

Each cluster lands on its own branch/worktree; file-disjoint so `cp`-land + a
main `tsc` backstop merges cleanly (per the parallel-wave landing recipe). C1 is
the long pole — start it first and staff it heaviest.
