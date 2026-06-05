# Feature Catalog — 기능별 설명/Use-case (jun-06 자동생성)

871 feature를 카테고리별로, 각 feature의 `purpose`(목적·동작·흡수출처)를 추출. 🆕=new ⏸=hold ✨=refined.

---
## 01-agent-loop

###  4-section system prompt + per-section cache_control breakpoints
Claude Desktop 1.7196.3의 systemPromptSectionCache 패턴 흡수 — 30-50 KiB 단일 cached SystemBlock 대신 base + project_md + session_ctx + user_append 4-section named/byte-stable 분할로 각 section에 cache_control breakpoint 부여(Anthropic 4-breakpoint cap에 정확

###  ConversationAction — typed mid-turn user action oneof (5-arm)
Cursor ConversationAction oneof 흡수 — 기존 단일 free-text SteerRequest 위에 5-arm 타입드 액션 레이어를 PURE + ADDITIVE + DEFAULT-OFF로 적층. ConversationAction = user_message{prepend[]} / cancel{reason} / cancel_subagent{subagent_id} / summarize / resume. �

###  Agent-loop branch hardening — refusal / thinking carry-over / deny-and-steer
docs/analysis/code-agent-loop/{claude,codex,cursor}.md 3-doc gap analysis로 식별한 runAgent loop의 4개 결함 중 3개 shipped + 1개 deferred. Gap-1 — Provider refusal/abnormal stop: decideOnAssembled에 stopReason==="refusal" 신규 브랜치(max_tokens / tool_use / emp

###  Phase marker + TTFT + readonly deny-steer trio
하나의 PR로 3개의 직교 신호를 흡수 — 각각 다른 plane(data / observability / control)에서 누락된 declared 답을 구조적으로 확보. 모든 의사결정이 producer가 이미 선언한 shape에 대한 closed discriminated-union match (Tool.isReadOnly(),

###  tool_choice forcing as an orthogonal control gate (pre-call plane)
사전 호출 평면(pre-call plane)으로 모델의 tool_use 선택 자유도를 게이트. admissibility-gate(사후/post-call)와 직교(orthogonal): 두 평면이 같은 tool_use 경계의 반대쪽에서 동작. resolveToolChoice(signals)는 순수 함수 (IO 0, no clock, no

###  IDE context provider seam (ADR-0080)
IDE host (VS Code extension, MCP IDE bridge 등) 가 turn-by-turn 에디터 상태를 모델에 보낼 수 있는 단일 진입점. 신규 `src/agent/ide-context.ts` 의 닫힌 shape `IdeSnapshot` (activeFile/openTabs/selection/diagnostics, 모든 필드 optional) + `IdeContextPr

###  EffectChannel — relocatable effect boundary (ADR-0093 M1 keystone)
Cursor의 cursor-agent-exec 분리 구조적 교훈 흡수 — 오케스트레이션 평면(permission/HITL/ plan-exit/hook)과 효과 평면(`registry.run`)을 typed `ToolRequest`/`ToolResultEnvelope` oneof로 격리. 같은 콜 사이트에 LocalEffectChannel(in-proc, M1 defaul

###  System-prompt git posture (default fail-closed)
System-prompt section that establishes default-NO mutation posture for git in the model's instructions. Free read-only inspection (status/log/diff/blame/ show/grep/ls-files) is allowed; commit/push/branch/merge/rebase/cherry-pick/ reset/restore/mutating-checkout/stash/tag require

###  cfg.fourRule:true


###  Plan-mode dispatch-seam mutating block


###  Per-thread queued follow-ups with PausedReason
Per-thread FIFO follow-up queue with multi-thread isolation and serializable snapshot/restore. 10 explicit PausedReason values — popReady delivers iff pausedReason === null; documented condition per reason; drain at thread close. L4 (2026-05-23): loop가 매 턴 시작 시 poll

###  safe 도구 스트림 중 즉시 디스패치


###  transient backoff / PTL→compact / max_tokens / malformed / empty


###  'verifyGuard: {}'


###  while


###  Refusal stop_reason typed surface
Replaces the lossy generic-error supersession of provider-side refusals with a typed StopReason variant. extractRefusalRationale lifts the rationale from the provider envelope; recovery.decideOnAssembled emits a refusal action; the loop finishes with kind="refusal" and AgentOutco

### 🆕 Plan-queue — typed mid-turn follow-up primitive
Typed primitive that lets a host accept user input while a turn is in flight and dispatch the queued items on the next turn boundary. Captures FollowUp context (pausedReason / arrivedDuringTurn / source / …) so a replayer can judge staleness. Pure helper — wiring into loop di

###  maxTurns


###  Precedence rule (R3-P1)


###  stream_reset


###  test_runner


### 🆕 System-prompt mode-variant registry — 6-mode identity table + builder seam
3-vendor (Cursor / Claude Code / Codex) 시스템 프롬프트의 mode-별 identity line 흡수. ADR-0198 identity 슬라이스 위에 SystemPromptVariantRegistry 포트를 신설 — 6 mode (default/ plan/review/audit/architect/editor) variant 테이블을 closed-port로 제공.

### 🆕 Devin playbook spec → bun:test fixture auto-generation
Devin Playbook의 `spec` 필드 흡수 — spec → bun:test fixture text 1개를 생성하는 작고 닫힌 포트. quanta 는 ADR-0203 에서 `successCriteria[]` 와 `procedure[]` 를 선언적으로만 받았고, 이를 실행 가능한 test code 로 자동 변환하는 슬라

###  completed|max_turns|aborted|error


###  decideVerifyGuard


###  nudge/completed 전 디스패치된 read-only 결과 폐기


###  src/agent/closeout-guard.ts


###  QUANTA_VERIFY_GUARD


### 🆕 bash/edit/write describe steering + when-not-to-use + 2 few-shot examples (ADR-0410)
Codex 0.131.0-alpha.9 SHELL.md + Claude Code 2.1.138 tools/{Bash,Edit,Write}.ts + Cursor 3.2.16 tool-choice-discipline 3-벤더 수렴 기반 prompt steering. bash describe에 "read/grep/edit 우선, bash는 한 번 shell 명령으로 끝나는 케이스만" 명시(bash 남용 �

### 🆕 Per-subagent model / role / effort override
A parent can assign a specific model and/or dispatch role and/or effort tier to a child it spawns via the `agent` tool (Cursor SubagentModelOverride: a planner on a deep-reasoning model delegating edits to a fast minimal-diff model). Threaded end-to-end: (1) SubagentRequest gains

###  Mid-turn steering + NonSteerableTurnKind + 8 closed rejection reasons


### ✨ Plan 모드 3-way exit (approve / reject / request-changes)
v0.dev PlanModeExit{Approve,Reject,RequestChanges} 흡수 — plan 모드 종료를 기존 2-way(approve/reject)에서 3-way로 확장. changes_requested는 feedback 필수(빌더가 강제, 위반 시 throw)이며 agent가 plan을 수정하고 plan posture 유지(planExitStaysIn

###  Submission op envelope (6-variant) + legacy messages→Submission adapter
Codex `Submission { id; op }` / `Op` discriminated union 흡수. host→agent 입력을 6-variant 닫힌 union으로 모델링: user_input / user_input_with_turn_context / interrupt / cancel_subagent / shutdown / reload_user_config. 순수 adapter submissionFromMessages(레거시

###  StopCategory matrix (3-layer kind/reasonCode/hint) + AgentOutcome.stopCategory
Cursor stop_category 흡수 — 레거시 4-element StopReason을 보완하는 3-layer 구조적 정지 사유: kind(completed|max_turns|interrupted|failed|needs_user_approval) + 닫힌 STOP_REASON_CODE 테이블(provider.{rate_limit,overloaded,network,auth,bad_request,unknown} /

###  Tool-failure ladder + multi-step exploration prompt rules
라이브 REPL replay에서 발견한 두 결함을 시스템 프롬프트 규칙으로 봉합 — (1) 단일 도구 cap 메시지("+292 deeper, increase max_depth", "raise max_files", "result truncated")를 능력 경계로 오해해 "I can't"로 surrender, (2) "분석해줘"/"�

###  Prompt template SOTA++ — 4 strengthening sections (Codex/Claude parity)
Codex base prompt (L26/L213-214/L217/L471) + Claude Code 1.7196.3 systemPromptSectionCache side-by-side 감사로 식별한 4개 갭을 닫음. (1) Internal-vocabulary 차폐 — turn_id / runtime / HARD_DENY / ADR-XXXX 등 호스트 내부 토큰을 사용자에게 노출 금지

###  Persona slot — Codex {{ personality }} Handlebars absorption
Codex Desktop base_instructions의 `{{ personality }}` Handlebars 슬롯 흡수. 3-arm 닫힌 enum PersonaKind = default | friendly | pragmatic. `default`는 빈 본문(byte-identical pre-ADR 프롬프트, 모든 snapshot/prefix-cache hit 보존). 비-default 본문은 톤 가이

###  TurnSession / TurnState parameter bundles (R2-B P1, 20→3 args)
`runTurn`/`streamConsume`/`applyAction`이 17-20 positional parameter로 자란 부채를 두 readonly 번들로 정리 (R2-B P1). `TurnSession` — session-lifetime resources (config/specs/recorder/classifier/skillGate/activeSkills/archive/guards), `runAgent` invocation당 ONCE 

###  GuardChain — verify + closeout turn-exit guards unified pipeline
verify-guard와 closeout-guard가 SAME 컨트롤 포인트(`applyAction` → "모델이 finish 하려 한다")에서 SAME 액션 (block finish, append `metaUser(...)` nudge, return CONTINUE)을 emit하는 중복 형태를 단일 chain framework로 collapsing. 각 guard는 pure `d

###  createStreamDispatcher factory (P3, byte-identical extraction)
`streamingTurn`이 loop의 stream seam에서 소비하는 `StreamCallbacks` 레코드 생성 로직을 loop.ts inline 본문에서 `stream-callbacks.ts#createStreamDispatcher` 로 추출 (commit 047238f, P3). Pure factory: 반환 클로저가 `TurnSession` / `TurnState` / `TurnTi

### 🆕 dispatch core — tool-call seam (admissibility + result shaping)
`src/agent/dispatch.ts` — `ToolRegistry.run()` 직전/직후 모든 deny/permit 결정 + result shaping 을 한 곳에 모은 dispatch seam 의 본체. 코어 루프 (`loop.ts`) 는 본 모듈만 호출하면 되도록 6 가지 cross-cutting concerns 가 하나의 진입점에�

### 🆕 checkDispatchAllowed — pure dispatch-seam mutating-tool guard (ADR-0036)
ADR-0036 (Cluster D Feature 1) — `ToolRegistry.run()` 직전에 호출되는 pure 함수로, 활성 collaboration mode (default / plan) 하에서 해당 tool 호출이 허용되는지 결정. throws 가 아닌 tagged `DispatchAllowedResult` 반환 — caller (`dispatch.ts`) 는

### 🆕 Tier-1 builders → per-subsystem composer (9 builders SRP split)
`src/agent/features.ts` (393 LOC of SessionFeatures 합성 GodFn) 을 9 개 per-subsystem builder + composer 로 분해. 각 builder 는 ONE optional config block → ONE concrete 런타임 object (or `undefined` 으로 byte-identical default-OFF 보존). 9 builders (`src/agent/t

### 🆕 Codex agent nickname pool (39) + agent_role 4-arm enum
Codex `core/src/config/agent_roles.rs`의 nickname_candidates 39-entry 풀과 `agent_role` enum (explorer/worker/none) 흡수. quanta 서브에이전트에 stable identity 부여 — 부모는 (nickname, role) 페어로 transcript label / 정책 라우팅 / SQLite durable column�

### 🆕 types.ts cohesion split (4 sub-modules, byte-identical)
`src/agent/types.ts` (875 LOC) 의 cohesion split — 응집도 높은 4 묶음을 `src/agent/types/` 하위 모듈로 분리하고 root `types.ts` 는 re-export 보존 해서 132 consumer 영향 ZERO. 4 sub-modules: - `agent-outcome.ts` — `AgentOutcome`/`RedactionRollup` 등 s

### 🆕 AFK away-summary — <40-word recap on user return
When the user steps away from an in-progress session and returns, generate a tiny recap so they re-orient without re-reading the transcript (Claude Code 2.1.150 away-summary, faithfully absorbed). The slice (src/agent/away-summary, imports @/shared ONLY) owns: (1) the VERBATIM sy

###  AWF 2-matcher PreToolUse hook


###  Branch-search Shadow-ODB anchor + pure progress formatter (ADR-0116)
Two leaf modules that complete the speculative branch-search slice. (1) `BranchSearchAnchor` — closed port wiring the Shadow git ODB (ADR-0108) into branch search as an opt-in, NO-THROW anchor + per- candidate delta measurement port. Without it, branch search runs N isolated ca

### ✨ Cap-as-instruction enforcer — 3rd-channel NextAction adherence
Session-scoped state machine that detects when the model IGNORES a tool's `NextAction` hint by re-calling the same `toolName:targetPath` without applying the suggested parameter change. Closed-union over `NextAction.kind` (`increase_max_depth` / `raise_max_files` / `narrow_path`)

### ⏸ CLI REPL GodClass → SOLID split (abandoned in-place; orphan tree pruned)
**Status truth-up (Slice B, 2026-05-25):** the 21-module split landed at commit `acb8d187` was NEVER wired into `src/apps/cli/repl.ts`. Verified by grep: zero importers in src/ or tests/ for any `./repl/*` path other than the standalone `mcp-surface-wire.ts` translator. `repl.ts`

### 🆕 CLI turn-indicator — spinner + elapsed + live token counter
LLM 대기 중 spinner + elapsed seconds + live token counter(input/output 누적) 표시. StreamPort tee 패턴으로 구현 — streaming-dispatch 본체 무수정, 새 StreamPort 어댑터가 기존 어댑터와 fan-out으로 병렬 소비한다. TTY 미감지 시 자동 OFF(�

###  Compaction circuit breaker — rapid-refill + consecutive-failure guard
Pure deterministic state machine that mirrors Claude Code v2's two compaction guards: (1) rapid-refill breaker — when the context refills to the limit and re-compacts with no real headroom gained, abort the turn with reason `rapid_refill_breaker` rather than spin forever on an 

###  Cross-subagent todo readback (Roo bidirectional extension)
Roo absorption — bidirectional extension of ADR-0219 focus chain. Where ADR-0219 only re-injects parent todos every N turns (one-way, single session), this slice lets any session snapshot another session's todos and lets a child session write updates that the host explicitly pr

###  Pre-flight dispatch dedup gate (T3 SOTA++ verify-loop stuck fix)
Bench Type F("Verify-Loop Stuck on Env") 구조적 fix — 동일 (tool name + canonical args) 호출이 sliding window 안에서 중복으로 들어오면 dispatch 전에 차단하고 synthetic observation block으로 단락. Pure deterministic state machine, no I/O. Rapid-refil

### 🆕 ADR-0229 DispatchGuard — 3-detector pre-flight composer (gitWriteProtect/branchOnly/hostAllowed)
Cursor 강신호 — 3 pure detector (gitWriteProtectReason, decideBranchOnly, isHostAllowed) SHIP됐는데 dispatch seam 미배선이던 갭. DispatchGuard port + default-guard 합성 (가장 보수 결정 win: deny > ask > allow) + admissibility-gate pre-flight 1줄 wire. defau

###  Effort 5-tier session dimension


### 🆕 ADR-0217 Typed error enum 16-variant + 5-action retry router (Codex)
Codex 16-arm typed enum 흡수 + 5-action retry routing. 분류: contextWindowExceeded / usageLimitExceeded / cyberPolicy / httpConnectionFailed / httpStatusCode / responseStream{Connection,Disconnect}Failed / responseTooManyFailedAttempts / internalServerError / unauthorized / b

###  ADR-0198 Identity slot — per-mode system prompt identity lines
Cursor + Claude + Codex 3-vendor 강신호 흡수. quanta 단일 "You are Quanta..." 시스템 prompt를 mode (default/plan/review/audit/onboarding) 별 identity 라인으로 분기. `buildSystemPrompt(opts.identity?)` 슬롯에 splice (persona 직전). closed-port `IdentityProvi

### 🆕 idle-monitor — 60s suppress + 5min snooze + 20-deny auto-exit (Cursor 3.2)
Cursor 3.2 §4.1/§4.2/§5 패턴 흡수: idle-monitor + snooze + reject-counter. 60초 무입력 시 자동 suppress(추가 LLM 호출 정지), /snooze 슬래시로 5분 동안 알림/턴 진행 일시정지 (disk-persistent — 재시작 후에도 유지), 사용자 거부 20�

### 🆕 Inline-trigger watcher — Aider-style source-comment dispatch primitive
The smallest reusable primitive for Aider-style `// fix this AI!` source-comment dispatch. Closed `InlineTriggerWatcher` port + Subscription handle, production `node:fs.watch` adapter, deterministic headless stub, pure helpers (debouncer + comment-scanner). Distinct from the sibl

### 🆕 N-phase HITL state machine (plan-exit-flow 일반화)
Cursor AiProjectService(8)의 N-phase 상태머신(init→clarify→plan→feedback →breakdown→...) 패턴 흡수. ADR-0063 plan-exit 3-way를 N-phase 시퀀스 + per-phase feedback gate로 일반화. closed-port (NPhaseDriver { current, transition, feedback }) + default-OFF 

###  Plan-exit flow orchestrator (ADR-0062 wire-up)
Plan-exit three-way (approved/rejected/changes_requested)의 셋 평면을 잇는 pure async orchestrator. 이미 shipped된 3개 조각 — plan-exit decision (62-plan-exit-three-way), plan store mutation (PlanStore.clear/freeze/preserve), follow-up router — 을 하나의 rout

### ⏸ Plan-queue — mid-turn user input capture/replay (Codex absorption)
Pure in-memory queue of follow-up user inputs captured WHILE a turn is in progress, replayed when the turn ends. Codex's unique `queued-follow-ups` pattern — no other modern agent has it (Claude Code / Cursor / v0 freeze the UI mid-turn). quanta absorbs the STRUCTURAL surface: 

### 🆕 Plan-writeback — bidirectional skill ↔ plan sync (ADR-0259)
Devin playbook 실행 중 skill 이 발견한 finding (discovery / blocker / opportunity) 을 plan 객체에 직접 mutate 하지 않고 사이드 큐에 typed 로 적재해, 호스트가 다음 plan re-render 경계에서 consume 하도록 하는 닫힌- 포트 슬라이스. qua

### 🆕 Playbook nesting — bounded recursive call chain with cycle detection — ADR-0258
ADR-0203의 macro 1-pass invariant 위에 직교적으로 추가되는 슬라이스 — procedure-level "playbook A가 playbook B를 호출 + 결과 변환" 패턴을 bounded recursion + 명시적 cycle detection으로 봉합한다. Devin Playbook 의 두 번째 recursion 형태 

### 🆕 prompt history + reverse-i-search + heredoc multiline
REPL 입력 UX 강화 — bash 스타일 ↑/↓ history navigation + Ctrl+R reverse-i-search + heredoc 멀티라인 입력. history는 disk-persistent(파일 경로 env override). multiline은 heredoc 종료 토큰까지 누적 후 한 번에 PromptPayload로 제출. raw-line-re

###  Prompt-rules per-mode pack registry + mode dispatch
6 verbatim CORE_RULES (R-ENV / R-STOP-ENV / R-SEARCH-FIRST / R-READ-FAILURE / R-NO-THRASH / R-NO-SHIM / R-FAILURE-MODE) + 4 mode-specific packs (assistant / task-runner / benchmark / pr-agent). Stable `[R-…]` IDs are inline in the rendered text so anti-regression tests pin them

### 🆕 ADR-0242 stop_reason 8-arm typed router (Cursor 3.2.16) — surface/abort/hitl/continue
Cursor 3.2.16 흡수 — provider `stop_reason` 8-arm vocabulary 전체 (end_turn/tool_use/max_tokens/refusal/pause_turn/error/content_filtered/ guardrail_intervened) 를 closed-port 타입 라우터로 분기. quanta 기존 `decideOnAssembled` 은 3-arm 만 다루고 5 arm 은 s

###  response.in_progress streaming event


###  dispatchSideConversation — external request/response router seam
UI/CLI/RPC-facing seam decoupling external callers from the executor's `SideConversationOptions` shape. Callers describe WHAT they want via `SideConversationRequest` (parentSessionId / question / effort / model hint); the host-supplied `SideConversationResolver` decides which LLM

###  Side-conversation prompt — Codex base + delimiter + quanta addendum
Three frozen constants implementing the byte-identical prompt invariant for the side-conversation seam. `SIDE_CONVERSATION_PROMPT_BASE` is the verbatim Codex side-conv prompt (build 2867 round-4 §G) — DO NOT MODIFY; the unit test asserts `toBe(...)` against the exact literal s

###  Side-conversation read-only sub-thread seam


###  spawn_batch — structured subagent fan-out (one templated child per item)
Single structured fan-out tool: items[] (inline) XOR items_path (.csv/.jsonl/.json, parsed inline — no CSV dep) + a prompt_template with {{key}} placeholders ({{item}} for string items, {{{{ }}}} for literal braces) → N templated child runs over a bounded worker pool. Codex s

### 🆕 streaming-boomerang — Roo Boomerang async-iterator progressive consumption (ADR-0251)
Roo Boomerang/Orchestrator의 streaming 분기 흡수 (ADR-0218 result-only sibling). 부모가 child subagent의 progress chunk를 점진적으로 consume하는 AsyncIterable surface. closed 3-arm BoomerangChunk (progress / result / error 6-arm) + closed port + default-OFF. Asyn

###  list_agents + followup_task — subagent introspection (enumerate + deliver-and-trigger)
Two Codex multi_agents_v2 tools absorbed. list_agents — read-only, concurrency-safe enumeration over TaskRegistry.list() (snapshot copy); 4-status registry union narrowed to a 3-bucket view (running/settled/failed); prefix filters by id OR label; includeSettled toggles finished

### 🆕 Subagent bounds — tool namespace / wait-timeout clamp / concurrency cap
Three opt-in subagent hardenings from Codex's multi_agent_v2, all default-OFF = byte-identical. (B1 tool_namespace) a closed ToolNamespaceStrategy injected into SubagentRunnerOptions: when set, a spawned child's filtered ToolRegistry is rewritten so each tool name is scoped (defa

### 🆕 Template-literal `{{ variable }}` expander — Windsurf workflow parity (sibling to ADR-0203 !macro)
Windsurf workflow `.windsurf/workflows/<name>.md`의 jinja2-style `{{ name }}` 치환을 흡수. ADR-0203의 `!macro` (1-pass, no-recursion) expander는 Devin Playbook 어법에 맞춰진 surface — `{{}}`는 다른 grammar (no left-boundary requirement), 다른 lookup (dotted-p

### 🆕 ADR-0206 Per-thread dynamic tools + defer_loading
Codex thread-scope dynamic tool 등록 + MCP server별 namespace + lazy factory 흡수. ThreadToolRegistry (register/list/resolve/evict/evictNamespace) + DynamicToolSpec.deferLoading 옵션 (lazy factory single-flight) + composer (global + per-thread merge, per-thread wins by nam


---
## 02-tool-system

###  Prefix-rule matcher — longest-prefix-match + ASCII-space word boundary
Deterministic longest-prefix-match over a single rule set. (1) Normalise by stripping LEADING whitespace ONLY — trailing whitespace and internal spacing are preserved so a rule cannot be bypassed by appending spaces (e.g. `git commit -m "msg "` matches as written). (2) Sort rul

###  git_commit + git_branch_switch — 1급 mutating git tools with WIP checkpoint
Claude Desktop 1.7196.3의 commitWipForBranchSwitch 패턴 흡수 — git push/commit/checkout을 bash 통과 + always-confirm 일괄 게이팅하던 구조에서 도구 단위로 1급화. (1) git_commit({ message?, mode?, paths? }) — mode="regular"(default)는 message 필수 +

###  defineTool — output-schema + toModelOutput + deferred + streaming-input
v0.dev createProviderToolFactoryWithOutputSchema 흡수 — Tool에 4개 OPTIONAL 능력 추가: outputSchema(결과 Zod 검증, 불일치 시 ok:false retry-지시), toModelOutput(모델용 compact 표현 분리로 토큰 절약), supportsDeferredResults(장기 도구 deferred h

###  shell_output_delta — typed event stream for long-running shell exec
src/runtime/shell.ts의 runShell이 child process stdout/stderr를 buffered string으로만 반환하던 것을, 옵션 `onShellEvent` observer 시 closed discriminated `ShellExecEvent` union (start|stdout|stderr|exit|aborted)을 실시간 emit. observer 부재 ⇒ legacy buffere

###  Multi-modal 이미지 입력 (dual-provider)
ContentBlock에 ImageBlock 추가 — 스크린샷·다이어그램 입력. 두 어댑터가 각자 native 형태로 직렬화: Anthropic {type:image, source:{base64}}, OpenAI content-array {type:image_url, image_url:{url:"data:..."}}. CLI --image <path> (repeatable, png/jpeg/web

###  CODE_MOD_CLOSEOUT_REMINDER


###  edit


###  'evidence?: ToolResultEvidence'


###  git_diff


###  isConcurrencySafe


###  isRegex:true


###  <persisted-output>


###  Promise.race


###  read/write/edit (primitive tool family umbrella)
Aggregate L5 marker for the primitive tool family covering 9 core tools — read, write, edit, bash, grep, glob, localize, diagnostics, test_runner. Individual L4/L5 catalog entries cover specifics: grep-tool (107), glob-tool (108), bash-tool-hitl-tier (109), edit-fuzzy-ladder (1

###  gh_pr_blame — PR review-thread blame
gh CLI tool that maps PR review-thread comments onto file:line anchors — one step beyond commit blame ("who last touched this line" → "what did reviewers say about this line"). Filters by optional file path and/or line number with ±5 line proximity. Parses gh pr view --json 

###  gh_pr_review_diff / gh_pr_auto_merge / gh_pr_create.draft
Three typed PR operations on top of gh CLI — review diff fetch with byte cap (default 64 KiB, schema cap 1 MiB, truncation marker on overflow), auto-merge toggle, and a draft option on gh_pr_create. Closes typed gaps relative to external reference desktop agents' PR IPC surface

###  read_image tool + ToolResult.images field + composer helper
read_image tool that loads a local image, verifies the format via a magic- byte SSOT (cannot be spoofed by extension), and surfaces the image through a new ToolResult.images field plus a composer helper that injects the image into the next provider request. Enforces a 5 MB per-im

### 🆕 pdf_read — native Anthropic document-block attachment (ADR-0137)
PDF reader that ships ZERO client-side text-extraction dependency. Every other modern agent (Cursor / Codex / Cline) pulls `pdf-parse` / `pdfjs` and stitches OCR; we instead emit a typed `DocumentBlock` (base64 + `application/pdf` mediaType) on a new `ToolResult.documents` field 

###  xlsx_read + docx_read — real pure-TS OOXML readers (ADR-0137 / ADR-0138)
REAL `xlsx_read` + `docx_read` document readers. jun-04 resolved the ADR-0138 deps blocker WITHOUT a dependency: `node:zlib.inflateRawSync` (via the H14b authoring slice's `unzip`) handles DEFLATE entries, and a focused OOXML parser resolves cells / paragraph text. Reads BOTH STO

### 🆕 yaml_read — pure-TS YAML document reader (ADR-0137)
First-class YAML reader closing the de-facto config-file gap left by ADR-0133's csv/ndjson slice. Single pure-TS dep (`yaml@2.x`, ~50 KB), no native binding, no spawn. Path safety mirrors ADR-0126's `read_image` posture: lstat symlink-leaf reject, `..` segment block, absolute pat

### 🆕 LSP 4-tool expansion — code-action / rename-apply / format / signature-help
Expands the Codex-absorbed ADR-0015 read-only LSP nav surface (8 nav tools) with 4 mutating + signature-help capabilities the model previously had to fake via raw bash/sed: 1. code_action — quickfix/refactor/organizeImports/fixAll suggest+apply 2. rename_apply — real textDocu

### 🆕 Wire finalization — web-search env factory + document-tools default registration (ADR-0142)
Surgical 2-part wire-up closing seams deliberately left open by ADR-0127 / 0133 / 0137. (A) `providerFromEnv(env)` — env-driven `WebSearchProvider` factory with precedence `BRAVE_SEARCH_API_KEY` > `QUANTA_WEB_SEARCH_DUCKDUCKGO=1` > undefined. Composition root keeps explicit `Ag

### 🆕 LSP default-adapter real wire — code-action / format / signature-help / applyWorkspaceEdit (ADR-0143)
Promotion-path closer for ADR-0141: replaces the three `not-implemented` default adapters (code-action / format / signature-help) with real `LspClient` delegations. Adds 4 wire methods to `LspClient` (`requestCodeActions` / `requestFormatting` / `requestSignatureHelp` / `applyWor

### 🆕 csv_read + ndjson_read — text-format structured-data tools (ADR-0133)
First modern coding agent to ship built-in structured-data tools (Cursor / Claude Code / Codex all shell out to cat/awk/jq). Closes 3 silent-corruption hazards in the bash baseline: (1) malformed CSV (unterminated quote, embedded newline) yields wrong column count; (2) one bad ND

### 🆕 Web search provider impls — Brave primary + DuckDuckGo fallback (ADR-0133)
ADR-0127 landed the `web_search` tool + `WebSearchProvider` closed port but shipped zero concrete impls — production behavior was `ok:false "no web_search provider wired"` graceful degrade. This ADR closes that gap with 2 factories, both OPT-IN (host injects into AgentConfig.we

###  CR2 + FU3 exhaustiveness gate


###  git init


###  QUANTA_TOOL_OUTPUT_MAX


###  zod 입력검증 → 회복가능 tool_result


### 🆕 /voice slash — handle-based recorder + multi-vendor transcriber ports
S3 voice slice — 4-vendor convergence absorption (Claude `/voice` Deepgram, Aider `/voice` Whisper, Windsurf voice input, Codex realtime WebRTC). Adds the handle-based AudioRecorderPort (start → handle, stop(handle) → Buffer, availability) that the interactive `/voice` slas

###  Shell-snapshot — production Bun spawner + size-budget prune + CLI opt-in
Production wire for ADR-0204's shell-snapshot primitive + ADR-0235's `runShell` prefix integration. Adds `bun-spawner.ts` (production adapter swapping in the Bun child-process API for the headless stub) + `pruneToSizeBudget` method on the `ShellSnapshotPort` (closes the unbounded

### 🆕 Production DeferredResultRegistry — registry-managed deferred work (ADR-0286)
Closed-port DeferredResultRegistry that OWNS the lifecycle of registered async work — distinct from the legacy ADR-0064 "external poller" seam (kept verbatim in `src/tool/deferred/legacy.ts`). Port: `register(work) / poll / await / cancel / list`. Closed 5-arm `Status` (pending

### 🆕 Async tool kind + poll_deferred — defineToolAsync + LLM probe (ADR-0287)
Three-piece async-tool seam built on ADR-0286 registry: (1) `defineToolAsync(spec)` wrapper — factory accepts a closed-port `DeferredResultRegistry` at construction (NOT via ToolContext, because src/tool/types.ts is slice-fence-locked AND because lifecycle ownership is structur

###  bash — timeout_behavior=background + bash_await + bash_kill (ADR-0296)
Cursor 3.2 `TimeoutBehavior.BACKGROUND` 패턴 흡수. `bash` schema에 `timeout_behavior: z.enum(["kill","background"]).optional()` 추가 (absent ⇒ `"kill"` 레거시 path BYTE-IDENTICAL). `"background"` 모드일 때 deadline 도달 시 process를 detach하고 `{shellId, sta

###  Spill → `evidence.fullLogPath` 라우팅 (Round 5)


###  ToolContext.depth


### 🆕 storage atomic write + edit expected_hash stale-precondition (ADR-0398)
storage/atomic-write.ts(신규 leaf) — 2-phase temp+rename adapter (writeFileAtomic). EXDEV → copyFile+unlink fallback; non-EXDEV rename 실패 시 temp on disk(replay용). lsp/adapters/file-write-atomic.ts와 격리 — slice fence(storage → lsp 금지) 위반 회피, 알�

###  apply_patch V4A 그래머 + deterministic 2-tier fuzzy


### 🆕 bash head-only 30K truncation 제거 → registry capToolOutput head+tail 위임 (ADR-0411)
bash가 자체 30K head-only truncation으로 출력 끝부분(에러 메시지/exit summary)을 잘라서 디버그 정보 손실되던 문제 폐쇄. `formatRunBody`와 `buildBackgroundCompletedResult` 둘 다 head-only slice 제거 — raw body 반환. registry의 `capToolOutp

### 🆕 Browser automation tools (headless CDP, ADR-0427)
Agent-callable browser automation over the Chrome DevTools Protocol (CDP). A pure `@/browser` slice (port + CDP adapter + headless stub + console/DOM collectors) drives a system Chrome over a launched dev-tools endpoint; the `@/tool/browser` layer exposes the navigate/collect too

### ✨ ADR-0442 Realtime voice session — live bidirectional spoken dialog
RFC-03 live spoken dialog. Composes the existing @/realtime transport (ADR-0230 8-method RealtimePort) + @/voice recorder (ADR-0208) + a new AudioPlaybackPort into a RealtimeVoiceSession driven by the OpenAI Realtime API (server-side VAD/codec/TTS). 5-state machine (idle→connec

### 🆕 read renders .ipynb cell-by-cell, base64 image outputs stripped (ADR-0481)
`read` treats a `.ipynb` as opaque UTF-8 today: it line-numbers the raw nbformat JSON — array-of-strings `source`, `execution_count`/`id`/`metadata` machinery, and (the expensive part) `outputs[]` carrying base64-encoded PNG/JPEG image payloads. A notebook with a few plots is t

### ⏸ GitBudget — 5-knob wall-time / commit-count / output-size cap (ADR-0107)
Closed-port typed budget interface + pure `applyBudget` helper that derives an AbortSignal carrying a deadline for long-running git invocations. Five knobs mirror the upstream `CaptureBudget` struct verbatim so a future port of the gix-snapshot RefStore→Commit→PackTree→Pack

### 🆕 gh — 6-tool GitHub CLI slice (ci-bot mode + PR/issue read & write)
Single slice that wraps the `gh` binary as 6 typed tools — `gh_pr_view`, `gh_issue_view`, `gh_pr_comment`, `gh_pr_create`, `gh_check_status`, `gh_pr_list`. Per-mode wiring decides whether to register them (ci-bot does; interactive does only if the operator opts in). Design: the

### 🆕 web_fetch + web_search — HTTPS read-only + provider-gated search (ADR-0127)
Two read-only web tools delivered as a single slice. (1) `web_fetch` — fetch an HTTPS URL and return the body (HTML→Markdown); always-on, no provider required, factory binds globalThis.fetch unless a fake fetcher is injected for tests. Security: TLS-required (non-`https:` pro

### 🆕 request_user_input — model-driven HITL question with typed outcome (ADR-0097)
Sister tool of `request_plan_exit`. Lets the model ask the operator a question and block on a typed reply when it cannot infer the decision itself. Designed for use inside plan-mode (a missing piece of information that would turn the plan into a gamble) but registered globally so

###  request_plan_exit — model-driven plan-mode exit with 3-way outcome (ADR-0086)
Model-driven exit from plan mode mirroring Claude Code's `ExitPlanMode`. When the agent has assembled a plan and is ready to act, it calls this with the plan text; the dispatch seam routes via `ToolContext.requestPlanExit` (built from `AgentConfig.planExitPort`), which surfaces t

###  scripted_replace — duplicated / bulk substitution sibling of edit
Codex `tool-routing-and-triggering.md` absorption — "patch is for local + stable context; scripted replace is for duplicated blocks, bulk substitution, or patch context mismatch". Sibling of `edit` — same FS-jail discipline (`@/storage` `enforceJail` chokepoint, single `FsJai

###  ToolRegistry — schema + isReadOnly + output-schema + spill capping
Central per-loop registry composing every built-in and ported tool into the surface the dispatch seam consumes. Owns: `has` / `get` lookups, `specs()` enumeration (schemas advertised to the model with zod-to-JSON-schema projection), `isReadOnly` per-tool read of the contract, pos

###  grep — jailed ripgrep search with 200-row cap + narrow/broaden hint
Read-only content search built on ripgrep. Model-supplied `path` is jail-validated via `@/storage.resolveJailed` BEFORE argv assembly (an unguarded `path: "/etc"` would otherwise escape the workspace through the ripgrep subprocess). Output is capped at MAX_LINES=200 with a tail c

###  glob — Bun.Glob file enumeration with jailed base + 300-cap
Read-only file enumeration via `Bun.Glob.scan`. Optional `path` (base directory) is jail-validated via `@/storage.resolveJailed` BEFORE the scan — otherwise `path: "/Users/other"` would return every file the process can read. Results are sorted lexicographically, capped at MAX=

###  bash — sandbox-driven HITL (ADR-0297, command-string heuristic removed)
`bash` is built by `makeBashTool({ sandboxProfile })` so its `hitlTier` closes over the operator-chosen `OsSandboxProfile` — a CLOSED-ENUM switch with ZERO command inspection. Matrix: `read-only`/`workspace-write`/ `danger-full-access` ⇒ `pre-approval-ok`; `workspace-write-ne

###  applyFuzzyEdit — 3-rung exact→whitespace-flexible→anchored-trim ladder
`edit` tool's fuzzy matcher: 3-rung conservative strategy ladder. (1) exact delegates to `applyExactEdit` (no duplication). (2) whitespace-flexible: per-line trim + internal-run collapse (`\s+` → single space). (3) anchored- trim: per-line end-trim only (preserves internal whit

###  git runner — AbortSignal propagation kills spawned git on cancel
Distinct axis from the runner's wall-clock timeout (ADR-0105) and from `GitBudget`'s deadline (ADR-0107): an optional caller-supplied `AbortSignal` is forwarded through `GitRunner.run(args, cwd, signal?)` and into `defaultGitRunner` so a cancelled tool call (loop abort, subagent 

###  gh tools — `normalizeRef` leading-dash defense (positional PR/issue ID)
Mirrors the `git diff`/`git log` leading-dash defense in the gh slice for the POSITIONAL PR/issue identifier argument to `gh <pr|issue|pr_checks> <id>`. A `-`-leading value (`--web`, `-R/owner/evil`, `--repo=...`) would otherwise be parsed by `gh` as a FLAG rather than a numeric 

###  test_runner — bun→npm→pytest auto-detect + heuristic verdict
Runs the project's test suite. Explicit `command` arg skips auto-detection; otherwise `detectCommand` probes in order: (1) bun if `bun.lockb` OR `bunfig.toml` OR `package.json.scripts.test` exists → `bun test`; (2) `package.json` only → `npm test`; (3) pytest markers (`pytest

###  diagnostics — provider-injected LSP front + graceful null degrade
Surfaces language-server errors/warnings for one file. Slice isolation (RFC §3.1, biome-enforced): `@/tool` MUST NOT import `@/lsp` — so this file owns ZERO LSP knowledge and talks only to an injected `DiagnosticsProvider`. Real provider (pyright / typescript-language-server) 

###  git `_shared.ts` — safeRun / mutate discriminated outcome boundary
Slice-internal helpers (`safeRun` + `mutate`) that normalize the spawn boundary into a tagged discriminated union — every git tool's `execute()` becomes a flat happy-path + branch-on-outcome, never a `try/catch` per call site. (1) `RunOutcome = { kind: "ok"; result } | { kind: 

###  git_branch_switch — `BRANCH_NAME_RE` schema-level alphabet guard
Schema-level zod regex `^(?!-)[A-Za-z0-9._/+-]{1,64}$` on `git_branch_switch.branch` that rejects a malicious or malformed branch name BEFORE argv is built — so it cannot escape into the `git switch <branch>` argv we hand to the runner. Four properties: (1) ALPHABET match — o

###  lsp_nav — 8 navigation tools (def/refs/hover/type-def/impl/symbols/rename-preview)
Eight navigation tools fronted by an injected `LspNavProvider` (same slice-isolation pattern as `diagnostics` — `@/tool` MUST NOT import `@/lsp`, biome-enforced): definition, references, hover, type-definition, implementation, document-symbol, workspace-symbol, rename-preview. 

###  localize — Stage-2 ranked fault-localization with FrameTier + JS-sibling penalty
Stage-2 of the 3-stage fault-localization triangle: ranked search for symbol/definition lines that match the model's natural-language query, bounded to the workspace via `resolveJailed`. Drives ripgrep with a definition-pattern grammar (line-leading shapes of declarations across 

###  file_tree_summary — Stage-1 fault-localization (repo 구조)
depth-bounded·.gitignore 준수 디렉터리 트리 + per-directory 파일 수를 반환하는 default tool. 모델이 파일을 고르기 전 repo 모듈 레이아웃을 파악하는 Stage-1 fault-localization 신호(Codex "file topology"). read-only + concurrency-safe (ripgrep

###  parse_test_failure — Stage-3 fault-localization (로그 파싱)
raw 테스트/빌드 출력에서 file:line 위치를 프레임워크 무관하게 추출하는 default tool (pytest/jest/vitest/bun-test/go-test/cargo-test + generic path:line:col). stack-trace 프레임은 검색 hit보다 높은 신뢰의 edit-location 신호(Codex 8/9 trust).

###  git_churn — 파일 변경빈도 핫스팟 (fault-localization 신호)
최근 윈도우 내 변경 빈도로 파일을 랭킹하는 git tool (churn 핫스팟). 자주 바뀌는 파일에 버그가 불균형하게 모인다는 Stage-1 fault-localization 신호. gitTools()에 등록, read-only + concurrency-safe (git log 부작용 0). rankChurn은 순

###  git_blame_heatmap — per-author 라인 소유권 분포
한 파일 또는 라인 범위의 per-author 라인 소유권 분포를 반환하는 git tool. 누가 이 코드를 아는지(Stage-1 ownership) fault-localization·리뷰어 지목 신호. gitTools()에 등록, read-only + concurrency-safe (git blame 부작용 0). rankBlame은 

###  git_log — US-separator () format + textconv determinism
`git_log` 도구가 commit 라인을 머신 파싱할 때 TAB(`	`) 대신 ASCII Unit Separator(``, US_SEP)를 필드 구분자로 쓴다 — commit subject와 author name에 TAB이 합법적으로 들어갈 수 있어 TAB-split 파서가 조용히 깨지는 클래스를 �

###  update_working_state — per-task 스크래치패드 메타도구 (Codex memory L3)
모델이 free-form per-task 스크래치패드(owner shortlist / hypothesis / blockers / deferred validation / next-step queue)를 유지하는 메타도구. 각 필드는 delta가 아닌 REPLACEMENT. 세션-스코프 WorkingStateHandle을 factory 클로저로 캡처. mutating·

### 🆕 ToolSearch — deferred-tool catalog ranked search + select:<name> lookup
Deferred-tool catalog search exposed as a Tool. Two modes: (1) `select:<name> [,<name>...]` direct lookup by name — restores schema for explicit deferred tools; (2) keyword search ranked by token overlap against tool name + first- line description ("tagline") + body. Tokenizer 

###  McpClient — line-framed JSON-RPC 2.0 + typed McpError + output cap
Wire-level details behind `mcp-tool-bridge`. (1) Newline-delimited JSON-RPC 2.0 codec — MCP framing is NOT LSP `Content-Length`; every message is a single line of UTF-8 JSON terminated by `
`, no embedded raw newlines. `LineReader` owns a byte buffer + only emits a message onc

###  git_upstream_check — upstream 분기 감지 (read-only)
v0.dev chat=branch upstreamChanges 흡수 — fetch 없이(네트워크·index 무변경) 이미 가져온 remote-tracking ref 대비 ahead/behind를 보고. rev-parse @{upstream}로 upstream ref 확인(미설정 graceful), rev-list --left-right --count HEAD...@{upstream}로 분�

###  ToolFailure discriminated union — 6-mode typed per-failure-mode results
Cursor EditResult/ShellResult의 discriminated failure union 흡수 — 기존 ok:false 도구 결과의 output 문자열을 모델이 정규식으로 재파싱하던 부담을 닫힌 enum으로 대체. ToolResult.failure?: ToolFailure 옵셔널 필드 추가(없으면 byte-ident

### 🆕 shadow_{snapshots,rewind,restore_partial} — first-class shadow-ODB tools
Three first-class agent tools wrapping the shadow ObjectDB safety-net store so the model (or operator via CLI) can inspect and undo a recent worktree state from within the loop. (1) `shadow_snapshots` — read-only enumerator over `ShadowOdb.listSnapshots`; deterministic newest-f

### 🆕 git_conflict_inspect — structured merge-conflict surface tool
Surfaces the pure conflict parser (`./conflict-parser`) as a typed first-class git tool so the `fix-merge-conflicts` skill (and any future loop consumer) can list structured merge conflicts in working-tree files without each caller hand-rolling a marker scan. Two input modes — 

###  git_review_diff — isolated reviewer-subagent over base...head diff
Extracts `git diff base...head` (default `origin/main...HEAD`) and hands it to an ISOLATED sub-agent reviewer (depth+1, read-only tool registry filtered to `{read, grep, glob}`, REVIEW-mode seed prompt). The main session's conversation history is NOT mutated — the reviewer's fi

### 🆕 subagent_{fork,poll,await} — background subagent tool trio (ADR-0130)
Three first-class tools wrapping a `BackgroundSubagentSchedulerPort` so the parent loop can fork a non-blocking subagent, poll its status without blocking, then optionally `await` it with timeout. `subagent_fork` is the primary mutator (returns an opaque handle id); `subagent_pol

### 🆕 git_moved_code — classifier surface (rename / move / split / merge)
Surfaces the pure moved-code classifier (ADR-0109 — normalize + similarity + parse-unified-diff) as a typed first-class git tool so the `pr-review-canvas` system skill can call it the same way it calls `git_diff`. Pipeline: shell `git diff [--staged] [base] [-- paths]` (same ar

### 🆕 DeferredResultRegistry — typed deferred-tool-result seam
Typed seam for tools that need to return a provisional placeholder plus a `DeferredHandle`, with the final `ToolResult` produced out-of-band and parked here until a poller resolves it. Pure in-memory registry: `register(hint?)` issues a fresh handle (`deferred-<n>` ids), `resolve

###  git runner — env-allowlist + deterministic overrides + bounded wall-clock
Single env-scrubbed spawn boundary for every `git` invocation in the slice. (1) ALLOWED_ENV — minimal parent-env subset (PATH/HOME/LANG/TZ/TMPDIR + ssh auth keys) so credentials and arbitrary code-exec env (LD_PRELOAD, PYTHON*PATH, NODE_OPTIONS, GIT_*) cannot reach the child. (

### 🆕 pptx_write / pptx_read tools — generate + read real .pptx (PresentationML, H14 follow-up)
Completes the Office authoring trio (xlsx + docx + PPTX) flagged as the scoped follow-up in office-authoring (H14b). `pptx_write` builds a real PowerPoint `.pptx` deck from per-slide title (the claim) + body bullet lines (the proof); `pptx_read` parses a `.pptx` back into per-sli

### 🆕 image_gen tool — text→image generation + edit (NEW binary-generation category)
The FIRST binary-artifact-GENERATION tool in quanta — opens a NEW category. Until now `src/tool/image/` was read-only (read_image / read_image_url) and `src/tool/document/` was `*-read.ts` only; there was ZERO image/asset generation. image_gen calls an injected provider port (d

### 🆕 xlsx_write / docx_write tools — generate real .xlsx / .docx (NEW Office-authoring category)
Opens a NEW tool category alongside H14a image_gen: GENERATING real binary Office files. Until now `src/tool/document/` was `*-read.ts` only (csv/yaml/ ndjson/pdf/xlsx read; the xlsx reader is itself a stub) — there was ZERO binary-document authoring. `xlsx_write` builds a vali

###  Advisor consult tool (second opinion from a stronger model)
Agent-callable PURE consult: the model deliberately asks a STRONGER / DIFFERENT model for a SECOND OPINION mid-loop and gets the analysis back in-band. Orthogonal to model-swap-on-retry (ADR-0066, failure-driven, invisible to the model), role-model-override (ADR-0256, a resolver 

### 🆕 applyPatchStructured — per-file outcome + messageForModel (self-correcting edits)
Cursor ApplyAgentDiff 흡수 — 기존 applyPatch는 첫 bad hunk에서 patch 전체를 wholesale throw + rollback(전부-or-전무). 이 ADDITIVE/default-OFF seam은 새 applyPatchStructured(patch, fs)를 추가: op 단위 PER-FILE ISOLATION으로 한 파일이 실패해도 나

### 🆕 Canvas / artifact persistence store (C1 — non-code generation outputs)
Cursor `agent.v1.Canvas{Register, GetUrl, Destroy}` 흡수 — 생성축(H14 image_gen / xlsx_write / docx_write / pptx_write)이 만든 NON-code 바이너리를 transcript와 분리해 등록·조회·파기 + 안정 미리보기 URL. "만든 파일을 어디 두고 어떻게 �

### 🆕 CommunicateUpdate — structured mid-turn progress report (C2)
Cursor 3.5.33 `agent.v1.CommunicateUpdateArgs` 흡수 — 모델이 턴을 끝내지 않고 MID-TURN에 구조화 진행상태를 보고하는 read-only 채널. 기존 free-text 내레이션 (`assistant_text`)·토큰카운터(`output_progress`)·tool-call-keyed 자유텍스트 (

###  Commit + PR authoring tools (diff→prose, git_compose_commit / git_compose_pr)
Two READ-ONLY authoring tools that close the diff→prose gap (the Codex `yeet` / Cursor compose pattern). `git_compose_commit` reads the STAGED diff and authors ONE Conventional Commits message; `git_compose_pr` reads the branch-vs-base diff + commit log and authors a PR title +

###  parseConflicts — pure git merge-conflict parser library (ADR-0111)
Pure typed-and-tested git merge-conflict parser shared by skills and tools that need to programmatically inspect merge conflicts. Input is the entire file contents (the agent has already `Read` them); output is the typed `ConflictParseResult` with `ConflictBlock[]` + `ConflictPar

### 🆕 document/image readers — unified FsJail chokepoint via resolveJailedDoc
Pre-S7, every file-reading tool rolled its own `resolveXxxPath` — `resolveImagePath` (`src/tool/image/read.ts`), `resolveCsvPath` (`src/tool/document/csv-read.ts`), `resolveNdjsonPath`, `resolvePdfPath`, `resolveYamlPath`. Five copies of the same `path.isAbsolute` + `path.resol

###  "Edit fuzzy matcher: scored-candidate recovery on ambiguity"
A final safety-net rung on the fuzzy ladder's AMBIGUOUS path (which fails today): score each candidate window by exactAnchorScore = count of lines matching the needle VERBATIM at the same position, and recover ONLY when exactly ONE window is a unique strict maximum (top score str

###  "Edit line_ranges — scope a repeated anchor by 1-indexed line window (H12)"
Optional `line_ranges: [{start, end}]` field on the `edit` tool input — 1-indexed, inclusive on BOTH ends (Cursor `LineRange{start_line_number, end_line_number_inclusive}` semantic). When present it PREFILTERS the candidate match windows to only those whose match lands inside A

### 🆕 appshot_verify — closed spec→scaffold→render→screenshot→judge verify loop (G1, Phase 1)
G1 Phase 1 — the CLOSED generation→verification cycle quanta never had. quanta already owned both ends in SEPARATE slices that were never joined: a binary- artifact GENERATION axis (image_gen / Office authoring / the artifact store) and a render+observe half (browser_navigate

###  "gh_pr_edit_labels — add / remove PR labels"
A thin MUTATING wrapper over `gh pr edit <pr> --add-label <l> --remove-label <l>`. quanta's gh tools READ labels (gh issue view --json …,labels) but had no way to MUTATE them; needs-review / ready-to-merge / do-not-merge label triage is a staple of CI-automation merge-gating. T

###  "gh_pr_open — author + open a PR in one step"
The seam joining git_compose_pr (authors prose, opens nothing) and gh_pr_create (opens from an existing title/body). One atomic tool: resolve branch NAMES (default head = current branch via rev-parse, base = main, 'origin/' stripped) → guards before any LLM/gh spend (detached H

###  "gh_pr_resolve_thread — resolve review threads + concurrent-push rebase"
The write that closes the review loop. GitHub exposes thread resolution ONLY via GraphQL (resolveReviewThread(input:{threadId})) — no `gh pr` subcommand — so this is the FIRST gh tool routing through `gh api graphql`. Three modes by input: LIST (no threadId/all → unresolved

###  "Diff-derived Conventional Commits scope inference"
diffToScopes(diff) — a pure, deterministic scope inferer: the scope is the first directory segment under a recognized source root (src/|packages/|apps/, requiring root/scope/leaf), candidates ordered files-DESC → lines-DESC → name-ASC. The top candidates are injected into C

###  git_blame / git_diff / git_status — read-only git tools
Three first-class read-only git tools sharing the injectable `GitRunner` port (so tests stub `git` without spawning). (1) `git_blame` — porcelain parser for `git blame --porcelain -L <range>`, surfaces hash / author / authorTime / summary / line content. Stderr-pattern recognis

###  read_image + read_image_url + compose helper — vision pipeline
Three modules that compose the vision-input slice. (1) `read_image` (ADR-0126) reads an image file from disk, magic-byte-sniffs the media type (rejecting any byte sequence that doesn't match a supported PNG / JPEG / GIF / WEBP signature), enforces a 5 MB cap (Anthropic Messages v

### 🆕 LSP call hierarchy — lsp_incoming_calls / lsp_outgoing_calls (RFC jun-6)
Two new read-only nav tools answering the refactorer's core question — "if I change this function's signature, what calls it (and breaks), and what does it call?" — which `lsp_references` cannot (it conflates reads / writes / imports / type annotations and gives no call-site 

### 🆕 Node REPL persistent kernel — Jupyter-style per-session node process
Codex `~/.codex/node_repl/active_execs/{execId}.json` 패턴 흡수의 slice primitive — 한 세션 동안 살아 있는 `node -i` 서브프로세스를 유지해서 턴 사이 변수 바인딩이 보존되게 한다 (`let x = 42` 후 다음 턴에 `x` → `42`). 이번 라운�

###  PatchFileSystemPort — apply_patch FS abstraction (pure applier)
Patch-specific FS port (read / write / delete / rename / exists) injected into the V4A `applyPatch` so the applier stays pure-functional w.r.t. the host filesystem and can be unit-tested in-memory. DIFFERENT shape and different name than the general `@/storage` `FileSystemPort` �

### 🆕 ADR-0231 Radar Cards — background proposal queue MVP (Claude CoworkRadar)
Claude Desktop CoworkRadar 흡수 (MVP scope) — background에서 task suggestion을 active proposal로 큐잉. 8-field RadarCard (id/kind/title/ description/sessionId?/createdAtMs/status/engagementCount) + 4-arm status (active/adopted/dismissed/expired) + 3-arm kind (suggestion

###  read B5 device + binary guard — reject FIFO / device files + NUL-byte binaries before reading
The `read` tool rejects targets that would hang the loop or dump unbounded output BEFORE opening them (B5 guard). A named pipe (FIFO) BLOCKS forever when no writer is attached; a character device (`/dev/random`, `/dev/zero`, `/dev/tty`) streams infinitely; a block device (`/dev/d

### 🆕 read file_unchanged dedup short-circuit (H9) — skip re-sending identical content
In an iterative agent loop the model frequently re-reads the SAME file at the SAME window (e.g. re-checking a function after an unrelated edit elsewhere). Pre-H9 the `read` tool re-sent the FULL content every time — pure wasted tokens. H9 closes that: BEFORE rendering full cont

### 🆕 ADR-0230 Realtime WebSocket — 8-method port (Codex streaming)
Codex Desktop 8 realtime WS methods 흡수 (connect/send/onMessage/negotiate/ audioStart/audioStop/close/status). Bun native `globalThis.WebSocket` (zero npm dependency, install gate honor). WebSocketCtor injectable for deterministic tests. SDP negotiator (PCM/Opus marker preserv

### 🆕 ShadowOdb closed port + LRU eviction utility (ADR-0108)
Closed-port contract for a separate git ObjectDB rooted at `<baseDir>/snapshots/<workspaceHash>/.git` — point-in-time worktree snapshots that NEVER touch the user's own `.git`. The pivot is `GIT_DIR` + `GIT_WORK_TREE` env override: one `git` invocation re-points at the shadow s

### ✨ Stale-read guard — block clobbering edits + post-bash re-read reminder
When the agent reads a file then the file is changed on disk by something outside the agent (a concurrent process, a git checkout, a formatter the agent itself ran via bash), a later write/edit against the agent's remembered contents silently CLOBBERS the external change. This sl

### 🆕 'block-interrupt critical section — defer ESC across a tool''s atomic FS-mutating window (jun-6)'
A tool that declares `interruptBehavior(): "block"` (write / edit) runs its atomic FS-mutating window (rename / flush) over a SUPPRESSIBLE derived abort signal so an upstream cancel (ESC) is WITHHELD until the window closes, then force-delivered — `block` can DEFER a cancel acr

### 🆕 Tool-surface manifest — SSOT for the LLM tool-access axis (gate + per-surface default)
jun-03 — 단일 관리 카탈로그로 LLM-accessible 도구 집합의 접근 축(어떤 도구가 존재하는가 / 무엇이 게이트하는가 / 표면별 default-ON 여부)을 SSOT로 모은다. 이전에는 이 데이터가 buildDefaultTools + tier-1 블록(@/agent/feature


---
## 03-permission-safety

###  Trust-scope registry wire-up (Phase C) — persistent grant memory ask-skip
TrustScope enum(always_allow | project | workspace | session | once_only | deny)을 위한 registry + admissibility-gate 단일 wire-up. ask-branch는 onConfirm 직전에 registry.hasGrant(projectKey, { tool, actionKey? }) 조회로 단락. once_only는 hasGrant 내부에서 posi

### ⏸ rememberPatterns — 권한 패턴 학습 + cascade 자동해소
v0.dev 권한 학습 흡수 — 모델이 필요 권한을 직접 제안(suggestedPermissions)하고 위험을 자가표시(isMaybeDangerous). "패턴 허용" 1회 → 대기 중인 모든 다른 tool 요청을 재평가해 rememberPatterns가 전부 allowed 집합에 포함되�

###  ConfirmDecision deny_and_steer verb — typed third option with steer injection
Gap-4 of the `agent-loop-branch-hardening` umbrella (ADR-0076). Adds a third verb to host confirmation — beyond `allow` / `deny`, the host can now return `{kind:"deny_and_steer", steer:string}` so a denial carries a redirect message back to the model in the same envelope. Compa

###  Readonly deny-steer note — admissibility isReadonly flag appended to steer message
Plane-C of the `phase-ttft-readonly-trio` umbrella (ADR-0077) — the control-plane sibling of Plane-A (phase marker, surfaced via `llm-assemble`) and Plane-B (TTFT, surfaced via `turn-timing-anchors`). Read-only tool denials get a structured steer note appended so the model know

###  git-write-protection 정적 deny (.git/{hooks,config} + .vscode)
Cursor cursorsandbox의 Seatbelt write-deny-regex를 surface-agnostic 정적 detector로 흡수 — .git/hooks·.git/config·.vscode write는 곧 임의 코드 실행(git/에디터가 auto-run) 이므로 정통 샌드박스 탈옥 벡터. gitWriteProtectReason(path)는 순수 경

###  default|acceptEdits|bypass|auto


###  e2e


###  FsJailError


###  git -c


###  HITLTier = hand-off-required | always-confirm | pre-approval-ok | none


###  LocalSandbox


###  mode-posture → HITL 4-tier → permission policy (HARD_DENY redundant guard) → pre


###  verbatim 위협프롬프트


###  Secret-detection scanner — pattern + entropy + composite
Hexagonal `src/security/secret-detection/` slice — closed `SecretScanner` port + 3 adapters (pattern regex against 10 known token shapes — AWS / GitHub PAT / Slack / PEM / etc.; Shannon-entropy detector for novel vendor keys git-secrets misses; secretlint adapter), composite-

###  PII-redaction scanner — port + pattern + Luhn + composite
Hexagonal `src/security/pii-redaction/` slice covering the OTHER half of agent-content safety — human identifiers (email, phone, SSN, credit card, IP, IBAN, passport, driver's license). Closed `PiiScanner` port + pattern-scanner (10 regex kinds + composite) + Luhn-validator (cr

###  단언 단위 + 183 통합 safety net 그대로 green


###  CR3 rule-catalog SSOT + FU1 rule-per-concern invert


###  DockerSandbox


###  HARD_DENY 선행 / readonly short-circuit


###  '`inferToolTier` secure-by-default fallback'


### 🆕 Per-tool / per-skill checkpoint granularity (ADR-0209)
ADR-0121의 4-arm trigger mode와 직교하는 GRANULARITY 축 추가 (`"turn" | "tool" | "skill"`). 기존 per-turn dedup는 Cline의 매-tool-call anchor + tag 패턴 (`/rewind-tool tool:edit_file:turn-1:7`) 을 막아왔음. `GranularCheckpointPolicy` 가 base `CheckpointPolic

### 🆕 3-way restore — Files Only / Task Only / Both (ADR-0210)
Cline UX 흡수 — 같은 tag로 두 면 (workspace files + conversation) 을 직교 3-way 로 surface. `ThreeWayRestorePort` (`restoreFiles` / `restoreTask` / `restoreBoth`) + typed `RestoreOutcome` envelope + closed `RestoreErrorCode` enum (`tag-not-found` / `shadow-odb-not-co

### 🆕 Tool profile preset — 4 named bundles (write/ask/minimal/code-only) + UP-nudge composition
Zed의 named "tool profile" mode 3종 (Write/Ask/Minimal) + Codex agent_role enum (explorer/ worker/none) 패턴 흡수. v3는 fine-grained 조각 (ADR-0046 permission stack / ADR-0055 HITL tier matcher / ADR-0135 4-pillar profile) 다 있지만 named bundle 없음 — 매 세션

### 🆕 Shell-snapshot runShell wire — opt-in source-fold (ADR-0235)
Wave 3 wire — ADR-0204 의 ShellSnapshotPort (capture/restore/prune leaf 슬라이스) 를 `runShell` 의 옵션 fold 로 연결. host 가 `runShellWithSnapshot({port, threadId})` 를 명시 호출하면 매 turn 진입 시 capture → `bash -lc "source <snapshot.sh>; <cmd>"` �

### 🆕 bash `mode` + per-call OS sandbox wrap (ADR-0295)
Cursor 3.2 패턴 흡수 — bash tool 입력에 closed-enum `mode: "read"|"write"` (OPTIONAL, default "write"). `mode="read"` 일 때 호출당 OS sandbox (Seatbelt read-only) 로 argv 를 래핑하여 write/exec/network 시도를 OS가 EACCES 로 거부. typed `ToolFailure { mo

###  Prefix-rule allowlist DSL + 3-layer (project > user > system) + default-deny opt-in


###  Reviewer 3-tier (user/auto_review/guardian_subagent) + 8-state outcome


### ✨ Permission-profile inheritance — extends + cycle detection + monotone-narrowing merge + Managed ceiling
ADR-0438 — 3개 고정 named profile(restricted/default/trusted)을 합성 가능한 extends 그래프로 확장. 새 leaf `profile-inheritance.ts`의 순수·전역(total)·무 I/O resolver `resolveProfileInheritance(name, registry, opts?)`가 ProfileDefinition (모든 pillar 

###  ADR-0441 Windows OS-sandbox backend (pure compiler + native boundary)
Closes the Windows surface-parity gap in the OS sandbox. Before ADR-0441, win32 had NO branch and NO type-union arm — agent shells ran fully unsandboxed regardless of profile. Now there is a pure policy compiler + native boundary + selection wire, mirroring Seatbelt (macOS) and

###  local-environment selection — DECLARED per-project dev env composed over the allowlist
프로젝트가 `.quanta/environment.toml` (또는 Codex-compat `.codex/environments/environment.toml`)에 named dev environment를 DECLARE하면, 에이전트가 하나를 SELECT하고 spawn된 shell 도구(bash)가 그 env의 vars / PATH-prepend를 scrubbed base env 위에 합�

###  ReviewKind × isExecutionBlocking × reason_code matrix + scoped-allowlist verbs
Cursor approval gate의 타입드 매트릭스 흡수 — quanta 권한 레이어에 "무엇을 리뷰하는가" 축 추가. HITLTier(ADR-0020 — 행위 risk 형상)와 ReviewerTier(ADR-0029 — 누가 결정)와 직교. ReviewKind = edit | delete | terminal | mcp | web_fetch | 

###  permission policy — HARD_DENY engine + tier inference + reviewer composition
The RESOLVER ENGINE half of the permission policy (SRP split with the data half in `policy-rules.ts`). Owns `evaluate` / `evaluateAuto` / `evaluateStack` / `inferToolTier` / `hardDenyReason` — the four call surfaces the admissibility gate composes per-action. Pipeline: (1) HARD

###  permission state store — atomic JSON-state-file persistence engine (ADR-0046)
File-backed JSON store for per-thread permissions, per-host agent modes, and post-denial precedence records. Single file at `~/.quanta/permission-state.json` (overridable via `QUANTA_PERMISSION_STATE`, both env vars read via `runtimeConfig()` — the one legitimate `process.env` 

###  Destructive git HARD_DENY rules (workflow + push mass-delete)
HARD_DENY_RULES extension covering workflow-destructive git argv shapes that prompt-level posture (ADR-0099) cannot guarantee — forced-history rewrites, mutating discard variants, and push mass-delete shapes. Static argv pattern matchers run before tool dispatch; deny is fail-c

###  trust-scope persistent grant store — cascade + TTL (L3→L4 promotion)
L3→L4 promotion of `trust-scope-wire-up`. File-backed persistent grant store consulted by the admissibility gate to short-circuit the legacy ask-flow when a previously-approved structurally-equivalent action is repeated within the grant's scope. The file lives under `~/.quanta`

###  branch-only git-write guard — ci-bot mode protected-branch propositional check
Propositional check on a shell command — is this operation forbidden by the `gitWrite: { kind: "branch-only"; protectedBranches: string[] }` lever? Four forbidden ci-bot operations: (1) any `git push` whose refspec targets a protected branch; (2) any `git commit` while HEAD is 

###  pattern-grant auto-pass — admissibility-gate cascade (ADR-0061 wire-up)
Pure module the admissibility-gate calls into to decide whether a pending action's `rememberPatterns` are ALREADY fully covered by the session's `PatternGrantStore` and therefore can be auto-passed with a synthetic `config_allowed` decision WITHOUT invoking the reviewer port. Ded

###  ADR-0044 negative invariants — single doc SSOT for 12 deliberately-not-absorbed patterns
Single ADR documenting 12 patterns from Codex/Claude Desktop audit that v3 deliberately does NOT adopt — paired SSOT for the "흡수 안 함" half of every audit cycle. Each N-item names a pattern, the v3 trust-model conflict, and the cost of reversal (a new ADR + explicit inva

###  External-agent importer — N10 credential-read ban (auth.json never opened)
Concrete enforcement point for ADR-0044 N10 (`claude-code-import` MUST NOT auto-read other agents' auth tokens). The detector treats `.claude/auth.json` as a marker for PRESENCE detection only — its content is never opened or parsed. The importer's 4-stage pipeline (detect → 

###  Permission recorder — observability fail-open invariant (verdict cannot be flipped by emitter throw)
Negative invariant: a thrown PermissionRecorder cannot deny an otherwise- allowable action nor allow an otherwise-denied one. Every emit helper wraps the registered recorder in try/catch and swallows the throw — the gate's verdict is computed BEFORE the emit and the emit is fir

###  Linux Landlock Phase 2 (bubblewrap)
Linux OS-level sandbox via `bwrap` (bubblewrap) shell-out. Phase 1 stub (ADR-0136) replaced with real Linux backend matching the macOS Seatbelt posture. `compileBubblewrapArgs` translates SandboxPolicy 4-arm enum to argv (`--ro-bind` / `--bind` / `--unshare-net` / `--die-with-par

### 🆕 AutoApprovalReview (periodic "are these auto-grants still OK?" prompt)
**Codex `automaticApprovalReview.actionSummary` 흡수.** 매 N (default 10) 연속 auto-approval 마다 사용자에게 review prompt — "이 정책 OK?" 확인. 사용자가 loop에 들어왔거나 deny 이벤트가 발생하면 streak 리셋. pure ledger pattern — record(to

### 🆕 LLM-backed permission auto-mode 2-stage ClassifierPort
HITL-AUTO 모드의 LLM 분류기 — 권한 결정을 사람 대신 자동으로 내리는 mode에서 "이 action이 safe/dangerous/needs-review 중 어느 카테고리인가" 를 LLM round-trip 한 번으로 답함. 2-stage + denial-limit state 는 `permission`의 `AutoModeClas

###  Bridge Attestation — remote permission preflight + STS token (ADR-0246)
Closed-port leaf slice for remote permission preflight + short-lived STS token issuance. Absorbs Claude Desktop's `onBridgePermissionPreflight` round + 9 lifecycle events into a typed `BridgeAttestor` port with 4 methods (preflight / mintToken / verify / revoke). 3-arm `AttestRes

### ✨ Config-provenance gate — repo-controllable config may only NARROW, never widen
SECURITY 🔴. The layered config merge (src/permission/policy-layers/index.ts) ranks team-admin > per-repo > per-user > default and, under source-precedence, the most-authoritative source that SETS a field wins it. That is correct for ADMIN policy but a PRIVILEGE-ESCALATION / SU

###  `decision` event emit Phase 2 — admissibility-gate (permission/rule/hook) wire (ADR-0267)
ADR-0239 Phase 1은 `decision` AgentEvent variant + debug-tracer consumer만 깔았고 *production code는 아직 emit하지 않는 상태*였음. 이 슬라이스는 사이클을 닫음 — `runAdmissibilityGate` 안의 3개 게이트 결정 지점에서 실제 emit해서 `QUANT

###  `decision` event emit Phase 3 — cap / jail / budget 게이트 wire (ADR-0269)
ADR-0267 Phase 2는 `runAdmissibilityGate` *내부* 3개 게이트 (permission / rule / hook)만 wire함. cap / jail / budget 게이트는 admissibility call graph 바깥의 다른 chokepoint에 있어서 silent 상태였음 — `DecisionEvent.kind` closed union에는 6 kind 다 

###  Disclaimer shell wrapper


### ✨ errMessage infinite-recursion fix + guard comment (regression-pinned)
`errMessage(e)` 의 self-recursion 회귀 fix — 2026-05-23 mass migration 이 over-eager find/replace 로 본문을 `errMessage(e)` 로 바꿔 무한 재귀 → 모든 consumer hang. 정정 후 body 는 verbatim: `e instanceof Error ? e.message : String(e)` 로 고정. Hardenin

###  ReDoS-hardened glob DP matcher (skill activation + Cursor rule paths)
Memoized dynamic-programming glob matcher for the constructs Claude Code's `paths:` and Cursor `.cursor/rules` `globs:` use: `**` (any chars incl. `/`, with an optional following `/` convenience), `*` (any run of non-`/`), `?` (one non-`/`), literals. A pattern without a `/` matc

###  RAII child-process lifecycle guard (runShell / sandbox 공통)
Spawn site (runShell의 observer/buffered path, LocalSandbox.run, DockerSandbox.run) 마다 자식 프로세스의 생애를 관리하는 RAII-style guard. WHY: 각 site가 같은 cleanup 코드(timeout / abort signal 전파 / stdio drain / kill+await exit / orphan 방지)를 ad-

###  HITL 4-tier gate registry + handoff event seam (ADR-0047)


### 🆕 JWKS agent identity — remote JWK fetch + cache + verify (ADR-0248)
Codex agent-task 등록 패턴 흡수의 verify-only foundation. 외부 dispatcher가 발급한 JWT를 remote JWKS endpoint로 검증한다. `src/security/jwks-identity/` 새 슬라이스: port(`JsonWebKey`/`JwksSet`/`VerifyResult` discriminated/ `JwksError` 계열/`JwksClient { 

### 🆕 Layered permission-policy merge (per-user / per-repo / team-admin)
Pure layered struct-merge engine + the permission-domain wiring that consumes it. Absorbs Codex `ConfigLayer / ConfigLayerSource / MergeStrategy / OverriddenMetadata` + Cursor `SandboxPolicyMergeSources { per_user, per_repo, team_admin }`: a `LayerSource` precedence (default < pe

### 🆕 LLMErrorKind.not_implemented (chatgpt-oauth Phase-1 fallback-eligible)
ADR-0094 Phase-1 chatgpt-oauth stub adapter 가 호출 시 매번 throw 하는 deliberate stub state 를 위해 새 LLMErrorKind 추가: `not_implemented`. Retry 정책에서 FATAL 로 분류 (재시도 0), fallback 정책에서 ELIGIBLE 로 분류 (다른 provider 로 swap). 3-p

###  Localize-phase guard — Agentless "localize-first" dispatch gate
Pure deterministic policy at the dispatch seam: during the first N turns of a run, mutating tools (`edit`, `write`, `scripted_replace`) are blocked with a reminder steering the model to `read`/`grep`/`glob`/`localize` first. Addresses the observed SWE-bench Verified failure patte

###  MUTATING_TOOL_TABLE drift closeout (12 caller-wire tools + agent.isReadOnly fix)
Closes the silent drift between MUTATING_TOOL_TABLE and the caller-wire tool registry. Twelve previously-missing entries (gh_pr_comment/create/auto_merge, memory_write/update, branch_search, task_stop, request_plan_exit, agent, Skill, ToolSearch, web_search, read_image_url) now c

### 🆕 Named permission-profile registry + by-name resolution
The 2026-06-01 gap audit found we had DEFAULT_PERMISSION_PROFILE (a single struct) and a session-envelope enum ["default","trusted","restricted","custom"], but NO registry mapping a name → concrete PermissionProfile, so TwoLayerManager only took a struct directly. This adds the

### 🆕 Socket-level egress proxy — close the subprocess egress bypass
Closes the SUBPROCESS egress bypass the dispatch-layer gate (network-egress-enforcement) leaves open. The tool-arg guard extracts a host from a tool CALL; a subprocess that opens its OWN socket (curl / gh / npm / git) never passes through it. This slice ships a REAL loopback HTTP

### 🆕 OS Sandbox wire-up — bash spawn wrapped by Seatbelt/Landlock policy
`defaultOsSandbox()` (macOS Seatbelt + Linux Landlock stub + Windows passthrough) is wired into the bash spawn path via a module-level `ShellSandboxSlot` seam in `@/runtime` (`installShellSandbox` / `getShellSandbox`). `QUANTA_SANDBOX` env is now a real policy switch (previously 

###  호스트별 기본 agent-mode (agent-mode-by-host-id 동등물)
**Host-level default** — hostId(SSH_CONNECTION 기반 결정론적 식별자, 부재 시 localhost) 단위로 full-access / read-only / custom 기본값을 잡는다. per-thread record가 없을 때만 적용 — 즉 "이 호스트에서 새로 열린 스레드의 기본 정책

###  스레드별 권한 (heartbeat-thread-permissions-by-id 동등물)
**Thread-level override** — 특정 sessionId(스레드)에 대해 sandboxPolicy + approvalPolicy + approvalsReviewer를 명시 지정한다. 한 스레드는 read-only, 형제 스레드는 danger-full-access로 병행 운영 가능. ADR-0046 우선순위 3위(post-denial 다음

### 🆕 4-pillar Permission (approval / network / sandbox / control)
**Codex `Permission.{approval, network, sandbox, control.managed}` 4-pillar 흡수.** v1에서는 approval / sandbox / control 3-pillar 정도였고 network는 명시적 분리 되지 않았음. ADR-0135로 network를 별도 pillar로 격상 — 외부 network access는 가장 �

###  Permission stack × pre_tool_use hook ordering lock (13-step canonical pipeline)


### 🆕 5-axis permission inspector (stateless, slash-facade)
Slash-command 표면(`/permission explain <tool>`)을 위한 stateless inspector. 동일 슬라이스의 `inspector.ts`(store-기반, per-thread "지금 어떻게 결정될까")와 보완: 본 모듈은 store 없이 "정책 SHAPE 가 어떻게 생겼는가" 를 5-axis 분해로 �

### 🆕 Permission stack inspector (ADR-0046 follow-up)
Read-only programmatic surface — given an action, *어떤* permission layer가 *왜* 허락/거부했는지 결정 trace 를 반환. `quanta permission inspect <action>` CLI / Tauri dashboard 의 backbone. 8-stage admissibility-gate(ADR-0026 SSOT) 결정을 reverse-engineer 하

### 🆕 PermissionProfile + file_system_sandbox_policy 2-layer (AND condition)
**Codex `turn_context.permission_profile.file_system` + `file_system_sandbox_policy` 의 2-layer 모델 흡수.** 동일 schema (`path.type: special/path`, `access: read/write`) 의 두 인스턴스를 AND-condition으로 결합 — 두 layer 모두 allow여야 access OK. 한쪽�

###  PermissionProfile List + Select + user-defined profiles from disk
Codex `PermissionProfile{List/Select/Apply/Resolve}` absorption. The existing `named-profiles.ts` registry shipped Resolve (`resolveProfileByName`) + Apply (`TwoLayerManager.setPermissionProfileByName`). This leaf adds the two missing verbs PLUS user-defined named profiles loaded

### 🆕 PermissionScope 4-tier (managed > project > user > open)
**Codex `Scope.{user, project, managed, open}` 4-tier RBAC 흡수.** Skill scope ([[0134-skill-scope-tiering]])의 7-tier보다 단순 — permission은 admin enforce channel + project repo-level만 있으면 충분 (admin/team 통합 = managed). Precedence (높을수록 강함):

###  post-denial 사용자 override (guardian-post-denial-precedence 동등물)
**Explicit re-approval precedence** — guardian/룰이 거부한 동작을 사용자가 "위험을 본 뒤 명시적 재승인"한 경우에 한해 그 동작에 대해 룰을 override 한다. per-thread/per-host와 달리 "특정 (threadId, action) 한 건"에 대한 one-shot �

###  AGENTS.md / repo-rules tree — deeper-wins layered rule ingestion (ADR-0098)
Repo가 ship하는 운영 contract (canonical 커맨드 경로, fail-closed posture, patch discipline, "no heuristics" 등)를 top-level 마크다운(`AGENTS.md`, `CLAUDE.md`, `.codex/CODEX-RULES.md`)에서 자동 흡수하여 per-turn system reminder에 주입. ADR-0098 확장: 

###  ADR-0199 macOS Seatbelt verbatim profile + 4 strict knobs
Codex 강신호 — macOS Seatbelt SBPL profile을 verbatim parity로 잠금 (3 profile: read-only / workspace-write / workspace-write-net). parity fixture 3개로 byte-equal lock. 4 strict knob 추가 (denyForkAdditional / denyNetworkAlways / allowTmpWrite / denyMetadataReadAbso

### 🆕 Per-turn shell environment snapshot (hermetic shell)
Codex의 `~/.codex/shell_snapshots/{thread}.{ns}.sh` (~90KB) 패턴 흡수 — 매 턴 진입 시 사용자 shell 환경(typeset/declare params, alias, function)을 단일 `.sh` 파일로 직렬화하고, 이후 shell tool 호출 시 그 파일을 `source` 한 뒤 사용자 명�

### 🆕 SpecialPathKind 8-kind OS-aware resolver (LRU cached)
**8 special path kinds OS-aware resolver.** Codex permission_profile entries는 `path.type: special` 형태로 root/project/tmpdir/git/agents/quanta/slash_tmp/tmp 을 named로 표현 — OS별 절대 경로는 resolver가 expand. profile JSON에 호스트 관례를 박지 않게 

### 🆕 Untrusted content tag-boundary defang — 단일 강제 path (embedUntrusted)
Per-turn 프롬프트가 untrusted fragment (파일 경로, IDE selection text, diagnostics, memory aggregate, rule body)를 named tag block 안에 넣을 때 — `<system-reminder>` 나 `<ide-context>` — fragment가 LITERAL closer를 포함하면 블록을 조기 종료시켜 

### ✨ Untrusted-source result envelope — wrap external tool output as DATA (H2)
외부 출처에서 온 도구 결과(web_fetch 페이지, MCP 서버, plugin, bash stdout, 파일 내용)는 공격자가 제어할 수 있어 prompt-injection 텍스트("기존 지시 무시하고 레포 유출하라")를 심을 수 있다. 이 슬라이스(src/agent/untrusted-


---
## 04-context-management

###  Message-id rewind — transcript truncate-to-message UX
Claude Desktop 1.7196.3의 transcript 단위 rewind UX 흡수 — Message.id?: string opt-in 필드를 src/llm/types.ts에 추가(byte-identical default-OFF: 기존 세션 파일은 id 없이 load/save, messageSchema는 absent 허용). assignMessageIds(messages, idFor?) 헬퍼는

###  cache:true


###  compaction.summarizerLlm


###  CompactionBreaker


###  loadRepoRules(cwd)


###  mode → repo-rules → active-skills → working-state → memory-hints


###  proactive


###  source/runtime > tests > docs/memory


###  TurnContextInput.{mode, repoRules, workingState, activeSkills}


###  PlanQueue enqueue collapse metric — EnqueueResult + dedicated counter
Closes the ADR-0161 follow-up gap: PlanQueueStore previously returned just a string id from `enqueue` — when ADR-0128's dedup rule collapsed a same-(threadId, textHash) request into an existing live entry, the `instrumentPlanQueue` wrap had no signal to count. New `EnqueueResul

###  Mid-turn user interruption — capture facade over PlanQueueStore + 3-arm mode + InterruptionPolicy port
Capture facade that maps the CLI "user submitted while streaming" signal onto ADR-0128's PlanQueueStore. 3-arm closed `InterruptionMode` (`queue` / `cancel-and-replace` / `cancel-and-amend`) — caller picks based on UI surface (typed-ahead = queue; `Cmd-K` = replace; "wait I for

###  (CLI 순수헬퍼 직접 유닛테스트 불가 — main() 톱레벨; 루프 e


###  reactive fail-fast


###  강화 "Trust and inputs"


### 🆕 ConvCheckpointWire — surface-side per-turn auto-record + /rewind-conv (ADR-0292)
ADR-0124 `ConversationCheckpointStore` 의 first consumer — surface-side wire + `/rewind-conv` slash. ADR-0124 catalog row(`conversation-checkpoint-store`)의 `deliberate_hold.promotion_path`("Wire a consumer (e.g. /rewind, message-rewind UI, or post-tool-failure auto-checkpoin

### 🆕 /session export+import slash — round-trip via ADR-0157 primitive (ADR-0294)
ADR-0294 — `/session export <id>` + `/session import <path>` 슬래시 명령으로 ADR-0157 (`src/session/import-export.ts` + `import-export-fs.ts`) 의 순수 serialization primitive 를 CLI 표면에 노출. 사용자 워크플로우: (1) `/session export <id> [--out=<path>]

###  Cargo prune (Round 5 CR1)


###  QUANTA_COMPACT_TOKENS


### 🆕 Per-tool granular checkpoint registry — in-memory ToolSnapshot store (ADR-0300)
ADR-0124 `ConversationCheckpointStore` 의 files+task sibling — pure in-memory `GranularRegistryPort` (`record/restore/list/clear`) storing `ToolSnapshot { toolCallId, turn, takenAt, filesBefore: ReadonlyMap<string,string>, taskMessagesBefore: ReadonlyArray<Message> }`. T1 ADR-

### 🆕 env/build 동적 컨텍스트 — platform/shell/git-status/pkg-mgr (ADR-0397)
buildDynamicContext에 platform(os/arch/version) + shell(SHELL env) + git-status(parsePorcelainV2 결과 압축 한 줄) + pkg-mgr(lock 파일 감지 fixed order: bun.lockb→pnpm-lock.yaml→yarn.lock→package-lock.json) 4가지 추가. TurnContextInput에 optional `env: TurnEn

###  Session JSONL envelope (5 top-level + 17+2 turn_context) (ADR-0034)


###  압축 프롬프트 verified-vs-assumed 강화


###  Async mention resolver + @file / @symbol mention kinds (ADR-0418)
Supersedes ADR-0325 (3-kind sync) + ADR-0330 (sync runner). Extends the mention enum to 5 kinds (skill | plugin | app | file | symbol) and flips the resolver port + injector to ASYNC so the new kinds can do I/O. Parser uses a DETERMINISTIC priority cascade on each `@<rest>` paylo

###  Codex anti-signal 7개 흡수


###  PreCompactRequestQuery (HITL)


###  renderActiveSkillsBlock — catalogue + trigger-rule footer (progressive disclosure)
Active-skills 카탈로그를 per-turn `<system-reminder>` 안에 `- $name — first-line` 목록 + 4-rule 트리거 footer 로 렌더한다. Description 의 FIRST LINE 만 사용 — 진짜 body 는 모델이 실제 invoke 할 때 `Skill` 도구로 lazy load(progressive disclosu

### ✨ Background (speculative) compaction — cancellable summarize + 2-phase install
When the live transcript is APPROACHING (not yet at) the context-window ceiling, start a CANCELLABLE summarize() as a background promise while the turn keeps running; at the turn boundary install the produced summary ONLY if it (a) completed AND (b) cleared the persist threshold,

###  BudgetProbe — real wire of ADR-0138 ledger into ADR-0265 budget-aware preset (ADR-0274)
Closes the deferred wire that ADR-0265's `budgetAwarePipeline` left open: a `BudgetProbe` factory that bridges `defaultBudgetLedger()` (ADR-0138) to the pipeline's duck-typed budget-gate seam WITHOUT crossing the slice fence (ADR-0159 forbids `@/retrieval` → `@/agent`). Ships t

###  buildTurnContext — system + per-turn dynamic assembly
`buildTurnContext(input)` → `{system: SystemBlock[], messages: Message[]}` 한 호출로 static system prefix(`buildSystemPrompt` 또는 caller 주입)와 per-turn dynamic 블록을 합성하는 SSOT. Dynamic 데이터(today date / cwd / mode notice / repo-rules / glob-rules / 

### 🆕 CLI action diff-preview — write/edit/apply_patch/scripted_replace 통합 unified diff
4개 변경-도구(`write` / `edit` / `apply_patch` / `scripted_replace`) 분기를 단일 `renderActionDiff()`로 통일 — before/after 텍스트 페어를 line-LCS unified diff(`@@ -a,b +c,d @@` hunks)로 렌더하고 ANSI 컬러(추가=green / 제거=red / hunk header=cyan)�

### 🆕 CLI markdown painter — assistant stream inline highlight (line-buffer FSM)
assistant 텍스트 스트림(델타 청크)을 라인 단위 유한상태머신으로 흘려 inline ANSI 컬러를 입히는 painter. 상태: header(`#`+`##`+`###`) / code-fence(```` ``` ````) / inline-code(`` ` ``) / bullet(`- ` / `* `). 델타 파편화 안전 — 청크가 �

###  Codebase indexer slice (ADR-0277)
Populates a SearchPipeline's underlying SemanticIndex / lexical store by walking the workspace, chunking files, and tracking deltas. Closed port `CodebaseIndexer { scanInitial, scanDelta, getCorpus, stop }`, closed 5-arm error taxonomy (`scan-in-progress`, `stopped`, `scan-failed

###  Compaction event emit (proactive + reactive) — ADR-0324 / 0331
Codex `Compaction / ContextCompaction / CompactionTrigger` ResponseItem parity in quanta. ADR-0324 added `compaction_event` as the 6th variant of the ADR-0320 closed-set (trigger: pre_sampling | mid_turn | user_requested; reason: context_limit | token_budget | manual; tokensBefor

###  Context-change persistent injection + buildTurnContext seam (ADR-0321 / 0327 / 0329)
Three-layer wire from state-diff producer to the model's per-turn view. ADR-0321 detector + buildPersistentInjectionMessages emit `<context-update>` envelopes via embedUntrusted. ADR-0327 adds the buildTurnContext seam — TurnContextInput gains 3 optional slots (contextChangeEve

###  Loop hook for plugin activation + auto-wire (ADR-0346 / 0350)
Closes the gap between ADR-0340 `cfg.activatePlugins` slot (per-session closure) and the per-turn invocation. ADR-0346 ships `src/agent/loop-activation-hook.ts` — `prepareTurnContext` calls `resolvePluginActivationForTurn(config, latestUserText, turnId)` BEFORE `buildTurnContex

###  Mention-injection pipeline + skill resolver + plugin activation trigger (ADR-0325 / 0330 / 0340)
4-layer mention pipeline parsing `@skill` / `plugin://name` / `@@app` out of user input and producing persistent typed events + injection messages. ADR-0325 ships parser + resolver port + event-emitter + inject-message builder (parser: ASCII kebab `[a-z][a-z0-9-]*`, email FP reje

###  Typed history event store (ADR-0320 + ADR-0335)
Closed-port typed event store that sits PARALLEL to the working memory message buffer. ADR-0320 ships the 5-variant foundation (context_update / skill_activation / repo_rules_change / mode_change / reasoning_echo) + in-memory adapter; ADR-0324 added the 6th variant compaction_eve

### 🆕 ConversationCheckpointStore — pure in-memory messages snapshot/restore (ADR-0124)
대화-레벨 rollback primitive — `ShadowOdb`(파일 face) 의 대화 face. Hermes Agent `/rollback` + Cline "Restore Files & Task" 가 file rollback 위에 conversation rollback 도 함께 제공하는 패턴. v3 는 ADR-0118 로 file rollback 은 있었지만 대화 face 가

###  ConversationSummaryArchive — sliding-window per-compaction summary log
Cursor compactor 의 `summaries[]` 모방. 각 compaction 직후 `appendSummary` 로 `ConversationSummaryEntry{fromTurnId, toTurnId, summary, ts, tokens}` 한 entry 를 archive 에 push — UI 가 "context history" 를 렌더하거나 debug inspector 가 "어떤 turn 이 어떤 s

###  "Unified-diff hunk headers + line-number gutters (CLI diff preview)"
Adds `@@ -A,B +C,D @@` hunk headers + old/new line-number gutters to the ANSI diff preview (was +/- prefix only). Groups changes into hunks with git-standard 3-line context, merges hunks within 2*context. Additive via a `{hunks}` option defaulting OFF → the original +/- render 

### 🆕 EmbedBatcher — 50ms window + single-flight dedupe + provider batch_size
Wrap any `embed(texts): Promise<vectors>` underlying with a closed-port batcher that fixes three failure modes of the single-text caller API: - N-call amplification: N concurrent same-tick `embed(text)` calls collapse into 1 underlying HTTP call (window coalesce). - Duplicate-tex

### 🆕 EmbedCache — idempotent content-hash + model-tag embedding cache
Idempotent embed cache keyed by `hash(text) + ":" + modelTag` so a provider/model swap automatically invalidates every stale entry (`cache.invalidate(oldTag)`) and the same (text, model) pair never re-pays the network/$ cost. Closed `EmbedCache` port with 5 methods (`get / put / 

###  findBoundary — orphan-safe tool_use/tool_result pair boundary
`findBoundary(messages, keepTurns)` 는 압축에서 가장 미묘한 invariant 를 보존한다 — Anthropic 은 suffix 안에 `tool_result` 가 있는데 짝지어진 `tool_use` 가 summarized prefix 로 빠지면 400 으로 거부한다. 알고리즘: (1) 끝에서부터 assi

### 🆕 ForkSessionPort — branch-name + signal + shadow-tag fork (ADR-0226)
ADR-0201 의 base `SessionForker` 를 둘러싸는 RICHER `ForkSessionPort` — Claude `/fork` + Cursor session-fork 가 노출하는 4-axis UX 흡수: (1) 사람이 grep 할 수 있는 `branchName` (URL-safe 64-char alphabet, collision-resistant ~126-bit branch id); (2) `AbortSi

###  fourSectionPreset + buildSectionedSystemBlocks — pure renderer (collapse-empty)
Pure 렌더링 모듈. `fourSectionPreset(input)` 은 `base + project_md + session_ctx + user_append` 4-튜플에서 whitespace-only 입력을 자동 collapse — 결과는 항상 1..4 PromptSection, 빈 블록 없음. `buildSectionedSystemBlocks(sections)` 는 그 리스트를 `

###  Glob-matched + always-applied auto-injected rules (Cursor .mdc parity)
Cursor의 4 rule kind 중 2개 (alwaysApply + glob-matched)를 흡수 — 모델이 요청 없이 프롬프트에 자동 주입되는 file-scoped 룰. `.cursor/rules/*.mdc` 와 `.quanta/rules/*.mdc` 를 frontmatter (`alwaysApply` + `globs`) + body로 파싱, 매 턴 `changedPaths

###  extractExpectedActual — opt-in inline E/A phrase extractor
OPT-IN sentence-bounded extractor for inline expected/actual phrasing in issue bodies (keywords: expected / expect / actual / actually / got / should / but / instead — word-boundary, case-insensitive). Gated by a SEPARATE env (`QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL=1`) beneat

###  Issue-hint extraction — Agentless-style structured signal scan
Pure deterministic extractors that scan an issue/problem-statement string and surface a structured `IssueHint` (files, errors, code fences, traceback paths, symbols) for downstream localization. Conservative posture — NO heuristics: paths require a slash + recognized extension;

### 🆕 LexicalSearch — BM25 + ripgrep pluggable retrieval engine (ADR-0260)
ADR-0159 retrieval slice 의 first-stage 누락 봉합 — Phase 7 pluggable lexical engine. 닫힌 `LexicalSearch` port (`index` / `query` / `clear` / `size`) + 2 production adapter (in-memory BM25 + ripgrep shell-out) + deterministic headless stub. BM25 는 Lucene defaults (k1=

###  memory_summary.md → session_ctx breakpoint coalesce (ADR-0068)
Phase-2 consolidated `memory_summary.md` 본문을 4-section preset 의 `session_ctx` breakpoint 에 prepend 하는 흐름. 별도 breakpoint를 따로 잡지 않고 session-stable 특성이 같은 `session_ctx` 와 coalesce — 그래서 `MAX_CACHE_BREAKPOINTS=4` 가 by-construc

###  PLAN/REVIEW/AUDIT mode notice — per-turn reminder injection
PLAN/REVIEW/AUDIT 모드 별 verbatim 본문을 `PLAN_NOTICE` / `REVIEW_NOTICE` / `AUDIT_NOTICE` 상수로 고정하고, `modeNotice(mode)` 가 mode → notice text 매핑 (default 는 undefined → block 미렌더). `resolveAgentMode(input.mode, input.planMode)` ADR-0018 SSOT �

### 🆕 ModelTag invalidator auto-hook — EmbedCache + VectorStore registrar (ADR-0273)
Wrap the ADR-0266 ModelTag invalidator's callback registry with a single registrar that stages a cache + a store and attaches them as `InvalidationCallback`s in one call. Composition roots get a one-line seam instead of N hand-rolled shims around `cache.invalidate(tag)` + `store.

### 🆕 ModelTag versioning + invalidator + canonical codec (ADR-0266)
Tag every stored embedding with its producing model identity (provider / model / version / dim) using a canonical, round-trippable string form `{provider}-{model}-v{version}-d{dim}`. When the embedder is swapped (vendor change / model bump / dim change / major version bump) the d

###  Multi-source rules vendor-detector (5-vendor convergence, ADR-0205)
6-vendor 자동 감지: .cursor/rules/*.mdc + .clinerules(file|dir) + .roo/rules-{mode}/*.md + .aider.conf.yml + CONVENTIONS.md + .windsurfrules + .quanta/rules/*. port-shaped (VendorDetectorPort.detectAll → DetectionResult), no-throw across boundary, declarative VENDOR_TABLE 6

### 🆕 Multi-modal embedding MVP — image + audio embedding port (ADR-0276)
Direct path from a binary blob (image / audio) to a retrieval embedding vector. Sibling-extension of ADR-0261 (text-only Embedder + 8 vendor factories — unchanged). The new MultiModalEmbedder port accepts a 3-arm discriminated input ({kind:"text"|"image"|"audio"}) and returns R

###  onSessionMinted callback port — resume-fsm surface decoupling (DIP)
Surface-supplied hook fired ONCE when a fresh session id is minted via `--new-session` inside the surface-AGNOSTIC `resolveResume` FSM (relocated to `@/runner/orchestrate/resume-fsm.ts`). Lets the CLI surface emit its legacy `session: <id>` log line without coupling the runner sl

###  Pipeline composition-root wire — assemblePipeline(env) + search_codebase tool (ADR-0272)
`assemblePipeline(env)` reads `QUANTA_PIPELINE` (closed 6-arm enum: `none` | `lexical-only` | `semantic-only` | `parallel-rrf` | `semantic-then-rerank` | `budget-aware`) and either returns a wired `SearchPipeline` or `null` (default-OFF). For each non-`none` preset the helper wir

### 🆕 Pluggable Embedder + VectorStore provider registry (ADR-0261)
Provider-swap seam for both retrieval axes (embedder + vector store) with closed-port contracts and env-driven selection. `QUANTA_EMBED_PROVIDER ∈ {openai, voyage, cohere, ollama, headless}` and `QUANTA_VECTOR_STORE ∈ {in-memory, sqlite, lance, qdrant}` swap engines without s

###  PromptSource / PromptPayload type widening (string | {text, images?})
Layer-2 `@/runner`가 surface (CLI raw-mode / Web WebSocket / Tauri IPC)에 의존하지 않도록 노출한 `PromptSource` 포트 + `PromptPayload` back-compat union. `PromptPayload = string | { text, images? }` — pre-multi-modal surface는 plain string 그대로 반환(byte-i

###  reactiveCompact — PTL-recovery aggressive squeeze + continuation summary
Proactive `compactIfNeeded` 가 `DEFAULT_KEEP_TURNS=6` 으로 부드럽게 줄이는 반면, `reactiveCompact` 는 loop 이 이미 "prompt is too long" API 에러를 맞은 뒤 호출되는 harder squeeze. `REACTIVE_KEEP_TURNS=2` 만 verbatim 유지하고 CONTINUATION_SYSTEM 프�

### 🆕 Real-API smoke eval for retrieval — drift detection (ADR-0275)
Phase 7 retrieval hellgate suite (ADR-0261 / ADR-0262) 는 전부 injected fake fetch — vendor (OpenAI / Voyage / Cohere / Ollama) 가 응답 shape / URL / auth / rate-limit semantics 를 바꿔도 unit 은 green 인 채 production 만 망가지는 drift 구멍이 있었다. AD

### 🆕 Reranker port — Cohere/Voyage REST adapters + identity default (ADR-0262)
ADR-0159 의 `RerankPort` family (identity / bm25-secondary / tier-aware / RRF) 은 PURE 전략 4종 — query-aware 채점이 아니라 caller 의 기존 score 를 reorder 한다. 본 슬라이스는 그 옆의 NEW closed port `Reranker<T>` — vendor 채점 (Cohere `rerank-v3.5

###  SearchPipeline composer + 5 pre-built presets (ADR-0265)
Pure functional DAG composer for retrieval pipelines. Reduces a `Stage[]` discriminated union (lexical / semantic / rerank / rrf / budget-gate) to a `SearchPipeline { search(query) → Result<SearchHit[], PipelineError> }`. Generalizes the legacy `runHybridQuery` 3-stage funnel w

### 🆕 Semantic-search port — embedding-based retrieval seam (Cline-style)
Cline / Cursor `CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL` 패턴 흡수의 slice primitive — 워크스페이스 코퍼스를 in-memory index로 묶고 쿼리 임베딩 대비 cosine similarity로 top-k 검색. quanta는 `grep`/`glob`/`lsp_nav` 같은 lexical retrieval과 ADR-01

###  Session envelope encoder/decoder — deterministic key-sorted JSONL
Encode/decode pair for the per-line records that make up the session JSONL rail. `encodeSessionLine` emits one JSON object terminated by exactly one `
`, with object keys sorted alphabetically at every nesting level so two semantically-equal records produce byte-identical wire f

###  Session git fingerprint capture (sha + branch + origin URL)
Captures the three-field git fingerprint (HEAD sha / branch / origin URL) onto `SessionMeta` so replay / trajectory / reproducibility surfaces know exactly which commit a session ran against. Codex §18.9 absorption (`threads.git_sha + git_branch + git_origin_url`). Best-effort: 

###  '`@/protocol/session` — surface-agnostic session protocol (command/event/snapshot codec)'
`src/protocol/session/` — the canonical, surface-agnostic wire protocol that the IPC session transport and the web-daemon WS surface speak (one JSON envelope per frame). Three message families, each a versioned envelope (`{ version, kind, payload }`) pinned to `SESSION_PROTOCOL

###  Session id sanitizer — filesystem-safe path component validator
Hardened id validator enforcing that a session id is safe to use as a single filesystem path component under `sessionsRoot()`. Rejects (with typed `SessionIdError`): empties, length > 128, `.` / `..` segments, leading `-` (CLI-flag confusion), path separators (`/`, `\`), NUL, ASC

### 🆕 SideChatManager — auxiliary conversation lifecycle with parent isolation (ADR-0244)
Claude Desktop `LocalSessions.{startSideChat, sendSideChatMessage, stopSideChat}` 흡수 — 부모 세션 컨텍스트를 보호하면서 임시 보조 대화를 실행하는 addressable lifecycle 프리미티브. ADR-0201 fork-session 은 *스냅샷 분기* 가, ADR-0049 side-c

###  Soft task-budget (model self-moderation)
SOFT, model-facing token budget — the quanta mirror of Claude's `task_budget: { type: "tokens", total: N }`. When the operator sets a budget (via the `task-budget` knob / `QUANTA_TASK_BUDGET`), the loop accumulates the session's observed input+output token usage and forwards `{

###  todayDateLine — injected clock port for byte-identical replay (ADR-0078)
Per-turn dynamic block 의 `Today's date is YYYY-MM-DD.` 라인이 매 턴 wall-clock 을 빨아들이면 prompt 가 매일 drift 해 byte-identical replay invariant 가 깨진다. `TurnContextInput.now?: () => number` 를 주입 가능한 clock port 로 노출 — 프로덕션 �

###  estimateTokens — chars/4 heuristic with image fixed-budget
Threshold 게이트(`compactIfNeeded` / reactive drop-ratio guard) 입력으로 사용되는 `estimateTokens(messages)` 휴리스틱. `blockChars` 는 ContentBlock 변종별로 분기 — `text`/`thinking`은 본문 길이, `tool_use`는 name + JSON-stringify(input), `tool_result


---
## 05-memory

###  memory_citation provenance surface (ADR-0082)
Surface "which record was placed in this run's prompt window, where, with what score". Provenance signal (placement = citation), NOT a heuristic scan of the assistant's response. Closed where-enum {system_prompt|reminder_tail|tool_result_injection}; today every v3 citation is `re

###  시스템 프롬프트에 "Durable state belongs in workspace files" 단락


###  L3 WorkingState


###  세션종료 LLM distill
세션 종료 시 LLM distill (provider 미주입 / 호출 실패 시 휴리스틱 폴백), pre-save dedup 후보 발견 시 LLM이 merge/supersede 중재, 정주기 eviction + age 기반 importance decay로 long-term store가 한도 안에서 유지되도록 하는 자동 지식

###  memory_search/write/update


###  동적 reminder의 memory recall 블록에 "routing hints only


###  src/agent/working-state.ts


###  tier


###  QUANTA_MEMORY[_PATH/_EMBED/_EMBED_MODEL/_RECALL_LIMIT/_DISTILL/_CONSOLIDATE/_SEL
메모리 서브시스템 surface knob 집합 `QUANTA_MEMORY_*` (PATH / EMBED / EMBED_MODEL / RECALL_LIMIT / DISTILL / CONSOLIDATE / SELF_EDIT / RECALL_TIERS). 각각 store 위치, 임베딩 어댑터, 임베딩 모델 식별자, recall 결과 cap, 세션 종료 distill, 2-phase 

###  '`snapshot()` deep-copy'


### 🆕 Stage1 → Phase 2 consume wire + vendor-rule glob wire (ADR-0233)
Wave 3 wire — (a) ADR-0207/0216 stage1 store 의 SELECT 측면을 Phase 2 consumer 가 실제로 소비 (이전엔 INSERT 만 wire, SELECT 는 dormant); (b) ADR-0205 vendor-rules-detector 가 발견한 vendor 룰의 glob 필터를 실제 rules-tree 로딩 경로에 splice. 두 

### ✨ Per-string 캡 + empty-patch refine


### 🆕 semantic index 실 embedder + pluggable vector-store backend (ADR-0392, ADR-0424)
startIndexer가 더 이상 placeholder hashEmbed(64-d FNV)만 쓰지 않는다 — ADR-0261 embedder 레지스트리(createEmbedderFromEnv: openai/voyage/cohere/ ollama/headless)에 wired. env 미설정 / embedder null ⇒ hashEmbed default, real provider failure는 SAME-DIM dete

###  Codex 2-phase memory consolidator — per-thread distill + cross-session synthesizer
Codex memory model의 2-phase distill+consolidator 흡수 — 기존 SOTA++ hybrid recall (ADR-0008, embedding+lexical+tag+freshness+tier+reinforcement)이 메우지 못한 두 구조적 갭을 닫음. (1) **사용자-검수가능 distilled 지식 부재** — embedding store는 

###  Memory learning default-ON via session factory (ADR-0413)
Flip memory learning from default-OFF to default-ON via one canonical surface-agnostic factory buildMemoryForSession(env, override?) that resolves all three slots (store / config / auto-trigger) in one place. Default-ON is backed by a VOLATILE InMemoryStore — zero disk side eff

###  ADR-0216 Stage1StorePortV2 (agent-side, no-throw, 4-verb persist seam)
Agent-side seam for persisting Phase 1 `stage1_outputs` rows. Closes the R1 false-positive where the SQL INSERT was wired in source (`runPhase1` → `store.upsert`) but a host opting into `memoryConsolidator.enabled` without supplying a `store?` would silently skip with `reason:"

### 🆕 auto-dream — cross-session memory consolidation trigger (H16)
Cross-SESSION memory consolidation glue ("auto-dream"). Sits ON TOP of the existing session-end consolidate pipeline (ADR-0068 `runPhase2`, ADR-0281 auto-trigger) — it does NOT reimplement consolidation. A small PERSISTED counter/clock (`DreamState`: sessions-since-last-dream +

###  Session-end consolidator hook — runMemoryConsolidatorHook (no-throw L4 wire)
Pure wiring around `runPhase1`. Converts the agent's session-end signal + host-injected `Phase1Port` / `Stage1StorePort` + final AgentOutcome into a `Phase1Input`, invokes the consolidator, and turns the result into a structured outcome (`distilled` / `skipped` / `error`). NO-THR

###  Consolidator distill-input redaction port — abstracted seam for Phase 1 LLM
Abstracted redaction seam at the consolidator boundary: `consolidator.redact?: (s:string) => string` on `ConsolidatorHookInput`. Each rollout message's string-leaf content (and each `{type:"text"}` block inside structured arrays) is run through the redactor BEFORE `runPhase1` rec

###  EmbedderPort — pluggable embedding provider seam (OpenAI / Null / Caching)
The memory slice owns the structural EmbedderPort interface (so it stays free of any LLM-provider import per slice-isolation), while concrete implementations live in @/agent (the only cross-slice importer). Three shipped providers: OpenAIEmbedder (batched real provider, wraps tra

###  ADR-0281 — Memory auto-trigger (session-end → phase1 → phase2 promote)
Closes the cross-session knowledge gap by wiring session-end Phase 1 distill → stage1 store → similarity-based Phase 2 promotion under a single closed `MemoryAutoTrigger` port. The default lexical-Jaccard scoring adapter compares the new Stage 1 entry's `rolloutSummary` token

###  ADR-0282 — Cross-session memory inject (selectForInject → prompt section)
Read path for ADR-0281: at session start, `CrossSessionInjector. selectForInject({maxBytes})` reads the stage1 store, filters to `selectedForPhase2 && usageCount ≥ 1`, drops empty/whitespace and non-string summaries, applies optional kindFilter (first-token match on `rolloutSum

###  Pure near-duplicate detection — pre-save merge/supersede candidates
Before saving a new memory entry the store asks: does an equivalent entry already exist? Pure planner that surfaces candidate matches via two complementary similarity channels (semantic vector + lexical token overlap) so paraphrases AND embedding-less rows both get caught. Return

###  Memory distill input fence — redactSecrets before LLM sees transcript
Third application point of the content-plane redaction invariant — the transcript handed to the LLM distiller (`distillSession`) is run through `redactSecrets({origin:"memory_distill"})` BEFORE the LLM sees a single byte. Pairs with the two other application points (tool_result

###  Pure eviction planner — per-tier caps + supersede prune + ancient decay
Periodic full-store sweep that bounds each memory tier (semantic / episodic), prunes ancient superseded rows, and decays long-archived low-value memories. Pure planner: returns only ids to delete + ids to decay (importance multiplier) — the caller performs the actual writes so 

###  @/memory → @/llm slice fence cleanup — dead REMOVE-ME stub deleted
Slice S9 Part A — delete the orphan `REMOVE-ME (verify biome fence)` stub at `src/memory/consolidate/phase2-llm.ts:30-40`: `import { assembleFromEvents as _verify } from "@/llm"` plus its `const _useVerify = _verify` dead alias. The stub had zero consumers (verified via grep) y

###  Self-edit memory line citations + per-thread mode + budget write-guard
Three INDEPENDENT, default-OFF axes folded into `MemoryToolsDeps` on the `memoryTools(deps)` seam (Codex `codex_memories_extension`): 1. Line-level citations — `LineCitation { recordId, lineStart, lineEnd }` (1-based inclusive); when on, `memory_search` appends `[L<s>-<e>]` so 

###  MEMORY.md 3-file atomic writer + git-tracked commit (ADR-0068 Wave B)
Owns the on-disk side of the Phase 2 cross-session consolidator. Three user-visible markdown files (MEMORY.md / raw_memories.md / memory_summary.md) under `~/.quanta/memory/` are produced atomically via a temp-then-rename dance: all three temp files are written in Phase A, then t

###  4-state memory outcome enum (partial / success / uncertain / fail)
Codex memory corpus(R4+R6) production 분포 (partial 75% / success 15% / uncertain 10% / fail 1%)를 4-state fixed-set enum으로 흡수. 기존 memory 자유형 percentage 표현 (“80% done”)이 후속 세션에서 inflation hallucination 의 직격 원인이 되는 것을 

### 🆕 Memory recall citation surface in turn-summary (user-visible provenance)
`AgentOutcome.memoryCitations` (ADR-0082, `memory-citation-surface` feature가 생성하는 신호)를 사용자에게 가시화하는 첫 consumer — `cli-turn-summary` 패널의 memory row가 한 줄로 표시: `◇ memory: N hits (id1, id2, id3, +K more)`. recordId만 노출�

###  memory_search / memory_write / memory_update — self-edit tools (RFC §6.3)
Three first-class agent tools letting the model search, write, and revise its own durable memory mid-session. Plane-clean — imports only `@/memory` (ports + types), `@/shared` (errMessage), `@/tool` types, `zod`. NEVER `@/agent`, `@/llm`, `@/permission`. Every `execute` is defe

###  MemoryTelemetryPort — inverted-dependency seam for phase1/phase2/recall metrics
Structural port that lets the @/memory slice emit phase1 (per-thread distill), phase2 (global consolidator), and recall (rank) telemetry WITHOUT importing @/observability — preserving the slice-isolation invariant documented in `src/memory/consolidate/constants.ts:53-64` (and e

###  Memory vector math — pure cosine / dot / normalize + Float32 serde
Pure vector math + (de)serialization for semantic recall. Zero deps: a Float32 little-endian buffer is the on-disk form (the SQLite embedding column is a BLOB), the in-memory form is a plain `number[]`. Shared by both memory adapters and the ranking layer so similarity semantics 

###  Stage1Store — per-thread distill rows + consolidate_watermark (ADR-0068 Wave A)
SQLite-backed `Stage1StorePort` implementation owning the `stage1_outputs` + `consolidate_watermark` tables that record per-thread Phase 1 distill outputs and the Phase 2 selection watermark. Additive schema: does NOT touch the legacy `memories` recall table, so existing recall +

###  Phase 2 session-start auto-trigger — runMemoryPhase2AutoTrigger (non-blocking)
Mirror of the session-end Phase 1 hook for the Phase 2 cross-session synthesizer. Reads Stage1 watermark + pending count from the injected `Stage1StorePort` at session-start; if `pending ≥ PHASE2_AUTO_TRIGGER_PENDING` OR `age_ms ≥ PHASE2_AUTO_TRIGGER_MAX_AGE_MS` (and pending 

###  Stage1 → Phase2 promotion gate (10% sample rate, fail-excluded, score-ranked)
Codex production stat 10% promotion rate를 selectForPhase2Promotion(entries, {sampleRate?}) 로 흡수. PURE function — clock/RNG/I/O 없음, deterministic. 필터 → 스코어 → 정렬 → 캡 순서: 1. HARD GATE: outcome === 'fail' 무조건 제외 (proof contradicted �

###  Preference phrase grammar — literal quote + count-based confidence + evidence anchor
Codex memory의 feedback-type 메모리 body 컨벤션 흡수 — 자유형 paraphrase 대신 4-field 구조화 grammar: **When the user said** "코드 레벨로만" ← literal quote (Korean/English 보존) **They meant**: … ← author's interpretation **Evidence**: src/foo.ts

### 🆕 Token-bucket re-chunker — 4 buckets × 10% sliding-window overlap
Split a long text into fixed-size token chunks with sliding-window overlap so downstream context windows can ingest big documents without dropping middle content. 4 buckets: - identity — no split; emit [text] unchanged - small-600 — 600 tokens - medium-2400 — 2400 tokens - 

### 🆕 Commit embedding — git-aware recall over recent commit messages with LRU cache
Pull recent git commit notes and embed them so a query like "why did we revert X" can recall the deciding commit by semantic similarity to its message body, not just by author / date / sha. Architecture is closed ports: - GitLogPort: the slice does NOT shell out itself — produc

###  Retrieval-stack composition-root wire — buildRetrievalStackCore + memory/localize bridges + AgentConfig slot (ADR-0159 wire)
Composition-root wire for the ADR-0159 retrieval stack. The 5 retrieval axes (rerank registry / chunk-bucket / commit-embedder / multi-vendor embedding / hybrid-query funnel) landed as primitives — until this wire, ZERO invocations existed from src/runner/ or src/apps/ (dead co

### 🆕 Hybrid query 3-stage funnel — keywords / embeddings / hybrid with optional final rerank
Pure orchestration over 4 axes. Stages: 1. Run the source(s) the query type asks for - keywords → BM25 source only - embeddings → embedding source only - hybrid → both, IN PARALLEL (Promise.all) 2. If both ran, fuse with RRF (Cormack 2009 k=60). 3. If a final-stage rerank i

### 🆕 Multi-vendor embedding port — 8 vendors (2 runtime + 6 type-level stub)
Generic seam over every embedding provider. Each concrete adapter lives in src/retrieval/embedders/<vendor>.ts and implements EmbeddingPort with its own vendor discriminator. 8 vendors total: - openai, voyage — runtime adapters (HTTP injected) - cohere, gemini, xai, moonshot, n

### 🆕 Reranker port + registry — 4 built-in strategies (identity / bm25-secondary / tier-aware / score-fusion-rrf)
Closed-by-default registry for second-stage rerankers over any candidate list (BM25 hits / embedding hits / external sources). The RerankPort port is a single async function — every concrete strategy is a separate SRP file: - identity: pass-through, default when operator has no

###  SQLite PersistentStorePort — long-term memory disk-backed adapter
Long-term 메모리 entries의 disk-backed PersistentStorePort 구현. `bun:sqlite` 사용 (외부 dep 0, Bun 내장). `rankEntries`(ranking.ts)와 함께 의미 검색 + 시간 기반 fade. in-memory adapter는 테스트/dev용, sqlite adapter는 production 영속성. 동일 Per

###  WorkingMemory — in-session message buffer (RFC §6.3 L1)
L1 in-session message buffer used by the agent loop to hold the live turn transcript. Distinct from L2 long-term memory: working memory is never persisted to a store and is dropped on session end. Generic over the message shape (`WorkingMemory<M>`) so the agent layer can bind it 


---
## 06-tier1

###  Eval 스키마 additive 필드 (keyed metrics / token·cost / run status·params)
Cursor aiserver.v1.EvalTrackingService에서 typed shape 3개만 흡수 — JSONL append-only eval 저장(schema.ts, zod 없음 plain TS)에 OPTIONAL·additive 필드 추가. Metric{key,value,unit?,step?}(단일 score보다 우월: named axis + step), TokenUsage {prompt,completio

###  agent
`agent` 도구(=Task) — 부모 loop가 자식 runAgent를 fork해 sub-thread로 실행. 부모는 자식의 `task_output` 채널을 통해 progress를 받고, `task_stop`으로 force-cancel을 보낼 수 있다. 활성 자식은 `TaskRegistry` 에 등록되어 lifecycle / cance

###  "`MUTATING_MODES = Set<AgentMode>([\"default\"])` 인버스"
AgentMode 4-arm (default | plan | review | audit)에서 mutating tool 허용을 positive set(`MUTATING_MODES = Set<AgentMode>(["default"])`)으로 표현하는 인버스 디자인. read-only-set 인버스였다면 신규로 추가되는 mode가 자동으로 write access를 받는

###  QUANTA_SKILLS_DIR
frontmatter 발견 → 본문 컨텍스트 주입. CLI surface는 `QUANTA_SKILLS_DIR` 세트 시 `buildSkillsConfigCore` → `buildSkillBlock` → `discoverSkills` 흐름으로 user-supplied SKILL.md 디렉토리 inventory를 session-start에 캐싱하고 Skill 도구를 ToolRegi

###  Localize tool — BM25-lite + FrameTier + def-boost + recall@1 polish
Stage-1 candidate generator in the file→function→edit funnel. Replaces flat term-count scoring with BM25-lite IDF weighting (rare term outranks common one), shared camelCase / snake / kebab / mcp__ subtoken split mirrored from the tool-search side, and FrameTier penalty so ve

###  Branch-search minimal-change bias + progress surface
Verifier and selector that bias the speculative branch search toward smaller patches. patchSizeVerifier attaches a patch_size signal to each candidate using the per-candidate delta from ADR-0116; minimalChangeSelector uses that signal as a tie-breaker (then primary ordering when 

### 🆕 BudgetLedger + budget_status — cross-run typed BudgetBreach primitive (ADR-0138)
Closed-port primitive that hardens the failure mode Cline's `$50 in one afternoon` retry-loop incident exposed: no programmatic cross-run budget with a typed circuit-breaker event. `BudgetMeter` (ADR-existing) gates a single RUN; this ledger is orthogonal — ACROSS-runs cumulati

###  Background-subagent caller wire — ADR-0130 helper exposed to loop
Caller-wire closure for ADR-0130 — adds AgentConfig.subagentBackground typed slot + FeaturesConfig Pick + buildSessionFeatures composer step so the BackgroundSubagentScheduler helper actually reaches the loop's extraTools. Without this wire, the 3 LLM-facing tools (subagent_for

###  Background subagent scheduler
Scheduler that runs a subagent fork in the background so the parent loop continues turn-taking while the subagent works. Pairs with a wait/await tool the parent uses to collect the background result when it's ready. Bridges the Tier-1 subagent surface with the background executio

### 🆕 Engineering-task skill bundle — debug-error / add-tests / explain-code / extract-function (ADR-0134)
ADR-0111 absorbed 8 CTK git skills; this ADR closes the engineering-task slice with 4 highest-ROI prompts (Cursor CTK engineering-task subset). Prompt-only (zero code dependencies) — each skill is SKILL.md + trivial index.ts router entry (NAME constant + Trigger interface + tri

###  매트릭스 보강 (2026-05-21)
review/audit 모드 — dispatch에서 mutating 차단 + 프롬프트에 REVIEW_NOTICE/AUDIT_NOTICE 주입. 별도 도구 없음. runAgent e2e 5 tests: plan/review/audit 각각 mutating tool dispatch 차단 (execute() 미도달 검증) → ok:false + 모드명 preview → 루프 

###  bounded 다단계 재귀
서브에이전트 다단계 재귀를 `maxDepth` (default 3)로 hard-bound. 자식 호출 마다 `req.depth = parentDepth + 1`이 전파되고, `req.depth > maxDepth`인 spawn 시도는 throw가 아니라 recoverable `deny` tool_result로 부모에게 반환된다 — 모델이 

###  tool-scoping 강제
활성 스킬의 `allowedTools` 프론트매터를 LOAD-BEARING 권한 경계로 강제 — 스킬이 활성화된 동안 그 set에 없는 도구는 호출이 차단된다 (deny message는 위반 도구명 + 허용 목록을 명시해 모델이 다른 경로로 회복 가능). `

### 🆕 User-authored playbook frontmatter (procedure / success-criteria / forbidden-actions / macros / inline-trigger) — ADR-0203
ADR-0040의 strict 6-field SKILL.md frontmatter 위에 author-facing procedural 슬롯 4개 + inline trigger 1개를 추가하는 누적 슬라이스. 기존 lenient/strict parser는 손대지 않고 `src/skill/playbook/` 신설 leaf 슬라이스로 PARALLEL parser 제공. 5-vend

###  Mode-typed delegation (parent → child mode-typed handoff)
Parent → child mode-typed handoff with isolated context. 4-vendor convergence (Roo Boomerang/Orchestrator, Devin sub-task delegation, Codex `spawn_agent({ role })`, Cursor `subagent_await`): every delegation declares its mode up front, which selects (a) the child's prompt voice

###  Focus Chain (automatic N-turn todo-list re-injection)
Cline absorption: every N turns (default 6) auto-splice the current todo list into the next prompt as a `## Focus Chain — Todos` markdown block so a long-running autonomous session doesn't lose the multi-step plan when it ages out of context. Drift detector: N turns of zero tod

###  Auto-background after 2 s — stuck-detector + propose-handler observer
Claude Code SOTA absorption: when a long-running tool exec sits >2 s with no progress, the UX automatically surfaces "move this to background?" and one keystroke (Esc/Enter) flips the call into the detached path (ADR-0140's BackgroundSubagentScheduler). Today quanta has the under

###  Queued follow-up per-msg mutators (retry / edit / delete / sendNow)
Codex Desktop composer absorption: each paused/active follow-up gets 4 mutators — `retry` (re-queue same body), `edit` (in-place body update), `delete` (remove entry), `sendNow` (non-interrupting injection: bypass paused state, append to next LLM turn user message WITHOUT abort

###  Playbook inline-trigger CLI auto-bind opt-in
Closes ADR-0203/0240's last unwired hop: the `AgentConfig.playbookTrigger` slot is now reachable via `--playbook-trigger` flag OR `QUANTA_PLAYBOOK_TRIGGER=on` env (env wins). `maybeStartPlaybookTriggerWire` in `apps/cli/repl/playbook-trigger-wire.ts` constructs an FS watcher root

### 🆕 Subagent fanout parallelization — `agent.isConcurrencySafe = true` + `parallel_worker` flag (ADR-0298)
Cursor 3.2 `is_parallel_worker:true` 패턴을 흡수하여 단일 assistant 메시지에 `agent` 도구 호출 N개를 emit 했을 때 streaming-dispatch barrier 가 자동으로 병렬 dispatch (Phase 1 in-flight overlap) 하도록 `agent.isConcurrencySafe` 를 `() => false` �

### ✨ Lexical refine (2026-05-21)


###  Plan-mode 구조화 메타도구 + state-machine (SOTA++ ADR-0095 draft)
ROI-무관 SOTA++ 흡수 — Cursor maximalist 도구셋(create_plan/update_todos) + Codex 이벤트 관측(plan_delta/plan_snapshot) + Claude 승인 ergonomics(plan-exit-three-way, 별개 L4)를 합쳐 세 모델 모두 능가하는 구조화 plan-state-machine. 5-state TodoStat

###  QUANTA_SUBAGENT[_MAX_DEPTH]
서브에이전트 기본-OFF 게이트 + git worktree 격리 + 재귀 한도 (`_MAX_DEPTH`, default 3). CLI surface는 `QUANTA_SUBAGENT` 세트로 enable, `QUANTA_SUBAGENT_MAX_DEPTH` 로 cap override. `buildSubagentConfigCore` 가 env → SubagentConfig 변환, `buildSubagentBlo

### 🆕 --playbook-trigger CLI flag echo through to wire (close ADR-0293 last-mile)
Closes the ADR-0293 last-mile gap. ADR-0293 added the `--playbook-trigger` boolean to the unified-agent CLI parser AND built `maybeStartPlaybookTriggerWire({ env, cliFlag, ... })` so the watcher honours an explicit flag in addition to the `QUANTA_PLAYBOOK_TRIGGER=on` env var. ADR

### 🆕 동기 delegate 도구 — mode-typed in-band boomerang (ADR-0393)
quanta엔 이미 background subagent(subagent_fork/poll/await, ADR-0140)와 6-tool(spawn_agent 등)이 있다. 이건 **동기** delegation 도구 — 부모가 자식에 위임하고 결과를 그 자리에서 받는(boomerang) LLM-facing surface. closed-enum mode(architect/edit

### ⏸ Activation-timing phase 분리


###  Safety-posture 전파 (Round 2 fix)
Safety-posture 전파 — buildChildConfig가 부모의 mode/verifyGuard/closeoutGuard/hitl를 옵셔널 spread로 자식에 전파. 이전엔 자식이 default mode로 붕괴 가능 → review-posture 부모가 mutating 자식을 spawn할 위험. CLI surface는 `QUANTA_SUBAGENT`

###  읽기 seam 노출


### 🆕 LSP textDocument/rename RPC + 2-phase atomic WorkspaceEdit 적용 (ADR-0404)
ADR-0141 `RenameApplyPort` + `lsp_rename_apply` 도구는 만들어져 있었으나 RPC/어댑터/등록 3 legs 누락. 이 ADR에서 채움. (1) base.ts에 textDocument/ rename RPC + toRenameWorkspaceEdit 정규화 — nav RPC + prepareRename 패턴 미러. applyWorkspaceEdit(2-

### 🆕 Edit-후 LSP diagnostics 자동 주입 hook (ADR-0405)
edit/write/apply_patch 같은 mutating 도구 실행 후 LSP diagnostics를 자동으로 가져와 다음 턴 프롬프트에 inject — 모델이 명시적으로 diagnostics 도구 호출 안 해도 type/lint 에러 즉시 가시화. dispatch.ts/loop.ts 0줄 변경 (ADR-0133 pro

### 🆕 force_background — promote a queued background subagent
Two-part absorption of Cursor's force_background_subagent "run this queued task now" affordance. (1) An opt-in admission wait-queue: when fork() would exceed maxConcurrent, instead of throwing cap-exceeded the spec is parked as a 5th `queued` status (bounded by maxQueued) and FIF

###  루프 wiring 추가
paths: 조건부 활성 — skillsActivatedFor/skillToolAllowlist 호스트 API 노출. AgentConfig.skills.changedPaths?: string[] 옵셔널 필드 — set 시 buildSkillFeatures가 unconditional 스킬 + paths: 매칭 스킬로 per-turn suggestion inventory 구성. buildSessionF

###  agent_role enum (explorer/worker/none) + maestro nickname pool


###  플러그인 매니페스트 (.quanta-plugin/plugin.json + .mcp.json + skills/)
`.quanta-plugin/plugin.json` (strict Zod) + 옵셔널 `.mcp.json` + `skills/<name>/SKILL.md` 3-surface 레이아웃. Codex `.codex-plugin/` 패턴을 v3 path 명으로 흡수 (RFC §1.6). loader는 cause-typed PluginManifestError 분기 — silent fallback 0. discovery는 depth 4

### 🆕 Skill 7-scope tiering (ADR-0134, builtIn / system / admin / team / repo / user / personal)
Codex의 7-scope skill registry 패턴 흡수 (R4 발견). 닫힌 union `SkillScope` (7 value) + `SkillInstallState` (required/recommended/optional) + 고정 precedence `admin > repo > team > user > personal > system > builtIn`. `Skill.scope` 는 frontmatter explicit > path-infer

### 🆕 Skill admin enforcement — org-policy.json + install decision (ADR-0134 §3)
`<orgConfigDir>/org-policy.json` strict Zod schema (requiredSkills/bannedSkills/auditRequired/org). `loadAdminPolicy({orgConfigDir, readPolicyFile})` 는 closed-port (test seam). 부재 ⇒ policy:null = admin scope 비활성 (ADR §3). 순수 결정 함수 `decideInstall(attempt

###  Skill 트리거 규칙 (ADR-0022)
Skill 트리거 규칙 (ADR-0022) — session start 시 inventory cache, per-turn reminder에 `## Active skills` 블록 + 4 rule (explicit $name mention OR description match → mandatory / multi-skill minimal covering / progressive disclosure: per-turn은 {name, description} 만

### 🆕 Skill install audit log — append-only JSONL (ADR-0134 §3)
Append-only JSONL at `<repo>/.quanta/audit/skill-install.log`. 6 event type (admin_install / admin_remove / admin_attempt_disable / banned_install_blocked / policy_load / policy_violation). 각 line은 {ts (ISO 8601), seq (process-monotonic), event, skillName, admin?, user?, scop

###  SKILL.md 6-필드 frontmatter + Skills vs Extensions 분류
SKILL.md frontmatter 6-필드 strict schema (name/description/userInvocable/allowedTools/category/stability). category로 skill(LLM-callable) vs extension(시스템 전용) 분기. hand-roll YAML splitter — js-yaml 의존 0. empty allowedTools = NO tools (not "all", heuristic �

### 🆕 Skill registry — 7-source discovery + precedence resolver (ADR-0134 §1)
`buildSkillRegistry({ repoRoot, homeDir, orgConfigDir, systemSkillsDir })` — 7-source 병렬 discovery 후 고정 precedence (admin > repo > team > user > personal > system > builtIn) 적용. 같은 name 충돌 시 winner + overriddenScopes[] 기록 → `lookup(name): {skill, w

###  Subagent 6-tool 표준 (exec_command / write_stdin / spawn_agent / wait_agent / close_agent / send_input)
Codex 통계 흡수: exec_command 75% + write_stdin 24% 지배. 6 tool contract-only (input/output Zod strict + success/error discriminator). SUBAGENT_6_TOOL_CONTRACTS frozen dispatch table. 신규 tool 추가는 ADR 개정 필수. Handler는 `handlers-6.ts`, 라우터는 `dispat

###  Tool routing matrix (ADR-0022)
Tool routing matrix (ADR-0022) — 시스템 프롬프트 정적 블록: truth-condition별 도구 매핑(fresh fact→web / local code→grep,read,glob,localize / modify stable→edit / modify unstable→scripted_replace / verify→test_runner,bash / parallel reads→batch / sid

###  Background subagent persistence (cross-restart)
BackgroundSubagentScheduler serialize / hydrate / hydrateWithPrune primitives + auto-restore-on-construction (`hydrateFrom` opt). Running entries whose Promise can't be reconstructed across restart surface as `status:"failed", errorMessage:"lost across restart"` (honest, not sile

###  Loop trio integration (auto-bg accept + automation tick + identity per-turn reminder)
Closes 3 of 11 ADR-0236 mega-wire deliberate_holds. (A) auto-background propose `onAccept` callback wires to `BackgroundSubagentScheduler.fork` (user-supplied callback precedence; scheduler absent = graceful noop). (B) `AutomationEnginePort.tickScheduler` runs on loop-scoped setI

###  Playbook auto-dispatch + Git directive 5-kind completion
Closes ADR-0203 inline-trigger dispatch gap + ADR-0221's remaining 3-of-5 directive kinds. (A) `dispatchPlaybook` canonical sink resolves watcher fire → `/play <name>` follow-up enqueue via planQueueSink (source="inline_trigger"). Sink-optional: counts observable even without q

### 🆕 classify() + allowed-tool whitelist gate (Skill vs Extension)
`SkillFrontmatter.category` is the SSOT for whether an entry is auto- triggerable by the model (`skill`) or system-level only (`extension`). `classify(fm)` is pure dispatch on `category` and returns `{kind:"skill", userInvocable}` or `{kind:"extension", userInvocable:false}` — 

###  discoverSkills — frontmatter + size-cap-guarded skill enumeration
Walk `QUANTA_SKILLS_DIR` (or per-project skills/) and emit `Skill[]` — reads each candidate's frontmatter via the lenient `parseFrontmatter`, coerces `allowedTools` / `effort` / scalar fields, falls back to first non-blank body line for description if not in frontmatter. Size g

###  loadPluginManifest + discoverPlugins — `.quanta-plugin/plugin.json` loader
Two contracts behind the plugin manifest. (1) `loadPluginManifest(pluginDir)` reads + validates a single plugin root: FAILS LOUDLY when the manifest is missing, JSON-malformed, or Zod-invalid — no auto-fix, no defaulting, no swallowed errors (Cluster E hard rule). Returns the m

###  TaskRegistry — background subagent registry + capability tokens + LRU
In-memory registry of background subagent tasks (v2's `taskRegistry` shape). Agent tool registers a task here when launched in background mode and resolves it when the forked runner settles; `task_output` / `task_stop` observe and cancel by id. Three seams: (1) `register()` retur

### 🆕 Agent tool input shape — task_kind / result_shape / owned_surfaces / forbidden_surfaces / continue_from / checkpoint
Closed input schema for the parent's `agent` tool — six Codex Round-3 absorption fields beyond `prompt`/`agent_type`/`tools`/`background`/ `isolation`/`max_turns`/`max_tokens`. (1) `task_kind: "read"|"edit"| "review"` — coarse role used to derive a default tool allowlist when

### ✨ branch_search — N-best verifier-prover (speculative branch search)
하드 edit를 N개 후보로 격리 워크스페이스에서 병렬 시도 → 닫힌 Verifier 포트(tsc/test/ lint/lsp_diag)로 채점 → 순수 Scorer 가중합 + Selector argmax로 winner 선택. 메인 루프는 winner만 봄(loser는 OTel span + smoke sidecar). 상용 코

### 🆕 CSV batch-job runner (`agent_jobs`) — row-indexed fan-out over subagents (ADR-0463)
Codex `agent_jobs` + Cursor batch fan-out 2-vendor convergence 흡수. CSV (또는 row list) 를 subagent 에 fan-out — 한 행 = 한 subagent task. 구조적 결과 수집, 실패 재시도(job 별 attempt cap), 행별 output-schema 검증(zod), 결과 CSV export. Port-free �

### 🆕 createAutoTitlePort + generateSessionTitle — opt-in cheap-model first-turn session titler
Opt-in, cheap-model, fire-and-forget session titler (RFC `docs/plans/jun-6-ai-session-title.md`). On the FIRST turn only, an opted-in composition root kicks `createAutoTitlePort(...).maybeTitle(sessionId, firstPrompt)` off WITHOUT awaiting it. A cheap injected `LLMPort` (pinned t

### 🆕 buildCompactionBreakerConfigCore + buildSummarizerLlmCore — compaction guards + dedicated summarizer
Two surface-agnostic compaction assemblers (ADR-0011 Tier-0 safety hardening + dedicated summarizer model): (1) `buildCompactionBreakerConfigCore` — composes the circuit-breaker block from 3 pre-parsed knobs: `disabled === true`, `reactiveMax` (finite int → `caps.maxConsecuti

### 🆕 buildLLMCore + composeLLMCore + parseFallbackModels — surface-agnostic LLM stack
Surface-agnostic LLM assembly family that hides three distinct concerns behind typed inputs (no `process.env` / `process.argv` reads — the surface maps its own ENV/HTTP/IPC into the `*AssembleInput` shapes first): (1) `pickProviderCore` — re-export of the `@/llm` factory prov

### 🆕 buildMemoryConfigCore + parseRecallTiers — memory tuning block composer
Surface-agnostic memory-config assembly. Two distinct helpers: (1) `parseRecallTiers` — pure parser for raw `QUANTA_MEMORY_RECALL_TIERS`-style strings ("episodic,semantic"). Lower- cases + trims tokens, accepts only the two valid tiers, dedups via Set. Empty result ⇒ `undefin

### 🆕 buildStoreCore + buildEmbedderCore — surface-agnostic memory store/embedder factories
Two surface-agnostic factories that produce the long-term memory store and the semantic embedder, both default-OFF (plain runs unchanged): (1) `buildStoreCore` — three states by `kind`: `"sqlite"` → on-disk `SqliteStore` (path or default `.quanta/memory.sqlite`), `"memory"` �

### 🆕 buildStreamingCore — StdoutStream + observe-dir JsonlRecorder TeeStream
Surface-agnostic streaming/observability wiring (RFC-0002 §5.4/§8). Default OFF: no `observeDir` ⇒ plain `StdoutStream` + no `RunContext` (byte-identical to today). When `observeDir` is set: (1) Mint a `runId` (caller-supplied OR `crypto.randomUUID()` when absent) so cross-pr

### 🆕 buildToolingCore — surface-agnostic ToolRegistry composition + per-config gate logs
Surface-agnostic assembly of the per-run `ToolRegistry` + the aggregated `Tooling` record. Substantial logic beyond plumbing: (1) Tool-merge order (last-write-wins via `ToolRegistry`'s Map): `buildDefaultTools()` → `mcpTools` → memory tools → `lspTools` → `lspNavTools` �

###  tmpdir/worktree isolators — node_modules symlink-safe cleanup
Two `Isolator` port implementations for the speculative branch search. `tmpdirIsolator` uses `mkdtemp` + `cp -r` excluding `.git` and `node_modules`, optionally symlinking the parent `node_modules` so `tsc`/`test` resolve deps. `worktreeIsolator` uses `git worktree add` per candi

###  Branch-search pure scorer — DEFAULT_WEIGHTS + argmax/minimal-change selectors
Pure scorer + selector. Given verifier signals, fold to a 0..1 total and pick winner. Deterministic for a fixed signal set (non-determinism lives in propose). Frozen `DEFAULT_WEIGHTS`: tsc 0.4 / test 0.4 / lint 0.1 / lsp_diag 0.2 / llm_judge 0.2 / patch_size 0.1. Weights need NOT

###  buildSeeds — Agentless temperature diversification + mixed-model voting
`buildSeeds(N, base, modelCandidates?)` — builds N `BranchSeed` records for parallel candidate proposal. Implements TWO Agentless techniques: §3.1 temperature diversification (spread across [0.2 .. 1.0] for N candidates; deterministic so replay is reproducible — N=1 ⇒ [0.2

###  Branch-search verifier suite — tsc / test / lint / lsp_diag + combineVerifiers
Concrete `Verifier` implementations bound to `@/runtime/shell#runShell` (env-scrubbed, timeout-bounded). Each verifier is READ-ONLY w.r.t. the candidate workspace (negative invariant) — analysis only. Five signal-emitting verifiers: `tscVerifier` (TS compile errors), `testVerif

###  Bug-fix proposal queue — debug-trace 자동수정 루프 Phase 1 (ADR-0186)
순수 in-memory capture-and-list primitive. `debug-trace` skill (ADR-0181)이 생성하는 `{file:line, hypothesis, proposed-fix}` ranked envelope를 typed 큐에 담아 caller(slash router / planner UI / test rig)가 HUMAN 검토용으로 drain 할 수 있게 한다. **CRITICAL

###  CTK git-task skill bundle — babysit / fix-merge-conflicts / get-pr-comments / loop-on-ci / make-pr-easy-to-review / new-branch-and-pr / pr-review-canvas / review-and-ship (ADR-0102)
ADR-0102 Phase AS absorption batch — 8 highest-ROI Cursor CTK git-task prompts shipped as bundled system skills. Each skill is SKILL.md (frontmatter + body) + a trivial index.ts router seam that mirrors `progress-audit/index.ts` (NAME constant + Trigger interface + trigger fn +

###  debug/blame 시스템 스킬 트리오 — debug-trace / explain-stack-trace / blame-section (ADR-0176)
세 개의 워크플로 형태 시스템 스킬을 한 번에 흡수 — 모두 prompt-only, 새 도구 추가 없음, 사용자가 query를 좁히며 반복 iterate 하는 narrative 워크플로. 1. **debug-trace** — "이거 크래시 났어 / 이 에러 조사해 줘". `parse

### 🆕 subagent + skills default-ON 전환 — surface-agnostic env-off-switch
RFC §1.2 default-OFF byte-identical 원칙의 **의도적 예외**. Codex/Claude Code/Cursor 모두 subagent + skills를 default로 켠다 — quanta가 default -OFF면 모델이 자연어로 "병렬로 해줘"/"스킬 알아서 써줘"라 해도 안 먹힌다 (도구 미등록 

###  git-log-search 시스템 스킬 — pickaxe/regex/author/since 검색 (ADR-0172)
사용자가 "when did X get added"/"who wrote this"/"find commits matching Y"/ "code archaeology"/"git history search"라고 물을 때 git 히스토리를 4개 검색 모드(pickaxe `-S` / regex `-G` / author / since+path) + ADR-0105 env-hygiene quartet (GIT_OPTIONAL_LOCKS=0 / 

###  Plan DAG validator — self/dangling/cycle + 100-node perf gate
Three pure exports operating on a `Readonly<Record<string, TodoItem>>` graph. `validateDag` is the full-plan validator that returns the first failure in PRIORITY ORDER: self_dependency → dependency_unknown → dependency_cycle (typed as `PlanMutationError` via `PlanResult`). `f

###  PlanStore → PlanMutator adapter — slice-boundary translation
The producer-side `PlanStore` returns `PlanResult<PlanDelta>` (rich shape: full Plan snapshot + typed delta). The duck-typed consumer-side `PlanMutator` (in `@/tool/types`) returns `PlanMutationResult` (compact shape: version + delta kind + touched ids). This adapter is the ONLY 

###  planToStreamMirror — single slice-boundary by-value projector
Single coercion site from canonical `Plan` to the minimalist `PlanReadonlyMirror` / `TodoReadonlyMirror` shapes the `@/stream` slice declares. Cross-slice flow stays by-value (RFC §3.1 — `@/stream` MUST NOT import `@/agent/plan`); biome `noRestrictedImports` enforces the fence

###  TodoStatus 5×5 transition matrix — pure predicate + frozen table
Closed `TodoStatus` transition matrix as a frozen lookup table + pure predicate. The mutations layer consults `isValidTransition(from, to)` whenever a TodoPatch sets `status`, emitting `PlanMutationError` `invalid_status_transition` on denial. Rules: pending → {in_progress | ca

###  progress-audit 시스템 스킬 (ADR-0045)
사용자가 "진행률"/"코드 레벨로만"/"P0/P1/P2"/"문서는 보지 말고"라고 묻거나 검증을 요구할 때, agent가 코드 증거 대신 plan/README/RFC를 1순위 evidence로 끌어다 쓰는 패턴을 시스템적으로 차단. 이 skill이 활성화되면 모

###  rewind 시스템 스킬 — shadow-snapshot 복원 워크플로 (ADR-0122)
사용자가 "rewind" / "undo" / "rollback" / "go back" / "revert changes"라고 말할 때 워크스페이스를 이전 shadow snapshot으로 복원하는 시스템 스킬. 3개의 `shadow_*` 도구 (`shadow_snapshots`, `shadow_rewind`, `shadow_restore_partial`)를 결정 트리

### 🆕 runner/assemble — surface-agnostic per-collaborator builder family
`apps/cli/internal.ts#buildTooling` 의 단일 GodFn (env 읽기 + collaborator 생성 + 레지스트리 와이어링 한 곳) 을 9 개 per-subsystem builder + 1 composer 로 분해. 각 builder 는 SRP — 단일 collaborator 또는 단일 config 블록만 책임. 9 builders + 

### 🆕 multimodal image input queue (/image add/list/clear)
PromptPayload 타입을 backward-compat하게 widening — 기존 string 페이로드 경로는 무변경, 새 코드는 `{ text, images[] }` 구조를 받을 수 있다. `/image add/list/clear` 슬래시로 이미지 큐를 누적하고, 다음 accepted prompt를 `prompt-pipelin

### 🆕 persistTurn — per-turn save plumbing (path-mode + id-mode)
CLI REPL `turn` 클로저의 inline save 블록을 surface 무관 슬라이스로 verbatim 추출. 두 개의 독립 default-OFF 저장 경로를 하나의 진입점으로 묶는다: 1. `state: string | undefined` (path-mode) — `--state <p>` / `QUANTA_STATE_PATH` 세트 시 `sa

### 🆕 resolveResume — surface-agnostic session-resume state machine
`--resume <token>` / `--new-session` startup state 결정을 surface 무관 슬라이스로 격리. argv/env 직접 읽기 ZERO — 모든 입력이 `ResolveResumeInput` 으로 명시되어 CLI/Web/Tauri 어느 surface 든 자신의 argv/env/HTTP 파서로 1회 변환 후 호출.

### 🆕 Legacy runInteractive cutover — prompt-pipeline + turn-runner REPL driver
옛 `runInteractive` 단일 helper는 제거됐지만, surface-agnostic REPL driver 계약 자체는 유지된다. 현재 live path는 `apps/agent/mode-presets/interactive.ts`의 runtime-SDK preset + `apps/cli/repl/prompt-pipeline.ts`의 prompt acquisition/slash routing + `apps/c

### 🆕 runOnce — surface-agnostic one-shot turn orchestration
`apps/cli/repl.ts::runRepl` 의 argv-prompt 분기를 surface-agnostic 한 한 줄 진입점으로 추출. "history append → runAgent → persistTurn → onTurnEnd → finally mcp shutdown" 의 5-단계 시퀀스를 단일 `runOnce(input)` 함수로 묶어 CLI argv-prompt / Web

###  side-chat — isolated agent loop without history pollution (Claude A9)
Claude Code A9 패턴 흡수: 메인 history를 오염시키지 않는 격리 agent loop. /side 슬래시 + sideChat() 진입점이 별도 SessionWriter로 분기, 메인 envelope는 무수정. 도구는 20-tool read-only allowlist + 17-tool forbidden deny-default(쓰기/실행/�

### 🆕 session rewind + fork (Claude Code A1 pattern)
Claude Code A1 rewind(messageId)/forkSession 패턴 흡수. Envelope append-only invariant 유지(원본 jsonl 무수정) — rewind는 새 fork 세션을 만들고 cutoff 이전 메시지만 복사한다. CLI surface `/rewind` (대화 cutoff) + `/rewind --git` (working-tree rest

###  "Skill ecosystem: argument-hint + metadata + bundled resources"
Absorbs codex's skill ECOSYSTEM frontmatter+resources (quanta's skill CORE — 7-scope/playbook/ReDoS-glob/admin — was already ahead). All ADDITIVE/optional: (A) `argument-hint` → Skill.argumentHint, shown in the listing (`rr [scope]`); (B) `metadata.short-description` → Sk

### 🆕 buildSkillBlock — skill discovery + tool registration + override maps + paths-filtered inventory
Per-subsystem Tier-1 builder that materializes the entire SKILL block off a single `config.skills` config field, returning `undefined` for byte-identical default-OFF (RFC §1.2). Substantial logic, not plumbing: (1) Discovers user skills (from `config.skills.dir`, optional) AND b

### 🆕 buildSubagentBlock — shared TaskRegistry trio + force-stop cleanup
Per-subsystem Tier-1 builder that materializes the SUBAGENT block — the `agent` / `task_output` / `task_stop` tool trio plus the cleanup hook — off a single `config.subagent` field. Returns `undefined` when absent for byte-identical default-OFF (RFC §1.2). Distinct from plum


---
## 07-resilience

###  FallbackLLM
`FallbackLLM` (`src/llm/fallback.ts`) — LLMPort 데코레이터. 우선순위 순서의 provider 리스트를 받아, 현재 provider가 fallback-trigger 에러 (overload/server_error/network/not_implemented; `FALLBACK_KINDS` policy로 정의)로 실패하면 다음 provider로

###  RetryingLLM
RetryingLLM (`src/agent/retry.ts`) — LLMPort 데코레이터. transient pre-stream 실패(network/server_error/overloaded/rate_limit)에만 bounded backoff로 재시도하고, 일단 stream이 시작된 후의 에러는 partial output 회수 + rethrow (mid-stream replay 금지�

###  QUANTA_MODEL_FALLBACK


###  QUANTA_PROVIDER
Dual-provider 선택 knob — `QUANTA_PROVIDER`로 Anthropic / OpenAI(또는 OpenAI-호환 endpoint) 중 활성 백엔드를 고르고, `QUANTA_MODEL`로 모델 id를 지정. 인증 prerequisite: 활성 provider에 따라 `ANTHROPIC_API_KEY` 혹은 `OPENAI_API_KEY` (+ optional `O

###  RECOVERY_CAPS — bounded per-turn same-turn recovery budgets
Per-turn recovery 4-카운터 캡을 Object.freeze 상수로 SSOT 화. 같은 턴 안의 pre-stream backoff, output-cap continue, malformed-output retry, consecutive- empty-assistant retry가 무한 spin하지 못하도록 각 사유별 ceiling을 강제. streamRetries=3 / output

###  RetryingLLM string-marker + LLMErrorKind taxonomy (RETRYABLE / FATAL / PTL)
`classifyLLMError`는 두 입력 — (1) 메시지 substring 매칭(RETRYABLE_MARKERS: 429/5xx/timeout/ECONNRESET/overloaded/rate-limit/temporarily/try-again, FATAL_MARKERS: 4xx/auth/unauthorized/permission/malformed/not-found, PTL_MARKERS: prompt too long / context length / maxi

###  FALLBACK_KINDS — structured provider-swap trigger set
Provider 교체를 trigger하는 LLMErrorKind 집합을 정책으로 박음 — `overloaded`(529), `server_error`(non-529 5xx), `network`(ECONNRESET/EPIPE/ DNS), `not_implemented`(stub 어댑터, ADR-0094 Phase-1 chatgpt-oauth). 메시지 regex가 아닌 STRUCTURED 분기 — 어

###  escalatingKill — SIGTERM → SIGKILL 2s-grace
`proc.kill()`은 SIGTERM 1발만 보냄 — `trap '' TERM; sleep 30`처럼 TERM을 무시/트랩하는 자식은 abort/timeout 후에도 살아남아 cancellation을 좌초시킴. 본 헬퍼는 polite SIGTERM 직후 KILL_GRACE_MS(2000ms) 안에 미exit 시 SIGKILL (signal 9, untr

###  CapEnforcer — ADR-0062 3rd-channel NextAction enforcement
Tool 호출이 emit하는 `NextAction`(=suggestion to grow `max_depth` / `max_files` / narrow `path`)을 모델이 무시하고 같은 (tool, target) 으로 다시 호출하면 reminder를 강제 발화. `(toolName, targetPath)` 키 LRU 상태 + check/ record O(1). NextAction.kin

###  SandboxPolicy — declarative per-command confinement
Single-command 실행에 옵션 필드 5개로 confinement를 선언: `cwdJail`(작업 디렉토리 jail — 구현체는 escape를 reject MUST), `allowNetwork`(network egress 거부, DockerSandbox만 실제 enforce), `envAllowlist`(통과 env 변수 이름 정확 집합, 그 외

###  bash 도구 — timeout_ms (default 120s) + output cap + stderr-tail
`bash` 도구는 단일 shell 실행 별로 (1) `timeout_ms` (default 120000) wall- clock budget — 초과 시 escalatingKill로 SIGTERM→SIGKILL 후 `timedOut` evidence emit, (2) MAX_OUTPUT(=30000) combined output 캡 — visible truncation marker, (3) STDERR_CAP(=4000) stderr

###  Patch applier — observer + OTel emitter fail-open (telemetry bugs MUST NOT abort apply)
Negative invariant: a throw from EITHER the in-process user observer OR the canonical OTel emitter is caught + swallowed so apply semantics are independent of telemetry health. The `wrapObserver` helper executes each emit in its own try/catch — a user-observer throw cannot stop

### 🆕 ShadowOdb auto-checkpoint policy (ADR-0121)
Cline / Hermes / Codex / Cursor의 auto-checkpoint 패턴을 closed enum 4-arm 으로 표면화 — `off`(byte-identical 기본) / `per_tool`(모든 tool-use 전, Cline식) / `turn_dedup`(턴당 최대 1회 destructive 직전, Hermes식) / `verify_success`(verify pass boundary, C

###  ConversationCheckpoint — message-level resume + restore
Per-message conversation checkpoint — 같은 session 내에서 특정 message id로 rewind + restart. AgentLoop이 destructive tool dispatch 전후로 checkpoint를 emit하면, surface가 `rewindToMessage(id)`로 transcript을 truncate하고 같은 세션에서 이어 실행. h

###  chatgpt-oauth token-store — atomic write + 0o600 perm guard
OAuth refresh-token / access-token on-disk 저장: (1) tmp + rename atomic write로 torn JSON 방지, (2) Linux/macOS에서 `mode & 0o077 !== 0`이면 TokenStoreError throw — world/group readable 토큰 파일은 load 대신 force relogin (tampering vs leak 회피), (3) `ENOENT

###  Side-chat isolation 5-invariant — Claude Code A9 absorption
사용자의 lookup 질문("어디서 X 정의됨?", "test 커맨드?")을 메인 대화의 history/ working-state/cost에 섞지 않고 격리된 mini agent loop으로 처리. 5-invariant 락-인: (I1) caller의 `messages` 배열 NEVER 변형 — 자체 message list 구성, (I2)

###  REPL turn-cancel — Ctrl+C hard / Esc-Esc soft 2-tier
CLI REPL의 cancellation 2-tier gesture wiring: (1) **Ctrl+C** → outer AbortController.abort() (hard exit, surface-scoped) + transient "interrupted" status, (2) **Esc 두 번 (2초 윈도우 안)** → turnAbort.abort() (soft cancel, per-turn controller) + "turn cancelled" stat

### ✨ 모델 교체 retry (SubmitRetryBotMessage)
v0.dev SubmitRetryBotMessage{messageId, retryModelId} 흡수 — 특정 turn을 의도적으로 다른 모델로 재실행(불만족 응답 재시도, opus→max 자동 에스컬레이션). resolveRetryModel (요청 모델 우선, 없으면 ordered candidate의 다음 항목, wra

###  AbortSignal.any compose + chainedSignal — framework-level dual-signal hierarchy
Framework-level cancellation-composition primitive: `AbortSignal.any([outer, turn])` fuses two independent controllers (surface-level outer abort driven by Ctrl+C, per-turn `turnAbort` driven by Esc-Esc) into a single derived signal that aborts when EITHER input aborts. The legac

### 🆕 Adversarial multi-voter verification (refute-biased quorum)
후보 fix/claim을 N개 독립 refute-biased 보터(각자 LLMPort)로 검증 → quorum 규칙으로 단일 verdict 집계. 보터는 "반증하라 + 불확실하면 FAIL" 시스템 프롬프트로 편향되고, throw·unparseable 출력은 refute로 카운트해 fail-closed. q

###  batch.computeExitCode — corpus aggregator (any !passed | degraded | env_prep_failed → 1)
Corpus-level exit-code aggregator for batch mode. `computeExitCode(results)` returns 0 iff EVERY instance resolved cleanly (passed AND verdict NOT in {"degraded", "env_prep_failed"}); 1 if ANY failed. Mirrors the legacy bench behaviour where the operator sees non-zero whenever a 

###  import.meta.main CLI-entry guard (test-import safety)
CLI entry 모듈은 `if (import.meta.main) { ... }` 가드 뒤에서만 production main을 실행한다. Bun은 `import.meta.main`을 *프로세스 진입 파일*에서만 true로 세팅하므로, `import "./index"`로 모듈을 끌어다 쓰는 유닛테스트는 가짜로 main�

###  BudgetDials / BudgetCaps / BudgetExhaustionPolicy pure types
16-field BudgetDials shape (maxTurns / maxWallClockMs / maxModelCalls / maxToolCalls / maxShellCommands / maxTestRuns / maxInputTokens / maxOutput Tokens / maxReasoningTokens / maxTotalTokens / maxCostUsd / maxFilesChanged / maxPatchBytes / maxRetries / maxConsecutiveFailures / c

###  BudgetEvent closed union — tick / exhausted / clamp
Discriminated-union event shapes for trajectory recording. BudgetTickEvent (kind + delta + cumulative observed after tick) emitted at every meter `tick()`. BudgetExhaustedEvent (kind + budget + observed + full usage snapshot) fired when `checkExhausted()` first returns exhausted=

### 🆕 BudgetMeter — pure cumulative per-run quantitative tracking
Per-run cumulative 정량 추적(토큰/턴/USD/wall-clock 등)의 pure deterministic state machine. NO I/O, NO clock side-effect — wall-clock 샘플링은 caller-supplied `now()` 로 위임해 테스트 결정성 보장. 모든 gate 는 propositional: `dial !== undefined && ob

###  Image-history sanitization pipeline (ADR-0323 / 0328 / 0333 / 0337)
4-ADR pipeline closing Codex `turn.rs:363-381` (invalid image → in-place wm mutation → retry). ADR-0323 ships `HistorySanitizationPort` + working-memory adapter using `wm.replace()` for mutation parity (3 reasons closed enum). ADR-0328 ships `withImageSanitizationRetry` wrapp

### ✨ Edit-repair-loop — lint-delta + bounded fast-model repair to green
After a model edit (edit/write/apply_patch), compute the diagnostics the edit INTRODUCED (post − pre, never the file's pre-existing lint debt) and attach them to the edit tool's toModelOutput; then, when gated ON, re-drive a fast edit model until the check is green (lints/named

### 🆕 startup environment probe + graceful-degradation warnings
Faithful absorption of Cursor's CloudAgentStartupWarning / CloudAgentStartupWarningType + CloudSetupBlocker. At session start the agent probes its toolchain over a CLOSED declared check list (node / bun / python3 / git, plus a manifest-derived test runner) and produces a structur

###  hellgate test pattern — 적대적 회귀 봉인 (`tests/unit/*-hellgate.test.ts`)
"이김(quanta-wins)" 또는 "절대 깨면 안 되는" 축을 적대적(adversarial) 케이스로 봉인하는 테스트 패턴. 일반 unit test와 분리된 `*-hellgate.test.ts` 네이밍으로 grep-가능하고, 한 축당 한 파일로 응집된다. 각 hellgate 배터리는

###  interactive runMode AbortError / ABORT_ERR → exit 130 boundary
The interactive mode-preset wraps `runRepl()` in a try/catch that converts a thrown abort (either `err.name === "AbortError"` OR `err.code === "ABORT_ERR"` — Node's two flavors of the same condition) into a clean `{ exitCode: 130 }` return. `runRepl` owns its own SIGINT wiring 

### ✨ LLMError 16-kind taxonomy + fromSdkError boundary classifier + classify(e) router-boundary classifier
Classify external/SDK errors EXACTLY ONCE at the adapter boundary into a closed `LLMErrorKind` union (16 arms after ADR-0214 Codex absorption): `overloaded` (529) / `rate_limit` (429) / `server_error` (5xx) / `network` (transport) / `auth` (401/403) / `bad_request` (400/422) / `n

###  exitCodeForOutcome — AgentOutcome → POSIX exit code mapping + SIGINT lifecycle wrapper
`exitCodeForOutcome(outcome)` is the PURE function that pins the canonical AgentOutcome→POSIX exit-code table (the ONLY policy `apps/agent/run.ts` owns): `completed=0` (EX_OK), `budget_exhausted=2` (distinct from generic failure so a budget cap is shell-distinguishable), `abort

### 🆕 Account rate-limit snapshot — proactive empty-bucket backoff from *-ratelimit-* headers
Today quanta is purely REACTIVE to rate limits: B3 (`parseRetryAfterMs`, `src/shared/errors.ts`) parses the `retry-after` family ONLY at the error boundary and waits the server-instructed delay AFTER a 429 has already burned a request. It never reads the `*-ratelimit-*-remaining`

### 🆕 RecoveryRouter port + CodexSpecRouter — 16-kind × 6-action routing table
Closed-port + Codex-spec routing table (ADR-0214) collapsing the 16-kind `LLMErrorKind` onto a closed 6-action `RecoveryAction` envelope — `retry_same_turn` (unused by current router, reserved for future mid-turn-steerable provider) / `retry_after_backoff` (rate_limit only) / `

###  Resume-boundary tool_use/tool_result reconciliation (B4 — ADR-0323 extension)
`reconcileToolPairing(messages)` repairs dangling `tool_use`↔`tool_result` pairs in a transcript RE-LOADED from disk (session resume, fork, checkpoint rewind, subagent resume) so the array is model-valid for BOTH Anthropic Messages and OpenAI (chat + Responses), which each 400 

###  switchToSessionCwd — fail-loud SessionStartupError on missing worktree on resume
HIGH-4 fail-loud guard for the resume path. When `--resume <id>` lands on a session whose recorded cwd no longer exists on disk (worktree removed since save / external rm -rf), `switchToSessionCwd` throws a typed `SessionStartupError` (kind: `session_cwd_missing`, exitCode: 1) wi

### 🆕 SWE-bench Verified 6-pick smoke baseline (recorded tier-0 regression gate)
`princeton-nlp/SWE-bench_Verified`에서 결정적·저비용·신뢰성 기준으로 6개 instance를 frozen하여 회귀 reference로 사용 (capability sweep 아님, smoke gate). 필터: `difficulty == "<15 min fix"` + 단일 파일 + ≤22 lines + FAIL_TO_PASS ≤2 + light re

### 🆕 SWE-bench smoke recordings — 6-pick recorded patches + offline-cert path
`swebench-smoke-baseline` 의 6 frozen instance 를 실제 에이전트로 한 번 돌려 얻은 patch 결과 (`predictions.jsonl`) + 사람-검토용 메타데이터 (`RECORDING.md`). 결정성 모델 3-단계 중 (1) once-live 녹화 슬롯에 해당. 모델/프로바이더: gp

###  process.on(unhandledRejection) defense-in-depth — log, never exit
R-Phase4 P3-1 defense-in-depth handler for promise rejections that escape the agent loop's `try/catch` boundaries (background MCP cleanup, off-loop timers, fire-and-forget logger flushes). Wired ONCE at the CLI entry (`src/apps/cli/index.ts`), logs to stderr via the shared logger


---
## 08-llm

###  Multi-cloud provider router (CLAUDE_CODE_USE_* env mirror + precedence ladder)
`resolveProviderWithRouter(input)` is the 7-layer precedence ladder that picks the active `LlmProvider` from explicit caller arg + `CLAUDE_CODE_USE_*` (claude-cli convention) + `ANTHROPIC_*_BASE_URL` (ADR-0139 convention) + chatgpt-oauth disk probe + ANTHROPIC_API_KEY + OPENAI_AP

###  AWS Bedrock LLM adapter (Anthropic Messages grammar via SigV4-signed Bedrock endpoint)
`BedrockProviderAdapter` routes Anthropic Messages API calls through AWS Bedrock's SigV4-signed endpoint via the optional `@anthropic-ai/bedrock-sdk` (lazy import — install footprint stays clean for non-enterprise users). Credentials are AWS-IAM shaped (env / IMDS / IRSA / SSO 

### 🆕 Sticky model-per-mode — fs-backed {mode → modelId} store + precedence resolver
Cline + Roo Code의 "Plan에 강한 모델 / Act에 빠른 모델" 패턴 흡수. v3 모델 resolution은 global default + CLI override만 인지 — mode 멤버십 invisible, 사용자가 mode 전환마다 모델 재선택해야 함. 신규 슬라이스 `src/agent/sticky-model/`

### 🆕 Spinner stall detection — soft-signal port for mid-stream silence (Claude `tengu_spinner_stalled_ui` absorption, ADR-0227)
Claude Code CLI의 `tengu_spinner_stalled_ui` + `tengu_spinner_stall_cleared` 텔레메트리 쌍 흡수. ADR-0200 stream-idle-timeout이 60s/120s 후 hard abort만 제공하던 갭을 메운다 — abort 전 N초 silence에 surface가 "still working… [r]etry / [a]bort" 패널�

###  LLM error 16-kind close-out — layer-owned arms wire (too-many-failed / thread-rollback / sandbox)
Closes the ADR-0214 → ADR-0234 taxonomy gap: three Codex-spec `LLMErrorKind` arms (`too_many_failed_attempts` → fatal; `thread_rollback_failed` → reactive_compaction; `sandbox_error` → hitl_handoff) were reachable only via the heuristic `classify(e: unknown)` router becau

### 🆕 Role-based model override — {role → modelId} resolver (Roo orchestrator)
Roo Code orchestrator의 "역할별 모델 선택" 패턴 흡수. plan-writer는 deep-reasoning model (o1/claude-opus), executor는 fast minimal-diff (claude-haiku/gpt-5-mini), reviewer/explorer 동. ADR-0212 sticky-model은 workflow phase (plan/audit/review) 축이고, role-over

###  GCP Vertex AI LLM adapter (Anthropic Messages via projects/loc URL)
`VertexProviderAdapter` routes Anthropic Messages API calls through GCP Vertex AI's region-scoped endpoint (`projects/{gcpProjectId}/locations/{gcpLocation}/...`) via the optional `@anthropic-ai/vertex-sdk` (lazy import — same discipline as Bedrock). Requires BOTH `gcpProjectId

### ⏸ Azure AI Foundry LLM adapter (Phase 1 stub — no public SDK)
`FoundryProviderAdapter` is a typed Phase-1 stub. Azure AI Foundry has no first-party `@anthropic-ai/foundry-sdk` shipping as of 2026-05-24; rather than fake it with raw `fetch` (which would silently lock us into a wire shape that may shift before the official SDK lands), the ada

### 🆕 Sticky model-per-mode — loop consume site (dead-seam → live, ADR-0462)
ADR-0212 shipped the sticky `{mode → modelId}` store + precedence resolver but left it a DEAD SEAM — nothing in the agent loop read it, so per-mode model stickiness never took effect (the 0212 fc explicitly deferred "CLI wire … 는 후속 라운드"). This slice is that wir

### ⏸ Anthropic Mantle LLM adapter (Phase 1 stub — internal enterprise endpoint)
`MantleProviderAdapter` is a typed Phase-1 stub. Anthropic Mantle is an internal/enterprise endpoint name surfaced via the Claude CLI env switch `CLAUDE_CODE_USE_MANTLE` and internal documentation only — no public SDK or wire spec as of 2026-05-24. The adapter constructs cleanl

###  OIDC federation token exchange (ANTHROPIC_IDENTITY_TOKEN_FILE → access token)
`OidcFederationExchanger.exchangeToken({identityTokenFile, federationRuleId, orgId})` reads a workload-identity JWT from disk (Kubernetes SA projection / GitHub OIDC / Vault), validates its shape (100 B–64 KiB + JWT 3-segment probe; signature NOT verified — that is the exchan

###  Distributed OAuth refresh lock (port + 3 impls + fallback chain)
`OAuthRefreshLockPort` is the single port behind 3 concrete implementations: `InMemoryLock` (per-process Map, re-entrant), `FileBasedLock` (cross-process same-machine via `~/.quanta/locks/{key}.lock` + JSON payload with PID + holderId + expiresAt), `RedisLockStub` (Phase-1 stub r

###  Mid-session GitHub token rotation (lock-protected, vendor-TTL respected)
`rotateGitHubToken({current, clientId, clientSecret, httpPort, clockPort, lockPort, holderId, rotateAfterMs?, lockTtlMs?, endpointBase?})` rotates a GitHub OAuth pair WELL BEFORE its 8-hour expiry so long-running sessions never hit 401s during `gh api` calls. Generalizes Cursor's

### 🆕 Session effort wire — `/effort` slash + `EffortStore` precedence fold-in (Codex `/model`-style)
Codex `/model` 패턴 흡수: 모델 옆 reasoning effort tier를 런타임에 swap. v3는 5-tier (`default | low | medium | high | max`) + token 예산 매핑이 leaf로 이미 존재(`src/agent/effort.ts`) 했으나 EffortStore가 src에서 호출되지 않아 `QUANTA_EFFORT=hi

### 🆕 Reasoning carry-over via `encrypted_content` — OpenAI Responses / o-series (H15, Codex `ResponseItem` absorption)
Codex `encrypted_content` carry-over 흡수 (codex-rs 0.135 `ResponseItem` + rollout-trace reducer/normalize + `x-reasoning-included` 헤더 + body `include: ["reasoning.encrypted_content"]`). quanta는 `src/llm/openai-responses-wire.ts`에서 reasoning thinking을 의도적으�

### 🆕 BYOK apiKeyHelper mint for the LEGACY vendor key path (anthropic/openai)
Extends the H7 `CredentialSource.mintApiKey()` (already hardened — TTL cache, single-flight, empty-stdout guard, trust gate, no-leak) to feed the LEGACY `anthropic` / `openai` vendor key path that `createLLM` resolves from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. Before this, on

### 🆕 Rotating cloud credentials (apiKeyHelper mint + aws/gcp pre-call refresh)
Executable `CredentialSource` port (`src/llm/credential-helper.ts`) with two trust-gated capabilities, both driven by a user-configured SHELL COMMAND: (a) MINT an API key via `apiKeyHelper` (TTL-cached, mirroring Claude Code's `apiKeyHelper` + `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`)

### 🆕 Brief mode — condensed output posture (`/brief` slash + `set_brief` op + `QUANTA_BRIEF` seed)
Claude Code 2.1.150 `briefTranscript`/`tengu_brief_mode_toggled` 흡수의 **model-facing 절반** (C3, docs/plans/jun-4-brief-mode.md). Claude의 brief는 render-primary(transcript layout) — copy하면 wire token은 0 절약. v3는 대신 **PROMPT DIRECTIVE**로 구현: brief�

### 🆕 Live "· N tokens" output-token counter — vendor-agnostic stream decorator (Claude-Code parity)
Claude-Code의 streaming 중 climbing "· N tokens" spinner counter를 구조적으로 흡수. commit 9dcea445 "feat(llm/cli): live · N tokens output counter". 핵심은 ONE vendor-agnostic decorator `withLiveUsage`(`src/llm/live-usage/index.ts`): adapter들이 이미 normalize�

###  OpenAI Responses API adapter + continuation/resume store
`OpenAIResponsesAdapter` (`src/llm/adapters/openai-responses.ts`) — the `LLMPort` implementation for OpenAI's `/v1/responses` streaming surface (`surfaceId: "openai-responses"`, `transportId: "public"`, BYOK auth). It composes the shared responses-stream machinery: `prepareResp

### 🆕 1-hour prompt-cache TTL — Anthropic `cache_control: { ttl: "1h" }` (cost optimization)
quanta는 Anthropic prompt-cache breakpoint를 `cache_control: { type: "ephemeral" }` 로만 마킹하는데(NO `ttl`), Anthropic은 이를 default 5분 TTL로 취급한다. 긴 interactive/ agentic 세션에서 5분보다 긴 gap(사용자 사고·긴 tool exec·paused turn)이 

### 🆕 Structured output mode — response_format json_schema passthrough (ADR-0469)
Caller가 한 LLM 요청에 JSON Schema를 붙여 schema-constrained 응답을 강제한다. OpenAI는 native `response_format:{type:"json_schema", json_schema:{name,schema,strict}}` (Structured Outputs)로 패스스루; Anthropic은 symmetric knob이 없어 single forced tool-ca


---
## 08-observability

###  Context-usage metrics fan-out + surface-agnostic status line
Claude Desktop 1.7196.3의 getContextUsage IPC sidebar 노출 흡수 — v3는 estimateTokens / provider usage StreamEvent로 내부 계산 중이었으나 어떤 surface도 user-facing 표시 없음. (1) AgentRecorder.tokensUsed(input, output, cacheRead?) 추가 — vocabulary�

###  OTel span tree (Codex 10-step) — core 4-stage SDK-free wrap


###  Cost & cache 대시보드
MetricsSnapshot 위 순수 aggregator — token in/out·cacheHitRate·estimatedCostUsd· turns·toolCalls(byTool)·stopReasons·latency(p50/p95)·shell rollup 집계. 새 수집 0 (AgentRecorder/shell-otel가 채운 counter/timer만 read). 2 string renderer (renderDashboardText·

###  AgentEvent
`AgentEvent` discriminated union — the surface-facing event stream the agent loop emits per turn (turn_start / assistant_text / tool_call / tool_progress / tool_result / usage / error / done). Carries the RunContext correlation tuple (runId / instanceId / attempt / turn / toolU

###  AgentRecorder


###  src/shared/logger.ts


### 🆕 turn_diff_updated stream event + emitter
AgentEvent union variant `turn_diff_updated` plus the emitter module that computes per-turn cumulative unified diff. captureTurnStart records workspace state at turn-open; computeTurnDiff produces a unified diff against the captured baseline at turn-close; buildTurnDiffEvent shap

### 🆕 Git observability composite — session fingerprint + turn-diff emit helpers
Composition-root helpers that wire the deferred halves of ADR-0102 (turn_diff_updated event emit) and ADR-0106 (SessionMeta git fingerprint). Part A populates session metadata (sha / branch / origin URL) at session open; Part B emits the turn-diff event at turn close. Barrel expo

###  JsonlRecorder
`JsonlRecorder` — append-only JSON-Lines sink for the trajectory event stream. One AgentEvent ⇒ one JSON object per line (newline-framed, never partial) under the directory configured by `QUANTA_OBSERVE_DIR`. Pairs with `TeeStream` for fan-out (SSE + JSONL + dashboard from th

### 🆕 "Git `::git-*` 5-directive emit protocol — phase-guarded behavioral layer + turn-collector wire"
Codex-style `::git-*` 5-directive emit protocol with a HARD phase guard: directives (create-branch / stage / commit / push / create-pr) may be emitted ONLY in the `final-answer` phase, after a confirmed-successful mutating git operation. `commentary` and `intermediate` phase emit

###  Observability stack audit (3-round, adversarial) findings + structural ratchets (ADR-0425)
Waves 1-5 observability stack(ADR-0394~0421) end-to-end live 도달 후 3-round adversarial 감사. R1: correctness/lifecycle/coverage/hygiene 4 lens parallel. R2: refutation + malicious input + concurrency 3 lens parallel. R3: synthesis + recipe. 6 structural fix: - F1 (HIGH): A

### 🆕 Session-startup LLM prewarm + Time-To-First-Message (TTFM)


###  JsonlRecorder cumulative-bytes sliding-window retention


###  OTel canonical attribute vocabulary (quanta.* 12 namespaces + gen_ai.* semconv)


###  OTel MeterProvider-backed metric sink
Closed-port `MetricSink` adapter wrapping `@opentelemetry/api` MeterProvider. Maps our 3-arm MetricKind (counter/histogram/gauge) to OTel instruments (Counter/Histogram/UpDownCounter) with lazy per-(name, kind) caching. Gauge emulation = UpDownCounter + per-(name, labelsKey) prev

###  OTLP HTTP + Prometheus exporter helpers
Factory helpers that lazily dynamic-import `@opentelemetry/sdk-metrics` + `@opentelemetry/exporter-metrics-otlp-http` + `@opentelemetry/exporter-prometheus`, construct a MeterProvider with PeriodicExportingMetricReader, hand off to `otelMetricsSink` (ADR-0154). Missing deps surfa

###  Metrics instrument wrap helpers + Grafana + alerts + E2E coverage
Closes the loop from ADR-0158 recipe (24-metric table) to actual end-to-end monitoring: (a) `instrumentLlmProvider` + `instrumentSubagentScheduler` + `withCallCounter` typed wrappers that emit the recipe metrics from caller's composition root without slice-side imports; (b) `docs

###  ShadowOdb/Tool instrument wraps + AlertManager routing + Grafana provisioning
Closes 24-metric recipe coverage gap from ADR-0159: ShadowOdb 5-method wrap (`shadow.checkpoint.*` / `shadow.rewind.*{target}` / `shadow.diff.*{kind}` / `shadow.restore_partial.*` / `shadow.markVerified.*`) + Tool generic wrap (`tool.call.*{tool, ok}` + `tool.call.duration_ms{too

###  PlanQueue/Budget/LSP wraps + withFullObservability + SLO doc
Final closeout for 24-metric recipe coverage: 3 additional typed wraps (PlanQueueStore enqueue/drain/clear; BudgetLedger record + breach surfacing; LspClient 4-method Proxy-based duck-typed) + `withFullObservability(bag,opts)` composition-root one-call auto-instrument helper + pe

###  observability.wired.total{slice} gauge — machine-readable wiring health
Opt-in `emitWiredGauge` flag on `withFullObservability` emits one `observability.wired.total{slice}` gauge per `ObservabilityBag` key (7 total) with value 1 (wired) or 0 (unwired). Machine-readable counterpart to ADR-0169's operator-facing skipped-warning log — log is for human

### 🆕 Git `::git-*` directive emit — wire/serdes leaf (ADR-0220)
Codex 의 `::git-*` 5-directive 와이어 포맷을 직렬화/역직렬화 하는 leaf 슬라이스. canonical alpha-sorted JSON 으로 byte-deterministic. ADR-0221 (phase-guarded 프로토콜) + ADR-0232 (turn-collector wire) 의 sibling — 본 슬라이스는 wire/serdes 만 �

###  workMetrics — turn별 비용·작업 투명성
v0.dev workMetrics 흡수 — turn별 diffMap(파일당 +추가/-삭제 줄), agentActions, linesRead, 토큰 in/out + estimatedCostUsd를 순수 집계. parseNumstat(git diff --numstat, binary '-' → 0), summarizeWorkMetrics(compact 1-block, 예: "3 files (+42 -7) · 5 actions 

###  costUsd — null-prototype TABLE로 prototype-pollution NaN 차단
`costUsd(model, ...)`의 model 인자는 untrusted 외부 문자열. 가격 TABLE이 평범한 object literal이면 `TABLE["constructor"]` / `["toString"]` / `["__proto__"]` / `["hasOwnProperty"]` / `["valueOf"]`가 inherited `Object.prototype` 멤버로 resolve되어 `=== undefi

###  '`assertNever` — compile-time + runtime exhaustiveness guard'
Exhaustiveness guard for `switch` / `if-else` chains over a closed union / enum. Placing `assertNever(x, label)` in the `default` branch makes TypeScript fail to COMPILE if a new variant is added without a matching case — turning a "silent fall-through returns undefined" bug in

###  '`byteCompare` — locale-independent string ordering'
Byte-stable string comparator for deterministic ordering. Unlike `String.prototype.localeCompare`, the result does NOT depend on the host locale or ICU collation, so any list sorted with `byteCompare` is byte-identical across machines and locales. This is REQUIRED for anything wh

###  Composition-root metrics wire + activation telemetry (ADR-0358 / 0360)
Closes ADR-0352 default-OFF state. ADR-0358 ships `adaptMetricsRegistryToEmitter(MetricsRegistry → MetricEmitterPort)` — one-line shim from ADR-0144 production registry to the orthogonal port the ADR-0352 decorators consume. `looksLikeMetricsRegistry()` duck-tests `cfg.metric

###  Cache + registry observability metric decorators (ADR-0352)
Two NO-THROW wrapping decorators emit hit/miss/eviction counters as the ADR-0326 system-prompt cache + ADR-0345/0348 session-resource registry are exercised. `withCacheMetrics(inner, cfg)` emits `codex_r2.cache.{hits,misses,peek_hits,peek_misses,invalidations,size}`; `withRegistr

###  System-prompt cache + drift detector + cache-control audit (ADR-0322 / 0326)
Two complementary pieces. ADR-0322 (passive audit Case C verdict): `analyzePrefixStability(batches)` over `CachePrefixSnapshot[]` records sha256 + cache_control marker per position; detects drift across turns. Verified the existing Anthropic prefix is byte-stable by construction 

### 🆕 Segmented context-window usage breakdown + wired /context
Extends context-usage-metrics (single total + one-color bar) with the per-category breakdown Cursor's Canvas UsageBar shows. (1) DATA: usage-breakdown.ts computes a ContextUsageBreakdown {segments:{id,tokens,color?}[], total, max} at prompt-assembly time by mapping each PromptSec

###  contract-tier gate — REQUIRE_CONTRACT skip-vs-fail switch (Docker / LSP probes)
Contract-tier 테스트는 실제 외부 프로세스(Docker daemon, typescript-/pyright- language-server)와 통신하므로 환경 가용성이 다르다. `tests/contract/_guard.ts` 의 `requireContract(name, available)` 는 단일 결정점: 로컬에서 의존성이 없으면

###  게이트 결정 trace surface — `AgentEvent.decision` variant + stderr debug-tracer + `/debug` + `QUANTA_DEBUG` (ADR-0239)
CLI에서 "왜 이 도구 호출이 deny / ask / allow 됐는지" 실시간으로 보는 surface. pre-dispatch 게이트 스택 (permission / rule / hook / cap / jail / budget)은 로직상 도구 호출의 진로를 정하지만 status-bar / cost-panel / turn-summary 어디에�

###  `decision` AgentEvent → MetricsRegistry counter sink (`quanta.gate.{kind}.{outcome}.total`) (ADR-0270)
Phase 2 + Phase 3 wiring 후에도 `MetricsRegistry`는 게이트 결정을 보지 못했음 — trajectory recorder + CLI tracer는 consume했지만 canonical counter `quanta.gate.{kind}.{outcome}.total` (operator가 기대하는 in-process snapshot + OTLP-exported view 양쪽)�

###  Flock acquire/timeout/fail/stale_reclaim telemetry (ADR-0364)
Emits five `codex_r2.lock.*` metrics through the ADR-0352 `MetricEmitterPort` on every `acquireSessionLock` outcome path: `acquire_success` / `acquire_timeout` / `acquire_fail` / `stale_reclaim` counters plus an `acquire_latency_ms` gauge. The emitter is an optional field on `Acq

###  Health snapshot watcher — periodic re-emit + SIGHUP hot-reload (3-channel drift defense)
ADR-0180 writes `~/.quanta/health.json` once at composition time. Operators scraping the file on a long-running daemon (K8s livenessProbe periodSeconds: 30, cron, shell loop) need the file to TRACK wiring changes, not freeze at startup. This watcher adds 3-channel refresh on top 

### 🆕 HITL outcome-site OTel emit — tier_resolved / registry_escalated / handoff_emitted
`quanta.hitl.tier_resolved` + `registry_escalated` + `handoff_emitted` 3개 키가 vocabulary 에 있고 helper 도 있었지만 zero call-site 였던 갭을 `runHitlGate` (admissibility-gate.ts) 안에서 봉합. `resolveHitlTier` 직후 tier + matched 부울을 `recordAttrs(han

### 🆕 JsonlRecorder span correlation — deterministic turn / tool / llm span ids
Deterministic span-id derivation inside the JsonlRecorder so the recorded trajectory is golden-testable with no randomness. The scheme: (1) `turn_start` opens a new turn span `t<turn>` (or `t#<seq>` fallback when the AgentEvent carries no turn number); every later event in that t

### 🆕 LLM tokens + cost_usd OTel emit at turn-record sink
`llm/*` adapter 가 계산한 `estimatedCostUsd` + `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` 가 `WorkMetrics` 에 surface 되지만 OTel registry 에는 도달하지 못하던 gap 을 downstream sink 에서 wire-up. **adapter �

###  localize 도구 calibration — recall@K / MRR 측정 코퍼스 (regression CI 아님)
`src/tool/localize/` 의 ranking 알고리즘 변경이 실제로 도움이 됐는가를 "vibes" 가 아닌 데이터로 답하기 위한 empirical calibration. unit-test 게이트 밖에 의도적으로 둠 — calibration ≠ regression CI. `corpus.json` 의 각 query 에 대�

###  lsp-nav test fixtures — ctx/run/findTool primitives for 9-tool per-suite split
`tests/unit/lsp-nav-fixtures.ts` 는 lsp_nav 9 개 per-tool 테스트 슬라이스 (definition · type-definition · references · implementation · hover · document-symbol · workspace-symbol · rename-preview · tools) 가 공유하는 순수 헬퍼 묶음이다. Refactor C �

###  MemoryTelemetry → MetricsRegistry adapter (phase1 / phase2 / recall OTel emission)
Production binding of `MemoryTelemetryPort` (from @/memory) onto the typed `MetricsRegistry` port (from @/observability/metrics). Lives in the observability slice — dependency points adapter→port, never the reverse, so the memory slice's `@/memory ↛ @/observability` fence s

###  In-process Metrics registry — counters + gauges + timers (nearest-rank p50/p95)
Dependency-free in-process metrics registry that backs every downstream observability surface — the AgentRecorder, the shell-exec OTel observer, the cost dashboard, and work-metrics all read its snapshot. Three primitive shapes: Counter (monotonic inc), Gauge (set), Timer (samp

### 🆕 Metrics typed-port slice — counter / histogram / gauge + sinks (ADR-0144)
Closed-port metrics primitive: `MetricsRegistry` + `MetricSink` pair with three KIND-committed shapes (counter / histogram / gauge) and a pluggable `send(MetricSample)` transport. Fills the gap that every modern agent leaves — Cursor's IDE panel, Claude Code session totals, Cod

### 🆕 NDJSON live-event introspection sink (Cursor cursor-ndjson-ingest)
Pure half of Cursor's `cursor-ndjson-ingest`: stream the live agent event firehose (tool start/stop, LLM deltas, permission decisions, subagent forks) as newline-delimited JSON to an external monitor for real-time introspection/tracing. `@/observability` may import ONLY `@/shared

### 🆕 ADR-0222 OTel emit unified across 4 new slices (fence-aware narrow ports)
4 새 슬라이스 (error-routing / shell-snapshot / git-directives / stream-timeout) 의 OTel metric 발화 unify. 슬라이스 fence 보존: 각 슬라이스에 narrow `metric-port.ts` + `no-op-metric.ts` 정의 → observability adapter (`wire-new-slices.ts`)는 type-only impo

###  OTLP/HTTP exporter — `QUANTA_OTEL_ENDPOINT` realtime ship (외부 SDK zero) (ADR-0268)
in-tree OTel scaffold (`metrics/otel-sink.ts`, `tracing/otel-tracer.ts`, `tracing/w3c-propagator.ts`)는 in-process surface (counter / histogram / span / W3C propagation)는 다 깔았지만 **모든 sample이 in-memory에 머묾** — real collector로 가는 wiring 없었음. `

### 🆕 "Passive git/gh stdout → structured VCS events (H6) — turn-diff observability for raw git/gh"
H6 (jun-3-misc §3). Closes the raw-stdout blind spot of `src/git/directive-emit/parser.ts`, which only reads quanta's OWN emitted `::git-*` directive lines. When the agent (or user) runs a raw `git rebase/merge/cherry-pick/commit --amend/push` or a `gh pr` command through the `b

### 🆕 V4A apply_patch OTel emit — patch.op + fuzzy_match_tier per hunk
`quanta.patch.op` (`add | update | delete | move`) + `quanta.patch. fuzzy_match_tier` (`exact | whitespace | fuzzy`) + `fuzzy_matched` 3개 키를 ADR-0028 vocabulary 에서 activate. applier.ts 의 op-루프 안에 PatchObserver seam 추가 — production 은 wrapper (`wrapObser

### 🆕 Permission decision-site OTel emit — slice-local recorder seam
ADR-0029 reviewer 3-tier + ADR-0046 stack-axis + post-denial vocabulary (`quanta.permission.*` 12 키)가 vocabulary.ts에 선언만 있고 실제 emit site가 없던 부분을 활성화. `src/permission/recorder.ts` 가 slice-local port (PermissionRecorder / PermissionDecisionRe

###  permission-rules fixture corpus — authorship-separated mustBlock/mustAllow catalog
`tests/unit/permission-rules.fixtures.ts` 는 `src/permission/policy.ts` 의 `HARD_DENY_RULES` 카탈로그를 적대(mustBlock) + 회피-방지(mustAllow) 케이스로 봉인하는 데이터-only 코퍼스다. 이전엔 각 `HardDenyRule` 이 같은 파일에 자기 `mustBlock` 

###  Pricing table — versioned static prices + provider cache-read semantics
Pure (no network) versioned static price table. Every derived cost event stamps `PRICING_VERSION` so historical costs can be re-derived after table drift. Unknown model returns `null` (NOT an error, NEVER silent `$0`). Crucially encodes the provider-aware semantics: Anthropic's `

###  RunContext — run/instance/attempt/turn/toolUseId correlation primitive
Correlation context threaded through an agent run (RFC-0002 §5.1). Carries `runId` (required) + optional `instanceId` / `attempt` / `turn` / `toolUseId` so every `TrajectoryEvent` can be sliced run → instance → attempt → turn → tool_use. Propagated via `AgentConfig.run?`

###  Frozen runtime-config SSOT — the only place that touches process.env
The SINGLE place that touches `process.env`. Two recurring failure modes motivated it: (1) silent garbage acceptance — `process.env.QUANTA_LOG_LEVEL as LogLevel` accepted any string; an unknown value made every comparison `<undefined` and silently dropped EVERY log line; (2) mi

### 🆕 Session transcript retention sweep
Wires the existing `applyRetention` cumulative-bytes sliding window (`src/stream/adapters/jsonl-retention.ts`) over the per-session `<id>.jsonl` transcript envelopes that grow unbounded under `sessionsRoot()` (written by `@/session` `store.ts` `appendEnvelope`). The host/CLI-laye

###  shared test harness — ScriptedLLM / FakeLLM / RecordingStream / cfg / findEvent SSOT
`tests/integration/_harness.ts` 는 100+ 테스트 파일이 공유하는 단일-출처 테스트 더블 묶음이다. `tests/unit/_harness.ts` 는 한 줄 re-export 로 unit 슬라이스에도 같은 심볼을 노출 — "ScriptedLLM/FakeLLM/RecordingStream 을 테스트 파일 

###  Shell-exec OTel observer — typed event stream → counter registry
OTel-bound observer for the ADR-0081 shell exec events. Fans the typed stream (start / stdout / stderr / exit / aborted) into the existing `Metrics` registry so the `handle_tool_call{name=bash}` span (or any later aggregator) reads accurate chunk + byte counters WITHOUT re-buffer

###  smoke fixture system — single/medium/tikitaka 15-scenario battery + LLM replay
실제 agent loop + 실제 도구를 돌리되 LLM은 녹화된 trajectory를 replay (tier-0, deterministic, $0)하거나 옵트인 live(tier-1) 호출하는 end-to-end fixture battery. 15 시나리오 (single 4 / medium 4 / tikitaka 7)로 흔한 coding-agent 모양을 커버. `f

###  "Live tokens/sec rate in the streaming spinner"
The streaming spinner appends a live output `tok/s` rate so the user sees flow vs stall (was cumulative counts only). Rate = slope over a trailing ring of the last RATE_WINDOW_SAMPLES=8 (outputTokens, ts) readings sampled on token-delta boundaries via the indicator's injected clo

###  StdoutStream adapter — assistant-text painter hook with boundary flush
Human-readable `StreamPort` adapter that renders `AgentEvent` to stdout: assistant text inline, tool calls / progress / results / lifecycle as dim ANSI-colored status lines. Exposes a closed-port `AssistantTextPainter { write(delta), flush() }` so the CLI surface can inject an in

###  TeeStream — fan-out StreamPort with degraded-record tracking
Pure fan-out `StreamPort`. Forwards every `AgentEvent` to every wrapped port in order. In NON-STRICT mode (default — product / session) one faulty port can never starve the others: its error is swallowed and remembered (per-port `DegradedRecord` keyed by `index:reason`) so the 

###  Structured JSON-per-line logger — machine-consumable observability
JSON-per-line logger for machine-consumable observability — distinct from `@/shared`'s human-shaped `logger`. Emits one `JSON.stringify(LogRecord)` per call so downstream tooling (the agent loop, adapters, a future collector) can parse fields without regex. Threshold + sink + c

###  Test Artifact Purge Hellgate
Prevent stale `.test.js` TypeScript-emit artifacts from polluting `tests/`. Symptom: a legacy build step or worktree pollution leaves `.test.js` next to `.test.ts` sources; `bun test tests/unit tests/integration` picks up both files (bun has no built-in `testPathIgnorePatterns`) 

### 🆕 Per-tool TTL drift detector — config-vs-RECOMMENDED preset divergence as typed signal
ADR-0183 박은 construction-time drift detector. `defaultToolCallCache({ checkRecommendedDrift: true })` 가 caller 의 `perToolTtlMs` 와 audited `RECOMMENDED_PER_TOOL_TTL_MS` preset (ADR-0179) 를 비교, 4-arm closed enum `PerToolTtlDriftKind` (`too-permissive` / `too-restric

###  Trajectory v1 schema SSOT — kind taxonomy + envelope + redaction policy id
Single source of truth for the append-only JSONL trajectory (RFC-0002 §5.2). Declares `TRAJECTORY_SCHEMA = "quanta.trajectory.v1"`, the 17-element `TrajectoryKind` closed union (session_start / session_end / turn_start / llm_request / llm_usage / assistant_text / tool_call / too

###  TurnDiffSession — per-turn anchor → endTurn state machine
Stateful per-session adapter orchestrating the `captureTurnStart / computeTurnDiff / buildTurnDiffEvent` trio from `@/agent/turn-diff` into a turn-scoped state machine. `startTurn(i)` snapshots the HEAD SHA for turn i (idempotent — a second call for the same turnIndex keeps the

###  Turn-timing wall-clock anchors — request/firstToken/streamEnd (ADR-0077)
Records the three wall-clock anchors that pin down a single LLM-stream turn: `requestSentAt` (adapter stamps immediately before the POST), `firstTokenAt` (idempotent — only the first chunk records), `streamEndAt` (drain or abort). Surfaces two derived quantities: `firstTokenLat


---
## 09-integration

### 🆕 ChatGPT-OAuth provider — BYOK 없이 구독계정으로 모델 호출 (ADR-0094 Phase 1)
ChatGPT Plus/Pro/Team 구독 계정으로 모델 호출 — BYOK(OPENAI_API_KEY) 없이 OAuth 토큰을 사용해 `https://chatgpt.com/backend-api/codex/responses`로 호출. BYOK provider와 형제로 공존 (토큰/엔드포인트/모델캐탈로그/빌링 분리). PKCE S256 + 

###  diagnostics


### ✨ HookBus + Cursor `updated_input` 흡수 (pre_tool_use 인자 rewrite) + ADR-0133 bidirectional RPC
In-process HookBus — 9 이벤트(session_start / session_end / turn_start / pre_tool_use / post_tool_use / **post_tool_use_failure** / **pre_compact** / **subagent_start** / **subagent_stop**) + matcher(글로브 + tool name + path) + compose 순서. pre_tool_use는 deny / allo

###  LspPort


###  QUANTA_MCP_CONFIG


###  pre_tool_use hook updatedInput rewrite channel
Third return shape on pre_tool_use hooks (beyond allow / deny): an updatedInput payload that REWRITES the tool's arguments before dispatch. Enables policy-driven argument normalization (destructive-flag rewrite), workspace-relative path canonicalization, and secret redaction at t

###  ADR-0132 cloud-agent branch snapshot (force-with-lease only)
`snapshotDirtyToCloudBranch` packages a dirty working tree onto a brand-new `quanta/cloud-agent-<YYYYMMDDhhmmss>-<rand6>` branch and pushes it with `--force-with-lease` (NEVER `--force`). 10-step ballet behind a single closed `GitProcessPort`: 1. rev-parse --git-dir (not-a-repo g

###  ADR-0132 self-wake (3 hard guards + audit suffix)
`injectSimulatedTurn` hands a `ProactiveTrigger` to a closed `AgentLoopPort` after THREE hard guards (evaluated in order; the order becomes the `reason` field of the audit event when a guard rejects): 1. ENV — `QUANTA_PROACTIVE_REACTOR=1` MUST be set (default-OFF = byte-identic

###  ADR-0132 reactor TriggerSourcePort (CI + PR-comment adapters)
Closed-port trigger sources that turn external signals into typed `ProactiveTrigger` records. Two adapters land in this slice: - `createCiTriggerSource` — polls `gh pr checks --json`; emits a `ci_completion` trigger ONLY when gh exited 0 AND at least one row's status is COMPLET

###  LLM provider fork — Anthropic 4-transport closed port (default/bedrock/vertex/foundry)
Hexagonal port that separates Anthropic vendor (wire grammar) from transport (api.anthropic.com vs AWS Bedrock vs GCP Vertex vs Azure Foundry). 4-arm ProviderId union + 3-code ProviderError (provider-unsupported / provider-misconfigured / provider-missing-dependency) + 5-tier res

###  LSP applyWorkspaceEdit Phase 2 — EXDEV cross-FS fallback (copy + unlink)
Closes the ADR-0152 follow-up: Phase 2's `fs.rename(tmp, target)` fails with `EXDEV` when tmp and target sit on different mounts (Linux tmpfs `/tmp`, container overlay vs workspace bind-mount, certain macOS `/private/var/folders/...T/` setups). Catch detects `e.code === "EXDEV"` 

###  lsp_definition


###  ADR-0279 Automation engine composition-root wire
`assembleAutomation(env, deps)` — the single composition-root helper that wires `AutomationEnginePort` + `tickScheduler` + a handler closure over an `AgentLoopPort` into the `AgentConfig.automationEngine` slot. When `QUANTA_AUTOMATION === "on"`, returns a fully-wired `Automatio

###  ADR-0280 automation_update tool + REPL inbox banner
Two thin operator-facing slices on top of ADR-0279: - `automation_update` tool (`src/tool/automation_update.ts`) — a `defineTool`-built tool with 6-action closed input schema (`create | list | pause | resume | cancel | get`). Registered in `buildDefaultTools` ONLY when `QUANTA_

###  unit + 46 nav-tool unit + 12 formatter unit


### 🆕 GitHub Actions Tier 0 PR webhook adapter
Tier 0 GitHub Actions adapter — reads `GITHUB_EVENT_PATH` JSON once per workflow run, normalizes 6 event kinds (issue_comment / pull_request / pull_request_review / pull_request_review_comment / issues / push) and gates each normalized event through the mention filter + trust s

### 🆕 from-pr CLI sub-command (Tier 0 PR webhook bot entry)
User-facing CLI entry for the Tier 0 PR webhook bot path. Runs ONE cycle end-to-end: 1. envPort.get(QUANTA_GH_ACTIONS_TRIGGER) !== "1" ⇒ default-OFF, exit 0 (byte-identical to absent integration). 2. createActionsEventSource → poll once → readonly ProactiveTrigger[]. 3. 0 t

### 🆕 GitHub App webhook host — Tier 1 port-only scaffold
Tier 1 self-hosted webhook receiver port-only scaffold. Defines the seam for HMAC-SHA256 X-Hub-Signature-256 verification (constant-time compare, per-installation secret lookup) and the `createWebhookEventSource` factory shape so the agent loop can later swap from `event-source-a

### 🆕 PR output sink with mandatory redaction
Closed-port sink for every outgoing PR comment / review / issue reply the agent produces. `createPrOutputSink({ redactPort, ... })` is a required-injection factory — calling without a `redactPort` boots a hard throw at construction time, so the slice cannot accidentally leak ra

### 🆕 Mention filter with trust-scope + code-block exclusion
Pure trigger-phrase matcher. Pulled out of the actions adapter so the matching policy can be tested in isolation against adversarial bodies and shared between Tier 0 (ADR-0311) and Tier 1 (ADR-0312) event sources. Trust scope defaults to `collaborator` — a normalized event whos

### 🆕 Screen OCR native sidecar — Swift CLI (ScreenCaptureKit + Vision) for Tauri shell
Tiny Swift CLI binary at native/screen-ocr/ that the Tauri shell (Worker D) spawns as a sidecar to feed quanta two host-desktop signals: (1) the list of on-screen windows the user can target, (2) a single captured frame of a chosen window plus its OCR text. Three subcommands — 

### 🆕 MCP transport port + stdio 분리 + Streamable-HTTP/SSE 카리어 (ADR-0391)
client.ts core(request/dispatch/pending/timeout)는 불변. stdio 4곳 (start/send/pumpStdout/stop)을 transport port 뒤로 분리 — `McpTransport` interface(start/send/onMessage/onExit/close). 3 impl: stdio(verbatim move), http-sse(MCP Streamable-HTTP — POST send + SSE/JSON

###  ADR-0435 MCP crash-detection + auto-restart (exponential backoff)
Detects an MCP server crash (transport/process exit) and auto-restarts it — re-spawn → re-`initialize` → re-`tools/list` — swapping the live client behind a stable `mcp__<server>__<tool>` indirection so bridged tools keep working across restarts. Absorbs Cursor `mcpProces

### ✨ ADR-0440 Canvas web components (render-side DiffView + segmented UsageBar)
Render-side React components for the web/Tauri surface mirroring Cursor's cursor/canvas SDK prop shapes (DiffViewProps / UsageBarProps / colorPalette), FED BY quanta's EXISTING computed data — NO recomputation. Data reuse (single source of truth): - Diff: the line-level LCS mat

###  ADR-0453 Heartbeat autorun eligibility (per-thread approval gate for scheduler + reactor)
A PURE, TOTAL eligibility evaluator consulted by BOTH background autorun paths before they fire: evaluateAutorunEligibility({ approvalPolicy, priorOutcome?, manualApprovalPresent?, mode? }) → { eligible, reason } Mapping (structural — no heuristics, no clock, no Date.now/Math

###  Disk-configured command hooks (security-gated shell on HookBus events, ADR-0454)
Adds the missing executor for Claude Code's settings.json#hooks model: a closed-port CommandHookRunner that, on a matching HookBus event, runs the configured shell command(s) ONE-SHOT through an injected spawn port, passing the hook event payload as JSON on the child's stdin (Cla

### 🆕 Proactive token-refresh scheduler — clock-driven pre-expiry refresh (ADR-0461)
`TokenRefreshScheduler` closed-port — turns ADR-0160's purely caller-driven rotation into clock-driven, refresh-BEFORE-expiry. ADR-0160 only refreshes reactively when a caller invokes `rotate()`, which in practice happens AFTER a wire call already ate a 401; a long task hits th

###  External-agent 4-stage import lifecycle


###  JSON-RPC 2.0 envelope + -timeout 채널 (ADR-0033)


###  MCP 클라이언트 + tool 브리지 (임의 MCP 도구 passthrough)
QUANTA_MCP_CONFIG 노브를 넘어선 실제 capability — McpClient(stdio JSON-RPC 2.0: initialize/tools-list/tools-call/shutdown + per-request 타임아웃)와 mcp-bridge가 임의 MCP 서버의 도구를 agent tool registry에 mcp__<server>__<tool> 이름으로 브리지. loa

### 🆕 Connector availability probe — DNS + HEAD + LRU (ADR-0160 W7 Phase D)
`createAvailabilityProber({fetchPort, dnsPort, clockPort, lruSize?, lruTtlMs?, headTimeoutMs?})` — per-host availability probe with LRU cache. Probe sequence: DNS resolve (typed `DnsPort`) → empty array → "dns-fail"; then HTTP HEAD to `https://{host}/` via injected `FetchPo

### 🆕 Per-connector token rotation — in-flight mutex (ADR-0160 W7 Phase E)
`createTokenRotator({tokenStore, clockPort})` — per-connector token rotation layer. `rotate(connectorId, refresh)` runs the caller-supplied refresh callback under an in-flight mutex keyed by `connectorId`: concurrent rotate calls for the SAME id coalesce to ONE callback invocat

### 🆕 Connectors REST registry — dynamic server-driven catalog (ADR-0160 W7 Phase B)
Dynamic connector catalog backed by `GET {baseUrl}/connectors`. Replaces the hand-curated static stdio MCP list with a server-driven registry. 24h positive cache (RFC 8414 §4 SHOULD anchor). On 5xx/network failure: serves stale cache and returns `cached-degraded` from `refresh()

### 🆕 OAuth endpoint discovery — RFC 8414 well-known + OIDC fallback (ADR-0160 W7 Phase C)
`discoverOAuthEndpoints(issuer, fetchPort)` — RFC 8414 §3 well-known authorization-server discovery + OIDC openid-configuration fallback on 404. Returns typed `OAuthEndpoints` with `authorizeEndpoint` / `tokenEndpoint` / optional `registrationEndpoint`. Stable error arm via `O

### 🆕 OAuth dynamic client registration — RFC 7591 (ADR-0160 W7 Phase C)
`registerOAuthClient(endpoint, metadata, fetchPort)` — RFC 7591 dynamic client registration. POSTs `client_metadata` (redirect_uris + optional client_name / token_endpoint_auth_method / grant_types / response_types / scope) as `application/json`, parses typed `OAuthClientRegist

###  ADR-0161 Automation 4-arm lifecycle + JSONL store
4-arm closed lifecycle (`active` / `paused` / `deleted` / `error`) + pure transition helpers (`createAutomation` / `transitionStatus` / `recordFire` / `markError` / `isFireEligible`) + file-backed JSONL append-only store. Layout mirrors shadow-odb (ADR-0108) and subagent-persiste

###  ADR-0161 Model reroute (preference + fallback chain)
`chooseModel({preference, fallbacks, availability})` probes `[preference, ...fallbacks]` in order against the injected `ModelAvailabilityPort` and returns the first available model OR `"all-unavailable"` (with `chosen: preference` so the caller preserves intent in the error path)

###  ADR-0161 RRULE parser (RFC 5545 strict subset)
`parseRRule(s)` / `serializeRRule(rule)` implement a strict RFC 5545 §3.3.10 BASIC RECUR rule subset (`FREQ=DAILY|WEEKLY|MONTHLY` + optional `INTERVAL` / `COUNT` / `UNTIL` / `BYDAY` / `BYMONTHDAY`). HOURLY / MINUTELY / SECONDLY / YEARLY and the BYSETPOS / BYWEEKNO / BYYEARDAY su

###  ADR-0161 SchedulerRuntime (tickOnce + reactor seam reuse)
`createSchedulerRuntime({store, availability, clock, env, agentLoop, workspace, sink?, tickIntervalMs?})` composes all the scheduler ports into one closed seam. Two surfaces: - `tickOnce()` — the testable atomic. Loads all automations, for each active+due: chooses model → enq

###  ADR-0161 Weekday nth-occurrence DSL (+1MO … -5FR)
`parseWeekday` / `serializeWeekday` / `nthWeekdayOfMonth` / `allOccurrencesInMonth` implement the RFC 5545 BYDAY ordinal grammar Codex's `automation-schedule-BpeIuMts.js` uses for "2nd Monday of every month" (`+2MO`) / "last Friday" (`-1FR`) style automations. Strict ordinal rang

###  IsolatedMcpClient — opt-in MCP backed by plugin-isolation (ADR-0162)
Mirror public API of legacy `McpClient` (start / listTools / callTool / stop) but delegates spawn to `IsolatedProcessSpawnerPort` (+ PluginHost for JSON-RPC). Default-OFF — gated by env flag `MCP_USE_ISOLATED_SPAWN=1` (also accepts `true` / `yes`); when unset, the legacy McpCli

###  DXT manifest loader + launchDxt (ADR-0162)
Strict Zod schema for `.dxt` manifest (faithful Claude Desktop subset): name (kebab/snake), version, entry (relative-only, path-traversal rejected), serviceName (ASCII ≤64), optional args (≤64) / env (value ≤4096 chars) / allowLoadingUnsignedLibraries. 1MB manifest cap (`MA

###  PluginHost — typed JSON-RPC 2.0 wrapper for isolated plugins (ADR-0162)
Protocol-agnostic JSON-RPC 2.0 wrapper over `IsolatedProcess` (closed port). `call(method, params, {timeoutMs, signal})` → typed Promise, per-call timeout (default 30s), AbortSignal cancel without timer leak, duplicate-id drop (warn), corrupted-envelope drop (NO-THROW), unknown

###  Plugin isolated process spawner — IsolatedProcessSpawnerPort + Bun adapter (ADR-0162)
Closed `IsolatedProcessSpawnerPort` (W11 Claude DXT `UtilityProcess.fork({serviceName, allowLoadingUnsignedLibraries})` 흡수) + `Bun.spawn` adapter. 5s spawn timeout (첫 stdout 라인 = ready sentinel), 5s SIGTERM→SIGKILL escalation (runtime/guarded-spawn 의 2s KILL_GRACE_M

###  PluginLifecycleManager — auto-restart + heartbeat (ADR-0162)
State machine `idle → starting → running ↔ restarting → dead/stopped`. Rolling-window restart counter (default max 3 / 60s); on budget exhaustion → `dead`, no further restart. Heartbeat (default 10s ping cadence + 2-miss threshold = 20s silence → kill+restart cycle); 

###  LLM Provider Phase 2 (Bedrock + Vertex real stream)
Real streaming impls for Bedrock + Vertex adapters via `@anthropic-ai/bedrock-sdk` + `@anthropic-ai/vertex-sdk` (Phase 1 was typed-throw stubs). DI `clientFactory` test seam keeps tests off-network; shared `mapRawEvent` reused from the public anthropic adapter (transport-only sub

###  LSP applyWorkspaceEdit 2-phase atomicity (+ EXDEV fallback)
3-phase atomic commit for cross-file LSP workspace edits (rename refactor, source code-action apply). Phase 0 cleanup of stale tmps from prior crash → Phase 1 write all targets to `.quanta-tmp-<sessionId>-<rand>` siblings → Phase 2 atomic rename to originals. EXDEV (cross-FS)

###  ADR-0215 AutomationEnginePort (Codex 3-table schema + pure tickScheduler)
`AutomationEnginePort` — a 5-verb closed seam (schedule / list / cancel / next / markRun) wrapping the Codex `automations` + `automation_runs` + `inbox_items` 3-table schema. Two adapters live under the slice: - `inMemoryAutomationEngine()` — zero-dep reference (tests / opt-o

###  createLLM provider factory + DEFAULT_MODEL registry (OCP)
`createLLM(provider, opts)` is the one factory the three app entry points (cli/bench/eval) call instead of duplicating `new AnthropicAdapter / new OpenAIAdapter / new ChatGPTOAuthAdapter`. The `Provider` type re-exports `LLMProvider` from `@/shared/errors` so the error taxonomy a

### 🆕 LLM stream first-chunk + inter-chunk idle timeout decorator
AsyncIterable decorator wrapping a raw provider stream and racing each `next()` against two independent deadlines — `firstChunkMs` (default 60s, reasoning models like o1 can legitimately take 30s+ before any token) and `idleMs` (default 120s between subsequent yields). On timeo

###  Provider streaming event decoders (SSE + WS) — Responses API v2
Wire-level decoders for streaming envelopes emerging from OpenAI Responses API v2 (HTTP `text/event-stream` + `wss://chatgpt.com/backend-api/codex/ responses`). Parses bytes off the wire into a uniform discriminated `DecodedProviderEvent` shape (12 documented `kind` variants from

###  assembleFromEvents — stream → Message + ADR-0076 thinking accumulation
Single SSOT for folding a `StreamEvent` iterator into one `AssembledTurn` ({message, stopReason}). Three explicit fold rules: (1) `text_delta` extends the trailing TextBlock OR opens a new one — text never merges into thinking/tool_use; (2) ADR-0076 Gap-2 — consecutive `think

### 🆕 EventBridge — surface-agnostic pub/sub + closed BridgePayload union
Surface-agnostic event bridge connecting multiple surfaces (CLI / Web / Tauri / future remote-control daemons) to a single logical agent session. Each surface publishes events and subscribes to peer events; the transport is INJECTED (no `process.env` / `argv` reads inside `@/ipc`

### 🆕 IPC transports — in-memory / stdio / uds / websocket
Four `BridgeTransport` implementations behind one closed shape so the EventBridge stays transport-agnostic. (1) `in-memory` — test fixture with `createInMemoryHub` for many-peer loopback (fully working). (2) `stdio` — line-delimited JSON over Node Readable/Writable, used by C

### 🆕 PortableSessionV1 export/import — surface round-trip schema
Portable session schema v1 (snake_case wire) for round-tripping a saved session across surfaces. `exportSession(sessionId)` writes `{schema, version, meta, reason, messages}` — meta is intentionally tiny (id, title, cwd, timestamps, archived, git_{sha,branch,origin_url}) so the

###  Anthropic beta channels + 30 MB skill cap


### 🆕 Approval-gate wire — attribute HITL reviewer escalations to Objective+RunLedger via approval-SM (ADR-0407)
Closed-port adapter (`createApprovalGate({ approvalSM?, now? })`) that wraps `ApprovalStateMachinePort.request` + `settle` around a host-supplied HITL resolver. Admissibility-gate imports + wraps `reviewAction` at `reviewAndDecide` so every reviewer escalation lands as a first-cl

### 🆕 Approval state machine (ADR-0403 port + store)
Closed port + in-memory store for HITL approval / clarification / escalation requests. quanta already has the *mechanism* for stopping the agent and asking the operator (HITL tier registry, `request_user_input`, `always-confirm` / `hand-off-required`), but it has no first-class S

### 🆕 ChatGPT-OAuth Responses-API adapter (subscription path)
Concrete `LLMPort` that calls `${apiBase}/responses` with the disk-stored OAuth bearer instead of an API key. Default `apiBase` is `https://chatgpt.com/backend-api/codex` — the Responses-API endpoint the OSS Codex CLI uses for ChatGPT subscription traffic. The wire protocol is 

###  Claude Code session translator (~/.claude/projects/*.jsonl → Message[])
`SessionTranslator` adapter that parses a Claude Code session transcript at `~/.claude/projects/<slug>/<id>.jsonl` into v3 `Message[]`. Each line is a JSON object discriminated by `.type`: `user` / `assistant` carry `message: { role, content }` (string or array of `text` / `tool_

###  Composition-root install helper + session-keyed resource registry (ADR-0332 / 0334 / 0345)
Two cross-cutting wires for the Codex-r2 absorption sprint. ADR-0332 `installCodexR2Wires(cfg, deps)` populates the 6 AgentConfig wire slots (systemPromptCache/Key, contextEventsForTurn, mentionInjector, compactionEventEmit, imageSanitizationRetry) from a composition-root dep bag

###  Disk-persistent session registry + env-var swap + cross-machine negative (ADR-0348 / 0351 / 0355)
Three-ADR persistence band for ADR-0345 session-resource-registry. ADR-0348 ships the jsonl-backed adapter (per-session `<storageDir>/<sessionId>/{events,prompt-cache}.jsonl + meta.json`, TTL 14d + per-session 50MB cap, path-traversal guard, atomic write via temp+rename, NO-THROW

###  Multi-process lockfile for jsonl disk-adapter (ADR-0356)
Closes ADR-0348 single-writer assumption. Per-session lockfile (`<storageDir>/<sessionId>/.lock`) acquired via Node `wx` flag (O_CREAT|O_EXCL|O_WRONLY|0o600) so concurrent quanta instances serialize disk writes per sessionId. Stale-lock detection at 30s mtime threshold reclaims l

### ⏸ Negative decisions — per-turn image retry rebuild + provider wm-live reads (ADR-0343 / 0344)
Two ADRs documenting deliberate NON-implementation with re-open triggers and impl sketches. ADR-0343 (per-turn image retry rebuild): fact-find showed no user / system / upstream-parity scenario for mid-session toggle of `cfg.imageSanitizationRetry`. Future trigger conditions (use

###  Plugin discovery + MCP launcher + skill set extension + app catalog + manifest unification (ADR-0336 / 0338 / 0339 / 0341 / 0342)
5-ADR plugin substrate. ADR-0336 ships 3 slices: plugin-discovery (`.codex-plugin/plugin.json` parser + fs scan + in-memory registry), app-catalog (`DEFAULT_APP_CATALOG` 3 entries verbatim from surface- model.md: cli / browser / desktop), plugin-app-resolver (composite resolver).

###  Session registry cleanup --dry-run (preview without commit) ADR-0387
ADR-0387 extends ADR-0379 `/session-registry cleanup` with a `--dry-run` flag so operators can preview retention sweep candidate counts (TTL axis + sliding-window byte-cap axis) WITHOUT committing the eviction. Adds two NEW leaf functions — `countDiskRegistryCleanupCandidates` 

###  Session registry R13 — caller-owned wire + sweep telemetry + WAL RESTART + evict/help + path norm (ADR-0372/0373/0374/0375/0376/0377)
6-ADR R13 closeout — every gap from R12's follow-up list landed TDD-strict (each hellgate case authored RED-first, GREEN-confirmed, REFACTOR-pinned). ADR-0372 closes the ADR-0368 architectural mismatch via a caller-owned- registry builder; assemble.ts ternary becomes 3-case (cf

###  Session registry R14 partial — WAL telemetry + cleanup slash + unified API (ADR-0378 / 0379 / 0383)
R14 partial closeout — 3 of 6 follow-ups landed; 3 deferred to R15 due to API instability (R14 W-A + W-B agents both lost ~48 tool uses to ConnectionRefused before commit). ADR-0378 surfaces post-sweep SQLite WAL size via `SweepResult.walSize` + emits `codex_r2.sqlite.wal_bytes

###  Session registry R15 closeout — TRUNCATE mode + bulk pattern + dry-run + listSessionIds + 2 process ADRs (ADR-0384..0389)
R15 closes out the R14 deferred follow-ups + adds two process-level ADRs from sprint retrospective. 6 ADRs land, 3 via worktree-isolated agents (all 3 successful — 9 consecutive worktree wins counting R12+R13+R14 ff stage) + 2 main-direct (markdown ADRs) + 1 from W-C (catalog r

###  Session registry retention sweep + inspector slash (ADR-0367 / 0369 / 0370)
Three-ADR closeout that takes ADR-0348 jsonl + ADR-0361 sqlite adapters from "exists" to "operator-ready". ADR-0367 adds `QUANTA_SESSION_REGISTRY_SQLITE_PATH` env-var to the global lazy-init priority chain (sqlite > disk > in-memory) with NO-THROW fallback at every step. ADR-0369

###  SQLite-backed session registry (Codex logs_2.sqlite parity) (ADR-0361)
Sibling SQLite backend for the ADR-0345 `SessionResourceRegistry` port. Layered architecture: in-process `Map<sessionId, Entry>` owns live `SessionResources` refs (preserves same-id same-ref invariant byte-identical with the in-memory + JSONL siblings); `bun:sqlite` WAL database 

### 🆕 Compaction visibility — RecoveryReason + microcompact + post_compact (ADR-0409)
Compaction은 그동안 silent internal optimization이었음 — 사용자는 왜 잊었는지, 어디서 재개해야 하는지 알 수 없어 신뢰가 깨졌음. ADR-0409은 compaction을 USER-VISIBLE RESUME CONTRACT로 승격: (1) `RecoveryReason` closed enum (7 arms: token_

### 🆕 Competitor session import — real persist + MCP/hooks/rules + dedup (ADR-0430)
`session import <provider>` ingests a competitor coding-agent install and makes it a first-class quanta session. ADR-0430 closes the `persisted_sessions=0` gap of the translate-only ADR-0038: each Claude Code transcript (`~/.claude/projects/<slug>/*.jsonl`) is translated to v3 `M

### 🆕 Custom 3P Setup MVP — 5 core method + lifecycle (ADR-0245)
Claude Desktop `Custom3pSetup` 24-method IPC namespace 의 MVP 5 core method 흡수: register / update / remove / health / list + 4-state lifecycle (draft → configured → healthy → failing). 19 method 는 ADR-0151 (OAuth discovery + dynamic registration) / ADR-0160 (REST cat

### ✨ DXT user_config — typed fields + template substitution + keychain secrets
Extend the DXT plugin manifest with Claude-Desktop-parity user configuration: typed user_config fields + `${...}` template substitution + OS-keychain secrets. Today src/plugin-isolation/dxt-loader.ts DxtManifestSchema accepts a minimal strict subset (name/version/entry/serviceNam

### 🆕 Prompt-keyword + tool-failure effort escalation classifier
Session-scoped advisory classifier (`createEffortClassifier`) that watches user prompts for "think harder" style keywords and accumulates per-tool failure counts, surfacing a recommended `EffortLevel` (the 5-tier `default|low|medium|high|max` axis from `src/agent/effort.ts`). Def

### 🆕 Apply-patch fast-apply fallback (focused re-emit on failure)
When `apply_patch` rejects a V4A patch (anchor drift / generic apply error / parse error), `createFastApplyFallback` makes ONE focused side-conversation attempt to re-emit the patch. It builds a prompt that names V4A explicitly, states the prior failure (errorKind + errorMessage)

### 🆕 Apply-patch fast-apply fallback WIRE (retry on V4A failure)
Wires the ADR-0417 `FastApplyFallbackPort` (previously a pure port with no consumer) into the `apply_patch` tool. When a V4A patch FAILS to apply, the tool optionally calls the fallback (executor-model re-emits the patch) and retries the V4A applier ONCE. Seam: a new OPTIONAL `To

### 🆕 External-agent config migration — detect + import Claude/Cursor config into quanta format (H13)
Startup detect-and-import of competitor (Claude Code / Cursor) CONFIG artifacts into quanta's format. Mirrors Codex's `external_agent_config.rs` three-part model: a DETECT pass walks the known external config locations (no heuristics — a fixed `(scope, relative-path, item-type)

###  Heartbeat automation — thread-attached repeating agent (kind cron|heartbeat)
Codex automation `kind: cron | heartbeat` 흡수. 기존 automation은 cron(thread- detached, fresh fire)뿐이었음. heartbeat는 기존 대화 THREAD에 붙어 매 fire를 그 thread로 라우팅하고 그 thread의 권한/샌드박스/collab posture를 상속(escalate 안 함

###  Hook DoS caps — handlers-per-event + payload bytes (S5 hardening)
Two structural DoS brakes for the HookBus surface. (1) Per-event handler cap (default 64) — registering a 65th handler throws HookRegistrationError; almost always a registration leak (forgotten unsubscribe in a loop / leaked test fixture / malicious third-party module), so we s

###  Hook new events — user_prompt_submit + pre_compact + subagent_stop (S5)
Three additional HookEvent variants S5 surfaces (pre_compact + subagent_stop already shipped via ADR-0133; user_prompt_submit is the new addition). (1) user_prompt_submit — emitted by loop.ts ONCE per run, immediately after session_start, when the seeded buffer ends in a user m

###  Hook per-handler timeout (S5 hardening)
Per-handler timeout race for the HookBus emit chain. A stuck handler used to block the agent loop forever (P0); S5 adds an opt-in race against setTimeout(reject) so the bus continues to the next handler and the loop stays responsive. Timeout is enforced ONLY when set — absent o

### 🆕 Channel-triple naming — `{name}-request` / `-response` / `-timeout`
Codex-pattern channel-triple generator. Every async method has THREE related channel names derived from a single base — `channelTriple("agent.run")` yields `{request: "agent.run-request", response: "agent.run-response", timeout: "agent.run-timeout"}`. Building the triple from o

### 🆕 JSON-RPC 2.0 codec — encode/decode helpers returning `Result`
encode / decode helpers for JSON-RPC 2.0 frames (request / notification / success-response / error-response / Codex-style explicit timeout). Decoders NEVER throw on malformed input — bad JSON, missing fields, wrong types all surface as `err(JsonRpcCodecError)` so the caller dec

### 🆕 JSON-RPC RequestId — branded, deterministic, seedable
Branded `RequestId` type plus a deterministic, seedable id generator for JSON-RPC correlation. No `Math.random()` and no `Date.now()` feed id generation, so recorded traces stay byte-identical replayable (ADR-0023 invariant) when the caller supplies a fixed seed. The generator ex

### 🆕 Landlock sandbox — phase-1 typed-degrade passthrough
Linux Landlock + seccomp implementation, deliberately phase-1. A production wire on Linux would need either a native binding (`napi-rs landlock`) with ongoing kernel-ABI-drift maintenance, or a shell-out to `bwrap` / `firejail` adding a system dependency we don't want to require 

### 🆕 LLM adapter shared helpers — stream-timeout / tool-input throw / usage spread
The Anthropic and OpenAI adapters previously duplicated ~90% of three frames; this module factors them as plain functions (composition over inheritance — there is no shared SDK base to subclass). (1) `resolveAdapterStreamTimeouts(config)` — resolves per-adapter stream-hang de

###  Agent↔LSP bridge — typescript + pyright adapter routing (ADR-0015)
Agent 슬라이스가 LSP 어댑터(TypescriptAdapter / PyrightAdapter)와 만나는 단일 bridge — 파일 확장자 → adapter 라우팅 + lsp-nav 도구(definition/references/hover/ symbols) 어셈블리 + diagnostics 채널 와이어업. LspPort 계약은 lsp 슬라이스 

###  LspClient base — stdio handshake + 8 nav RPCs + LspRequestError typed
Concrete implementation of `LspPort` (ADR-0015 / ADR-0024) — the bulk of the LSP slice machinery lives here so adapters (TypescriptAdapter, PyrightAdapter) only contribute their launcher argv and an extension→languageId mapping. Owns: subprocess lifecycle (`start`/`stop` idem

###  LSP JSON-RPC 2.0 codec — Content-Length framed (MessageReader / encodeMessage)
Wire-level codec behind `lsp-bridge` and `lspport`. LSP framing is NOT MCP's newline-delimited shape: every message is a JSON body preceded by an HTTP- style `Content-Length: N

` header. The single hardest correctness risk in an LSP client is the stream framing — a serve

###  PyrightAdapter — pyright-langserver stdio adapter (Python)
Per-language adapter on top of `LspClient` base for `pyright-langserver` over stdio. Minimal contribution surface — only the launch argv default `["pyright-langserver", "--stdio"]` (overridable via adapter options) and a constant `languageIdFor: () => "python"`. Every file the 

###  TypescriptAdapter — typescript-language-server stdio adapter + JS/TS/JSX/TSX languageId map
Per-language adapter on top of `LspClient` base for `typescript-language-server` over stdio. Two contributions only — the rest is inherited: (1) launch argv default `["typescript-language-server", "--stdio"]` (overridable via adapter options); (2) `languageIdFor(filePath)` whic

### 🆕 ADR-0197 MCP Elicitation 7-schema (rmcp 0.15)
rmcp 0.15 Elicitation 7-schema 흡수 — typed user input prompt: String / Number / Integer / Boolean / Enum / MultiSelectEnum / SingleSelectEnum (각 Titled/Untitled variant = 14 zod schema). Port surface 7 method 1쌍. Adapters: defaultCliPrompter (REPL 통합) + headlessRejec

### 🆕 H18 MCP HTTP-Server OAuth (RFC 8414 discovery + PKCE + refresh, port-injected)
Wire the EXISTING `@/connectors` OAuth-discovery suite (RFC 8414 `.well-known/oauth-authorization-server` + OIDC fallback, RFC 7591 dynamic client registration, RFC 6749 §6 refresh, token rotation) plus the `@/auth/chatgpt-oauth` loopback + PKCE browser flow into the MCP client,

### 🆕 MCP inbound elicitation wiring + single-flight lease
The 2026-06-01 gap audit found MCP elicitation was DEAD: the ElicitationPrompter port/schemas existed (ADR-0197) and full-negotiator advertised elicitation:{} to the server, but McpClient.dispatch() did `if (!isResponse(msg)) return` — silently dropping every inbound server req

### 🆕 MCP OAuth token storage in the OS keyring (Keychain / libsecret), file-fallback + migration
Harden H18 (`mcp-http-oauth`) credential STORAGE: an OPTIONAL `KeyringPort` (closed-port, injected exec — NOT a hard-coded `child_process`) so MCP OAuth tokens live in the OS secret store — macOS Keychain (`security`) / Linux libsecret (`secret-tool`, Secret Service) — inst

### 🆕 H19 MCP resources/prompts/roots typed client methods
H19 (jun-3-misc §3) — TYPED MCP client methods for the `resources/*`, `prompts/*`, and `roots/*` method families so the model can use server-exposed resources + prompt templates, and so quanta can honestly advertise `roots`. Before this the client spoke only `initialize` / `to

### 🆕 ADR-0470 B1 MCP Sampling Handler (@/llm-backed, HITL-gated)
B1 follow-up — wire a REAL `@/llm`-backed inbound MCP `sampling/createMessage` handler at the composition root (the host layer is the only slice allowed to reach both `@/mcp` and `@/llm`; `@/mcp` may NOT import `@/llm`, the reason the `SamplingHandlerPort` DI seam exists). The 

### 🆕 ADR-0196 MCP Tasks Capability (rmcp 0.15 standard)
Cursor + Claude + Codex 3-vendor 강신호 — rmcp 0.15 표준 MCP Tasks capability 흡수. 4 method: tasks/list (cursor pagination) / tasks/getInfo (task_id → status) / tasks/getResult (task_id → result|error) / tasks/cancel (task_id → ok|not-cancellable). TaskState 5-arm

###  MCP tasks live binding (outbound tasks/* dispatch)
Live `McpTasksPort` over a started `McpClient`. `clientTasksPort(client)` dispatches the four rmcp 0.15 `tasks/*` JSON-RPC requests through `client.requestRaw(method, params)` — the outbound mirror of the inbound elicitation router: list → `tasks/list` `{ cursor? }` → `{ ta

### 🆕 Migration content-dedup fingerprint — SHA-256 of source bytes
Content-addressed fingerprint of a session transcript file so a re-run does not re-import an unchanged session. `contentSha256(jsonlPath)` is the SHA-256 hex of the raw file bytes (NOT the parsed Messages) — cheapest correct primitive, stable across translator changes for the s

### 🆕 Import-log persistence — sidecar lock + busy-error
Persistence for the external-agent import log, mirroring Codex's `external_agent_session_imports.json`. Default path is `<homeDir>/.quanta/external_agent_session_imports.json`; the caller-supplied `homeDir` lets tests redirect to a tmpdir. Writes use a sidecar lock file (`<import

### 🆕 Background side-agent daemon — resident monitor/cleanup (N1)
Claude `tengu_bg_agent_action`(24 occ, 최고신호) 흡수 — 메인루프 안 막고 모니터링/ 정리/주기점검 돌리는 PERSISTENT 백그라운드 데몬 에이전트. one-shot subagent-bg(ADR-0130) /scheduler(메인루프 구동, ADR-0161)와 별개 축: 데몬은 re

### 🆕 MCP connector discovery / catalog (N2 — discover + install MCP servers)
Codex `imported-connector-apps`/`connector-logo` 흡수 — `.mcp.json` 수동편집 대신 MCP 서버를 **발견·설치·관리**하는 surface. H18(MCP-OAuth)과 짝: OAuth는 인증, 이건 발견/카탈로그. 코어 (`src/connectors/mcp-connector-catalog.ts`, PURE leaf, @/

### 🆕 MCP resource/prompt tools (N3 — list/read resources + list/get prompts)
H19(LANDED)이 준 `McpClient`의 typed no-throw `listResources`/`readResource`/ `listPrompts`/`getPrompt` (resources/* + prompts/* method 패밀리) 위에 얹는 **agent-callable 도구층**. H19 메서드는 INTERNAL — 에이전트 루프가 못 부름. N3가 네 개의 call

### 🆕 "PTY / tmux session attach (N6) — attach + resize + live stdio across turns"
N6 (§7, RFC docs/plans/jun-4-pty-attach.md). quanta could spawn shells (one-shot `bash`, `bash` background, the subagent 6-tool pipe router) but had NO real PTY and could not attach to a pre-existing, long-lived interactive terminal. N6 adds a gated `@/tool/pty` slice exposing 6

### 🆕 OAuth callback provider port — CLI loopback / Tauri deep-link / Web origin
ChatGPT-OAuth 콜백 수신을 surface-agnostic port로 추상화 — `OAuthCallbackProvider` 인터페이스는 redirect_uri 빌드 + 콜백 대기(promise) + state 검증을 한 계약으로 본다. Surface 별 구현: (1) **CLI** — `cli-callback.ts`, `http://localhost:<port>

### 🆕 Thread-goal budget ENFORCEMENT — budget_limited status + idle-continuation hard gate (H17)
Makes the ADR-0394 `ObjectiveBudget` (maxTokens / maxTurns) a HARD GATE instead of stored-but-never-read informational state. Before H17 the budget round-tripped through the store and the `objective_get` render, but NO enforcement site ever read it: a goal could run unbounded pas

### 🆕 Objective as a first-class per-thread object (ADR-0394, MODEL ONLY wave)
First-class per-thread Objective — closes quanta's biggest structural gap: there was no typed object tying a thread's work together (goal / what "done" means / what is blocking / what to do next / budget). Compaction, resume, subagent-result attribution, and approval all re-der

### 🆕 Objective LLM tools — objective_set / objective_update / objective_get (ADR-0402)
Three LLM-facing tools wired to the ADR-0394 `ObjectivePort` so the agent itself can declare its objective, surface blockers, and list next actions — closing the consumer side of the substrate ADR-0394 shipped. Wave-1 (ADR-0394) was MODEL ONLY; this wave (ADR-0402) is the FIRST

###  ADR-0415 Observability live-wire (HookBus auto-subscribe + RuntimeFacade port exposure)
Closes the three Wave-3 deliberate-holds so observability goes live. Part 1 (landed separately) promoted `runLedger` + `approvalStateMachine` to first-class `AgentConfig` slots (alongside `objective` + `shadowVerify`). Part 2 — `resolveObservabilitySlots(env)` mints the canonic

### 🆕 Observability UI pane (Running / Waiting / Completed + Objective + Approvals)
Render the three Wave-1/2 long-running-work state machines (RunLedger / Objective / Approval state machine) in a SEPARATE pane alongside the chat so the operator sees Running / Waiting / Completed + the per-thread Objective + Pending Approvals at a glance — the structural UX ga

###  ADR-0406 Composition-root observability wire (Objective + RunLedger + ApprovalSM + ShadowVerify)
Wave-1 + Wave-2 shipped four pure typed observability ports — `Objective` (ADR-0394), `RunLedger` (ADR-0395), `ApprovalStateMachine` (ADR-0403), and `ShadowVerify` (ADR-0396/0400) — plus the `run-ledger-attribution` hook subscriber (ADR-0401). All five are SEALED slices with 

###  ADR-0420 Observability served-WebSocket sink (closes ADR-0415 emitter-port-only deferral)
Closes ADR-0415's documented emitter-port-only deferral so observability goes fully live over the served WebSocket. ADR-0415 fed the four live observability ports (RunLedger / Objective / ApprovalStateMachine / ShadowVerify) to `createObservabilityEmitter`, but the emitter ran PO

### 🆕 OsSandbox port — platform-aware backend router with typed-degrade
Closed-port DI surface `OsSandbox { spawn, availability }` and its production default `defaultOsSandbox(cfg)`. Picks the right backend for the current OS: macOS → Seatbelt (`sandbox-exec`), Linux → Landlock (phase-1 typed-degrade), Windows → passthrough. The two profiles `"

### 🆕 Revoke OAuth tokens on logout (RFC 7009, best-effort, NO-THROW, default-OFF)
Close a credential-lifetime hole at `/logout` (jun-6 RFC). Today logout deletes ONLY the local token file (`deleteToken` → `unlink`); the server-side refresh token stays valid until it naturally expires, so anyone who captured it (a leaked backup, a stale process, a compromised

###  ADR-0401 Run-ledger attribution via hook bus (bash/subagent/mcp observer)
Wave-2 wiring for the wave-1 Run Ledger (ADR-0395). `@/agent/run-ledger` is a pure store; this slice plugs INTO the in-process `HookBus` (`src/agent/hooks.ts`) `post_tool_use` event and translates observed tool outputs (bash background/await/kill banner, agent background launch b

### 🆕 ADR-0395 unified long-running-work state model (Run Ledger)
ONE state model + closed `RunLedgerPort` + in-memory store so a single surface can render Running / Waiting / Completed across ALL long-running work, replacing the three disjoint shapes quanta uses today: shell-detached (`{shellId, status:"running"}` resumed via `bash_await`/`bas

### 🆕 Seatbelt (SBPL) profile compiler — macOS sandbox-exec text
Pure compiler from a `SandboxPolicy` to a Seatbelt (SBPL) profile text suitable for `sandbox-exec -p '<text>'`. No I/O. Mirrors the Codex baseline (memory: `codex-seatbelt-sandbox-profile`) adapted to our 5-arm closed profile enum. `compileSeatbeltProfile(policy, workspace)` retu

### 🆕 Shadow-ODB workspace path → 16-hex directory hash
Deterministic SHA-256 hash of a normalized absolute workspace path, truncated to the first 16 hex characters (64 bits). The result is the on-disk directory name for that workspace's shadow ODB, e.g. `~/.quanta/snapshots/3a7f9c1b2e8d4a6b/`. 64 bits gives ~1-in-2^32 collision odds 

### 🆕 ADR-0400 Shadow Verify — real adapters (worktree/V4A/LSP) + shadow_verify LLM tool (Wave 2)
Wave 2 of ADR-0396. Real adapters for the closed `ShadowVerifyPort`: ShadowScratchPort = createPersistentWorktree (fresh git worktree forked off HEAD per call, removed on dispose); ShadowApplyPort = @/patch V4A applier with a scratch-rooted PatchFileSystemPort (NO-THROW — every

### 🆕 ADR-0396 Shadow Verify — apply-before-show in a scratch overlay (Wave 1 port + runner)
Multi-file edits change UX more by PRE-APPLY VERIFICATION than by the proposal itself. Closed ShadowVerifyPort + DI runner that: opens an isolated SCRATCH overlay (never the real workspace), applies the opaque patch (V4A/unified diff), runs requested lint/typecheck/targeted-test 

### ✨ skill-mcp-deps — skill-declared MCP servers auto-attached on activation (ADR-0476)
A skill declares the MCP servers it needs; when the skill is active and the gate is ON, the harness auto-attaches the deduped set. Today @/skill/skill-frontmatter parses only userInvocable/allowedTools — there is NO skill→MCP link. The leaf slice (src/skill/skill-mcp-deps, im

### 🆕 10-architecture-invariant slice-boundary runtime guards (16 slices)
Each library slice now has a `<slice>-slice-boundary.test.ts` runtime guard enforcing 10 invariants (surface isolation, per-slice deny-list, process.env/argv ban, raw stdio ban, console.* ban, alt-runtime env ban, surface-coupled node module ban, node:process named-import ban, sl

###  SseStream — spec-correct SSE serializer with redaction + injectable clock
Serializes every `AgentEvent` as a spec-correct Server-Sent Events frame: one `id:` line (per-frame monotonic counter), one `event:` line (the discriminant), one-or-more `data:` lines, terminated by a blank line. Transport-agnostic: `SseSink` is just `{ write(chunk) }` — a real

### 🆕 Managed-subagent mailbox — subagent_send_message between agents (ADR-0416)
Inter-agent mailbox so quanta subagents can coordinate WITHOUT teardown — Codex `multi_agents_v2.send_message(agent_id, msg)` parity. quanta subagents are fork-and-forget (ADR-0011): the parent only learns the result when the child settles. This slice adds a closed `MailboxPort

### 🆕 Subagent read-inbox — subagent_read_messages poll (ADR-0419)
Closes the ADR-0416 read deferral: adds the LLM-facing READ surface so a running agent can POLL its own inbox for messages other agents sent it (or broadcast) WITHOUT teardown. ADR-0416 shipped the `MailboxPort` substrate + `subagent_send_message`, but incoming mail was only surf

### ✨ Multi-agent coordination B — leader-mediated permission escalation (broker)
Capability B of multi-agent coordination (plan docs/plans/ multiagent-coordination.md §2.B) — a leader-mediated permission escalation broker so a subagent that hits a denied tool can ESCALATE to the spawning agent (the leader) instead of failing hard. Claude Code `--agent-team

### ✨ Multi-agent coordination A — task dependency DAG (Claude --agent-teams parity)
Capability A of multi-agent coordination (plan docs/plans/ multiagent-coordination.md §2.A) — a task dependency DAG so subagent fan-out respects ordering edges instead of firing flat + unordered. Claude Code `--agent-teams` parity (task dependency DAG arm; the leader-broker + 

### ✨ Multi-agent team-idle barrier + idle beacon (Capability C)
Claude --agent-teams의 team-idle 배리어 흡수. 리더가 "전원 끝났나"를 폴링하는 대신 fan-in 배리어로 await. 각 멤버가 turn-end에 idle beacon emit, 리더는 teamIdle(전원 beacon) 감지 시 다음 phase/handoff/종료. PURE 코어 (`src/subagent/coor

###  `/why <toolCallId|last>` — 기록된 tool-call에 대한 meta-LLM reasoning chain (ADR-0271)
ADR-0239가 `/debug` runtime tracer (single-line per-event)를 깔고 ADR-0267이 decision-emit을 widen해서 모든 게이트가 session JSONL에 decision envelope을 쓰게 만들었음. `/inspect <toolCallId>` follow-up surface가 그 envelope들을 re-read해서 multi-sectio

###  Windows flock strategy — Node `wx` retained (ADR-0365 negative)
Investigation + memorialization: Node `fs.open(path, "wx")` maps to `CreateFileW(CREATE_NEW)` on Windows, which is atomic at the kernel level on every supported volume (NTFS / ReFS / modern SMB2/3). The ADR-0356 exclusive-create primitive is therefore Windows-correct as written; 


---
## 09-security

###  Secret redaction as content-plane invariant (ADR-0078)


### 🆕 PII redaction을 dispatch.applyRedaction에 wire (ADR-0399)
PII 모듈(`src/security/pii-redaction/`)은 sync + masking(redactText)이라 ADR-0078 sync masking 슬롯에 drop-in 가능(secret-detection 신모듈은 async + detection-only라 안 됐던 그 대비). dispatch.applyRedaction에 PII 브랜치 추가 — secret-first 후 PII pa

### 🆕 check_secrets LLM-facing tool over async secret-detection (ADR-0412)
ADR-0078 secret-redaction은 sync + masking 슬롯이라 dispatch.applyRedaction에 wired됐지만, 신모듈 `src/security/secret-detection/`은 async + detection-only (splice 안 함)라 그 슬롯에 drop-in 불가. 이 항목은 그 갭을 LLM-callable 도구로 닫는다 —

###  sensitivity classifier — Layer 1 of secret-redaction (ADR-0078)
Layer 1 of the content-plane secret-redaction invariant. Maps a file path OR a shell-command shape to a closed-enum `SensitivityClass` (`public` / `internal` / `secret`). NEITHER layer is heuristic — paths match against an EXPLICIT list of dotfiles / config locations; commands 

###  redaction opt-out gate — startup-fail when disabled without ack (ADR-0078)
Default-ON gate that enforces the secret-redaction invariant. Disabling at the host level requires an explicit `acknowledgedRisk` string — a non-empty value the caller authored, surfaced in transcripts and audit so "redaction is off" is never invisible. `normalizeRedactionConfi

###  Network allowlist — propositional outbound host check (ci-bot mode)
Pure propositional check answering "is this URL/host on the allowlist?" for the ci-bot mode network lever (`network: { kind: "allowlist"; hosts: readonly string[] }`). The signal is purely the URL/host string — no counts, no thresholds, no fuzzy match. Allowlist semantics: exac

### 🆕 Network-egress enforcement wiring (mode → dispatch-guard)
Closes the "defined-but-not-enforced" hole found in the 2026-06-01 gap audit: network-allowlist-host-check shipped a pure host-check, NetworkPolicy/NetworkLever shipped a schema, and default-guard had checkHostAllowlist — but NOTHING wired them, so allowHosts was never read in 


---
## 10-app-persist-policy

###  Session import / export primitive
Versioned wire-stable `SessionExportEnvelope` (v1) + pure serialize/import primitives + FS adapter helpers. Carries SavedSession + optional sidecar (ConversationCheckpointStore / BudgetLedger / PlanQueueStore serialized strings). Import validates version + shape + emits warnings 


---
## 10-app

###  Biome 슬라이스격리


###  bun run dev|start


###  읽기 전용, NON-authoritative inspector


###  Python harness e2e 폐쇄 (2026-05-21, L3→L4)


###  QUANTA_STATE_PATH


###  tests/integration/sota-codex-full.test.ts


###  Shadow ODB rewindToLast — destructive restore + auto safety net
Closes the deliberate "not-implemented" trap from ADR-0108 by implementing rewindToLast (destructive workspace restore to last snapshot) plus a safety net: before rewind, the current workspace state is captured under a pre-rewind ref so the user can recover from accidental rewind

### 🆕 Verify-checkpoint bridge — opt-in markVerified caller seam
Caller seam that lets verify-pass events advance the Shadow ODB markVerified ref. Keeps mechanism (markVerified port from ADR-0122) and policy (when to call) separate so verify-guard can wire when its in-flight edits land. Helper-only module — no automatic wiring; hosts opt in 

###  Code coverage observability — V8-coverage port + MetricSink emission
4-part hexagonal slice in `src/observability/coverage/`. Closed `CoverageSource` port + V8 JSON adapter (byte-range → per-line, inner range overrides outer) + `defaultCoverageReporter()` exposing `evaluate(report, opts)` (closed 2-arm verdict) and `emitMetrics(report, sink)` (p

###  Prometheus recording rules — SLO burn-rate pre-computation
`docs/observability/recording-rules.yaml` with two groups: `quanta.slo.error_rate` (6 SLIs × 4 windows = 24 rules producing `slo:<sli>:error_rate_<window>`; tool-call preserves `by(tool)` dimension, others scalar-aggregate) and `quanta.slo.burn_rate` (6 SLIs × 2 windows = 12 ru

###  AST-precise branch counter — astCoverageSource() behind ADR-0165 port
AST-walked sibling to ADR-0165's V8 keyword-regex heuristic. Uses the typescript compiler API (`ts.createSourceFile` + `ts.forEachChild`) WITHOUT a runtime type-check pass — `typescript` is already on disk via the project's tsconfig install so marginal cost is zero. Counts bran

###  Prompt cache observability — typed observer + budget bridge + tool surface
Typed observer slice (`src/observability/prompt-cache/`) for the Anthropic Messages API `cache_control:{type:"ephemeral"}` mechanic. Captures `cache_creation_input_tokens` + `cache_read_input_tokens` per call into a `PromptCacheObserver` (record / attributeBreakpoint / snapshot /

###  Per-tool TTL drift detector — config-vs-preset divergence as typed signal
Closes ADR-0179's follow-up gap — caller `perToolTtlMs` is compared at cache construction against the audited `RECOMMENDED_PER_TOOL_TTL_MS` preset, divergence emerges as a 4-arm closed verdict (`too-permissive` / `too-restrictive` / `missing` / `unknown-tool`) emitted on the op

### 🆕 Darwin VZ native scaffold — napi-rs binding to Virtualization.framework
napi-rs Cargo workspace member (`crates/darwin-vz-helper/`) — typed surface + 20-case fake-binding hellgate + TS adapter (`src/mcp/skybridge/applevz-native.ts`) wired into `src/mcp/skybridge/registry.ts`. Mirrors ADR-0175 (linux-sandbox-native) scaffold side-by-side. Phase 3.4 

###  Architecture generator — tools/arch-gen walks ADRs + slices → ARCHITECTURE.generated.md
Plane-clean mini-generator that walks `docs/decisions/*.md` (ADR headers + status / date / related / 참조 paths) and `src/**/index.ts` (slice barrel doc-comments) — two signals of intent quanta has already stabilized — and emits `docs/ARCHITECTURE.generated.md`. Closes the 

###  Linux sandbox native impl — Phase 3.1 Rust bodies + cargo build verify
Fills the Rust function bodies stubbed by ADR-0175's Phase 3 scaffold. `crates/linux-sandbox-native/src/policy.rs` builds `landlock::Ruleset` with `CompatLevel::BestEffort` (kernel 5.13~6.15 ABI auto-fallback) + per-profile FS access matrix (read-only / workspace-write / workspac

###  CLI 헬퍼 export 폐쇄 (2026-05-21, L2→L3)


###  Cross-slice 타입-레벨 mirror 단언


###  tests/integration/probe.test.ts


###  withGitSnapshot


### 🆕 REPL slash-surface ctx mega-wire (8 slash slots)
Closes 8 default-OFF `ReplSlashCtx` slots so the corresponding slash commands render their real bodies instead of "not wired in this surface": - /edit-plan → ctx.planEdit (PlanStore wrapper) - /edit-message → ctx.composerEdit (mutable composer text) - /fork-checkpoint → ctx

### 🆕 CLI runtime feature-config unification (CLI-04)
Consolidates the scatter of inline `process.env` / `isTTY` reads across the CLI REPL surface (lifecycle pills, cost panel, branch progress, plan store, work-metrics sink, turn summary, turn indicator, debug tracer, image queue, rewind-git, `buildPromptUx` history/multiline) into 

### 🆕 CLI bootstrap host extraction (CLI-01)
Moves the per-session bootstrap (`bootstrapSession` from `src/apps/cli/repl/session-bootstrap.ts`, 332 LOC) out of the CLI surface and into `src/host/bootstrap/` — a surface-agnostic host layer composed of `bootstrap-session.ts` + `types.ts` + barrel. CLI now injects 14 factory

###  runRepairRounds
Pure-policy bench-repair loop SSOT: `runRepairRounds` orchestrates N rounds of (apply → `validate` → `buildRepairContext` → re-prompt) inside ONE sandbox so rounds share state (continue-the-conversation semantics), with all collaborators injected (no env / I/O reads in the 

### 🆕 ADR-0302 — /identity mid-session system-prompt rebuild (closes ADR-0291 last-mile)
ADR-0291 wired ctx.identity = {get,set,list}. Today set("plan") mutates the active mode cell, but the LLM keeps seeing the OLD system prompt that was captured ONCE at session bootstrap. The cached prefix never refreshes, so /identity plan after turn 1 leaves a default-flavoured p

### 🆕 Thin-surface invariant + headless-core ratchet
Codifies the "thin surface, headless core" architecture invariant: the CLI surface owns prompt UX + slash dispatch only; turn execution lives in `@/runner/orchestrate` (host-neutral `runOnce` / `runInteractive`); collaborator assembly lives in `@/runner/assemble`; loop semantics 

### 🆕 SideConversationPort — CLI engine-internal leak closure (CLI-02)
Closes the engine-internal leak in the CLI slash-surface where `buildReplSlashCtx` imported `assembleConfig` + `SessionDeps` from `@/apps/cli/internal` to wire the `/side` slash. Introduces a typed `SideConversationPort` injected from the host bootstrap; the slash-surface consume

### 🆕 CLI session-commands shim removal (CLI-05)
Removes `src/apps/cli/session-commands.ts` (the Phase-3 shim wrapping `runSessionCommand` from `@/runner/session-ops` with `cliImportHandler` + `resolveCliListEnv()`). The shim's 164 LOC of indirection is replaced by direct call sites that inject the migration handler + list-env 

### 🆕 Slash registry split — surface / session / app (CLI-03)
Splits the historical `src/apps/cli/slash-commands.ts` (763 LOC) into three sibling registries under `src/apps/cli/slash/`, each owning one ownership layer: - registry-surface.ts (34 entries) — `/help`, `/context`, `/usage`, `/color`, `/navigate`, `/wait`, `/skills`, `/reload-s

### 🆕 REPL host slim-down — lift 10 surface-adapter factories (CLI-06)
Lifts 10 inline `build*` helpers (~200 LOC) out of `src/apps/cli/repl.ts` into sibling factory modules under `src/apps/cli/repl/factories/` (branch-progress, cost-panel, debug-tracer, lifecycle, etc.). Each is a single-purpose composer mapping a typed `CliFeatureConfig` slice to 

### 🆕 Headless second-consumer proof (ARCH-07)
Validates the host-layer SSOT by adding a SECOND surface (`src/apps/headless/`) that drives the SAME `bootstrapSession` + `@/runner#runOnce` cores end-to-end with zero CLI imports. The headless surface is the proof-of-portability: until a second consumer exists, the slice-isolati

### 🆕 ADR-0309 — Surface-Wire R2 (identity onChange + granular registry + per-tool auto-record)
Closes the 3 deferred last-mile gaps from ADR-0300 + ADR-0302 in a single bundled slice (they all converge on surface-compose.ts and are file-disjoint parallel impossible): Wire 1 — Identity onChange → SystemPromptRebuilder → SystemSource The identity adapter's optional onC

### 🆕 Surface composition wire — ADR-0291/0292/0293/0294 end-to-end
Closes the REPL composition root for the 4 sibling tracks landed in the prior round (ADR-0291/0292/0293/0294). Each track shipped its contract + slash + adapter factory but never reached the surface composition path; this slice wires them through `composeSurfaceWires` so the slas

### 🆕 '`@/apps/web-daemon` — Bun.serve WS daemon publishing RuntimeSession'
Default-OFF bun process that publishes the existing `@/sdk/runtime` `RuntimeFacade` over WebSocket using the wire format already established by `@/ipc/session` (`SessionTransportMessage`, one JSON envelope per WS text frame). Boots via `bun run web:daemon` (or `main({...})` from 

### 🆕 ADR-0316 — Web frontend surface (Vite + React + Tailwind SPA)
Standalone Vite + React 18 + TypeScript strict + Tailwind 3.4 SPA at `apps/web-frontend/`, the web surface of the multi-surface plan (CLI / Web / Tauri shell). Connects to the daemon (Worker B, `apps/web-daemon/`) on `ws://127.0.0.1:4096/` and renders a minimal chat-style UI driv

### 🆕 Tauri macOS desktop shell — bun-daemon + screen-OCR sidecars + opt-in global hotkey (ADR-0317)
macOS-only Tauri 2.x desktop wrapper (`apps/tauri-shell/`) that hosts the web-frontend SPA, spawns the bun `quanta-web-daemon` and Swift `screen-ocr` sidecars from a default-DENY capability ACL, and registers a Cmd+Shift+Q global shortcut that is OFF by default (frontend must cal

###  LLM 호출 0


### 🆕 "/sticky-model SET surface — per-mode model slash command (ADR-0462)"
The SET half of sticky-model: a `/sticky-model <mode> <modelId>` slash command that writes the per-mode preference the CONSUME side (agent loop, ADR-0462) reads. ADR-0212 shipped the fs-backed store + resolver, and ADR-0462 wired the loop to read it — but there was no way for a

###  QUANTA_BENCH_TIMEOUT_MS


###  Run-mode expansion — ide + daemon (C1, ADR-0092)
RFC may-22 4-mode(interactive/headless/batch/ci-bot) × 12-lever ModePolicy 매트릭스에 2개 surface 셀 추가. ide = 에디터 임베디드(VS Code/Tauri): structured 이벤트 출력 + full-trajectory 관측 + reviewer-modal — interactive와 함께 유이한 reviewer-bac

###  eval 앱 — 6-tier 검증 스택 (audit/synthetic/grounding/public/trajectory/compare)
`bun run eval` — taxonomy(12 major/~120 leaf) 기반 6-tier 로컬 검증 스택. Tier 0 audit(정적 grep 커버리지 매트릭스) / Tier 1 synthetic(LLM-judge 시나리오 run) / Tier 2 grounding(real prompt assembly 기반 structured probe) / Tier 3 public (SWE-bench Verif

###  eval Tier-1 — synthetic scenario runner + LLM judge
Tier-1 of the 6-tier eval stack (umbrella id: `eval-five-tier`). Generates synthetic single-turn scenarios from declared `scenarios/` fixtures via `generator.ts` (deterministic schema-validated, distinct shape from trajectory replay), runs them through the real agent via `runner.

###  eval Tier-2 — context grounding structured probe + live gate
Tier-2 of the 6-tier eval stack (umbrella id: `eval-five-tier`). Measures fail-closed conversational grounding, not prose quality: a controlled probe runs over the real prompt assembly path (`buildTurnContext(...)` + direct `LLMPort.stream(...)`, `tools: []`) and asks for exactly

###  eval Tier-4 — trajectory replay / classify / freeze (real-session corpus)
Tier-4 of the 6-tier eval stack (umbrella id: `eval-five-tier`). Operates on REAL session transcripts (not synthetic, not public bench) — `source.ts` ingests recorded JSONL sessions, `classifier.ts` maps them onto the taxonomy(12 major / ~120 leaf), `replay.ts` re-runs the same

###  eval Tier-5 — A/B pairwise compare across CLI adapters (quanta/cursor/claude/aider)
Tier-5 of the 6-tier eval stack (umbrella id: `eval-five-tier`). The only tier that runs TWO agents on the same prompt and asks an LLM judge to pick a winner (`pairwise-judge.ts`). 4 CLI adapters share the `cli-base.ts` argv-pinning + SIGTERM→SIGKILL grace + stderr-tail truncat

###  QUANTA_HOME — cross-cutting app-home root override
Single env override that relocates every Quanta-owned persistent path — permission-state, bench corpus/artifacts, prefs fallback parent, and other feature-site path derivations. NOT owned by any one subsystem: permission- store, bench/corpus/paths, and runtime-config SSOT all c

###  agent — pure argv parser (mode-discriminated, env-free)
`parseAgentArgs(readonly string[])` — pure argv → typed `AgentArgs` discriminated by `mode` (`interactive | headless | batch | ci-bot | ide | daemon`). RFC may-22-unified-agent-runtime / Phase 4. Hard invariants: - NO I/O, NO `process.env` reads, NO silent defaults - Defaults

###  agent — unified AgentConfig assembler (12-lever wiring point)
SINGLE wiring point for `ModePolicy + BudgetMeter + BudgetCaps`. RFC may-22-unified-agent-runtime / Phase 4. Apps that want a unified surface (`apps/agent/index.ts`) call `assembleAgentConfig`; legacy entry points (`apps/cli/index.ts`, `apps/bench/index.ts`) can adopt incremental

###  agent SCC guard — Tarjan + module-top-level usage 차단 (deadlock 봉합)
`src/agent/*.ts` 의 value-level import cycle 은 의도적으로 허용 (cross-edge 값이 function-body 안에서만 평가됨). 그러나 누군가가 cycle-edge 의 imported symbol 을 module-top-level (동기, 함수 밖) 에서 호출하면 ESM circular init 의 TDZ deadloc

### 🆕 슬라이스 architecture invariants — biome (정적) + test (런타임) 이중 강제
4 신규 슬라이스 (@/runner, @/ipc, @/ui, @/auth) × 10 invariants = 20+ enforced guard. 정적 (biome.json `src/runner/**` + `src/ipc/**` override) + 런타임 (slice-boundary test) 의 이중 강제로 file:line + offending specifier 1-step 진단. 추가로 `agent-import-c

###  assembleConfig — per-turn AgentConfig composer (surface-agnostic)
Pure type-safe composer that turns already-built collaborators (`SessionDeps`: llm / registry / stream / permission / store / embedder / …) + message history into the immutable `AgentConfig` shape `runAgent` consumes. NO env / argv reads — every input is explicit. Naming is d

###  "@-mention autocomplete dropdown (CLI input)"
Typing `@` at a valid left-boundary opens a kind-grouped candidate dropdown (file / symbol / skill / plugin / app); ↑↓ select, Tab/Enter accept (splice the mention token), Esc dismiss. Activates quanta's EXISTING mention-injection backend (parser/resolver, already loop-wired 

###  bench — Best-of-N sampler (N trajectories × patchVote)
Pure module that runs N independent agent trajectories against a single bench instance and picks one — without leaking sampling concerns into the agent core (RFC §1.2: no closed-alphabet / orchestration creep). RFC §13 Q4 design decision: Best-of-N lives INSIDE `apps/bench`, 

###  Bench cache-shaped pathspec SSOT — patch-sanitizer prune-at-source
Single source of truth for build/cache-shaped path exclusions across the bench harness. The bench runner previously captured patches with `git diff --cached` and filtered TEST paths in `sourceOnlyDiff`, but build/cache pollution (`outputs/`, `__pycache__/`, `.claude/worktrees/`, 

###  Bench corpus loader — real SWE-bench vs synthetic layout detection
Adapter that turns a `QUANTA_SWEBENCH_CORPUS_ROOT` directory into an `Instance[]` for the bench runner. Detects TWO layouts and degrades gracefully on a third (offline / empty / invalid). 1. REAL `quanta-benchmark-corpus` (`tasks/repo/swebench/<id>.yaml` + `external/swebench/veri

###  bench — single-instance eval driver (sandbox + agent + verdict + diff)
Top-level orchestration for a SINGLE SWE-bench-style instance. The ONLY place that ties the eval sub-slice together: 1. Prepare an isolated sandbox `cp -R` copy of the instance repo (corpus is NEVER mutated — that invariant lives in `eval/sandbox.ts`) 2. Run the real agent (`ru

###  bench — per-instance env pre-preparation (fail-fast on setupCmd)
Per-instance env prep — the structural fix for Type-F (verify-loop stuck on env). When the instance carries `setupCmd`, run it INSIDE the sandbox copy BEFORE the agent. If setup exits non-zero, fail-fast with a DISTINCT `env_prep_failed` verdict and DO NOT run the agent — han

###  bench — decisive 2-axis failure classifier (termination × signals[])
Classifies an `InstanceResult` for the operator console + `bench-report .json`. Two-axis schema (covering + non-exclusive): - `termination` : EXACTLY ONE — HOW the run ended (success / fail / timeout / oom / sandbox_error / env_prep_failed / agent_error / budget_exhausted / …

###  bench — host-architecture detection + Docker image inventory
Host arch detection (`hostArch`) + Docker image warm-pool query (`images.ts`). Why: SWE-bench's upstream default namespace (`swebench`) pulls prebuilt x86_64 images. On Apple Silicon (arm64) those run under emulation — a tiny django test that takes ~2-3s natively measured ~20s 

###  bench — non-agent evidence emitter (sandbox / patch_generated / verify)
Bench is the producer of *non-agent* trajectory evidence: `sandbox` events, `patch_generated`, `verify` (pre/post-verify outcomes). The agent loop's `AgentEvent` stream is normalized by the stream-slice `JsonlRecorder` (RFC-0002 Wave B). The bench-specific kinds are NOT `AgentEve

###  bench — official Python SWE-bench harness verifier (real grader)
The documented swebench-seam, now real. Given a `swebench.verified` Instance and the unified diff the agent produced, writes an official predictions JSONL and invokes the upstream grader: python -m swebench.harness.run_evaluation \ --predictions_path <preds.jsonl> \ --run_id quan

###  Bench repair-round context — seed message + cumulative-diff truncation
Pure seed-message builder for the b2 repair-round orchestrator (RFC §16, ADR-0014). Given the running cumulative diff and the latest validator failure tail, produces the seed user message for the NEXT repair round. Output structure (in order): 1. `Repair round <round>.` 2. Origi

###  Built-in slash commands (10)


###  "Canvas rich DiffView (split + collapsible) + UsageBar legend (web)"
The rich web-canvas layer ADR-0440 (RFC-06) deferred: a side-by-side/split DiffView with collapsible hunks (06 was inline-only) + Swatch + CollapsibleSection primitives + a UsageBreakdownPanel (Swatch legend + per-category drilldown consuming ContextUsageBreakdown's color/chars).

###  agent — ci-bot mode preset policy (branch-only + no-MCP)
Bridges the data-only `MODE_PRESETS["ci-bot"]` into a runnable `AgentConfig`. RFC may-22 Phase 5. Concrete policy for the ci-bot surface (GitHub Actions / GitLab CI / similar batch-PR contexts): - toolSurface ⇒ ci-safe tool set = `defaultTools` (read/edit/grep/ bash/test_runner

### 🆕 CLI `/help` discovery — category grouping + env-var SSOT + virtual /image
기존 `cli-slash-help` 의 dynamic BUILTINS 인벤토리 위에 3개 P0 discovery 갭 봉합: (a) **/image virtual entry** — `prompt-source.ts` 에서 BUILTINS 진입 전에 intercept 되는 가상 명령. `runReplLoop` short-circuit `/exit`+ `/quit` 와 같은 패턴으로 `V

### 🆕 CLI lifecycle pills — subagent/follow-up/MCP 3-pill (conditional)
Top-line status-pills(`cli-status-pills`)과 직교한 3개 lifecycle pill: (1) `subagent` (활성 sub-agent 개수 + worker nickname), (2) `follow-up` (큐잉된 follow-up 메시지 개수 — Codex queued-follow-ups 패턴 흡수), (3) `mcp` (연결된 MCP 서버 + 도구 카�

###  /logout — destroy on-disk ChatGPT-OAuth token bundle
Slash command that destroys the ChatGPT-OAuth token bundle written by `/login --chatgpt`. Idempotent: when there is no token to begin with the rendered box still shows cleanly with a "not signed in" line and exits 0. Does NOT call any remote `/revoke` endpoint — Codex itself do

###  CLI `--resume` state machine — path-mode vs id-mode (ADR-0024 split)
`--resume <token>` 해석의 pure state machine — 실구현은 surface-agnostic Layer-2 슬라이스 `@/runner/orchestrate/resume-fsm` 으로 재배치됐고, `src/apps/cli/resume.ts` 는 기존 CLI importer(`internal.ts` 배럴 / `repl.ts` / 테스트) 호환을 위한 thin re

###  /retry-with — session-time model-swap slash command (ADR-0065 wire-up)
CLI surface that wires `resolveRetryModel` + `streamWithModel` (`src/llm/model-swap.ts`, ADR-0065) into a session-time slash command: /retry-with → escalate to the NEXT candidate after the current model in the configured ordered list. /retry-with <model-id> → request that spe

###  bun build --compile → dist/agent single binary
`bun run build` produces a single self-contained executable at `dist/agent` via `bun build --compile --minify src/apps/cli/index.ts`. This is the distribution path for the v3 CLI — no `bun` runtime required on the target machine. ADR-0045 (progress-audit system skill) explicitl

### 🆕 CLI `/help` unified menu — dynamic BUILTINS + keybinds + ENV knobs
`/help` 통합 메뉴 렌더러 — pure `renderHelp(BUILTINS)` 함수로 unit-testable. inventory 구성: (a) **dynamic** — `BUILTINS` 배열을 live 순회해 모든 slash command 자동 나열 (수동 동기화 없음; 새 명령 추가 시 자동 노출), (b) **static** —

### 🆕 CLI status-bar — DECSTBM scroll-region pinned bottom row
Vim-style fixed bottom status bar implemented via ANSI DECSTBM (`CSI <top>;<bottom>r`). The terminal's scroll region is constrained to rows `[1..N-1]` so the last row is reserved exclusively for the status line — it is never scrolled out by stdout / streamed LLM output. Repaint

### 🆕 CLI status-pills chrome — Mode/Workspace/Sandbox/Skills/Rules (5-pill)
CLI chrome top-line "pill" composer — 초기 4-pill (Mode / Workspace / Sandbox / Skills) → 5-pill (with Rules) 확장. 각 pill은 개별 OFF 가능 (`QUANTA_PILL_<NAME>=0`) + master OFF (`QUANTA_PILLS=0`); non-TTY 자동 OFF. status-bar transient(진행 메시지)와 통합

### 🆕 CLI turn-summary box — tools/verify-guard/compaction/memory/recovery
Turn-end "summary box" panel — 한 턴 종료 시 다음을 한 박스에 모아 출력: (1) tools row (도구 호출/결과 카운트 + 실패 카운트), (2) verify-guard row (verify-guard hit/miss), (3) compaction row (`context_compacted` 이벤트 카운트 + reclaimed byte

### 🆕 ColorPolicyResolver (per-surface ANSI color cache)
Encapsulates the ANSI color-policy cache so multiple surfaces (CLI, REPL, Tauri renderer, parallel test harness) can keep isolated state instead of sharing one module-level cell. Resolution order on first use: 1. Explicit override via `set(mode)` (test seam). 2. `NO_COLOR` env pr

###  "Turn-completion terminal notification (OSC title + bell)"
A closed-port NotificationPort + OSC-title/bell adapter: on turn completion (slow turns only — reuses the existing durationMs) and on idle-awaiting-input, write an `ESC]0;<title>BEL` terminal-title (+ optional bell), restoring a neutral title on teardown. TTY-gated (never to a 

###  Composition-root mega-wire — 11 subsystems, default-OFF (ADR-0236)
Wire 11 SOTA++ slices (ADR-0203/0211/0212/0213/0215/0218/0219/0224/0225/0226 + ADR-0203 inline-trigger watcher) into the agent composition root. Each lands as an OPTIONAL slot on AgentConfig (caller-side composition); only `focusChain` has agent-loop semantics (per-turn `tickTurn

###  "Pre-compaction context-usage warning banner"
A one-line warning surfaced near the prompt BEFORE auto-compaction fires, computed from the SAME retained token count the /context breakdown uses (no new heuristic) vs the compaction threshold (DEFAULT 120k). Forward-looking ratio at prompt time — deliberately does NOT reuse th

###  clampDials — propositional dial clamping with operator log
Pure function `clampDials(dials, caps, onClamp?)` — for each of 16 dial fields, returns `min(requested, cap)` when both present; emits a `[budget-cap]` warn log via `@/shared#logger` for every clamp event (silent clamping is forbidden by the run-mode contract). Defensive normal

### 🆕 /doctor startup self-diagnostic — pure check-registry over injected probes
`/doctor` is a read-only startup self-check that aggregates the scattered `/status` (auth), `/mcp` (servers), `runtimeConfig()` (config), terminal, and session-store health checks into one pass/warn/fail report with a per-failure remedy. It is the missing "왜 안 되지" first-t

###  .env loader — first-wins, no-override, `export ` strip, no-deps
Tiny no-dependency `.env` loader (`loadEnvFiles(files)`). Both CLI surfaces (`src/apps/cli/index.ts` and `src/apps/agent/index.ts`) invoke it with the same precedence chain — `[".env.dev", ".env.local", ".env"]` — at process start, BEFORE any module reads `process.env`. Three

###  eval Tier 4 — pairwise judge with bias-swap double pass
Tier 4 compare의 채점기 — 두 transcript + scenario rubric → ONE winner (또는 tie). BIAS MITIGATION (standard): judge를 두 번 호출 (forward + swapped) → swap 후 "A"가 "B"가 되어야 같은 winner가 inverse로 reported. 두 verdict가 inverse-consistent해야

###  eval Tier 3 — public bench bridge (SWE-bench Verified report → PublicPayload)
Tier 3는 의도적으로 THIN BRIDGE — `apps/bench/`의 기존 harness가 생산한 `bench-report.json`을 읽어서 eval store가 이해하는 `PublicPayload`로 번역. Bench CLI 로직을 duplicate하지 않고 (`bench/index.ts` 직접 import 안 함) 같은 dataset path를

###  eval storage — JSONL append-only ResultStore (per-runId serialisation)
Tier-agnostic JSONL store. 한 runId당 하나의 파일 (`<dir>/<runId>.jsonl`) — tier 간 isolation + 단순 diff. Schema validation은 `schema.ts`, aggregation은 `report/`에 두고 이 모듈은 I/O만 담당 (dependency-light). WRITE ATOMICITY (Phase B): 동일 runId에 �

###  eval Tier 1 — LLM-driven synthetic scenario generator (strict validation)
`bun run eval generate --usecase ID [--count N]` — 주어진 `UseCaseId`로 N개의 fully-formed `Scenario` JSON을 LLM으로 생성해 `scenarios/<usecase>/`에 저장. Hard constraints: schema 정확 일치 (parseScenario 통과), `usecase` 필드가 요청 id와 일치 (잘�

###  eval Tier 1 — LLM-as-judge (per-rubric pass/fail + weighted score)
Scenario rubric + 캡쳐된 transcript를 받아 judge LLM에 per-item pass/fail을 요청, weighted score(default weight=1) 계산. ERROR SURFACE CONTRACT (critical): `error:undefined` = judge ran (모든 rubric pass:false도 legitimate judgement), `error:defined` = INFRA failur

###  eval Tier 1 — Scenario JSON schema + tolerant loader/parser
Tier 1 합성 시나리오 schema (`scenarios/<usecase-id>/<scenario-id>.json`). Schema version 1, additive — 새 optional 필드 추가는 backward-compat, breaking change는 SCENARIO_SCHEMA_VERSION bump 필요. `Scenario` shape: `{ schema, id, usecase, title, prompt, files?, 

###  eval taxonomy classifier — query → UseCaseId (LLM, JSON-block tolerant)
Pure classification primitive `(LLMPort, query) → ClassifyResult`. System prompt가 모든 leaf id + label + 대표 example을 enumerate하고, 모델은 단일 JSON 객체 `{ id, confidence, alt? }`로 응답. `extractJsonObject`가 balanced brace로 첫 객체를 추출하므

###  eval taxonomy doc-sync — code → markdown one-way renderer
`TAXONOMY` 배열을 `docs/analysis/may-21-coding-agent-query-usecase.md` §1 포맷(major별 `중분류 | 소분류 | 트리거 | 커버 | 담당 | 검증` 테이블)으로 렌더. SINGLE DIRECTION: code → doc. Markdown을 손으로 편집하면 unit test가 drift를 못 잡�

###  eval taxonomy — 12 major / ~120 leaf use-case tree (single source of truth)
`docs/analysis/may-21-coding-agent-query-usecase.md` §1과 1:1 미러링된 in-code 분류 트리. ID 스킴은 `<major>.<mid>.<leaf>` kebab-case로 stable across releases — downstream store (Tier 1 fixtures, Tier 3 trajectory labels) 모두 이 id로 keying하므로 rename은

###  eval Tier 0 — static grep-mapper + curated rules + (major × CoverageLevel) matrix
Tier 0 정적 감사 내부 — 손-큐레이트된 grep 룰 테이블이 `UseCaseId` → 토큰을 매핑하고, `auditOne`이 rg(우선) 또는 portable BSD/GNU `grep -F -Z` 폴백으로 code/test/runbook roots를 스캔해 leaf 별 `AuditFinding`을 산출. 두 도구 모두 �

###  eval Tier 3 — structural projection diff (LCS over event kinds)
두 `TrajectoryEvent` 스트림을 PROJECTION 기반으로 비교 (raw equality 아님). 설계 결정 (each = contract): (1) PROJECTION over EQUALITY: timestamp/monotonic ns/span id/assistant token stream/llm usage 등 producer가 deterministic하게 pin 못 하는 필드를 str

###  eval Tier 3 — meta sidecar + JSONL session loader (no-heuristic policy)
Tier 3 trajectory 실측 데이터 I/O 레이어. `EvalMeta` 사이드카 (`<jsonl>.meta.json`)가 "어떤 prompt가 이 trajectory를 만들었나"의 권위 source — JSONL body에서 prompt를 inferring하는 heuristic은 의도적으로 거부 (assistant_text 델타에서 us

###  "External $EDITOR draft composition (ctrl-x ctrl-e)"
A ctrl-x ctrl-e chord (readline convention) suspends raw mode, opens the current draft in $EDITOR on a temp file, reads it back, and ALWAYS restores raw mode + re-attaches the keypress listener in a finally (the #1 risk — restore even on editor throw/nonzero-exit/spawn-fail/ctr

###  fc baseline ratchet — empty-stub / orphan-ADR 캡 + tsc/biome/test 측정 스냅
`tools/feature-catalog/baseline.json` 단일 SSOT 가 두 가지를 합쳐 저장: (1) `fc` 하위 ratchet — empty stubs HARD cap (`empty_stubs_max`) + grandfathered orphan ADR allowlist (`orphan_adrs_grandfathered`) — 그래서 `bun fc lint` 가 audit 의 현재 count 와 �

###  fc check-changed — PR-time gate (new src/*.ts 는 fc evidence 등록 필수)
`bun fc check-changed <base-ref>` — PR diff 를 git name-status 로 읽어 ADDED 된 `src/**/*.ts` 파일이 어떤 fc YAML 의 `evidence.code` 에도 등장 하지 않으면 fail. Modified 파일은 정보용 경고만(BLOCK 안 함) — 헬퍼는 부모 feature 와 같이 변

###  fc prose bundles — intro + non-absorption 정책 MD 가 catalog 빌드 시 blend
Rendered `docs/10.feature-catalog.md` 의 두 가지 비-YAML 섹션 — (a) intro/머리말 (성숙도 5단계 척도, RFC/ADR refs, slice-isolation 원칙), (b) trailer 정책 노트 (Codex 의도적 미흡수 — heartbeat/plugin bundle/cassette validator 등, ADR-0015~0023 �

###  feature-catalog tool — `bun fc` CLI (build / validate / list / audit / lint)
Feature catalog의 단일 진실 원천 (SSOT) 도구. 모든 feature는 `tools/feature-catalog/features/<section>/*.yaml` 한 파일로 표현되고, `bun fc build`가 zod 스키마 검증 + 교차참조 + prose + baseline 메트릭을 합쳐 `docs/10.feature-catalog.md`를 결�

###  ImageQueue — single-shot per-turn multi-modal image attachment
REPL surface가 소유하는 in-memory FIFO. 사용자가 `/image add <path>` 슬래시로 `ImageBlock` (base64 + mediaType, `loadImageBlock`이 검증한)을 큐에 enqueue, 다음 user turn의 `PromptSource.next()` 가 `drain()` 으로 atomic snapshot+clear → 이 turn에만 �

###  `/inspect <toolCallId>` — 세션 JSONL projection + 확장 패널 (input/decision/result/recovery) (ADR-0239 Track I)
Phase 1 debug-tracer는 *live stream*만 stderr로 흘리고 ring buffer 같은 것이 없어서 `/debug` 켜기 전에 fire한 event는 retroactive 못 봄 (Codex / Cursor와 같은 posture). 그런데 사용자가 진짜 자주 묻는 질문은 "방금 그 도구 호출 hits에

###  "User-customizable keybinding config layer"
Loads ~/.quanta/keybindings.json (same dir as knobs.json), merges over a default key→action map (closed 14-action enum), and remaps keys in the raw-line-reader keypress handler. Reuses the knobs fail-safe (malformed/version-bad ⇒ defaults + warning, never crash) + the __proto

###  "shift+tab permission/agent mode-cycle + input pill"
shift+tab (a.k.a. backtab / CSI Z) cycles a single user-facing 4-rung posture (default → acceptEdits → plan → bypass), collapsing the two orthogonal axes (PermissionMode + AgentMode) onto one slot — NO invented mode. A bold colored pill renders both in the input meta row 

###  narrowMode + assertModeMatrix — 48-cell defense-in-depth
Compile-time + runtime defense against cast-corrupted ModePolicy values. `narrowMode<M>(mode, policy)` is a TS assertion function — after the call `policy` is typed as `ModePolicy & { mode: M }` so subsequent code can rely on the matrix column for that mode (e.g. batch + review

###  tools/pm — executable Definition of Done (catalog + TDD + e2e-hellgate gate)
tools/pm is the EXECUTABLE Definition of Done — the process home that makes one rule impossible to forget: a feature is "done" only when ALL THREE ship together (1) catalog entry with real evidence (≥1 code path AND ≥1 ADR), (2) ≥1 unit test under evidence.tests.unit, (3)

###  probe — NON-authoritative failure triage (ordered rule-table hypothesis)
Reads a `TrajectoryEvent[]` and returns a HYPOTHESIS describing the likely failure class: { likely_failure_class: string, confidence: number, // hedged — capped well below 1.0 hint: string, // one-line, hedged language evidence: string[] // raw excerpts for human review } Imple

###  probe — fault-localization 3-stage funnel adherence checker
NON-authoritative analyzer that scores a trajectory's adherence to the `localize-fault` skill's 3-stage funnel: Stage 1 FILE → localize / grep / glob / file_tree_summary / git_churn Stage 2 FUNCTION → read / lsp_document_symbol / lsp_hover Stage 3 EDIT-LOCATION → lsp_refere

###  probe — plain-text renderers (`--failed` / `--slow` / `--cost` / `--json`)
Pure renderers — events in, strings out. No color, no I/O (RFC-0002 §7 Phase 1 = plain text, no TUI per RFC §14). Multiple views from the same source: - default : ordered event timeline (compact) - `--failed` : only events leading to failed instances - `--slow` : per-instance

###  probe — trajectory JSONL + run-dir loader (forward-compat, never throws)
Pure deterministic loader for the trajectory JSONL + bench run-dir conventions. Trajectory JSONL is the single source of truth (RFC §3 원칙1); probe is READ-ONLY (RFC §1.2 / §3 원칙8). The loader: - NEVER mutates inputs / writes files / throws on malformed JSON - Unparseab

### 🆕 Prompt-suggestion + quality reject-gate (ADR-0467)
Suggests what the user might naturally type next. The crown jewel is the PURE reject gate (`rejectGate`, `src/agent/prompt-suggestion/reject-gate.ts`) — a closed `RejectReason` enum where each member is one named predicate, evaluated in declaration order, first-match-wins. Abso

###  `quanta session` subcommand suite — 10 lifecycle operations
`quanta session …` subcommand dispatcher — 세션 라이프사이클의 모든 mutating / read-only 연산을 한 surface에 모음. 10 subcommand: ls / show / rename / archive / unarchive / fork / rewind / delete / path / import. Fork는 `createPersistentWorktree` 로 git wo

### 🆕 RefreshCoordinator (ChatGPT-OAuth thundering-herd guard)
Coordinates concurrent refresh_token exchanges so multiple callers sharing the same (issuer, clientId, refresh_token) tuple await one in-flight Promise instead of racing two requests at the issuer (Codex doesn't guard this — we do). Extracted from a module-level Map into a name

### 🆕 REPL code-smell cleanup — STATUS_FLASH config + string drift + silent-catch telemetry
Closes 7 audit findings on `src/apps/cli/repl.ts` without splitting the larger God-class: (1) `ESC_WINDOW_MS = 2000` was the only un-env-backed timing constant — replaced with `flash.escWindowMs` driven by `QUANTA_ESC_WINDOW_MS`. (2) 5 magic UX flash durations (4000 ×3, 3000, 

### 🆕 REPL CLI heuristics inventory — DOC/ENV/ARBITRARY audit
Audit of every NUMERIC LITERAL ≥ 3 digits across src/apps/cli/*.ts in service of the user MEMORY rule "no-heuristics-only-validated" (임의 휴리스틱/임계값 제안 금지). Each literal is classified as: - DOC-BACKED — referenced by an ADR / SOTA absorption note / modu

### 🆕 Interactive REPL (continuous conversation + in-REPL slash routing)
`quanta` (인자 없는) 호출 시 진입하는 readline 기반 인터랙티브 REPL — 연속 대화, per-turn agent run, /skills / /reload-skills / /retry-with / /login / /status 등 슬래시 명령 in-REPL 라우팅 (Codex parity). 매 턴: 사용자 입력 → 이미지 �

###  REPL `/mcp` surface translator (live CLI state → structural snapshot)
Sub-feature of `cli-repl-solid-split` umbrella — separately catalogued because this module is the ONLY translator between live CLI MCP wiring (`McpServerConfig[]` + bridged `Tool[]` + live `McpClient[]`) and the structural `McpSurfaceInfo` snapshot consumed by the `/mcp` slash 

###  CLI repl/ orphan modules — Slice B truth-up & prune
Closeout of the 21-module orphan tree under `src/apps/cli/repl/` created by commit `acb8d187` (2026-05-24 "split GodClass into SOLID modules v2, byte-identical"). Verified by grep: zero importers in src/ or tests/ for any `./repl/*` path other than `mcp-surface-wire.ts`. `src/app

###  REPL `PromptSource` adapter — slash short-circuit + raw-line reader
Sub-feature of `cli-repl-solid-split` umbrella — separately catalogued because this module implements the `runner.PromptSource` port for the CLI surface and is the in-REPL slash-command short-circuit point that gives `quanta` its Codex `forceReloadSkills` parity for `/skills` /

###  `/replay <session-id> [--at N] [--from tc_x]` — 세션 JSONL 시간순 재생 (ADR-0239 Track R)
`/inspect`는 단일 tool-call에 대한 사후 zoom이고 `/debug`는 *live stream* 이라 retroactive하게는 못 봄 (ring buffer 없음). 사용자가 자주 묻는 또 다른 질문 — "어제 그 세션, 전체적으로 어떻게 흘러갔어? Turn N부터 뭐가 일어�

###  Repro-test pipeline — Agentless §3.3.1 generate / execute / select
Agentless paper §3.3.1 absorption: drive the LLM K times to synthesise self-contained Python repro scripts that print one of three sentinels (`Issue reproduced` / `Issue resolved` / `Other issues`), execute each candidate against the ORIGINAL repo (pre-patch) via a `ReproExecPor

### 🆕 runner/session-ops — surface-agnostic `quanta session …` dispatcher
`quanta session <subcommand>` 의 dispatcher 를 surface-agnostic 슬라이스로 격리. 8 개 서브커맨드 (`list` / `show` / `delete` / `rename` / `archive` / `unarchive` / `fork` / `import`) 를 단일 진입점 `runSessionCommand(argv, deps)` 으로 분기. argv 가 `sess

###  Session `index.jsonl` directory — atomic upsert + in-process mutex
`index.jsonl` 는 세션의 lightweight 디렉토리 — 라인당 1 JSON SessionMeta(세션 id / 생성 시각 / 라벨 등). 매 upsert 마다 전체 파일 재기록(per-writer tmp + atomic rename). 파일이 작아(수백 세션도 수 KB) append-then-dedupe 복잡성 회피.

###  SessionRootProvider port — multi-tenant session-root abstraction
Inverts the legacy process-wide `sessionsRoot()` resolver so multi-tenant surfaces (Web / Tauri daemon) can supply per-tenant rooting strategies without cross-user data leak. Interface `{ resolve(): Promise<string> }` injected through the session slice's `*Async` overloads. CLI d

###  Shadow-ODB per-workspace LRU eviction (best-effort, scope-fenced)
Bounded-disk policy for the shadow git ODB (ADR-0108). Sums the on-disk size of each per-workspace shadow directory under `<base>/snapshots/<workspaceHash>/` and, while the total exceeds `maxBytes`, removes the oldest one (by directory `mtimeMs`) until the cumulative size is at o

### 🆕 /branches — speculative N-best branch-search progress
Live progress visualization for catalog 대6 speculative branch search (ADR-0084 / Agentless N-best verifier-prover). Without a sticky indicator the user sees dead air during the multi-second parallel candidate loop and a single eventual `winner` line. This module reads the TYPED

### 🆕 /cost — cumulative session cost panel
Sticky cumulative session-spend dashboard surfaced via `/cost` — Claude SOTA inspired (Claude Code's `costPanel` 누적 spend ticker). Complements the existing per-turn `renderTurnDashboard` (fresh snapshot at each turn end) by aggregating input/output/cache-read tokens + USD a

### 🆕 /history — recent turns + tool-call breadcrumb
Compact scannable summary of the live session so the operator can answer "what did I just do?" without scrolling. Four subcommands: `/history` (last N turns, one line each with a `✓✓✗` per-turn tool-status microbar); `/history tools` (last N tool calls with per-call OK/FAIL

### 🆕 /mcp — MCP server + bridged-tool explorer
Read-only MCP runtime explorer. Four subcommands: `/mcp` (list servers + tool count + status), `/mcp tools` (every bridged tool across all servers), `/mcp tools <name>` (tools belonging to one server), `/mcp config` (current config file path + raw contents). The CLI is the only p

### 🆕 /memory — browse / recall / search / delete durable memory
Browse / recall / delete the durable memory store from the REPL. Subcommand- style surface: `/memory` (recent 10 by recency), `/memory list [--tier=…]` (capped at `QUANTA_MEMORY_LIST_MAX` default 20; `--tier=episodic|semantic` filters), `/memory search <query>` (semantic + lexi

### 🆕 /permission — Codex 5-axis permission stack inspector
Codex 5-axis post-denial precedence stack inspector. Sub-commands: `/permission` (short summary — mode + tier counts + 5-axis legend), `/permission explain <tool>` (full 5-axis pipeline for one tool), `/permission list` (table of all built-in tools — name + tier + read-only),

### 🆕 /plan — read-only plan-store visualization
Codex + Claude plan-mode TUI panel — renders the live `Plan` (via `PlanStore.current` snapshot) as a compact boxed panel: ordered todo list with status glyphs, current-step pointer, and progress header `Plan (N of M done)`. 100% READ-ONLY — this surface NEVER invokes a `PlanS

### 🆕 /queue per-msg manage (ADR-0228 — Codex composer parity)
Codex Desktop composer parity: each queued follow-up gets 4 per-msg mutators (retry / edit / delete / sendNow) over a `/queue` slash. ADR-0128 absorbed the structural queue + ADR-0037 the pause-reason vocabulary; this slice closes the operator-management gap. `sendNow` is the dis

### 🆕 /rules + rule-pill — repo-local rule inventory indicator
Codex `repo-local-rule-ingestion-audit.md` (AGENTS.md pattern) inspired surface for the CLI: surfaces the COUNT + IDENTITY of repo-local rule files loaded / matched for the current session (AGENTS.md, CLAUDE.md, file-scoped `.cursor/rules/*.mdc` + `.quanta/rules/*.md`). Without t

### 🆕 /snapshot — Shadow-ODB snapshot list / rewind / partial restore
CLI surface over the `ShadowOdb` port + the three `shadow_*` tools (ADR-0122, Hermes Agent `/rollback` parity). Lets the operator browse, preview, and restore workspace snapshots without round-tripping through the model. Sub-commands: - `/snapshot` — list snapshots newest-first

### 🆕 /web + /paste + /edit-plan + /edit-message (ADR-0224/0225)
Four-slash absorption batch. /web <url> + /paste deliver out-of-band content (URL fetch / clipboard) through a single-shot TextInbox the next user turn prepends. /edit-plan + /edit-message open the current plan / pending composer in $EDITOR (vi/nano/code) for mid-execution edits 

### 🆕 /state — WorkingState L3 scratchpad visualization
Surface-only renderer for catalog 대5 L4 `WorkingState` — the per-session L3 scratchpad (owner shortlist, hypothesis, blockers, next steps, deferred validation) the model mutates via `update_working_state`. The MODEL sees this block verbatim through `renderWorkingStateBlock` i

### 🆕 SlashContext R10 ports — 5 default-OFF surface seams
R10 extends the `SlashContext` interface in `src/apps/cli/slash-commands.ts` with FIVE optional surface ports — one per R10 panel that needs live session data: `cost: () => string | undefined` (R10 F cost-panel render seam), `planSnapshot: () => Plan | null` (R10 G plan-store a

### 🆕 SlashContext 6-port wire-up (S3 deferred-wire closeout)
Closes the Tier-2 SlashContext deferred-wire gap by threading 5 of the 6 R10 surface ports from the REPL composer (`runRepl`) onto the live `slashCtx`, so the corresponding slash commands render their real bodies instead of the placeholder "not wired in this surface" line. Ports 

### 🆕 '`@/auth/chatgpt-oauth` 슬라이스 — PKCE + JWT + token-store + refresh + callback port'
`src/auth/chatgpt-oauth/` 8 파일 — ChatGPT OAuth provider seam (ADR-0094 Phase 1). ChatGPT 구독 자격으로 모델 호출하는 토대. 컴포넌트: `pkce.ts` (S256 challenge/verifier 생성) + `jwt.ts` (ES256/RS256 verify + claims) + `browser-flow.ts` (loopback callback 

###  '`@/ipc` 슬라이스 — CLI ↔ Web ↔ Tauri EventBridge + portable session'
`src/ipc/` — Claude A11 deep-dive 흡수 (importCliSession + logCliEvent pattern). 두 컨트랙트: (1) `EventBridge` — typed `BridgePayload` 위 publish/subscribe + loopback 로컬 배달 + transport-agnostic wire encoding. (2) `BridgeTransport` — 저수준 byte shuttle, 

### 🆕 '`@/runner` 슬라이스 — surface-agnostic Layer-2 오케스트레이션'
`src/runner/` 슬라이스 — CLI/Web/Tauri/Codex/Claude 어느 표면에서도 동일하게 호출 가능한 Layer-2 오케스트레이션 모듈. 3 sub-slice 배럴: `assemble/` (8 builder: llm/store/memory/ subagent/skill/compaction/verify/tooling/streaming/config) + `orchest

### 🆕 '`@/ui` 슬라이스 — surface-agnostic ANSI/box helpers (former auth-ui)'
`src/ui/ui-helpers.ts` (구 `auth-ui.ts` 에서 이관 + 슬라이스화) — 순수 string/ANSI/ box-drawing primitives. 어떤 표면 (CLI / REPL / 임베디드 browser / Tauri renderer) 도 composition 가능. 본 슬라이스는 I/O 미수행 — 호출자가 렌더된 문자

### 🆕 /snapshot — shadow-store snapshot/restore/diff slash command (ADR-0122)
ShadowOdb 포트 + 3개 `shadow_*` 도구를 CLI에 surface하여 사용자가 모델을 거치지 않고 워크스페이스 스냅샷을 browse/preview/restore 할 수 있게 하는 슬래시 커맨드. 서브커맨드: `/snapshot` (newest-first 리스트, sha+ISO ts) / `/snapsh

###  SWE-bench A/B matrix runner — 3-axis 2^3 condition sweep (LSP × subagent × skills)
`bun run tools/swebench-matrix.ts` — SWE-bench-shape 데이터셋(기본 `tests/smoke/swebench/picks.jsonl`)을 3축 ON/OFF 조건 매트릭스로 sweep 하여 per-condition pass@1 / 평균 토큰 / 턴 / wall / cost 를 산출하는 실험 러너. 축: LSP (`QUANTA_BENCH_LSP`)

###  tools/bin/swebench-python — uvx ephemeral python shim
Thin shell shim that satisfies the bench harness's `QUANTA_SWEBENCH_PYTHON_BIN` contract without polluting the user's base python. Runs: uvx --from swebench --python 3.11 --quiet python "$@" so the official swebench grader (per `bench-python-swebench`) gets an ephemeral, uvx-cach

### 🆕 Thin-surface increment — turn-driver hoist + cli→agent launcher relocation
Later §3.1 thin-surface increment (jun-04, commit 00f0bfb6) on top of the ADR-0303 ratchet: relocate reusable runtime + launcher semantics BELOW `src/apps/**` so the surfaces stay thin and no surface reaches sideways into a sibling surface. Three relocations: 1. turn-driver HOIS

###  split-screen live AgentEvent timeline panel (`QUANTA_TIMELINE=N`) (ADR-0239 Track T)
ADR-0239 debug-tracer가 stderr에 단일-line per-event를 dump하는 방식은 scrollback에 묻혀버려서 high-rate session에서 한눈에 trajectory를 보기 어려움. Cursor / Claude Desktop의 chat-inline collapsible panel과 달리 CLI의 풀-screen 점유는 곤란 �

###  withWorktree — throwaway git worktree HOF + transient-lock retry
Runtime HOF that runs `fn` inside a throwaway git worktree at `<repoRoot>/.claude/worktrees/agent-<id>` on branch `worktree-<id>` and cleans up by policy: - body resolves, no diff + no untracked → worktree + branch REMOVED (clean run, nothing worth keeping); `info.removed = tru

###  Persistent worktree primitive — createPersistentWorktree / removeWorktree
Persistent (NOT auto-removed) git worktree primitive used by top-level conversation fork. Creates `<repoRoot>/.quanta/worktrees/<safeId>` on branch `fork-<safeId>` (overridable). Distinct from `withWorktree` which is the scoped + auto-clean variant — the persistent flavor lets 

