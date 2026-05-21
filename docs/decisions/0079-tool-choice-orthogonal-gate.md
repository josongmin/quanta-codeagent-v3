# ADR-0079 — tool_choice forcing as an orthogonal control gate

## Status
Accepted (2026-05-21)

## Context

The loop has two distinct planes for steering the model's tool calls:

1. **Post-call** — `src/agent/admissibility-gate.ts` decides whether to allow
   / deny / steer a `tool_use` AFTER the model has already emitted it. The
   `tool_result` carries the verdict; the model then sees the result and
   adapts on the next turn. This is reactive.

2. **Pre-call** — the LLM API's `tool_choice` field steers the model's
   decision space BEFORE it commits to a `tool_use`. Anthropic supports
   `auto | any | none | {type:"tool", name}`; OpenAI supports
   `"auto" | "required" | "none" | {type:"function", function:{name}}`.
   This is proactive — it changes what the model is *allowed to consider*.

Before this ADR we used plane (1) only. The two guards we own —
`verify-guard.ts` (force a verify after an unverified mutating tool) and
`closeout-guard.ts` (single-shot closeout reminder) — both express their
intent only through **content** (a meta-user message in working memory):

- verify-guard appends `VERIFY_FORCE_MESSAGE` ("you edited source but ran
  no test or reproduction afterward; do NOT finish yet…") and lets the
  model choose to comply.
- closeout-guard appends `CLOSEOUT_REMINDER` and lets the model choose.

**Gap**: the model can ignore the meta and emit another finish text turn,
or call yet another mutating tool. The guards rely on prose persuasion
while the API has a *structural* knob (`tool_choice`) we never use.

This ADR adds the pre-call plane as a structural enforcement layer. It is
**orthogonal** to admissibility — both planes operate on the same
`tool_use` boundary from opposite sides:

```
                  tool_choice (pre-call)
                            │
                            ▼
                  model emits tool_use
                            │
                            ▼
                 admissibility (post-call)
                            │
                            ▼
                       tool_result
```

## Decision

### Pure resolution

A new pure module `src/agent/tool-choice.ts`:

```ts
export type ToolChoice =
  | { readonly kind: "auto" }
  | { readonly kind: "any" }
  | { readonly kind: "none" }
  | { readonly kind: "tool"; readonly name: string }

export interface ToolChoiceSignals {
  readonly verifyGuardViolated?: boolean
  readonly closeoutAttempted?: boolean
  readonly explicit?: ToolChoice
}

export const resolveToolChoice = (signals: ToolChoiceSignals): ToolChoice => { … }
```

`resolveToolChoice` is **pure**: IO 0, no clock, no env, no registry. Same
input always produces same output. The signal struct is **closed** — no
escape hatch for arbitrary hints, no `Record<string,unknown>` bag. New
triggers require an ADR + a new explicit field so the precedence ladder
stays auditable.

### Closed 4-way precedence

```
1. explicit !== undefined        → explicit
2. verifyGuardViolated === true  → { kind: "any" }     (force re-verify)
3. closeoutAttempted === true    → { kind: "none" }    (force termination)
4. otherwise                     → { kind: "auto" }    (default)
```

Higher precedence wins. The explicit override beats every implicit trigger
so a host that wants to pin the choice (test, runbook, retry strategy)
is never overridden by a guard signal. The default `{kind:"auto"}` plus
the adapter's "auto ⇒ omit on the wire" rule means **byte-identical**
to the pre-feature path when no signals fire.

### 1-turn TTL signal lifecycle

Signals do NOT carry across turns. The mechanism is a loop-owned mutable
state object (`ToolChoiceTurnState`) holding two booleans:

- `verify-guard.ts` blocks a finish attempt → loop sets
  `toolChoiceTurnState.verifyGuardViolated = true` AND appends the
  forcing meta + returns `CONTINUE`.
- `closeout-guard.ts` blocks a finish attempt → loop sets
  `toolChoiceTurnState.closeoutAttempted = true` similarly.
- The forced `CONTINUE` loops back to the top of the `for(;;)` in
  `runTurn`, where `consumeTurnSignals(state)` reads the flags AND
  clears them in place. `resolveToolChoice` then emits the forced
  variant for **exactly one** LLM stream call.

The flag can never carry to a second consume: `consumeTurnSignals` is
the single canonical clear point. Same-turn recovery paths (stream-error
backoff, compact, output-limit nudge, malformed nudge, empty nudge) do
not re-arm — they pass through `consumeTurnSignals` with zero signals
and resolve to `auto`.

### Adapter wire mapping

```
                  Anthropic                          OpenAI
  auto    ⇒  (field omitted)                  (field omitted)
  any     ⇒  { type: "any" }                  "required"
  none    ⇒  { type: "none" }                 "none"
  tool    ⇒  { type: "tool", name }           { type: "function", function: { name } }
```

The `auto ⇒ omit` rule is the byte-identical guarantee. The default-OFF
path produces literally the same bytes as before.

A `{kind:"tool", name}` referencing a name not in the request's `tools`
list throws at the adapter via `LLMError`. No silent fallback to auto —
that would mask a caller bug.

Both adapters use a closed `switch` with a `never` default branch so any
future ToolChoice variant addition is a compile error in BOTH adapters.

## Consequences

### Positive

- Verify-guard now has structural enforcement: the model can no longer
  ignore the forcing meta and emit another finish text — the next call
  has `tool_choice:"any"` and the API itself rejects a text-only response.
- Closeout-guard now has structural enforcement: the model cannot keep
  calling tools to delay closeout.
- Host-supplied `explicit` overrides give tests/runbooks/retries a clean
  pin point with no environment-variable side channel.

### Negative

- Adds one mutable object per session (`ToolChoiceTurnState`). The
  default-OFF path consumes empty signals every iteration, but the
  resolve + consume are both `O(1)`. Allocation is one 2-boolean
  object per session lifetime.
- One new file (`tool-choice.ts`) + two adapter functions to keep
  in sync. The closed switch + `never` default guards the sync.

### Out of scope

- We do not surface `disable_parallel_tool_use` (Anthropic-only refinement).
- We do not add a `force_text` shape on Anthropic (server-side composite of
  `none` + chat-style output) — closeout already pins this through `none`.
- The `explicit` field is plumbed through `ToolChoiceSignals` but no host
  `AgentConfig.toolChoiceOverride` wire-up is added in this PR — adding it
  is a one-line follow-up when a use case lands.

## References

- `src/agent/tool-choice.ts` — pure policy + turn state.
- `src/agent/verify-guard.ts` — comment-only update naming the new signal.
- `src/agent/closeout-guard.ts` — comment-only update naming the new signal.
- `src/agent/loop.ts` — consume + thread + arm sites.
- `src/llm/types.ts` — `StreamInput.toolChoice` field.
- `src/llm/adapters/anthropic.ts` — `toAnthropicToolChoice`.
- `src/llm/adapters/openai.ts` — `toOpenAIToolChoice`.
- `tests/unit/agent/tool-choice-resolve.test.ts` — pure precedence.
- `tests/unit/llm/tool-choice-adapter.test.ts` — wire-shape mapping.
- `tests/integration/verify-guard-forces-any.test.ts` — loop wire-up.
- `tests/integration/closeout-forces-none.test.ts` — loop wire-up.
