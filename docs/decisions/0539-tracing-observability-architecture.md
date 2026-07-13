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
| **DEBUG-sink** | keyed slices enriched into `metadata.debug` (`toolExec` + `verdict` + `editTrace` — ALL THREE contributors wired; set COMPLETE) | free `Record` in cassette metadata | `src/apps/bench/trajectory-debug-sink.ts` | OFF (`RECORD=debug`) |
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
   - OTEL now stamps `quanta.run.id` (resource) + `quanta.instance.id` + `quanta.instance.attempt` (per-attempt root span). The attempt IS now threaded by the driver (C5): `config-build.ts` `spanIdentity` carries `deps.observe.attempt` (the same 0-based index that names the `.<attempt>.jsonl` trajectory file), stamped on the `quanta.bench.instance` root by `withBenchInstanceRoot`. Absent (`observe` off / single-pass) ⇒ key omitted, join falls back to `{runId, instanceId}`.
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
- **Honesty** — debug-sink docstring reflects reality (`toolExec` + `verdict` +
  `editTrace` ALL wired, contributor set complete); the stale "observe default-OFF"
  comment fixed (observe is default-ON).

## Residual gaps (tracked, not yet fixed)

- ~~`quanta.attempt` not threaded onto spans~~ — DONE (C5, jul-13): threaded as
  `quanta.instance.attempt` via `config-build spanIdentity` → `withBenchInstanceRoot`.
- ~~Dead trajectory kinds `patch_applied` / `patch_rejected` are declared but never
  emitted~~ — DONE (R2, jul-13): now emitted from the bench eval driver via
  `emitPatchOutcome` (`eval/report.ts`) → `BenchObserver.patchApplied`/`patchRejected`,
  carrying the declared `PatchData` (`{diffPath, filesChanged, hunks, applyStatus}`)
  that `probe/triage.ts` consumes. Emitted at the AUTHORITATIVE result-assembly sites
  (`result-assembly.ts`): `patch_applied` on the ONE verify-and-finalize path
  (`attachObservedSuccessBasics`, non-empty patch reached the grading tree,
  `applyStatus:"applied"`); `patch_rejected` on the terminal failure paths
  (`generationFailureResult` / `noPatchResult`, plus the empty-patch fail-closed grade,
  `applyStatus:"rejected"`). ONE line per terminal (not per breadth/acceptance
  candidate). Byte-identical when observe is off (`wiring.observer` undefined ⇒ no-op).
- ~~`onSelection` per-round acceptance observer is declared but bound nowhere~~ —
  DONE (R3, jul-13): the `onSelection` closure (already capturing `acceptanceTier` for
  the report) now ALSO records an OBSERVE `recovery` line (`reason:"acceptance_select"`,
  `{tier, votes, candidateCount, llmOverrode}` — no-leak, never the winning patch) via
  `BenchObserver.acceptanceSelection`, wired at BOTH drivers
  (`runner/batch/eval/driver/repair-phase.ts` and `apps/bench/eval/driver.ts`). Gated
  behind `QUANTA_BENCH_ACCEPTANCE`: OFF ⇒ the acceptance selector is `undefined` ⇒ the
  closure never fires ⇒ byte-identical.
- ~~Phase-gate blocks (`consultLocalizePhase`) return a synthetic tool_result but
  emit no `decision` event despite the kind being wired — should emit a
  `decision {kind:"gate", ruleId, outcome:"deny"}`.~~ — DONE (jul-13): emits a
  `decision` OBSERVE event on `config.stream` at the deny point
  (`src/agent/dispatch/preflight-consults.ts:128`), so the CAUSE rides the SAME
  trajectory stream as the tool_result EFFECT (jsonl-recorder maps `decision →
  recovery` kind, `reason:"decision"` + `kind`/`outcome`/`ruleId`/`toolCallId` in
  `data`; joinable to the effect by `toolCallId`). CORRECTION: the DecisionEvent
  `kind` enum has no `"gate"` arm (`permission|rule|hook|cap|jail|budget`); the
  phase-gate is a pure policy RULE, so `kind:"rule"` is the honest match and the
  only kind for which `ruleId` is meaningful. `ruleId:"localize-phase-blocked"`
  reuses the deny reason code. Per-deny (no dedupe — each blocked retry is real
  signal). Byte-identical when the guard is OFF (unreachable branch; no alloc).
  Acceptance: `tests/unit/localize-phase-decision-observe-emit.test.ts`
  (red-on-injection: removing the emit fails the 3 active-guard cases, leaves the
  3 guard-OFF/pass-through silence cases green).
- DEBUG-sink contributors now COMPLETE (jul-13) — all three wired, none pending:
  - `verdict` (contributeVerdictDebug): the driver's verify-finalize sites
    `contribute("verdict", {passed, patchBytes, observationVerdict?, error?})` so
    the grade outcome rides `metadata.debug.verdict` alongside the recorded turn.
  - `editTrace` (contributeEditTraceDebug): wired as `BenchStreamTap.onEditResult`
    (gated by `isTrajectoryDebugEnabled`). Per edit it `append`s a shaped trace
    `{file, mode(exact/fuzzy/fast-apply), outcome(matched/stale/failed),
    occurrences?, replaceAll?, fuzzyEscalated?}` — derived from the edit tool's OWN
    output message (no diff recompute / no re-read) — onto `metadata.debug.editTrace`
    as a LIST, so multiple edits per turn accumulate.
  Both are metadata-only ⇒ replay-neutral (never touch the request hash) and no-op
  off the debug gate. The debug-sink contributor set is now complete.

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
5. **No per-event legacy fallback in unified mode (ENFORCED — jul-13).** A
   missing active context WHILE a trace context is EXPECTED (a live span sink,
   `getSpanSink() !== null` — so `withActiveSpanScope` wraps every recorded unit
   and every emit should see a ref) is a correlation DEFECT → one
   `observability_degraded` record (`reason:"missing_trace_context"`) + a failed
   strict rail, NOT a silently-synthesized `t<turn>` id. The "context expected
   but missing" (defect) vs "context never wired" (legitimate) distinction is
   threaded via a `traceContextExpected?: () => boolean` DI callback (mirroring
   the `getActiveTraceRef` DI so `@/stream`/`@/llm/replay` never import
   `@/observability`), bound at the composition roots to
   `() => getSpanSink() !== null`. The OBSERVE recorder
   (`jsonl-recorder.ts:frame()` → `checkMissingTraceContext`) emits the
   `observability_degraded` line ONCE per instance (`missingRefReported` latch,
   like `capDone`) with the offending kind/seq, and rethrows on the strict rail;
   the cassette recorder (`recording-llm.ts`) warns once + stamps a
   replay-neutral `metadata.observabilityDegraded` marker. The deterministic
   `t<turn>` id is STILL synthesized as the fallback VALUE (existing consumers
   depend on it) — enforcement only ADDS the degraded signal. When no sink is
   live (OFF / context-never-wired) `traceContextExpected` returns `false` ⇒ NO
   degraded record, output BYTE-IDENTICAL to the pre-enforcement path.
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
unit acceptance already exercises a real exporter sink over `runAgent`).

- **Rule 5 enforcement (jul-13)** — expected-but-missing trace context in unified
  mode now emits `observability_degraded` (`reason:"missing_trace_context"`) +
  fails the strict rail, threaded via the `traceContextExpected` DI callback
  (`() => getSpanSink() !== null`). See rule 5 above. The deterministic `t<turn>`
  fallback VALUE is retained (existing consumers depend on it); enforcement only
  ADDS the defect signal when a sink was live but no ref was installed. C7 legacy
  DELETION — RECLASSIFIED (jul-13): NOT a deferred cleanup, a WON'T-DELETE by
  design. The `t<turn>`/`llm:t<turn>`/`tool:<id>` scheme (`jsonl-recorder.ts`
  `spanOf()`) is the CORRECT deterministic span-id for the OFF / OTel-never-wired
  path — every OFF-mode OBSERVE/probe consumer joins on those stable ids, and
  removing them would break the byte-identical OFF contract, not remove cruft.
  It is only a "fallback" in unified mode (where a real ref supersedes it) and
  there rule-5 already surfaces its use as a defect. There is NO separate
  "SpanSink compat adapter" to remove (an earlier residual-note phrasing implied
  one; the audit found none — the only legacy surface was the removed global
  regime counter, gone since R1). So this residual is CLOSED: `spanOf()` stays as
  the OFF-mode identity, unified mode never silently uses it, done.
  - Design choice + LATENT trigger (audited clean jul-13): the "expected" gate is
    raw sink-liveness (`getSpanSink() !== null`), NOT "am I inside a span scope."
    This is correct TODAY because every recorded bench emit is a descendant of
    `withBenchInstanceRoot` (which wraps the ENTIRE `runInstance`) or `runAgent`'s
    `withActiveSpanScope` — both install a real ref when the sink is live, so
    `getActiveTraceRef()` is never undefined for a legitimate in-loop event, and
    the strict throw (bound only on the bench OBSERVE recorder, `observe.ts`) is
    unreachable except on a genuine defect. TRIGGER: if a future change adds a
    bench-/run-LEVEL recorder or cassette emit OUTSIDE `withBenchInstanceRoot`
    while `QUANTA_OTEL_ENDPOINT` is set, it would strict-throw. Hardening if that
    day comes: gate on a "scope-was-entered" async-local flag, or whitelist the
    enforced kinds to the in-loop set (turn_start/llm_request/tool_*/…).
- **Hex-id consolidation (jul-13)** — the four duplicate W3C hex-id mint helpers
  (`toHex`/`randomHex`×2/`bridgeHex`) collapsed into one `@/observability/tracing`
  `hexId(byteCount, gen?)` (default crypto CSPRNG, test-seam `gen` override).
  Byte-identical output; the deterministic exporter test seam is unchanged.

## Rule for new observability features

Add to the SSOT (OBSERVE) as a typed `kind`, stamp the correlation tuple, and —
if the data is a low-frequency HIGH-VALUE decision (verdict, gate, knob posture) —
also surface it in the viewer's pinned summary, not just the ts-sorted stream.
Do NOT bolt a new event onto whichever layer is convenient.
