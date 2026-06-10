# jun-10 Agent Reliability — Audit + RFC Bundle (INDEX / status board SSOT) — FINAL

**Date:** 2026-06-10 (finalized same day after R4)
**Scope:** 6-axis reliability audit of the quanta agent + RFCs closing every confirmed gap + per-workstream tickets.
**Status legend:** `FINAL` (this revision) → tickets in [tickets/](tickets/00-backlog.md)

## Audit methodology — 4 rounds

- **R1 — Exploration (6 agents, one per axis):** existence + wiring + defaults, consumer-verified.
- **R2 — Adversarial refutation (4 agents):** every load-bearing R1 claim attacked by direct code reading. Overturned 6 R1 claims (recorded below).
- **R3 — Completeness critic:** corners neither round checked (telemetry, prose-path validation, cross-process, merge-back).
- **R4 — Finalization round (this revision):**
  - **Competitor SOTA alignment** over `.extracted_source/` (Claude Code CLI 2.1.167, Cursor 3.5.33, Codex 0.133): verified mechanisms per axis, strongest-baseline calls, exceed criteria. Each RFC now carries a *SOTA alignment* section.
  - **Bundle adversarial review:** all 8 docs re-verified against the working tree — 22 evidence anchors spot-checked (15 accurate, 6 off-by-lines → corrected in this revision), 4 HIGH + 10 MED + 5 LOW findings → all incorporated.
- Main-loop spot-checks throughout (read-routing, typecheck-stamp, command-hooks, `DEFAULT_MAX_TRIPS`, scripted_replace guard absence).

**R4 headline finding (new, elevates RFC-04):** `scripted_replace` is a BASE tool (`src/tool/surface/manifest.ts:109`), mutating, writes via raw `ctx.cwd` (`src/tool/scripted-replace.ts:305`) — and has **zero stale-read-guard integration**. That bypasses the default-ON TOCTOU control in ALL cases, not just under worktrees. `notebook_edit` (gated) has the guard but keys by raw `ctx.cwd`. RFC-04 scope was widened accordingly, and the house mirror rule below now names the full write class.

## The 6 axes

1. 도구 선택 품질 — grep vs LSP 낭비/삽질, cheap→AST→LSP escalation
2. 증거 계약 — 근거 강제, hallucinated path/API 차단, "봤다/검증했다" vs tool trace
3. 편집 후 회귀 — 관련 테스트, snapshot 정책, generated/lockfile/migration
4. 충돌/동시성 — user↔agent 동시 수정, subagent 충돌, rebase/merge 중 동작
5. 룰 우선순위 — 소스 충돌, 동급 tiebreak, 악성 repo rule
6. 실패 UX — partial patch/원인/다음 액션, clean-stop, ask 전 상태 요약

## Gaps → RFC map (FINAL)

| # | RFC | Axis | Closes | Priority | SOTA posture |
|---|-----|------|--------|----------|--------------|
| 01 | [tool-routing runtime + measurement](01-rfc-tool-routing-runtime.md) | 1 | no runtime escalation; routing quality unmeasured | P2 (measure-first) | Cursor leads baseline (semantic-first prompt, degraded-mode flags, routing telemetry); we reach parity via W3/W4, exceed via measured routing |
| 02 | [evidence claim↔trace contract](02-rfc-evidence-claim-trace.md) | 2 | no prose-claim↔trace reconciliation; no prose path validation; evidence unlinked; verify-guard doc drift | P1 | **No competitor validates model citations at runtime** — W1/W2 are exceed-class |
| 03 | [post-edit regression guards](03-rfc-post-edit-regression-guards.md) | 3 | no affected-test selection; no lockfile drift detection; no generated-file guard | P1 | Cursor LOOP_ON_LINTS ≈ our edit-repair-loop (parity); affected-tests + runtime lockfile/generated guards exceed all three |
| 04 | [write-path stale-guard integrity (BUGFIX, widened)](04-rfc-stale-guard-worktree-parity.md) | 4 | scripted_replace guard bypass (ALL cases); apply_patch/write worktree divergence (guard key AND write target); notebook_edit keying | **P0** | Restores the CC-grade read-state invariant our richer write surface broke |
| 05 | [git op-state + resume staleness](05-rfc-git-state-and-resume-staleness.md) | 4 | rebase/merge-in-progress undetected; resume into changed tree; ReadFileState lost across crash; merge-back unstructured | P1 | Cursor polls MERGE_HEAD/rebase (absorb); **no competitor fingerprints workspace drift on resume** — exceed |
| 06 | [rule provenance + determinism](06-rfc-rule-provenance-and-determinism.md) | 5 | silent vendor collisions; hook identity loss; SKILL.md validation | P2 | CC labels hook source in permission UI (absorb); collision observability + frontmatter lint exceed |
| 07 | [pre-handoff state summary](07-rfc-pre-handoff-state-summary.md) | 6 | no structured stop artifact; `BudgetExhaustionPolicy` stored-never-read | **P0** (north-star) | Cursor's structured handoff-summary prompt is content baseline; **no competitor ships a machine-readable stop artifact + policy dispatch** — exceed |

Landing order unchanged: **04 → 07 → 02 → 03 → 05 → 06 → 01**.
Tickets: [tickets/00-backlog.md](tickets/00-backlog.md) (37 tickets, dependency-ordered).

## Default-posture register (R4-M7: every default-ON workstream, enumerated)

The repo discipline is default-OFF; the following workstreams ship ON and each must defend the same envelope the staleness gate met (additive, deterministic, zero-false-positive, killswitch where behavioral):

| Workstream | What ships ON | Justification |
|---|---|---|
| RFC-04 all | guard-integrity fixes | repairs an existing default-ON safety control |
| RFC-01 W3/W4 | failure/truncation message content | message text only, zero behavior change |
| RFC-02 W1/W2 | claim-audit **annotations** on the outcome | additive outcome field; forcing variant stays OFF |
| RFC-02 W3 | toolCallId threading | plumbing; byte-identical outputs |
| RFC-03 W3/W4 | paired-file reminder + generated-file warn | exact-match tables, advisory verdicts, `=off` killswitch |
| RFC-07 W1 | PreHandoffSummary on outcome | additive field, pure builder, no-throw |

Reviewers should push back on these rows first; flipping any to OFF changes no design.

## Verified-OK (existing coverage — do NOT re-open; anchors corrected in R4)

| Area | Verdict | Evidence |
|------|---------|----------|
| Stale-read-guard default-ON; edit/write/apply_patch pre-commit + post-bash reminder; unread-allowed by design | LIVE (but see RFC-04 for the write-class holes) | `src/tool/stale-read-guard/gate.ts:37-42`, `state.ts:186-192` |
| Edit hallucinated-merge defenses | LIVE | `src/tool/edit/index.ts:142-200` |
| Unknown tool → typed deny, loop continues | LIVE | `src/agent/dispatch.ts:896-898` |
| hand-off-required universal (32-cell matrix) | LIVE | `tests/integration/hand-off-required-universal-e2e.test.ts` |
| Repo rules deeper-wins; same-dir first-present-wins; `### From <path>` attribution | LIVE | `src/agent/repo-rules.ts:80,148-167,137` |
| Glob/vendor rule ordering deterministic (priority asc → sourcePath) | LIVE | `src/agent/glob-rules.ts:179,405-412` *(path corrected: agent/, not rules/)* |
| Caller `input.system` honored; projectMd only when caller passes repoRules | LIVE | `src/agent/prompt.ts:618-642` |
| Repo trust gate: deny always; allow/ask/hooks/MCP dropped untrusted | LIVE | `src/config/merge.ts:85-149` |
| `embedUntrusted` single defang path; symlink-rejecting rules loader | LIVE | `src/shared/untrusted.ts`, `src/agent/repo-rules.ts:186` |
| `/state` fully wired | LIVE | `src/apps/cli/slash/registry-surface.ts:387-411` |
| Clean-stop persists + tears down on every finish path | LIVE | `src/agent/loop/session-lifecycle.ts:123-171` |
| Crash-resume marker + partial flush | LIVE (gated) | `src/runner/orchestrate/crash-resume-wire.ts` |
| 4-verb escalation cards | LIVE (skill-scope v2) | `src/agent/skill-scope-escalation.ts:75-184` |
| LSP unavailable → typed failure; mention-resolver fallback chain | LIVE | `src/agent/lsp-bridge.ts:143-164`, `src/agent/mention-runner/default-resolver.ts:113-125` |
| command-hooks wired via HookBus, default-OFF | LIVE (gated) | `src/agent/command-hooks/install.ts` |

## R2/R4 refutations + corrections register (prevents audit churn)

R2 refuted: glob-order nondeterminism / same-dir concat / caller-system splice / "/state missing" / "no LSP fallback at all" / read-routing-as-tool-routing (knob-framework term, `src/config/knob-inventory.ts:12`).

R4 anchor corrections applied to this revision: verify-guard knob docs at `cli-knobs.ts:584-599` (not 406-411); resume consumer `repl.ts:~313-340`; shadow-odb MERGE_HEAD `536-586`; glob-rules under `src/agent/`; read tool resolves at `read/index.ts:305`, records at `:515`; crash-resume offers at `crash-resume-wire.ts:~84-95`.

R4 reality checks folded into RFCs: ADR-0397 env block is **built-not-wired** (`probeTurnEnv` zero live callers) → RFC-05 W2 now includes wiring; `emit-partial` unimplementable at the turn-boundary seam as previously worded → RFC-07 W3 redefines it; hook bus does NOT know registrant identity today (`hooks.ts:540-549`) → RFC-06 W2 is an API extension; `ctx.toolCallId` threading is conditional on `onToolDiff` (`dispatch.ts:803`) → RFC-02 W3 includes unconditional threading; turn-diff ledger is opt-in → RFC-07 derives filesChanged from the trace.

## Competitor SOTA summary (R4 corpus, verified mechanisms only)

- **Cursor:** semantic-first routing prompt ("grep is for follow-up, not discovery"), cheap/expensive cost config + `isDegradedMode` fallback flags, `LOOP_ON_LINTS`/`LOOP_ON_TESTS` with `maxLoops` + `idleThreshold`, delta-only re-lint (`GetLintsForChange`), **runtime MERGE_HEAD + rebase polling** (`cursor-always-local/dist/main.js:208675,208686`), structured continuation-summary prompt.
- **Claude Code:** tool-layer read-before-edit + content-hash stale detection, 5-tier settings precedence (user<project<local<flag<policy), hook output in labeled system-reminder + hook **source shown in permission dialog**, context-% warning + compaction circuit breaker, grey "Interrupted" + task panel.
- **Codex:** `prepare-worktree-snapshot`/`upload-worktree-snapshot` multi-agent tools; otherwise thinnest on these axes.
- **Nobody has:** runtime citation validation (RFC-02), affected-test selection (RFC-03), runtime lockfile/generated guards (RFC-03), resume drift fingerprint (RFC-05), machine-readable stop artifact with policy dispatch (RFC-07). These are the bundle's exceed-class moves.

## Ticket extraction — done

37 tickets under [tickets/](tickets/00-backlog.md), one per right-sized workstream (R4-L4 splits applied: metric spec vs analyzer; survey vs fixes; CLI render vs web push). House constraints restated there; the write-class mirror rule is now: **edit / write / apply_patch / scripted_replace / notebook_edit / storage adapters / file-history**.
