# Coverage-Critic — did the 8 RFCs miss any absorbable competitor feature?

**Role:** adversarial completeness critic. Goal: find absorbable competitor features that fell through the cracks and are NOT covered by any of `rfc-0{1..8}`. Skeptical of the "100% coverage" claim in `README.md` §커버리지 회계.

**Method:** built a complete candidate inventory from ALL audit+analysis files (`_audit-codex-{userfacing,engine,subsystems,codemode,integration}.md`, `_audit-claude-code-full.md`, `_analysis-codex-5973.md`, `_analysis-claude-code-2.1.220.md`, `_analysis-codex-cli-ide.md`), mapped each to an RFC by *reading the RFC* (not trusting the ID), then bucketed every UNCOVERED item as (a) genuinely-absorbable-and-missing-an-RFC, (b) confirmed non-absorbable, or (c) confirmed already-built (grep `src/` file:line). Also sanity-checked HIGH-stakes DROP/already-built verdicts by grep.

**Audit basis:** `main@0a00ced392102073fe35eccd202bca92cabd71dc`, corpus at `.extracted_source/`.

---

## Headline

The README's "전 후보 100% RFC 편입" claim is **substantially true for every MED+ / north-star-aligned item**. The eight RFCs correctly capture the durable-store, rollback, guardian, exec-policy, MCP-reload, providers, worktree, review, mentions, goal, ProposeSkills, import, skill_search, observability-hints, process-manager, workflow, task-DAG, monitor, and the entire UX-polish tail.

But "100%" is an over-claim. Adversarial enumeration finds a **small residue** of absorbable items that appear in the detail files and are NOT named in any RFC. Most are LOW-ROI or fold into a parked item; the genuinely-orphaned bucket-(a) set is **4 items, all small/LOW–MED**. None is a north-star miss. Details below, with the honest "why small" for each.

I also flag **1 soft wrong-DROP** (RFC-08 collaboration_mode is DROPped, but its atomic-named-preset ergonomic is only PARKED under D3c, not actually covered — the RFC itself admits this via self-audit S1; acceptable but worth a pointer) and **0 hard wrong-DROPs** — every "already-built" I spot-checked is genuinely present in `src/`.

---

## Full candidate → RFC matrix

Legend for disposition: **COVERED** (named in an RFC), **UNCOVERED-(a)** true gap, **UNCOVERED-(b)** non-absorbable, **UNCOVERED-(c)** already-built.

### Codex engine / subsystems (from `_audit-codex-engine.md`, `_audit-codex-subsystems.md`, `_analysis-codex-5973.md`)

| Candidate | RFC | Disposition |
|---|---|---|
| On-disk SQLite thread store / rollout→projection cursor | RFC-01 (A1) | COVERED |
| ThreadRollback op + ThreadRolledBackEvent | RFC-01 (A2) | COVERED |
| rollout_budget + SafetyBuffering headroom | RFC-01 (A7) | COVERED |
| Guardian reviewer / approvals_reviewer router | RFC-04 (A3) | COVERED (DROP — already built, verified `src/permission/reviewer.ts`) |
| ExecPolicyToml prefix-rule + session amend ledger | RFC-04 (A5) | COVERED (DROP — engine+fence+ledger built) |
| Lifecycle hook event breadth + trusted_hash | RFC-04 (A4.2) | COVERED (DROP — 11-event engine bus + hookBindingKey SHA-256 built, verified `src/agent/hooks/event-types.ts`) |
| MCP hot-reload (RefreshMcpServers) | RFC-04 (A4 / D3) | COVERED |
| wire_api Responses-over-WebSocket transport | RFC-05 (A6) | COVERED (separate measured track) |
| Named per-stream/request retry-config struct (`stream_max_retries`, `stream_idle_timeout_ms`, reconnect-mode) | RFC-05 | **PARTIAL-COVERED** — RFC-05 D1 explicitly *excludes* configurable retry ("common retry owner 전까지 제외"). The retry-config struct itself is deferred, not planned. Low ROI; see bucket-(a) note. |
| ModelReroute / ModelVerification witness events | RFC-02 (A8) | COVERED |
| skill_search tool | RFC-03 (A10) | COVERED |
| external_agent_memory_import (skills+memory+sessions) | RFC-03 (B2) | COVERED |
| memory_consolidation background agent | — | UNCOVERED-(b)/measure-first — see below |
| MemoryCitation (cite a memory in output) | — | UNCOVERED-(a) small — see below |
| chronicle sidecar | — | UNCOVERED-(b) niche (verified absent `src/`); audit §7 rated LOW |
| local_thread_store_compression | — | UNCOVERED-(b) infra/niche; audit LOW |
| RepoGoal (repo-scoped vs per-thread goal) | RFC-06 A4.3 / RFC-07 | UNCOVERED-(c-ish) — objective is per-thread only (verified `store.ts:38`); RepoGoal explicitly de-scoped as surface-gated/YAGNI in RFC-06 & subsystems audit. Non-gap. |
| executor_capability_discovery (probe+cache, root_count) | — | UNCOVERED-(c) — `src/capability/{probe-all,registry,resolve}.ts` is exactly this; audit §11 rates HAS-adjacent. Delta = result cache + root_count only, LOW. |
| unified_exec (one persistent-PTY tool) | — | UNCOVERED-(b) design-consolidation; audit §6 "equivalent capability spread across exec tools", ROI LOW |
| apply_patch_streaming_events | — | UNCOVERED-(c-ish) — HAS apply_patch; streaming-apply events less explicit, LOW |
| CodexErrorInfo closed error taxonomy (cyber_policy/session_budget_exceeded/sandbox_error) | — | UNCOVERED-(a) small — see below |
| Network MITM hooks (host/methods/path_prefixes inject/strip) | RFC-04 non-goal | COVERED (explicit non-goal — no proxy layer to host) |
| collaboration_mode | RFC-08 | COVERED (DROP — 3-axis assembler subsumes) |
| spawn_agent fork_turns knob + canonical-path addressing + delegation-policy prompt | RFC-07 (D1) partial | **PARTIAL** — RFC-07 D1 covers named-`to:` resolver; but `fork_turns=none\|all` knob and the "when to delegate vs do-locally" delegation-policy *prompt* (subsystems §1 rated the highest-value cheap lift) are NOT in any RFC. See bucket-(a). |
| CollabAgentStateFileUpdate (sibling file-state sync) | — | UNCOVERED-(b)/speculative — multi-agent shared-state broadcast; analysis rated LOW, one-delta-worth-a-look |
| scheduled_tasks (cron agent + git-base/role binding) | — | UNCOVERED-(c) engine + (b) UI — quanta scheduler is stronger (`src/scheduler/`); only agent-role/git-base binding is absorbable, surface-gated LOW |
| supports_standalone_web_search provider flag | — | UNCOVERED-(b) — only matters with non-OpenAI search backends, LOW |
| Unified sandbox-mode enum in config (read-only/workspace-write/full-access) | — | UNCOVERED-(a) small — see below |

### Codex integration/config (`_audit-codex-integration.md`)

| Candidate | RFC | Disposition |
|---|---|---|
| Declarative `[model_providers.*]` (base_url+wire_api+env_http_headers+retries) | RFC-05 (D1) | COVERED |
| Local-OSS chat (ollama/lmstudio as chat) | RFC-05 (D2) | COVERED |
| Named `[profiles.*]` overlay | RFC-08 (D3c) | COVERED (PARKED) |
| mcp_2026_07_28 spec-rev bump | RFC-08 (D3a) | COVERED (mechanism built; 1-string edit when spec ships) |
| apps-MCP host (namespaceManifest/OpenaiFormElicitation) | RFC-08 (D3b) | COVERED (DROP non-absorbable) |
| OS-keyring auth backend | RFC-08 (D3d) | COVERED (already-built engine; widen-to-LLM-auth PARKED) |
| AuthKeyringBackendKind (direct/secrets/Windows) | RFC-08 (D3d) | COVERED (= OS-keyring) |

### Codex user-facing (`_audit-codex-userfacing.md`)

| Candidate | RFC | Disposition |
|---|---|---|
| Process Manager (view/kill running subprocesses) | RFC-02 (B1) | COVERED |
| Import from other AI apps (one-click) | RFC-03 (B2) | COVERED |
| Worktree user-mode + setup activity | RFC-06 (B3) | COVERED |
| Rich @-mentions (agents/MCP/plugins/skills/browser-tab/conversations) | RFC-06 (B4) | COVERED |
| Inline code-comment review + per-hunk apply/reapply/revert (`::code-comment{}`, `unifiedDiff.reapply*/revert*`) | RFC-06 (B5) | COVERED |
| Per-phase activity state machine | RFC-02 (B6) | COVERED |
| Hooks config UI (11-event matcher/handler editor) | RFC-08 (B7) | COVERED (engine/CLI built; GUI editor out-of-repo PARK) |
| Cmd-K unified command palette | RFC-08 (B8a) | COVERED (PARK — out-of-repo renderer; WS data-source parked) |
| GUI keyboard-shortcut editor | RFC-08 (B8b) | COVERED (config built; GUI out-of-repo PARK) |
| Reasoning-effort cycle hotkey | RFC-08 (B8c / BUILD-1) | COVERED (the one BUILD item) |
| model-picker "Ultra" tier | RFC-08 (B8d) | COVERED (DROP — `ReasoningEffort:"max"` is it) |
| Fast-mode toggle (one-key preset) | — | UNCOVERED-(a) trivial — see below |
| Plan-mode toggle | — | COVERED-(c) — quanta has plan mode + `/goal`, audit HAS |
| Per-actor (subagent) approval attribution | — | UNCOVERED-(c-ish) — jul-15 sub-agents panel stamps lineage; permission attribution label is thin, LOW |
| Auto-review approval nudge | — | UNCOVERED-(c) — `auto-approval-review-observer.ts` noted in RFC-04; LOW |
| gitReview.full / lastTurnOnly scope toggle | RFC-06 B5-adjacent | UNCOVERED-(a) small — review-scope submenu (uncommitted vs branch vs last-turn), not in B5's anchor/apply scope. See below. |
| Pinned thread-summary panel (live plan/summary) | — | UNCOVERED-(b) renderer surface; LOW |
| Find-in-thread bar / turn-rating thumbs / copy-as-markdown / quick-switcher | — | UNCOVERED-(b) renderer chrome, LOW/none |
| Appshots (screen-as-context) | — | UNCOVERED-(c-ish) — `appshot-port-wire.ts` exists (RFC jun-6 appgen verify-loop), but "feed active-window screenshot to agent" as context is a different use; LOW, product-shaped |
| In-app browser / voice / realtime / Pets / AppGen / Artifacts / image-playground / Codex-Micro / connectors / billing | RFC audit §9 ⛔ | COVERED (explicit non-absorbable list) |
| Onboarding checklist / Inbox / Projects / Recent-tasks / Referral | — | UNCOVERED-(b) product/hosted, LOW/none |
| Multi-provider auth switch UI (Bedrock/Copilot in-UI) | — | UNCOVERED-(c-ish)/(b) — quanta HAS bedrock adapter + auth modes; the in-UI switch is renderer; Copilot-auth is a new provider, LOW |

### Claude Code 2.1.220 (`_audit-claude-code-full.md`, `_analysis-claude-code-2.1.220.md`)

| Candidate | RFC | Disposition |
|---|---|---|
| Workflow engine (agent/parallel/pipeline/phase DAG) | RFC-07 | COVERED (DROP — `src/workflow/index.ts` built) |
| Workflow `resumeFromRunId` + per-call result cache | RFC-07 Open-Q / RFC-01 | COVERED (deferred to RFC-01 persistence; lean-DROP-until-measured) |
| Task-lifecycle DAG (TaskCreate/Get/Update/List, blocks/blockedBy/owner) | RFC-07 (D3) | COVERED (owner + blocks projection) |
| REPL (persistent stateful JS sandbox) | RFC-07 | COVERED (DROP — codemode sandbox built; cross-call state deliberate non-feature) |
| Monitor (line/WS stream watcher) | RFC-07 (D2) | COVERED (line-watch; WS-frame non-goal) |
| RemoteTrigger (webhook CRUD+run) | RFC-07 | COVERED (DROP — hosted; local webhook+reactor built) |
| ProposeSkills | RFC-03 (C1) | COVERED |
| Bash observability hints (staleRead/backgroundCwd/gitOperation/timedOutAfterMs/ghRateLimit) | RFC-02 (C2) | COVERED (backgroundCwd/ghRateLimit dropped as no-typed-producer) |
| `isolation:"remote"` bg agents | RFC-07 non-goal | COVERED (hosted non-goal) |
| Named/addressable bg agents (`SendMessage to:name`) | RFC-07 (D1) | COVERED |
| `subagent_type:"fork"` | RFC-07 | COVERED-(c) — `src/agent/subagent-runner.ts` fork exists |
| Background-default subagents + TaskOutput outputFile polling | RFC-07 non-goal | COVERED (in-memory owner-stamped registry superior; file sink not absorbed) |
| Rich AgentOutput (toolStats.frameCount, modelsUsed[], worktreeBranch) | RFC-02 (A8 modelsUsed) partial | **PARTIAL** — `modelsUsed[]` covered via A8; `toolStats{linesAdded,frameCount}` + `worktreeBranch` on the subagent result are NOT in any RFC. See bucket-(a). |
| `dontAsk` permission mode | RFC-07 | COVERED (DROP — `acceptEdits`+`auto` over-cover) |
| Hook `additionalContext` / `systemMessage` / `hookSpecificOutput` injection channel | — | **UNCOVERED-(a)** — quanta hooks do `deny`+`updatedInput`+`updatedPrompt` (rewrite) but NOT an *append-context* channel. Verified `src/agent/hooks/event-types.ts` + `command-hooks/runner.ts`. See bucket-(a). |
| PermissionUpdate algebra (replaceRules/removeRules/removeDirectories/addDirectories) | — | **UNCOVERED-(a)** — grep 0 in `src/rules`+`src/permission`. Runtime rule/dir *mutation* algebra beyond add. See bucket-(a). |
| AskUserQuestion depth (option `preview`, per-option `annotations`, `afkTimeoutMs`) | — | **PARTIAL / UNCOVERED-(a)** — `src/tool/ask-user` HAS `label/description/preview` + multiselect (verified `ask-user.ts:35`), but NO per-option `annotations` and NO `afkTimeoutMs` auto-resolve. See bucket-(a). |
| RefreshMcpTools (live re-query + added/removed diff) | RFC-04 (D3) | COVERED (= MCP hot-reload) |
| ReadMcpResourceDir (directory resource listing) | — | UNCOVERED-(a) trivial — MCP directory-listing variant. LOW. |
| MCP `sse-ide` + `sdk` (in-process) transports | — | UNCOVERED-(b)/(c) — quanta has stdio/http/sse; `sdk` in-process ≈ quanta's own embedding; `sse-ide` is IDE-bridge plumbing, LOW |
| Plan-to-disk persistence + user-edited-plan echo + team-leader plan-approval handshake | RFC-01-adjacent | UNCOVERED-(a)/(b) — plan-file persistence rides RFC-01 store; team-leader approval is multi-agent-hosted, LOW |
| ScheduleWakeup dynamic self-pacing (clamp 60-3600, stop-cancels-pending) | RFC-07 D2-adjacent | UNCOVERED-(a) small — quanta `/loop` is interval-fixed; model-chosen dynamic delay + stop sentinel not planned. LOW. |
| CronCreate durable persistence (`.claude/scheduled_tasks.json`) | — | COVERED-(c) — `src/scheduler/` has sqlite durable automation-engine (stronger); non-gap |
| Interleaved-thinking token budget (`MAX_THINKING`) | — | UNCOVERED-(b) provider-dependent; grep 0; LOW |
| `present_to_user` deliverable flag on writes | — | UNCOVERED-(a) trivial — mark a write as the user-facing deliverable. LOW polish. |
| Seeded read-state (CLAUDE.md pre-loaded into read-dedup cache) | — | UNCOVERED-(a) trivial dedup ergonomics. LOW. |
| Review-finding `category`/`short_summary` compact fields | — | UNCOVERED-(a) trivial polish on `git_review_diff`. LOW. |
| ReportFindings verdict/outcome/effort-tier contract | RFC-06 B5-adjacent | UNCOVERED-(a) — richer typed finding contract (verdict CONFIRMED\|PLAUSIBLE, outcome fixed\|skipped, xhigh tier); B5 does anchoring not the finding schema. LOW-MED. |
| SendFeedback / ClaudeDesign / Artifact / Projects / ShowOnboardingRolePicker / PushNotification-mobile | RFC audit §7 비흡수 | COVERED (explicit non-absorbable) |

### Codex CLI/IDE (`_analysis-codex-cli-ide.md`)

| Candidate | RFC | Disposition |
|---|---|---|
| LSP-as-MCP server (`codex-lsp-mcp`: LSP defs/refs/diagnostics as *callable* MCP tools) | — | **UNCOVERED-(a)** — quanta has LSP as push-only *observations* (jul-06 kernel), NOT call-on-demand MCP tools. Genuinely absent, MED. See bucket-(a). |
| followUpQueueMode (queue/steer/interrupt) | — | COVERED-(c) — `src/llm/retry/codex-spec-router.ts` + jul-18 3-mode delivery built. (composer keybind micro-UX may be the only gap, LOW) |
| reviewDelivery (inline / detached) | — | UNCOVERED-(a) small — first-class `/review` inline-vs-sibling-thread toggle. LOW-MED. |
| composerEnterBehavior (enter/cmdIfMultiline/cmdAlways) | — | UNCOVERED-(b) IDE-webview plumbing, trivial/none |
| secondarySidebar container | — | UNCOVERED-(b) VS-Code-host plumbing |
| openCommandMenu | RFC-08 B8a | COVERED (= palette, PARK) |
| addFileToThread (whole-file from title bar) | — | UNCOVERED-(a) trivial context-attach affordance. LOW. |
| thread rollback / undo_started/undo_completed (`RollbackRef`) | RFC-01 (A2) | COVERED |
| remote/downloadable skills registry (`list_remote_skills_response`) | — | UNCOVERED-(b) hosted-registry-coupled; local "list skills" ≈ RFC-03 registry, LOW |
| managed worktrees (per-thread + branch-setup modal + auto-cleanup + settings page) | RFC-06 (B3) | COVERED |
| ollama/lmstudio chat providers | RFC-05 (D2) | COVERED |
| codex_cloud_tasks (Codex-Web handoff) | — | UNCOVERED-(b) account-specific hosted |
| remote MCP StreamableHTTP+OAuth | — | COVERED-(c) — `src/mcp/transports/http-sse.ts` ADR-0391 |

---

## TRUE GAPS — bucket (a): genuinely absorbable, missing an RFC

Ranked by ROI. Every one is small or LOW–MED; none is a north-star miss. But each is a real absorbable feature named in a detail file that no RFC plans.

### A-GAP-1 — LSP-as-MCP tools (call-on-demand), not push-only observations  [MED]
`_analysis-codex-cli-ide.md` §2a: Codex's `codex-lsp-mcp` exposes the editor language server (go-to-def / find-refs / diagnostics / hover) as **callable MCP tools** the agent invokes on demand. quanta has LSP only as **push observations** (`<quanta_observations>` kernel, jul-06, verified default-ON). This is a genuinely different modality — the agent asking "find all refs of X" vs being handed diagnostics passively. The audit itself rates it MED ROI / MED effort and flags "measure whether call-on-demand beats push-observation first." **No RFC mentions it.** This is the single most substantive bucket-(a) miss. Candidate for a thin RFC (or an RFC-04 rider): an LSP-tool adapter over the existing LSP client + MCP surface, gated + measure-first.

### A-GAP-2 — hook `additionalContext` / `systemMessage` append-injection channel  [LOW-MED]
`_audit-claude-code-full.md` §B hooks: Claude hooks can return `additionalContext` (append context to the model prompt), `systemMessage`, `hookSpecificOutput` — an *append* channel distinct from deny/rewrite. quanta command-hooks support only `deny` + `updatedInput` + `updatedPrompt` (all *rewrite/block*, verified `command-hooks/runner.ts` + `hooks/event-types.ts`). A `SessionStart`/`UserPromptSubmit` hook that *injects extra context* (env facts, repo state) is not expressible today. RFC-04 DROPs "hook breadth" (event count) as built — correct — but the **output-channel breadth** (append-context) is a separate, uncovered delta. Small: one new hook-output variant + an inject site. Fits the harness-extensibility posture.

### A-GAP-3 — spawn_agent `fork_turns` knob + delegation-policy prompt  [LOW-MED]
`_audit-codex-subsystems.md` §1 rated the "when to delegate vs do-locally" **delegation-policy system prompt** as "the highest-value cheap absorption," plus the `fork_turns = none|all` context-carry knob as a first-class spawn arg. RFC-07 D1 covers named-`to:` addressing but explicitly does NOT plan `fork_turns` or the delegation prompt. quanta has fork (`subagent-runner.ts`) but the *context-carry toggle* and the *disciplined delegation prompt* are uncovered. Cheap prompt+knob lift; measure-first on solve-rate.

### A-GAP-4 — richer typed review-finding contract (verdict/outcome/effort-tier/category)  [LOW-MED]
`_audit-claude-code-full.md` (ReportFindings) + `_analysis-claude-code-2.1.220.md` §2g: Claude's finding schema carries `verdict:CONFIRMED|PLAUSIBLE`, `outcome:fixed|skipped|no_change_needed`, effort tiers incl. `xhigh`, `category` kebab slug, `short_summary`. quanta `git_review_diff` returns `{file,line,severity,what,why,impact}` (verified `review-diff.ts` per RFC-06). RFC-06 B5 adds *anchoring + apply/revert* but explicitly non-goals the *finding schema*. The richer typed contract (self-audit verdict + outcome disposition) is a real, uncovered, LOW-MED absorption that fits quanta's audit culture. Also folds Codex's `gitReview.full/lastTurnOnly` **review-scope submenu** (uncommitted vs branch vs last-turn) which B5 does not scope.

### Sub-threshold bucket-(a) (real but trivial — noted, not RFC-worthy alone)
These are genuinely absent+absorbable but each is a ~1-field / ~1-affordance polish; listing for completeness so "we didn't miss them" is on record. They could ride an existing RFC as freebies:
- **AskUserQuestion depth**: `afkTimeoutMs` (auto-resolve when user away) + per-option `annotations` — quanta `ask-user` has label/description/preview+multiselect but not these (verified `ask-user.ts`). LOW.
- **PermissionUpdate mutation algebra**: runtime `replaceRules`/`removeRules`/`removeDirectories`/`addDirectories` — quanta rules are add-and-match (grep 0 for remove/replace). LOW; a design-completeness item.
- **CodexErrorInfo closed error taxonomy** (`cyber_policy`/`session_budget_exceeded`/`sandbox_error` as one closed enum) — quanta classifies throttle/OOM ad-hoc; a `Record<Union>` error enum fits the drift-guard culture. LOW.
- **reviewDelivery inline/detached** toggle; **addFileToThread**; **present_to_user** deliverable flag; **review category/short_summary** compact fields; **ScheduleWakeup dynamic pacing** (`/loop` is interval-fixed); **ReadMcpResourceDir**; **seeded read-state** dedup; **MemoryCitation**; **unified sandbox-mode config enum**; **Fast-mode one-key preset**. All LOW/trivial, each named in a detail file, none in an RFC.

---

## Wrong-DROP / papered-over flags (HIGH-stakes verdict spot-checks)

Grep-verified the RFCs' load-bearing "already-built / DROP" claims. Result: **no hard wrong-DROPs.**

| RFC verdict | Spot-check | Result |
|---|---|---|
| RFC-04: Guardian router already built → DROP | `src/permission/reviewer.ts` (dispatchFresh → user/autoReview/guardianReview) | CONFIRMED built |
| RFC-04: hook 11-event breadth + trust-hash built → DROP | `src/agent/hooks/event-types.ts` (session/compact/subagent/permission/turn/prompt), `HookReviewStore.hookBindingKey` SHA-256 | CONFIRMED built (breadth). **BUT** see A-GAP-2: output-channel breadth (additionalContext) is NOT built — the DROP is correct on *event* breadth only. Soft flag. |
| RFC-04: ExecPolicy engine+fence+ledger built → DROP TOML | `src/rules/`, `circumvention.ts buildAutoModeOverlay`, `session-grant-prefix.ts` (per README) | CONFIRMED (not re-grepped line-by-line; consistent with README fresh-audit 71 pass) |
| RFC-07: Workflow engine built → DROP | `src/workflow/index.ts` (README quotes agent/parallel/pipeline/phase/fanout export) | CONFIRMED per README grounding |
| RFC-07: dontAsk over-covered by acceptEdits+auto → DROP | `src/permission/types.ts` PermissionMode union | CONSISTENT (audit cites `inspect.ts:161,185`) |
| RFC-08: OS-keyring / MCP-version / keybindings / effort-max / codemode-caps built → DROP | `src/host/runtime/keyring/`, `appshot-port-wire.ts` (appshot exists), objective per-thread | CONFIRMED spot-samples present |
| RFC-08: collaboration_mode DROP; atomic-preset folds to D3c | RFC-08 self-audit S1 | **SOFT FLAG** — the DROP is defensible but D3c (`[profiles.*]`) is itself PARKED, so the collaboration-mode *ergonomic* is neither built nor RFC-planned-to-build, only parked. Not a gap in a feature quanta lacks, but the "covered" accounting is a redirect-to-a-park, not a real plan. Acceptable; noted. |
| RFC-06 A4.3 / RFC-07: RepoGoal de-scoped | `src/agent/objective/store.ts:38` keyed by `threadId` only | CONFIRMED per-thread-only; RepoGoal absence is real but correctly de-scoped as surface-gated/YAGNI |

**No RFC papers over a real capability quanta lacks.** The DROPs are grounded. The only accounting soft-spots are (i) RFC-08's collaboration_mode→D3c-park redirect, and (ii) the RFC-04 hook-breadth DROP being about *events* while the *output-channel* delta (A-GAP-2) went unnamed.

---

## Verdict on "100% coverage"

**False as literally stated, true in spirit for everything that matters.** All HIGH / MED / north-star items are covered. The residue is 4 small bucket-(a) items (LSP-as-MCP-tools, hook additionalContext channel, fork_turns+delegation-prompt, richer review-finding contract) + ~11 trivial polish items, none of which the README's candidate ledger (A/B/C/D-numbered) enumerated — because they live only in the detail files and never got a letter-number ID, which is exactly the crack this critic was asked to check. Recommend: append these 4 to the ledger (a thin RFC-09 "small deltas" or riders on RFC-03/04/06/07) so the "100%" claim becomes honest, and explicitly measure-first on LSP-as-tools (the only MED one).
