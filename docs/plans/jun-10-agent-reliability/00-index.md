# jun-10 Agent Reliability — Audit + RFC Bundle (INDEX / status board SSOT)

**Date:** 2026-06-10
**Scope:** 6-axis reliability audit of the quanta agent and the RFCs that close every confirmed gap.
**Status legend:** `PROPOSED` → `ACCEPTED` → `IN-PROGRESS` → `LANDED` / `DEFERRED`

## Audit methodology (why findings here can be trusted)

Three rounds, per the house hard-rule (≥3 audits incl. adversarial before claiming completeness):

- **R1 — Exploration (6 parallel agents, one per axis):** existence + wiring (LIVE vs built-not-wired) + default ON/OFF, with consumer verification to avoid narrow-symbol false gaps.
- **R2 — Adversarial refutation (4 parallel agents):** every load-bearing R1 claim attacked with direct code reading. **R2 overturned 6 R1 claims** (see "Refuted" table below) — those are recorded so future audits do not re-flag them.
- **R3 — Completeness critic (1 agent):** corners neither round checked (telemetry, prose-path validation, cross-process, merge-back, signal handling).
- **Main-loop spot-checks:** conflicting agent claims re-verified by direct grep/read in the orchestrating session (read-routing, typecheck-stamp, command-hooks wiring, `DEFAULT_MAX_TRIPS`).

Coverage claim: near-complete **within the 6 axes below**. Axes outside this scope (e.g. provider retry policy, sandbox escape) were not audited here.

## The 6 axes (from the originating request)

1. 도구 선택 품질 — grep vs LSP 낭비/삽질 방지, cheap→AST→LSP escalation
2. 증거 계약 — 근거 강제, hallucinated path/API 차단, "봤다/검증했다" vs tool trace
3. 편집 후 회귀 — 관련 테스트, snapshot 정책, generated/lockfile/migration
4. 충돌/동시성 — user↔agent 동시 수정, subagent 충돌, rebase/merge 중 동작
5. 룰 우선순위 — 소스 충돌, 동급 tiebreak, 악성 repo rule
6. 실패 UX — partial patch/원인/다음 액션, clean-stop, ask 전 상태 요약

## Confirmed gaps → RFC map

| # | RFC | Axis | Gaps closed | Priority | Status |
|---|-----|------|-------------|----------|--------|
| 01 | [tool-routing runtime + measurement](01-rfc-tool-routing-runtime.md) | 1 | no runtime escalation; routing quality unmeasured despite collected OTel spans | P2 (measure-first) | PROPOSED |
| 02 | [evidence claim↔trace contract](02-rfc-evidence-claim-trace.md) | 2 | no prose-claim vs tool-trace reconciliation; no prose path validation; evidence not linked to tool call; verify-guard doc/code drift | P1 | PROPOSED |
| 03 | [post-edit regression guards](03-rfc-post-edit-regression-guards.md) | 3 | no affected-test selection; no lockfile drift detection; no generated-file guard | P1 | PROPOSED |
| 04 | [stale-guard worktree parity (BUGFIX)](04-rfc-stale-guard-worktree-parity.md) | 4 | apply_patch/write stale-guard false negative under active worktree | **P0** | PROPOSED |
| 05 | [git op-state + resume staleness](05-rfc-git-state-and-resume-staleness.md) | 4 | rebase/cherry-pick in-progress undetected; crash-resume reinjects into changed tree; ReadFileState lost across crash; worktree merge-back unstructured | P1 | PROPOSED |
| 06 | [rule provenance + determinism](06-rfc-rule-provenance-and-determinism.md) | 5 | silent vendor collisions; hook injects carry no identity; SKILL.md tier declaration unvalidated | P2 | PROPOSED |
| 07 | [pre-handoff state summary](07-rfc-pre-handoff-state-summary.md) | 6 | no structured {partialProgress, failureCause, nextActions} on blocked/exhausted stops; `BudgetExhaustionPolicy` stored but never dispatched | **P0** (north-star) | PROPOSED |

Recommended landing order: **04 → 07 → 02 → 03 → 05 → 06 → 01**.
04 is a small high-severity bugfix; 07 is the north-star (agent state observability) with most parts already built; 01 is deliberately last because the house rule forbids heuristic interventions before measurement.

## Verified-OK (existing coverage — do NOT re-open as gaps)

| Area | Verdict | Evidence |
|------|---------|----------|
| Stale-read-guard default-ON, covers edit/write/apply_patch pre-commit + post-bash reminder; unread-files allowed by design | LIVE | `src/tool/stale-read-guard/gate.ts:37-42`, `state.ts:186-192` |
| Edit hallucinated-merge defenses (elision-copy detection, occurrence-count, empty new_string) | LIVE | `src/tool/edit/index.ts:142-200` |
| Hallucinated tool name → typed `Unknown tool` deny, loop continues | LIVE | `src/agent/dispatch.ts:896-898` |
| HARD_DENY / hand-off-required universal (32-cell matrix pinned) | LIVE | `tests/integration/hand-off-required-universal-e2e.test.ts` |
| Repo rules deeper-wins; same-dir first-present-wins (AGENTS.md > CLAUDE.md > .codex/CODEX-RULES.md); multi-layer rendered with `### From <path>` attribution | LIVE | `src/agent/repo-rules.ts:80,148-167,137` |
| Glob/vendor rule ordering IS deterministic (priority asc, then sourcePath lexicographic) | LIVE | `src/rules/glob-rules.ts:179,405-412` |
| Caller-supplied `input.system` is honored as base; projectMd only spliced when caller passes repoRules | LIVE | `src/agent/prompt.ts:618-642` |
| Repo trust gate: deny always applies; allow/ask/hooks/MCP dropped for untrusted repos | LIVE | `src/config/merge.ts:85-149` |
| Untrusted defang single path (`embedUntrusted`), symlink-rejecting repo-rules loader | LIVE | `src/shared/untrusted.ts`, `src/agent/repo-rules.ts:186` |
| `/state` slash command fully wired (working state + skill scope panels) | LIVE | `src/apps/cli/slash/registry-surface.ts:388-411` |
| Clean-stop: every finish path persists transcript + tears down resources | LIVE | `src/agent/loop/session-lifecycle.ts:123-171` |
| Crash-resume marker + partial flush at tool.invoked boundaries | LIVE (gated) | `src/runner/orchestrate/crash-resume-wire.ts` |
| 4-verb escalation cards end-to-end | LIVE (skill-scope v2 ON) | `src/agent/skill-scope-escalation.ts:75-184` |
| LSP unavailable → clean typed failure; mention-resolver has lsp/semantic fallback chain | LIVE | `src/agent/lsp-bridge.ts:143-164`, `src/agent/mention-runner/default-resolver.ts:113-125` |
| command-hooks (ADR-0454) wired via HookBus (pre/post_tool_use), default-OFF | LIVE (gated) | `src/agent/command-hooks/install.ts` |

## R1 claims REFUTED in R2 (recorded to prevent audit churn)

1. "Glob rule order is filesystem-dependent" — **false**, stable two-level sort exists.
2. "Same-dir AGENTS.md-class files are concatenated with positional bias" — **false**, first-present-wins with documented priority.
3. "Caller system prompt gets repo rules spliced against caller intent" — **false**.
4. "/state command consumer unverified/possibly missing" — **false**, fully wired.
5. "No LSP fallback of any kind" — **overstated**; typed unavailable failure + mention-resolver chain exist (tool-level auto-degrade still absent, tracked in RFC-01).
6. "read-routing / typecheck-stamp features refute the tool-routing gap" — **false lead**; `read-routing` is a knob-framework term (P4, `src/config/knob-inventory.ts:12`), unrelated to tool selection.

Also corrected: verify-guard max-trips default is **1** in code (`src/agent/verify-guard.ts:102`) while CLI knob docs say 2 — tracked as a ticket in RFC-02.

## Ticket extraction guidance

Each RFC has `W#`-numbered workstreams sized to be individual tickets. Every workstream lists: evidence anchors, exact deliverable, acceptance criteria, and default-ON/OFF posture. House constraints that apply to ALL tickets:

- **No invented heuristics/thresholds** — deterministic rules or measure-first (RFC-01 is explicitly measurement-gated).
- **Default-OFF discipline** for new behavior unless the RFC argues a safety-control exception (RFC-04 fixes an existing default-ON control, so it ships ON).
- **New gates** go through `@/shared` gateOn/gateDisabled vocabulary + knob registry (`src/apps/cli/cli-knobs.ts`) — three parallel knob systems exist; grep before adding (see memory: knob-config-systems-inventory).
- **Edit-class changes must mirror-check** edit / write / apply_patch / storage paths (jun-09 lesson).
- Each landed feature needs feature-catalog entry + ADR per DoD (`tools/pm/definition-of-done.ts`).
