# ADR-0242: Stop-reason 8-arm typed branching policy (Cursor 3.2.16)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related ADRs**: ADR-0076 Gap-1 SOTA++ + ADR-0120 (`refusal` typed
  StopReason — legacy 3-arm `decideOnAssembled` mapping that this slice
  generalises), ADR-0229 (`DispatchGuard` — sibling closed-port composer
  pattern this slice mirrors), ADR-0073 (`StopCategory` — structured stop
  classification, this slice's tags `[stop-abort]` / `[stop-hitl]` are the
  recognition surface a future re-router can build on without changing the
  outcome shape).
- **References**: `src/agent/stop-reason/**`,
  `tests/unit/agent/stop-reason-hellgate.test.ts`,
  `src/agent/recovery.ts` (`decideFromStopPolicy` helper),
  `src/agent/loop.ts` (single 4-line wire site in `runTurn`)

## Context

Cursor 3.2.16 (audit in `cursor-3.2-absorption` memory + 4-way comparison
in `agent-loop-4way-comparison`) reports an 8-arm `stop_reason` vocabulary
from the model provider and branches each into a typed loop action:

| reason                  | Cursor action |
| ----------------------- | ------------- |
| `end_turn`              | continue      |
| `tool_use`              | continue      |
| `max_tokens`            | surface       |
| `refusal`               | surface       |
| `pause_turn`            | surface       |
| `error`                 | surface       |
| `content_filtered`      | abort         |
| `guardrail_intervened`  | hitl          |

quanta's pure FSM in `recovery.decideOnAssembled` (the only consumer of
`stop_reason`) handles **3** of those: `refusal` (typed terminal,
ADR-0076 Gap-1), `max_tokens` (nudge / continue), `tool_use` (malformed-tool
detection). The other 5 (`end_turn`, `pause_turn`, `content_filtered`,
`guardrail_intervened`, `error`) fall through to the "empty/proceed" arms
silently — a `content_filtered` looks the same as a plain `end_turn` to the
loop, an `error` stop string from the provider gets no telemetry tag, and a
`guardrail_intervened` cannot be re-routed to a human reviewer.

The gap is closed-vocabulary aware: every new arm must be added to the
loop, the recovery FSM, and the observability schema simultaneously. We
absorb this Cursor signal as a sibling typed router, not by extending the
existing 3-arm FSM in place (which would conflate "what the provider
reports" with "what the loop does about it").

## Decision

Add a **plane-clean leaf slice** at `src/agent/stop-reason/` exposing one
closed port that classifies provider-reported `stop_reason` strings into a
closed 4-arm `StopAction`:

```ts
type StopReasonKind =
  | "end_turn" | "tool_use"
  | "max_tokens" | "refusal" | "pause_turn" | "error"
  | "content_filtered"
  | "guardrail_intervened"

type StopAction =
  | { kind: "continue" }                       // fall through to legacy mapping
  | { kind: "surface"; reason: string }        // terminal error
  | { kind: "abort";   reason: string }        // terminal error, tagged
  | { kind: "hitl";    reason: string }        // terminal error, tagged

interface StopReasonPolicy {
  handle(stopReason: string): StopAction
}
```

- **`defaultStopReasonPolicy()`** — the Cursor 3.2.16 routing table verbatim
  (table above), encoded as a frozen object literal. Unknown / unrecognised
  inputs collapse to `{ kind: "continue" }` so the legacy
  `decideOnAssembled` FSM retains the final word (HELL-SR-09). Zero
  allocation per call (frozen literals from the lookup map).
- **`noOpStopReasonPolicy`** — frozen `{ handle: () => ({ kind: "continue" }) }`,
  the explicit byte-identical opt-in (the loop's wire site short-circuits
  on `config.stopReasonPolicy === undefined` for zero allocation; the
  no-op is for tests + composition roots that always pass a port).

### Wire site (single)

`src/agent/recovery.ts` adds a pure `decideFromStopPolicy(policy, stopReason)`
helper that translates a `StopAction` into a terminal `RecoveryAction` or
`null` to fall through:

| StopAction.kind | translated RecoveryAction                                  |
| --------------- | ---------------------------------------------------------- |
| `continue`      | `null` (fall through to `decideOnAssembled`)               |
| `surface`       | `{ do: "error", reason }`                                  |
| `abort`         | `{ do: "error", reason: "[stop-abort] " + reason }`        |
| `hitl`          | `{ do: "error", reason: "[stop-hitl] " + reason }`         |

`src/agent/loop.ts:runTurn` consults the helper BEFORE the existing
`decideOnAssembled` call:

```ts
const stopOverride =
  "error" in result
    ? null
    : decideFromStopPolicy(config.stopReasonPolicy, result.stopReason)
const action =
  stopOverride ??
  ("error" in result
    ? decideOnStreamError(result.error, result.message, rec)
    : decideOnAssembled(result.stopReason, result.message, rec))
```

A non-`continue` policy decision short-circuits the turn into the existing
`{do:"error"}` error path. The `[stop-abort]` / `[stop-hitl]` prefixes
ride on `reason` so observability + a future HITL re-router can recognise
them by substring without changing the outcome surface. Same-turn recovery
budgets are NOT consumed (the policy decided the turn is terminal — no
retry, no budget bookkeeping).

Default-OFF preserved: `config.stopReasonPolicy` absent ⇒ a single
optional-chain check on a possibly-undefined value, zero allocation,
byte-identical to the pre-ADR path. Every existing test (including
`agent-refusal-e2e` + `recovery-hellgate` + `recovery-hell`) stays green.

### Why the policy takes precedence over the legacy refusal arm

`decideOnAssembled` already has a typed `refusal` arm (ADR-0076 Gap-1
SOTA++). When `stopReasonPolicy` is wired, `refusal` routes through the
policy's `surface` path → terminal `error` outcome instead of the legacy
typed `refusal` outcome. This is **intentional**:

- The Cursor router is opt-in; absent ⇒ legacy refusal behavior preserved
  (HELL-SR-15 second test asserts this regression fence).
- A composition root that wires the policy is opting INTO Cursor parity
  (uniform surface across all 8 stop reasons), and gets the documented
  trade-off.
- A future PR can lift the typed `refusal` outcome into the policy
  vocabulary (new `StopAction` arm) without touching this ADR's surface.

## Consequences

- **Default-OFF / byte-identical** — `stopReasonPolicy` absent ⇒ zero
  behavior change; the optional-chain short-circuits BEFORE allocating
  anything. All existing tests stay green.
- **Closed-port preserved** — the 8-arm vocabulary + 4-arm action union
  are both closed (compile-error on consumer drift). Adding a 9th
  provider stop_reason forces a recompile at every consumer switch.
- **Cursor parity (opt-in)** — when wired, the loop branches `stop_reason`
  exactly as Cursor 3.2.16 does (audited matrix), without losing our
  "Default-NO-provider-tax" invariant.
- **Observability surface** — `[stop-abort]` / `[stop-hitl]` prefixes
  give probes + log scanners a stable recognition tag without changing
  the AgentOutcome shape. A future StopCategory router (ADR-0073) can
  switch on these prefixes.
- **Deferred** — actual HITL queue routing is NOT in this ADR. The
  `hitl` action collapses to a tagged terminal error today; lifting it
  into the existing `HandoffRequiredEvent` plumbing is a follow-up that
  can identify candidates by the `[stop-hitl]` prefix.

## Negative invariants (hellgate-locked)

- HELL-SR-01..08: every closed-vocabulary reason routes per the Cursor table.
- HELL-SR-09: unknown reasons (case mismatch, empty string, legacy OpenAI
  vocabulary `stop_sequence`/`tool_calls`/`function_call`) collapse to
  `continue` — the legacy FSM keeps the final word.
- HELL-SR-10: `config.stopReasonPolicy` absent ⇒ `decideFromStopPolicy`
  returns `null` for EVERY closed reason (zero allocation, no port call,
  byte-identical legacy path verified end-to-end via `runAgent`).
- HELL-SR-11..14: each `StopAction.kind` maps to the documented
  `RecoveryAction` (tag prefixes asserted verbatim).
- HELL-SR-15: refusal under policy ⇒ outcome `reason === "error"` +
  `stream` `error` event carries the policy's reason text; exactly ONE
  LLM call (no retry thrash); the legacy refusal behavior (absent policy
  ⇒ outcome `reason === "refusal"`) is asserted as a regression fence.
- Purity: `handle` is deterministic across 100 invocations on the same
  input; the routing map is frozen (assignment throws in strict mode);
  no-op policy returns `continue` for EVERY input including unknowns.
