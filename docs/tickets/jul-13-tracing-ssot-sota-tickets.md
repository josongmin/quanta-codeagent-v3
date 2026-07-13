# Ticket — Tracing SSOT + OTel-GenAI SOTA alignment

- **Date:** 2026-07-13
- **Status:** PLAN — not started. Plan: [docs/plans/jul-13-tracing-ssot-sota.md](../plans/jul-13-tracing-ssot-sota.md). ADR: [ADR-0539](../decisions/0539-tracing-observability-architecture.md).
- **Provenance:** deep code investigation + 2026-07 SOTA research + a 3-P1 plan review, then a **3-agent SOTA++ augmentation** (anchor-verification vs HEAD `8ce399435` · pinned-semconv blob extraction · adversarial gap-find). All corrections folded in; anchors verified/corrected; 4 missing tickets added (T-B4/T-B5/T-B6/T-C3); T-B2/T-D1 hardened for instance-fatal + preview-leak.
- **Truth-source:** HEAD `8ce399435`; normative semconv pin `63f8200eee093730ce845d26ce2aafb621b0807e`.
- **Goal:** the three purposes each work on a reproducible SOTA basis — (1) troubleshooting trace tree, (2) cassette replay, (3) full joined history in the trajectory viewer for every **bench** run (non-bench surfaces = T-B6 scope decision).

> **SSOT model:** 2 content planes + 1 correlation coordinate. Plane A = cassette (replay, unredacted, req-hash). Plane B = OBSERVE (evidence, redacted). Coordinate = trace tuple + run/instance/attempt/turn/conversation, stamped on both; OTLP = derived export. See plan/ADR.

---

## Normative semconv contract (PINNED `63f8200…`) — cite THIS, not upstream main

> At this pin the convention is the NEW registry: provider = **`gen_ai.provider.name`** (enum); **`gen_ai.system` is ABSENT** (fully replaced). Content = opt-in **structured attributes** `gen_ai.input.messages`/`gen_ai.output.messages` (role + `parts[]`), carried on event **`gen_ai.client.inference.operation.details`**; system prompt = **`gen_ai.system_instructions`** (underscore). If any code/doc still says `gen_ai.system` or per-role log events, it's stale vs the pin.

**Chat (CLIENT) span** — name `{gen_ai.operation.name} {gen_ai.request.model}`, kind SHOULD be CLIENT:
- **Required (hard):** `gen_ai.operation.name` (enum), `gen_ai.provider.name` (enum).
- **Conditionally Required:** `gen_ai.request.model` (if available), `error.type` (if errored), `server.port` (if server.address set), `gen_ai.request.choice.count` (if !=1).
- **Recommended:** `gen_ai.response.model/id`, `gen_ai.response.finish_reasons` (string[]), `gen_ai.usage.input_tokens`/`output_tokens` (int), `gen_ai.request.{temperature,top_p,max_tokens,frequency_penalty,presence_penalty,stop_sequences}`, `server.address`.
- **Opt-In:** `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`.
- `gen_ai.provider.name` enum incl. `openai`, `anthropic`, `azure.ai.openai`, … (our provider slug must map into it).

**invoke_agent / execute_tool spans:** `invoke_agent {agent.name}` CLIENT (or INTERNAL variant drops provider/server); `execute_tool {tool.name}` — ⚠️ the full execute_tool SPAN attr table defers to `gen-ai-spans.md` and was NOT verbatim-verified; **re-pull that section before citing `gen_ai.tool.call.id`/`tool.description` requirement levels as normative.**

**Metrics** (both Histograms; advisory buckets in the pin):
- `gen_ai.client.operation.duration` — **unit `s`** — Required `gen_ai.operation.name`; CR `gen_ai.provider.name`, `error.type`, `gen_ai.request.model`; Rec `gen_ai.response.model`, `server.address`.
- `gen_ai.client.token.usage` — **unit `{token}`** — Required `gen_ai.operation.name` + `gen_ai.provider.name` + **`gen_ai.token.type` (enum `input`|`output`)**; CR `gen_ai.request.model`. (Asymmetry: provider is hard-Required on token.usage, CR on duration.)

**Content messages** (Opt-In, "likely PII"): message object `{role, parts:[{type:"text",content}|{type:"tool_call",id,name,arguments}|{type:"tool_call_response",id,response}]}`; on spans MAY be a JSON string if structured unsupported.

---

## ALREADY DONE — do NOT rebuild (anti-duplication)

- **Coordinate id-unification** (OTLP≡OBSERVE≡cassette one `{traceId,spanId}`): exporter issues `TraceRef`, `withActiveSpanScope` installs it (`session-resources.ts:328-356`; reads issued ref :344, installs :345), async-context `active-context.ts`. gen_ai attrs (operation/provider/model/usage/`finish_reasons` array), **CLIENT kind** chat (`stream-consume.ts:339`), `invoke_agent`/`execute_tool`, per-attempt `quanta.bench.instance` root. **DONE.**
- **Rule-5** enforcement (`jsonl-recorder.ts:327-328` checkMissingTraceContext) + `traceContextExpected` DI (`runner/batch/observe.ts:179`, also `apps/bench/trajectory.ts:207,321`). **DONE — but see T-B2: this is INSTANCE-FATAL.**
- **Plane A**: req-hash replay + metadata `traceRef` (hash-neutral); off-mode cassette carries NO span id (`recording-llm.ts:96-105`, `:99 return {}`). debug-sink 3 enrichers COMPLETE. **DONE.**
- **Plane B**: `TrajectoryEvent`/`makeEvent` + `traceId`; off-mode OBSERVE uses deterministic `t<turn>` (minted `jsonl-recorder.ts:176`, consumed by `spanOf` :916-936); dead-producer kinds closed. **DONE.**
- **Viewer** `buildSpanTree` join (`index.html:1166-1226`) + toggle (`:1401`) + `treeEmpty` message (`:697,760`) + group-chat kept default (`:810-812`). **DONE — no viewer code change below** (except optional copy fix, noted).
- **`hexId`** (`hex-id.ts:20-23`). **Reuse.** **`contextTracer`** (`noop-tracer.ts:137-173`) — UNWIRED in prod (only re-exported `tracing/index.ts:20`, never called); T-B1 reuses its SHAPE but installs via `setSpanSink`.
- **Resource attrs** `service.name` + `quanta.run.id` set (`otel-exporter.ts:328-333`) — adequate; `service.version`/`telemetry.sdk.*` absent = optional, ADR note not ticket.
- **Span status** Ok/Error mapped (`otel-exporter.ts:261-262,356-361`), `traceFlags ?? 1` sampled (`:783`). **DONE — but `error.type` ATTR missing: T-B5.**

---

## Phase A — Pin authority + reframe (docs + fixtures)

### T-A0 — [INFRA / blocks C+D acceptance] raw-OTLP proof harness
- **Why:** conformance claims must be backed by raw `/v1/traces` + `/v1/metrics` bytes (names, kinds, keys, value-types, units), not "tests pass."
- **How (corrected):** the exporter takes an INJECTED `fetch` (`otel-exporter.ts:136-138,459`) — pass a fake `fetch` that records the POST body → parse JSON. NO live receiver needed. ⚠️ The prior ticket said "reuse the pattern in spans-otlp-active-context-unification.test.ts" — that file has NO such capture; build from the injected-`fetch` seam directly.
- **Done:** `captureOtlp(fn) → {traces, metrics}` (parsed OTLP JSON); smoke asserts a `chat` span's `gen_ai.operation.name` + kind reach the traces payload.
- **Blocks:** T-A2, T-C2, T-D1 acceptance.

### T-A1 — [MED / doc-honesty] ADR-0539 SSOT reframe
- Rewrite ADR SSOT section to **2 plane + 1 coordinate**; demote OTel to coordinate/derived-export; map 3 purposes; requirement levels from the pin (spans Development; metrics Recommended — not Stable/Required). Add: monotonic-clock limitation note (spans use `Date.now` ms × 1e6 = ms granularity, `otel-exporter.ts:321` — acceptable at LLM-scale, documented not fixed).
- **Files:** ADR. **Risk:** none.

### T-A2 — [HIGH / reproducibility] semconv pin fixture + drift guard
- `src/observability/semconv-pin.ts` `SEMCONV_SNAPSHOT="63f8200…"` + 3 blob URLs; copy SHA into ADR; drift test asserting the vocab gen_ai key SET matches a checked-in pinned list (RED on off-pin key add/rename). Cross-check with T-A0 raw names.
- **Files:** `semconv-pin.ts`, `vocabulary.ts`, ADR, test. **Deps:** T-A0.

---

## Phase B — Context-only SpanSink (enabler; default-OFF byte-identical)

> Root cause the tree is empty on normal runs: real ids only exist with an OTLP endpoint. Decouple id-issuance from export.

### T-B1 — [HIGH] `makeContextOnlySpanSink()`
- `SpanSink` whose `onStart(name,attrs,kind)` returns a `TraceRef` (mint `hexId(16)`/`hexId(8)`, parent from enclosing active ref exactly like `createExporterSpanSink.onStart` :100-134 — active-ref-first, direct-path LIFO fallback, `onScoped` eviction), **`traceFlags:1` (sampled)** so a later-attached exporter/child reads a sampled ref; `onEnd`/`onScoped` no-op (no export/buffer). `SpanSink` shape at `spans.ts:139-184` (NO event method).
- **Done:** under this sink, `getActiveTraceRef()` inside `withActiveSpanScope` === issued `{traceId,spanId}`, `traceFlags===1`; 2 concurrent sessions → distinct traces, no cross-parent; `onEnd` never exports. Red-on-injection (revert id-install → child orphans).

### T-B2 — [HIGH / instance-FATAL coupling] wire at bench boot + rule-5 live-gate
- Wire in `apps/bench/otel.ts` `bootBenchOtelExport` (`:168-186`): `QUANTA_TRACE_CONTEXT` truthy AND no OTLP endpoint → `setSpanSink(makeContextOnlySpanSink())`. Endpoint set → the real exporter is installed and **wins** (order branches; exporter idempotent-guards `getSpanSink()!==null` at `otel-span-export.ts:197`); context-only must NOT shadow it.
- **⚠️ INSTANCE-FATAL (not cosmetic):** installing any sink flips `traceContextExpected: () => getSpanSink()!==null` true (`runner/batch/observe.ts:179`). A missing-context event then emits `observability_degraded` + the recorder FAILS the rail → the instance gets `verdict:"degraded"` (`observe.ts:278,312`) which is **excluded from the eval denominator** (`:294-299`). So ANY emit path outside `withActiveSpanScope` while the knob is on silently converts real solves → degraded = a **bench-correctness regression disguised as a tracing feature**.
- **Done:** knob-on + no endpoint → cassette + OBSERVE both carry unified hex `{traceId,spanId}`, `buildSpanTree(inst).unified===true`, ZERO spurious `missing_trace_context` across a full instance (every recorded kind: session_start/turn_start/llm_request/usage/tool_*/verdict/patch/done/error). Endpoint set + knob on → OTLP exporter is the installed sink (context-only didn't shadow). Knob off → no sink, byte-identical.
- **Red-on-injection (proves the gate is LIVE, per anti-inert-knob):** inject a missing-context unit under the sink → assert the instance degrades (proves non-inert AND guards the hole).
- **Deps:** T-B1, T-B3. **Risk:** HIGH (the degraded coupling).

### T-B3 — [LOW] `QUANTA_TRACE_CONTEXT` knob + registration
- Register in `config/knob-inventory/extra.ts` (mirror `QUANTA_BENCH_TRAJECTORY_DEBUG` :426 — `group:"observability"`, `home:"bench"`, `kind:"bool"`, `default:undefined`, truthful `readSite`) + fc `config_refs.env` on `otel-genai-unified-tracing.yaml`. **fc rebuild recipe:** move untracked concurrent yamls aside before `bun fc build` (else the md dangles a source-less feature).
- **Done:** knob-registry-completeness + readsite-truthful + fc guards green.
- **Naming note:** the knob is `QUANTA_TRACE_CONTEXT` (NOT `QUANTA_BENCH_`-prefixed) → it is NOT auto-forwarded to boxes → **T-B4 required**. (Alternatively name it `QUANTA_BENCH_TRACE_CONTEXT` to auto-forward; decide in T-B3.)

### T-B4 — [HIGH / purpose-3 on full-remote] forward the knob to boxes ★NEW
- **Why:** `FORWARD_EXTRA_ENV` (`box-session.ts:130-174`) forwards `QUANTA_OTEL_ENDPOINT/SERVICE_NAME/OTEL_RUN_ID/RUN_ID` but NOT `QUANTA_TRACE_CONTEXT`; forward gate (:211) is `startsWith("QUANTA_BENCH_") || FORWARD_EXTRA_ENV.has(k)`. So on a full-remote run the box records with NO sink → no ids → the FETCHED cassettes/observe the viewer loads (`launch.ts:26,88,132` from `trajectories/<box>/` + `observe-<box>.tar.b64`) degrade — exactly the runs the user most wants to inspect.
- **Fix:** add `"QUANTA_TRACE_CONTEXT"` to `FORWARD_EXTRA_ENV` (or adopt the `QUANTA_BENCH_` name in T-B3).
- **Done:** box-forward test asserts the knob reaches `buildBenchCommand` env; a fetched box cassette carries unified `{traceId,spanId}` when the operator set the knob.
- **Deps:** T-B3. **Without this, T-F1 default-ON still yields degraded full-remote viewers.**

### T-B5 — [HIGH / conformance] `error.type` on failed chat/tool spans ★NEW
- **Why:** span status code is mapped, but `buildSamplingSpanAttrs` (`loop-helpers.ts:407-456`) emits NO `error.type` and `vocabulary.ts` has NO `error.type` key (grep-confirmed absent). Semconv makes `error.type` Conditionally-Required on the span AND both metrics when errored; backends key error dashboards on it.
- **Fix:** add `error.type` to `GEN_AI_ATTRS`; set it on the span when `status==="error"` (map the error class from `stream-consume.ts:295-310` — LOW cardinality enum, never raw message). Separate emit site from T-C2 (span attr vs metric dim).
- **Done:** raw-OTLP fixture asserts `error.type` on a forced-error chat span; red-on-injection.
- **Deps:** T-A0.

### T-B6 — [MED / scope-honesty] non-bench surface coverage OR explicit scope ★NEW
- **Why:** `setSpanSink`/`bootBenchOtel` exist ONLY under `apps/bench/*` (daemon/web/CLI-agent install no sink; `daemon.ts:41` has the endpoint knob but wires no context-only sink). After Phase B, interactive daemon/web runs STILL have empty trees — but purpose #3 says "the management tool" (interactive).
- **Decide:** (a) wire `makeContextOnlySpanSink()` at the daemon/web composition root too, OR (b) ADR/plan explicitly scopes purpose-3-tree to BENCH runs. As written the tickets imply "every run" but deliver "every bench run."
- **Done:** either the daemon/web wiring + test, or an explicit ADR scope sentence.

---

## Phase C — Standard OTel-GenAI metrics (Recommended; units+dims mandatory)

### T-C1 — [HIGH / metric wire format, ALL metrics] port: unit + descriptor
- **Re-rated HIGH** (was MED): `MetricSample` (`metrics/port.ts:35-45`) has no `unit`/`description`; the OTLP metric serializer (`otel-exporter.ts:394-449`) emits none — so adding them changes the descriptor for EVERY existing metric (`tool.call.total`, `turn_duration_ms`, … `instrument-tool.ts:8-11`).
- **Fix:** typed instrument descriptor `{name,unit,description,kind}` (SSOT) + serialize `unit`(/`description`) into OTLP; `unit` optional/defaulted so existing metrics stay byte-identical.
- **Done:** enumerate EVERY existing metric name and assert each is byte-identical on the wire (not just "unchanged"); raw `/v1/metrics` shows `unit` on a histogram.
- **Deps:** T-A0.

### T-C2 — [MED] emit `gen_ai.client.operation.duration` + `token.usage`
- **Corrected premise:** usage+duration ARE in scope at the sampling-span close (`closeSamplingSpan` `loop-helpers.ts:464-498`; `capturedUsage`/`timing`/`requestModel`/`requestProvider` available), but NO metric is emitted there today — `closeSamplingSpan` emits span attrs only; `emitUsage` is a wire-adapter generator (yields a StreamEvent), NOT a metric; the default metric sink is populated only with the OTLP exporter installed (live-only). **T-C2 ADDS the metric emit.**
- **Fix:**
  - `gen_ai.client.operation.duration` — histogram, **unit `s`** (ms→s from the span duration); dims `gen_ai.operation.name`(Req), `gen_ai.provider.name`, `error.type`(on error), `gen_ai.request.model`.
  - `gen_ai.client.token.usage` — histogram, **unit `{token}`**, **two series** by required `gen_ai.token.type`=`input`|`output`; dims `gen_ai.operation.name`+`gen_ai.provider.name`(both Req)+`gen_ai.request.model`.
  - Cardinality guard: `gen_ai.request.model` = the normalized `requestModel` slug (not raw response ids); `error.type` bounded enum. Confirm no label-schema collision with existing `{tool,ok}` metrics (`instrument-tool.ts:8-11`).
- **Done:** raw `/v1/metrics` fixture asserts both names, units, the input/output `gen_ai.token.type` split, and the required dims; gated on sink live → byte-identical off; red-on-injection (drop token.type → RED).
- **Deps:** T-C1, T-A0.

### T-C3 — [MED / conformance] emit stable `gen_ai.conversation.id` ★NEW
- **Why:** the Coordinate lists `conversationId` and `vocabulary.ts:328` defines `gen_ai.conversation.id`, but it's emitted NOWHERE — a per-turn tree with no stable conversation id can't be grouped into a session by any GenAI backend.
- **Fix:** emit `gen_ai.conversation.id` on the chat/agent span, **stable across all turns of one instance/attempt** (reuse the instanceId/attempt tuple).
- **Done:** two turns of one instance share it; two instances differ; raw-OTLP fixture asserts it. **Deps:** T-A0.

---

## Phase D — Opt-in content capture (PINNED form; default-OFF; redacted)

### T-D0 — [SPIKE / blocks D1] representation decision
- Attribute form `gen_ai.input.messages`/`output.messages` (structured, **no new transport** — exporter serializes attrs; on spans MAY be JSON string) **vs** event form `gen_ai.client.inference.operation.details` (**needs new transport**: SpanSink event method + `ExportSpan.events[]` + OTLP `events[]` serializer — NONE exist, `spans.ts:139-184`/`otel-exporter.ts:96-114`). **Recommend attribute form.** Record the pinned message schema (role + parts text/tool_call/tool_call_response) + `gen_ai.system_instructions` separate.
- **Done:** decision + blob link recorded; D1/D2 scoped.

### T-D1 — [HIGH / content governance + latent leak] content capture, attr form
- **Fix:** opt-in `gen_ai.input.messages`/`output.messages` on the chat span as structured attrs (pinned message schema), gated by a knob mirroring `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` (default OFF). **Redact at `closeSamplingSpan`** — it already receives raw `messages`+`responseMessage` and imports `redactSecrets` from `@/security` (`loop-helpers.ts:21,127-133`) → NO slice-boundary break. Cassette stays unredacted (Plane A, unchanged).
- **⚠️ LATENT LEAK (must fix in this ticket):** existing `gen_ai.prompt`/`gen_ai.completion` PREVIEWS (`loop-helpers.ts:479-482`) are gated on `sinkActive` ONLY, not on any content knob. T-B flips `sinkActive` true on ordinary runs → those raw-ish truncated previews start emitting **un-knobbed** on every context-only run. **Re-gate `promptPreview`/`completionPreview` behind the content knob + redaction** (or drop them in favor of the pinned messages attr).
- **Done (adversarial ≥3):** default-OFF proof (no content attr AND no preview when knob unset, even with sink live); redaction proof (secret in → redacted out); cassette-unredacted-unchanged proof; raw-OTLP fixture showing the pinned attr shape/value-type.
- **Deps:** T-D0, T-A0, and MUST land after T-B (the preview re-gate is only reachable once T-B flips sinkActive).

### T-D2 — [DEFER unless T-D0=event] span-event transport
- Only if event form: SpanSink event method + `ExportSpan.events[]` + OTLP `events[]` serializer + raw-OTLP fixture (`gen_ai.client.inference.operation.details`). **Deps:** T-D0=event.

---

## Phase E — Plane hardening (parallel, low risk)

### T-E1 — [MED] Plane A secret-boundary drift-guard
- Guard test: UNREDACTED content is written ONLY by the cassette path (`recording-llm.ts`/`trajectory.ts`); OBSERVE/metrics/OTLP-content go through `redactValue`/`redactSecrets`. RED on injecting a raw-content write into an OBSERVE/OTLP path. **Note:** this guard would have CAUGHT the T-D1 preview leak — sequence it to also cover the preview site.

### T-E2 — [LOW] Plane A fork-from-failure entrypoint
- Consolidate + document fork-from-failure (exists but scattered) into one named entrypoint + a smoke exercising the existing path. No new engine.

### T-E3 — [MED] Plane B TrajectoryKind schema-version + drift-guard
- Declared schema version for `TrajectoryKind`/`*Data` + guard failing on a kind declared-without-`*Data` or emitted-without-declaration. (Stretch, separate: OTel-Logs-model alignment.)

---

## Phase F — Context default-ON (measure-first; SEPARATE gate — last)

### T-F1 — [MED / measure-first] flip `QUANTA_TRACE_CONTEXT` default-ON for bench
- **Gate:** (i) no trajectory consumer/probe/fixture breaks on the added trace fields; (ii) regenerate golden fixtures; (iii) A/B the byte change is inert downstream. Include a **group-chat regression guard**: assert the timestamp-merged group-chat renders identically with/without trace fields (`index.html:810-812`). Fix the `treeEmpty` copy (`:697,760` says "legacy mode" — misleading for a knob-OFF-untraced run).
- **Done:** every bench run's viewer shows the span-tree with no flag; fixtures regenerated; probe/consumers green; group-chat byte-identical.
- **Deps:** ALL T-B* (incl. T-B4 box forward) landed + soaked; T-D1 preview re-gate landed (else default-ON leaks previews). **Rails:** the ONE ticket that intentionally breaks off-byte-identical — own commit + measure-first evidence.

---

## Dependency order
T-A0 → (T-A1, T-A2). T-B1 → T-B2 (needs T-B3, then T-B4). T-B5, T-B6 parallel to B. T-C1 → T-C2; T-C3 parallel. T-D0 → T-D1 (after T-B). E-tickets parallel. **T-F1 LAST** (needs all B + T-D1 re-gate).
**Quick-win "viewer tree on every bench run":** T-B1 + T-B3 + T-B2 + **T-B4** (local + full-remote), opt-in via knob. T-F1 makes it default.
**Ship-wrong risk order (fix first):** T-B2 degraded-fatal → T-B4 box-forward → T-D1 preview-leak → T-B5 error.type / T-C3 conversation.id → T-C1 re-rate.

## Rails (every ticket)
Hellgate RED-e2e → TDD → ≥3 adversarial + objective → self-audit; red-on-injection on every emit/guard AND proving each knob is LIVE (not inert); OFF ⇒ byte-identical except T-F1; metadata never in the request hash; concurrent-session isolation (`git push origin HEAD:main` + rebase, own files only); new knob ⇒ inventory + fc + drift-guards + box-forward check.
