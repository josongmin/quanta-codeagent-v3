# ADR-0524: Typed subagent `agentType` — closed-set SSOT + boundary classifier (§4.4)

- **상태**: Proposed
- **날짜**: 2026-06-09
- **관련**:
  - `src/subagent/agent-type.ts` (pure leaf: `SUBAGENT_KINDS` SSOT, `classifyAgentType`, `validateAgentType`)
  - `src/subagent/types.ts` (`SubagentRequest.agentType` retyped to `SubagentAgentType`)
  - `src/subagent/agent-tool.ts` (spawn boundary calls `validateAgentType` under `enforceTypedAgentKind`)
  - `src/agent/tier1/subagent.ts` (wires `enforceTypedAgentKind` + `knownCustom` from the named-agent registry)
  - `src/shared/runtime-config.ts` / `runtime-config-knobs.ts` (gate `QUANTA_SUBAGENT_TYPED_KIND` → `subagentTypedKind`)
  - Tests: `tests/unit/subagent-agent-type-typed.test.ts`,
    `tests/unit/subagent-typed-kind-boundary-hellgate.test.ts`,
    `tests/unit/subagent-typed-kind-live-wire-hellgate.test.ts`,
    `tests/unit/side-agent-typed-kind-gates-default-off.test.ts`
  - Absorbs: Claude-Code `tengu_subagent_type_normalized` / `…_miss` telemetry shape.

## Context

The subagent's `agentType` was a FREE STRING (`subagent/types.ts`). The §4.4 audit and
the Claude-Code corpus both want a CLOSED set of well-known kinds plus a NORMALISING
boundary validator: a requested type is lower-cased + trimmed, matched against the
available set, and only on a TRUE miss does the spawn fail. Without this, a typo
(`"Plan "` vs `"plan"`) silently forks a generic worker, and there is no observability
seam for "the model requested an agent kind we don't have".

This is DISTINCT from ADR-0218 (mode-typed delegation, `src/agent/subagent-typed/`): that
slice gates the child's TOOL SURFACE + BUDGET via a 5-arm `AgentMode` enum. ADR-0524 is
narrower — it normalises + classifies the `agent_type` FIELD at the existing `agent`-tool
spawn boundary, without touching tool inheritance or budget.

## Decision

A PURE LEAF (`src/subagent/agent-type.ts`) — no imports, no IO, no clock:

- `SUBAGENT_KINDS = ["general","explore","plan","review","edit"]` is the single source
  of truth; `SubagentType` and the `WELL_KNOWN_SET` are DERIVED from it (no second copy).
- `SubagentAgentType = SubagentType | (string & {})` — a typed-or-string union: editor
  autocompletion for the well-known kinds while STILL accepting any custom (named-agent)
  string for back-compat.
- `classifyAgentType(raw)` — NO-THROW, total: `undefined`/whitespace ⇒ `empty`;
  trimmed+lower-cased well-known ⇒ `well-known` (carries `canonical` + raw `requested`);
  otherwise ⇒ `custom` (carries `requested` + `normalized`).
- `validateAgentType(raw, { enforce?, knownCustom? })` — the boundary validator. With
  `enforce` FALSY (gate absent / DEFAULT-OFF) the result is ALWAYS `{ ok: true, value: raw }`:
  the field flows byte-identically to the legacy free string (no normalisation, no
  rejection). With `enforce: true`, a well-known kind is accepted AND canonicalised to its
  SSOT spelling; an `empty` kind is accepted (⇒ general fork, value `undefined`); a `custom`
  kind is accepted iff it matches a `knownCustom` name (case-insensitively), else REJECTED
  with a `subagent_type_not_found`-style one-line reason (CC's `…_miss`).

Wiring: `tier1/subagent.ts` reads `config.subagentTypedKind` (from gate
`QUANTA_SUBAGENT_TYPED_KIND`) and, when on, passes `enforceTypedAgentKind: true` plus the
named-agent registry keys as `knownCustom`; `agent-tool.ts` calls `validateAgentType` at the
spawn boundary and converts an `ok:false` into a recoverable tool deny (NO-THROW — the
runner is never invoked on a miss).

## Consequences

DEFAULT-OFF byte-identity preserved: with the gate absent the `ToolRegistry` and the carried
`agent_type` value are unchanged, so no behaviour shifts for existing callers. Under the gate
the model gets a fail-closed boundary: a typo'd well-known kind is auto-corrected to canonical;
an unknown kind is rejected with a recoverable, actionable reason instead of silently forking a
generic worker. The closed `SUBAGENT_KINDS` set is the seam future telemetry / per-kind tool
posture can hang off. Adding a kind is a one-line edit to the SSOT array (the union + the
runtime set both re-derive). Slice isolation holds: `@/subagent` reaches only `@/tool`/`@/shared`
and this leaf reaches neither.
