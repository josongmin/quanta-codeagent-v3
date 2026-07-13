# Tracing/Observability SSOT — SOTA alignment plan (2026-07)

Status: PLAN (governing ADR: [ADR-0539](../decisions/0539-tracing-observability-architecture.md))
Owner: songmin · Concurrent-branch note: land via `git push origin HEAD:main` + rebase, stage only own files.

## Purpose (the three things this system must do)

1. **Troubleshooting tracing** — a real trace/span tree (OTel-native) to debug "what happened, in what causal order, why did it stall/fail."
2. **Cassette replay** — deterministic re-run / fork-from-failure from recorded LLM interactions, no live LLM.
3. **Concrete history inspection in the management tool** — the trajectory viewer
   (`file:///Users/songmin/quanta-codeagent-v3/tools/trajectory-viewer/index.html`) must show the
   full, joined history of any run (prompts, responses, scaffold actions, tool calls, verdicts).

These three are NOT one store. They have incompatible contracts, so they are distinct SSOTs — mapped below.

## The SSOT model (2 content planes + 1 correlation coordinate)

> Reframe of ADR-0539's "three layers": OTel is NOT a peer content store — it is the correlation
> COORDINATE both planes stamp, and OTLP is a derived export of it. Rule for "is this a separate SSOT?":
> only if it has a contract that PREVENTS merging. A↔B genuinely can't merge (redaction + content-scope);
> OTel has no such content contract (same ids, projected out).

| SSOT | What | Contract (why it can't merge) | Serves purpose |
|---|---|---|---|
| **Plane A — REPLAY** (cassette) | `RecordedInteraction {id,request,events,metadata}` per LLM `stream()` | unredacted · request-hash identity · LLM-only · SECRET (operator boundary) | **#2 replay** |
| **Plane B — EVIDENCE** (OBSERVE) | `TrajectoryEvent` stream (`makeEvent`) — agent events + scaffold actions | redacted · shareable · whole-scaffold scope | **#3 history** |
| **Coordinate — CORRELATION** | `{traceId,spanId,parentSpanId}` + `{runId,instanceId,attempt,turn,conversationId}` | stamped on BOTH planes; identity/causality SSOT. OTLP = derived export | **#1 troubleshooting** (+ the join that powers #3) |
| (+ DEBUG-sink) | `metadata.debug` enrichers (toolExec/verdict/editTrace) | optional annotation riding Plane A, `RECORD=debug` | #1/#3 detail |

Key consequence: the trajectory viewer (purpose #3) reads **Plane B + Plane A**, joined on the **Coordinate**.
The OTLP viewer (`otel-trace-sink.ts`/`trace-viewer.html`, :4318) is a **live** export view of the Coordinate for
purpose #1 during a run — kept separate, NOT merged (it is redundant offline; the tree is reconstructable from B+A).

## SOTA reference (2026-07) + why

Industry standard = **OpenTelemetry GenAI semantic conventions** (Phoenix/OpenInference, Langfuse, Braintrust all ingest OTel):
- `chat {model}` **CLIENT** span is **STABLE** (graduated early 2026); `invoke_agent`/`create_agent`/`execute_tool` agent/tool spans are **Development** but stable in practice (v1.41).
- **Required metric** `gen_ai.client.operation.duration` (histogram); recommended `gen_ai.client.token.usage` (histogram).
- **Content capture**: default OFF (`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false`); messages ride **span EVENTS** / `gen_ai.input.messages`·`gen_ai.output.messages` (NOT attributes) so a Collector can filter/redact without touching app code. Defense-in-depth: SDK gate + Collector redaction/transform.
- Attribute names still shift (Development badges) → **PIN the semconv version** (ADR already does).
- "One-schema" principle: whatever the harness, emit OTel-gen_ai-conformant output so any backend works with zero custom logic.

Sources: OTel gen-ai-spans (stable client spans); OTel blog "Inside the LLM Call" (2026); GenAI Agent SemConv Cheat Sheet 2026; Braintrust "Agent observability 2026"; oneuptime "Capture GenAI prompt/completion events" + "Redact sensitive prompts".

Quanta's 2-plane model is AHEAD of the OTel baseline (OTel has only binary content-on/off; quanta separates replay-exact from evidence-redacted). So **SOTA-alignment work targets the Coordinate/OTLP export only**; the planes stay.

## Current state (landed this session, on main)

- Coordinate: active-context (AsyncLocalStorage `TraceRef`), **id-unification** (OTLP≡OBSERVE≡cassette share one `{traceId,spanId}`), gen_ai attrs (operation/provider/model/usage/`finish_reasons` array), **CLIENT kind** for chat, `invoke_agent`/`execute_tool`, per-attempt `quanta.bench.instance` root, semconv version pinned, rule-5 missing-context enforcement.
- Plane A: request-hash replay + metadata `traceRef` (hash-neutral, invariant proven), debug-sink **3 enrichers COMPLETE** (toolExec/verdict/editTrace).
- Plane B: `TrajectoryEvent`/`makeEvent` SSOT, redaction, RunContext tuple + `traceId`, all dead-producer kinds closed (patch_applied/rejected, onSelection, phase-gate decision).
- Viewer: `buildSpanTree` join on `{traceId,spanId,parentSpanId}`, group-chat + span-tree toggle, debug-sink surfaced.
- **The gap**: the Coordinate only POPULATES when a span sink is live (OTel endpoint set). For a normal run (endpoint unset) cassette records **no** span id (`traceMeta(undefined)={}`, `recording-llm.ts:96-105`) → the viewer's span-tree is empty and falls back to the timestamp/`t<turn>` group-chat. Troubleshooting-tracing (#1) and the tree view of #3 only work when tracing was on.

## Plan (phased)

### P-A — ADR-0539 reframe (docs only, code 0) — DO FIRST
Rewrite the SSOT section to the **2 plane + 1 coordinate** model; demote OTel from "layer" to "coordinate / derived export"; state the SOTA conformance target + pinned semconv version; map the 3 purposes to the SSOTs. No behavior change.
- Files: `docs/decisions/0539-tracing-observability-architecture.md`. Risk: none.

### P-B — G3: context-only SpanSink (THE enabler for #1 offline + #3 tree) — default-OFF
Decouple "issue real trace ids" from "OTLP export" so **every run** has a real Coordinate without an OTLP endpoint.
- Add `makeContextOnlySpanSink()` (observability): `onStart` mints a `TraceRef` via `hexId` (mirror the exporter's id issuance, minus export); `onEnd`/`onScoped` no-op.
- Wire at the bench composition root (`apps/bench/otel.ts` `bootBenchOtelExport`): if **no** OTLP endpoint **and** knob `QUANTA_TRACE_CONTEXT=1` → install the context-only sink. If an OTLP endpoint IS set → the real exporter wins (guard install order so context-only never pre-empts the exporter — `getSpanSink()!==null` idempotent check).
- Register knob `QUANTA_TRACE_CONTEXT` (inventory `src/config/knob-inventory/extra.ts` + fc entry).
- **rule-5 caveat**: installing any sink flips `traceContextExpected: () => getSpanSink()!==null` true → the missing-context degraded machinery activates. Since `withActiveSpanScope` wraps every recorded unit under the same gate, refs are always present → verify NO spurious `observability_degraded` fires.
- Cost: negligible (µs id mint + `AsyncLocalStorage.run` vs seconds-scale LLM). Replay-safe (metadata unhashed). Only the recorded trajectory BYTES change (adds trace fields) → default-OFF keeps it byte-identical until opted in.
- Files: `src/observability/otel-span-export.ts` (or sibling) + `src/observability/spans.ts` (export), `src/apps/bench/otel.ts`, `src/config/knob-inventory/extra.ts`, fc yaml. Viewer: **0 changes** (`buildSpanTree` already consumes the ids).
- Test: knob-on (no endpoint) → cassette+OBSERVE both carry unified hex `{traceId,spanId}`, `buildSpanTree` `unified=true`, parent links correct, NO spurious degraded; knob-off → no sink, byte-identical.
- Result: purpose #3 gains a working **span-tree** view on ordinary runs; purpose #1 troubleshooting works offline. Group-chat view unchanged (still default).

### P-C — G1: standard OTel GenAI metrics
Emit the required + recommended metrics so any OTel backend (Phoenix/Langfuse/Braintrust) shows latency/token dashboards.
- `gen_ai.client.operation.duration` (histogram, REQUIRED) — per `chat`/LLM call, from the sampling-span duration.
- `gen_ai.client.token.usage` (histogram, recommended) — input/output tokens, from the captured usage.
- Emit through the existing metric sink; gated on the sink being live (byte-identical off).
- Files: `src/observability/*` (metric emission at the chat span close in `stream-consume.ts`/`loop-helpers.ts`), vocabulary. Risk: low (observe-only).

### P-D — G2: opt-in content capture, SOTA form (span events, default-OFF, redacted)
Let Phoenix/Langfuse show messages when opted in, WITHOUT breaking the plane contracts.
- `gen_ai.input.messages` / `gen_ai.output.messages` emitted as span **EVENTS** (not attributes), gated by a knob mirroring `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` (default **OFF**).
- Content on the OTLP export path is **redacted** (reuse Plane B `redactValue`) — the cassette stays unredacted (that's Plane A's contract, unchanged). No raw content leaks onto spans by default.
- **No-leak adversarial audit required** (this touches content on an external-export surface): default-off proof, redaction proof, cassette-unredacted-unchanged proof.
- Files: loop span sites + vocabulary + knob + fc. Risk: medium (content governance) → hellgate + ≥3 adversarial.

### P-E — Plane A/B hardening (parallel, low risk)
- Plane A: **secret-boundary drift-guard** (a test/lint asserting unredacted content is written ONLY by the cassette path — nothing else emits raw). Fork-from-failure entry-point documented as a first-class operation.
- Plane B: **TrajectoryKind schema version + drift-guard** (new kinds must declare their `*Data` contract; a guard fails on an unemitted/undeclared kind). (Stretch) align OBSERVE to the OTel Logs data model for external ingestion.

### P-F — P1: context default-ON (measure-first, separate gate)
Flip `QUANTA_TRACE_CONTEXT` to default-ON for bench after: (i) confirm no trajectory-consumer/probe breaks on the new trace fields, (ii) regenerate golden fixtures. End state: **every run** is unified in the trajectory viewer with zero flags. Requires fixture regen — do NOT bundle with P-B.

## The trajectory viewer (purpose #3) — before / after

- **Today**: group-chat timeline (🧑 me / 🛰 Quanta / 🤖 LLM, timestamp-merged OBSERVE+cassette) works for **every** run — this already satisfies "concrete history." The **span-tree** toggle only appears when the run had trace ids (OTel-on), else hidden.
- **After P-B (knob on)**: span-tree toggle appears on ordinary runs too — the causal `instance → invoke_agent → turn → chat/tool` tree with full per-node evidence + debug-sink detail. Group-chat stays the default view.
- **After P-F (default-on)**: the above with no flag. Viewer code itself is unchanged across all phases (`buildSpanTree` already built).
- OTLP `trace-viewer.html` (:4318) stays for **live** waterfall during a run; the offline trajectory viewer is the history tool.

## Rails / invariants (every phase)
- Hellgate RED e2e setup → TDD → **≥3 adversarial audits** + objective → self-audit; red-on-injection on every emit/guard.
- OFF ⇒ byte-identical until the explicit default-ON gate (P-F); metadata never enters the request hash (replay invariant).
- Concurrent-session isolation: re-verify HEAD, `git push origin HEAD:main` + rebase, stage only own files, never touch others' in-flight work.
- Registration: any new knob → inventory + fc; run knob-registry-completeness + fc drift-guards.

## Ordering
P-A (now) → P-B (enabler; unblocks #1 offline + #3 tree) → P-C, P-D, P-E (parallel) → P-F (measure-first, last).

## Open decisions
- G2 content capture: confirm the knob name + whether to honor the OTel env var directly.
- P-F default-ON: needs a measure-first A/B (does the added trace-field byte change break any downstream consumer?) before flipping.
- Production box run (validate the OTLP tuple over a real network hop) — separate, needs auth + spend.
