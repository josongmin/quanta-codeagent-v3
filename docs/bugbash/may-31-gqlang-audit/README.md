# L3 Audit — Plugin / Skill / Memory / Context-Checkpoint

**Date:** 2026-05-31
**Scope:** Lane L3 (~25k LOC) — `src/agent/{plugin-*, app-catalog, memory, context-*, turn-diff, checkpoint, per-tool-checkpoint, shadow-verify*, issue-hint, repro-test}` + `src/skill` + `src/memory`
**Lenses:** code quality, missing features, silent errors, error swallowing, 짜치는 코드, SOLID violations, race/cancellation, security
**Method:** 2-round parallel audit (Round 1 objective + Round 2 adversarial, 7 clusters each), then adversarial verification of every high/critical finding against the real source. 45 agents total.

## Result summary

| | count |
|---|---|
| Raw findings (R1 + R2) | 52 |
| High/critical sent to verification | 31 |
| **Confirmed high/critical** | **25** |
| Rejected as false-positive by verifier | 6 |
| Medium/low (not verified) | 21 |

Findings per cluster (R1 objective / R2 adversarial):

| cluster | R1 | R2 |
|---|---|---|
| plugin | 3 | 4 |
| skill-core | 3 | 4 |
| playbook | 0 | 6 |
| memory-core | 2 | 12 |
| memory-consolidate | 1 | 5 |
| context-checkpoint | 4 | 3 |
| issue-repro | 1 | 4 |

## Documents

- [01-critical-high.md](01-critical-high.md) — 25 confirmed CRITICAL/HIGH findings with evidence, file:line, why, fix. **Start here.**
- [02-medium-low.md](02-medium-low.md) — 21 medium/low cleanups (not adversarially verified).
- [03-false-positives.md](03-false-positives.md) — 6 findings the verifier rejected, recorded so they are not re-raised.

## Top-priority fix set (highest ROI — small fixes, real contract violations)

| # | severity | issue | file:line |
|---|---|---|---|
| 1 | CRITICAL | Double `usage_count` increment in Stage1 reuse | [memory-consolidator-hook.ts:579-584](../../../src/agent/memory-consolidator-hook.ts#L579-L584) + adapters |
| 2 | HIGH | logger no-throw contract violated ×3 | [memory-consolidator-hook.ts:174](../../../src/agent/memory-consolidator-hook.ts#L174), [:343](../../../src/agent/memory-consolidator-hook.ts#L343), [:389-394](../../../src/agent/memory-consolidator-hook.ts#L389-L394) |
| 3 | HIGH | `SqliteStore.delete()` sync-throw bypasses Promise contract | [sqlite.ts:178-181](../../../src/memory/adapters/sqlite.ts#L178-L181) |
| 4 | HIGH | AbortSignal not forwarded to LLM stream | [memory-consolidate.ts:180-185](../../../src/agent/memory-consolidate.ts#L180-L185) |
| 5 | HIGH | switch non-exhaustive → undefined tag/body | [context-change/inject.ts:59-149](../../../src/agent/context-change/inject.ts#L59-L149) |
| 6 | HIGH | AbortSignal ignored in shadow-verify adapters ×2 | [apply-v4a.ts:84-98](../../../src/agent/shadow-verify-adapters/apply-v4a.ts#L84-L98), [scratch-worktree.ts:37-49](../../../src/agent/shadow-verify-adapters/scratch-worktree.ts#L37-L49) |
| 7 | HIGH | head+tail compression drops tail (loses exception line) ×2 | [extract-code.ts:66-67](../../../src/agent/issue-hint/extract-code.ts#L66-L67), [extract-tracebacks.ts:55-58](../../../src/agent/issue-hint/extract-tracebacks.ts#L55-L58) |
| 8 | HIGH | glob brace-expansion exponential DoS | [inline-trigger-watcher.ts:234-246](../../../src/skill/playbook/inline-trigger-watcher.ts#L234-L246) |
