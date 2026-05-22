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

---

# SOTA++ references (Codex / Claude / Cursor)

2026-05-23. Per-feature competitor patterns mined from the beautified corpus at
`~/agent-analysis/unpacked/` (codex-desktop / claude-desktop / cursor). Each entry:
**source** (agent + corpus file:line), **adopt** (fold into our steps),
**skip** (deliberately not — with why). Citations are corpus paths, not our repo.

## Permission cluster

### git-write-protection (L2→L3)
- **Source — Cursor** `cursor/agent-exec.js:162850-162952`: path-**type-categorized** deny set (`git`: `.git/hooks/**`, `.git/config`, `.git/config.worktree`, `.git/info/attributes`; `workspace`: `.vscode/**`, `*.code-workspace`, `.cursorignore`, `.cursor/**/{cli,mcp*}.json`, `.claude/*.json`; `worktree`: `.git` root). Enforced **preflight** via glob (`WU()`) before sandbox spawn; git-worktree lookups **cached** in a Map.
- **Adopt**: (1) add a `GitWriteProtectReason` path-type tag (`git_hooks|git_config|editor_config|worktree`); (2) extend deny set with `.git/config.worktree` + `.git/info/attributes` (both name git-executed config); (3) **cache** the worktree-root resolution so nested-`.git` scans don't re-`stat` per call; (4) dual-layer = our static gate now + OS sandbox later reuse same list.
- **Skip**: cursorsandbox binary (OS-level; we're surface-agnostic), `.cursorignore`/`.claude/*.json` (competitor-specific, not our jailbreak vector — matches ADR-0091).

### review-kind-matrix (L3→L4)
- **Source — Cursor** `cursor/agent-exec.js:138299-138327, 98878`: `HumanReview{selected_option, feedback_text, submit_feedback_as_new_message, bubble_id}`; review kinds as oneof (`media/diff/code_edit`); `allowlist_escalated:bool` on policy → re-run command with preflight skipped.
- **Adopt**: (1) `submit_feedback_as_new_message` → wire `reject_and_tell.message` into our steering seam (next-turn user msg); (2) the **allowlist_escalated re-run** pattern — after approval, set a flag so the same action skips re-review within the run.
- **Skip**: `bubble_id` (internal UI tracking); media_review kind (no media tools).

### trust-scope-wire-up (L3→L4)
- **Source — Claude Desktop** `claude-desktop/main.js:103939-104225, 89827`: `safeStorage.encryptString` persistent allowlist cache, **2h TTL**, org-scoped, cascade API→cache→TTL-check. **Codex** uses ephemeral `Map<routeKey,host>` (not persistent).
- **Adopt**: persistent grant store with **OS-keyring/encrypted** at rest + **TTL** + **scope cascade** (exact → command-pattern → project → global, most-specific wins); per-project overlay in `.quanta/project-grants.json`.
- **Skip**: org-blocklist API (needs backend; defer to SaaS), Codex ephemeral cache.

### permission-remember-patterns (L3→L4)
- **Source — Cursor** `cursor/agent-exec.js:99207-99213`: `ClassifiedCommand{name, arguments[], suggested_allowlist_entry, subcommand_tokens[]}` — classifier proposes a **token-sequence** allowlist entry (`"npm,install"`), human accepts → grant.
- **Adopt**: (1) emit a `suggested_allowlist_entry` (leading-token sequence) on each ask, so the user grants a *pattern* not a literal; (2) cascade resolution order = exact → prefix-token (min_tokens_match) → base → ask; (3) record `learning_source` (user_accept | classifier).
- **Skip**: ML classifier v2 (start with prefix-token match; overfitting guard on known-dangerous flags later).

## Agent-loop control-op cluster

### submission-op-envelope (L3→L4)
- **Source — Codex** `codex-desktop/*`: control-ops are **first-class JSON-RPC methods** (`turn/interrupt{threadId,turnId}`), interrupt pre-gated by `ensureReady()`.
- **Adopt**: gate `interrupt` on session-ready state before `signal.abort()`; keep the typed op envelope but make interrupt/cancel_subagent *behavioral* (the L4 gap), reusing conversation-action's cancel path.
- **Skip**: full RPC transport rewrite (our envelope is already typed; just wire behaviors).

### conversation-action-steering (L3→L4)
- **Source — Codex**: mid-turn enforcement is **policy-as-capability** (sandboxPolicy `read-only|workspace-write|...`) at dispatch, NOT mid-turn message unwinding. **Cursor** uses post-turn `notifyUserAction` (accept/cancel), not true mid-turn injection.
- **Adopt**: prefer **dispatch-boundary enforcement** for control effects (stateless) over unwinding; cancel_subagent routes to the subagent registry abort (ADR-0011).
- **Skip**: Cursor side-channel notification model (loses request/response traceability).

### response-in-progress (L3→L4)
- **Source — Codex** `codex-desktop/{worker,app-session}.js`: full OpenAI-Responses taxonomy — `response.created / .in_progress / .queued / .output_text.delta / .function_call_arguments.{delta,done} / .completed / .failed / .incomplete`; `.in_progress` fires on first **event** (not first chunk); `.queued` = back-pressure (approval/rate-limit), distinct from interrupt.
- **Adopt**: (1) wire `onInProgress` (the L4 gap); (2) **add a `queued` back-pressure variant** with reason (approval|rate_limit) — richer than a bare heartbeat; (3) terminal trio completed/failed/**incomplete** (incomplete = user-truncated).
- **Skip**: codex/event/* internal namespace.

### queued-follow-ups (L3→L4)
- **Source — Codex**: feature-flagged `queued-follow-ups`; turn can enter `queued`; pause metrics (`safetyRunningCount`, `safetyStartedAtMs`) let client estimate pause duration.
- **Adopt**: PausedReason taxonomy = `user_approval | rate_limit | system_resource | safety_review`; expose a pause-duration estimate; emit `response.queued` (ties to response-in-progress).
- **Skip**: making the queue a heavy first-class construct — keep it thread-scoped + derivable from turn history.

### phase-ttft-readonly-trio (L3→L4)
- **Source — Cursor** `cursor/workbench.js`: explicit `ttft / total_ttft_ms` scalar fields + `setTtftMs(n)` guard (reject non-finite/negative), telemetry `composer.submitChat.hangTtft`. **Codex** = SandboxPolicy-as-phase.
- **Adopt**: mirror Cursor's **measured ttft_ms with the negative/non-finite guard**; emit `total_ttft_ms` to OTel; keep phase tagging as-is.
- **Skip**: per-tool TTFT histograms (deferred follow-up already noted).

### plan-mode-dispatch-block (L3→L4)
- **Source — Codex**: dispatch-time `sandboxPolicy` check, default `read-only`; allowed-policy set pre-filtered per user/org.
- **Adopt**: enforce at the dispatch boundary (fail-fast, stateless) — exactly our `checkDispatchAllowed` call-site plan; default-deny mutating in plan posture.

## Tools / subagent / memory cluster

### subagent-6-tools (L3→L4)
- **Source — Codex** `codex-desktop/main.js:21975,38933,40088-40103; worker.js:40904`: `terminalManager.{createOrAttach, write, runAction, resize, close, track, getSnapshotForConversationId}`; per-conversation PTY isolation; worker-thread isolation; events `exec_command_{begin,end,output_delta}`.
- **Adopt**: (1) **idempotent `createOrAttach`** (reuse PTY by (conversationId,sessionId)); (2) **getSnapshot** for turn checkpointing; (3) exec output_delta events (ties to our shell-output-delta L4); (4) `resize` for TTY-aware tools.
- **Skip**: worker-thread process model (our runtime is single-process Bun) unless isolation demands it.

### tool-output-schema-factory (L3→L4)
- **Source — Cursor/Claude** `cursor/workbench.js:1206392; claude-desktop/main.js:90592`: `outputSchema` as first-class tool property + `renderOutputCell` (= toModelOutput bridge).
- **Adopt**: wire the streaming-input seam (`buildToolInputSeam`) — our L4 gap — and keep outputSchema validation pre-return; render compact `toModelOutput` on dispatch.

### typed-tool-failure-modes (L3→L4)
- **Source — Cursor** `cursor/agent-exec.js:99363-99381 (ShellResult), 105790-105816 (EditResult)`: per-case **message types** — Shell `{success|failure|timeout|rejected|spawn_error|permission_denied}`, Edit `{success|file_not_found|read_permission_denied|write_permission_denied(+isReadonly)|rejected|error}`.
- **Adopt**: (1) when migrating tools, carry **case-specific context** (e.g. `write_permission_denied{path,isReadonly}`); (2) add `spawn_error` to bash failures; (3) split read/write permission-denied. Richer than our current 5-mode union.
- **Skip**: nothing — this is a straight superset to adopt.

### codex-2-phase-consolidator (L3→L4)
- **Source — Cursor** `cursor/workbench.js:143388,169336,185740,191276,192931`: `summarization_strategy` enum, `summarizedMessages` (per-turn = phase 1), `summarizedComposers` (cross-session = phase 2), `force_summarization` flag, `RememberThisCapability.memory`.
- **Adopt**: (1) **session-end hook** drives phase 1 (turns are the unit — not cron, per audit); (2) `force_summarization` manual trigger + memory-budget check; (3) keep our CAS/watermark (already SOTA vs their obfuscated version).
- **Skip**: cron scheduler for phase 2 (use threshold/explicit trigger; cron is heavier than needed).

### seam — skill model/effort override (L3→L4)
- **Source — Codex** `codex-desktop/main.js:1340,1817,14668`: SKILL.md frontmatter `{model, reasoningEffort}`, passed at turn creation (`effort: f.reasoningEffort`), inheritance automation→skill→default.
- **Adopt**: enforce override **in the loop harness, not agent code** (auditability); inheritance order skill > session config > default; effort caps thinking budget next-turn.
- **Skip**: prompt-engineered model swap (breaks audit) — frontmatter/loop only.

## Eval / observability / IDE / migration cluster

### eval-schema-additive (L2→L3) + eval-five-tier (L3→L4)
- **Source — Cursor** `cursor/workbench.js:9368-9380; agent-exec.js:158086-158119`: OTel **`gen_ai.usage.*`** semantic conventions (input/output/total + `cache_creation`/`cache_read`), `usage_events_display` raw→display **aggregation tier**, `total_cost_cents` + `percent_of_burst_used`.
- **Adopt**: (1) fill our additive fields using **OTel gen_ai.* keys** (we already have GEN_AI_ATTRS — align names); (2) report renders a **raw→display aggregation tier** (per-tier cost/token rollup); (3) Tier-4 compare rendered as side-by-side.
- **Skip**: Sentry tracing, burst-% (enterprise).

### work-metrics + cost surfacing (L3→L4)
- **Source — Cursor** `cursor/workbench.js:9548-9804`: turn-level cost aggregation with **cache breakdown** + cache-hit-rate; **Codex** `thread/tokenUsage/updated` event.
- **Adopt**: default sink emits a turn **cost card** (`input(+cache_read) | output | cost_usd | latency`) + inline **cache_hit_rate** + session cumulative; this is exactly the cost-cache-dashboard surface — wire work-metrics through it.

### ide-context-provider-seam (L3→L4, out-of-repo for full L4)
- **Source — Cursor** `cursor/workbench.js:241614-241643`: `injectedContext{usedCurrentFile{relativeFilePath}, usedCodebase{fileResults,codeResults}}` + `predictedContext`; **metadata-only** persisted (full contents stripped), relative paths.
- **Adopt**: (1) **dual-tier** context — `injected` (user-selected: activeFile, selection, diagnostics) vs `predicted` (AI-inferred from search); (2) inject as an **XML block**; (3) persist **metadata-only** (relativeFilePath + line-ranges, never full contents) into jsonl envelope.
- **Skip**: Lexical-editor specifics; the out-of-repo VS Code/Tauri adapter remains the L4 blocker.

### external-agent-import (L3→L4)
- **Source — Codex** `codex-desktop/main.js:16146-16241,14255`: `ImportCandidate{sourceId, sourceJsonlPath, title, contentSha256, lastActivityAtMs, projectRoot, workspaceKind, remoteMcpServerNames, detectedFiles}`; `selectSession()` predicate → `include | too-old | outside-project | ignore`; dedup by `contentSha256+projectRoot+sourceId`; skip if in import-history.
- **Adopt**: (1) canonical **JSONL transcript** + **contentSha256 dedup**; (2) `selectSession` filter (too-old/outside-project); (3) `import-history.json` to skip re-imports; (4) translators target claude-code `~/.claude` + cursor composer JSON first.
- **Skip**: DynamoDB-backed history (local file).

### run-mode-expansion-ide-daemon (L3→L4, out-of-repo for full L4)
- **Source — Cursor** `cursor/workbench.js:25365,25618,1391593,1549583,1214930-1215317; agent-exec.js:122562`: `backgroundComposer` + `aiserver.v1.AutomationsService` (trigger→filter→spawn), `persistentData`/`workspacePersistentData`, **queue + locks** for concurrent spawn, `background_shell_spawn_{args,result}`.
- **Adopt** (daemon mode): (1) automation shape `trigger(cron|git|webhook) → agentic filter → spawn → onComplete`; (2) **queue + lock** concurrency control; (3) persistent daemon-state for cron-to-cron reuse. (Cross-links ADR-0090 declarative-automation design.)
- **Skip**: VS Code view integration (we're CLI-first; expose via API/socket); full L4 still needs out-of-repo scheduler/editor host.

