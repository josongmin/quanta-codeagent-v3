# ADR-0429 — Advisor consult tool (agent-callable second opinion)

Status: accepted (2026-06-02)

## Context

The agent could not deliberately consult a stronger/different model mid-loop. Existing model plumbing is failure- or composition-driven, not model-invokable:
- model-swap-on-retry (ADR-0066) — failure-driven swap, not deliberate.
- role-based model override (ADR-0256) — a composition-root resolver, not a tool the model can call.
- delegate (ADR-0393) — picks a child MODE/posture, not a stronger MODEL for a second opinion.

Claude Code (cc-cli 2.1.150) ships `advisor_20260301`{model}: an agent-callable tool that runs a separate completion with a chosen model and returns its analysis in-band. 2026-06-02 4사 합집합 어딧(§8)에서 quanta의 확정 ❌ 갭으로 식별.

> ADR number note: drafted as 0257 in the isolated worktree; 0257 was already `ai-attribution-tool`, so peer-renumbered to 0429 (next-free) per the user-deference renumber policy.

## Decision

Add an agent-callable `advisor` tool (`src/tool/advisor/`):
- Input `{ question, context?, model? }`. Runs a ONE-SHOT `LLMPort` completion with **zero tools offered** (pure consult), using a configured advisor model — resolved via the ADR-0256 'advisor' role resolver or an explicit `model` validated against an allowlist BEFORE the port is consulted.
- `isReadOnly: true`, `hitlTier: "none"`, `isConcurrencySafe: true`, no `extractShellCommand` surface — the permission gate can never route it through a mutation/HARD_DENY path. It cannot mutate files or call other tools.
- Hexagonal `AdvisorPort` (duck-typed `consult` + `listModels`, closed `AdvisorErrorKind`), so the slice does not import `@/agent`/`@/llm`.
- **Default-OFF seam**: registered only when `config.advisor` is present; absent ⇒ byte-identical (tool not registered).

Errors are typed `ToolFailure` (model-not-in-allowlist → `rejected` without consulting the port; port throw/timeout → graceful `ok:false` so the loop survives).

## Consequences

- The model can escalate to a stronger model for a genuine second opinion at decision points, composing with verify/closeout gates.
- Orthogonal to ADR-0066/0256/0393.
- 17-case hellgate (`tests/unit/advisor-tool-hellgate.test.ts`) covers wire (absent-config ⇒ unregistered), behaviour (analysis surfaced), and pure-consult invariants.
- Composition root must source `config.advisor` to turn it on (follow-up wire).
