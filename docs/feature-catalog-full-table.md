# Feature Catalog (fc) — 전체 등록 항목 표

> Archived snapshot. This file is not maintained against the live feature
> catalog; use `tools/feature-catalog/features/**/*.yaml` and the generated
> `docs/10.feature-catalog.md` for current inventory and activation claims.

생성: 2026-07-07 · 총 1021 feature / 13 카테고리
완성도(maturity): L1 스케치 → L2 → L3 → L4 → L5 검증완료 · status: stable/new/refined/hold · cli=CLI wiring · cfg=설정노출


## 01-agent-loop (89)

| id | title | 완성도 | status | cli | cfg |
|---|---|---|---|---|---|
| sectioned-system-prompt | 4-section system prompt + per-section cache_control breakpoints | L4 | stable | full | static |
| conversation-action-steering | ConversationAction — typed mid-turn user action oneof (5-arm) | L5 | stable | full | n-a |
| agent-loop-branch-hardening | Agent-loop branch hardening — refusal / thinking carry-over / deny-and-steer | L5 | stable | full | n-a |
| phase-ttft-readonly-trio | Phase marker + TTFT + readonly deny-steer trio | L4 | stable | full | n-a |
| tool-choice-orthogonal-gate | tool_choice forcing as an orthogonal control gate (pre-call plane) | L4 | stable | full | n-a |
| ide-context-provider-seam | IDE context provider seam (ADR-0080) | L4 | stable | full | integrated |
| effect-channel | EffectChannel — relocatable effect boundary (ADR-0093 M1 keystone) | L5 | stable | full | n-a |
| git-posture-prompt | System-prompt git posture (default fail-closed) | L4 | stable | full | static |
| cfg-fourrule-true | cfg.fourRule:true | L4 | stable | full | static |
| plan-mode-dispatch-block | Plan-mode dispatch-seam mutating block | L4 | stable | full | n-a |
| queued-follow-ups | Per-thread queued follow-ups with PausedReason | L4 | stable | full | n-a |
| safe | safe 도구 스트림 중 즉시 디스패치 | L3 | stable | full | static |
| transient-backoff-ptl-compact-maxtokens-malformed-empty | transient backoff / PTL→compact / max_tokens / malformed / empty | L3 | stable | full | static |
| verifyguard | verifyGuard: {} | L4 | stable | full | integrated |
| while | while | L3 | stable | full | static |
| refusal-stop-reason | Refusal stop_reason typed surface | L4 | stable | full | static |
| plan-queue-helper | Plan-queue — typed mid-turn follow-up primitive | L3 | new | full | n-a |
| maxturns | maxTurns | L3 | stable | full | integrated |
| precedence-rule-r3-p1 | Precedence rule (R3-P1) | L5 | stable | full | static |
| streamreset | stream_reset | L3 | stable | full | static |
| testrunner | test_runner | L5 | stable | full | static |
| mode-variant-registry | System-prompt mode-variant registry — 6-mode identity table + builder seam | L4 | new | full | integrated |
| spec-to-test-gen-devin | Devin playbook spec → bun:test fixture auto-generation | L2 | new | missing | integrated |
| completed-maxturns-aborted-error | completed\|max_turns\|aborted\|error | L3 | stable | full | n-a |
| decideverifyguard | decideVerifyGuard | L5 | stable | full | static |
| nudge-completed-read-only | nudge/completed 전 디스패치된 read-only 결과 폐기 | L3 | stable | full | n-a |
| src-agent-closeout-guard-ts | src/agent/closeout-guard.ts | L4 | stable | full | static |
| quantaverifyguard | QUANTA_VERIFY_GUARD | L4 | stable | full | integrated |
| tool-describe-steering-and-prompt-fewshots | bash/edit/write describe steering + when-not-to-use + 2 few-shot examples (ADR-0410) | L4 | new | full | n-a |
| subagent-model-override | Per-subagent model / role / effort override | L4 | new | full | partial |
| mid-turn-steering | Mid-turn steering + NonSteerableTurnKind + 8 closed rejection reasons | L4 | stable | full | n-a |
| plan-exit-three-way | Plan 모드 3-way exit (approve / reject / request-changes) | L4 | refined | full | static |
| submission-op-envelope | Submission op envelope (6-variant) + legacy messages→Submission adapter | L4 | stable | full | n-a |
| stop-category-matrix | StopCategory matrix (3-layer kind/reasonCode/hint) + AgentOutcome.stopCategory | L5 | stable | full | static |
| tool-failure-exploration-ladder | Tool-failure ladder + multi-step exploration prompt rules | L4 | stable | full | static |
| prompt-template-sota-plus-plus | Prompt template SOTA++ — 4 strengthening sections (Codex/Claude parity) | L4 | stable | full | static |
| persona-slot | Persona slot — Codex {{ personality }} Handlebars absorption | L5 | stable | full | integrated |
| turn-session-state-bundles | TurnSession / TurnState parameter bundles (R2-B P1, 20→3 args) | L4 | stable | full | static |
| guard-chain | GuardChain — verify + closeout turn-exit guards unified pipeline | L5 | stable | full | n-a |
| create-stream-dispatcher | createStreamDispatcher factory (P3, byte-identical extraction) | L4 | stable | full | n-a |
| agent-dispatch-core | dispatch core — tool-call seam (admissibility + result shaping) | L5 | new | full | static |
| agent-dispatch-seam-guard | checkDispatchAllowed — pure dispatch-seam mutating-tool guard (ADR-0036) | L4 | new | full | n-a |
| agent-features-tier1 | Tier-1 builders → per-subsystem composer (9 builders SRP split) | L4 | new | full | static |
| agent-nickname-pool-role-enum | Codex agent nickname pool (39) + agent_role 4-arm enum | L2 | new | missing | integrated |
| agent-types-split | types.ts cohesion split (4 sub-modules, byte-identical) | L4 | new | full | static |
| awf-tool-matcher | AWF 2-matcher PreToolUse hook | L4 | stable | full | static |
| branch-search-progress | Branch-search Shadow-ODB anchor + pure progress formatter (ADR-0116) | L4 | stable | full | n-a |
| cap-enforcer | Cap-as-instruction enforcer — 3rd-channel NextAction adherence | L4 | refined | full | integrated |
| cli-repl-solid-split | CLI REPL GodClass → SOLID split (abandoned in-place; orphan tree pruned) | L2 | hold | full | n-a |
| cli-turn-indicator | CLI turn-indicator — spinner + elapsed + live token counter | L4 | new | full | integrated |
| closeout-critic-gate | Optional second-opinion critic at turn closeout (advisory, never blocks) | L3 | stable | full | integrated |
| compaction-breaker | Compaction circuit breaker — rapid-refill + consecutive-failure guard | L4 | stable | full | static |
| control-request-surface | control-request runtime surface — set_model/permission_mode/thinking/get_context_usage (ADR-0496) | L3 | new | missing | integrated |
| cross-subagent-todo-readback | Cross-subagent todo readback (Roo bidirectional extension) | L3 | stable | missing | n-a |
| dispatch-dedup | Pre-flight dispatch dedup gate (T3 SOTA++ verify-loop stuck fix) | L5 | stable | full | static |
| dispatch-guard-wiring | ADR-0229 DispatchGuard — 3-detector pre-flight composer (gitWriteProtect/branchOnly/hostAllowed) | L2 | new | full | integrated |
| effort-5-tier | Effort 5-tier session dimension | L4 | stable | full | static |
| error-routing-16-variant | ADR-0217 Typed error enum 16-variant + 5-action retry router (Codex) | L2 | new | full | integrated |
| identity-mode-variant | ADR-0198 Identity slot — per-mode system prompt identity lines | L2 | stable | full | integrated |
| idle-monitor-snooze | idle-monitor — 60s suppress + 5min snooze + 20-deny auto-exit (Cursor 3.2) | L4 | new | full | integrated |
| inline-trigger-wiring | Inline-trigger watcher — Aider-style source-comment dispatch primitive | L3 | new | missing | static |
| prompt-directive-bundle | §5 prompt-level directive bundle — seven DEFAULT-OFF behavioral directives | L4 | refined | full | integrated |
| lane-manager-parallel | Parallel lane-manager — N child-agent lanes with allSettled aggregation (ADR-0285) | L3 | new | missing | planned |
| assistant-language-auto-detect | 어시스턴트 언어 자동감지 — respond-in-<lang> notice (N1, absorb:cursor whichlang) | L2 | stable | full | integrated |
| n-phase-hitl | N-phase HITL state machine (plan-exit-flow 일반화) | L3 | new | missing | static |
| plan-exit-flow | Plan-exit flow orchestrator (ADR-0062 wire-up) | L4 | stable | full | static |
| plan-queue | Plan-queue — mid-turn user input capture/replay (Codex absorption) | L4 | stable | full | n-a |
| plan-writeback-bidirectional | Plan-writeback — bidirectional skill ↔ plan sync (ADR-0259) | L2 | new | missing | n-a |
| playbook-nesting | Playbook nesting — bounded recursive call chain with cycle detection — ADR-0258 | L4 | new | full | integrated |
| plugin-app-resolver-folder-git | @folder + @git mention resolvers (§10.3 Cursor parity) | L3 | new | partial | integrated |
| prompt-history-multiline | prompt history + reverse-i-search + heredoc multiline | L4 | new | full | integrated |
| prompt-rules-mode-dispatch | Prompt-rules per-mode pack registry + mode dispatch | L3 | stable | full | n-a |
| refusal-fallback-recovery | Model-refusal recovery (fork/neutralize + re-prompt) | L3 | new | full | static |
| refusal-stop-reason-branching | ADR-0242 stop_reason 8-arm typed router (Cursor 3.2.16) — surface/abort/hitl/continue | L2 | new | full | integrated |
| response-in-progress | response.in_progress streaming event | L4 | stable | full | static |
| side-conv-dispatch-router | dispatchSideConversation — external request/response router seam | L4 | stable | full | static |
| side-conv-prompt-byte-identical | Side-conversation prompt — Codex base + delimiter + quanta addendum | L4 | stable | full | integrated |
| side-conversation-seam | Side-conversation read-only sub-thread seam | L4 | stable | full | integrated |
| spawn-batch-tool | spawn_batch — structured subagent fan-out (one templated child per item) | L3 | stable | full | integrated |
| streaming-boomerang | streaming-boomerang — Roo Boomerang async-iterator progressive consumption (ADR-0251) | L3 | new | missing | integrated |
| streaming-cancellation-primitive | Streaming-cancellation controller — typed cancel-cause + AbortSignal round-trip (ADR-0183, built-not-wired) | L2 | new | missing | planned |
| subagent-agent-type | Typed subagent agentType — closed-set SSOT + boundary classifier (§4.4) | L3 | new | full | integrated |
| subagent-fs-ownership-enforce | Subagent FS owned/forbidden ENFORCEMENT — hard path fence at the write seam (§20.4) | L4 | new | full | integrated |
| subagent-introspect-tools | list_agents + followup_task — subagent introspection (enumerate + deliver-and-trigger) | L3 | stable | full | integrated |
| subagent-multi-agent-bounds | Subagent bounds — tool namespace / wait-timeout clamp / concurrency cap | L3 | new | full | partial |
| subagent-resume-replay | Subagent resume/replay — idempotent re-drive of interrupted child handles (built-not-wired) | L2 | new | missing | planned |
| subagent-role-identity | Named-agent role identity — role-specialized system prompt + .quanta/agents runtime loader | L4 | new | full | partial |
| template-literal-windsurf | Template-literal `{{ variable }}` expander — Windsurf workflow parity (sibling to ADR-0203 !macro) | L2 | new | missing | static |
| thread-tools-dynamic | ADR-0206 Per-thread dynamic tools + defer_loading | L2 | new | full | integrated |

## 02-tool-system (134)

| id | title | 완성도 | status | cli | cfg |
|---|---|---|---|---|---|
| rules-matcher | Prefix-rule matcher — longest-prefix-match + ASCII-space word boundary | L4 | stable | full | static |
| git-mutating-tools | git_commit + git_branch_switch — 1급 mutating git tools with WIP checkpoint | L4 | stable | full | static |
| tool-output-schema-factory | defineTool — output-schema + toModelOutput + deferred + streaming-input | L4 | stable | full | n-a |
| shell-output-delta-streaming | shell_output_delta — typed event stream for long-running shell exec | L4 | stable | full | integrated |
| multimodal-image-input | Multi-modal 이미지 입력 (dual-provider) | L4 | stable | full | static |
| codemodcloseoutreminder | CODE_MOD_CLOSEOUT_REMINDER | L4 | stable | full | n-a |
| edit | edit | L4 | stable | full | n-a |
| evidence-toolresultevidence | evidence?: ToolResultEvidence | L5 | stable | full | n-a |
| gitdiff | git_diff | L4 | stable | full | integrated |
| isconcurrencysafe | isConcurrencySafe | L3 | stable | full | n-a |
| isregex-true | isRegex:true | L4 | stable | full | static |
| persisted-output | <persisted-output> | L3 | stable | full | n-a |
| promise-race | Promise.race | L5 | stable | full | static |
| read-write-edit | read/write/edit (primitive tool family umbrella) | L5 | stable | full | n-a |
| gh-pr-blame | gh_pr_blame — PR review-thread blame | L3 | stable | full | n-a |
| gh-pr-typed-ops | gh_pr_review_diff / gh_pr_auto_merge / gh_pr_create.draft | L4 | stable | full | static |
| read-image | read_image tool + ToolResult.images field + composer helper | L4 | stable | full | static |
| pdf-read-tool | pdf_read — native Anthropic document-block attachment (ADR-0137) | L4 | new | full | static |
| xlsx-read-stub | xlsx_read + docx_read — real pure-TS OOXML readers (ADR-0137 / ADR-0138) | L4 | stable | full | integrated |
| yaml-read-tool | yaml_read — pure-TS YAML document reader (ADR-0137) | L4 | new | full | static |
| lsp-expansion-4-tools | LSP 4-tool expansion — code-action / rename-apply / format / signature-help | L4 | new | full | n-a |
| wire-finalization | Wire finalization — web-search env factory + document-tools default registration (ADR-0142) | L4 | new | full | integrated |
| lsp-real-adapters | LSP default-adapter real wire — code-action / format / signature-help / applyWorkspaceEdit (ADR-0143) | L4 | new | full | n-a |
| document-tools-csv-ndjson | csv_read + ndjson_read — text-format structured-data tools (ADR-0133) | L4 | new | full | static |
| web-search-providers | Web search provider impls — Brave primary + DuckDuckGo fallback (ADR-0133) | L2 | new | full | n-a |
| cr2-fu3-exhaustiveness-gate | CR2 + FU3 exhaustiveness gate | L4 | stable | full | n-a |
| git-init | git init | L4 | stable | full | n-a |
| quantatooloutputmax | QUANTA_TOOL_OUTPUT_MAX | L3 | stable | full | integrated |
| zod-toolresult | zod 입력검증 → 회복가능 tool_result | L3 | stable | full | n-a |
| voice-input-stt-slice | /voice slash — handle-based recorder + multi-vendor transcriber ports | L3 | new | full | static |
| shell-snapshot-production-spawner | Shell-snapshot — production Bun spawner + size-budget prune + CLI opt-in | L3 | stable | full | integrated |
| deferred-result-registry-production | Production DeferredResultRegistry — registry-managed deferred work (ADR-0286) | L4 | new | full | integrated |
| async-tool-kind-poll-deferred | Async tool kind + poll_deferred — defineToolAsync + LLM probe (ADR-0287) | L4 | new | full | integrated |
| async-shell-background | bash — timeout_behavior=background + bash_await + bash_kill (ADR-0296) | L3 | stable | full | integrated |
| spill-evidence-fulllogpath-round-5 | Spill → `evidence.fullLogPath` 라우팅 (Round 5) | L3 | stable | full | n-a |
| toolcontext-depth | ToolContext.depth | L3 | stable | full | n-a |
| atomic-write-and-hash-precondition | storage atomic write + edit expected_hash stale-precondition (ADR-0398) | L4 | new | full | integrated |
| apply-patch-v4a | apply_patch V4A 그래머 + deterministic 2-tier fuzzy | L4 | stable | full | n-a |
| bash-output-cap-delegation | bash head-only 30K truncation 제거 → registry capToolOutput head+tail 위임 (ADR-0411) | L4 | new | full | n-a |
| browser-automation | Browser automation tools (headless CDP, ADR-0427) | L2 | new | full | integrated |
| realtime-voice-session | ADR-0442 Realtime voice session — live bidirectional spoken dialog | L2 | refined | full | partial |
| ipynb-cell-read | read renders .ipynb cell-by-cell, base64 image outputs stripped (ADR-0481) | L4 | new | full | integrated |
| git-budget | GitBudget — 5-knob wall-time / commit-count / output-size cap (ADR-0107) | L2 | hold | full | static |
| gh-cli-tool-slice | gh — 6-tool GitHub CLI slice (ci-bot mode + PR/issue read & write) | L4 | new | full | n-a |
| web-fetch-search | web_fetch + web_search — HTTPS read-only + provider-gated search (ADR-0127) | L4 | new | full | static |
| request-user-input-tool | request_user_input — model-driven HITL question with typed outcome (ADR-0097) | L4 | new | full | n-a |
| request-plan-exit-tool | request_plan_exit — model-driven plan-mode exit with 3-way outcome (ADR-0086) | L4 | stable | full | n-a |
| scripted-replace-tool | scripted_replace — duplicated / bulk substitution sibling of edit | L4 | stable | full | static |
| tool-registry | ToolRegistry — schema + isReadOnly + output-schema + spill capping | L4 | stable | full | integrated |
| grep-tool | grep — jailed ripgrep search with 200-row cap + narrow/broaden hint | L4 | stable | full | static |
| glob-tool | glob — Bun.Glob file enumeration with jailed base + 300-cap | L4 | stable | full | integrated |
| bash-tool-hitl-tier | bash — sandbox-driven HITL (ADR-0297, command-string heuristic removed) | L4 | stable | full | integrated |
| edit-fuzzy-ladder | applyFuzzyEdit — 3-rung exact→whitespace-flexible→anchored-trim ladder | L4 | stable | full | n-a |
| git-runner-cancellation-signal | git runner — AbortSignal propagation kills spawned git on cancel | L4 | stable | full | n-a |
| gh-arg-injection-guard | gh tools — `normalizeRef` leading-dash defense (positional PR/issue ID) | L4 | stable | full | n-a |
| test-runner-tool | test_runner — bun→npm→pytest auto-detect + heuristic verdict | L4 | stable | full | static |
| diagnostics-tool | diagnostics — provider-injected LSP front + graceful null degrade | L4 | stable | full | static |
| git-shared-discriminated-outcome | git `_shared.ts` — safeRun / mutate discriminated outcome boundary | L4 | stable | full | static |
| git-branch-name-schema-guard | git_branch_switch — `BRANCH_NAME_RE` schema-level alphabet guard | L4 | stable | full | static |
| lsp-nav-tool-slice | lsp_nav — 8 navigation tools (def/refs/hover/type-def/impl/symbols/rename-preview) | L4 | stable | full | n-a |
| localize-tool | localize — Stage-2 ranked fault-localization with FrameTier + JS-sibling penalty | L4 | stable | full | integrated |
| file-tree-summary | file_tree_summary — Stage-1 fault-localization (repo 구조) | L4 | stable | full | n-a |
| parse-test-failure | parse_test_failure — Stage-3 fault-localization (로그 파싱) | L4 | stable | full | n-a |
| git-churn | git_churn — 파일 변경빈도 핫스팟 (fault-localization 신호) | L4 | stable | full | n-a |
| git-blame-heatmap | git_blame_heatmap — per-author 라인 소유권 분포 | L4 | stable | full | n-a |
| git-log-us-separator | git_log — US-separator () format + textconv determinism | L4 | stable | full | n-a |
| update-working-state | update_working_state — per-task 스크래치패드 메타도구 (Codex memory L3) | L4 | stable | full | n-a |
| tool-search | ToolSearch — deferred-tool catalog ranked search + select:<name> lookup | L4 | new | full | static |
| mcp-client-jsonrpc | McpClient — line-framed JSON-RPC 2.0 + typed McpError + output cap | L4 | stable | full | static |
| git-upstream-check | git_upstream_check — upstream 분기 감지 (read-only) | L4 | stable | full | integrated |
| typed-tool-failure-modes | ToolFailure discriminated union — 6-mode typed per-failure-mode results | L5 | stable | full | static |
| shadow-tools-trio | shadow_{snapshots,rewind,restore_partial} — first-class shadow-ODB tools | L4 | new | full | n-a |
| git-conflict-inspect | git_conflict_inspect — structured merge-conflict surface tool | L4 | new | full | n-a |
| git-review-diff | git_review_diff — isolated reviewer-subagent over base...head diff | L4 | stable | full | static |
| subagent-bg-tools-trio | subagent_{fork,poll,await} — background subagent tool trio (ADR-0130) | L4 | new | full | n-a |
| git-moved-code-tool | git_moved_code — classifier surface (rename / move / split / merge) | L4 | new | full | n-a |
| deferred-tool-registry | DeferredResultRegistry — typed deferred-tool-result seam | L4 | new | full | n-a |
| git-runner-env-determinism | git runner — env-allowlist + deterministic overrides + bounded wall-clock | L4 | stable | full | static |
| pptx-authoring | pptx_write / pptx_read tools — generate + read real .pptx (PresentationML, H14 follow-up) | L3 | new | full | integrated |
| image-gen | image_gen tool — text→image generation + edit (NEW binary-generation category) | L3 | new | full | integrated |
| office-authoring | xlsx_write / docx_write tools — generate real .xlsx / .docx (NEW Office-authoring category) | L3 | new | full | integrated |
| projects-kb | projects_kb — context-offloading knowledge-base tool (A3) | L2 | new | full | integrated |
| advisor-consult-tool | Advisor consult tool (second opinion from a stronger model) | L3 | stable | full | integrated |
| apply-patch-structured-result | applyPatchStructured — per-file outcome + messageForModel (self-correcting edits) | L2 | new | full | planned |
| ask-user-elicitation | ask_user — generalized structured elicitation tool (ADR-0494) | L4 | new | full | integrated |
| ast-grep-tool | ast_grep — structural AST code search via ast-grep CLI (QUANTA_AST_GREP, default-OFF) | L3 | new | full | partial |
| artifact-canvas-store | Canvas / artifact persistence store (C1 — non-code generation outputs) | L3 | new | full | integrated |
| communicate-update | CommunicateUpdate — structured mid-turn progress report (C2) | L3 | new | full | integrated |
| ci-finding | ci_finding — structured CI-investigation finding store + tool (§7.3 long-tail) (ADR-0515) | L3 | new | partial | integrated |
| cli-slash-capabilities | CLI `/capabilities` (alias `/caps`) — capability-layer operator view | L2 | new | full | static |
| cli-slash-knobs-live-control | CLI `/knobs` live-control + knob governance (unified catalog + session override + redaction) | L2 | new | full | integrated |
| code-mode-js-runtime | code_cell — JS-runtime tool-calling (code-mode, Phase 1-3, RFC jun-6-code-mode) | L3 | refined | full | integrated |
| collect-evidence | collect_evidence — Evidence Packet Builder (keystone; fuse failure+static+runtime+repo) | L3 | stable | full | integrated |
| commit-pr-authoring | Commit + PR authoring tools (diff→prose, git_compose_commit / git_compose_pr) | L3 | stable | full | integrated |
| conflict-parser-lib | parseConflicts — pure git merge-conflict parser library (ADR-0111) | L4 | stable | full | n-a |
| debug-inspect | debug_inspect — DAP debugger tool (run under adapter, stop at breakpoint, report stack+vars) (W5) | L3 | stable | full | integrated |
| document-image-fsjail-unify | document/image readers — unified FsJail chokepoint via resolveJailedDoc | L4 | new | full | integrated |
| edit-fuzzy-scored-recovery | Edit fuzzy matcher: scored-candidate recovery on ambiguity | L3 | stable | full | integrated |
| edit-line-ranges-scoped-match | Edit line_ranges — scope a repeated anchor by 1-indexed line window (H12) | L4 | stable | full | n-a |
| file-history-rewind | Per-file session snapshot list/restore (file_history_rewind — Claude tengu parity) | L3 | new | full | integrated |
| appshot-verify-loop | appshot_verify — closed spec→scaffold→render→screenshot→judge verify loop (G1, Phase 1) | L3 | refined | full | integrated |
| gh-pr-code-tour | gh_pr_code_tour — guided PR-diff walkthrough (ordered tour stops) | L3 | new | partial | integrated |
| gh-pr-edit-labels | gh_pr_edit_labels — add / remove PR labels | L4 | stable | full | integrated |
| gh-pr-open-author-and-ship | gh_pr_open — author + open a PR in one step | L3 | stable | full | integrated |
| gh-pr-resolve-thread | gh_pr_resolve_thread — resolve review threads + concurrent-push rebase | L4 | stable | full | integrated |
| git-co-change | git_co_change — co-change / related-files 신호 (change-impact, §7.2 long-tail) | L4 | new | full | integrated |
| git-diff-scope-inference | Diff-derived Conventional Commits scope inference | L3 | stable | full | integrated |
| git-read-trio | git_blame / git_diff / git_status — read-only git tools | L4 | stable | full | static |
| glob-gitignore-mtime | glob — ripgrep enumeration (.gitignore-aware + mtime-DESC ordering) | L4 | stable | full | integrated |
| grep-rg-flags | grep ripgrep flag surface (context / output_mode / -i / multiline / type) | L4 | stable | full | static |
| image-downsample | read_image downsample codec port — over-cap images shrink instead of reject (ADR-0507) | L4 | new | full | integrated |
| image-vision-tools | read_image + read_image_url + compose helper — vision pipeline | L4 | stable | full | static |
| jun7-search-codebase-scope | search_codebase `scope` directory filter (§21.5) | L4 | new | full | static |
| jun7-skill-args-template | Skill `$ARGUMENTS` / `$N` argument templating (§22.2) | L4 | new | full | n-a |
| lsp-call-hierarchy | LSP call hierarchy — lsp_incoming_calls / lsp_outgoing_calls (RFC jun-6) | L4 | new | full | integrated |
| mcp-server-reverse | Reverse-MCP — expose quanta AS an MCP server over stdio (TICKET-19, ADR-0520) | L2 | new | full | integrated |
| node-repl-persistent-kernel | Node REPL persistent kernel — Jupyter-style per-session node process | L2 | new | missing | static |
| notebook-edit-cell-tool | notebook_edit — cell-level .ipynb editor (W6, NotebookEdit P17 해소) | L2 | stable | full | integrated |
| patch-filesystem-port | PatchFileSystemPort — apply_patch FS abstraction (pure applier) | L4 | stable | full | n-a |
| per-hunk-diff-accept-reject | per-hunk diff accept/reject — interactive [h]unk-select + atomic partial-apply (T05) | L4 | new | full | integrated |
| radar-cards-proposal-queue | ADR-0231 Radar Cards — background proposal queue MVP (Claude CoworkRadar) | L4 | stable | full | integrated |
| read-binary-device-guard | read B5 device + binary guard — reject FIFO / device files + NUL-byte binaries before reading | L4 | stable | full | integrated |
| read-file-unchanged-dedup | read file_unchanged dedup short-circuit (H9) — skip re-sending identical content | L2 | new | full | partial |
| realtime-websocket-codex | ADR-0230 Realtime WebSocket — 8-method port (Codex streaming) | L4 | stable | full | integrated |
| reflect-self-correction | reflect — mid-turn self-critique with a forcing-function next_steps (ADR-0504) | L3 | new | full | integrated |
| run-tests | run_tests — structured multi-language test runner (detect + run + normalized evidence) | L3 | stable | full | integrated |
| run-workflow | run_workflow — declarative multi-agent workflow engine (§25.1) | L3 | new | full | integrated |
| session-config-tool | session_config — agent reads/sets its own SDK posture (effort tier, mode, profile, model) | L3 | new | full | integrated |
| shadow-odb-port | ShadowOdb closed port + LRU eviction utility (ADR-0108) | L4 | new | full | n-a |
| spawn-agents-on-csv | spawn_agents_on_csv — agent-callable CSV batch fan-out (capped, durable, resumable) (ADR-0510) | L4 | new | full | integrated |
| stale-read-guard | Stale-read guard — block clobbering edits + post-bash re-read reminder | L3 | refined | full | partial |
| tool-interrupt-block | block-interrupt critical section — defer ESC across a tools atomic FS-mutating window (jun-6) | L3 | new | full | integrated |
| tool-surface-manifest | Tool-surface manifest — SSOT for the LLM tool-access axis (gate + per-surface default) | L3 | new | full | integrated |
| worktree-tool | git-worktree agent tools — session slot + relative-cwd edit-fence (ticket-11 P8, CC EnterWorktree 흡수) | L2 | new | full | partial |

## 03-permission-safety (93)

| id | title | 완성도 | status | cli | cfg |
|---|---|---|---|---|---|
| trust-scope-wire-up | Trust-scope registry wire-up (Phase C) — persistent grant memory ask-skip | L2 | stable | full | integrated |
| permission-remember-patterns | rememberPatterns — 권한 패턴 학습 + cascade 자동해소 | L4 | refined | full | integrated |
| deny-and-steer-verb | ConfirmDecision deny_and_steer verb — typed third option with steer injection | L4 | stable | full | static |
| readonly-deny-steer-note | Readonly deny-steer note — admissibility isReadonly flag appended to steer message | L4 | stable | full | static |
| git-write-protection | git-write-protection 정적 deny (.git/{hooks,config} + .vscode) | L4 | stable | full | static |
| default-acceptedits-bypass-auto | default\|acceptEdits\|bypass\|auto | L3 | stable | full | integrated |
| e2e | e2e | L4 | stable | full | integrated |
| fsjailerror | FsJailError | L4 | stable | full | integrated |
| git-c | git -c | L3 | stable | full | static |
| hitltier-hand-off-required-always-confirm-pre-approval-ok-no | HITLTier = hand-off-required \| always-confirm \| pre-approval-ok \| none | L4 | stable | full | integrated |
| localsandbox | LocalSandbox | L4 | stable | full | static |
| mode-posture-hitl-4-tier-permission-policy-harddeny-redundan | mode-posture → HITL 4-tier → permission policy (HARD_DENY redundant guard) → pre | L5 | stable | full | integrated |
| verbatim | verbatim 위협프롬프트 | L3 | stable | full | static |
| secret-detection-scanner | Secret-detection scanner — pattern + entropy + composite | L3 | stable | full | integrated |
| pii-redaction-scanner | PII-redaction scanner — port + pattern + Luhn + composite | L3 | stable | full | integrated |
| 183-safety-net-green | 단언 단위 + 183 통합 safety net 그대로 green | L4 | stable | full | static |
| cr3-rule-catalog-ssot-fu1-rule-per-concern-invert | CR3 rule-catalog SSOT + FU1 rule-per-concern invert | L5 | stable | full | static |
| dockersandbox | DockerSandbox | L4 | stable | full | static |
| harddeny-readonly-short-circuit | HARD_DENY 선행 / readonly short-circuit | L3 | stable | full | static |
| infertooltier-secure-by-default-fallback | `inferToolTier` secure-by-default fallback | L5 | stable | full | integrated |
| per-tool-checkpoint-granularity | Per-tool / per-skill checkpoint granularity (ADR-0209) | L3 | new | full | integrated |
| three-way-restore | 3-way restore — Files Only / Task Only / Both (ADR-0210) | L3 | new | full | integrated |
| tool-profile-preset | Tool profile preset — 4 named bundles (write/ask/minimal/code-only) + UP-nudge composition | L4 | new | full | integrated |
| shell-snapshot-runshell-wire | Shell-snapshot runShell wire — opt-in source-fold (ADR-0235) | L3 | new | full | integrated |
| bash-mode-per-call-sandbox | bash `mode` + per-call OS sandbox wrap (ADR-0295) | L3 | new | full | integrated |
| prefix-rule-dsl | Prefix-rule allowlist DSL + 3-layer (project > user > system) + default-deny opt-in | L4 | stable | full | static |
| reviewer-3tier | Reviewer 3-tier (user/auto_review/guardian_subagent) + 8-state outcome | L4 | stable | full | static |
| permission-profile-inheritance | Permission-profile inheritance — extends + cycle detection + monotone-narrowing merge + Managed ceiling | L3 | refined | full | integrated |
| windows-sandbox-backend | ADR-0441 Windows OS-sandbox backend (pure compiler + native boundary) | L2 | stable | full | partial |
| local-environments | local-environment selection — DECLARED per-project dev env composed over the allowlist | L3 | stable | full | static |
| guardian-per-action-assessment | Guardian per-action TYPED assessment — binary verdict → discriminated ActionAssessment (collapse boundary) | L2 | hold | full | integrated |
| central-config-project-trust | Central on-disk config loader + per-project trust gate | L4 | new | full | integrated |
| review-kind-matrix | ReviewKind × isExecutionBlocking × reason_code matrix + scoped-allowlist verbs | L4 | stable | full | integrated |
| permission-policy-engine | permission policy — HARD_DENY engine + tier inference + reviewer composition | L4 | stable | full | static |
| permission-store-json | permission state store — atomic JSON-state-file persistence engine (ADR-0046) | L4 | stable | full | integrated |
| git-destructive-hard-deny | Destructive git HARD_DENY rules (workflow + push mass-delete) | L4 | stable | full | static |
| trust-scope-store-persistent | trust-scope persistent grant store — cascade + TTL (L3→L4 promotion) | L2 | stable | full | integrated |
| branch-only-guard | branch-only git-write guard — ci-bot mode protected-branch propositional check | L4 | stable | full | static |
| gate-pattern-wire | pattern-grant auto-pass — admissibility-gate cascade (ADR-0061 wire-up) | L4 | stable | full | integrated |
| negative-invariants-doc-ssot | ADR-0044 negative invariants — single doc SSOT for 12 deliberately-not-absorbed patterns | L2 | stable | na | integrated |
| migration-importer-credential-read-ban | External-agent importer — N10 credential-read ban (auth.json never opened) | L4 | stable | full | static |
| recorder-fail-open-permission-verdict | Permission recorder — observability fail-open invariant (verdict cannot be flipped by emitter throw) | L2 | stable | full | static |
| landlock-phase2 | Linux Landlock Phase 2 (bubblewrap) | L3 | stable | full | partial |
| agent-requested-rules | agent-requested rules — description-only rule fetch-on-demand matcher (ADR-0509) | L4 | new | full | integrated |
| argv-token-prefix-matcher | argv tokenizer + array-literal parser + token-prefix matcher (Codex prefix_rule parity) | L3 | new | full | static |
| auto-approval-reviewer | AutoApprovalReview (periodic are these auto-grants still OK? prompt) | L4 | new | full | static |
| auto-mode-classifier | LLM-backed permission auto-mode 2-stage ClassifierPort | L4 | new | full | integrated |
| auto-mode-rule-overlay | jun-7 auto-mode user-rule overlay (4-category $defaults splice + untrusted-source fence) | L3 | new | full | integrated |
| bridge-attestation | Bridge Attestation — remote permission preflight + STS token (ADR-0246) | L3 | stable | missing | integrated |
| circumvention-detector | jun-7 tool-switch circumvention detector (denied-effect memory, advisory-first) | L3 | new | full | integrated |
| config-provenance-gate | Config-provenance gate — repo-controllable config may only NARROW, never widen | L3 | refined | full | partial |
| decision-emit-phase2-admissibility | `decision` event emit Phase 2 — admissibility-gate (permission/rule/hook) wire (ADR-0267) | L4 | stable | full | partial |
| decision-emit-phase3-cap-jail-budget | `decision` event emit Phase 3 — cap / jail / budget 게이트 wire (ADR-0269) | L4 | stable | full | partial |
| disclaimer-shell-wrapper | Disclaimer shell wrapper | L4 | stable | full | static |
| errors-helper-fix | errMessage infinite-recursion fix + guard comment (regression-pinned) | L4 | refined | full | integrated |
| glob-dp-matcher | ReDoS-hardened glob DP matcher (skill activation + Cursor rule paths) | L4 | stable | full | static |
| guarded-spawn | RAII child-process lifecycle guard (runShell / sandbox 공통) | L4 | stable | full | integrated |
| hitl-4-tier-gate | HITL 4-tier gate registry + handoff event seam (ADR-0047) | L5 | stable | full | integrated |
| deny-reason-surfacing | C6 — structured deny-reason surfacing (layer/pillar, sanitized-by-construction) | L4 | new | full | integrated |
| exfil-glob-write-guard | jun-6 exfil-rail (b) — glob-in-write guard (write/edit reject glob path) | L3 | new | full | integrated |
| exfil-scouting-detector | jun-6 exfil-rail (c) — exfil-scouting sequence detector + taxonomy line | L3 | new | full | integrated |
| exfil-write-budget | jun-6 exfil-rail (a) — per-turn write/edit-count budget (untrusted-gated drip-exfil guard) | L3 | new | full | integrated |
| sandbox-escalation | jun-6 sandbox-block → escalation-retry loop (denialReason:sandbox-blocked + HITL escape hatch) | L3 | refined | full | integrated |
| secret-aware-egress | jun-6 exfil-rail (B) — secret-aware egress (plaintext-HTTP body/header scan; HTTPS opaque) | L3 | new | full | integrated |
| tls-mitm-egress | jun-7 TLS-MITM egress — HTTPS body/header secret scanning (Phase-2 of exfil-rail (B)) | L3 | new | full | integrated |
| jwks-agent-identity | JWKS agent identity — remote JWK fetch + cache + verify (ADR-0248) | L2 | new | missing | integrated |
| layered-policy-merge | Layered permission-policy merge (per-user / per-repo / team-admin) | L3 | new | full | integrated |
| llm-not-implemented-kind | LLMErrorKind.not_implemented (chatgpt-oauth Phase-1 fallback-eligible) | L4 | new | full | static |
| localize-phase-guard | Localize-phase guard — Agentless localize-first dispatch gate | L4 | stable | full | integrated |
| mutating-tool-table-coverage | MUTATING_TOOL_TABLE drift closeout (12 caller-wire tools + agent.isReadOnly fix) | L4 | stable | full | integrated |
| named-permission-profiles | Named permission-profile registry + by-name resolution | L3 | new | full | integrated |
| network-egress-proxy | Socket-level egress proxy — close the subprocess egress bypass | L3 | new | full | integrated |
| os-sandbox-wire | OS Sandbox wire-up — bash spawn wrapped by Seatbelt/Landlock policy | L4 | new | full | integrated |
| pdp-security-floor-decider | PDP security-floor decider — capability-driven universal always-confirm (jun-10 P2-T3) | L4 | new | full | integrated |
| per-host-agent-mode | 호스트별 기본 agent-mode (agent-mode-by-host-id 동등물) | L4 | stable | full | integrated |
| per-thread-permissions | 스레드별 권한 (heartbeat-thread-permissions-by-id 동등물) | L4 | stable | full | integrated |
| permission-4-pillar | 4-pillar Permission (approval / network / sandbox / control) | L4 | new | full | static |
| permission-hook-ordering | Permission stack × pre_tool_use hook ordering lock (13-step canonical pipeline) | L4 | stable | full | integrated |
| permission-inspect-5axis | 5-axis permission inspector (stateless, slash-facade) | L4 | new | full | integrated |
| permission-inspector | Permission stack inspector (ADR-0046 follow-up) | L4 | new | full | integrated |
| permission-profile-2-layer | PermissionProfile + file_system_sandbox_policy 2-layer (AND condition) | L4 | new | full | static |
| permission-profile-list-select | PermissionProfile List + Select + user-defined profiles from disk | L3 | stable | full | integrated |
| permission-scope-4-tier | PermissionScope 4-tier (managed > project > user > open) | L4 | new | full | static |
| platform-base-shell-argv | Platform-aware base shell argv — POSIX-first discovery ladder + dialect (P16 → ADR-0529) | L3 | new | full | integrated |
| post-denial-precedence | post-denial 사용자 override (guardian-post-denial-precedence 동등물) | L4 | stable | full | integrated |
| proxy-header-rewrite | ticket-13 (§12.2) outbound header-rewrite — operator transform + forbidden-inject/forbidden-framing guards | L2 | new | partial | partial |
| remember-patterns-dangerous-knob | Remember-patterns dangerous opt-in knob — operator lifts the dangerous-gate ONLY (no-widen holds) | L3 | new | full | integrated |
| repo-rules-tree | AGENTS.md / repo-rules tree — deeper-wins layered rule ingestion (ADR-0098) | L4 | stable | full | static |
| seatbelt-verbatim | ADR-0199 macOS Seatbelt verbatim profile + 4 strict knobs | L2 | stable | full | integrated |
| shell-snapshot | Per-turn shell environment snapshot (hermetic shell) | L2 | new | full | integrated |
| special-path-resolver | SpecialPathKind 8-kind OS-aware resolver (LRU cached) | L2 | new | full | static |
| untrusted-content-tag | Untrusted content tag-boundary defang — 단일 강제 path (embedUntrusted) | L4 | new | full | integrated |
| untrusted-source-envelope | Untrusted-source result envelope — wrap external tool output as DATA (H2) | L3 | refined | full | integrated |

## 04-context-management (77)

| id | title | 완성도 | status | cli | cfg |
|---|---|---|---|---|---|
| message-id-rewind | Message-id rewind — transcript truncate-to-message UX | L4 | stable | full | integrated |
| cache-true | cache:true | L3 | stable | full | static |
| compaction-summarizerllm | compaction.summarizerLlm | L3 | stable | full | integrated |
| compactionbreaker | CompactionBreaker | L3 | stable | full | integrated |
| loadreporules-cwd | loadRepoRules(cwd) | L4 | stable | full | static |
| mode-repo-rules-active-skills-working-state-memory-hints | mode → repo-rules → active-skills → working-state → memory-hints | L4 | stable | full | static |
| proactive | proactive | L3 | stable | full | integrated |
| source-runtime-tests-docs-memory | source/runtime > tests > docs/memory | L5 | stable | full | static |
| turncontextinput-mode-reporules-workingstate-activeskills | TurnContextInput.{mode, repoRules, workingState, activeSkills} | L4 | stable | full | static |
| plan-queue-collapse-metric | PlanQueue enqueue collapse metric — EnqueueResult + dedicated counter | L3 | stable | full | integrated |
| mid-turn-interruption | Mid-turn user interruption — capture facade over PlanQueueStore + 3-arm mode + InterruptionPolicy port | L3 | stable | full | integrated |
| cli-main-e | (CLI 순수헬퍼 직접 유닛테스트 불가 — main() 톱레벨; 루프 e | L3 | stable | full | n-a |
| reactive-fail-fast | reactive fail-fast | L3 | stable | full | integrated |
| trust-and-inputs | 강화 Trust and inputs | L3 | stable | full | static |
| conv-checkpoint-auto-record | ConvCheckpointWire — surface-side per-turn auto-record + /rewind-conv (ADR-0292) | L4 | new | full | static |
| session-export-import-slash | /session export+import slash — round-trip via ADR-0157 primitive (ADR-0294) | L3 | new | full | static |
| cargo-prune-round-5-cr1 | Cargo prune (Round 5 CR1) | L3 | stable | full | static |
| quantacompacttokens | QUANTA_COMPACT_TOKENS | L3 | stable | full | integrated |
| per-tool-granular-registry | Per-tool granular checkpoint registry — in-memory ToolSnapshot store (ADR-0300) | L3 | new | full | integrated |
| env-build-dynamic-context | env/build 동적 컨텍스트 — platform/shell/git-status/pkg-mgr (ADR-0397) | L3 | new | full | integrated |
| session-jsonl-envelope | Session JSONL envelope (5 top-level + 17+2 turn_context) (ADR-0034) | L4 | stable | full | integrated |
| verified-vs-assumed | 압축 프롬프트 verified-vs-assumed 강화 | L3 | stable | full | static |
| async-mention-resolver-and-file-symbol | Async mention resolver + @file / @symbol mention kinds (ADR-0418) | L3 | stable | full | integrated |
| codex-anti-signal-7 | Codex anti-signal 7개 흡수 | L5 | stable | full | static |
| pre-compact-hitl | PreCompactRequestQuery (HITL) | L4 | stable | full | integrated |
| active-skills-reminder-block | renderActiveSkillsBlock — catalogue + trigger-rule footer (progressive disclosure) | L4 | stable | full | static |
| background-compaction | Background (speculative) compaction — cancellable summarize + 2-phase install | L3 | refined | full | partial |
| budget-probe-ledger-wire | BudgetProbe — real wire of ADR-0138 ledger into ADR-0265 budget-aware preset (ADR-0274) | L2 | stable | missing | integrated |
| build-turn-context | buildTurnContext — system + per-turn dynamic assembly | L5 | stable | full | static |
| cli-diff-preview | CLI action diff-preview — write/edit/apply_patch/scripted_replace 통합 unified diff | L4 | new | full | integrated |
| cli-markdown-painter | CLI markdown painter — assistant stream inline highlight (line-buffer FSM) | L4 | new | full | integrated |
| codebase-indexer | Codebase indexer slice (ADR-0277) | L4 | stable | full | integrated |
| codex-r2-compaction-event-emit | Compaction event emit (proactive + reactive) — ADR-0324 / 0331 | L3 | stable | full | n-a |
| codex-r2-context-change-injection-wire | Context-change persistent injection + buildTurnContext seam (ADR-0321 / 0327 / 0329) | L3 | stable | full | n-a |
| codex-r2-loop-activation-hook | Loop hook for plugin activation + auto-wire (ADR-0346 / 0350) | L3 | stable | full | n-a |
| codex-r2-mention-injection-pipeline | Mention-injection pipeline + skill resolver + plugin activation trigger (ADR-0325 / 0330 / 0340) | L3 | stable | full | n-a |
| codex-r2-typed-event-store | Typed history event store (ADR-0320 + ADR-0335) | L3 | stable | full | n-a |
| conversation-checkpoint-store | ConversationCheckpointStore — pure in-memory messages snapshot/restore (ADR-0124) | L4 | new | full | static |
| conversation-summary-archive | ConversationSummaryArchive — sliding-window per-compaction summary log | L4 | stable | full | integrated |
| diff-hunk-headers | Unified-diff hunk headers + line-number gutters (CLI diff preview) | L3 | stable | full | partial |
| embed-batcher | EmbedBatcher — 50ms window + single-flight dedupe + provider batch_size | L2 | new | missing | integrated |
| embed-cache | EmbedCache — idempotent content-hash + model-tag embedding cache | L4 | new | full | integrated |
| eol-detect-split-join | EOL detection + EOL-aware split/join (shared SSOT for patch + edit slices) | L3 | new | full | static |
| find-boundary-orphan-safe | findBoundary — orphan-safe tool_use/tool_result pair boundary | L4 | stable | full | integrated |
| fork-session-port | ForkSessionPort — branch-name + signal + shadow-tag fork (ADR-0226) | L3 | new | full | static |
| four-section-preset-renderer | fourSectionPreset + buildSectionedSystemBlocks — pure renderer (collapse-empty) | L4 | stable | full | static |
| glob-rules | Glob-matched + always-applied auto-injected rules (Cursor .mdc parity) | L4 | stable | full | n-a |
| issue-hint-expected-actual-opt-in | extractExpectedActual — opt-in inline E/A phrase extractor | L4 | stable | full | integrated |
| issue-hint-extraction | Issue-hint extraction — Agentless-style structured signal scan | L4 | stable | full | n-a |
| delta-token-accounting | Delta token accounting — O(1) incremental estimateTokens memoization | L4 | refined | full | integrated |
| env-context-repo-map | Bounded repo-map turn-0 injection into the env block (RFC jun-6 §4) | L3 | new | full | integrated |
| lexical-search-bm25-ripgrep | LexicalSearch — BM25 + ripgrep pluggable retrieval engine (ADR-0260) | L3 | new | full | static |
| memory-summary-aggregate-coalesce | memory_summary.md → session_ctx breakpoint coalesce (ADR-0068) | L4 | stable | full | static |
| microcompact-tool-result-evict | Microcompaction — tier-1 tool-result eviction (in-place content clearing) | L3 | new | full | integrated |
| mode-notice-block | PLAN/REVIEW/AUDIT mode notice — per-turn reminder injection | L4 | stable | full | static |
| model-tag-auto-hook | ModelTag invalidator auto-hook — EmbedCache + VectorStore registrar (ADR-0273) | L3 | new | missing | integrated |
| model-tag-versioning | ModelTag versioning + invalidator + canonical codec (ADR-0266) | L3 | new | missing | integrated |
| multi-source-rules-vendor-detector | Multi-source rules vendor-detector (5-vendor convergence, ADR-0205) | L3 | stable | full | static |
| multimodal-embedding-mvp | Multi-modal embedding MVP — image + audio embedding port (ADR-0276) | L2 | new | missing | integrated |
| on-session-minted-port | onSessionMinted callback port — resume-fsm surface decoupling (DIP) | L4 | stable | full | n-a |
| pipeline-composition-root-wire | Pipeline composition-root wire — assemblePipeline(env) + search_codebase tool (ADR-0272) | L4 | stable | full | integrated |
| pluggable-embedder-store-registry | Pluggable Embedder + VectorStore provider registry (ADR-0261) | L4 | new | full | integrated |
| prompt-source-payload-widening | PromptSource / PromptPayload type widening (string \| {text, images?}) | L4 | stable | full | static |
| reactive-compaction | reactiveCompact — PTL-recovery aggressive squeeze + continuation summary | L4 | stable | full | integrated |
| real-api-smoke-eval | Real-API smoke eval for retrieval — drift detection (ADR-0275) | L2 | new | na | integrated |
| reranker-port | Reranker port — Cohere/Voyage REST adapters + identity default (ADR-0262) | L3 | new | full | integrated |
| search-pipeline-composer | SearchPipeline composer + 5 pre-built presets (ADR-0265) | L4 | stable | full | integrated |
| semantic-search-port | Semantic-search port — embedding-based retrieval seam (Cline-style) | L2 | new | full | static |
| session-envelope-encoder | Session envelope encoder/decoder — deterministic key-sorted JSONL | L4 | stable | full | n-a |
| session-git-fingerprint | Session git fingerprint capture (sha + branch + origin URL) | L4 | stable | full | n-a |
| session-protocol-codec | `@/protocol/session` — surface-agnostic session protocol (command/event/snapshot codec) | L3 | stable | full | n-a |
| session-sanitize-id | Session id sanitizer — filesystem-safe path component validator | L4 | stable | full | integrated |
| side-chat-session-isolation | SideChatManager — auxiliary conversation lifecycle with parent isolation (ADR-0244) | L3 | new | missing | static |
| syntax-aware-chunking | Syntax-aware (tree-sitter) chunking + in-file outline read (RFC jun-6) | L3 | new | full | integrated |
| task-budget-soft | Soft task-budget (model self-moderation) | L3 | stable | full | partial |
| today-date-line-clock-port | todayDateLine — injected clock port for byte-identical replay (ADR-0078) | L4 | stable | full | static |
| token-estimator-chars-quarter | estimateTokens — chars/4 heuristic with image fixed-budget | L4 | stable | full | integrated |

## 05-memory (45)

| id | title | 완성도 | status | cli | cfg |
|---|---|---|---|---|---|
| memory-citation-surface | memory_citation provenance surface (ADR-0082) | L4 | stable | full | integrated |
| durable-state-belongs-in-workspace-files | 시스템 프롬프트에 Durable state belongs in workspace files 단락 | L4 | stable | full | static |
| l3-workingstate | L3 WorkingState | L2 | stable | full | n-a |
| llm-distill | 세션종료 LLM distill | L4 | stable | full | n-a |
| memorysearch-write-update | memory_search/write/update | L4 | stable | full | n-a |
| reminder-memory-recall-routing-hints-only | 동적 reminder의 memory recall 블록에 routing hints only | L4 | stable | full | n-a |
| src-agent-working-state-ts | src/agent/working-state.ts | L4 | stable | full | integrated |
| tier | tier | L4 | stable | full | n-a |
| quantamemory-path-embed-embedmodel-recalllimit-distill-conso | QUANTA_MEMORY[_PATH/_EMBED/_EMBED_MODEL/_RECALL_LIMIT/_DISTILL/_CONSOLIDATE/_SEL | L4 | stable | full | integrated |
| snapshot-deep-copy | `snapshot()` deep-copy | L5 | stable | full | integrated |
| per-string-empty-patch-refine | Per-string 캡 + empty-patch refine | L5 | refined | full | integrated |
| semantic-index-real-embedder | semantic index 실 embedder + pluggable vector-store backend (ADR-0392, ADR-0424) | L3 | new | full | integrated |
| codex-2-phase-consolidator | Codex 2-phase memory consolidator — per-thread distill + cross-session synthesizer | L4 | stable | full | static |
| memory-learning-default-on | Memory learning default-ON via session factory (ADR-0413) | L4 | stable | full | integrated |
| auto-dream-cross-session | auto-dream — cross-session memory consolidation trigger (H16) | L3 | new | full | integrated |
| consolidator-session-hook | Session-end consolidator hook — runMemoryConsolidatorHook (no-throw L4 wire) | L4 | stable | full | integrated |
| distill-redaction-port | Consolidator distill-input redaction port — abstracted seam for Phase 1 LLM | L4 | stable | full | integrated |
| embedder-port | EmbedderPort — pluggable embedding provider seam (OpenAI / Null / Caching) | L4 | stable | full | integrated |
| memory-auto-trigger | ADR-0281 — Memory auto-trigger (session-end → phase1 → phase2 promote) | L3 | stable | full | integrated |
| memory-cross-session-inject | ADR-0282 — Cross-session memory inject (selectForInject → prompt section) | L3 | stable | full | integrated |
| memory-dedup-planner | Pure near-duplicate detection — pre-save merge/supersede candidates | L4 | stable | full | n-a |
| memory-distill-redaction-fence | Memory distill input fence — redactSecrets before LLM sees transcript | L4 | stable | full | n-a |
| memory-eviction-planner | Pure eviction planner — per-tier caps + supersede prune + ancient decay | L4 | stable | full | static |
| memory-fence-cleanup | @/memory → @/llm slice fence cleanup — dead REMOVE-ME stub deleted | L4 | stable | full | integrated |
| memory-line-citation-mode-guard | Self-edit memory line citations + per-thread mode + budget write-guard | L3 | stable | full | partial |
| memory-md-atomic-writer | MEMORY.md 3-file atomic writer + git-tracked commit (ADR-0068 Wave B) | L4 | stable | full | static |
| memory-outcome-enum | 4-state memory outcome enum (partial / success / uncertain / fail) | L4 | stable | full | n-a |
| memory-recall-citation | Memory recall citation surface in turn-summary (user-visible provenance) | L4 | new | full | integrated |
| memory-self-edit-tools | memory_search / memory_write / memory_update — self-edit tools (RFC §6.3) | L4 | stable | full | n-a |
| memory-telemetry-port | MemoryTelemetryPort — inverted-dependency seam for phase1/phase2/recall metrics | L4 | stable | full | integrated |
| memory-vector-math | Memory vector math — pure cosine / dot / normalize + Float32 serde | L4 | stable | full | integrated |
| phase1-stage1-store | Stage1Store — per-thread distill rows + consolidate_watermark (ADR-0068 Wave A) | L4 | stable | full | integrated |
| phase2-auto-trigger-wire | Phase 2 session-start auto-trigger — runMemoryPhase2AutoTrigger (non-blocking) | L4 | stable | full | integrated |
| phase2-promotion-gate | Stage1 → Phase2 promotion gate (10% sample rate, fail-excluded, score-ranked) | L4 | stable | full | integrated |
| preference-phrase-grammar | Preference phrase grammar — literal quote + count-based confidence + evidence anchor | L4 | stable | full | n-a |
| retrieval-chunk-bucket | Token-bucket re-chunker — 4 buckets × 10% sliding-window overlap | L4 | new | full | integrated |
| retrieval-commit-embedder | Commit embedding — git-aware recall over recent commit messages with LRU cache | L4 | new | full | integrated |
| retrieval-composition-wire | Retrieval-stack composition-root wire — buildRetrievalStackCore + memory/localize bridges + AgentConfig slot (ADR-0159 wire) | L4 | stable | full | integrated |
| retrieval-hybrid-query | Hybrid query 3-stage funnel — keywords / embeddings / hybrid with optional final rerank | L4 | new | full | integrated |
| retrieval-multi-vendor-embedding | Multi-vendor embedding port — 8 vendors (2 runtime + 6 type-level stub) | L4 | new | full | integrated |
| retrieval-rerank-registry | Reranker port + registry — 4 built-in strategies (identity / bm25-secondary / tier-aware / score-fusion-rrf) | L4 | new | full | integrated |
| sqlite-persistent-store | SQLite PersistentStorePort — long-term memory disk-backed adapter | L4 | stable | full | n-a |
| working-memory-buffer | WorkingMemory — in-session message buffer (RFC §6.3 L1) | L4 | stable | full | n-a |

## 06-tier1 (91)

| id | title | 완성도 | status | cli | cfg |
|---|---|---|---|---|---|
| eval-schema-additive | Eval 스키마 additive 필드 (keyed metrics / token·cost / run status·params) | L5 | stable | missing | n-a |
| agent | agent | L3 | stable | full | integrated |
| mutatingmodes-set-agentmode-default | `MUTATING_MODES = Set<AgentMode>([\default\])` 인버스 | L5 | stable | full | integrated |
| quantaskillsdir | QUANTA_SKILLS_DIR | L3 | stable | full | integrated |
| localize-signal-hardening | Localize tool — BM25-lite + FrameTier + def-boost + recall@1 polish | L4 | stable | full | integrated |
| branch-search-minimal-change | Branch-search minimal-change bias + progress surface | L4 | stable | full | n-a |
| budget-ledger | BudgetLedger + budget_status — cross-run typed BudgetBreach primitive (ADR-0138) | L4 | new | full | static |
| subagent-background-wire | Background-subagent caller wire — ADR-0130 helper exposed to loop | L4 | stable | full | n-a |
| background-subagent | Background subagent scheduler | L4 | stable | full | n-a |
| engineering-skills-bundle | Engineering-task skill bundle — debug-error / add-tests / explain-code / extract-function (ADR-0134) | L4 | new | full | static |
| 2026-05-21 | 매트릭스 보강 (2026-05-21) | L4 | stable | full | integrated |
| bounded | bounded 다단계 재귀 | L3 | stable | full | integrated |
| tool-scoping | tool-scoping 강제 | L4 | stable | full | integrated |
| user-authored-playbook-frontmatter | User-authored playbook frontmatter (procedure / success-criteria / forbidden-actions / macros / inline-trigger) — ADR-0203 | L4 | new | full | integrated |
| subagent-mode-typed | Mode-typed delegation (parent → child mode-typed handoff) | L3 | stable | full | n-a |
| focus-chain | Focus Chain (automatic N-turn todo-list re-injection) | L3 | stable | full | n-a |
| auto-background-stuck-detector | Auto-background after 2 s — stuck-detector + propose-handler observer | L3 | stable | full | integrated |
| queued-followup-per-msg-mutators | Queued follow-up per-msg mutators (retry / edit / delete / sendNow) | L3 | stable | full | n-a |
| playbook-trigger-cli-bind | Playbook inline-trigger CLI auto-bind opt-in | L2 | stable | full | integrated |
| subagent-fanout-parallel | Subagent fanout parallelization — `agent.isConcurrencySafe = true` + `parallel_worker` flag (ADR-0298) | L4 | new | full | static |
| lexical-refine-2026-05-21 | Lexical refine (2026-05-21) | L4 | refined | full | n-a |
| plan-mode | Plan-mode 구조화 메타도구 + state-machine (SOTA++ ADR-0095 draft) | L4 | stable | full | integrated |
| quantasubagent-maxdepth | QUANTA_SUBAGENT[_MAX_DEPTH] | L3 | stable | full | integrated |
| playbook-trigger-flag-echo | --playbook-trigger CLI flag echo through to wire (close ADR-0293 last-mile) | L3 | new | full | integrated |
| synchronous-delegate-tool | 동기 delegate 도구 — mode-typed in-band boomerang (ADR-0393) | L3 | new | full | integrated |
| activation-timing-phase | Activation-timing phase 분리 | L1 | hold | na | n-a |
| safety-posture-round-2-fix | Safety-posture 전파 (Round 2 fix) | L3 | stable | full | integrated |
| seam | 읽기 seam 노출 | L4 | stable | full | integrated |
| lsp-rename-rpc-and-apply | LSP textDocument/rename RPC + 2-phase atomic WorkspaceEdit 적용 (ADR-0404) | L4 | new | full | integrated |
| edit-after-diagnostics-hook | Edit-후 LSP diagnostics 자동 주입 hook (ADR-0405) | L3 | new | full | integrated |
| force-background | force_background — promote a queued background subagent | L3 | new | full | planned |
| wiring | 루프 wiring 추가 | L4 | stable | full | integrated |
| agent-role | agent_role enum (explorer/worker/none) + maestro nickname pool | L2 | stable | full | n-a |
| plugin-manifest | 플러그인 매니페스트 (.quanta-plugin/plugin.json + .mcp.json + skills/) | L4 | stable | full | static |
| skill-7-scope-tiering | Skill 7-scope tiering (ADR-0134, builtIn / system / admin / team / repo / user / personal) | L4 | new | full | integrated |
| skill-admin-enforcement | Skill admin enforcement — org-policy.json + install decision (ADR-0134 §3) | L4 | new | full | static |
| skill-adr-0022 | Skill 트리거 규칙 (ADR-0022) | L4 | stable | full | integrated |
| skill-audit-log | Skill install audit log — append-only JSONL (ADR-0134 §3) | L4 | new | full | static |
| skill-md-frontmatter | SKILL.md 6-필드 frontmatter + Skills vs Extensions 분류 | L4 | stable | full | integrated |
| skill-registry-precedence | Skill registry — 7-source discovery + precedence resolver (ADR-0134 §1) | L4 | new | full | static |
| subagent-6-tools | Subagent 6-tool 표준 (exec_command / write_stdin / spawn_agent / wait_agent / close_agent / send_input) | L4 | stable | full | integrated |
| tool-routing-matrix-adr-0022 | Tool routing matrix (ADR-0022) | L5 | stable | full | integrated |
| subagent-persistence | Background subagent persistence (cross-restart) | L4 | stable | full | partial |
| loop-trio-integration | Loop trio integration (auto-bg accept + automation tick + identity per-turn reminder) | L3 | stable | full | integrated |
| playbook-auto-dispatch-git-directive-completion | Playbook auto-dispatch + Git directive 5-kind completion | L3 | stable | full | integrated |
| skill-vs-extension | classify() + allowed-tool whitelist gate (Skill vs Extension) | L4 | new | full | integrated |
| skill-discover | discoverSkills — frontmatter + size-cap-guarded skill enumeration | L4 | stable | full | integrated |
| plugin-loader | loadPluginManifest + discoverPlugins — `.quanta-plugin/plugin.json` loader | L4 | stable | full | static |
| task-registry | TaskRegistry — background subagent registry + capability tokens + LRU | L4 | stable | full | integrated |
| agent-tool-shape | Agent tool input shape — task_kind / result_shape / owned_surfaces / forbidden_surfaces / continue_from / checkpoint | L4 | new | full | integrated |
| speculative-branch-search | branch_search — N-best verifier-prover (speculative branch search) | L4 | refined | full | n-a |
| adaptive-escalation-v5 | Adaptive-escalation controller — v5 thin-first bench outer control plane (jun-22) | L3 | new | missing | partial |
| agent-jobs-batch | CSV batch-job runner (`agent_jobs`) — row-indexed fan-out over subagents (ADR-0463) | L4 | stable | full | static |
| ai-session-title | createAutoTitlePort + generateSessionTitle — opt-in cheap-model first-turn session titler | L4 | refined | full | integrated |
| assemble-compaction-core | buildCompactionBreakerConfigCore + buildSummarizerLlmCore — compaction guards + dedicated summarizer | L4 | new | full | integrated |
| assemble-llm-core | buildLLMCore + composeLLMCore + parseFallbackModels — surface-agnostic LLM stack | L4 | new | full | integrated |
| assemble-memory-config-core | buildMemoryConfigCore + parseRecallTiers — memory tuning block composer | L4 | new | full | integrated |
| assemble-store-core | buildStoreCore + buildEmbedderCore — surface-agnostic memory store/embedder factories | L4 | new | full | integrated |
| assemble-streaming-core | buildStreamingCore — StdoutStream + observe-dir JsonlRecorder TeeStream | L4 | new | full | integrated |
| assemble-tooling-core | buildToolingCore — surface-agnostic ToolRegistry composition + per-config gate logs | L4 | new | full | integrated |
| product-onboard-skill | product-onboard system skill — new-USER guided first-run (B1) | L2 | new | full | static |
| branch-search-isolate-symlink-safe | tmpdir/worktree isolators — node_modules symlink-safe cleanup | L4 | stable | full | static |
| branch-search-pure-scorer | Branch-search pure scorer — DEFAULT_WEIGHTS + argmax/minimal-change selectors | L4 | stable | full | integrated |
| branch-search-seed-temperature | buildSeeds — Agentless temperature diversification + mixed-model voting | L2 | stable | full | static |
| branch-search-verifier-suite | Branch-search verifier suite — tsc / test / lint / lsp_diag + combineVerifiers | L4 | stable | full | integrated |
| bug-fix-proposal-queue | Bug-fix proposal queue — debug-trace 자동수정 루프 Phase 1 (ADR-0186) | L3 | stable | missing | static |
| ctk-git-skills-bundle | CTK git-task skill bundle — babysit / fix-merge-conflicts / get-pr-comments / loop-on-ci / make-pr-easy-to-review / new-branch-and-pr / pr-review-canvas / review-and-ship (ADR-0102) | L4 | stable | full | static |
| debug-blame-skills-trio | debug/blame 시스템 스킬 트리오 — debug-trace / explain-stack-trace / blame-section (ADR-0176) | L4 | stable | full | static |
| default-on-subagent-and-skills | subagent + skills default-ON 전환 — surface-agnostic env-off-switch | L4 | new | full | integrated |
| fork-turns | fork_turns — spawned subagent inherits parents recent (redacted) turns (ADR-0511) | L4 | new | full | integrated |
| git-log-search-skill | git-log-search 시스템 스킬 — pickaxe/regex/author/since 검색 (ADR-0172) | L4 | stable | full | static |
| plan-dag-validator | Plan DAG validator — self/dangling/cycle + 100-node perf gate | L4 | stable | full | integrated |
| plan-mutator-adapter | PlanStore → PlanMutator adapter — slice-boundary translation | L4 | stable | full | integrated |
| plan-stream-mirror | planToStreamMirror — single slice-boundary by-value projector | L4 | stable | full | integrated |
| plan-transition-matrix | TodoStatus 5×5 transition matrix — pure predicate + frozen table | L4 | stable | full | integrated |
| progress-audit-skill | progress-audit 시스템 스킬 (ADR-0045) | L4 | stable | full | integrated |
| rewind-skill | rewind 시스템 스킬 — shadow-snapshot 복원 워크플로 (ADR-0122) | L4 | stable | full | n-a |
| runner-assemble-builders | runner/assemble — surface-agnostic per-collaborator builder family | L4 | new | full | integrated |
| runner-multimodal-image | multimodal image input queue (/image add/list/clear) | L4 | new | full | integrated |
| runner-persist-turn | persistTurn — per-turn save plumbing (path-mode + id-mode) | L4 | new | full | integrated |
| runner-resume-fsm | resolveResume — surface-agnostic session-resume state machine | L4 | new | full | integrated |
| runner-run-interactive | Legacy runInteractive cutover — prompt-pipeline + turn-runner REPL driver | L4 | new | full | integrated |
| runner-run-once | runOnce — surface-agnostic one-shot turn orchestration | L2 | new | full | n-a |
| runner-side-chat | side-chat — isolated agent loop without history pollution (Claude A9) | L4 | stable | full | integrated |
| session-rewind-fork | session rewind + fork (Claude Code A1 pattern) | L4 | new | full | integrated |
| skill-creator-tool | Skill-creator tool — agent-callable scaffold + validate + install a skill (Codex parity) | L3 | new | full | integrated |
| skill-ecosystem-frontmatter | Skill ecosystem: argument-hint + metadata + bundled resources | L3 | stable | full | integrated |
| skill-scope-v2-availability-permission | Skill tool-scope v2 — 가용성(visibility) ⟂ 권한(permission) 2축 분리 + escalation (ADR-0512) | L4 | new | full | integrated |
| tier1-skill-block | buildSkillBlock — skill discovery + tool registration + override maps + paths-filtered inventory | L4 | new | full | integrated |
| tier1-subagent-block | buildSubagentBlock — shared TaskRegistry trio + force-stop cleanup | L4 | new | full | integrated |
| verify-and-select | Verify-and-select executor — N-candidate diversity-gen + VerificationBundle pick (TD) | L3 | new | missing | partial |

## 07-resilience (40)

| id | title | 완성도 | status | cli | cfg |
|---|---|---|---|---|---|
| fallbackllm | FallbackLLM | L3 | stable | full | static |
| retryingllm | RetryingLLM | L3 | stable | full | static |
| quantamodelfallback | QUANTA_MODEL_FALLBACK | L3 | stable | full | integrated |
| quantaprovider | QUANTA_PROVIDER | L5 | stable | full | integrated |
| recovery-state-budgets | RECOVERY_CAPS — bounded per-turn same-turn recovery budgets | L5 | stable | full | static |
| retry-error-classification | RetryingLLM string-marker + LLMErrorKind taxonomy (RETRYABLE / FATAL / PTL) | L5 | stable | full | integrated |
| fallback-kinds-policy | FALLBACK_KINDS — structured provider-swap trigger set | L4 | stable | full | integrated |
| escalating-kill | escalatingKill — SIGTERM → SIGKILL 2s-grace | L4 | stable | full | static |
| cap-enforcer-nextaction | CapEnforcer — ADR-0062 3rd-channel NextAction enforcement | L4 | stable | full | integrated |
| sandbox-policy | SandboxPolicy — declarative per-command confinement | L4 | stable | full | integrated |
| bash-timeout-cap | bash 도구 — timeout_ms (default 120s) + output cap + stderr-tail | L4 | stable | full | integrated |
| patch-observer-fail-open | Patch applier — observer + OTel emitter fail-open (telemetry bugs MUST NOT abort apply) | L4 | stable | full | static |
| shadow-checkpoint-policy | ShadowOdb auto-checkpoint policy (ADR-0121) | L4 | new | full | static |
| conversation-checkpoint | ConversationCheckpoint — message-level resume + restore | L4 | stable | full | static |
| token-store-atomic | chatgpt-oauth token-store — atomic write + 0o600 perm guard | L4 | stable | full | integrated |
| side-chat-cap | Side-chat isolation 5-invariant — Claude Code A9 absorption | L4 | stable | full | integrated |
| turn-cancel-keys | REPL turn-cancel — Ctrl+C hard / Esc-Esc soft 2-tier | L4 | stable | full | integrated |
| model-swap-retry | 모델 교체 retry (SubmitRetryBotMessage) | L4 | refined | full | integrated |
| abort-signal-compose | AbortSignal.any compose + chainedSignal — framework-level dual-signal hierarchy | L4 | stable | full | static |
| adversarial-multi-voter | Adversarial multi-voter verification (refute-biased quorum) | L3 | new | full | integrated |
| batch-aggregate-exit-code | batch.computeExitCode — corpus aggregator (any !passed \| degraded \| env_prep_failed → 1) | L4 | stable | missing | integrated |
| bench-main-gate | import.meta.main CLI-entry guard (test-import safety) | L4 | stable | full | static |
| budget-dials-types | BudgetDials / BudgetCaps / BudgetExhaustionPolicy pure types | L2 | stable | full | static |
| budget-events-union | BudgetEvent closed union — tick / exhausted / clamp | L4 | stable | full | integrated |
| budget-meter | BudgetMeter — pure cumulative per-run quantitative tracking | L4 | new | full | static |
| codex-r2-image-history-sanitization | Image-history sanitization pipeline (ADR-0323 / 0328 / 0333 / 0337) | L4 | stable | full | n-a |
| edit-repair-loop | Edit-repair-loop — lint-delta + bounded fast-model repair to green | L3 | refined | full | integrated |
| env-probe | startup environment probe + graceful-degradation warnings | L2 | new | full | none |
| hellgate-test-pattern | hellgate test pattern — 적대적 회귀 봉인 (`tests/unit/*-hellgate.test.ts`) | L2 | stable | na | static |
| interactive-abort-error-mapping | interactive runMode AbortError / ABORT_ERR → exit 130 boundary | L4 | stable | full | integrated |
| llm-error-taxonomy | LLMError 16-kind taxonomy + fromSdkError boundary classifier + classify(e) router-boundary classifier | L4 | refined | full | integrated |
| outcome-exit-code-table | exitCodeForOutcome — AgentOutcome → POSIX exit code mapping + SIGINT lifecycle wrapper | L4 | stable | missing | integrated |
| ratelimit-snapshot | Account rate-limit snapshot — proactive empty-bucket backoff from *-ratelimit-* headers | L3 | refined | full | integrated |
| recovery-router-codex-spec | RecoveryRouter port + CodexSpecRouter — 16-kind × 6-action routing table | L3 | new | full | integrated |
| resume-tool-pairing-reconcile | Resume-boundary tool_use/tool_result reconciliation (B4 — ADR-0323 extension) | L4 | stable | full | integrated |
| session-cwd-missing-exit | switchToSessionCwd — fail-loud SessionStartupError on missing worktree on resume | L4 | stable | full | integrated |
| session-resilience | Session resilience — persisted crash-resume marker (§13.2) + aggregate store-health diagnostic (§13.1) | L4 | stable | full | integrated |
| swebench-smoke-baseline | SWE-bench Verified 6-pick smoke baseline (recorded tier-0 regression gate) | L2 | new | missing | integrated |
| swebench-smoke-recordings | SWE-bench smoke recordings — 6-pick recorded patches + offline-cert path | L2 | new | na | static |
| unhandled-rejection-defense | process.on(unhandledRejection) defense-in-depth — log, never exit | L4 | stable | full | static |

## 08-llm (29)

| id | title | 완성도 | status | cli | cfg |
|---|---|---|---|---|---|
| llm-multicloud-provider-router | Multi-cloud provider router (CLAUDE_CODE_USE_* env mirror + precedence ladder) | L2 | stable | full | integrated |
| llm-adapter-bedrock | AWS Bedrock LLM adapter (Anthropic Messages grammar via SigV4-signed Bedrock endpoint) | L4 | stable | full | integrated |
| sticky-model-per-mode | Sticky model-per-mode — fs-backed {mode → modelId} store + precedence resolver | L4 | new | full | integrated |
| spinner-stall-detection | Spinner stall detection — soft-signal port for mid-stream silence (Claude `tengu_spinner_stalled_ui` absorption, ADR-0227) | L3 | new | full | integrated |
| llm-error-16-kind-layer-owned-arms-wire | LLM error 16-kind close-out — layer-owned arms wire (too-many-failed / thread-rollback / sandbox) | L3 | stable | full | integrated |
| role-based-model-override | Role-based model override — {role → modelId} resolver (Roo orchestrator) | L4 | new | full | integrated |
| llm-adapter-vertex | GCP Vertex AI LLM adapter (Anthropic Messages via projects/loc URL) | L4 | stable | full | integrated |
| llm-adapter-foundry | Azure AI Foundry LLM adapter (REAL stream, ADR-0172) | L4 | stable | full | integrated |
| sticky-model-loop-consume | Sticky model-per-mode — loop consume site (dead-seam → live, ADR-0462) | L3 | new | full | integrated |
| llm-adapter-mantle | Anthropic Mantle LLM adapter (Phase 1 stub — internal enterprise endpoint) | L2 | hold | full | integrated |
| oidc-federation | OIDC federation token exchange (ANTHROPIC_IDENTITY_TOKEN_FILE → access token) | L4 | stable | full | integrated |
| oauth-refresh-lock | Distributed OAuth refresh lock (port + 3 impls + fallback chain) | L2 | stable | full | integrated |
| github-token-rotation | Mid-session GitHub token rotation (lock-protected, vendor-TTL respected) | L2 | stable | full | integrated |
| session-effort-wire | Session effort wire — `/effort` slash + `EffortStore` precedence fold-in (Codex `/model`-style) | L4 | new | full | integrated |
| reasoning-carryover | Reasoning carry-over via `encrypted_content` — OpenAI Responses / o-series (H15, Codex `ResponseItem` absorption) | L2 | new | full | integrated |
| byok-apikey-helper-legacy-vendor | BYOK apiKeyHelper mint for the LEGACY vendor key path (anthropic/openai) | L4 | refined | full | integrated |
| rotating-cloud-credentials | Rotating cloud credentials (apiKeyHelper mint + aws/gcp pre-call refresh) | L4 | new | full | integrated |
| adaptive-thinking | Adaptive thinking — Anthropic `thinking:{type:adaptive}` (4.6+ self-paced reasoning) | L3 | new | full | integrated |
| anthropic-service-tier | Anthropic service_tier request control (auto / standard_only, priority→auto) (ADR-0506) | L4 | new | full | integrated |
| brief-mode | Brief mode — condensed output posture (`/brief` slash + `set_brief` op + `QUANTA_BRIEF` seed) | L4 | new | full | integrated |
| context-1m-window | 1M-context window opt-in (Anthropic context-1m beta) — derived eligibility (ADR-0505) | L4 | new | full | integrated |
| live-usage-output-token-counter | Live · N tokens output-token counter — vendor-agnostic stream decorator (Claude-Code parity) | L3 | new | full | integrated |
| llm-record-replay | LLM session record/replay — deterministic JSONL recorder + replayer (RecordingLLM / ReplayLLM) | L3 | stable | na | integrated |
| message-batches-client-core | Anthropic Message Batches API client core (create/retrieve/results/cancel, no-throw) | L2 | new | na | n-a |
| model-preset-sticky-resolver | opusplan-style sticky model PRESET registry + resolver (curated multi-role recipe) | L2 | new | na | n-a |
| openai-responses-adapter | OpenAI Responses API adapter + continuation/resume store | L3 | stable | full | integrated |
| prompt-cache-1h-ttl | 1-hour prompt-cache TTL — Anthropic `cache_control: { ttl: 1h }` (cost optimization) | L2 | new | full | planned |
| ratelimit-dual-window-snapshot | Codex per-account DUAL-WINDOW ratelimit snapshot parser + store (used-percent meter) | L2 | new | na | n-a |
| structured-output-mode | Structured output mode — response_format json_schema passthrough (ADR-0469) | L2 | new | full | partial |

## 08-observability (71)

| id | title | 완성도 | status | cli | cfg |
|---|---|---|---|---|---|
| context-usage-metrics | Context-usage metrics fan-out + surface-agnostic status line | L4 | stable | full | integrated |
| otel-span-tree | OTel span tree (Codex 10-step) — core 4-stage SDK-free wrap | L4 | stable | full | integrated |
| cost-cache-dashboard | Cost & cache 대시보드 | L4 | stable | full | integrated |
| agentevent | AgentEvent | L3 | stable | full | integrated |
| agentrecorder | AgentRecorder | L3 | stable | full | integrated |
| src-shared-logger-ts | src/shared/logger.ts | L4 | stable | full | integrated |
| turn-diff-event | turn_diff_updated stream event + emitter | L4 | new | full | integrated |
| git-observability-wiring | Git observability composite — session fingerprint + turn-diff emit helpers | L4 | new | full | static |
| jsonlrecorder | JsonlRecorder | L3 | stable | full | integrated |
| git-directive-emit-protocol | Git `::git-*` 5-directive emit protocol — phase-guarded behavioral layer + turn-collector wire | L4 | new | full | integrated |
| observability-audit-findings-and-ratchets | Observability stack audit (3-round, adversarial) findings + structural ratchets (ADR-0425) | L4 | stable | full | n-a |
| session-prewarm-ttfm | Session-startup LLM prewarm + Time-To-First-Message (TTFM) | L3 | new | full | integrated |
| jsonl-cumulative-retention | JsonlRecorder cumulative-bytes sliding-window retention | L4 | stable | full | integrated |
| otel-attribute-vocab | OTel canonical attribute vocabulary (quanta.* 12 namespaces + gen_ai.* semconv) | L4 | stable | full | integrated |
| otel-sink | OTel MeterProvider-backed metric sink | L4 | stable | full | partial |
| otlp-helper | OTLP HTTP + Prometheus exporter helpers | L3 | stable | missing | integrated |
| instrument-wrap | Metrics instrument wrap helpers + Grafana + alerts + E2E coverage | L2 | stable | missing | partial |
| instrument-shadow-tool-routing | ShadowOdb/Tool instrument wraps + AlertManager routing + Grafana provisioning | L2 | stable | missing | partial |
| instrument-extra-and-helper | PlanQueue/Budget/LSP wraps + withFullObservability + SLO doc | L2 | stable | missing | partial |
| observability-wired-gauge | observability.wired.total{slice} gauge — machine-readable wiring health | L4 | stable | full | partial |
| git-directive-emit-leaf | Git `::git-*` directive emit — wire/serdes leaf (ADR-0220) | L3 | new | full | integrated |
| work-metrics | workMetrics — turn별 비용·작업 투명성 | L4 | stable | full | integrated |
| pricing-null-proto-guard | costUsd — null-prototype TABLE로 prototype-pollution NaN 차단 | L5 | stable | full | static |
| activity-spine | Agent Activity Spine — unified zoomable activity model + /activity view | L3 | new | full | static |
| assert-never-exhaustiveness | `assertNever` — compile-time + runtime exhaustiveness guard | L4 | stable | full | static |
| notify-presence-suppression | Presence-aware desktop-notification suppression (B5) | L2 | new | full | integrated |
| bench-live-trace-run-link | Live-trace receiver + waterfall UI + run-id deep-link (operator span view) | L3 | new | full | integrated |
| byte-stable-string-comparator | `byteCompare` — locale-independent string ordering | L4 | stable | full | static |
| codex-r2-metrics-composition-wire | Composition-root metrics wire + activation telemetry (ADR-0358 / 0360) | L3 | stable | full | n-a |
| codex-r2-observability-decorators | Cache + registry observability metric decorators (ADR-0352) | L3 | stable | full | n-a |
| codex-r2-system-prompt-cache-and-audit | System-prompt cache + drift detector + cache-control audit (ADR-0322 / 0326) | L3 | stable | full | n-a |
| context-usage-breakdown | Segmented context-window usage breakdown + wired /context | L3 | new | full | integrated |
| contract-tier-gate | contract-tier gate — REQUIRE_CONTRACT skip-vs-fail switch (Docker / LSP probes) | L2 | stable | na | integrated |
| debug-tracer-decision-event | 게이트 결정 trace surface — `AgentEvent.decision` variant + stderr debug-tracer + `/debug` + `QUANTA_DEBUG` (ADR-0239) | L4 | stable | full | partial |
| decision-counter-sink | `decision` AgentEvent → MetricsRegistry counter sink (`quanta.gate.{kind}.{outcome}.total`) (ADR-0270) | L4 | stable | full | partial |
| flock-operations-telemetry | Flock acquire/timeout/fail/stale_reclaim telemetry (ADR-0364) | L3 | stable | full | integrated |
| health-snapshot-watcher | Health snapshot watcher — periodic re-emit + SIGHUP hot-reload (3-channel drift defense) | L3 | stable | missing | integrated |
| hitl-otel-emit-outcome | HITL outcome-site OTel emit — tier_resolved / registry_escalated / handoff_emitted | L4 | new | full | static |
| item-lifecycle-stream | item-lifecycle stream projector — per-item started/updated/completed events (ADR-0508) | L4 | new | full | integrated |
| item-stream-fine-grained | T01 fine-grained item/* streaming — one ItemStreamProjector → both planes | L4 | new | full | integrated |
| jsonl-span-correlation | JsonlRecorder span correlation — deterministic turn / tool / llm span ids | L4 | new | full | static |
| llm-cost-emit-sink | LLM tokens + cost_usd OTel emit at turn-record sink | L4 | new | full | integrated |
| localize-calibration-corpus | localize 도구 calibration — recall@K / MRR 측정 코퍼스 (regression CI 아님) | L2 | stable | na | static |
| lsp-nav-test-fixtures | lsp-nav test fixtures — ctx/run/findTool primitives for 9-tool per-suite split | L4 | stable | full | static |
| memory-telemetry-adapter | MemoryTelemetry → MetricsRegistry adapter (phase1 / phase2 / recall OTel emission) | L4 | stable | full | integrated |
| metrics-registry | In-process Metrics registry — counters + gauges + timers (nearest-rank p50/p95) | L4 | stable | full | integrated |
| metrics-typed-port-slice | Metrics typed-port slice — counter / histogram / gauge + sinks (ADR-0144) | L4 | new | full | integrated |
| ndjson-introspection | NDJSON live-event introspection sink (Cursor cursor-ndjson-ingest) | L2 | new | full | partial |
| otel-emit-new-slices | ADR-0222 OTel emit unified across 4 new slices (fence-aware narrow ports) | L2 | new | full | integrated |
| otlp-http-exporter | OTLP/HTTP exporter — `QUANTA_OTEL_ENDPOINT` realtime ship (외부 SDK zero) (ADR-0268) | L4 | stable | full | partial |
| passive-vcs-classify | Passive git/gh stdout → structured VCS events (H6) — turn-diff observability for raw git/gh | L3 | new | full | integrated |
| patch-v4a-otel-emit | V4A apply_patch OTel emit — patch.op + fuzzy_match_tier per hunk | L4 | new | full | integrated |
| permission-otel-emit-recorder | Permission decision-site OTel emit — slice-local recorder seam | L4 | new | full | integrated |
| permission-rules-fixture-corpus | permission-rules fixture corpus — authorship-separated mustBlock/mustAllow catalog | L4 | stable | full | static |
| pricing-table-versioned | Pricing table — versioned static prices + provider cache-read semantics | L4 | stable | full | static |
| ratelimit-snapshot-render | Transient rate-limit quota notice (CLI status-bar render) | L3 | stable | full | partial |
| run-context-correlation | RunContext — run/instance/attempt/turn/toolUseId correlation primitive | L4 | stable | full | static |
| runtime-config-ssot | Frozen runtime-config SSOT — the only place that touches process.env | L4 | stable | full | integrated |
| session-transcript-retention | Session transcript retention sweep | L3 | new | full | integrated |
| shared-test-harness | shared test harness — ScriptedLLM / FakeLLM / RecordingStream / cfg / findEvent SSOT | L2 | stable | na | static |
| shell-exec-otel-observer | Shell-exec OTel observer — typed event stream → counter registry | L2 | stable | full | integrated |
| smoke-fixture-system | smoke fixture system — single/medium/tikitaka 15-scenario battery + LLM replay | L5 | stable | full | integrated |
| spinner-tokens-per-sec | Live tokens/sec rate in the streaming spinner | L3 | stable | full | integrated |
| stream-stdout-painter-hook | StdoutStream adapter — assistant-text painter hook with boundary flush | L4 | stable | full | integrated |
| stream-tee-fanout | TeeStream — fan-out StreamPort with degraded-record tracking | L4 | stable | full | integrated |
| structured-logger | Structured JSON-per-line logger — machine-consumable observability | L4 | stable | full | integrated |
| test-artifact-purge-hellgate | Test Artifact Purge Hellgate | L4 | stable | na | integrated |
| tool-dedup-drift-detector | Per-tool TTL drift detector — config-vs-RECOMMENDED preset divergence as typed signal | L2 | new | missing | integrated |
| trajectory-schema | Trajectory v1 schema SSOT — kind taxonomy + envelope + redaction policy id | L4 | stable | full | static |
| turn-diff-emit-session | TurnDiffSession — per-turn anchor → endTurn state machine | L2 | stable | full | static |
| turn-timing-anchors | Turn-timing wall-clock anchors — request/firstToken/streamEnd (ADR-0077) | L4 | stable | full | integrated |

## 09-integration (149)

| id | title | 완성도 | status | cli | cfg |
|---|---|---|---|---|---|
| chatgpt-oauth-provider | ChatGPT-OAuth provider — BYOK 없이 구독계정으로 모델 호출 (ADR-0094 Phase 1) | L4 | new | full | integrated |
| diagnostics | diagnostics | L4 | stable | full | integrated |
| hookbus | HookBus + Cursor `updated_input` 흡수 (pre_tool_use 인자 rewrite) + ADR-0133 bidirectional RPC | L4 | refined | full | integrated |
| lspport | LspPort | L4 | stable | full | partial |
| quantamcpconfig | QUANTA_MCP_CONFIG | L4 | stable | full | integrated |
| hook-updated-input | pre_tool_use hook updatedInput rewrite channel | L4 | stable | full | partial |
| cloud-agent-branch-snapshot | ADR-0132 cloud-agent branch snapshot (force-with-lease only) | L2 | stable | missing | integrated |
| reactor-self-wake | ADR-0132 self-wake (3 hard guards + audit suffix) | L4 | stable | full | integrated |
| reactor-trigger-source | ADR-0132 reactor TriggerSourcePort (CI + PR-comment adapters) | L4 | stable | full | integrated |
| llm-provider-fork | LLM provider fork — Anthropic 4-transport closed port (default/bedrock/vertex/foundry) | L4 | stable | full | integrated |
| lsp-exdev-fallback | LSP applyWorkspaceEdit Phase 2 — EXDEV cross-FS fallback (copy + unlink) | L3 | stable | full | integrated |
| lspdefinition | lsp_definition | L4 | stable | full | integrated |
| automation-engine-wire | ADR-0279 Automation engine composition-root wire | L3 | stable | full | integrated |
| automation-tool-inbox-cli | ADR-0280 automation_update tool + REPL inbox banner + B2 threads_handoff | L3 | stable | full | integrated |
| unit-46-nav-tool-unit-12-formatter-unit | unit + 46 nav-tool unit + 12 formatter unit | L4 | stable | full | partial |
| github-actions-trigger-adapter | GitHub Actions Tier 0 PR webhook adapter | L3 | new | missing | integrated |
| github-pr-from-pr-cli | from-pr CLI sub-command (Tier 0 PR webhook bot entry) | L2 | new | missing | integrated |
| github-webhook-host-scaffold | GitHub App webhook host — `quanta webhook` inbound HTTP → reactor (ADR-0312) | L4 | stable | full | integrated |
| pr-output-sink-redaction | PR output sink with mandatory redaction | L3 | new | missing | integrated |
| mention-filter-trust-scope | Mention filter with trust-scope + code-block exclusion | L3 | new | missing | integrated |
| screen-ocr-native-sidecar | Screen OCR native sidecar — Swift CLI (ScreenCaptureKit + Vision) for Tauri shell | L2 | new | na | integrated |
| mcp-transport-port-and-http-sse | MCP transport port + stdio 분리 + Streamable-HTTP/SSE 카리어 (ADR-0391) | L4 | new | full | integrated |
| mcp-auto-restart | ADR-0435 MCP crash-detection + auto-restart (exponential backoff) | L4 | stable | full | integrated |
| canvas-web-components | ADR-0440 Canvas web components (render-side DiffView + segmented UsageBar) | L3 | refined | full | partial |
| heartbeat-eligibility | ADR-0453 Heartbeat autorun eligibility (per-thread approval gate for scheduler + reactor) | L3 | stable | full | integrated |
| command-hooks | Disk-configured command hooks (security-gated shell on HookBus events, ADR-0454) | L3 | stable | full | partial |
| token-refresh-scheduler | Proactive token-refresh scheduler — clock-driven pre-expiry refresh (ADR-0461) | L2 | new | full | integrated |
| external-agent-import | External-agent 4-stage import lifecycle | L4 | stable | full | integrated |
| jsonrpc-envelope | JSON-RPC 2.0 envelope + -timeout 채널 (ADR-0033) | L2 | stable | missing | partial |
| mcp-tool-bridge | MCP 클라이언트 + tool 브리지 (임의 MCP 도구 passthrough) | L4 | stable | full | integrated |
| connector-availability-probe | Connector availability probe — DNS + HEAD + LRU (ADR-0160 W7 Phase D) | L2 | new | full | integrated |
| connector-token-rotation | Per-connector token rotation — in-flight mutex (ADR-0160 W7 Phase E) | L2 | new | full | integrated |
| connectors-rest-registry | Connectors REST registry — dynamic server-driven catalog (ADR-0160 W7 Phase B) | L2 | new | full | integrated |
| oauth-dynamic-discovery | OAuth endpoint discovery — RFC 8414 well-known + OIDC fallback (ADR-0160 W7 Phase C) | L2 | new | full | integrated |
| oauth-dynamic-registration | OAuth dynamic client registration — RFC 7591 (ADR-0160 W7 Phase C) | L2 | new | full | integrated |
| scheduler-automation-lifecycle | ADR-0161 Automation 4-arm lifecycle + JSONL store | L4 | stable | full | integrated |
| scheduler-model-reroute | ADR-0161 Model reroute (preference + fallback chain) | L4 | stable | full | integrated |
| scheduler-rrule | ADR-0161 RRULE parser (RFC 5545 strict subset) | L4 | stable | full | integrated |
| scheduler-runtime | ADR-0161 SchedulerRuntime (tickOnce + reactor seam reuse) | L4 | stable | full | integrated |
| scheduler-weekday-nth | ADR-0161 Weekday nth-occurrence DSL (+1MO … -5FR) | L4 | stable | full | integrated |
| mcp-isolated-spawn | IsolatedMcpClient — opt-in MCP backed by plugin-isolation (ADR-0162) | L4 | stable | full | integrated |
| plugin-dxt-loader | DXT manifest loader + launchDxt (ADR-0162) | L4 | stable | full | integrated |
| plugin-host-wrapper | PluginHost — typed JSON-RPC 2.0 wrapper for isolated plugins (ADR-0162) | L4 | stable | full | integrated |
| plugin-isolated-spawner | Plugin isolated process spawner — IsolatedProcessSpawnerPort + Bun adapter (ADR-0162) | L4 | stable | full | integrated |
| plugin-lifecycle-manager | PluginLifecycleManager — auto-restart + heartbeat (ADR-0162) | L4 | stable | full | integrated |
| llm-provider-phase2 | LLM Provider Phase 2 (Bedrock + Vertex real stream) | L2 | stable | full | partial |
| lsp-atomic-workspace-edit | LSP applyWorkspaceEdit 2-phase atomicity (+ EXDEV fallback) | L4 | stable | full | static |
| automation-engine | ADR-0215 AutomationEnginePort (Codex 3-table schema + pure tickScheduler) | L3 | stable | full | integrated |
| llm-factory | createLLM provider factory + DEFAULT_MODEL registry (OCP) | L4 | stable | full | integrated |
| llm-stream-timeout | LLM stream first-chunk + inter-chunk idle timeout decorator | L4 | new | full | integrated |
| llm-streaming-events | Provider streaming event decoders (SSE + WS) — Responses API v2 | L4 | stable | full | integrated |
| llm-assemble | assembleFromEvents — stream → Message + ADR-0076 thinking accumulation | L4 | stable | full | integrated |
| ipc-event-bridge | EventBridge — surface-agnostic pub/sub + closed BridgePayload union | L2 | new | missing | integrated |
| ipc-transports | IPC transports — in-memory / stdio / uds / websocket | L2 | new | missing | planned |
| portable-session-v1 | PortableSessionV1 export/import — surface round-trip schema | L2 | new | missing | partial |
| anthropic-beta-and-skill-size-cap | Anthropic beta channels + 30 MB skill cap | L4 | stable | full | static |
| approval-gate-wire | Approval-gate wire — attribute HITL reviewer escalations to Objective+RunLedger via approval-SM (ADR-0407) | L3 | new | full | integrated |
| approval-state-machine | Approval state machine (ADR-0403 port + store) | L2 | new | full | none |
| chatgpt-responses-adapter | ChatGPT-OAuth Responses-API adapter (subscription path) | L4 | new | full | integrated |
| claude-code-session-translator | Claude Code session translator (~/.claude/projects/*.jsonl → Message[]) | L4 | stable | full | integrated |
| codex-r2-composition-install-and-registry | Composition-root install helper + session-keyed resource registry (ADR-0332 / 0334 / 0345) | L3 | stable | full | n-a |
| codex-r2-disk-persistence-and-env-swap | Disk-persistent session registry + env-var swap + cross-machine negative (ADR-0348 / 0351 / 0355) | L3 | stable | full | n-a |
| codex-r2-multi-process-flock | Multi-process lockfile for jsonl disk-adapter (ADR-0356) | L3 | stable | full | n-a |
| codex-r2-negative-decisions-r6r7 | Negative decisions — per-turn image retry rebuild + provider wm-live reads (ADR-0343 / 0344) | L1 | hold | na | n-a |
| codex-r2-plugin-system | Plugin discovery + MCP launcher + skill set extension + app catalog + manifest unification (ADR-0336 / 0338 / 0339 / 0341 / 0342) | L3 | stable | full | n-a |
| codex-r2-registry-cleanup-dry-run | Session registry cleanup --dry-run (preview without commit) ADR-0387 | L3 | stable | full | n-a |
| codex-r2-registry-r13-closeout | Session registry R13 — caller-owned wire + sweep telemetry + WAL RESTART + evict/help + path norm (ADR-0372/0373/0374/0375/0376/0377) | L4 | stable | full | n-a |
| codex-r2-registry-r14-partial | Session registry R14 partial — WAL telemetry + cleanup slash + unified API (ADR-0378 / 0379 / 0383) | L3 | stable | full | n-a |
| codex-r2-registry-r15-closeout | Session registry R15 closeout — TRUNCATE mode + bulk pattern + dry-run + listSessionIds + 2 process ADRs (ADR-0384..0389) | L3 | stable | full | n-a |
| codex-r2-registry-retention-and-inspector | Session registry retention sweep + inspector slash (ADR-0367 / 0369 / 0370) | L4 | stable | full | n-a |
| codex-r2-sqlite-session-registry | SQLite-backed session registry (Codex logs_2.sqlite parity) (ADR-0361) | L3 | stable | full | n-a |
| compaction-visibility | Compaction visibility — RecoveryReason + microcompact + post_compact (ADR-0409) | L4 | new | full | integrated |
| competitor-import | Competitor session import — real persist + MCP/hooks/rules + dedup (ADR-0430) | L4 | new | full | integrated |
| connector-marketplace | Connector marketplace V1 (DirectoryApp install lifecycle) + enterprise source policy (ADR-0519) | L2 | new | na | integrated |
| custom-3p-setup-mvp | Custom 3P Setup MVP — 5 core method + lifecycle (ADR-0245) | L2 | new | missing | integrated |
| dxt-user-config | DXT user_config — typed fields + template substitution + keychain secrets | L3 | refined | full | partial |
| effort-classifier | Prompt-keyword + tool-failure effort escalation classifier | L4 | stable | full | integrated |
| fast-apply-fallback | Apply-patch fast-apply fallback (focused re-emit on failure) | L4 | stable | full | integrated |
| fast-apply-merge | Model-based fast-apply MERGE rung (apply-model elision merge) | L3 | stable | full | integrated |
| fast-apply-wire | Apply-patch fast-apply fallback WIRE (retry on V4A failure) | L2 | new | full | integrated |
| h13-external-config-migration | External-agent config migration — detect + import Claude/Cursor config into quanta format (H13) | L4 | new | full | integrated |
| heartbeat-automation | Heartbeat automation — thread-attached repeating agent (kind cron\|heartbeat) | L5 | stable | full | integrated |
| hook-dos-caps | Hook DoS caps — handlers-per-event + payload bytes (S5 hardening) | L4 | stable | full | ? |
| hook-new-events-cursor-parity | Hook new events — user_prompt_submit + pre_compact + subagent_stop (S5) | L4 | stable | full | ? |
| hook-timeout-per-handler | Hook per-handler timeout (S5 hardening) | L4 | stable | full | ? |
| jsonrpc-channel-triple | Channel-triple naming — `{name}-request` / `-response` / `-timeout` | L2 | new | missing | partial |
| jsonrpc-codec | JSON-RPC 2.0 codec — encode/decode helpers returning `Result` | L2 | new | missing | partial |
| jsonrpc-request-id-correlation | JSON-RPC RequestId — branded, deterministic, seedable | L2 | new | missing | partial |
| jun7-manifest-codex-compat | Plugin/skill manifest codex-compat INGEST — strict schemas accept real codex artifacts (ADR-0499) | L3 | new | full | integrated |
| jun7-mcp-ingestion-progress-structured | MCP ingestion completion — structuredContent · progress · tools/list_changed (§19.2/§19.4/§19.5) | L4 | new | full | static |
| jun7-mcp-protocol-version-negotiation | MCP protocol-version SSOT + negotiated supported-set (bump + downgrade-safe handshake) | L4 | new | full | integrated |
| landlock-degraded-passthrough | Landlock sandbox — phase-1 typed-degrade passthrough | L2 | new | full | partial |
| llm-adapter-shared-helpers | LLM adapter shared helpers — stream-timeout / tool-input throw / usage spread | L4 | new | full | integrated |
| lsp-bridge | Agent↔LSP bridge — typescript + pyright adapter routing (ADR-0015) | L4 | stable | full | integrated |
| lsp-clangd-adapter | ClangdAdapter — clangd stdio adapter (C/C++/Objective-C) | L4 | stable | full | static |
| lsp-client-base | LspClient base — stdio handshake + 8 nav RPCs + LspRequestError typed | L4 | stable | full | integrated |
| lsp-gopls-adapter | GoplsAdapter — gopls stdio adapter (Go) | L4 | stable | full | static |
| lsp-jsonrpc-codec | LSP JSON-RPC 2.0 codec — Content-Length framed (MessageReader / encodeMessage) | L4 | stable | full | partial |
| lsp-pyright-adapter | PyrightAdapter — pyright-langserver stdio adapter (Python) | L4 | stable | full | static |
| lsp-rust-analyzer-adapter | RustAnalyzerAdapter — rust-analyzer stdio adapter (Rust) | L4 | stable | full | static |
| lsp-typescript-adapter | TypescriptAdapter — typescript-language-server stdio adapter + JS/TS/JSX/TSX languageId map | L4 | stable | full | integrated |
| lsp-warm-backend-prewarm | Code-intelligence warm backend — session-start LSP prewarm + first-call join + engine-swap pool | L3 | new | full | integrated |
| mcp-elicitation-schemas | ADR-0197 MCP Elicitation 7-schema (rmcp 0.15) | L2 | new | full | integrated |
| mcp-launch-governance | MCP launch governance — deniedServers + allowManagedMcpServersOnly LIVE enforcement (E2/E1-sub, §12.4 해소) | L3 | stable | full | integrated |
| mcp-http-oauth | H18 MCP HTTP-Server OAuth (RFC 8414 discovery + PKCE + refresh, port-injected) | L3 | refined | full | integrated |
| mcp-inbound-elicitation-lease | MCP inbound elicitation wiring + single-flight lease | L3 | new | full | integrated |
| mcp-oauth-keyring | MCP OAuth token storage in the OS keyring (Keychain / libsecret), file-fallback + migration | L3 | refined | full | integrated |
| mcp-resources-prompts-roots | H19 MCP resources/prompts/roots typed client methods | L2 | new | full | integrated |
| mcp-sampling-handler | ADR-0470 B1 MCP Sampling Handler (@/llm-backed, HITL-gated) | L2 | new | full | integrated |
| mcp-tasks-capability | ADR-0196 MCP Tasks Capability (rmcp 0.15 standard) | L2 | new | full | integrated |
| mcp-tasks-live | MCP tasks live binding (outbound tasks/* dispatch) | L3 | stable | full | integrated |
| mcp-tool-annotations-content | MCP ToolAnnotations ingestion + non-text content blocks (§19.1 / §19.3) | L3 | stable | full | integrated |
| migration-content-dedup-fingerprint | Migration content-dedup fingerprint — SHA-256 of source bytes | L2 | new | full | partial |
| migration-import-log-busy | Import-log persistence — sidecar lock + busy-error | L4 | new | full | partial |
| background-side-agent | Background side-agent daemon — resident monitor/cleanup (N1) | L3 | new | full | integrated |
| mcp-connector-discovery | MCP connector discovery / catalog (N2 — discover + install MCP servers) | L3 | new | full | integrated |
| mcp-resource-tools | MCP resource/prompt tools (N3 — list/read/read-dir resources + list-templates + list/get prompts) | L3 | new | full | integrated |
| n6-pty-attach | PTY / tmux session attach (N6) — attach + resize + live stdio across turns | L3 | new | full | integrated |
| oauth-callback-provider | OAuth callback provider port — CLI loopback / Tauri deep-link / Web origin | L4 | new | full | integrated |
| objective-budget-enforce | Thread-goal budget ENFORCEMENT — budget_limited status + idle-continuation hard gate (H17) | L3 | new | full | integrated |
| objective-first-class | Objective as a first-class per-thread object (ADR-0394, MODEL ONLY wave) | L2 | new | full | none |
| objective-tools | Objective LLM tools — objective_set / objective_update / objective_get (ADR-0402) | L3 | new | full | integrated |
| observability-live-wire | ADR-0415 Observability live-wire (HookBus auto-subscribe + RuntimeFacade port exposure) | L3 | stable | missing | integrated |
| observability-ui-pane | Observability UI pane (Running / Waiting / Completed + Objective + Approvals) | L3 | new | missing | integrated |
| observability-wire | ADR-0406 Composition-root observability wire (Objective + RunLedger + ApprovalSM + ShadowVerify) | L4 | stable | full | integrated |
| observability-ws-sink | ADR-0420 Observability served-WebSocket sink (closes ADR-0415 emitter-port-only deferral) | L4 | stable | missing | integrated |
| os-sandbox-port-router | OsSandbox port — platform-aware backend router with typed-degrade | L4 | new | full | partial |
| peer-teammate-messaging | Peer teammate messaging — auto-delivered inbox + team-scoped bus + redaction | L3 | refined | full | partial |
| remote-runner | Remote runner — `quanta remote` run/status/cancel/logs over docker\|lima\|apple-vz\|headless (ADR-0288/0289/0290) | L4 | stable | full | integrated |
| auth-revoke-on-logout | Revoke OAuth tokens on logout (RFC 7009, best-effort, NO-THROW, default-OFF) | L2 | new | full | integrated |
| run-ledger-attribution | ADR-0401 Run-ledger attribution via hook bus (bash/subagent/mcp observer) | L3 | stable | full | integrated |
| run-ledger | ADR-0395 unified long-running-work state model (Run Ledger) | L3 | new | full | integrated |
| seatbelt-profile-compiler | Seatbelt (SBPL) profile compiler — macOS sandbox-exec text | L2 | new | full | partial |
| shadow-odb-workspace-hash | Shadow-ODB workspace path → 16-hex directory hash | L4 | new | full | partial |
| shadow-verify-adapters | ADR-0400 Shadow Verify — real adapters (worktree/V4A/LSP) + shadow_verify LLM tool (Wave 2) | L3 | new | full | integrated |
| shadow-verify | ADR-0396 Shadow Verify — apply-before-show in a scratch overlay (Wave 1 port + runner) | L4 | stable | full | integrated |
| side-agent-os-process-daemon | Side-agent OS-PROCESS daemon V1 — forked child + supervised backoff respawn (§4.3) | L4 | stable | full | integrated |
| skill-mcp-deps | skill-mcp-deps — skill-declared MCP servers auto-attached on activation (ADR-0476) | L3 | refined | full | partial |
| slice-boundary-invariants | 10-architecture-invariant slice-boundary runtime guards (16 slices) | L4 | new | na | ? |
| stream-sse-adapter | SseStream — spec-correct SSE serializer with redaction + injectable clock | L4 | stable | full | partial |
| subagent-mailbox | Managed-subagent mailbox — subagent_send_message between agents (ADR-0416) | L3 | new | full | integrated |
| subagent-read-inbox | Subagent read-inbox — subagent_read_messages poll (ADR-0419) | L3 | new | full | integrated |
| team-broker-coordination | Multi-agent coordination B — leader-mediated permission escalation (broker) | L3 | refined | full | partial |
| team-dag-coordination | Multi-agent coordination A — task dependency DAG (Claude --agent-teams parity) | L3 | refined | full | partial |
| team-idle-barrier-coordination | Multi-agent team-idle barrier + idle beacon (Capability C) | L3 | refined | full | integrated |
| vscode-chatsessions-surface | VS Code chatSessions editor surface — 3rd surface (PURE session.v1 adapter + thin provider) | L3 | new | na | static |
| web-agent-state-channel | QUANTA_WEB_AGENT_STATE — agent-state WS push + out-of-band user-input port (jun-9 parity) | L3 | new | missing | integrated |
| why-meta-llm-reasoning | `/why <toolCallId\|last>` — 기록된 tool-call에 대한 meta-LLM reasoning chain (ADR-0271) | L4 | stable | full | partial |
| windows-flock-strategy | Windows flock strategy — Node `wx` retained (ADR-0365 negative) | L2 | stable | full | n-a |

## 09-security (7)

| id | title | 완성도 | status | cli | cfg |
|---|---|---|---|---|---|
| secret-redaction-content-plane | Secret redaction as content-plane invariant (ADR-0078) | L4 | stable | full | integrated |
| pii-redaction-dispatch-wire | PII redaction을 dispatch.applyRedaction에 wire (ADR-0399) | L3 | new | full | integrated |
| check-secrets-llm-tool | check_secrets LLM-facing tool over async secret-detection (ADR-0412) | L3 | new | full | integrated |
| sensitivity-classifier | sensitivity classifier — Layer 1 of secret-redaction (ADR-0078) | L4 | stable | full | partial |
| redaction-config-gate | redaction opt-out gate — startup-fail when disabled without ack (ADR-0078) | L4 | stable | full | integrated |
| network-allowlist-host-check | Network allowlist — propositional outbound host check (ci-bot mode) | L4 | stable | full | integrated |
| network-egress-enforcement | Network-egress enforcement wiring (mode → dispatch-guard) | L3 | new | full | integrated |

## 10-app-persist-policy (1)

| id | title | 완성도 | status | cli | cfg |
|---|---|---|---|---|---|
| session-import-export | Session import / export primitive | L4 | stable | full | partial |

## 10-app (195)

| id | title | 완성도 | status | cli | cfg |
|---|---|---|---|---|---|
| biome | Biome 슬라이스격리 | L3 | stable | na | static |
| bun-run-dev-start | bun run dev\|start | L3 | stable | full | integrated |
| non-authoritative-inspector | 읽기 전용, NON-authoritative inspector | L4 | stable | missing | static |
| python-harness-e2e-2026-05-21-l3-l4 | Python harness e2e 폐쇄 (2026-05-21, L3→L4) | L4 | stable | full | static |
| quantastatepath | QUANTA_STATE_PATH | L4 | stable | full | integrated |
| tests-integration-sota-codex-full-test-ts | tests/integration/sota-codex-full.test.ts | L5 | stable | full | static |
| shadow-odb-rewind | Shadow ODB rewindToLast — destructive restore + auto safety net | L4 | stable | full | static |
| verify-checkpoint-bridge | Verify-checkpoint bridge — opt-in markVerified caller seam | L3 | new | full | static |
| code-coverage | Code coverage observability — V8-coverage port + MetricSink emission | L3 | stable | full | integrated |
| prometheus-recording-rules | Prometheus recording rules — SLO burn-rate pre-computation | L2 | stable | na | integrated |
| coverage-ast-branch | AST-precise branch counter — astCoverageSource() behind ADR-0165 port | L3 | stable | full | integrated |
| prompt-cache-observability | Prompt cache observability — typed observer + budget bridge + tool surface | L3 | stable | full | integrated |
| tool-dedup-drift | Per-tool TTL drift detector — config-vs-preset divergence as typed signal | L3 | stable | missing | integrated |
| darwin-vz-native-scaffold | Darwin VZ native scaffold — napi-rs binding to Virtualization.framework | L3 | new | missing | integrated |
| architecture-generator | Architecture generator — tools/arch-gen walks ADRs + slices → ARCHITECTURE.generated.md | L3 | stable | na | integrated |
| linux-sandbox-native-impl | Linux sandbox native impl — Phase 3.1 Rust bodies + cargo build verify | L3 | stable | full | integrated |
| cli-export-2026-05-21-l2-l3 | CLI 헬퍼 export 폐쇄 (2026-05-21, L2→L3) | L4 | stable | full | static |
| cross-slice-mirror | Cross-slice 타입-레벨 mirror 단언 | L5 | stable | full | static |
| tests-integration-probe-test-ts | tests/integration/probe.test.ts | L4 | stable | missing | static |
| withgitsnapshot | withGitSnapshot | L4 | stable | full | integrated |
| repl-slash-ctx-mega-wire | REPL slash-surface ctx mega-wire (8 slash slots) | L3 | new | full | integrated |
| cli-runtime-feature-config-unification | CLI runtime feature-config unification (CLI-04) | L3 | new | full | integrated |
| cli-bootstrap-host-extraction | CLI bootstrap host extraction (CLI-01) | L3 | new | full | integrated |
| runrepairrounds | runRepairRounds | L3 | stable | missing | integrated |
| identity-mid-session-prompt-rebuild | ADR-0302 — /identity mid-session system-prompt rebuild (closes ADR-0291 last-mile) | L2 | new | full | integrated |
| thin-surface-headless-core | Thin-surface invariant + headless-core ratchet | L3 | new | na | static |
| side-conversation-port | SideConversationPort — CLI engine-internal leak closure (CLI-02) | L3 | new | full | integrated |
| cli-session-cmd-shim-removal | CLI session-commands shim removal (CLI-05) | L3 | new | full | integrated |
| slash-registry-split | Slash registry split — surface / session / app (CLI-03) | L3 | new | full | integrated |
| repl-host-slim-down | REPL host slim-down — lift 10 surface-adapter factories (CLI-06) | L3 | new | full | integrated |
| headless-second-consumer | Headless second-consumer proof (ARCH-07) | L3 | new | missing | integrated |
| surface-wire-r2 | ADR-0309 — Surface-Wire R2 (identity onChange + granular registry + per-tool auto-record) | L2 | new | full | integrated |
| surface-composition-wire-r1 | Surface composition wire — ADR-0291/0292/0293/0294 end-to-end | L3 | new | full | integrated |
| web-daemon-surface | `@/apps/web-daemon` — Bun.serve WS daemon publishing RuntimeSession | L3 | new | missing | integrated |
| web-frontend-surface | ADR-0316 — Web frontend surface (Vite + React + Tailwind SPA) | L2 | new | na | integrated |
| tauri-desktop-shell | Tauri macOS desktop shell — bun-daemon + screen-OCR sidecars + opt-in global hotkey (ADR-0317) | L2 | new | na | integrated |
| llm-0 | LLM 호출 0 | L3 | stable | missing | static |
| sticky-model-set-surface | /sticky-model SET surface — per-mode model slash command (ADR-0462) | L3 | new | full | integrated |
| quantabenchtimeoutms | QUANTA_BENCH_TIMEOUT_MS | L2 | stable | full | integrated |
| run-mode-expansion-ide-daemon | Run-mode expansion — ide + daemon (C1, ADR-0092) | L4 | stable | full | n-a |
| eval-five-tier | eval 앱 — 6-tier 검증 스택 (audit/synthetic/grounding/public/trajectory/compare) | L4 | stable | missing | static |
| eval-tier1-synthetic | eval Tier-1 — synthetic scenario runner + LLM judge | L4 | stable | missing | static |
| eval-tier2-grounding | eval Tier-2 — context grounding structured probe + live gate | L4 | stable | missing | static |
| eval-tier3-trajectory | eval Tier-4 — trajectory replay / classify / freeze (real-session corpus) | L4 | stable | missing | static |
| eval-tier4-compare | eval Tier-5 — A/B pairwise compare across CLI adapters (quanta/cursor/claude/aider) | L4 | stable | missing | static |
| quanta-home-meta-root | QUANTA_HOME — cross-cutting app-home root override | L4 | stable | full | integrated |
| adversarial-repro-knob | adversarial-repro — repro-quality adversarial coverage block | L3 | new | missing | integrated |
| agent-cli-args-parser | agent — pure argv parser (mode-discriminated, env-free) | L4 | stable | missing | static |
| agent-config-assembler | agent — unified AgentConfig assembler (12-lever wiring point) | L4 | stable | missing | n-a |
| agent-import-cycle-guard | agent SCC guard — Tarjan + module-top-level usage 차단 (deadlock 봉합) | L2 | stable | na | static |
| agents-fleet-panel | /agents — live subagent fleet panel (pure renderer) | L4 | new | full | static |
| architecture-invariants | 슬라이스 architecture invariants — biome (정적) + test (런타임) 이중 강제 | L4 | new | na | static |
| assemble-config | assembleConfig — per-turn AgentConfig composer (surface-agnostic) | L5 | stable | full | integrated |
| at-mention-autocomplete | @-mention autocomplete dropdown (CLI input) | L3 | stable | full | partial |
| bench-best-of-n-sampler | bench — Best-of-N sampler (N trajectories × patchVote) | L4 | stable | full | n-a |
| bench-cache-pathspec-ssot | Bench cache-shaped pathspec SSOT — patch-sanitizer prune-at-source | L4 | stable | full | static |
| bench-closure-repair-wiring | Bench closure repair wiring — phase policy + prompt augment | L4 | new | missing | integrated |
| bench-corpus-loader | Bench corpus loader — real SWE-bench vs synthetic layout detection | L4 | stable | missing | integrated |
| bench-eval-driver | bench — single-instance eval driver (sandbox + agent + verdict + diff) | L4 | stable | full | integrated |
| bench-eval-env-prep | bench — per-instance env pre-preparation (fail-fast on setupCmd) | L4 | stable | missing | integrated |
| bench-failure-classifier | bench — decisive 2-axis failure classifier (termination × signals[]) | L2 | stable | missing | integrated |
| bench-find-refs-steer | Bench find_references tool + steer — ripgrep replacement for lsp_references | L3 | new | missing | integrated |
| bench-full-remote-ami | Full-remote bench — prebaked AMI + artifact persist under benchHome | L3 | new | partial | integrated |
| bench-host-arch-detect | bench — host-architecture detection + Docker image inventory | L4 | stable | full | integrated |
| bench-in-loop-exec-knob | bench-in-loop-exec — agent runs tests in-loop vs submit-only posture | L3 | new | missing | integrated |
| bench-knob-presets-registry | Bench knob presets + inventory — frozen posture bundles + discoverability SSOT | L3 | new | missing | integrated |
| bench-knob-unit-display | Knob self-describing values — unit suffix in reports/presets | L3 | new | missing | n-a |
| bench-leaderboard-analyze | bench — leaderboard / verdict analysis + dashboard | L3 | new | full | partial |
| bench-observe-non-agent-evidence | bench — non-agent evidence emitter (sandbox / patch_generated / verify) | L4 | stable | full | static |
| bench-python-swebench | bench — official Python SWE-bench harness verifier (real grader) | L4 | stable | missing | integrated |
| bench-repair-context-builder | Bench repair-round context — seed message + cumulative-diff truncation | L4 | stable | missing | n-a |
| bench-simplicity-steer | Bench simplicity steer — minimal-mechanism philosophy (DEFAULT-ON) | L3 | new | missing | integrated |
| bench-stream-tap | Bench stream tap — SSOT for lastVerifyCmd / firstEdit / editCount signals | L3 | new | missing | n-a |
| bench-test-path-ssot | Test-path SSOT — shared isTestFilePath for patch sanitizer + dispatch guard | L3 | new | partial | integrated |
| bench-trajectory-record | Bench LLM trajectory recording — replayable JSONL cassette (default-OFF) | L3 | new | missing | integrated |
| built-in-slash-commands | Built-in slash commands (10) | L4 | stable | full | integrated |
| canvas-rich-diff-usage | Canvas rich DiffView (split + collapsible) + UsageBar legend (web) | L3 | stable | na | partial |
| ci-bot-mode-policy | agent — ci-bot mode preset policy (branch-only + no-MCP) | L2 | stable | missing | n-a |
| cli-attach-daemon | `quanta attach` — CLI → daemon shared-session WS client (ADR-0516) | L3 | new | full | integrated |
| cli-background-turn | Ctrl+B background-turn portal + /background (ticket-18 V1) | L3 | new | full | static |
| cli-help-discovery-render | CLI `/help` discovery — category grouping + env-var SSOT + virtual /image | L4 | new | full | integrated |
| cli-jun11-repl-input-ux | jun-11 REPL input UX — approval preflight, bracketed paste, automation inbox banner | L3 | new | full | integrated |
| cli-jun11-turn-input-layer | jun-11 turn + input layer — line editing, LLM replay cassette, PTY e2e harness | L3 | new | full | integrated |
| cli-lifecycle-pills | CLI lifecycle pills — subagent/follow-up/MCP 3-pill (conditional) | L4 | new | full | integrated |
| cli-logout-cmd | /logout — destroy on-disk ChatGPT-OAuth token bundle | L4 | stable | full | integrated |
| cli-model-picker | /model interactive picker + model↔effort clamp (Codex validateEffort mirror, ADR-0517) | L3 | new | full | integrated |
| cli-resume-state-machine | CLI `--resume` state machine — path-mode vs id-mode (ADR-0024 split) | L4 | stable | full | integrated |
| cli-retry-with-cmd | /retry-with — session-time model-swap slash command (ADR-0065 wire-up) | L4 | stable | full | integrated |
| cli-single-binary-build | bun build --compile → dist/agent single binary | L3 | stable | full | static |
| cli-slash-help | CLI `/help` unified menu — dynamic BUILTINS + keybinds + ENV knobs | L4 | new | full | static |
| cli-status-bar | CLI status-bar — DECSTBM scroll-region pinned bottom row | L2 | new | full | static |
| cli-status-command-runner | Scriptable statusLine runner — CC stdin contract, args-based spawn, ANSI-aware truncated first line | L3 | new | na | static |
| cli-status-pills | CLI status-pills chrome — Mode/Workspace/Sandbox/Skills/Rules (5-pill) | L4 | new | full | integrated |
| cli-turn-summary | CLI turn-summary box — tools/verify-guard/compaction/memory/recovery | L4 | new | full | integrated |
| color-palettes | Colorblind-safe color palettes (Okabe-Ito CUD SSOT) | L3 | new | partial | static |
| color-policy-resolver | ColorPolicyResolver (per-surface ANSI color cache) | L4 | new | full | integrated |
| completion-notify | Turn-completion terminal notification (OSC title + bell) | L3 | stable | full | partial |
| composition-root-mega-wire-2026-05-25 | Composition-root mega-wire — 11 subsystems, default-OFF (ADR-0236) | L3 | stable | full | integrated |
| context-warning-banner | Pre-compaction context-usage warning banner | L3 | stable | full | partial |
| dial-clamp-propositional | clampDials — propositional dial clamping with operator log | L2 | stable | full | static |
| doctor-selfcheck | /doctor startup self-diagnostic — pure check-registry over injected probes | L3 | new | full | static |
| dotenv-loader-first-wins | .env loader — first-wins, no-override, `export ` strip, no-deps | L5 | stable | full | integrated |
| eval-compare-pairwise-judge | eval Tier 4 — pairwise judge with bias-swap double pass | L4 | stable | missing | static |
| eval-public-swebench-bridge | eval Tier 3 — public bench bridge (SWE-bench Verified report → PublicPayload) | L2 | stable | missing | static |
| eval-storage-result-store | eval storage — JSONL append-only ResultStore (per-runId serialisation) | L4 | stable | missing | integrated |
| eval-synthetic-generator | eval Tier 1 — LLM-driven synthetic scenario generator (strict validation) | L4 | stable | missing | static |
| eval-synthetic-judge | eval Tier 1 — LLM-as-judge (per-rubric pass/fail + weighted score) | L4 | stable | missing | static |
| eval-synthetic-scenario-schema | eval Tier 1 — Scenario JSON schema + tolerant loader/parser | L4 | stable | missing | static |
| eval-taxonomy-classifier | eval taxonomy classifier — query → UseCaseId (LLM, JSON-block tolerant) | L4 | stable | missing | static |
| eval-taxonomy-doc-sync | eval taxonomy doc-sync — code → markdown one-way renderer | L1 | stable | missing | static |
| eval-taxonomy-tree | eval taxonomy — 12 major / ~120 leaf use-case tree (single source of truth) | L4 | stable | missing | static |
| eval-tier0-audit-grep-mapper | eval Tier 0 — static grep-mapper + curated rules + (major × CoverageLevel) matrix | L4 | stable | missing | static |
| eval-trajectory-diff | eval Tier 3 — structural projection diff (LCS over event kinds) | L4 | stable | missing | static |
| eval-trajectory-meta-source | eval Tier 3 — meta sidecar + JSONL session loader (no-heuristic policy) | L4 | stable | missing | static |
| external-editor-compose | External $EDITOR draft composition (ctrl-x ctrl-e) | L3 | stable | full | partial |
| fault-evidence-knob | fault-evidence — T-201 typed FaultEvidencePacket knob | L3 | new | missing | integrated |
| fc-baseline-ratchet | fc baseline ratchet — empty-stub / orphan-ADR 캡 + tsc/biome/test 측정 스냅 | L5 | stable | na | static |
| fc-check-changed-gate | fc check-changed — PR-time gate (new src/*.ts 는 fc evidence 등록 필수) | L5 | stable | na | static |
| fc-prose-bundles | fc prose bundles — intro + non-absorption 정책 MD 가 catalog 빌드 시 blend | L4 | stable | full | n-a |
| feature-catalog-tool | feature-catalog tool — `bun fc` CLI (build / validate / list / audit / lint) | L5 | stable | full | n-a |
| god-code-ratchet | dev — god-code SE-metric ratchet (detect oversized/over-coupled modules) | L3 | new | full | partial |
| headless-output-format-stream-json | Headless --output-format (text\|json\|stream-json) | L4 | stable | full | integrated |
| image-queue | ImageQueue — single-shot per-turn multi-modal image attachment | L4 | stable | full | integrated |
| init-scaffold-slash | /init — AGENTS.md / CLAUDE.md project-rules scaffold (gated) | L4 | new | full | integrated |
| inspect-cmd-toolcall-expand | `/inspect <toolCallId>` — 세션 JSONL projection + 확장 패널 (input/decision/result/recovery) (ADR-0239 Track I) | L3 | stable | full | partial |
| jun-11-surface-protocol-inventory | jun-11 surface-protocol truth inventory — AgentEvent / SessionProtocol / bridge / render coverage ratchets | L3 | new | full | n-a |
| jun7-cost-panel-per-model | Cost panel per-model breakdown (§23.5) | L4 | new | full | static |
| jun7-operator-transparency-slashes | /version · /release-notes · /bug operator transparency (§23.3/§23.4) | L4 | new | full | static |
| keybindings-config | User-customizable keybinding config layer | L3 | stable | full | partial |
| knobs-settings-web-ui | Web Settings UI (KnobsPanel) — daemon-backed knob inspect + live /config write | L2 | new | missing | integrated |
| localize-phase-knob | localize-phase — bench localize-phase opt-in (agentless retrieval pre-pass) | L3 | stable | missing | integrated |
| lsp-steer-knob | lsp-steer — LSP-nav grounding nudge on localize-phase block | L3 | new | missing | integrated |
| mode-cycle-pill | shift+tab permission/agent mode-cycle + input pill | L3 | stable | full | partial |
| mode-matrix-narrow-assert | narrowMode + assertModeMatrix — 48-cell defense-in-depth | L4 | stable | full | static |
| no-patch-breaker-knob | no-patch-breaker — T-501 post-localization commit rail knob | L3 | new | missing | integrated |
| paste-burst-placeholder | Paste-burst placeholder — large paste coalesced to `[Pasted Content N chars]` (Codex parity) | L3 | new | full | integrated |
| patch-budget-admission | Patch-budget — minimal-edit admission (over-engineer class guard) | L4 | new | missing | integrated |
| patch-hygiene-knob | patch-hygiene — T-401 PatchHygieneReport knob | L3 | new | missing | integrated |
| pm-definition-of-done | tools/pm — executable Definition of Done (catalog + TDD + e2e-hellgate gate) | L5 | stable | na | static |
| primary-rail-knob | primary-rail — T-302 primary-rail enforcement knob | L3 | new | missing | integrated |
| probe-failure-triage | probe — NON-authoritative failure triage (ordered rule-table hypothesis) | L4 | stable | missing | static |
| probe-funnel-adherence | probe — fault-localization 3-stage funnel adherence checker | L4 | stable | missing | static |
| probe-renderers | probe — plain-text renderers (`--failed` / `--slow` / `--cost` / `--json`) | L4 | stable | missing | n-a |
| probe-trajectory-parse | probe — trajectory JSONL + run-dir loader (forward-compat, never throws) | L4 | stable | missing | static |
| prompt-suggestion | Prompt-suggestion + quality reject-gate (ADR-0467) | L2 | new | full | partial |
| proof-driven-bench-closure | Proof-driven bench closure — ClosureBundle SSOT + diagnostics rail | L4 | new | missing | integrated |
| quanta-session-subcommands | `quanta session` subcommand suite — 10 lifecycle operations | L4 | stable | full | static |
| refresh-coordinator | RefreshCoordinator (ChatGPT-OAuth thundering-herd guard) | L4 | new | full | static |
| repair-escalation-knob | repair-escalation — T-601 multi-owner escalation knob | L3 | new | missing | integrated |
| repl-code-smell-cleanup | REPL code-smell cleanup — STATUS_FLASH config + string drift + silent-catch telemetry | L2 | new | full | integrated |
| repl-heuristics-inventory-audit | REPL CLI heuristics inventory — DOC/ENV/ARBITRARY audit | L2 | new | full | static |
| repl-interactive-surface | Interactive REPL (continuous conversation + in-REPL slash routing) | L4 | new | full | static |
| repl-mcp-surface-wire | REPL `/mcp` surface translator (live CLI state → structural snapshot) | L4 | stable | full | static |
| repl-orphan-resolution | CLI repl/ orphan modules — Slice B truth-up & prune | L4 | stable | full | n-a |
| repl-prompt-source | REPL `PromptSource` adapter — slash short-circuit + raw-line reader | L4 | stable | full | static |
| replay-cmd-session-rewind | `/replay <session-id> [--at N] [--from tc_x]` — 세션 JSONL 시간순 재생 (ADR-0239 Track R) | L3 | stable | full | partial |
| repro-doubt-knob | repro-doubt — break verify_loop_stuck with repro-test suspicion steer | L3 | new | missing | integrated |
| repro-oracle-gold-calibration | repro-oracle gold calibration — EVAL-ONLY false-negative diagnostic | L3 | new | missing | integrated |
| repro-test-mwe-vote | Repro MWE extraction + K-of-N resolved vote gate | L4 | new | missing | integrated |
| repro-test-slice | Repro-test pipeline — Agentless §3.3.1 generate / execute / select | L4 | stable | full | integrated |
| retry-transient-knob | retry-transient — bench per-instance transient-failure retry cap | L3 | stable | missing | integrated |
| runner-session-ops | runner/session-ops — surface-agnostic `quanta session …` dispatcher | L4 | new | full | integrated |
| session-index-store | Session `index.jsonl` directory — atomic upsert + in-process mutex | L4 | stable | full | static |
| session-root-provider-port | SessionRootProvider port — multi-tenant session-root abstraction | L4 | stable | full | static |
| shadow-odb-lru-cleanup | Shadow-ODB per-workspace LRU eviction (best-effort, scope-fenced) | L4 | stable | full | static |
| slash-branches-progress | /branches — speculative N-best branch-search progress | L4 | new | full | integrated |
| slash-cost-panel | /cost — cumulative session cost panel | L4 | new | full | integrated |
| slash-history | /history — recent turns + tool-call breadcrumb | L4 | new | full | integrated |
| slash-mcp-explorer | /mcp — MCP server + bridged-tool explorer | L4 | new | full | integrated |
| slash-memory-browse | /memory — browse / recall / search / delete durable memory | L4 | new | full | integrated |
| slash-permission-inspect | /permission — Codex 5-axis permission stack inspector | L4 | new | full | static |
| slash-plan-panel | /plan — read-only plan-store visualization | L4 | new | full | static |
| slash-queue-per-msg-mutators | /queue per-msg manage (ADR-0228 — Codex composer parity) | L4 | new | full | n-a |
| slash-rules-indicator | /rules + rule-pill — repo-local rule inventory indicator | L4 | new | full | integrated |
| slash-snapshot | /snapshot — Shadow-ODB snapshot list / rewind / partial restore | L4 | new | full | static |
| slash-web-paste-edit | /web + /paste + /edit-plan + /edit-message (ADR-0224/0225) | L4 | new | full | integrated |
| slash-working-state-panel | /state — WorkingState L3 scratchpad visualization | L4 | new | full | static |
| slashcontext-r10-ports | SlashContext R10 ports — 5 default-OFF surface seams | L4 | new | full | static |
| slashctx-6-ports-wire-completion | SlashContext 6-port wire-up (S3 deferred-wire closeout) | L4 | new | full | integrated |
| slice-auth-chatgpt-oauth | `@/auth/chatgpt-oauth` 슬라이스 — PKCE + JWT + token-store + refresh + callback port | L4 | new | full | integrated |
| slice-ipc-bridge | `@/ipc` 슬라이스 — CLI ↔ Web ↔ Tauri EventBridge + portable session | L2 | stable | missing | static |
| slice-runner-layer2 | `@/runner` 슬라이스 — surface-agnostic Layer-2 오케스트레이션 | L4 | new | full | integrated |
| slice-ui-helpers | `@/ui` 슬라이스 — surface-agnostic ANSI/box helpers (former auth-ui) | L4 | new | full | static |
| snapshot-slash-cmd | /snapshot — shadow-store snapshot/restore/diff slash command (ADR-0122) | L4 | new | full | static |
| spec-fidelity-steer-knob | spec-fidelity-steer — gap-B minimal-literal-fix steer knob | L3 | new | missing | integrated |
| swebench-matrix-runner | SWE-bench A/B matrix runner — 3-axis 2^3 condition sweep (LSP × subagent × skills) | L4 | stable | na | integrated |
| swebench-python-uvx-shim | tools/bin/swebench-python — uvx ephemeral python shim | L4 | stable | full | integrated |
| thin-client-dispatch | thin-client dispatch routing — one command, per-surface local/post-text/control-request (ADR-0493) | L3 | new | full | integrated |
| thin-surface-loop-hoist-cli-agent-relocation | Thin-surface increment — turn-driver hoist + cli→agent launcher relocation | L3 | new | full | integrated |
| thread-follower-cocontrol | thread-follower co-control — timeout-bounded follower verbs (steer/interrupt/approval-relay) + queue-mode invert (T02) | L3 | new | full | integrated |
| timeline-panel-split-screen | split-screen live AgentEvent timeline panel (`QUANTA_TIMELINE=N`) (ADR-0239 Track T) | L3 | stable | full | partial |
| verification-plan-knob | verification-plan — T-301 typed VerificationPlan knob | L3 | new | missing | integrated |
| web-slash-readout-http | Web slash readouts — GET /readout/:name out-of-band HTTP (jun-9 parity Phase 1) | L2 | new | missing | n-a |
| with-worktree-runtime-primitive | withWorktree — throwaway git worktree HOF + transient-lock retry | L4 | stable | full | static |
| worktree-fork-primitive | Persistent worktree primitive — createPersistentWorktree / removeWorktree | L4 | stable | full | static |
