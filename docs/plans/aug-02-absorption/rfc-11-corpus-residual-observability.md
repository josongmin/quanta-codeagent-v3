# RFC-11 — Corpus-residual: subagent-result observability + scheduled-task binding richness

**Status:** SCOPED (2 thin BUILDs). Surfaced by reconciling the `REFRESH-DIFF-2026-08-02` candidate list against landed code — RFC-10's raw-token DRY sweep did not cross-check the refresh-diff's named MED candidates, and two survive as genuine (small) deltas after RFC-01~09.

**Audit basis:** corpus `.extracted_source/` (claude-code 2.1.220 `sdk-tools.d.ts`, codex 5973 `_codex-bin-symbols.txt`), landed surface = `codex/aug02-integration`. **Depends on the aug-02 integration branch being landed** (RFC-02-3 route events, RFC-06 WorkspaceOwnership, existing usage/budget meter) — RFC-11 PROJECTS those existing signals; it builds no new store.

## Why this exists (RFC-10 gap)

The `REFRESH-DIFF-2026-08-02` §1 named HIGH+MED absorption candidates but flagged them **unverified** ("착수 전 각 후보 quanta 코드-먼저 대조 필수"). Cross-checking each against code:

| refresh-diff candidate | disposition |
|---|---|
| Lifecycle Hooks engine (HIGH) | **ALREADY-BUILT** — `src/agent/command-hooks/` (full event set pre/post_tool_use·permission_request·pre/post_compact·session_start/end·user_prompt_submit·subagent_start/stop + `matchTool` matcher + `HookReviewStore` trust-hash + runner). refresh-diff's "훅 엔진 없음" was stale. |
| ProposeSkills (HIGH) | **ALREADY-BUILT** — RFC-03 `skill_create` cutover = agent-drafts → immutable proposal stage → ApprovalStateMachine → CAS promote. Auto-lexical-trigger deliberately excluded (RFC-03 non-goal). |
| RefreshMcpTools (MED) | **ABSORBED** — RFC-04 MCP hot-reload LIVE feeder. |
| Thread rollback / undo-applied-edits (MED) | **ABSORBED** — RFC-01 ThreadRollback + RFC-06-4 hunk CAS undo. |
| bash `timedOutAfterMs` (MED) | **ABSORBED** — RFC-02-4 evidence (`timeoutMs`/`detached`/`backgroundShellId`). |
| external agent import (MED) | **ABSORBED** (agents_md·skills·memory·hooks·mcp·subagents) — RFC-03-4 + external-config. |
| **subagent AgentOutput observability fields** (MED) | **RESIDUAL → RFC11-1** |
| **Scheduled-task role/git-base binding** (MED) | **RESIDUAL → RFC11-2** |

Deliberate non-absorptions (recorded so a future audit does not re-flag as gaps): `backgroundCwdHint` (RFC-02 refuses to guess background cwd — safety); `modelsUsed[]` as a *stored* array (RFC-02 single-owner matrix forbids a `modelsUsed` store — quanta projects from `model_route_changed` events instead — RFC11-1 honors this by projecting, not storing); external-import `PLUGINS`/`SESSIONS` (Codex plugin ecosystem ≈ non-absorbable; session-import low-value); realtime/voice/browser/computer_use/imagegen/marketplace/connectors/billing/codex_cloud_tasks/SendFeedback/ClaudeDesign/artifact-gallery/project-knowledge-RAG (hosted/product-specific).

## RFC11-1 — Subagent result observability projection

**Corpus (claude-code `AgentOutput`, sdk-tools.d.ts:99-164):** `{ agentId, agentType, resolvedModel, modelsUsed?: string[], totalToolUseCount, totalDurationMs, totalTokens, usage{...}, frameCount?, worktreeBranch? }`.

**quanta today (`subagent-runner.ts`):** the subagent result carries `{ finalText, turns, ok }` + `TaskRecord.result.{outputSummary,outputDetail}`. Rich per-run observability (models used, tokens, duration, tool-use count, worktree branch) is NOT surfaced onto the result — even though every input signal already exists elsewhere.

**Delta = pure read PROJECTION onto the existing subagent result / `TaskRecord` (no new store):**
- `frameCount := turns` (already tracked; alias for parity).
- `modelsUsed[] :=` the distinct set projected from RFC-02-3 `model_route_changed` events over the run (NOT a stored array — honors the single-owner matrix; the caller projects, same as RFC-02-3).
- `worktreeBranch :=` the subagent's `SessionMeta.workspaceOwnership` branch (RFC-06) when it ran in an owned worktree; absent otherwise.
- `totalTokens`/`totalDurationMs`/`totalToolUseCount`/`usage :=` project the existing budget/usage meter + tool-dispatch count for the run.

**Owner:** existing `subagent-runner` result + `TaskRecord` (jul-15 lineage). Optional additive fields only. **North-star fit:** direct agent-state observability (what a subagent did / which models / which worktree).
**Admission RED:** a completed subagent whose run used ≥2 models / ran in an owned worktree / spent tokens does NOT surface `modelsUsed`/`worktreeBranch`/`totalTokens` on its result; red-on-injection = drop the projection → the fields vanish.
**Non-goals:** no `modelsUsed` store, no new usage meter, no per-field bus. Gate-OFF (fields absent) ⇒ `TaskRecord`/result byte-identical.
**Effort:** S (projection wiring over landed RFC-02-3/RFC-06 signals).

## RFC11-2 — Scheduled-task agent-role + git-base binding

**Corpus (codex 5973 `ScheduledTaskSchedule`):** binds `{ baseBranch, agent_role, agent_path, agent_nickname, model, prompt/instructions, cadence(Hourly interval_hours | Daily | Weekly+Weekday MoTuWeThFrSaSu), skill_approval, request_permissions }`.

**quanta today (`src/scheduler/cron-slash-adapter.ts`):** `create(title, rule, prompt)` binds title + cron rule + prompt; model binds via `model-reroute`. Missing vs Codex: **agent-role** and **git-base-branch** binding on a scheduled task.

**Delta = extend the existing scheduler `create` additively (no new scheduler/store):**
- Bind an optional **agent-role** (reuse the existing subagent/agent-role registry — a scheduled run adopts that role's system prompt/tools).
- Bind an optional **git-base-branch** (reuse RFC-06 `WorkspaceOwnership`/`createPersistentWorktree` — a scheduled run forks from that base, same owner as interactive worktree).

**Owner:** existing `src/scheduler/` (cron-slash-adapter + runtime-wire + model-reroute). Additive optional binding fields; NO new scheduler engine/store/panel.
**Admission RED:** a scheduled task created with a role + git-base does NOT run under that role / from that base branch; red-on-injection = drop the binding → the scheduled run reverts to default role/cwd.
**Non-goals:** no `ScheduledTasksDetail` renderer panel (product chrome, non-absorbable), no `skill_approval`/`request_permissions` per-task ACL (RFC-04/permission owner), no new cron engine.
**Effort:** MED (binding threading through the existing scheduler; git-base reuses RFC-06).

## Landing rules (README-consistent)

Both are default-OFF additive, single-owner (RFC11-1 = subagent result/TaskRecord projection; RFC11-2 = existing scheduler), no new store/bus/panel, hellgate (admission RED + gate-OFF byte-identical + red-on-injection) + ≥3R hellaudit. RFC11-1 is independent; RFC11-2 depends only on RFC-06 WorkspaceOwnership. Neither is a SWE-score lever — both are agent-state-observability / UX richness. **Measure-first: neither has proven efficacy; land default-OFF and A/B only if an observability/scheduling consumer demands it.**
