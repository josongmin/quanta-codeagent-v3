# Ticket — Tracing SSOT + OTel-GenAI SOTA alignment

- **Date:** 2026-07-13
- **Status:** PLAN — no ticket started. Plan: [docs/plans/jul-13-tracing-ssot-sota.md](../plans/jul-13-tracing-ssot-sota.md). Governing ADR: [ADR-0539](../decisions/0539-tracing-observability-architecture.md).
- **Provenance:** deep code investigation (off-mode data shape, context-mode cost, viewer-merge feasibility) + 2026-07 OTel-GenAI SOTA web research + a 3-P1 adversarial review of the plan (all folded in). Truth-source: HEAD `9d01eb139`; normative semconv pin `63f8200eee093730ce845d26ce2aafb621b0807e`.
- **Goal:** the three purposes each work, on a reproducible SOTA basis — (1) troubleshooting trace tree, (2) cassette replay, (3) full joined history in the trajectory viewer for EVERY run.

> **SSOT model (governing):** 2 content planes + 1 correlation coordinate. Plane A = cassette (replay, unredacted, req-hash). Plane B = OBSERVE (evidence, redacted). Coordinate = trace tuple + run/instance/attempt/turn, stamped on both; OTLP = derived export. See plan.

---

## ALREADY DONE — do NOT rebuild (anti-duplication)

- **Coordinate id-unification** (OTLP≡OBSERVE≡cassette one `{traceId,spanId}`): exporter issues `TraceRef`, `withActiveSpanScope` installs it (`session-resources.ts:328-356`), async-context via `active-context.ts`. gen_ai attrs (operation/provider/model/usage/`finish_reasons` array), **CLIENT kind** for chat (`stream-consume.ts:339`), `invoke_agent`/`execute_tool`, per-attempt `quanta.bench.instance` root (`run-main-helpers.ts:withBenchInstanceRoot`). **DONE.**
- **Rule-5** missing-context enforcement (`jsonl-recorder.ts:328`, `recording-llm.ts`) + `traceContextExpected` DI (`observe.ts:179`). **DONE.**
- **Plane A**: req-hash replay + metadata `traceRef` (hash-neutral, proven); debug-sink 3 enrichers (toolExec/verdict/editTrace) COMPLETE. **DONE.**
- **Plane B**: `TrajectoryEvent`/`makeEvent` SSOT + `traceId` field; dead-producer kinds closed (patch_applied/rejected, onSelection, phase-gate decision). **DONE.**
- **Viewer** `buildSpanTree` join on `{traceId,spanId,parentSpanId}` + group-chat/tree toggle (`index.html:1166-1226,1401`). **DONE — no viewer code change in any ticket below.**
- **`hexId`** consolidated mint (`observability/tracing/hex-id.ts`). **DONE — reuse it.**
- **`contextTracer`** exists (`noop-tracer.ts:137-178`) but is UNWIRED in production — mints ids + installs context without export. T-B1 may reuse its shape but must install via `setSpanSink`, not the dead typed-tracer path.

---

## Phase A — Pin authority + reframe (docs + 1 fixture; code-risk none)

### T-A0 — [INFRA / blocks C+D acceptance] raw-OTLP proof harness
- **Why:** ADR/plan require a conformance claim to be backed by **raw `/v1/traces` + `/v1/metrics`** payloads (pinned names, kinds, keys, value-types, units), not "tests pass." No such capture harness exists for offline assertion.
- **Where (verified):** OTLP is serialized in `otel-exporter.ts` (spans `:~330-360`, metrics `:394-449`); the live receiver is `apps/bench/otel-trace-sink.ts` (in-memory ring, `/spans.json`). No offline golden-payload fixture path.
- **Fix:** a test helper that drives the exporter over a capturing transport and returns the exact OTLP JSON (resource + scope + spans[] + metrics[]), so tickets can assert on the wire bytes. Reuse the capturing-exporter pattern from `spans-otlp-active-context-unification.test.ts`.
- **Done-criteria:** `captureOtlp(fn) → {traces, metrics}`; one smoke asserting a `chat` span's `gen_ai.operation.name`/kind reaches the traces payload.
- **Deps:** none. **Blocks:** T-A2, T-C2, T-D1 acceptance.

### T-A1 — [MED / doc-honesty] ADR-0539 SSOT reframe
- **Fix:** rewrite the ADR SSOT section to **2 plane + 1 coordinate**; demote OTel "layer" → "coordinate / derived OTLP export"; map the 3 purposes; state requirement levels **as read from the pin** (client/agent/tool spans = Development; duration + token metrics = Recommended — NOT Stable/Required).
- **Done-criteria:** ADR no longer calls any gen_ai span "stable"; the 2-plane+coordinate table present; the "OTLP is redundant offline / kept for live" note present.
- **Files:** `docs/decisions/0539-…md`. **Dup-check:** ADR currently frames "3 authorities" — this supersedes that wording, not a new doc.

### T-A2 — [HIGH / reproducibility] semconv pin fixture + drift guard
- **Why:** the pin SHA lives only in jul-12's plan prose; nothing machine-checks conformance against it, and the ADR has no SHA.
- **Fix:** `src/observability/semconv-pin.ts` exporting `SEMCONV_SNAPSHOT = "63f8200eee093730ce845d26ce2aafb621b0807e"` + the three blob URLs; reference it from `vocabulary.ts` (doc-link) and copy the SHA into ADR-0539. Add a drift test asserting the vocab's gen_ai key SET matches a checked-in list derived from the pinned blobs (so an unreviewed key addition/rename goes RED).
- **Done-criteria:** SHA present in ADR + `semconv-pin.ts`; drift test RED on injecting an off-pin key.
- **Deps:** T-A0 (optional, for the raw-name cross-check). **Files:** `semconv-pin.ts`, `vocabulary.ts`, ADR, new test.

---

## Phase B — Context-only SpanSink (THE enabler; default-OFF byte-identical)

> Root cause the viewer's tree is empty on normal runs: real trace ids only exist when an OTLP endpoint is set. Off-mode cassette records NO span id (`traceMeta(undefined)={}`, `recording-llm.ts:96-105`). Decoupling id-issuance from export fixes purpose #1 offline + purpose #3 tree, with **zero viewer changes**.

### T-B1 — [HIGH] `makeContextOnlySpanSink()`
- **Fix:** a `SpanSink` whose `onStart(name,attrs,kind)` returns a `TraceRef` (mint via `hexId(16)`/`hexId(8)`, inherit parent from the enclosing active ref exactly like the exporter's `onStart` parentage), and whose `onEnd`/`onScoped` are **no-ops** (no export, no buffer). This makes `spanTraceRef(span)` non-undefined so `withActiveSpanScope` installs the exact id (`session-resources.ts:344`).
- **Where (verified):** mirror `createExporterSpanSink.onStart` parentage (`otel-span-export.ts` — active-ref-first, direct-path LIFO fallback, `onScoped` eviction) MINUS the exporter. `SpanSink` shape at `spans.ts:139-184`.
- **Done-criteria:** unit — under this sink, `getActiveTraceRef()` inside `withActiveSpanScope` === the issued `{traceId,spanId}`; two concurrent sessions get distinct trace ids, no cross-parent (reuse the direct-path-concurrent-scope patterns); `onEnd` never exports.
- **Deps:** none. **Rails:** red-on-injection (revert id-install → child orphans).

### T-B2 — [HIGH] wire at bench boot + install-order + rule-5 no-spurious
- **Fix:** in `apps/bench/otel.ts` `bootBenchOtelExport` (`:168-186`): if `QUANTA_TRACE_CONTEXT` truthy AND no OTLP endpoint → `setSpanSink(makeContextOnlySpanSink())`. If an OTLP endpoint IS set, the real exporter is installed and **wins** — the context-only sink must NOT pre-empt it (order the branches; the exporter path already guards `getSpanSink()!==null` idempotently at `otel-span-export.ts:197`).
- **rule-5 caveat (MUST verify):** installing any sink flips `traceContextExpected: () => getSpanSink()!==null` true (`observe.ts:179`), arming the missing-context degraded/strict machinery. Since `withActiveSpanScope` wraps every recorded unit under the SAME `getSpanSink()!==null` gate, every emit should see a ref → **assert NO `observability_degraded` line fires** on a normal context-only run.
- **Done-criteria:** with knob on + no endpoint → cassette + OBSERVE both carry unified hex `{traceId,spanId}`; `buildSpanTree(inst).unified === true` on the produced data; ZERO spurious `missing_trace_context`. With endpoint set + knob on → the OTLP exporter is the installed sink (context-only did not shadow it). Knob off → no sink, byte-identical.
- **Deps:** T-B1, T-B3. **Rails:** off byte-identical; hellgate (behavioral seam).

### T-B3 — [MED] `QUANTA_TRACE_CONTEXT` knob + registration
- **Fix:** register the knob — `src/config/knob-inventory/extra.ts` (group `observability`, home `bench`, `kind:"bool"`, default `undefined`/OFF, truthful `readSite`) + an fc `config_refs.env` entry on `otel-genai-unified-tracing.yaml`. Read at `bootBenchOtelExport`.
- **Done-criteria:** `knob-registry-completeness-ratchet` + `knob-inventory-readsite-truthful` + fc guards green (no new orphan). fc md regenerated (mind the concurrent-yaml rebuild recipe — move untracked concurrent yamls aside before `fc build`).
- **Deps:** none. **Dup-check:** distinct from `QUANTA_OTEL_ENDPOINT` (that = ids+export; this = ids-only).

---

## Phase C — Standard OTel-GenAI metrics (Recommended; units+dimensions mandatory)

### T-C1 — [MED / transport gap] metric port: unit + descriptor
- **Why:** `MetricSample` (`metrics/port.ts:35-44`) has NO `unit`/`description`; the OTLP metric serializer (`otel-exporter.ts:394-449`) emits no unit. Name+number alone is non-conformant.
- **Fix:** add a typed instrument descriptor `{name, unit, description, kind}` (or extend the sample) as an SSOT; serialize `unit` (+ optional `description`) into the OTLP metric. Keep existing metrics byte-identical (unit optional / defaulted).
- **Done-criteria:** raw `/v1/metrics` (via T-A0) shows a `unit` field on a histogram; pre-existing metrics unchanged on the wire.
- **Deps:** T-A0. **Rails:** existing 17 tracing rails stay green; new metric wire test.

### T-C2 — [MED] emit `gen_ai.client.operation.duration` + `token.usage`
- **Fix:** at the chat/sampling span close (`stream-consume.ts`/`loop-helpers.ts`, where usage+duration are already captured):
  - `gen_ai.client.operation.duration` — histogram, **unit `s`** (convert ms→s from the sampling-span duration).
  - `gen_ai.client.token.usage` — histogram, **unit `{token}`**, emitted as **two series** keyed by required `gen_ai.token.type` = `input` | `output` (never one combined number).
  - Both carry dimensions `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.operation.name`, and `error.type` on error.
- **Where (verified):** usage already captured (`stream-consume.ts` `capturedUsage`), duration derivable from the sampling span. Metric sink already exists (emitUsage/meter).
- **Done-criteria:** raw `/v1/metrics` fixture asserts BOTH names, `unit=s` / `unit={token}`, the input/output `gen_ai.token.type` split, and the 3+1 dimensions. Gated on sink live → byte-identical off.
- **Deps:** T-C1, T-A0. **Rails:** off byte-identical; red-on-injection (drop token.type → fixture RED).

---

## Phase D — Opt-in content capture (PINNED form; default-OFF; redacted)

### T-D0 — [SPIKE / blocks D1] representation decision
- **Decide (cite the pinned blob):** attribute form `gen_ai.input.messages`/`gen_ai.output.messages` (structured value; **no new transport** — exporter already serializes attrs) **vs** event form `gen_ai.client.inference.operation.details` (**needs new transport**: SpanEvent API on `SpanSink`, `ExportSpan.events[]`, OTLP `events[]` serializer — none exist per `spans.ts:139-184`, `otel-exporter.ts:96-114`).
- **Recommendation:** attribute form unless a target backend requires the event form. Record the decision + the exact pinned message schema in the ticket.
- **Done-criteria:** decision recorded with blob link; D1/D2 scoped accordingly.

### T-D1 — [MED / content governance] content capture, attribute form (if T-D0 = attr)
- **Fix:** opt-in `gen_ai.input.messages`/`output.messages` on the chat span as **structured attributes** (specify the JSON encoding rail — NOT plain strings), gated by a knob mirroring `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` (default **OFF**). Content on the OTLP path is **redacted** via Plane B `redactValue`. Cassette stays unredacted (Plane A contract, unchanged).
- **Done-criteria (adversarial ≥3):** default-OFF proof (no content attr when unset); redaction proof (secret in → redacted out on the span); cassette-unredacted-unchanged proof; raw-OTLP fixture (T-A0) showing the pinned attribute shape + value-type. No raw content on any span by default.
- **Deps:** T-D0, T-A0. **Rails:** hellgate + ≥3 adversarial (content on external-export surface); knob registration (Phase-B recipe).

### T-D2 — [DEFER unless T-D0 = event] span-event transport
- **Only if event form chosen.** Build: `SpanSink` event method + `ExportSpan.events[]` + OTLP `events[]` serializer + raw-OTLP fixture. Then D1's payload rides the event.
- **Done-criteria:** raw-OTLP shows `events[]` with `gen_ai.client.inference.operation.details`. **Deps:** T-D0=event.

---

## Phase E — Plane hardening (parallel, low risk)

### T-E1 — [MED] Plane A secret-boundary drift-guard
- **Fix:** a guard test asserting UNREDACTED content is written ONLY by the cassette path (`recording-llm.ts`/`trajectory.ts`) — OBSERVE/metrics/OTLP-content paths must go through `redactValue`. Catches a future code path leaking raw content outside the operator boundary.
- **Done-criteria:** test RED on injecting a raw-content write into an OBSERVE/OTLP path. **Deps:** none.

### T-E2 — [LOW] Plane A fork-from-failure entrypoint
- **Fix:** document + surface fork-from-failure as a first-class operation (it exists but scattered) — one entrypoint/doc: "replay cassette up to turn N, resume with config override." No new engine, just consolidate + name it.
- **Done-criteria:** doc + a smoke exercising the existing fork path end-to-end. **Deps:** none.

### T-E3 — [MED] Plane B TrajectoryKind schema-version + drift-guard
- **Fix:** a declared schema version for `TrajectoryKind`/`*Data` + a guard that fails if a kind is declared without a `*Data` contract OR emitted without declaration (extends the existing partial guards).
- **Done-criteria:** guard RED on an undeclared kind. (Stretch, separate: OTel-Logs-model alignment for external ingestion.) **Deps:** none.

---

## Phase F — Context default-ON (measure-first; SEPARATE gate — do last)

### T-F1 — [MED / measure-first] flip `QUANTA_TRACE_CONTEXT` default-ON for bench
- **Gate (do NOT bundle with T-B*):** (i) confirm no trajectory consumer / probe / golden fixture breaks on the added trace fields; (ii) regenerate golden trajectory fixtures; (iii) A/B that the byte change is inert to downstream. Only then default-ON.
- **Done-criteria:** every bench run's trajectory viewer shows the span-tree with no flag; fixtures regenerated; probe/consumers green.
- **Deps:** T-B* landed + soaked. **Rails:** this is the ONE ticket that intentionally breaks off-byte-identical — behind its own commit + measure-first evidence.

---

## Dependency order
T-A0 → (T-A1, T-A2) · T-B1 → T-B2 (needs T-B3) · T-C1 → T-C2 · T-D0 → T-D1 (or T-D2) · E-tickets parallel · **T-F1 last**.
Quick-win path to "viewer tree works on every run": **T-B1 + T-B3 + T-B2** (then opt-in with the knob; T-F1 makes it default).

## Rails (every ticket)
Hellgate RED-e2e → TDD → ≥3 adversarial + objective audits → self-audit; red-on-injection on every emit/guard; OFF ⇒ byte-identical except T-F1; metadata never in the request hash; concurrent-session isolation (`git push origin HEAD:main` + rebase, stage own files only, never touch others' in-flight); new knob ⇒ inventory + fc + drift-guards.
