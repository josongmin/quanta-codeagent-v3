# ADR-0218: Mode-typed delegation (parent → child mode-typed handoff)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related ADRs**: ADR-0130 (background subagent scheduler — generic worker;
  this slice adds the MODE TYPING that ADR-0130 deliberately omitted),
  ADR-0042 (agent_role enum — Codex 3-role policy that inspired the
  per-mode tool-kind allowlist), ADR-0145 (subagent + plan queue), ADR-0166
  (conversation seed replay)
- **References**:
  `src/agent/subagent-typed/{port,delegation-router,mode-registry,isolated-context,boomerang,index}.ts`,
  `tests/unit/subagent-mode-typed-hellgate.test.ts`

## Research grounding

Per `docs/analysis/경쟁사리뷰/`, four independent vendors converge on the same
shape: parent → child subtask handoff with the child declared under a
TYPED ROLE that pre-selects tool surface + budget. The agreement is what
makes this a strong-signal absorption (single-vendor patterns get demoted
under our "no n=1 heuristic" rule):

- **Roo Boomerang / Orchestrator** — parent dispatches to "Architect" /
  "Debug" / "TDD" / "Code" children. Child runs in an isolated context;
  only the typed result boomerangs back to the parent.
- **Devin sub-task delegation** — handoff is named (architect / engineer
  / qa) and the child's tool surface is gated.
- **Codex `spawn_agent({ role })`** — closed 3-arm enum
  (`explorer | worker | none`) drives the child's registry filter at the
  fork boundary.
- **Cursor `subagent_await` family** — handle-based async surface (similar
  in shape to ADR-0130 but without the mode typing).

Our `ADR-0130` (background subagent scheduler) shipped the BG-execution
half but deliberately left the mode-typed half open: every fork is a
generic worker with the parent's full tool inheritance. That decision was
correct for ADR-0130's scope (BG execution as a primitive) but leaves the
TYPED HANDOFF gap unfilled — which this ADR closes.

## Context

A subagent fork without mode posture creates two operational hazards:

1. **Tool-surface inheritance** — the child inherits the parent's full
   tool registry. An "architect" child that only needs read+lsp gets
   `bash` + `write` access it never asked for. A `dispatch-seam`
   block in plan mode does NOT propagate into the fork (the child's
   collab mode is reset to default). Same hazard as ADR-0036
   §`subagent_spawn`.
2. **Budget runaway** — without per-mode budget caps, an architect
   delegation that's "supposed to be light planning" can consume the
   parent's entire turn budget on a single child.

Both are addressable via a TYPED MODE on every delegation:

- The mode declares its `allowedToolKinds` up front (mirror of Codex's
  role-to-policy table).
- The mode declares its `maxTurns` + `maxTokens` cap; per-call budget
  may TIGHTEN but never LOOSEN.

## Decision

Add a closed-port slice `src/agent/subagent-typed/` that closes both
gaps:

- **`DelegationPort`** (`port.ts`) — single method `delegate(req)`
  returns a typed `BoomerangResult`. No throws on operational failure;
  every failure surfaces as `errorKind: "cancelled" | "budget-overflow" |
  "mode-missing" | "runner-error" | "timeout"`.
- **`AgentMode`** (closed 5-arm enum) — `architect | editor | debug |
  tdd | explore`. Adding a mode is a 2-step change (extend enum + add
  registry row); the exhaustiveness test catches the omission.
- **`DEFAULT_MODE_REGISTRY`** (`mode-registry.ts`) — every mode has ONE
  `ModeProfile` row carrying `systemPromptVariant` (free-form name the
  host maps to its own per-mode prompt table), `allowedToolKinds`,
  `maxTurns`, `maxTokens`, `rationale`.
- **`TypedDelegationRunner`** (port type in `delegation-router.ts`) —
  the host's bridge to the actual agent loop. Same closed-port pattern
  as `SubagentRunner` for ADR-0130. The router does NOT know how the
  runner spawns the child; the runner does NOT know about the boomerang
  shape.
- **`wrapSubagentRunner`** — bridge that lets an existing ADR-0130
  `SubagentRunner` be plugged into this slice without modification.

### Default profiles

| Mode      | Tool kinds                    | maxTurns | maxTokens |
|-----------|-------------------------------|----------|-----------|
| architect | read, lsp, memory             | 40       | 128K      |
| editor    | read, edit, memory            | 12       | 32K       |
| debug     | read, shell, lsp, memory      | 24       | 64K       |
| tdd       | read, edit, shell, memory     | 48       | 128K      |
| explore   | read, lsp, memory             | 20       | 64K       |

Numbers are conservative defaults; callers may TIGHTEN via per-request
`budget`. They are NOT measurements — they exist to bound runaway
children, not to optimize cost.

### Parent context isolation

- `chainParentSignal()` builds a child-owned `AbortController` so the
  child code reads ONE signal; the parent's controller is never passed
  to the child.
- `makeChildCorrelation()` deep-clones + freezes the correlation map so
  the child cannot mutate the parent's pointer.
- Seed prompt is composed with `[mode: …] <rationale>\n\n<user prompt>`
  so the child sees its posture even if the host's prompt-variant
  lookup misses.

## Why this is distinct from ADR-0130

| Axis              | ADR-0130 (BG scheduler)       | ADR-0218 (mode-typed)         |
|-------------------|--------------------------------|-------------------------------|
| Purpose           | detached background execution  | typed handoff with posture    |
| Tool inheritance  | inherits parent's full set     | filtered by mode profile      |
| Budget            | optional `maxTurns` hint       | enforced cap from mode        |
| Result shape      | `SubagentResult` (free-form)   | `BoomerangResult` (typed enum) |
| Cancellation      | per-handle AbortController     | parent-signal chained via isolated child controller |
| Persistence       | serialize/hydrate (JSON)       | none (pure run/result)         |
| Concurrent cap    | `maxConcurrent` (default 3)    | caller's choice — no cap here  |

The two compose: `wrapSubagentRunner(bgScheduler.fork-wrapped-runner)`
produces a `TypedDelegationRunner` that runs in the background AND under
a mode profile.

## Default-OFF posture

The loop never constructs a `DelegationPort`. Callers (apps / tier1
builders / future CLI command) opt in by wiring through `AgentConfig`.
When the slot is absent the ToolRegistry stays byte-identical and no
mode-typed child is ever spawned. Voice match: ADR-0130's
`subagentBackground?` slot.

## Slice isolation

- Pure types + a factory; no `@/agent/loop` / `@/agent/dispatch` /
  `@/llm` / `@/tool` imports.
- `ToolKind` is declared locally (mirror of `@/subagent/role.ts:TOOL_KINDS`)
  so this slice has zero `@/subagent` runtime dependency. The
  cross-check in the hellgate catches drift if the canonical list
  changes.
- `mode.ts` is NOT modified — W1-7 agents own per-mode prompt
  variants there; this slice only consumes the variant NAME via the
  registry's `systemPromptVariant` field. Cross-track conflict-free.

## Validation

- **Hellgate**: `tests/unit/subagent-mode-typed-hellgate.test.ts` — 26
  cases covering registry exhaustiveness, 5-mode routing, mode-missing
  + budget-overflow + cancelled + runner-error error arms, parent
  context isolation (correlation freeze + hostile-input rejection),
  cancellation propagation, runner-throws-suppressed, seed prompt
  shape, `wrapSubagentRunner` bridge round-trip, byte-stable
  boomerang shape.
- **TSC**: 0 errors introduced by this slice.
- **Biome**: 0 errors on this slice.

## Limits + follow-ups

- Result shape includes `artifacts?: Record<string, string>` but the
  runner is responsible for extracting them from the child's final
  text. A future extension (ADR-TBD) could add a "structured artifact
  parser" port — out of scope here.
- No `timeout` enforcement today; the `errorKind: "timeout"` arm
  exists in the union but the router does not generate it. A wall-clock
  guard around the runner is a clean follow-up.
- The slice does NOT register a tool. Hosts wire it via `AgentConfig`
  and surface a tool (e.g. `delegate`) in their own tier1 builder —
  same shape as ADR-0130's `subagent_fork/poll/await`.
