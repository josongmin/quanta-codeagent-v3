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

## SOTA reference — PINNED snapshot (normative), not upstream main

Industry standard = **OpenTelemetry GenAI semantic conventions** (Phoenix/OpenInference, Langfuse, Braintrust ingest OTel). The requirement levels below are read from the **PINNED snapshot** — NOT from upstream `main` (upstream moves; the project's contract is the pin, for reproducibility). Upstream may have graduated client spans on main since, but that is irrelevant to conformance judged against the pin.

**Normative snapshot: commit `63f8200eee093730ce845d26ce2aafb621b0807e`** (same pin as [jul-12-otel-genai-unified-tracing.md](jul-12-otel-genai-unified-tracing.md)).
- [GenAI client spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/63f8200eee093730ce845d26ce2aafb621b0807e/docs/gen-ai/gen-ai-spans.md) · [GenAI agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/63f8200eee093730ce845d26ce2aafb621b0807e/docs/gen-ai/gen-ai-agent-spans.md) · [OpenAI overrides](https://github.com/open-telemetry/semantic-conventions-genai/blob/63f8200eee093730ce845d26ce2aafb621b0807e/docs/gen-ai/openai.md)

Facts from the pin (do NOT overstate):
- `chat {model}` CLIENT span + `invoke_agent`/`create_agent`/`execute_tool` agent/tool spans are **ALL Development** (not Stable). Do not call any of them "stable" / "stable in practice" in the ADR or this plan.
- `gen_ai.client.operation.duration` (histogram, **unit `s`/seconds**) and `gen_ai.client.token.usage` (histogram, **unit `{token}`**, split by required `gen_ai.token.type` = `input`|`output`) are both **Recommended** (NOT Required). Common metric dimensions: `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.operation.name`, and `error.type` on error.
- **Content capture** default OFF. Two pinned representations exist and are DIFFERENT — pick ONE and cite the blob (see P-D): (a) opt-in **attributes** `gen_ai.input.messages` / `gen_ai.output.messages` (structured value), OR (b) a dedicated **span event** named `gen_ai.client.inference.operation.details` carrying them. `gen_ai.input.messages`/`output.messages` are attribute names, NOT event names.
- Attribute names still shift (Development) → the **pinned SHA is the only reproducible authority**. Copying it into ADR-0539 + a code fixture is a P-A deliverable (below); it is NOT yet in the ADR.
- "One-schema" principle: emit output conformant to the PIN so any backend works with zero custom logic.

Sources (upstream, background only — the PIN governs): OTel gen-ai-spans; OTel blog "Inside the LLM Call" (2026); GenAI Agent SemConv Cheat Sheet 2026; Braintrust "Agent observability 2026"; oneuptime "Capture GenAI prompt/completion events" + "Redact sensitive prompts".

Quanta's 2-plane model is AHEAD of the OTel baseline (OTel has only binary content-on/off; quanta separates replay-exact from evidence-redacted). So **SOTA-alignment work targets the Coordinate/OTLP export only**; the planes stay.

## Current state (landed this session, on main)

- Coordinate: active-context (AsyncLocalStorage `TraceRef`), **id-unification** (OTLP≡OBSERVE≡cassette share one `{traceId,spanId}`), gen_ai attrs (operation/provider/model/usage/`finish_reasons` array), **CLIENT kind** for chat, `invoke_agent`/`execute_tool`, per-attempt `quanta.bench.instance` root, rule-5 missing-context enforcement. ⚠️ The semconv SHA is pinned in jul-12's plan but **NOT yet copied into ADR-0539 or a code fixture** (P-A closes this).
- Plane A: request-hash replay + metadata `traceRef` (hash-neutral, invariant proven), debug-sink **3 enrichers COMPLETE** (toolExec/verdict/editTrace).
- Plane B: `TrajectoryEvent`/`makeEvent` SSOT, redaction, RunContext tuple + `traceId`, all dead-producer kinds closed (patch_applied/rejected, onSelection, phase-gate decision).
- Viewer: `buildSpanTree` join on `{traceId,spanId,parentSpanId}`, group-chat + span-tree toggle, debug-sink surfaced.
- **The gap**: the Coordinate only POPULATES when a span sink is live (OTel endpoint set). For a normal run (endpoint unset) cassette records **no** span id (`traceMeta(undefined)={}`, `recording-llm.ts:96-105`) → the viewer's span-tree is empty and falls back to the timestamp/`t<turn>` group-chat. Troubleshooting-tracing (#1) and the tree view of #3 only work when tracing was on.

## Plan (phased)

### P-A — ADR-0539 reframe + PIN authority (docs + one code fixture) — DO FIRST
Rewrite the SSOT section to the **2 plane + 1 coordinate** model; demote OTel from "layer" to "coordinate / derived export"; map the 3 purposes to the SSOTs. No behavior change.
Deliverables (the pin authority the current docs LACK):
1. Copy the normative SHA `63f8200eee093730ce845d26ce2aafb621b0807e` + the three blob links into ADR-0539 (it currently has none).
2. Add a **code fixture** pinning the SHA (e.g. `src/observability/semconv-pin.ts` `SEMCONV_SNAPSHOT = "63f8200…"`) referenced by the vocabulary + a drift test, so "conformant to the pin" is machine-checkable, not prose.
3. State requirement levels **as read from the pin**: client/agent/tool spans = Development; the two metrics = Recommended (NOT Required/Stable). Restore jul-12's SOTA-claim boundary — a conformance claim requires **raw-OTLP proof** (pinned names, kinds, keys, value-types) captured from `/v1/traces`+`/v1/metrics`, not just "tests pass."
- Files: `docs/decisions/0539-…md`, `docs/plans/jul-13-tracing-ssot-sota.md`, `src/observability/semconv-pin.ts` (+ its drift test). Risk: none (docs + one const + one test).

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
Both metrics are **Recommended** at the pin (not Required). Conformance = correct **units + dimensions**, not just name+number.
- **Blocker (transport gap)**: `MetricSample` (`metrics/port.ts:35-44`) has NO `unit`/`description`, and the OTLP metric serializer (`otel-exporter.ts:394-449`) does NOT emit unit. So "emit the metric" alone produces a non-conformant series. FIRST add a **typed instrument descriptor** `{name, unit, description}` (or equivalent SSOT) to the metric port + serialize `unit` into OTLP.
- `gen_ai.client.operation.duration` — histogram, **unit `s` (seconds)** — convert the sampling-span duration (ms→s). Dimensions: `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.operation.name`, `error.type` (on error).
- `gen_ai.client.token.usage` — histogram, **unit `{token}`** — split into TWO series by required `gen_ai.token.type` = `input` | `output` (not one combined number). Same dimensions.
- Gated on the sink being live (byte-identical off).
- Acceptance: **raw `/v1/metrics` OTLP fixture** asserting name + unit + `gen_ai.token.type` split + dimensions (not just a value showing on a dashboard).
- Files: `src/observability/metrics/port.ts` (descriptor + unit), `src/observability/otel-exporter.ts` (serialize unit), metric emission at chat-span close (`stream-consume.ts`/`loop-helpers.ts`), vocabulary. Risk: low-medium (touches the metric wire format).

### P-D — G2: opt-in content capture, PINNED form (default-OFF, redacted)
Let Phoenix/Langfuse show messages when opted in, WITHOUT breaking the plane contracts.
- **Decide the pinned representation FIRST** (the two are different and the code supports only one today):
  - **(a) ATTRIBUTE form — RECOMMENDED**: opt-in attributes `gen_ai.input.messages` / `gen_ai.output.messages` carrying a **structured value** (per the pin's message schema; specify the JSON encoding rail — these are NOT plain strings). Needs NO new transport — the exporter already serializes span attributes. Lowest cost.
  - **(b) EVENT form**: a dedicated span event named `gen_ai.client.inference.operation.details` (NOT `gen_ai.input.messages` — that's an attribute name). **Blocker**: there is NO span-event transport today — `SpanSink` is `onStart/onEnd/onScoped` only (`spans.ts:139-184`), `ExportSpan` has no `events[]` (`otel-exporter.ts:96-114`), and the OTLP serializer emits no `events`. Choosing (b) REQUIRES building: a SpanEvent API on the sink + `ExportSpan.events` + OTLP `events[]` serializer + a raw-OTLP fixture. Defer unless a backend specifically needs the event form.
- Gated by a knob mirroring `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` (default **OFF**). Content on the OTLP path is **redacted** (reuse Plane B `redactValue`); the cassette stays unredacted (Plane A contract, unchanged).
- **No-leak adversarial audit required**: default-off proof, redaction proof, cassette-unredacted-unchanged proof, + a **raw-OTLP fixture** showing the pinned representation on the wire.
- Files (form a): loop span sites (attribute build + redaction) + structured-encoding helper + vocabulary + knob + fc. (form b additionally: `spans.ts` SpanSink event method, `otel-exporter.ts` ExportSpan.events + serializer.) Risk: medium (content governance) → hellgate + ≥3 adversarial.

### P-E — Plane A/B hardening (parallel, low risk)
- Plane A: **secret-boundary drift-guard** (a test/lint asserting unredacted content is written ONLY by the cassette path — nothing else emits raw). Fork-from-failure entry-point documented as a first-class operation.
- Plane B: **TrajectoryKind schema version + drift-guard** (new kinds must declare their `*Data` contract; a guard fails on an unemitted/undeclared kind). (Stretch) align OBSERVE to the OTel Logs data model for external ingestion.

### P-F — P1: context default-ON (measure-first, separate gate)
Flip `QUANTA_TRACE_CONTEXT` to default-ON for bench after: (i) confirm no trajectory-consumer/probe breaks on the new trace fields, (ii) regenerate golden fixtures. End state: **every run** is unified in the trajectory viewer with zero flags. Requires fixture regen — do NOT bundle with P-B.

## The trajectory viewer (purpose #3) — before / after

- **Today**: group-chat timeline (🧑 me / 🛰 Quanta / 🤖 LLM, timestamp-merged OBSERVE+cassette) works for **every** run — this already satisfies "concrete history." The **span-tree** toggle only appears when the run had trace ids (OTel-on), else hidden.
- **After P-B (knob on)**: span-tree toggle appears on ordinary runs too — the causal `instance → invoke_agent → turn → chat/tool` tree, with scaffold-action evidence (sandbox/localize/verify/patch) joined on the instance node (jul-13 `observe.append()` stamp fix) + debug-sink detail. Group-chat stays the default view. NOTE (honest scope): the offline tree shows STRUCTURE + scaffold + LLM chain + raw req/resp; the GenAI-semconv ATTRS (messages / `error.type` class / token+duration metric histograms / finish_reasons) are OTLP-span/metric-only → they need a LIVE collector (Phoenix), not the offline viewer. The underlying data (req/resp, token counts via `llm_usage`, error message) is still offline-visible — only the semconv re-projection needs an endpoint.
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
- **P-D representation** (must decide before building): attribute form `gen_ai.input.messages`/`output.messages` (recommended — no new transport) vs event form `gen_ai.client.inference.operation.details` (needs a new SpanEvent transport end-to-end). Pick per the pinned blob + which backend consumes it.
- P-D knob: confirm name + whether to honor the OTel env var `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` directly.
- P-F default-ON: needs a measure-first A/B (does the added trace-field byte change break any downstream consumer?) before flipping.
- Production box run (validate the OTLP tuple over a real network hop) — separate, needs auth + spend.

## Audit corrections folded in (2026-07-13)
An adversarial review of this plan (against pin `63f8200…` + HEAD interfaces) caught three P1 defects, now fixed above: (1) requirement levels were overstated as Stable/Required from upstream main — corrected to the pin's Development/Recommended + SHA/blob/fixture made a P-A deliverable; (2) P-D assumed a span-event transport that does not exist — now decides attribute-vs-event with the event-form transport gap enumerated; (3) P-C lacked units/dimensions and the metric port lacks a unit field — now specifies seconds/`{token}` units, `gen_ai.token.type` split, provider/model dimensions, a typed instrument descriptor, and a raw `/v1/metrics` fixture as acceptance.
