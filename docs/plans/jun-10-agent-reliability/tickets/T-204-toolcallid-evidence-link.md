# T-204: toolCallId unconditional threading + ToolResultEvidence cross-link

**RFC:** [02·W4](../02-rfc-evidence-claim-trace.md) · **Priority:** P1 · **Size:** M · **Deps:** none · **Posture:** ON (plumbing; byte-identical outputs)

## Deliverable
1. Thread `toolCallId` into tool ctx **unconditionally** — today conditional on the ADR-0440 `onToolDiff` sink (`src/agent/dispatch.ts:803`; `src/tool/types.ts:312` comment). Contract change on the dispatch hot path → mandatory byte-identical regression check on existing outputs.
2. Add `toolCallId` to `ToolResultEvidence` (`src/tool/types.ts:1005-1011`); populate in read/edit/grep.

## Acceptance criteria
- [ ] toolCallId present in ctx without onToolDiff wired.
- [ ] Evidence carries the id in the three tools; absence stays legal for others (type-level test).
- [ ] Dispatch byte-identical regression suite green.
