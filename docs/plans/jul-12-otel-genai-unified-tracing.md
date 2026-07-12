# Plan — OTel GenAI unified tracing

Status: **audited draft; not implementation-ready until Phase 0 is accepted**

Owner decision: ADR-0539 amendment

Audited against repository state and OpenTelemetry GenAI main on 2026-07-12.

## Decision summary

Build one causally correct OTel trace per bench **instance attempt** and use its
`traceId`/`spanId` as the correlation authority across OTLP spans, OBSERVE
evidence, and the replay cassette.

This does **not** make OTLP the evidence source of truth:

- OBSERVE remains the typed, redacted evidence SSOT from ADR-0539.
- The replay cassette remains the unredacted replay SSOT and a secret artifact.
- OTel span context becomes the identity and causality SSOT.

The target is not a file merge. It is a shared identity contract across files.

## Standards basis and stability boundary

The implementation must pin the exact GenAI convention snapshot it targets.
The current OpenTelemetry core semantic-conventions site has moved GenAI to the
separate `open-telemetry/semantic-conventions-genai` repository. At the audit
date:

- The GenAI client, agent, and tool span documents are all **Development**, not
  Stable. Do not describe agent conventions as "stable in practice" in an ADR.
- Inference spans use `{gen_ai.operation.name} {gen_ai.request.model}` and
  normally use `CLIENT` kind.
- In-process agent invocation uses `invoke_agent {gen_ai.agent.name}` and
  `INTERNAL` kind.
- Tool execution uses `execute_tool {gen_ai.tool.name}` and `INTERNAL` kind.
- `gen_ai.input.messages`, `gen_ai.output.messages`, system instructions, tool
  arguments, and tool results are opt-in content with explicit sensitive-data
  warnings and schema requirements.

Normative snapshot used by this plan: commit
`63f8200eee093730ce845d26ce2aafb621b0807e`.

- [GenAI client spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/63f8200eee093730ce845d26ce2aafb621b0807e/docs/gen-ai/gen-ai-spans.md)
- [GenAI agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/63f8200eee093730ce845d26ce2aafb621b0807e/docs/gen-ai/gen-ai-agent-spans.md)
- [OpenAI client overrides](https://github.com/open-telemetry/semantic-conventions-genai/blob/63f8200eee093730ce845d26ce2aafb621b0807e/docs/gen-ai/openai.md)

Before implementation, copy this commit SHA into ADR-0539 and a code
constant/test fixture. `main` is not a durable contract.

## Current state — code audit

| Surface | Current behavior | Consequence |
|---|---|---|
| Live loop spans | `src/observability/spans.ts` exposes the four literal names `session_loop`, `session_task.turn`, `run_sampling_request`, `handle_tool_call` through a process-global `SpanSink`. | The live loop does not use the richer `Tracer` port in `src/observability/tracing/`. |
| Export parentage | `createExporterSpanSink` derives parents from a process-global open-span LIFO stack. | Parent selection is not async-context-safe. Concurrent roots/children can cross-link even though close removes the exact frame. |
| Span identity | `Span.token` is opaque and the no-sink sentinel has no valid trace/span identity. | OBSERVE and cassette code cannot read the active OTel identity. |
| Span kind | `SpanSink.onStart` receives only name and attrs; `createExporterSpanSink` emits no `kind`. OTLP defaults omitted kinds to `INTERNAL`. | Current sampling spans cannot satisfy the GenAI `CLIENT` requirement. |
| GenAI vocabulary | `GEN_AI_ATTRS` includes `gen_ai.system`, `gen_ai.prompt`, `gen_ai.completion`, underscore cache keys, and `gen_ai.response.time_to_first_token_ms`. | These are deprecated or do not match the audited convention snapshot. |
| Finish reasons | The vocabulary names `gen_ai.response.finish_reasons`, but the loop emits one string. | The semantic type should be a string array; the live exporter path currently accepts only scalar attrs. |
| OBSERVE identity | `JsonlRecorder` generates deterministic `t<turn>`, `llm:t<turn>`, and `tool:<id>` IDs. `TrajectoryEvent` has `spanId`/`parentSpanId` but no `traceId`. | IDs are a separate namespace and cannot be joined safely across traces. |
| OBSERVE clock | `JsonlRecorder` supports a monotonic clock, but production `BenchObserver` does not provide one. Bench-produced events also use a separate high sequence range. | Cross-producer ordering cannot be reconstructed from `monotonicNs`; `seq` is producer-local. |
| Replay cassette | `RecordedInteraction.metadata` can carry run/instance/attempt, but ordinary `maybeRecordTrajectory` does not supply `callCtx` or trace identity. | A cassette interaction cannot be joined to its LLM span. |
| Run identity | OBSERVE/artifact paths use `QUANTA_RUN_ID`; OTLP resource attrs use separately auto-issued `QUANTA_OTEL_RUN_ID`. OTel boot runs before `runMain` seeds `QUANTA_RUN_ID`. | Auto-configured runs can have different IDs despite ADR-0539 claiming `{runId, instanceId}` is a join key. |
| Attempt identity | `AttemptObservation` has `attempt`, but `config-build.ts` sends only `spanIdentity.instanceId`. | Best-of-N/retry attempts are ambiguous on spans. |
| Existing tracing port | `src/observability/tracing/port.ts` models context, kind, and explicit parents, but its `withSpan` implementations do not install an active async context for arbitrary callers. | Reusing the name `withSpan` does not by itself solve active-context propagation. |
| Payloads | The loop currently attaches bounded `gen_ai.prompt`/`gen_ai.completion` previews when a sink is active. | The keys are deprecated, the shapes are not GenAI message schema, and this is not the same contract as explicit opt-in content capture. |

## P0 contradictions to resolve

Implementation must not start until ADR-0539 records these decisions:

1. **SSOT split** — OBSERVE owns evidence; OTel context owns correlation. This
   amends, rather than silently reverses, ADR-0539's current "OBSERVE is SSOT"
   wording.
2. **Trace scope** — one trace per instance attempt. Best-of-N attempts get
   different trace IDs and share `{runId, instanceId}` with distinct `attempt`.
3. **Root scope** — bench uses a custom `quanta.bench.instance` `INTERNAL` root
   spanning sandbox setup through verification. `invoke_agent` is its child.
   Non-bench agent entry points may use `invoke_agent` as the root.
4. **Context mode** — valid IDs without an exporter require ID generation and
   async context storage. That is not a no-op and cannot be called "zero cost"
   or "byte-identical". Use an explicit rollout mode.
5. **No mixed fallback** — unified mode must never fall back per-event to
   `t<turn>` IDs. A missing active context is a correlation defect, surfaced as
   degraded evidence and failed by the owning test rail.
6. **Compatibility window** — decide whether legacy span names/attributes are
   dual-emitted for one release or cut over atomically. Recommended: additive
   aliases for one release, then deletion with a drift ratchet.

## Target invariants

### Trace tree

```text
quanta.bench.instance                         INTERNAL, one per instance attempt
├─ quanta.sandbox / quanta.localize           INTERNAL when represented as spans
├─ invoke_agent quanta-codeagent              INTERNAL
│  └─ session_task.turn                       INTERNAL, Quanta structural span
│     ├─ chat {requested_model}               CLIENT, one logical provider call
│     └─ execute_tool {tool_name}              INTERNAL, one dispatch
└─ quanta.verify                              INTERNAL when represented as a span
```

- A provider adapter's transparent transport retries remain inside one `chat`
  span. An application-level new sampling request gets a new `chat` span.
- In-process subagents are child `invoke_agent` spans in the same trace. A
  detached/remote operation uses W3C propagation or an OTel link; it must not be
  parented by guessing from a process-global stack.
- `session_task.turn` is intentionally retained as a Quanta structural span. It
  is not mislabeled as a GenAI operation.

### Correlation contract

Every trace-enabled artifact uses this identity:

```ts
interface TraceRef {
  traceId: string       // 32 lowercase hex, non-zero
  spanId: string        // 16 lowercase hex, non-zero
  parentSpanId?: string // when the artifact describes a child
  traceFlags?: number
}
```

The full cross-layer tuple is:

```text
{traceId, spanId, runId, instanceId, attempt, conversationId}
```

Rules:

- `runId` has one authority. Resolve it once before OTel attach, then feed both
  `QUANTA_RUN_ID` compatibility and the OTel resource builder from that value.
- `instanceId` and `attempt` are span attrs on the instance root and agent span.
- `gen_ai.conversation.id` is the real session/conversation identifier. Never
  synthesize it from trace ID or request content.
- `gen_ai.agent.name = "quanta-codeagent"` is stable and low-cardinality.
  Omit `gen_ai.agent.id` until a stable configured agent identity exists; do not
  put transient process/session IDs there.
- OBSERVE adds optional `traceId` to `TrajectoryEvent`. `spanId` alone is not a
  globally sufficient join key.
- Bench evidence emitted outside a child span uses the instance-root `TraceRef`,
  not a deterministic synthetic span ID.

### Runtime modes

Use one resolved mode, not independent partially overlapping booleans:

| Mode | Context IDs / async propagation | OTLP export | Intended use |
|---|---:|---:|---|
| `off` | no | no | rollback and non-observed entry points |
| `context` | yes | no | local artifact correlation |
| `export` | yes | yes | OTLP plus local correlation |

Compatibility resolution:

- An existing `QUANTA_OTEL_ENDPOINT` implies `export` unless explicitly off.
- Initial rollout is gated for bench. After correctness and overhead budgets
  pass, bench may default to `context`; other apps remain `off` unless enabled.
- Only `off` may claim current default-off behavior. `context` performs ID
  allocation, async-context work, and changes artifact bytes.

## Canonical GenAI mapping

| Operation | Required/recommended target | Current drift to remove |
|---|---|---|
| Agent | name `invoke_agent quanta-codeagent`; kind `INTERNAL`; `gen_ai.operation.name=invoke_agent`; `gen_ai.agent.name`; `gen_ai.conversation.id` when available | `session_loop` alone has no GenAI operation attrs |
| Inference | name `chat {model}`; kind `CLIENT`; `gen_ai.operation.name=chat`; `gen_ai.provider.name`; requested/response model; token usage; finish reasons | `run_sampling_request`; `gen_ai.system`; scalar finish reason |
| Tool | name `execute_tool {name}`; kind `INTERNAL`; `gen_ai.operation.name=execute_tool`; `gen_ai.tool.name`; call ID; type when known | `handle_tool_call`; Quanta-only attrs; nonstandard tool input/output keys |
| Cache usage | `gen_ai.usage.cache_creation.input_tokens`, `gen_ai.usage.cache_read.input_tokens` | underscore keys `cache_creation_input_tokens`, `cache_read_input_tokens` |
| First chunk | `gen_ai.response.time_to_first_chunk` in seconds when current timing boundary matches the first response chunk | `gen_ai.response.time_to_first_token_ms` in milliseconds |
| Content | structured-schema `gen_ai.input.messages` / `gen_ai.output.messages`; tool arguments/result only under explicit capture policy | removed `gen_ai.prompt` / `gen_ai.completion`; nonstandard `gen_ai.tool.input/output` |
| Error | OTel status plus low-cardinality `error.type` on failures | status only; no canonical error type |

`quanta.*` attributes remain for bench-specific identity, policy, and diagnostics.
Do not place Quanta extensions under the reserved `gen_ai.*` namespace.

## Implementation phases

Each phase must land with its own tests and can be rolled back independently.

### Phase 0 — authority and schema decisions

Files:

- `docs/decisions/0539-tracing-observability-architecture.md`
- `docs/decisions/0074-otel-span-tree.md`
- this plan

Actions:

- Record the SSOT split, trace scope, root span, runtime modes, compatibility
  window, and pinned GenAI convention revision.
- Specify `TraceRef`, the optional `TrajectoryEvent.traceId`, cassette metadata,
  and missing-context failure behavior.
- State that the cassette remains unredacted because request hashing/replay
  depends on exact content; it remains outside content-capture policy and must
  stay inside the operator boundary.

Acceptance:

- The ADR no longer says both OBSERVE and OTel are the undifferentiated SSOT.
- No claim says Development conventions are Stable.
- No context-enabled mode claims zero allocation or byte-identical artifacts.

### Phase 1 — one async-safe tracing runtime

Primary files:

- `src/observability/spans.ts`
- `src/observability/tracing/{port.ts,noop-tracer.ts,otel-tracer.ts}`
- `src/observability/otel-span-export.ts`
- `src/observability/otel-exporter.ts`
- `src/observability/index.ts`
- agent span call sites under `src/agent/`

Actions:

- Choose one canonical tracing port. Recommended migration: make the live
  `spans.ts` helpers delegate to the typed `Tracer` runtime, retain `SpanSink`
  only as a compatibility adapter, then delete it after the migration window.
- Add async-context activation around the full async lifetime of instance,
  agent, turn, LLM stream consumption, and tool dispatch. A helper named
  `withSpan` must actually make the span active for nested async work.
- Carry `SpanKind`, `TraceRef`, explicit parent, start attrs, end attrs, status,
  and error type through the production exporter.
- Remove LIFO-stack parent inference as an authority. Explicit parent/active
  async context owns parentage.
- Provide an ID-only/context-only runtime for `context` mode. A no-op span with
  all-zero IDs is never treated as valid context.
- Root the whole bench attempt before sandbox/agent/verify work and thread the
  root parent into `runAgent`.

Acceptance:

- Two concurrently interleaved instance attempts never share trace IDs or
  parent spans.
- Concurrent tool calls under one turn are siblings.
- Nested subagents inherit the intended trace through explicit active context.
- Sampling spans export OTLP kind `CLIENT`; agent/tool/turn spans export
  `INTERNAL`.
- Export-off `context` mode still yields valid IDs; `off` yields none.

### Phase 2 — identity and vocabulary alignment

Primary files:

- `src/observability/vocabulary.ts`
- `src/observability/attrs.ts`
- `src/agent/session-resources.ts`
- `src/agent/loop-helpers.ts`
- `src/agent/dispatch.ts`
- `src/runner/batch/eval/driver/config-build.ts`
- `src/apps/bench/{otel.ts,run-main.ts,run-main-helpers.ts}`

Actions:

- Resolve one run ID before both OTel boot and artifact path resolution.
- Thread `attempt` to the instance root and agent configuration.
- Add operation/provider/agent/conversation/tool attrs and canonical span names.
- Replace deprecated/misnamed keys. Extend attribute and OTLP serialization for
  required homogeneous arrays, including finish reasons.
- Convert the existing first-chunk timing from milliseconds to seconds only
  after a boundary test proves it matches the convention.
- Preserve legacy aliases only for the ADR-defined compatibility window.

Acceptance:

- `quanta.run.id === TrajectoryEvent.ctx.runId === cassette.metadata.runId`.
- One box test shows distinct attempt attrs and trace IDs for two attempts of
  the same instance.
- OTLP fixture asserts exact names, kinds, attr keys, attr value types, and
  parentage.
- A vocabulary ratchet rejects removed deprecated keys in live emitters.

### Phase 3 — join OBSERVE and cassette to active context

Primary files:

- `src/shared/trajectory.ts`
- `src/stream/adapters/jsonl-recorder.ts`
- `src/runner/batch/observe.ts`
- `src/apps/bench/observe.ts`
- `src/llm/replay/{recording-llm.ts,types.ts}`
- `src/apps/bench/trajectory.ts`

Actions:

- Add optional `traceId` to the v1 trajectory envelope if consumers tolerate
  additive fields; otherwise introduce a versioned migration. Prove this with
  the strict validator and replay/probe consumers before choosing.
- Inject a structural `getActiveTraceRef()` callback into `JsonlRecorder`; do
  not import `@/observability` from the `@/stream` slice.
- Stamp each synchronously emitted agent event with the active span context.
  Bench-produced events use the current span or explicit instance-root context.
- Capture the active `chat` context at `recordingLlmPort.stream()` start and
  persist it in `RecordedInteraction.metadata` together with run/instance/
  attempt. Metadata must remain excluded from the request hash.
- Populate production `monotonicNs` from `process.hrtime.bigint()` relative to a
  run-local origin. Do not convert arbitrary absolute bigint nanoseconds to an
  unsafe JS number; store a bounded delta or a decimal string via an explicit
  schema decision.
- In unified mode, a required event without context emits one
  `observability_degraded` record and fails strict bench correlation validation.
  It does not invent a legacy ID.

Acceptance:

- For LLM request/usage/cassette records:
  `observe.traceId === cassette.traceId === OTLP.traceId` and
  `observe.spanId === cassette.spanId === chat.spanId`.
- Tool call/progress/result records share the exported tool span identity.
- A replay hash is unchanged before and after trace metadata is added.
- Cross-producer ordering is deterministic for equal wall-clock timestamps.
- Legacy mode fixtures remain readable during the compatibility window.

### Phase 4 — safe content capture

Primary files:

- `src/observability/payload-preview.ts`
- `src/observability/vocabulary.ts`
- `src/agent/loop-helpers.ts`
- `src/agent/dispatch.ts`
- exporter/event serialization

Actions:

- Replace implicit "sink active means capture content" with an explicit capture
  policy, default off.
- Transform messages to the pinned GenAI input/output JSON schemas. Do not write
  arbitrary internal `Message` objects under canonical keys.
- Apply one redaction policy before export, then enforce size/count limits.
- Define separate gates for message content and tool arguments/results.
- Prefer span attributes only when the exporter supports the required shape.
  Otherwise use schema-compliant events or external content storage references;
  do not stringify under a misleading canonical contract.
- Keep replay cassette bytes and hashing outside this redaction path.

Acceptance:

- With capture off, no prompt, message, tool argument, or tool result content is
  present in OTLP.
- Secret/PII fixtures are redacted before the exporter buffer sees them.
- Oversized payloads are deterministically truncated with explicit metadata.
- Capture settings do not alter replay matching.

### Phase 5 — viewer projection

Primary files:

- `src/apps/bench/trace-viewer.html`
- `src/apps/bench/otel-trace-sink.ts`
- `tools/trajectory-viewer/index.html`

Actions:

- Render the instance-attempt tree and join OBSERVE/cassette evidence on
  `{traceId, spanId}`.
- Preserve the pinned run summary from ADR-0539.
- Show explicit badges for legacy, unavailable, redacted, truncated, and
  degraded correlation states.
- Never require raw cassette content to render a normal trace. Loading a secret
  cassette is a separate operator action.

Acceptance:

- Selecting one `chat` or `execute_tool` span shows only evidence attached to
  that span.
- Parallel spans render as siblings, not by arrival order.
- A missing artifact produces a visible partial-data state, not an empty green
  view.

### Phase 6 — cutover and deletion

- Stop writing deterministic `t<turn>`/`llm:t<turn>`/`tool:<id>` identities in
  unified mode.
- Remove legacy aliases and the compatibility `SpanSink` adapter after the
  declared window.
- Update ADR-0074, ADR-0539, fixtures, viewer docs, and feature catalog YAML if
  feature maturity/status changes. Rebuild the generated catalog; never edit
  `docs/10.feature-catalog.md` directly.

## Verification rails

Run narrow rails per phase, then the repository gates near closeout.

Targeted rails:

```sh
bun test tests/unit/observability/spans.test.ts
bun test tests/unit/observability-tracing-hellgate.test.ts
bun test tests/unit/observability/otel-span-export-wiring-hellgate.test.ts
bun test tests/unit/otel-trace-sink.test.ts
bun test tests/integration/spans-e2e.test.ts
bun test tests/unit/jsonl-recorder.test.ts
bun test tests/unit/bench-trajectory-record-hellgate.test.ts
bun test tests/integration/bench-observability.test.ts
```

New mandatory rails:

- async interleaving: two roots, overlapping turns/tools, exact parent tree;
- context-only mode: valid IDs with zero exporter calls;
- unified tuple: OTLP + OBSERVE + cassette equality in one box fixture;
- run-ID authority: explicit and auto-issued paths use the same run ID;
- Best-of-N: same instance, distinct attempts and trace IDs;
- semconv fixture: names, kinds, canonical keys, arrays, units, error type;
- content negative rail: capture off and redaction before buffering;
- legacy-read/new-write compatibility and final legacy-write ratchet.

Closeout gates:

```sh
bun run typecheck
bun run lint
bun test tests/unit/god-code-ratchet.test.ts
bun test tests/unit tests/integration
```

If feature YAML changes:

```sh
bun fc validate
bun fc build
bun fc diff
```

## Performance and rollout budgets

Measure `off`, `context`, and `export` separately. Do not compare only exporter
on/off.

- `off`: no regression relative to the existing no-sink path.
- `context`: report allocations per span, p50/p95 turn overhead, and retained
  async-context objects after 1,000 turns. Set a numeric budget from the baseline
  measurement before defaulting bench to this mode.
- `export`: bound exporter queue size, dropped spans, flush latency, shutdown
  drain time, and collector outage behavior.
- Correlation defects are counted and surfaced. A collector outage may degrade
  export without changing agent outcome; context corruption must fail the trace
  proof rail.

Rollout order:

1. tests and context-only local fixtures;
2. opt-in single-instance box run;
3. opt-in parallel/Best-of-N run;
4. exporter outage and process-shutdown tests;
5. bench default `context` only after budgets pass;
6. delete legacy writes after the compatibility window.

Rollback is one mode change to `off`; readers remain dual-format during the
window. Rollback must not require rewriting existing artifacts.

## Non-goals

- Merging OBSERVE, cassette, and OTLP into one file.
- Redacting or reformatting the replay cassette.
- Claiming vendor-specific zero-adapter compatibility without an ingest fixture
  for that vendor.
- Treating `traceId` as conversation ID or agent ID.
- Representing every OBSERVE event as an OTel span. High-frequency evidence can
  remain an artifact/event attached to the owning span.
- Making a collector or network path required for agent correctness.

## Completion checklist

- [ ] ADR-0539 amendment accepted with pinned semconv revision.
- [ ] One canonical async-safe tracing runtime; no LIFO parent authority.
- [ ] One run-ID authority and full instance/attempt threading.
- [ ] GenAI names, kinds, keys, value types, and units verified from OTLP bytes.
- [ ] OBSERVE and cassette carry valid `traceId`/`spanId` in unified mode.
- [ ] No per-event deterministic fallback in unified mode.
- [ ] Content capture is explicit, schema-valid, redacted, and bounded.
- [ ] Parallel, Best-of-N, replay-hash, outage, and shutdown rails pass.
- [ ] Viewer exposes partial/degraded state and correct sibling relationships.
- [ ] Legacy write path and deprecated keys removed after compatibility window.
