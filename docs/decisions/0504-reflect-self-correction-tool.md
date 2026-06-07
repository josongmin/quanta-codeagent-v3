# ADR-0504: `reflect` mid-turn self-correction tool

- **상태**: Accepted
- **날짜**: 2026-06-07
- **관련**:
  - `src/tool/reflect/` (port + tool + barrel)
  - `src/tool/index.ts` (`DefaultToolPorts.reflect` conditional registration)
  - `src/tool/surface/manifest.ts` (gated entry, `QUANTA_REFLECT`)
  - Tests: `tests/unit/reflect-tool-hellgate.test.ts`
  - Absorbs: Cursor `reflectToolCall` (gap-other-agent GAP 11)

## Context

Cursor exposes a `reflect`-style tool so the model can self-critique mid-turn when its
actions are not working — it states its situation + a DIFFERENT plan and gets a critique
back in-band. quanta had no such forcing function: a stuck agent kept retrying the same
approach with no structured "step back and re-plan" affordance.

## Decision

A `reflect` tool over a closed `ReflectPort { reflect(req) }`. The input REQUIRES both
`situation` and `next_steps` (the DIFFERENT plan) — `next_steps` is the forcing function;
omitting it ⇒ `ok:false` before the port is ever called. Both fields are length-capped
(`REFLECT_MAX_CHARS=8000`). A per-session call quota (`maxCalls`, default 5) bounds cost;
the quota is consumed ONLY on a successful port return (a throwing port does not drain it).
Pure interaction: `isReadOnly`, `hitlTier:none`, no shell extractor. Default-OFF: the tool
is registered ONLY when the composition root injects a `ReflectPort` (absent ⇒ tool absent,
byte-identical). The LLM-backed port wiring (like `advisor`) is the documented follow-up.

## Consequences

The essential decision + geometry (forcing function, quota, caps) are in-slice and
hellgate-proven; the live LLM port rides the host. Distinct from `advisor` (second opinion
on a question) — `reflect` critiques the agent's own committed trajectory.
