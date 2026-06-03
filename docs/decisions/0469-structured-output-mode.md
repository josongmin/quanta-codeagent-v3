# ADR-0469 — Structured output mode: `response_format` json_schema passthrough

**Status:** Accepted (2026-06-03)
**Type:** Additive `@/llm` slice (new module + one optional request field + one
adapter passthrough). Default-OFF, opt-in per request.
**Scope:** new `src/llm/structured-output.ts`; one optional `responseFormat?`
field appended to `StreamInput` in `src/llm/types.ts`; one additive conditional
spread in `src/llm/adapters/openai.ts` (`openRawStream`); hellgate
`tests/unit/llm-structured-output-hellgate.test.ts`. No other files touched.
**Default-OFF / byte-identical:** a request with NO `responseFormat` produces a
byte-identical wire payload — the adapter spreads nothing, the validator is
never called. The feature activates only when a caller attaches a
`responseFormat` to a single request.

ADR-number note: 0466 was the highest existing decision; this slice took the
assigned-free number 0469.

## Context

`@/llm` had no schema-forced response mode for the main loop. A caller that
wants the model to emit a JSON document conforming to a known shape (extraction
tasks, tool-arg synthesis, deterministic downstream parsing) had to prompt for
JSON and hope — there was no provider-level constraint and no confirmation that
the model obeyed.

Both major providers support schema-forcing, but ASYMMETRICALLY:

- **OpenAI Chat Completions** — native
  `response_format:{type:"json_schema", json_schema:{name, schema, strict}}`
  (Structured Outputs). With `strict:true` the provider guarantees exact schema
  adherence over a narrower JSON-Schema subset.
- **Anthropic Messages** — NO `response_format` knob. The SOTA strategy is a
  single **forced tool-call**: register one tool whose `input_schema` IS the
  json schema and force `tool_choice` to it; the model "calls" the tool with a
  conforming JSON object, which the caller reads from the `tool_use` block.

ARCHITECTURE.md §2 already documents that `LLMPort.StreamEvent` is
leaky-by-design and **adapter asymmetry is ACCEPTED**. This ADR follows that
posture: we wire the OpenAI native path and DOCUMENT the Anthropic forced-tool
strategy (with a pure builder) rather than fake symmetry.

## Decision

1. **New leaf module `src/llm/structured-output.ts`** (imports only `@/shared`):
   - `ResponseFormat` — the wire-shaped request fragment, mirroring the OpenAI
     Structured-Outputs shape 1:1 so the adapter passthrough is a lift, not a
     translation.
   - `validateAgainstResponseSchema(text, schema): Result<unknown, ResponseFormatError>`
     — a no-throw validator a caller runs on the model's returned text (or the
     forced-tool input stringified) to CONFIRM the model obeyed. Parses then
     structurally validates against a **closed, documented subset** of JSON
     Schema (`type` / `properties` / `required` / `items` / `enum` /
     `additionalProperties` / `anyOf`). Unknown keywords are IGNORED, never
     guessed — it deliberately under-validates rather than invent semantics.
   - `validateResponseFormat(format)` — guards the request fragment itself
     (illegal name, non-object schema) before it reaches the provider as an
     opaque 400. The name constraint `^[a-zA-Z0-9_-]{1,64}$` is pinned from the
     OpenAI SDK doc comment (`resources/shared.d.ts`), not a guessed limit.
   - `toOpenAIResponseFormat(format)` — pure map to the SDK param.
   - `toAnthropicForcedTool(format)` + `RESPONSE_FORMAT_ANTHROPIC_NOTE` — the
     documented Anthropic strategy as a pure builder the Anthropic adapter MAY
     adopt at integration. The returned `{tool, toolChoice}` is structurally
     compatible with `@/llm/types`'s `ToolSchema` / `ToolChoice`.

2. **`StreamInput.responseFormat?`** (optional) added to `src/llm/types.ts`.
   Absent ⇒ byte-identical. Restated structurally there to keep `@/llm/types`
   import-light; `ResponseFormat` in `structured-output.ts` is the SoT.

3. **OpenAI adapter passthrough** — one additive conditional spread in
   `openRawStream`: `input.responseFormat !== undefined` ⇒ spread
   `response_format:{type:"json_schema", json_schema:{name, schema, strict?}}`;
   absent ⇒ OMIT the key (byte-identical). `strict` is conditionally nested so
   omitting it on the request omits it on the wire.

### Why a confirmation validator (the model claiming structured output ≠ obeyed)

Structured Outputs is best-effort on older models, can be truncated by
streaming cutoff, and the Anthropic forced-tool path is a different mechanism
entirely. So the caller VERIFIES: `validateAgainstResponseSchema` is the single
no-throw checkpoint that turns "the model said it's JSON" into a typed
`Ok(parsed)` / `Err(violation)`.

## Default-OFF / byte-identical proof

- No `responseFormat` ⇒ the adapter's `...(input.responseFormat !== undefined ? … : {})`
  spreads `{}` ⇒ the request object has no `response_format` key ⇒ identical to
  the pre-feature wire. Pinned by hellgate case
  "ABSENT responseFormat ⇒ no response_format key on the wire".
- Importing `structured-output.ts` runs no side effects; the validator is
  inert until called.

## Consequences

- OpenAI callers get native Structured Outputs with one optional field.
- Anthropic schema-forcing is DOCUMENTED + has a pure builder but is NOT wired
  into the shared Anthropic adapter by this slice (scope fence — see
  integrationTodos). The asymmetry is explicit, not faked.
- The validator is a confirmation check, not a JSON-Schema engine. It
  under-validates unknown keywords by design (no invented semantics).

## Negative invariants

- The validator NEVER throws: adversarial / huge / malformed input
  (`{ not json ]`, 5000-deep `[`, non-string, non-object schema) returns a
  typed `Err`. Pinned by the malformed/adversarial hellgate cases.
- This slice does NOT edit the Anthropic adapter, `src/tool/**`,
  `src/apps/**`, `biome.json`, or `src/agent/loop.ts`.
- `structured-output.ts` imports ONLY `@/shared` — no `import OpenAI`, no
  cross-slice reach. The OpenAI SDK param shape is mirrored structurally.
- No arbitrary thresholds: the only magic number (name length 64 / charset) is
  pinned from the OpenAI SDK contract.

## Honest deferred (integrationTodos)

- **OpenAI Responses surface** (`openai-responses-wire.ts`) passthrough — the
  Responses API also accepts a structured-output knob; not wired here.
- **Anthropic adapter forced-tool wiring** — `toAnthropicForcedTool` exists but
  the adapter does not consume `responseFormat` yet.
- **Loop-level auto-validate** — the loop does not call
  `validateAgainstResponseSchema` automatically; callers invoke it.
