# Feature-catalog promotion plan (below-L4)

2026-05-22. 4-agent parallel code-grounded audit of every feature below L4 (2×L1,
2×L2, 20×L3). Each entry: **target**, **gap**, **steps** (file:line), **effort**
(S ≤0.5d / M ~1–2d / L >2d), **risk**, **deps**. Maturity gate: **L3** = wired to a
real consumer on a live path; **L4** = core wired + passing behavioral tests + no
non-functional core sub-parts.

## Roadmap (recommended order)

### Tier A — quick wins (S), independent, low risk → do first
| feature | cur→tgt | gap | key step |
|---|---|---|---|
| git-write-protection | L2→L3 | detector has 0 callers | wire `gitWriteProtectReason` static-deny into admissibility-gate before HITL |
| response-in-progress | L3→L4 | `onInProgress` not wired | pass `onInProgress` to `streamingTurn` in loop.ts:340 |
| seam (skill model/effort) | L3→L4 | overrides read but not enforced | loop applies `skillModelOverride`/`skillEffortOverride` next-turn |
| work-metrics | L3→L4 | no default sink | default stderr/result emit of `summarizeWorkMetrics` post-turn |
| cli-export | L3→L4 | no e2e test | add `tests/integration/cli-export-assembly.test.ts` subprocess run |

### Tier B — medium (M), mostly independent
| feature | cur→tgt | gap | key step |
|---|---|---|---|
| eval-schema-additive | L2→L3 | runner doesn't fill, report doesn't render | synthetic/runner emits metrics/tokens/costUsd + report renders |
| tool-output-schema-factory | L3→L4 | streaming-input seam not wired | `buildToolInputSeam(registry)` → `onToolInput` in loop |
| typed-tool-failure-modes | L3→L4 | tools don't populate `failure` | migrate read/edit/bash/scripted_replace ok:false → typed `failure` |
| phase-ttft-readonly-trio | L3→L4 | TTFT marks + readonly flag unwired | wire `markRequestSent/markFirstToken/markStreamEnd` + `isReadonly` in denyFromConfirm |
| plan-mode-dispatch-block | L3→L4 | `checkDispatchAllowed` not called | call at dispatch.ts site + `collaborationMode` config field |
| queued-follow-ups | L3→L4 | no persist/resume + UI | session-envelope snapshot + `popReady` before next turn |
| trust-scope-wire-up | L3→L4 | in-memory only | persistent JSON store + hydrate on session start + grant CLI verb |
| permission-remember-patterns | L3→L4 | no model surface + cascade | expose `rememberPatterns` schema field + cascade in user-approval path |
| review-kind-matrix | L3→L4 | pure module, 0 consumer | `inferReviewKind` + wire into gate reviewer routing + `isDecisionLegalFor` |
| codex-2-phase-consolidator | L3→L4 | no session-end trigger | call `runPhase1` in loop finally + Phase2 cron/threshold |
| external-agent-import | L3→L4 | `runImport` uncalled + no translators | provider translators (claude-code first) + `quanta import` subcommand |
| run-mode-expansion-ide-daemon | L3→L4 | real consumer out-of-repo | in-repo headless e2e smoke for ide+daemon presets (full L4 needs ext adapter) |

### Tier C — large (L) / dependency-gated
| feature | cur→tgt | gap | key step |
|---|---|---|---|
| submission-op-envelope | L3→L4 | control-ops accepted-and-ignored | wire interrupt→AbortSignal, cancel_subagent→subagent abort (after conversation-action) |
| conversation-action-steering | L3→L4 | `decideAction` not consumed | loop consumes action; cancel_subagent via subagent registry (ADR-0011) |
| subagent-6-tools | L3→L4 | contracts frozen, handlers in-flight | implement 6 handlers + dispatch routing in subagent/agent-tool.ts |
| eval-five-tier | L3→L4 | Tier-4 stub + report no metrics | implement compare adapters + e2e + report cost/token render (after eval-schema-additive) |
| ide-context-provider-seam | L3→L4 | in-repo seam complete; consumer external | needs VS Code/Tauri extension out-of-repo — in-repo only adds provider e2e test |

### Hold — no promotion planned (intentional, low ROI)
- **plan-mode (L1)** — structured `update_plan`/`create_plan`/`request_user_input` deliberately unabsorbed; 3-way exit (ADR-0063/0086) + dispatch block (ADR-0036) already cover CLI needs. Revisit only if interactive plan-editing UX is added (then: new ADR + tool shell + `ctx.requestUserInput` seam).
- **activation-timing-phase (L1)** — activation-timing phase-machine deliberately held; current session-start-1×+per-turn-label is sufficient. Distinct from ADR-0077 output phases. Revisit only on a concrete phase-gated-activation use case.

## Dependency notes
- **control-op cluster**: `conversation-action-steering` → then `submission-op-envelope` (shared cancel_subagent logic). Both touch loop.ts hot path + depend on ADR-0011 (subagent abort) / ADR-0030 (AbortSignal). Batch them.
- **eval chain**: `eval-schema-additive` (L2→L3) is a prerequisite for `eval-five-tier` L4 report rendering. Do schema-additive first.
- **permission cluster**: `trust-scope-wire-up`, `permission-remember-patterns`, `review-kind-matrix` all improve gate routing independently but share `admissibility-gate.ts` — coordinate edits.
- **out-of-repo blocked**: `ide-context-provider-seam` and full `run-mode-ide-daemon` L4 need an external editor/daemon host; in-repo work caps at "seam complete + e2e smoke."

## Per-feature detail
Detailed gap + steps + file:line for each feature are captured in the 2026-05-22
audit (commit trail). Key insertion points:
- loop.ts: `streamingTurn` call (~340) is the wiring point for response-in-progress,
  phase-ttft, tool-input seam; `finally` (~1153) for consolidator session-end hook.
- admissibility-gate.ts: pre-HITL static layer for git-write-protection; reviewer
  routing (~139) for review-kind-matrix; user-approval path (~176) for remember-patterns.
- dispatch.ts: `checkDispatchAllowed` call site for plan-mode-dispatch-block.
- src/apps/eval/synthetic/index.ts + report/: eval-schema-additive + eval-five-tier.
