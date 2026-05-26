# 코딩 에이전트 4-way 기능 합집합 비교

**Cursor 3.2.16 / Codex Desktop build 2867 (codex-rs 0.131.0-α9) / Claude Desktop 1.7196.3 + Claude Code 2.1.138 / quanta-codeagent-v3**

> **검증 상태: Draft v15 (15 wave 누적 823+ 신발견 / 25 카테고리 A~Y / ~418 row · ★ quanta GitHub trunk 발굴)**
>
> - **v0**: 메모리 + ADR + `.extracted_source/` 카탈로그 초벌
> - **v1**: 4 agent spot-check — 19/20 hit (95% accuracy)
> - **v2**: 4 agent 깊이 매핑 — file:line 보강
> - **v3**: 4 agent 합집합 확장 — 13 row · ★ quanta ADR-0132/0133 발견
> - **v4**: 4 agent 꼼꼼 audit — 333 cell / tengu_ 1155→2053 정정
> - **v5**: 3 agent wave 2 (64 신발견) + **S/T/U 신규** (+39 row)
> - **v6**: 4 agent wave 3 (80 신발견) + 9 row + Hook 14→22 / ADR-0021·0082·0008
> - **v7**: 3 agent wave 4 (74 신발견) + 12 row + 3 count 정정 (CLAUDE_CODE_* 10→243 / ANTHROPIC_* 22→48 / endpoints 10→36)
> - **v8**: 4 agent wave 5 (86 신발견) + 18 row + UnifiedMode 6-mode + bestOfNDefaultModels verbatim + ComposerCheckpointService + Skybridge CSP triple + 131 codex_* (잘못 카운트)
> - **v9**: 4 agent wave 6 (88 신발견) + 16 row + 4 정정 (codex_* 131→42 manifest, CLAUDE_CODE_* 281, ANTHROPIC_* 42, /api 8+6)
> - **v10** (#10, ★ 자율주행 완료): 4 agent wave 7 (Cursor 18 + Codex 22 + Claude 17 + Cross-vendor 17 = **74 신발견**) + **V/W 신규 카테고리** (자율 Orchestration + Telemetry Exhaustiveness, +17 row) + count 정정 (**CLAUDE_CODE_* 281→372** / **tengu_* 1150→1649**) + Cursor Grind 2-phase planning+execution + cursor_prediction feedback loop + Discovery Budget effort enum + Codex Excel 49 function verbatim + Pet Spritesheet 6-persona + 2.096B log row production scale + Claude PLAN_V2 multi-agent + tengu_auto_ 78 subgroup + SecureCredentialFileDescriptor 3-mode + cross-vendor 17 비교 관찰
> - **카테고리: 21 → 23 (+V/W)**, **row: 331 → ~349**
> - 누적: 10 wave · **586+ 신발견** · 211+ row 정정/보강 · 11 count 정정 (5점/4점 333개 + 신규 233+ row)
> - 중간 점수 정성 ~25% 여전히 휴리스틱.
> - 경쟁사 코드 경로: `.extracted_source/{cursor,codex,claude,claude-code-cli,codex-cli,userdata}/`. minified bundle line drift → 분기별 재추출 권장.

---

## Legend

- **점수 0~5**: 5=production-grade·깊이, 4=견고한 1차 구현, 3=기본 동작, 2=부분/실험, 1=stub, 0=없음. **N/A**=적용 불가.
- **Source 컬럼**: 가장 강한 단일 증거. quanta는 `ADR-####` 또는 `src/<path>`. 경쟁사는 `.extracted_source/...`의 상대경로(`extr/`로 줄임). 메모리에만 있고 ADR 파일명 미확인은 `ADR# pending`.
- **기깔난 포인트**: 그 기능에서 가장 비명백한 디자인 결정 한 줄.

---

## A. 에이전트 루프 / 턴 제어

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| Mid-turn steering (response items inject) | 4 | **5** | 3 | 3 | Cdx: `codex-rs/core-skills/src/injection.rs` · qta: ADR-0030 + steering.ts | Codex는 `expectedTurnId` optimistic concurrency로 turn boundary 안 끊고 inject |
| **Turn 6-API verbatim** [v6 신발견] | 3 | **5** | 3 | 3 | Cdx: `extr/codex/.../app-server-manager-signals-BEaGjuc8.js:L8-19` (turn/{start,interrupt,diff/updated,plan/updated,completed,started}) | 6 turn op + 5 thread-follower message = 11 RPC verb |
| **Thread-Follower 5 message types** [v6 신발견] | 3 | **5** | 3 | 3 | Cdx: `app-server-manager-signals-*.js` (thread-follower-{submit-user-input,command-approval-decision,file-approval-decision,interrupt-turn,compact-thread}) | remote control primitives — agent를 외부에서 조작하는 5 verb |
| **Submission op 11-variant verbatim** [v7 신발견] | 3 | **5** | 3 | 4 | Cdx: `extr/codex-cli/_cli-symbols.txt` (user_input/user_turn/user_input_with_turn_context/reload_user_config/shutdown/interrupt + new/forked/resumed/no_active_turn/standalone_turn) | 메모리 6-variant 정정 → **11 verified** (5 infrastructure variant 추가) |
| **Realtime Conversation Stack (WebRTC SDP)** [v7 신발견] | 0 | **5** | 0 | 4 | Cdx: `codex-rs/core/src/{realtime_conversation,realtime_context}.rs` + ThreadRealtime{Start,AudioChunk,AppendAudio,AppendText,Stop,ListVoices,Sdp}* 8 method · qta: ADR-0208 | WebRTC SDP negotiation + audio chunked streaming via wss://chatgpt.com/backend-api/ |
| **RTC SDP 7-stage state machine + ICE candidates** [v13 신발견] | 0 | **5** | 0 | 3 | Cdx: ThreadRealtimeStart 38refs / ThreadRealtimeSdp 9refs / ThreadRealtimeStartedNotification + `WebRTC-ExtraICEPing` + `last_ping_sent` tracking + "SDP munging: audio codecs added/removed" | ICE candidate marshaling + 7-stage WebRTC lifecycle — VAD client/server split (PCM 입력 + server VAD) |
| **Voice mute = out-of-band text injection** [v13 신발견] | 0 | **5** | 0 | 0 | Cdx: "Update mute (voice processing)" + "unmuting vp for restart/stop-recording" + `ThreadRealtimeAppendText` injection path | session 안 끊고 modality 전환 — voice→text 우회 |
| **Realtime conversation event 5-stream** [v7 신발견] | 0 | **5** | 0 | 3 | Cdx: `realtime_conversation_{started,audio,text,sdp,closed}` events | session lifecycle 5-state stream — UI sync 직접 |
| NonSteerableTurnKind enum (review/compact/standalone) | 0 | **5** | 2 | 2 | Cdx: codex-rs core | "turn에 type이 박힘" — steer 가능 여부가 contract |
| Cancel (incl. cancel_subagent) | **5** | 4 | 4 | 4 | Csr: agent-exec `ConversationAction.cancel_subagent` · qta: ADR-0071 steering.ts | Cursor만 서브에이전트 단위 typed cancel (부모턴 유지) |
| Queued follow-up (with pausedReason) | 4 | 4 | 3 | **5** | Cdx: `extr/userdata/codex/.codex-global-state.json` (queued-follow-ups[threadId]) · qta: `src/agent/follow-up-queue.ts:128` (FollowUpQueueSnapshot) | quanta는 `threadId→FollowUp[]+pausedReason` superset — Codex 12-field+Cursor flat의 합 |
| Side-conversation thread | 3 | **5** | 4 | 3 | Cdx: telemetry key `codex.thread.side` | Codex만 별개 sub-thread를 telemetry로 1급 표면화 |
| `response.in_progress` 이벤트 | 4 | 3 | 4 | 3 | Cdx WS 12-kind | Codex 자신은 이걸 미처리(forward-compat gap) |
| Agent message phase (commentary vs final) | 2 | **5** | 3 | 4 | Cdx sessions JSONL `agent_message.phase` · qta: ADR-0221 phase-guard | "commentary" 단계는 git directive 거부 — 최종답변에서만 허용 |
| Edit-last-user-turn (savepoint rollback) | 4 | **5** | 3 | 3 | Cdx: `trunk_new`/`trunk_reused` telemetry | SQL savepoint 기반 — 임의 turn 아닌 마지막 user turn에만 |
| Fork session (lineage) | 4 | 4 | 4 | 4 | qta: ADR-0201/0199 fork-session + `cloneSnapshot`/`lineageOf` | Cursor `SubagentPersistedState`가 fork 없는 superset |
| Resume-by-ID + portable transcript | **5** | 4 | 4 | 4 | Csr: `~/.cursor/projects/<p>/agent-transcripts/<uuid>/<uuid>.jsonl` | IDE/CLI/SDK 같은 transcript 공유 → surface-portable |
| Continue from checkpoint | 4 | 4 | 4 | 4 | qta: `continue_from` (subagent-sota-hardening) | |
| Stream HOL barrier + ordering 보장 | 2 | 3 | 3 | **5** | qta: src/agent/loop.ts (HOL 강제) | quanta 단독 hard ordering — Cursor는 streaming 클라 시각 |
| **Streaming dispatch overlap (safe sibling in-flight)** [v13 신발견 ADR] | 3 | 3 | 3 | **5** | qta: **ADR-0059 streaming-dispatch-overlap** | HOL barrier가 unsafe call gate + safe sibling은 stream emission 중 in-flight dispatch + Promise.allSettled로 in-order 수집 |
| **Per-turn mutable authority (single owner)** [v13 신발견 ADR] | 0 | 0 | 0 | **5** | qta: **ADR-0061 per-turn-mutable-authority** | turn-by-turn 변하는 state는 단일 authoritative owner — mirror는 projection만 허용, dual source 금지 |
| **Caller-side wrapper seam (instrumentation BEFORE loop)** [v13 신발견 ADR] | 0 | 0 | 0 | **5** | qta: **ADR-0067 caller-side-wrapper-seam** | feature instrumentation은 registry consume BEFORE engine loop — dispatch 안에 안 들어감 (no-throw cadence 보존) |
| Stream idle timeout | 4 | 3 | 4 | **5** | qta: ADR-0200 + src/llm/stream-timeout/ | `Promise.race(it.next, idleTimeout)` + snooze + AbortSignal — loop.ts 1줄 wire |
| Spinner stall detection (30s) | 3 | 3 | **5** | **5** | Cld: `extr/claude-code-cli/_cli-symbols.txt:L108092+` (tengu_spinner_stalled_ui + 70+ tengu_* family) · qta: ADR-0227 + `src/llm/spinner-stall/index.ts:16` (createDefaultStallDetector) | Claude 흡수 + 3중 default-OFF 레이어로 |
| Auto-compact multi-trigger (5-axis) | 3 | **5** | 3 | 4 | Cdx: `compact.rs`/`compact_remote.rs`/`compact_remote_v2.rs` | `auto-compact-` turn ID prefix · `context_limit\|model_downshift\|manual\|memento\|prefix_compaction` |
| Compaction sliding-window archive | 4 | 3 | 4 | 4 | Csr: `ConversationSummaryArchive` `self_summary_count` | Cursor: out-of-band, transcript에 마커 0 |
| PreCompact HITL hook | 4 | 3 | 4 | 4 | Csr: `PreCompactRequestQuery` (context_usage_percent/messages_to_compact/is_first_compaction) | first-compaction이면 warm-up 다르게 |
| Reflect / replan gate | 4 | 3 | 2 | 4 | Csr: AiBranchService `OpusChainReflect` (extr/cursor/.../extensionHostWorkerMain.js) · qta: ADR-0089 lint-grounded-reflect | typed Decision oneof `{accept\|retry_without_more_info\|retry_with_codebase_question}` |
| Plan mode (enabled-tools allowlist) | **5** | 4 | 4 | 4 | Csr: agent-exec EnabledTools selector · qta: ADR-0088 phasegate-hitl-ladder | "인터셉터 아닌 선언적 게이팅" — 도구 enum subset만 expose |
| Plan-exit N-phase ladder | 3 | 3 | 2 | 4 | qta: ADR-0088 phasegate-hitl-ladder | AiProjectService 8-RPC를 일반화 |
| Mode-typed delegation (5-mode closed) | 4 | 4 | 3 | 4 | qta: ADR-0218 subagent-mode-typed-delegation | 4-vendor 강신호(Roo/Devin/Codex/Cursor) 수렴 |
| Focus-chain reinject (N-turn todo) | 4 | 2 | 2 | 4 | qta: ADR-0219 focus-chain-auto-reinject (Cline 원천) | 6턴 reinject + 5턴 drift detector |
| Multi-correlation 격리 | 2 | 3 | 3 | **5** | qta: ADR-0227 spinner-stall 안에 round-robin invariant | |

## B. 도구 카탈로그

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| 도구 수 (실측 baked-in) | **52** | 18 | 20 | ~25 | Csr: agent-exec proto 340+ wire-level / 52 baked + Cmd-K | Cursor가 wire-level이 더 풍부, "model-facing 51"은 일부 |
| Read file (sparse chunk / line elision) | **5** | 4 | 4 | 4 | Csr: `SparseFileChunk` (extr/cursor/extensions/cursor-agent-exec) | 라인 elision으로 큰 파일을 outline+focus로 |
| Edit (apply_patch V4A + `*** Move to:`) | 3 | **5** | 4 | 4 | Cdx: `codex-rs/apply_patch/` + diffy crate · qta: ADR-0028 | `Move to:` = rename + edit atomic. AST 아닌 fuzzy match |
| Edit (fast-apply streamed full-content) | **5** | 0 | 0 | 0 | Csr: AiService.StreamFastEdit · 25 FastApplyModelType | 서버모델 종속(흡수 불가) — quanta는 search_replace 유지 |
| **3-phase warming (PreloadEdit→WarmApply→StreamFastEdit)** [v7 신발견] | **5** | 0 | 0 | 0 | Csr: `extensionHostProcess.js:L158715` PreloadEdit → `:L143669-L143721` WarmApply → `:L158457-L158532` StreamFastEdit | sub-100ms latency 위한 3중 pre-warming — composer cache + edit cache 다 데움 |
| **UnifiedMode 6-mode enum** [v8 신발견] | **5** | 0 | 0 | 0 | Csr: `workbench.desktop.main.js:L845457` (UNSPECIFIED/CHAT/AGENT/EDIT/CUSTOM/PLAN/DEBUG) + `getComposerUnifiedMode()` L972700-L972721 | 단일 unified chat protocol이 6 distinct LLM execution context 디스패치 — `StreamUnifiedChatRequest`로 통합 |
| **ThinkingLevel 3-tier** [v8 신발견] | **5** | 0 | 4 | 0 | Csr: `workbench.desktop.main.js:L150461` (UNSPECIFIED/MEDIUM/HIGH) within StreamUnifiedChatRequest | UnifiedMode와 짝 — 모드별 reasoning intensity 별도 dial |
| **bestOfNDefaultModels (production verbatim)** [v8 신발견] | **5** | 3 | 3 | 2 | Csr: `workbench.desktop.main.js:L201715` `["composer-1","claude-4.5-opus-high","gpt-5.1-codex"]` + `StreamUiBestOfNJudge*` L175886-L176004 | 3 candidate model 박힘 + 라이브 UI ranking judge — Cursor 자체 `composer-1` 모델 leak |
| **`SwWriteTextFileWithLintsRequest` + FixLintsSubagent** [v8 신발견] | **5** | 0 | 0 | 0 | Csr: `:L147784` SwWriteTextFileWithLintsRequest + `:L154954` FixLintsSubagent + `:L122195` FixLintsParams/Result | write tool이 lints를 입력으로 받음 → 별도 fix subagent loop가 lints clean한 후 accept |
| **ComposerCheckpointService (Git-like)** [v8 신발견] | **5** | 4 | 3 | **5** | Csr: `:L959934` getCurrentFilesContent/createCheckpoint/checkoutToCheckpoint/validateCheckpointContent + `:L962479` removeMessagesAfterBubble truncate · qta: ADR-0184 | plan undo/redo + branch exploration — 메시지 truncate은 비-idempotent (재시행 함정) |
| **GetLatestAgentConversationState (cloud-backed resume)** [v8 신발견] | **5** | 0 | 3 | 3 | Csr: `:L793407,L1196550` `LatestAgentConversationState` (conversationState blob + lastInteraction) | IDE 재시작 가로지르는 session resumption — cloud에서 회복 |
| **ComposerCapabilityRequest 15-subtype** [v7 신발견] | **5** | 0 | 0 | 0 | Csr: `extensionHostProcess.js:L131774-L132665` (LoopOnLints/Tests/Command/ToolCall/DiffReview/AutoContext/ContextPlanner 등 15 nested) | composer 능력 등록을 typed subtype으로 — 흐름별 capability 게이팅 |
| Glob / grep (2-tier truncation) | **5** | 4 | 4 | 4 | Csr: `client_truncated`/`ripgrep_truncated`/`*_applied` echo | "어느 단계에서 잘렸나"를 wire-level로 분리 |
| `read_lints` / `diagnostics` | **5** | 3 | 4 | 3 | Csr: `DiagnosticsToolCall`/`ReadLintsToolCall` | 1급 tool — quanta는 LSP 통해 |
| `blame_by_filepath` (heatmap/churn) | 4 | 3 | 3 | **5** | qta: ADR-0025 src/tool/git/ 9-tool | quanta가 git tool 최다(blame_heatmap/churn) |
| 3-way restore (files/task/both) | 4 | 3 | 3 | **5** | qta: ADR-0210 + `src/agent/per-tool-checkpoint/three-way-restore.ts:231` (defaultThreeWayRestore) | Cline/Cursor 강신호 → typed port 3-verb orthogonal |
| Per-tool checkpoint | 4 | 3 | 3 | **5** | qta: ADR-0209 `granularity: turn\|tool\|skill` | quanta가 axis 단독 명시화. default turn=byte-identical |
| Shell async (2-stage + write_stdin) | **5** | 4 | 3 | 4 | Csr: `TimeoutBehavior{CANCEL,BACKGROUND}` + `write_shell_stdin{shell_id,chars}` | hard_timeout(절대) vs soft(background 전환) 2단 |
| Background shell spawn (force) | **5** | 3 | 4 | 3 | Csr: `ForceBackgroundShellToolCall` | "절대 background" 명시 강제 옵션 |
| Per-turn shell snapshot | 0 | **5** | 0 | 4 | Cdx: `~/.codex/shell_snapshots/` · qta: ADR-0204 src/shell/snapshot/ | zsh `typeset -p; alias; declare -f` — alias LAST가 bash 호환의 핵심 |
| Terminal history 1급 도구 | **5** | 4 | 3 | 2 | Csr: `terminal_history` · Cdx: `read_thread_terminal` | quanta는 output-spill+PTY만 |
| Web fetch + Search | **5** | 4 | **5** | 4 | qta: ADR-0126/0127 + web-fetch slice | |
| Image input (read_image) | 4 | **5** | **5** | 4 | qta: ADR-0132/0146 read_image+URL | |
| Generate image | **5** | 4 | 3 | 0 | Csr: `GenerateImageToolCall` (approval 필요) | |
| Computer Use (mouse/key/screen) | **5** | **5** | **5** | 0 | Cdx: `/Applications/Codex.app/Contents/Resources/plugins/.../Codex Computer Use.app` (4-binary) · Cld: `claude-native-binding.node` Rust napi | Codex 4-binary 구조 + AppKit/CoreGraphics — quanta 0 (★★★ 갭) |
| Voice / STT | 3 | **5** | 4 | 4 | Cdx: `composer-DXaiOlFj.js` offset 65404 (WebRTC) · qta: ADR-0208 voice + 3 adapter | Codex voice-mute = **out-of-band text injection** (session 안 끊고 modality 전환) |
| Browser engine (CDP) | **5** | **5** | 4 | 0 | Cdx: 6엔진(playwright/cua/dom_cua/dev/clipboard/cap) | `exportGsuite` = print→PDF 아닌 Google native API + credentials:include |
| Record screen | 3 | 4 | 3 | 0 | Csr: `RecordScreenToolCall` · Cdx: Chronicle ambient | |
| LSP 4-tool (hover/def/refs/diag) | 4 | 3 | 3 | 4 | qta: ADR-0024/0141 src/tool/lsp/ | |
| AI attribution tool | **5** | 0 | 0 | 3 | Csr: `AiAttributionToolCall` · qta: trailer-only | Cursor 62MB hash-DB; quanta는 정직하게 trailer만 |
| TodoWrite | 4 | 4 | **5** | 4 | Cld baked-in · Csr: `CreatePlanArgs.todos[].dependencies` | Cursor 단독 dependency edge |
| ExitPlanMode | 3 | 4 | **5** | 4 | Cld baked-in | |
| **Code Mode** (격리 코드 실행 환경) [v3 신발견] | 3 | **5** | 3 | 2 | Cdx: `codex-rs/core/src/shell_snapshot.rs` + `code_mode_only` 권한 + js_repl 훅 | shell/JS/코드를 격리 환경에서 실행 + undo 계약 — `code_mode_only` 권한 grade |
| **StartGrind** execution + planning 2-phase tool [v3 신발견] | **5** | 0 | 0 | 0 | Csr: agent.v1 `StartGrindExecutionToolCall` + `StartGrindPlanningToolCall` | 2-phase research framework — plan → execute iteration cycle |
| **SetupVmEnvironment** tool [v3 신발견] | **5** | 0 | 0 | 0 | Csr: agent.v1 `SetupVmEnvironmentToolCall` | Infrastructure-as-code — agent가 remote VM env provisioning |

## C. MCP / 플러그인 / 스킬 / 룰

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| MCP standard client | **5** | **5** | **5** | 4 | qta: ADR-0007 mcp-slice | |
| **Claude 11 MCP tool namespaces verbatim** [v15 재정정] | 3 | 3 | **5** | 3 | Cld: `_cli-symbols.txt` (mcp__claude-in-chrome__{gif_creator,javascript_tool,read_console_messages,tabs_context_mcp,tabs_create_mcp} + mcp__ide__{execute,get,executeCode,getDiagnostics} + mcp__slack__{slack_send_message,slack_read_thread}) = **11 tool verified** (v12 13 → v15 11 정확) | MCP marketplace vendor-pre-installed — `mcp__claude-in-chrome__tabs_context_mcp` must be called first |
| **Claude /api/oauth/* 8 endpoints + tengu_ 32 sub-family** [v15 신발견] | 0 | 0 | **5** | 0 | Cld: `_cli-symbols.txt` `/api/oauth/{account/{grove_notice_viewed,settings},claude_cli/{create_api_key,roles},file_upload,files,organizations,profile,usage}` 8 + tengu_advisor 6 (command/dialog_shown/strip_retry/tool_call/tool_interrupted/tool_token_usage) + tengu_vertex 9 (default_check/probe_result/setup_started+complete+cancelled/upgrade_*) + tengu_voice 6 (circuit_breaker_tripped/recording_*) + tengu_worktree 7 (cleanup/created/entered_existing) + tengu_ws_transport 4 (reconnected) | OAuth surface 8-endpoint + telemetry 32 subgroup — v7 6 정정 |
| **Claude Hook block 3-pair (JOB/SCRIPT/NOTICE × BEFORE_START/AFTER_FINISH)** [v12 신발견] | 0 | 0 | **5** | 0 | Cld: `_cli-symbols.txt` `JOB_BLOCK_{BEFORE_START,AFTER_FINISH}` + `SCRIPT_BLOCK_{BEFORE_START,AFTER_FINISH}` + `NOTICE_BLOCK_{BEFORE_START,AFTER_FINISH}` | 6 hook event = 3 block kind × 2 lifecycle (before/after) — automation 자체에 hook 박힘 |
| **Claude 5 Worktree config keys** [v12 신발견] | **5** | 4 | **5** | 4 | Cld: `worktreeEK/worktreeSparseCheckout/worktreeCount/worktreeSymlinkDirs` + git sparse-checkout cone mode + baseRef | Claude도 worktree 1급 — sparse-checkout cone로 큰 repo도 효율적 |
| MCP Tasks (장기실행 큐) | 3 | 4 | **5** | 3 | Cld: directMcpHost.js (`tasks/{list,get,result,cancel}` + TaskMessageQueue) · qta: ADR-0196 | Anthropic 자체 확장 — 표준 MCP에 없음 |
| MCP Elicitation (7-schema form) | 3 | 4 | **5** | 4 | Cld: ElicitationHooks · qta: ADR-0197 | form-mode + url-mode + OAuth 통합 |
| MCP `sampling/createMessage` | 0 | 0 | **5** | 0 | Cld: directMcpHost.js | Claude 단독 |
| MCP `requestStream` AsyncGenerator | 0 | 0 | **5** | 0 | Cld: directMcpHost.js | 1.5k LOC MCP 런타임 — outputSchema 검증 포함 |
| MCP runtime (py/node/binary/uv) | 4 | 4 | **5** | 3 | Cld: `["python","node","binary","uv"]` | Python MCP를 **uv**(Astral)로 부트스트랩 |
| MCP OAuth dynamic client registration | **5** | 3 | 4 | 2 | Csr: `/.well-known/oauth-authorization-server`+`/.well-known/openid-configuration` | MCP server가 OIDC면 자동 등록 + 24h snapshot TTL |
| MCP live monitoring + auto-reconnect | 3 | 3 | **5** | 2 | Cld: `getMcpServersConfigWithStatus`+`mcp-server-auto-reconnect` | `_listChangedDebounceTimers` 폭주 방지 |
| Reverse MCP (server→agent trigger) | 0 | **5** | 0 | 0 | Cdx: `extr/codex-cli/_cli-symbols.txt:L48629` (codex_rmcp_client + rmcp::transport::WorkerTransport) | 외부 webhook/CI/cron이 agent를 깨움 — paradigm flip |
| MCP marketplace (registry+cache) | **5** | 4 | 4 | 2 | Cdx: `plugins/cache/openai-primary-runtime/{documents,sheets,slides}/version/.codex-plugin/plugin.json` | 버전 태그된 cached registry |
| Plugin manifest (.plugin.json+.mcp.json) | **5** | **5** | 4 | 3 | Cdx 3-파일 컨벤션 · qta: ADR-0162 plugin-isolation | `Interactive\|Read\|Write` closed capability |
| Plugin scope 7-layer | 4 | **5** | 3 | 2 | Cdx: `skills.scope.{builtIn,system,admin,team,repo,user,personal}` | admin이 강제 install → team → repo → user → personal layered |
| Skills (SKILL.md frontmatter) | **5** | 4 | 4 | 4 | Cdx: `~/.codex/skills/.system/` (5 system skills) · qta: src/skill/ | `user-invocable: true\|false` = slash command 게이팅 |
| Skill allowed-tools frontmatter | 4 | **5** | 3 | 3 | Cdx: rr(Read/Grep/Bash, NO Edit) vs rr2(+Edit) vs ss(+Edit) | review-only vs review-repair vs execute 권한 분리 |
| Glob rules (`.mdc` per-turn select) | **5** | 4 | 3 | 4 | Csr: `~/.cursor/rules/*.mdc` (frontmatter `globs`+`alwaysApply`) · qta: glob-rules-and-hook-updated-input | 글로브 매칭 파일이 열리면 자동 주입 — CC/quanta 구조적 부재였음 |
| Multi-source rules (5-vendor convergence) | 3 | 3 | 3 | **5** | qta: ADR-0205 src/rules/multi-vendor/ | .cursor + .cline + .windsurf + .aider + .roo + .quanta 자동 감지 |
| Repo-rules tree (AGENTS.md deeper-wins) | 4 | **5** | 3 | **5** | Cdx 원천 · qta: ADR-0098 src/repo-rules/ | suffix layered — 깊은 디렉토리가 얕은 것 override |
| Playbook frontmatter | 3 | 4 | 3 | 4 | qta: ADR-0203 src/skill/playbook/ | procedure / success-criteria / forbidden-actions / macros / inline-trigger 5필드 |
| Vendor-curated skills cache (60+) | 3 | **5** | 3 | 0 | Cdx: `.extracted_source/userdata/codex/vendor_imports/skills-curated-cache.json` 21KB | aspnet-core/figma 7종/linear/notion/render/vercel/security/playwright-interactive |
| **Managed Agents Beta** (multiagent coordinator) [v3 신발견] | 0 | 0 | **5** | 0 | Cld: `extr/claude-code-cli/_cli-symbols.txt:L160790+` (anthropic-beta: managed-agents-2026-04-01 + `multiagent:{type:"coordinator",agents:[1-20]}` + self-delegation) | swarm-like task delegation + self-delegation (agent가 자기 자신을 sub-task로 호출) |
| **Memory Versions + Redact API** [v3 신발견] | 0 | 0 | **5** | 0 | Cld: `memory_stores.memory_versions.{list,retrieve,redact}` + FUSE-mount agent interface | persistent memory 변경의 audit trail + redact API. enterprise compliance |
| **MCP OAuth Validate** (vault-scoped credential) [v3 신발견] | 0 | 0 | **5** | 0 | Cld: `vaults.credentials.mcp_oauth_validate` | OAuth 토큰을 agent attach 전에 validate. credential 자동 rotation |
| **`codex_mcp_server`** (Codex 자체가 MCP server) [v4 신발견] | 0 | **5** | 4 | 0 | Cdx: `extr/codex-cli/_cli-symbols.txt` `mcp-server/src/*.rs` (/tools, /resources, /prompts MCP impl) | Codex 자체가 MCP server로 제공 — 다중 클라이언트 지원, MCP-as-bus paradigm |

## D. Hook 시스템

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| Hook event 수 | **20** | 11 | **22** | 14 | Csr: `Sw` enum 정확 20 / Cld: **22 named** (PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest/PermissionDenied/UserPromptSubmit/SessionStart/SessionEnd/Setup/SubagentStart/Stop/SubagentStop/PreCompact/PostCompact/ConfigChange/FileChanged/InstructionsLoaded/Elicitation/WorktreeCreate/Remove/Setup + 2종) — **메모리 14 정정** | Claude가 최다 — `PermissionDenied` vs `PermissionRequest` 분리(전자=거절 후, 후자=묻기 전) |
| Hook `updated_input` (arg mutate) | **5** | 0 | 0 | 4 | Csr: `Qnb` validator preToolUse · qta: ADR-0113 src/hook/updated-input/ | Cursor 단독 mid-flight 인자 재작성 → quanta 흡수 |
| Hook `followup_message` (loop steer) | **5** | 0 | 0 | 3 | Csr: stop/subagentStop output, `loop_limit=5` bound | 턴 안 끝내고 재프롬프트 — CC `{decision:block}` normalize |
| Hook Request/Response paired RPC (양방향) | **5** | 3 | 3 | **4** | Csr: agent-exec `PreToolUseRequestQuery/Response` 6쌍 + `prompt_hook` · qta: **ADR-0133-hook-bidirectional-rpc** (6 lifecycle event, prompt_hook/tool_override/abort) | quanta는 6 lifecycle event 모두 typed Request/Response — Cursor 매칭 paradigm |
| `agent_message` vs `user_message` 분리 | **5** | 3 | 3 | 4 | Csr: stop hook output | 모델 보는 거부사유 ≠ 사람 |
| Hook precedence (deny>ask>allow) | 4 | 3 | 4 | 4 | Csr: validator 명시 | hook이 최후게이트 — allow도 뒤집음 |
| `type:"prompt"` hook (shell 대신 LLM) | **5** | 0 | 3 | 2 | Csr: agent-exec | hook이 자체 LLM 호출 |
| `sessionStart` env+additional_context 주입 | **5** | 3 | 4 | 3 | Csr: SessionStart hook | |
| AWF_GUARDED_TOOLS_MATCHER 분리 | 0 | 0 | **5** | 3 | Cld: `Read\|Write\|Edit\|MultiEdit\|NotebookEdit\|Grep\|Glob` + 별도 `Task` matcher | 2종 PreToolUse hook 분리 wire-up |

## E. 권한 / 트러스트

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| Permission modes (5-tier) | 4 | 4 | **5** | 4 | Cld: `default\|plan\|acceptEdits\|readOnly\|bypassPermissions` | |
| Trust scope (공간×시간 매트릭스) | 4 | 4 | **5** | **5** | Cld: `always_allow>project>workspace>session>deny`+`once_only` · qta: ApprovalOutcome 8-state | quanta가 8-state로 형식화 — 메모리 정정: "유일" 아님(Codex/Claude 모두 있음), formal invariant만 단독 |
| ApprovalPolicy enum | 3 | **5** | 4 | 4 | Cdx: `never\|on-request\|on-failure\|always` | |
| Reviewer 3-tier (user/auto/guardian) | 0 | **5** | 0 | 4 | Cdx: `extr/codex/webview/assets/permissions-mode-helpers-*.js:L379` (guardian_subagent + auto_review enum) + Rust `CollabAgentRef` | `auto_review`가 별도 thread에서 risk_level 산출 |
| Per-tool approval bubble (runtime HITL) | **5** | 3 | 4 | 3 | Csr: `ComposerDecisionsService.getPendingApprovalBubble`/`waitForBubbleCreation` | "흐름 안 끊는" runtime bubble — 명시 mode 아닌 inline |
| Post-denial precedence override | 3 | **5** | 3 | 3 | Cdx Guardian: "Post-denial user approval has highest precedence" | 한번 거절한 액션도 위험본 후 재승인 = `user_authorization="high"` |
| HITL 4-tier (hand-off/always/pre-ok/none) | 3 | **5** | 3 | 4 | Cdx: `hand-off-required\|always-confirm\|pre-approval-ok\|none` · qta: ADR-0020 + ADR-0048 | |
| `permission_profile` + `file_system_sandbox_policy` 이중 layer | 0 | **5** | 0 | 3 | Cdx sessions JSONL turn_context | user permission + sandbox policy 분리 |
| **GuardianAssessmentEvent (4-action discriminated)** [v7 신발견] | 0 | **5** | 0 | 4 | Cdx: `_cli-symbols.txt` `GuardianAssessmentEvent` (execve/network_policy_amendment/exec_policy_amendment) + 5 decision sources | "Guardian이 무엇을 평가했나"를 typed action enum + 5 source로 audit |
| Per-thread permissions store | 3 | **5** | 3 | 3 | Cdx: `.codex-global-state.json` `heartbeat-thread-permissions-by-id` | |
| **Permission stack: thread + host + post-denial** [v11 신발견 ADR] | 0 | 3 | 0 | **5** | qta: **ADR-0046 permission-stack** | thread / host / post-denial 3-layered gates — Codex Guardian post-denial precedence 흡수 |
| **Mention filter trust-scope (4-attack surface gate)** [v15 신발견 ADR] | 4 | 3 | 4 | **5** | qta: **ADR-0314 mention-filter-trust-scope** (4 attack surface: strangers/bots/self-loop/code-block echo + word-boundary anchoring + code-block+blockquote exclusion + trust-scope rank `public<collaborator<member<owner` + bot gate + 17 hellgate) | GitHub PR comment에서 @-mention agent trigger 안전화 — 4-attack 모두 차단 |
| **Cursor Anysphere fork mapping (8-path)** [v15 신발견] | **5** | 0 | 0 | 0 | Csr: `product.json` extensionReplacementMapForImports (ms-vscode-remote.remote-{ssh,wsl,containers} → anysphere.remote-{ssh,wsl,containers} + ms-python.vscode-pylance → anysphere.cursorpyright + ms-vscode.cpptools → anysphere.cpptools + ms-dotnettools.csharp → anysphere.csharp) | 8-path replacement — getExtensionOverrides context로 amazon-q/aws-toolkit injection |

## F. 샌드박스 / 보안

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| OS-level sandbox | **5** | **5** | **5** | 1 | Csr: `/Applications/Cursor.app/Contents/Resources/helpers/cursorsandbox` (Rust 3.2MB Seatbelt+bwrap+proxy) · Cdx: sandbox_mode · Cld: yukonSilver microVM | **quanta 최대 갭** — 세 곳 다 OS-level. quanta는 Docker optional |
| **Skybridge sandbox CSP triple validation** [v8 신발견] | 0 | **5** | 4 | 0 | Cdx: `/codex/.vite/build/sandbox-preload.js:L39-L41` (`t.protocol!=="https:"` + `t.port!==""` + `t.username!==""&&t.password!==""` 3중 reject) | defense-in-depth: 평문 origin + implicit port + credential URL 다 거부 |
| **Skybridge initId 128-char alphanumeric validation** [v8 신발견] | 0 | **5** | 0 | 0 | Cdx: `sandbox-preload.js:L26-27` `URLSearchParams(hash).get('initId')` + `/^[A-Za-z0-9_-]{1,128}$/` | MCP widget lifecycle을 parent session에 correlate — origin spoofing 방어 |
| **Skybridge 12-port whitelist + reply asymmetric** [v8 보강] | 0 | **5** | 0 | 0 | Cdx: `sandbox-preload.js:L49,L64-71` (navigate/notifyMcpAppsHost*/notifyMcpAppsToolInput/requestMcpAppsResourceTeardown/runWidgetCode/setAdditionalGlobals/setSafeArea/setTheme/setWidgetData/setWidgetView + reply port asymmetric) | port array 길이 validation + 각 port가 specific action scope grant |
| Seatbelt profile verbatim adopt | 3 | **5** | 4 | 4 | Cdx: 100+ line SBPL · qta: ADR-0199 src/sandbox/seatbelt/ | `(version 1)(deny default)(allow process-exec)...` copy-paste |
| microVM (VZ + rootfs+sessiondata COW) | 0 | 0 | **5** | 2 | Cld: `~/Library/Application Support/Claude/vm_bundles/claudevm.bundle/` (rootfs.img.zst + sessiondata.img + gvisorMacAddress) | rootfs RO + sessiondata RW (COW) + gVisor 격리 추정 |
| Sandbox modes 3-tier | 4 | **5** | 4 | 3 | Cdx: `danger-full-access\|read-only\|workspace-write` + `writable_roots[]?`+`network_access?` | |
| `.git/hooks` write deny | **5** | 4 | 4 | **5** | Csr: cursorsandbox SBPL deny-regex verbatim · qta: ADR-0091 src/permission/git-write-guard.ts | segment-anchored 매칭 (near-miss 정확 배제) |
| fs-jail (branded type) | 3 | 3 | 3 | **5** | qta: `src/storage/fs-jail-lib.ts:6` (FsJailLib interface) + is-path-inside lib-swap | quanta 단독 brand 타입 |
| HARD_DENY 9-rule destructive | 2 | 3 | 4 | **5** | qta: ADR-0098~0107 + `src/permission/git-write-guard.ts:99` (ALL_GIT_WRITE_PROTECT_REASONS) | git rm -rf, branch -D --force, push --force main 등 9 |
| Network policy (3-tier DSL) | **5** | 4 | 4 | 3 | Csr: `user_config_only\|with_defaults\|allow_all`+`NetworkPolicy{default_action,allow,deny}` | classification_failed 폴백 + `smartAllowlistEnabled` |
| `codex_network_proxy` 별도 layer | 0 | **5** | 0 | 0 | Cdx: `extr/codex-cli/_cli-symbols.txt` + **`network-proxy/src/mitm.rs:210~388` MITM SSL/TLS intercept + rewrite rules + MITM CA + Host cert generation** | sandbox 외 별도 proxy layer — MITM은 기업 프록시 통합용 |
| `codex_shell_escalation` 별도 layer | 0 | **5** | 0 | 0 | Cdx: `extr/codex-cli/_cli-symbols.txt` + `shell-escalation/src/` (`SuperExecRequest` via **ESCALATE_SOCKET**, EXEC_WRAPPER 계약) | shell권한 상향은 격리된 서버 프로세스로 분리 |
| SSRF block (RFC1918+link-local+metadata) | 4 | **5** | 4 | 3 | Cdx: `ComputerUseURLBlocklist` + cache | |
| AppApproval per-bundle persistent | 3 | **5** | 3 | 0 | Cdx: `SkyComputerUseService` | "이 앱은 prompt injection 위험" 명시 warning |
| App blocklist (password mgr+terminal) | 3 | **5** | 3 | 0 | Cdx hardcoded(1Password/Bitwarden/iTerm2/Ghostty/wezterm 등 10종) | |
| Disclaimer wrapper (POSIX_SPAWN_SETDISCLAIM) | 0 | 0 | **5** | 0 | Cld: `Helpers/disclaimer` + `shell-path-worker.js` | 사용자 zshrc 악성코드로부터 앱 entitlement 격리 — 비명백 OS API |
| TCC.db 직접 read | 0 | **5** | 0 | 0 | Cdx: `/Library/Application Support/com.apple.TCC/TCC.db` | **negative invariant** — Apple 공식 API 우회, 따라하지 말 것 |
| Identity mode variant | 3 | 4 | 4 | 2 | qta: ADR-0198 src/agent/identity/ + 5 mode identity table | 부분 구현 |
| **`cursor-shadow-workspace`** extension (격리 workspace context) [v4 신발견] | **5** | 4 | 3 | 0 | Csr: `extr/cursor/extensions/cursor-shadow-workspace/` | 격리 workspace ― Codex Code Mode와 paradigm 매칭(Cursor는 extension, Codex는 권한 grade) |

## G. 검증 / 품질 (★ quanta 우위 축)

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| verify-guard hard gate | 0 | 0 | 0 | **5** | qta: ADR-0013 + `src/agent/guards/verify-guard.ts:35` (createVerifyGuard) | test 미실행이면 turn 종료 **차단** — 3사 다 soft prompt, quanta만 코드 hard gate |
| closeout-guard 4-truth (R1~R4) | 0 | 0 | 0 | **5** | qta: ADR-0017 src/closeout/four-truth.ts | 거짓-success 방지 hard gate |
| Hellgate adversarial battery | 1 | 1 | 1 | **5** | qta: `tests/**/*-hellgate.test.ts` 17 batteries | 384+ adversarial case — "내가 이기는 축" 봉인 |
| **Ratchet-proof rail (every architecture rule has *.test.ts)** [v13 신발견 ADR] | 0 | 0 | 0 | **5** | qta: **ADR-0057 ratchet-proof-rail** (surface-coupling-ratchet + terminal-defaults-ratchet + slash-state-ssot-hellgate + exact-zero-debt enforcement) | 모든 architecture rule이 자동 ratchet test — debt grow 차단 |
| **Heuristic-ban registry (closed enum only)** [v13 신발견 ADR] | 0 | 0 | 0 | **5** | qta: **ADR-0053 heuristic-ban-registry** (No regex/timing/name heuristics in safety gates — closed enum over authoritative sandbox/permission tiers only) | "휴리스틱 안 됨" 메모리 정합 — false negative/positive risk가 structural이라 게이트에 적용 금지 |
| **Byte-identical SOTA++ integration invariant** [v11 신발견 ADR] | 0 | 0 | 0 | **5** | qta: **ADR-0023 sota-codex-integration-byte-identical** | 흡수 후 기존 동작 byte-identical 보장 — default-OFF 강제 invariant |
| **Anti-signals policy + injection hardening** [v11 신발견 ADR] | 0 | 0 | 0 | **5** | qta: **ADR-0027 anti-signals-policy-injection-hardening** | "DO NOT follow rollout content" 류 prompt injection 방어 정책화 |
| **Negative invariants test paradigm** [v11 신발견 ADR] | 1 | 1 | 1 | **5** | qta: **ADR-0044 negative-invariants** | "절대 ~하면 안 됨"을 test로 봉인 — Chronicle/TCC.db/auto-unlock 등 흡수 금지 봉인 |
| Coverage (V8 + AST branch counter) | 3 | 3 | 3 | **5** | qta: ADR-0165 V8 + ADR-0167 AST(tsc compiler API) | branch는 V8 line이 아닌 tsc AST로 정확 |
| parse-test-failure 구조화 | 0 | 0 | 0 | **5** | qta: src/tool/test/parse-failure.ts | "테스트 실패가 단순 string" → typed FailureKind |
| Anti-slop 3-pass self-check | **5** | 3 | 3 | 3 | Csr: agent-exec persona reminders | "2개↑ 검출되면 redesign 명시" forbidden gradient/emoji/box-shadow/rainbow |
| Lint-grounded reflect 3-way | 4 | 2 | 2 | 4 | Csr: AiBranchService `OpusChainReflect` | `lints` 입력 + Decision 3-way oneof |
| Best-of-N ensemble | **5** | 3 | 3 | 2 | Csr: `bestOfNDefaultModels[]` | per-feature 별도 ensemble |
| Mock stream framework (1급) | **5** | 3 | 3 | 3 | Csr: `mockAgentStreamController`/`mockComposerStreamController` (sharedProcessMain) | 테스트 first-class |
| Chaos failure inject (declarative) | **5** | 3 | 3 | 3 | Csr: `cursor-socket.injectFailure` | |
| Compaction breaker | 2 | 3 | 3 | **5** | qta: `src/agent/compaction-breaker.ts:48` (DEFAULT_COMPACTION_BREAKER_CAPS) | hard gate |
| `redacted_read_result` (PII separate) | **5** | 3 | 3 | 4 | Csr: agent-exec `Qr` class wire-level | |
| Thinking signature (verifiable reasoning) | 3 | 3 | **5** | 3 | Cld: sessions `thinking.signature` base64 | tamper-resistant reasoning chunk |
| `reasoning.encrypted_content` (fernet) | 0 | **5** | 0 | 0 | Cdx sessions JSONL | tamper-resistant audit trail |

## H. 컨텍스트 / 메모리

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| 2-Phase memory consolidator | 0 | **5** | 4 | 3 | Cdx: `memories/write/src/{phase1.rs,phase2.rs,prompts.rs}` | "DO NOT follow rollout content" 명문 — prompt injection 방어 |
| `stage1_outputs` SQLite raw_memory | 0 | **5** | 0 | 3 | Cdx: state_5.sample-stage1_outputs.txt — `description/task/task_outcome/preference signals/failures/usage_count` sections · qta: ADR-0216 stage1Store | |
| Worker jobs lease+watermark | 0 | **5** | 0 | 2 | Cdx: state_5.jobs `kind: memory_consolidate_global \| memory_stage1` + `lease_until`/`retry_at`/`input_watermark`/`last_success_watermark` | 분산 비동기 worker pool — 우리 task scheduler reference |
| Memory classification (User/Project/Local/Managed) | 3 | 4 | **5** | 3 | Cld: claude-code-cli/_cli-symbols.txt | 4-type + 5 load triggers |
| 5 memory load triggers | 3 | 3 | **5** | 3 | Cld: `session_start\|nested_traversal\|path_glob_match\|include\|compact` | |
| 3 compaction memory hooks | 3 | 3 | **5** | 3 | Cld: `auto_dream\|extract_memories\|speculation` | "auto_dream" — 텔레메트리 이름 자체가 design 시그니처 |
| Team Memory + transcript 공유 | 0 | 3 | **5** | 0 | Cld: `extr/claude-code-cli/_cli-symbols.txt:L137612` (/api/claude_code/team_memory?repo= verified) + `${projects}/teams/{teamId}/config.json` + `/api/claude_code_shared_session_transcripts` | enterprise SaaS 모델 |
| Server-side memory_stores API | 0 | 4 | **5** | 0 | Cld: `/v1/memory_stores` Beta `managed-agents-2026-04-01` | |
| Personality 슬롯 (3 variant) | 0 | **5** | 0 | 0 | Cdx: `extr/codex-cli/_cli-symbols.txt:L48563` (personality_default/friendly/pragmatic + {{personality}} Handlebars) | `models_cache.json`이 페르소나 카탈로그 push |
| Chronicle ambient memory (10min) | 0 | **5** | 0 | 0 | Cdx: 1388개 `YYYY-MM-DDTHH-MM-SS-{hash}-10min-memory-summary.md` | **negative invariant** — 의식적 미흡수 |
| `systemPromptSectionCache` | 0 | 0 | **5** | 3 | Cld: `Map()` 단독 | section 단위 cache key → prompt-cache hit ratio 극대 |
| Per-thread memory_mode opt-out | 0 | **5** | 4 | 3 | Cdx: `threads.memory_mode='enabled'` | |
| Remote memory dir mount | 0 | 0 | **5** | 0 | Cld: `extr/claude-code-cli/_cli-symbols.txt:L117531` (CLAUDE_CODE_REMOTE_MEMORY_DIR verified) | |
| Auto memory file 시스템 | 0 | 0 | **5** | 4 | qta: `~/.claude/projects/.../memory/MEMORY.md` (현 user-facing) | MEMORY.md 인덱스 + topic 파일 분리 |
| **5-layer working state memory** [v6 신발견] | 0 | 0 | 0 | **5** | qta: **ADR-0021 memory-5layer-workingstate** | ephemeral / working / long-term / planning / archive 5-tier (Claude 4-class보다 더 세분, quanta 단독) |
| **Cross-session memory inject** [v8 신발견] | 0 | 4 | 4 | **5** | qta: **ADR-0282 cross-session-memory-inject** + ADR-0281 memory-auto-trigger · `selectForInject` → prompt section | per-session 동치를 session-wide로 확장 — session-end phase1→phase2 promote 자동 |
| **ConversationState (resumable agent session)** [v8 신발견] | **5** | 4 | 4 | 4 | Csr: `:L694679,L144514` ConversationStateStructure / topLevelConversationState · qta: ADR-0292 conv-checkpoint-auto-record | full conversation tree schema — state rollback 가능 |
| **Memory citation provenance chain** [v6 신발견] | 0 | 0 | 0 | **5** | qta: **ADR-0082 memory-citation-provenance** | evidence → recalled → output attribution chain — 메모리가 산출물에 미친 영향 추적 |
| **SOTA memory: tier+kind+벡터+dedupe** [v6 신발견] | 0 | 0 | 0 | **5** | qta: **ADR-0008 sota-memory** | episodic vs semantic tier × 4-kind enum × 벡터 임베딩 + dedupe — Codex 2-Phase보다 풍부 |
| Retrieval (Merkle+simhash+rerank) | **5** | 3 | 4 | 3 | Csr: cursor-retrieval extension (file-service NAPI Rust 29MB) · qta: ADR-0159 retrieval-sota-stack | Merkle subtree 증분-sync 만 차용, 벡터스토어 흡수금지 |
| **Semantic-search port (closed + adapters)** [v11 신발견 ADR] | **5** | 3 | 4 | **5** | qta: **ADR-0254 semantic-search-port** + ADR-0261 pluggable-embedder-store | closed port + N adapter (BM25/embedding/hybrid) — Cursor 13 reranker 패턴을 typed port로 |
| 13 reranker (LULEA/UMEA + 11) | **5** | 0 | 3 | 0 | Csr: `extr/cursor/out/.../extensionHostWorkerMain.js` (RerankerAlgorithm enum 12 variant: LULEA/UMEA in-house + LLAMA/STARCODER_V1/GPT_3_5_LOGPROBS/COHERE/VOYAGE/ADA_EMBEDS+) | 13 reranker 중 2개는 in-house code-specialized |
| 4 chunk-size buckets | **5** | 0 | 0 | 0 | Csr: `RechunkerChoice` `IDENTITY\|600_TOKS\|2400_TOKS\|4000_TOKS` | retrieval 후 token 버킷에 맞게 re-chunk |
| BM25 + vector hybrid | **5** | 0 | 3 | 2 | Csr: `QueryType.QUERY_TYPE_KEYWORDS`vs`QUERY_TYPE_EMBEDDINGS` | caller가 routing 결정 — backend assemble |
| Commit message embeddings | **5** | 0 | 0 | 0 | Csr: `CommitNoteWithEmbeddings` (E2E-encrypted) | git diff-context search — E2E encrypted relative path+weight |
| Context items typed union | 4 | 3 | 3 | 4 | Csr: SparseFileChunk/LspSubgraphChunk/Lints-as-context/PostGenerationEvaluation · qta: ADR-0080 ide-context-provider-seam | typed 6-value union(memory/file_chunk/outline/diagnostic/rule/snapshot) |

## I. 모델 / 라우팅 / 비용

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| Multi-vendor (Bedrock/Vertex/Foundry) | 4 | 4 | **5** | 4 | Cld: `extr/claude-code-cli/_cli-symbols.txt:L114120~L114124` (CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY,MANTLE}) · qta: ADR-0139 | **48 `ANTHROPIC_*` env verified** (메모리 22 정정) |
| **`CLAUDE_CODE_*` env 372 verified** [v10 재정정] | 3 | 4 | **5** | 3 | Cld: `_cli-symbols.txt` (v7 243→v9 281→**v10 372 verified**. 추가: IS_COWORK/USE_COWORK_PLUGINS/PLAN_V2_AGENT_COUNT/PLAN_V2_EXPLORE_AGENT_COUNT/PLAN_MODE_INTERVIEW_PHASE/ENABLE_APPEND_SUBAGENT_PROMPT/API_KEY_FILE_DESCRIPTOR/OAUTH_TOKEN_FILE_DESCRIPTOR/WEBSOCKET_AUTH_FILE_DESCRIPTOR/EMIT_TOOL_USE_SUMMARIES/MID_CONVERSATION_SYSTEM 등) | 372 env — Cowork integration + multi-agent planning + secure credential fd 발견 |
| **`/api/claude_code/*` endpoints 8 + `/api/oauth/*` 6 verified** [v9 재정정] | 3 | 3 | **5** | 3 | Cld: `_cli-symbols.txt` (v7 36 정정. /api/claude_code/{metrics,notification/preferences,organizations/metrics_enabled,policy_limits,settings,team_memory,grove,environments/metrics_enabled} 8 + /api/oauth/{claude_cli/create_api_key,claude_cli/roles,profile,account/settings,account/grove_notice_viewed,usage} 6 = 14) | claude_code + oauth 두 namespace 분리 — v7 endpoint count는 ambiguous |
| **`ANTHROPIC_*` env 42 verified** [v9 재정정] | 0 | 0 | **5** | 0 | Cld: `_cli-symbols.txt` (v7 48→**42 verified**. ANTHROPIC_API_KEY/AUTH_TOKEN/AWS/BEDROCK_MANTLE_API_KEY/CUSTOM_MODEL_OPTION/DEFAULT_{HAIKU,SONNET,OPUS}_MODEL/FOUNDRY_API_KEY/FOUNDRY_BASE_URL/VERTEX_BASE_URL/VERTEX_PROJECT_ID/UNIX_SOCKET 등) | 42 env가 vendor 분기 + model tier override 풀 커버 |
| **6 model enum (gpt-5.5 + claude-mythos)** [v9 신발견] | 0 | **5** | **5** | 0 | Cld: models_cache.json (`gpt-5.5`=frontier agentic / `gpt-5.4`=strong everyday / `claude-opus`=advisor fallback / `claude-sonnet`=main / `claude-haiku`=default fast / `claude-mythos`=preview) | gpt-5.5 + 5.4 + claude-mythos preview 동시 enum — Codex/Claude 모델 leak verbatim |
| **1150 tengu_* 9-cluster taxonomy** [v9 정정] | 0 | 0 | **5** | 0 | Cld: tengu_api(47)/agent(25)/auto(78)/advisor(5)/vertex(9)/version(6)/voice(6)/worktree(7)/ws_transport(4) + 8 color family (amber/slate/velvet/ashen/willow/crimson/hazel/cedar) | v4 "2053", v6 "1150" 확정 — auto_* (auto_dream 등) 78개로 최대 비중 |
| **PKCE OAuth Desktop S256** [v7 신발견] | 3 | **5** | **5** | 4 | Cld: `_cli-symbols.txt` `generatePkceCodes`/`S256_CODE_CHALLENGE_METHOD` (no client_secret) · Cdx: `auth.openai.com/oauth/{token,revoke}` + `CODEX_REVOKE_TOKEN_URL_OVERRIDE` | desktop OAuth without secrets — localhost callback + S256 challenge |
| **9 `anthropic-beta` API version stratification** [v8 신발견] | 0 | 0 | **5** | 0 | Cld: `_cli-symbols.txt` (skills-2025-10-02 / oauth-2025-04-20 / managed-agents-2026-04-01 / environments-2025-11-01 / files-api-2025-04-14 / structured-outputs-2025-12-15 / message-batches-2024-09-24 / user-profiles-2026-03-24 / token-counting-2024-11-01) | 9 distinct beta version — Anthropic은 single "unstable" 안 함, 각 기능 도메인 자체 버전 |
| **41 `codex_*` Rust crate verified (manifest)** [v15 재정정] | 0 | **5** | 0 | 0 | Cdx: v9 42 → v15 **41 verified** (analytics/api/app_server/app_server_client/app_server_protocol/app_server_transport/cli/client/cloud_tasks/code_mode/config/connectors/core/core_plugins/core_skills/exec_server/features/file_search/hooks/lmstudio/login/mcp/mcp_server/memories_write/model_provider/models_manager/network_proxy/ollama/otel/protocol/rmcp_client/rollout/rollout_trace/sandboxing/shell_escalation/state/thread_store/tool_config/tools/tui/utils_*) | full crate manifest verified — 마지막 정정 |
| **`codex_memories_write` 2-phase consolidation agent** [v9 신발견] | 0 | **5** | 0 | 3 | Cdx: `/codex-rs/memories/write/src/{phase1,phase2,prompts,runtime,storage}.rs` (raw_memory/rollout_summary/rollout_slug + agent spawn + heartbeat monitoring `lost global phase-2 ownership during heartbeat`) | Phase-2 ownership을 heartbeat lease로 관리 — 분산 worker pool detail |
| **`codex_hooks` Guardian review system** [v9 신발견] | 3 | **5** | 3 | 4 | Cdx: `core/src/guardian/review_session.rs` + `ExecCommandApprovalEvent`/`PatchApplyBeginEvent`/`RequestPermissionsEvent` + approval_policy `always\|persistent\|suggest` | review session이 별도 module — exec/patch/permission 3종 approval event |
| **Credential store 3-mode** [v9 신발견] | 0 | **5** | 3 | 3 | Cdx: `cli_auth_credentials_store` config (`system_keychain` / `file` / `memory`) | OS keychain / file / memory 3-mode — enterprise lock-down vs dev |
| **`model_instructions_file` (custom persona)** [v9 신발견] | 0 | **5** | 0 | 3 | Cdx: Codex.toml `model_instructions_file` | default agent personality override — Personality slot보다 깊은 customization |
| Vendor count (실측 retrieval) | **8** | 3 | 4 | 3 | Csr: cursor-retrieval `ANTHROPIC/OPENAI/GOOGLE/XAI/MOONSHOT/CURSOR/NVIDIA/ZAI` + Azure + Bedrock | 8 vendor enum — Cursor 단독 |
| Local model (ollama/lm-studio) | 2 | **5** | 0 | 0 | Cdx: `extr/codex-cli/_cli-symbols.txt:L53168` (codex_lmstudio) + `:L56884` (codex_ollama) | OpenAI API 없이 local 추론 직접 호출 |
| Per-command LOCAL_ONLY/CLOUD_ONLY | **5** | 3 | 0 | 0 | Csr: cursor-always-local `GlobalCommandAvailability` | "offline-local"이 단일 로컬 모델 아닌 **per-command routing seam** |
| Fallback models[] list | **5** | 3 | 3 | 2 | Csr: `FeatureModelConfig.fallbackModels[]` | |
| Subscription auth (ChatGPT OAuth PKCE) | 3 | **5** | **5** | 4 | qta: ADR-0094 src/llm/chatgpt-oauth/ + `/login`/`/status` | Codex 공개 client_id `app_EMoamEEZ73f0CkXaXp7hram` 차용 → 사용자는 `/login` 한 줄 |
| OIDC federation | 3 | 3 | **5** | 3 | Cld: `extr/claude-code-cli/_cli-symbols.txt:L113086` (ANTHROPIC_IDENTITY_TOKEN_FILE) + `:L115476` (ANTHROPIC_FEDERATION_RULE_ID) | k8s workload identity 지원 |
| Effort/reasoning tier | 4 | **5** (6) | **5** (5) | 4 | Cdx: 6-tier `none\|minimal\|low\|medium\|high\|xhigh` · Cld: `default/max/high/medium/low` | Codex `xhigh`가 최상 |
| Per-composer model picker | **5** | 4 | 3 | 2 | Cdx: `composer.intelligenceDropdown` + `composer.mode.worktree` | |
| Per-automation reasoning override | **5** | 4 | 3 | 3 | Csr: `automations.reasoning.label` | 스케줄러 task별 reasoning effort 차등 |
| Region override (Haiku) | 3 | 4 | **5** | 3 | Cld: `SMALL_FAST_MODEL_AWS_REGION` | Haiku만 별도 region — 비용 최적 |
| Anthropic prompt-cache tracker | 0 | 0 | 4 | **5** | qta: ADR-0182 src/llm/prompt-cache/ | cache_creation/cache_read pricing + tool surface |
| Token budget breaker | 4 | 4 | 4 | **5** | qta: ADR-0138/0144 + `src/agent/budget/meter.ts:18` (BudgetMeter export) | hard gate |
| Cost-steering throttle (runtime) | 3 | 3 | **5** | 3 | Cld: `CLAUDE_CODE_AGENT_COST_STEER`+`budget_usd` attachment | |
| Rate-limit tier awareness | 3 | 4 | **5** | 3 | Cld: `CLAUDE_CODE_RATE_LIMIT_TIER`+`BLOCKING_LIMIT_OVERRIDE` | |
| Plan-aware (rate_limits in session) | 3 | **5** | 3 | 3 | Cdx sessions: `token_count.rate_limits{limit_id,primary,secondary,plan_type,credits}` | agent가 plan 인식 가능 |
| **Subagent model override** (env-driven) [v3 신발견] | 3 | 4 | **5** | 3 | Cld: `extr/claude-code-cli/_cli-symbols.txt:L129751` (CLAUDE_CODE_SUBAGENT_MODEL — Haiku default, override Sonnet/Opus) | per-deployment subagent 모델 강제 — 비용 최적 |
| **Role-based model override (Roo orchestrator)** [v11 신발견 ADR] | 4 | 3 | 4 | **5** | qta: **ADR-0256 role-based-model-override** | role(architect/editor/debug/tdd/explore)별 다른 모델 자동 라우팅 — Roo orchestrator 흡수 |
| **Auto-compact window threshold** [v3 신발견] | 3 | 4 | **5** | 3 | Cld: `extr/claude-code-cli/_cli-symbols.txt:L136373,L139685` (CLAUDE_CODE_AUTO_COMPACT_WINDOW) | 토큰 임계치 자동 compaction trigger — prompt cache 통합 (Anthropic 비용 모델 노출) |
| **`CLAUDE_CODE_RATE_LIMIT_TIER`** (plan-aware quota) [v4 신발견] | 3 | 4 | **5** | 3 | Cld: `extr/claude-code-cli/_cli-symbols.txt:L120343` (rate-limit tier + plan_type+credits) | agent가 자체 plan 인식 → 자체 rate 제어 |
| **`CLAUDE_CODE_AGENT_COST_STEER`** (runtime cost gating) [v4 신발견] | 3 | 4 | **5** | 3 | Cld: `extr/claude-code-cli/_cli-symbols.txt:L124072` | 비용 임계 도달 시 runtime throttle |
| **`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`** (per-tool cap) [v4 신발견] | 3 | 4 | **5** | 4 | Cld: `extr/claude-code-cli/_cli-symbols.txt:L126701` + ripgrep `--threads` | 동시 tool use 조절 — Q 카테고리에도 박혀 있는데 별도 env 명시 |
| **`claude-opus-4-7`** (latest Opus 4.7 tier) [v3 신발견] | 0 | 0 | **5** | 0 | Cld: `extr/claude-code-cli/_cli-symbols.txt` model selection hints + 4.6-fast speed mode 인접 | 4.6 successor. 모델 enum에 박힘 |
| **`gpt-5.5` 모델 availability NUX** [v6 신발견] | 0 | **5** | 0 | 0 | Cdx: `extr/userdata/codex/config.toml:L41` `tui.model_availability_nux["gpt-5.5"]=4` + `models_cache.json:L7-44` (reasoning_effort={low,medium,high,xhigh}, priority=9) | gpt-5.5 출시 임박 신호 — codex가 NUX 메시지 단계 4까지 표시 준비 |
| **`xhigh` reasoning effort** [v6 신발견] | 0 | **5** | 0 | 4 | Cdx: `config.toml:L2,4` `model_reasoning_effort="xhigh"` + `plan_mode_reasoning_effort="high"` | 6-tier none/minimal/low/medium/high/xhigh 중 최상 — Claude 5-tier보다 한 단계 위 |
| **4 model tier env vars** [v6 신발견] | 0 | 0 | **5** | 0 | Cld: `_cli-symbols.txt` ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL + ANTHROPIC_SMALL_FAST_MODEL (tier별 override) | 3+1 tier override — `SMALL_FAST_MODEL`이 Haiku와 별도 (latency 최적) |

## J. Git / Checkpoint / VCS

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| Git 도구 수 (blame_heatmap/churn 포함) | 4 | 4 | 4 | **5** | qta: ADR-0025 src/tool/git/ 9-tool | quanta 9-tool 최다 |
| **Cursor Git context provider 15+ method** [v9 신발견] | **5** | 3 | 3 | 4 | Csr: `extensionHostProcess.js registerGitContextProvider` (getFullCommit/getCommitMetadataOnly/getSingleFileDiff/getPullRequests/getIssues/getMergeBase/getDiffRaw 15+) | git을 1급 context provider로 — composer가 commit/PR/issue 자동 회수 |
| **Cursor worktree integration (composer mapping)** [v9 신발견] | **5** | 4 | 3 | 4 | Csr: cursor-checkout/dist/main.js `worktreeComposerMappings[]` + `git worktree add -b <branch> <tmpdir>` snapshot isolation | worktree ↔ composerId 양방향 매핑 — 병렬 agent 격리 |
| Shadow ODB (gix-snapshot) | 4 | 3 | 3 | **5** | Csr: file-service NAPI Rust `gix-snapshot @~/.cursor/snapshots`+`captureGitHistory` · qta: ADR-0108 shadow-git-odb | quanta는 extension batch ADR-0121~0125 |
| Conversation checkpoint (LRU) | 3 | 4 | 3 | 4 | qta: ADR-0184/0185 src/checkpoint/ + lru-cache lib-swap | |
| Per-turn byte-identical 보장 | 4 | 4 | 3 | **5** | qta: ADR-0209 default turn granularity | |
| Turn-diff event emitter | 3 | **5** | 3 | 4 | Cdx: `turn/diff/updated` · qta: ADR-0099 | turn 전체 누적 unified diff |
| Moved-code detector | 3 | 3 | 3 | 4 | qta: ADR-0109 src/git/moved-code/ | |
| `::git-*` directive emit + phase-guard | 0 | **5** | 0 | 4 | Cdx 5-directive · qta: ADR-0221 src/git/directive-emit/ | 최종답변(`final`)에서만 emit, commentary phase HARD-reject |
| PR management (label/tour/diff apply) | **5** | 3 | 4 | 3 | Csr: agent-exec `PrManagementToolCall`/`EditPrLabelsToolCall`/`UpdatePrCodeTourToolCall` | |
| PR review (gh integration) | **5** | 3 | **5** | 4 | Csr: BugbotService (Team/Learned/Manual 3-layer) · Cld: launchUltrareview · qta: ADR-0112 git_review_diff | Claude `reviewDiff`(read-only sub-agent depth+1) |
| Commit checkout 3-strategy | **5** | 3 | 3 | 3 | Csr: `cursor-checkout` stash/discard/merge --ff-only | |
| Detached HEAD validation | **5** | 3 | 3 | 3 | Csr: cursor-checkout | |
| AI provenance trailer | 4 | 0 | 0 | 3 | Csr: 62MB hash-DB `~/.cursor/ai-tracking/` · qta: src/git/trailer.ts | Cursor v1=23% vs v2=99.95% — metric을 product lever로 부풀림 (negative invariant 회피) |
| Active branch change signal | **5** | 3 | 3 | 2 | Csr: `active_branch_change` hook | 흡수 보류 (S3) |

## K. UX / Surface / 입출력

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| CLI surface | **5** | **5** | **5** | **5** | qta: src/cli/ | |
| TUI 풀세트 | 3 | **5** | 3 | 3 | Cdx: codex-rs TUI 풀 | |
| GUI (Electron) | **5** | **5** | **5** | 0 | Csr/Cdx/Cld Electron | quanta=CLI-only by design |
| Tauri/Web surface (설계) | 0 | 0 | 0 | 2 | qta: surface-model (메모리) | surface gating 금지 원칙 |
| IDE 통합 (VS Code 기반) | **5** | 0 | 4 | 0 | Csr fork · Cld vscode ext | |
| Mobile pairing (QR+DeviceCheck) | 0 | 4 | 4 | 0 | Cdx: QR + Secure Enclave P-256 + `x-oai-attestation` · Cld: trusted_devices | Codex DeviceCheck = darwin+arm64 강제 (cross-platform 거부) **negative invariant** |
| Worktree-isolated parallel agents | **5** | 4 | 4 | 4 | qta: scripts/worktree (메모리 + 사용 흔적) | |
| Agent modes 수 | **8** | 3 | 4 | 5 | Csr: `AGENT/ASK/PLAN/DEBUG/TRIAGE/PROJECT/MULTITASK/CHAT` | TRIAGE/MULTITASK/PROJECT 신설 — 메모리 4-primitive 정정 |
| Cmd-K inline edit (warming triple) | **5** | 0 | 0 | 0 | Csr: 11 RPC (CmdK 6+Chat.StreamFullFileCmdK/Warm+SlashEdit/SlashEditFollowUp/StreamEdit/PreloadEdit/StreamFastEdit/ReportCmdKFate) | double-issue + PreloadEdit + WarmApply 3중 warming |
| Cursor Tab (next-edit prediction) | **5** | 0 | 0 | 0 | Csr: api3/api4.cursor.sh "Cursor Tab" 별도 endpoint | `cursor_prediction_target` fused 다음편집 위치 stream |
| Tinder diff editor (swipe) | **5** | 0 | 0 | 0 | Csr: `cursor.tinderdiffeditor` URI scheme | Inline edit swipe UI |
| Slash commands 수 | **5** | 4 | **5** | 4 | Cld: `/plan`/`/fork`/`/rewind`/`/bg`+ Cdx: `/side`/`/speed`/`/compact`/`/reasoning`/`/approve` | |
| Voice input UX (`/voice`) | 3 | **5** | 4 | 4 | Cdx: `composer-DXaiOlFj.js` offset 65404 (WebRTC) | mute = **out-of-band text injection** (session 안 끊고) |
| Comment overlay (browser, 16-msg) | 0 | **5** | 0 | 0 | Cdx: `comment-preload.js` 38MB | Manhattan distance scorer (name=1000/nearbyText=500/title=250/elementPath=25) |
| Popcorn 4-channel (code/doc/slide/sheet) | 0 | **5** | 0 | 0 | Cdx: `PopcornElectronPresentationPanel-*.js` 711KB + `WorkbookPanel-*.js` 540KB | code agent 정의 확장 (Notion+Figma 하이브리드) — **negative invariant** |
| Cytoscape/3Dmol viewer | 0 | **5** | 0 | 0 | Cdx: `cytoscape.esm-*.js` 614KB + `3Dmol-oBP9-eS4.js` 908KB | 의존성 그래프 + 분자 구조 (기술 문서 플랫폼 포지셔닝) |
| Floating mini window | 0 | 4 | **4?** | 0 | Cld: "Penguin" codename(grep hit) · `FloatingPenguinMini` 명칭은 minified에 miss · Cdx: hotkey window | grep 검증: 정확 명칭 hit 안 됨, codename만 hit — 점수 보수화 |
| Background Composer Peek | **5** | 3 | 3 | 0 | Csr: `background-composer-peek` URI scheme | foreground 작업 안 끊고 inline preview |
| Multiple Composer (pinned panel) | **5** | 3 | 3 | 0 | Csr: 260+ `*Composer*` (SubComposer/BackgroundComposer/PinnedComposers) | |
| Buddy (BLE) | 0 | 0 | **5** | 0 | Cld: `claude.buddy` IPC namespace + `buddyBle` contextBridge | Bluetooth pairing — 용도 불명 |
| **OpenDocuments IPC (active doc → base64)** [v7 신발견] | 4 | 0 | **5** | 0 | Cld: `mainView.js` `claude.web.{readOpenDocumentAsBase64,getOpenDocuments,fetchMentionOptions,handleMentionSelect}` | 현재 열려있는 문서를 base64로 읽음 — IDE/Office plugin bridge. mention 자동 |
| **Slack marketplace bot** [v7 신발견] | 0 | 0 | **5** | 0 | Cld: `slack.com/marketplace/A08SF47R6P4-claude` + `/app_redirect?channel=` | 공식 Slack bot — App ID `A08SF47R6P4` |
| **3 parallel runtime workers (load balanced)** [v7 신발견] | 3 | **5** | 3 | 0 | Cdx: `extr/codex/webview/assets/runtime.worker-CtSmS8cT.js` 3.8MB(primary editor) + `CdINnV8h.js` 2.2MB(render) + `ChFQ4OyP.js` 2.2MB(calc-engine) | 대칭 병렬 워커 풀 — TextRange/Selection state machine + load balancing |
| **AppleScript 300KB syntax bundle** [v8 신발견] | 0 | **5** | 0 | 0 | Cdx: `extr/codex/webview/assets/applescript-BBCXWTjO.js` (Finder/TextMate/System Events/iTunes process tell-block parsing) | osascript verb-object → JSON message dispatch — native macOS automation bridging |
| **PopcornWorkbookPanel 80+ Excel functions** [v8 신발견] | 0 | **5** | 0 | 0 | Cdx: `extr/codex/webview/assets/PopcornElectronWorkbookPanel-CM0gf_-P.js` (DATE/TIME/IF/AND/OR/SUMPRODUCT/NETWORKDAYS/WORKDAY.INTL 80+ functions + parameter metadata) | Office calc engine parity — NETWORKDAYS.INTL custom weekends 등 financial+array formula 풀 |
| **context-compaction first-class conversation event** [v8 신발견] | 3 | **5** | 4 | 3 | Cdx: `local-conversation-thread-BX7YNcUw.js:case context-compaction` ({source,completed} payload) | compaction이 UI 가시 — user가 어떤 메시지가 culled됐는지 inspect 가능. JSONL 풀 provenance |
| **`glass.*` command enum** (20+ items) [v4 신발견] | **5** | 0 | 0 | 0 | Csr: `extr/cursor/out/main.js` (glass.newBrowser/goToTab1~9/etc.) | 별도 명령 네임스페이스 — Cmd-K과 분리된 Browser automation UI 제어 |

## L. IPC / Wire Protocol

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| JSON-RPC 2.0 stdio + slash-path | 3 | **5** | 4 | 4 | Cdx: 19 methods + 18 events (codex-jsonrpc-protocol-pattern) | `category/subcategory/action` slash-path |
| BiDi multiplex (single stream) | **5** | 3 | 3 | 3 | Csr: agent-exec `AgentService.Run` `ExecServerMessage`/`ExecClientMessage` pair | "엔진이 도구 안 돌림 — 클라에 시킴" |
| Wire-level redaction + span_context | **5** | 3 | 3 | 4 | Csr: `redacted_read_args` + per-exec OTel span | exec 단위로 OTel span 박힘 |
| Connect-RPC + protobuf | **5** | 0 | 0 | 0 | Csr: extr/cursor/extensions/cursor-agent-exec `agent.v1.*` | |
| MessagePort utility process | 3 | 4 | **5** | 3 | Cld: `directMcpHost.js` 15879줄 | Electron utility process + Zod schema |
| Skybridge 12-named MessagePort | 0 | **5** | 0 | 0 | Cdx: `web-sandbox.oaiusercontent.com` + 12 ports (`navigate/runWidgetCode/setSafeArea` 등) | capability-scoped ports — `unsafeSkipTargetOriginCheck=true` 위험 ack |
| WebSocket + HTTP + SSE 공존 | 3 | **5** | 4 | 3 | Cdx: 모델별 분기 (`gpt-5.4`=WS, `gpt-5.5`=HTTP, SSE는 이벤트 디코딩) | |
| Endpoint 매트릭스 풀 노출 | 3 | **5** | 4 | 3 | Cdx: `wss://chatgpt.com/backend-api/codex/responses` + Analytics `analytics-events/events` | api.openai.com 직접 호출 아님 — chatgpt.com 단일 |
| `isTrustedIpcSender` 검증 | 4 | **5** | 4 | 3 | Cdx/Cld origin allowlist | |
| Wire protocol method count | 211 | 19 | 616 | ~40 | Cld: directMcpHost.js 616 IPC methods | Claude desktop IPC 풀 — `mainView.js` 97.7% |
| **Claude 7 IPC namespace + 79 method verbatim** [v7 신발견] | 0 | 0 | **5** | 0 | Cld: `mainView.js` claude.{settings(14)/web(10:WindowControl/Auth/FileSystem/OpenDocuments/DeepLink)/hybrid/internal/buddy/officeAddin/simulator} | "8 namespace 616 IPC"의 핵심 7개 풀 메서드 매핑 |
| **Cursor 60+ MainThread shape services** [v12 신발견] | **5** | 0 | 0 | 0 | Csr: `extensionHostWorkerMain.js` (MainThreadMcp/CursorAgentProviderService/ShellExec/SocketProvider/SocketConsumer/Speech/SpeechProvider/Localization/NotebookDocuments/NotebookEditors 외 50+) | 60+ shape services로 main↔extension IPC isolation — VS Code pattern 확장 |
| **Cursor 60 aiserver.v1 services + 13,528 protobuf stubs** [v13 신발견] | **5** | 0 | 0 | 0 | Csr: workbench (60 aiserver.v1 service types + 13,528 typeName/fromBinary/equals stubs + 59 event types) | massive protobuf code-gen — multi-service marshaling 완전 typed |
| **Cursor `cursor-proclist` native binding** [v13 신발견] | **5** | 4 | 4 | 0 | Csr: `_firstparty-npm/cursor-proclist/build/Release/cursor_proclist.node` (return array [pid, ppid, name, extensionId, cpuTimeMs, memoryMB, argv]) | process tree + per-extension metrics — Electron 한계 회피 |
| **Cursor Sentry 37-type integration** [v15 신발견] | **5** | 4 | 4 | 3 | Csr: workbench.desktop.main.js (SentryProject/Trigger/Status/TraceHeader/Span/NonRecordingSpan/FramesAndReverse/Callback/IssueEvent {Created,Resolved,Assigned,Archived,Unresolved} 37 distinct classes + 11 payload traces) | Sentry v2 stable telemetry core — issue lifecycle 5-state + distributed tracing schema 완비 |
| **Cursor `cursorTrustedExtensionAuthAccess` whitelist** [v15 신발견] | **5** | 0 | 0 | 0 | Csr: `product.json` (["anysphere.cursor-retrieval", "anysphere.cursor-commits"] 2-extension OAuth escalation) | trusted-only OAuth — dual-extension scope authorization, 다른 extension은 user prompt 필요 |
| **Cursor `cursorTracing` API proposal** [v15 신발견] | **5** | 0 | 0 | 0 | Csr: cursor-mcp `vscode.proposed.cursorTracing.d.ts` + enabledApiProposals ["control", "cursor", "cursorTracing"] | tracing privileges가 별도 API proposal — anysphere.{remote-ssh,wsl,containers,tunnels,cpptools,cursorpyright} 한정 |
| Local↔cloud scope URL | **5** | 4 | 4 | 0 | Csr: `local:${conversationId}` vs `cloud:${taskId}` | composerId가 URL에 박혀 cloud-agent 라벨링 |
| Background Composer URL scheme | **5** | 0 | 0 | 0 | Csr: `background-composer+{bcId}:{url}` + `cursor-socket onResolveRemoteAuthority` | remote authority로 TCP/TLS socket mesh |
| Mock RPC framework (1급) | **5** | 3 | 3 | 3 | Csr: `mockAgentStreamController`/`mockComposerStreamController` sharedProcess registry | |

## M. Subagent / Orchestration

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| Subagent spawn (basic) | **5** | **5** | 4 | 4 | qta: subagent-sota-hardening + ADR-0218 | |
| 6 subagent lifecycle tools | 4 | **5** | 3 | 3 | Cdx: `exec_command`(75%)+`write_stdin`(24%)+`spawn_agent`+`wait_agent`+`close_agent`+`send_input` | exec_command가 75%, write_stdin이 24% (interactive REPL) |
| 9 SubagentType specialize | **5** | 3 | 3 | 3 | Csr: `SubagentTypeBash/Shell/ComputerUse/BrowserUse/CursorGuide/Debug/Explore/MediaReview/VmSetupHelper` | type별 pre-prompt + tool 한정 |
| Background subagent non-blocking + await | **5** | 4 | 4 | 3 | Csr: `force_background_subagent`+`subagent_await` | |
| Reviewer 3-tier + 8-state outcome | 0 | **5** | 0 | **5** | Cdx: `"user"\|"auto_review"\|"guardian_subagent"` + 8-state `not_needed/config_allowed/guardian_approved/guardian_denied/user_approved/user_approved_for_session/user_denied/user_aborted` · qta: ADR-0029 | Codex/quanta 단독 — 메모리 정정 후 invariant만 quanta unique |
| Subagent default readonly + fanout≤5/depth=1 | **5** | **5** | 3 | 3 | Csr production calibration · Cdx 86% depth=1, 6386 sessions | "깊은 재귀 트리는 over-engineering 증거" |
| Subagent fork (fork_agent_id) | **5** | 3 | 4 | 3 | Csr: `SubagentPersistedState` | continue_from의 superset (fork 없음) |
| CoT leak 방지 (empty initial prompt) | 3 | **5** | 3 | 3 | Cdx: `Initial prompt sent to the agent. Can be empty to prevent CoT leaking at the beginning` | spawn payload comment 자체가 design 시그니처 |
| Subagent transcript 공유 (team_context) | 0 | 3 | **5** | 0 | Cld: `/api/claude_code_shared_session_transcripts` + `team_context` attachment | 다른 팀원이 reuse |
| Nickname pool (39 거장) | 0 | **5** | 0 | 0 | Cdx: 6386 sessions corpus — Averroes/Banach/Bohr/Curie/Dirac/Einstein/Erdos/Euler/Feynman/Godel/Hegel/Kant/Nash/Nietzsche/Pascal/Russell/Sartre/Tesla... | 인류 지성사 거장 39명 — UX 아이디어 |
| Stage-aware Update chunk (13 type) | **5** | 3 | 3 | 3 | Csr: `extr/cursor/extensions/cursor-agent-exec/dist/main.js` (TextDelta/TokenDelta/ToolCallDelta+Start+Completed/StepStart+Completed/ThinkingDelta+Completed/SummaryStart+Completed/Heartbeat/Interaction/Partial - 13 variants verified) | UI가 각 phase별 다르게 렌더 — semantic rich streaming |
| Heartbeat update | **5** | 3 | 3 | 3 | Csr: `HeartbeatUpdate` | 단독 chunk type |
| Mode-typed delegation (BoomerangResult) | 4 | 4 | 3 | 4 | qta: ADR-0218 5-mode closed enum | architect/editor/debug/tdd/explore — 4-vendor 수렴 |
| Focus chain reinject | 4 | 2 | 2 | 4 | Cline → qta: ADR-0219 | |
| `thread_spawn_edges` lifecycle | 3 | **5** | 3 | 3 | Cdx: state_5.thread_spawn_edges `status: open/closed` | subagent lifecycle을 edge state로 |
| **Multiagent Coordinator + self-delegation** [v3 신발견] | 4 | 4 | **5** | 3 | Cld: `CreateAgent.multiagent:{type:"coordinator",agents:[]}` (1-20 specialist) · qta: ADR-0218 mode-typed delegation | Claude는 self-delegation도 명시 — agent가 자기 자신을 sub-task로 호출 |
| **`AGENT_TEAMS` experimental flag** [v3 신발견] | 4 | 4 | **5** | 3 | Cld: `extr/claude-code-cli/_cli-symbols.txt:L117378,L129956` (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) | Agent + Coordinator + Self 패턴 게이팅 |
| **Thread Dynamic Tools** (per-thread lazy registry) [v3 신발견] | 3 | **5** | 3 | 3 | Cdx: state_5 `thread_dynamic_tools` (position/namespace/input_schema/`defer_loading`) | tool registry를 thread별 lazy load — namespace 분리(codex_app vs MCP) |
| **`agent.thread_message_sent/received`** (multiagent cross-thread) [v6 신발견] | 3 | 4 | **5** | 3 | Cld: managed-agents `/v1/sessions/{sid}/threads/{tid}/events` (max 25 concurrent threads, 6 thread events: created/status_{running,idle,rescheduled,terminated}) | coordinator↔thread message pairing — `session.status`는 thread statuses aggregate |
| **`BackgroundComposerService` 12-cluster, 114 method 풀** [v6 신발견] | **5** | 3 | 3 | 0 | Csr: `extr/cursor/out/.../extensionHostProcess.js:L243974+` (ListBackgroundComposers/AttachBackgroundComposer/StreamConversation/MakePRBackgroundComposer/OpenPRBackgroundComposer/**PreWarmPod**/Pause/Resume/Archive/Delete/**startBackgroundComposerFromSnapshot:L244018**/ListPendingFollowups:L244048/UpdatePendingFollowup/SubmitPendingFollowupNow) | Pod lifecycle + pre-warming + snapshot rehydration paradigm — async follow-up queue (Cursor 단독) |
| **`AiProjectService` 8-RPC 4-phase pipeline** [v6 신발견] | **5** | 0 | 0 | 0 | Csr: `extensionHostProcess.js:L129432+` (Init→Clarification→Plan+PlanFeedback→Breakdown+BreakdownFeedback→Step+StepFeedback) | step_type ∈ {READ_WRITE_FILE/RUN_TERM/CREATE_RM_FILES} — 모든 step에 paired Feedback |

## N. 관측성 / Telemetry

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| OTel canonical attribute vocabulary | 3 | **5** | 4 | **5** | Cdx: 70+ keys · qta: **ADR-0032 otel-attribute-vocabulary** + ADR-0010 + ADR-0144 | quanta가 typed OTel vocabulary로 형식화 — Codex copy-paste보다 stricter typed schema |
| W3C tracing propagator | 3 | 4 | 4 | 4 | qta: ADR-0186 src/observability/tracing/ | |
| MCP-specific telemetry | **5** | 4 | 4 | 3 | Csr: `mcp.ipc.{count,duration_ms}`+`mcp.snapshot.notify_pull_changed_count`+`mcp.agent_exec.lease_selected` | |
| Telemetry event namespace | 4 | 4 | **5** | 4 | Cld: `claude_code.{session,pull_request,commit,cost,token,code_edit_tool,active_time}.*` | |
| Sentry stack 4중 | 3 | **5** | **5** | 3 | Cld: `@sentry/{electron,node,opentelemetry,instrumentation}` | release pin = git commit SHA |
| Datadog sink | 3 | 4 | **5** | 3 | Cld: `extr/claude-code-cli/_cli-symbols.txt:L108092+` (**`tengu_*` 2053 family** — 메모리 1155+ 정정; spinner/memory/oauth/performance/agent lifecycle full grid) | Sentry + Datadog 4중 중복 가능 — cost 최적화 트레이드오프 |
| Statsig + GrowthBook A/B | 3 | 4 | **5** | 3 | Cld: 통합 | |
| Cursor Sentry tagging | **5** | 3 | 3 | 3 | Csr: `CURSOR_EXTENSION_HOST_ROLE=background-composer`+`CURSOR_LAYOUT` | host process role별 분기 |
| Trace recording | 3 | **5** | 4 | 3 | Cdx: `trace-recording-sentry-upload-D1vMSdCW.js` 3.4KB (Chrome DevTools format) | gzip + Sentry attachment 30s flush |
| `_safe`/`_log_only` PII-stripped 2-copy | 0 | **5** | 0 | 0 | Cdx: logs_2.sqlite | 외부 OTLP exporter용 sanitized 사본 |
| NDJSON ingest debug server | **5** | 3 | 3 | 0 | Csr: extr/cursor/extensions/cursor-ndjson-ingest (port 7242-7942 workspace-sticky) | `.cursor/debug.log` + curl 명령 copy |
| Metric registry (Eval) | **5** | 4 | 4 | 4 | Csr: EvalTrackingService 21 Unary methods (Ray/S3/Slack training sink) · qta: ADR-0087 storage/schema.ts | `Metric{key,value,unit,step}` shape 흡수, Ray 부적합 |
| Tool stats / heatmap | 4 | 3 | **5** | 3 | Cld: `extractToolStats`+multi-Claude 감지 | |
| **AutoDream 4-state lifecycle** [v6 신발견] | 0 | 0 | **5** | 0 | Cld: `_cli-symbols.txt` `tengu_auto_dream_{fired,completed,failed,skipped_due_to_lock}` + `tengu_auto_dream_toggled.is_first_enable` | per-session review count + cache hit/creation tokens + daily logs + files touched 자동 추출. 이름 자체가 design 시그니처 |
| Sentry release pin | 4 | 4 | **5** | 3 | Cld: git commit SHA `ca0c62bc1d73c3f4d2f37816bd25565587fb4443` + debug ID | |
| **Notification Preferences API** [v3 신발견] | 3 | 3 | **5** | 0 | Cld: `/api/claude_code/notification/preferences` OAuth-protected | cross-session notification 관리 — programmatic control |
| **Organization Metrics gating** [v3 신발견] | 3 | 4 | **5** | 0 | Cld: `/api/claude_code/organizations/metrics_enabled` | org-scope telemetry collection gating flag |

## O. Privacy / Data Governance

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| Secret detection (10 regex+Shannon+Luhn) | 3 | 3 | 3 | **5** | qta: ADR-0164 src/security/secret-detection/ + secretlint lib-swap | 10 regex + Shannon entropy + Luhn checksum |
| PII redaction | 2 | 3 | 3 | **5** | qta: ADR-0171 pii-redaction src/security/pii-redaction/ | 10-kind + composite |
| PRIVACY_MODE 5-value enum | **5** | 3 | 3 | 2 | Csr: agent-exec | typed enum 1급 |
| E2E-encrypted commit notes | **5** | 0 | 0 | 0 | Csr: `GetGitGraphRelatedFiles encrypted_relative_path+weight` | co-change 분석을 E2E-encrypted로 |
| Bridge separate origin (XSS isolation) | 0 | **5** | **5** | 0 | Cld: `wss://bridge.claudeusercontent.com` · Cdx: `oaiusercontent.com` | GitHub `githubusercontent.com` 패턴 — 사용자 콘텐츠 XSS가 메인 API 토큰 못 훔침 |
| Cyber Safety Composer Banner | 0 | **5** | 0 | 0 | Cdx: `cyberSafetyComposerBanner` (comment-preload.js) | 대화 내 보안 위험 자동 감지 + GPT-5.4 upgrade prompt |
| `disableNonessentialServices` MDM key | 3 | 3 | **5** | 0 | Cld: `anthropic-mcp-registry` 헤더 ↔ macOS configuration profile | IT 관리자가 끌 수 있음 — `mdmKey` 일급 |

## P. 자율 / Reactor / Background

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| `SIMULATED_MSG_REASON_*` 자율 self-prompt | **5** | 0 | 0 | **4** | Csr: `extr/cursor/out/vs/workbench/api/node/extensionHostProcess.js` (**17 variant verified**: UNSPECIFIED/PLAN_EXECUTION/COMMIT_REMINDER/BACKGROUND_TASK_COMPLETION/DIFF_TAB_{COMMIT,PUSH,CREATE_PR,FIX_MERGE_CONFLICTS}/MULTITASK_SPLIT_PRS/BUILD_IN_PARALLEL/BABYSIT_PR_IN_CLOUD/CI_PANEL_INVESTIGATE_FAILURE/USER_*_SUBAGENT 2종 + 4종 추가) · qta: **ADR-0132-autonomous-proactive-reactor** (temp cloud branch + simulated msg + 30s guard, default-OFF) | ★ paradigm shift — 17 variant는 자율 wake trigger 분류 전수 |
| Background Composer (PR babysit) | **5** | **5** | 4 | 0 | Csr: BackgroundComposerService 114 메서드 (6 ServerStream+108 Unary, 12-cluster) · Cdx: `codex cloud` 8 sub-cmd | bc_id로 PR binding |
| BugBot AUTOFIX 사다리 | **5** | 0 | 3 | 0 | Csr: `extr/cursor/out/.../extensionHostProcess.js` + `workbench.desktop.main.js` (BUGBOT_AUTOFIX_MODE_{AUTO_MERGE,AUTO_PR,MANUAL,OFF,UNSPECIFIED} 5 variant verified) | 이슈→PR→머지 풀 파이프 자율도 3단 |
| Cron + RRULE scheduled agent | 4 | 3 | 3 | 4 | qta: ADR-0161/0215 AutomationEnginePort src/automation/ | |
| 8-trigger oneof | **5** | 3 | 3 | 3 | Csr: `AutomationsService` (cron/git/slack/linear/webhook/slack_channel_created/pagerduty/sentry) | |
| Agentic filter prompt (LLM gate) | **5** | 3 | 3 | 3 | Csr: `agentic_filter_prompt` ALLOW/BLOCK + rationale | LLM이 trigger를 한 번 더 게이팅 — gem |
| Per-automation memory CAS | **5** | 3 | 3 | 2 | Csr: AutomationsService | |
| Cloud handoff | **5** | 3 | 3 | 0 | Csr: `AgentCompatService.getConversationStateForCloudTransfer(composerId)` | local agent 상태를 cloud-agent로 marshal |
| Reverse MCP (RMCP) | 0 | **5** | 0 | 0 | Cdx: codex-cli `codex_rmcp_client` | server → agent 역방향 trigger |
| **HeartBeat Automations** (RRULE + cron taxonomy) [v3 신발견] | 4 | **5** | 3 | 4 | Cdx: state_5 `automation_update` tool + RRULE 스케줄 + mode={heartbeat,cron} + ACTIVE/PAUSED 상태 · qta: ADR-0161 | follow-up/wake-up 1분~주 단위 — `heartbeat`는 1회성 wakeup, `cron`은 반복 |
| **quanta automation chain (engine+update tool+inbox)** [v12 신발견 ADR] | 4 | **5** | 3 | **5** | qta: **ADR-0278** searchCodebase auto-register + **ADR-0279** automation-engine wire + **ADR-0280** automation_update tool + REPL inbox banner | searchCodebase lazy registration + AutomationEngine compose + 6-action discriminated input + inbox-count status bar |
| **Automation RRULE granularity matrix** [v8 신발견] | 4 | **5** | 3 | 4 | Cdx: cron `FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9` (hourly+) vs heartbeat `FREQ=MINUTELY;INTERVAL=30` (sub-minute) | 2-tier: cron workspace-scoped batch / heartbeat thread-attached < 1min latency |
| **$CODEX_HOME/automations/*/automation.toml registry** [v8 신발견] | 3 | **5** | 0 | 3 | Cdx: `app-server-manager-signals-BEaGjuc8.js` (filesystem-backed registry + TOML 파싱 + `automation_update` patch semantic) | TOML 파싱 필요한 introspection — RRULE/schedule preserve unless asked |
| **Tool failure exploration ladder** [v3 신발견] | 3 | 3 | 3 | **5** | qta: **ADR-0062 tool-failure-and-exploration-ladder** | 단일 broad call→narrow 대신 실패 타입별 next-action 사다리 (cap→narrow, 404→fold, perm→skip) |
| **Speculative branch search** (N-best verifier-prover) [v3 신발견] | 3 | 0 | 0 | **5** | qta: **ADR-0084 speculative-branch-search** | Agentless 기법 흡수. patch candidate N개 병렬 → scorer/selector. SWE-bench SOTA |

## Q. 신뢰성 / Resilience

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| AbortSignal propagation | **5** | 3 | 4 | 4 | Csr: cursor-explorer "Workspace explorer aborted" | long-running explore cancellation |
| Retry policy (p-retry) | 3 | 3 | 4 | 4 | qta: lib-swap-2nd-round (p-retry sibling, streaming kept) | streaming class can't be promise-wrapped — ADR-0200 retry-pretry sibling |
| Chaos failure inject | **5** | 3 | 3 | 3 | Csr: `extr/cursor/extensions/cursor-socket/dist/main.js` (`injectFailure` API — quanta와 동일 paradigm, declarative) | declarative socket failure injection |
| WAL corruption detection | 0 | **5** | 0 | 2 | Cdx: `database disk image is malformed` 감지 + retention pruning slow query (1.4~2.2s) | self-logging 성능 저하도 잡힘 |
| MCP auto-reconnect | 3 | 3 | **5** | 3 | Cld: `mcp-server-auto-reconnect`+`_listChangedDebounceTimers` | |
| Multi-tab page lock | **5** | 3 | 3 | 0 | Csr: cursor-browser-automation task-scoped page locking + CPU profile capture | multi-agent contention 방지 |
| Per-tool concurrency cap | 3 | 3 | **5** | 4 | Cld: `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` + ripgrep `--threads` | |
| Stream idle + spinner stall composite | 4 | 3 | 4 | **5** | qta: ADR-0200 + ADR-0227 | |
| Hard abort fence | 3 | 3 | 3 | **5** | qta: closeout fence (ADR-0017) | |

## R. 엔터프라이즈 / 협업

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| Team rules (Bugbot 3-layer) | **5** | 0 | 3 | 2 | Csr: BugbotService Team/Learned/Manual + Mode DEFAULT/HIGH/AUTO + BugbotModePrompt[] | 모드별 system prompt 주입 슬롯 |
| Team Memory + transcript 공유 | 0 | 3 | **5** | 0 | Cld: 위 H 행 | |
| OIDC IdP federation | 3 | 3 | **5** | 3 | Cld: 위 I 행 | k8s workload identity |
| MDM (`mdmKey` preference) | 3 | 3 | **5** | 0 | Cld: 위 O 행 | macOS configuration profile |
| FedRAMP / residency lock | 3 | 4 | **5** | 0 | Cdx: `fedramp_account`+`x-openai-internal-codex-residency` | |
| Trusted devices API | 0 | 4 | **5** | 0 | Cld: `extr/claude-code-cli/_cli-symbols.txt:L126373` (/api/auth/trusted_devices verified) | |
| Grove remote feature gate | 0 | 3 | **5** | 3 | Cld: `extr/claude-code-cli/_cli-symbols.txt:L214666` (/api/claude_code_grove verified) | |
| Connectors REST API | 4 | 3 | 4 | 4 | qta: ADR-0160 src/connectors/ | |
| **GitHub Actions trigger adapter (Tier-0 webhook bot)** [v15 신발견 ADR] | **5** | 4 | 4 | **5** | Csr: BackgroundComposerService BABYSIT_PR_IN_CLOUD · qta: **ADR-0311 github-actions-trigger-adapter** (6 exhaustive event kinds + dedup via GITHUB_DELIVERY + default-OFF + trust-scope gate + self-loop+bot guard + 27 hellgate) | quanta GitHub trunk 시작 — self-trigger from GH Actions runner |
| **GitHub App webhook host scaffold** [v15 신발견 ADR] | 4 | 3 | 4 | **5** | qta: **ADR-0312 github-app-webhook-host-scaffold** (WebhookTransportPort + verifyHubSignature256 HMAC-SHA256 length guard + timing-safe compare) | Tier-1 long-lived GitHub App — host decision deferred, scaffold load-bearing |
| **Why meta-LLM reasoning (/why slash)** [v15 신발견 ADR] | 4 | 4 | 4 | **5** | qta: **ADR-0271 why-meta-llm-reasoning** (`/why <toolCallId\|last>` + 1 LLM call + sanitised last-3-msg query + JSON parse soft-fail + isolated from live conv + 21 hellgate) | tool call reasoning introspection — agent 자기 행동의 why를 meta-LLM에 물어봄 |
| **CLI runtime feature config unification** [v15 신발견 ADR] | 4 | 3 | 4 | **5** | qta: **ADR-0297 cli-runtime-feature-config-unification** (typed `CliFeatureConfig` + single `readCliFeatureConfig(env, isTTY)` resolver + byte-identical preservation + 24 hellgate) | surface-level feature gates 통합 (pills/cost/summary/etc.) — env+TTY 1-resolver |
| **REPL host slim-down (CLI-06 factory lift)** [v15 신발견 ADR] | 4 | 3 | 4 | **5** | qta: **ADR-0307 repl-host-slim-down** (lifts buildImageQueue/buildRewindSlashState/buildPromptUx to host slice + zero @/apps/cli reach-through) | REPL이 dispatch/render만 책임 — host adapter 격리 강화 |
| Multi-device sync (cloud handoff) | **5** | 4 | 4 | 0 | Csr: 위 P 행 | |
| Slack/Linear/PagerDuty connector | **5** | 3 | 4 | 0 | Csr: AutomationsService 8-trigger | |
| Office Add-in | 0 | 0 | **5** | 0 | Cld: `pivot.claude.ai/manifest.xml`+`microsoft365.mcp.claude.com` | |
| Sparkle auto-update (EdDSA pinned) | 4 | **5** | 4 | 0 | Cdx: 7 flavor(Dev/InternalAlpha/Nightly/Owl/Agent/PublicBeta/Prod) + SUPublicEDKey `mNfr1v9t63BfgDtlw4C8lRvSY6uMggIXABDOCi3tS6k=` | flavor별 icon+feed path 분리 + EdDSA pinning |
| **Sparkle feed runtime injection (codexSparkleFeedUrl verbatim)** [v13 신발견] | 0 | **5** | 0 | 0 | Cdx: `package.json:L101-102` `codexSparkleFeedUrl: https://persistent.oaistatic.com/codex-app-prod/appcast.xml` + `codexSparklePublicKey: mNfr1v9t63BfgDtlw4C8lRvSY6uMggIXABDOCi3tS6k=` | feed URL이 Info.plist 아닌 build-time injection — EdDSA key도 같이 |
| **Codex.dmg distribution chain (hdiutil)** [v13 신발견] | 0 | **5** | 0 | 0 | Cdx: "Mounting Codex Desktop installer..." + `/Volumes/codex-app-installer-` + `hdiutil attach/detach` | macOS DMG mount/detach 자동 — installer chain 풀 control |
| **electron-forge maker-{dmg,deb,rpm,squirrel,zip,msix}** [v13 신발견] | 4 | **5** | 4 | 0 | Cdx: `package.json:L16-19` `rebuild:native-modules && rebuild:forge-natives && electron-forge {package\|make\|publish}` + v7.11.1 | 6 platform maker — DMG/DEB/RPM/Squirrel(Windows)/ZIP/MSIX 통합 빌드 |
| **Policy Limits Endpoint** (enterprise quota) [v3 신발견] | 3 | 3 | **5** | 3 | Cld: `/api/claude_code/policy_limits` | org-scope rate/token limits return — enterprise policy enforcement |
| **Penguin Mode Endpoint** (VM sandboxed exec) [v3 신발견] | 3 | 4 | **5** | 0 | Cld: `/api/claude_code_penguin_mode` (gvisor microVM 관련) | code isolation toggle — `Penguin` codename과 일치 |
| **Remote Control Enrollments** (SQLite normalized) [v3 신발견] | 0 | **5** | 3 | 0 | Cdx: state_5 `remote_control_enrollments` table | enrollment flow SQLite로 정규화 — wham/remote와 동일 layer |

## S. 데이터 보안 / Encryption [v5 신규 카테고리]

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| Reasoning encrypted_content (fernet) | 0 | **5** | 0 | 0 | Cdx: `extr/userdata/codex/_sampled/sessions/*.jsonl` `reasoning.encrypted_content` (Fernet token base64) | tamper-resistant audit trail — reasoning chunk이 encryption으로 저장 |
| Bridge separate origin (XSS isolation) | 0 | **5** | **5** | 0 | Cld: `extr/claude/.vite/build/index.js:L51701-51706` `yr() URL resolver` + `bridge.claudeusercontent.com` · Cdx: `web-sandbox.oaiusercontent.com` | GitHub `githubusercontent.com` 패턴 — 사용자 콘텐츠가 메인 API 토큰 못 훔침 |
| `_safe` + `_log_only` PII-stripped 2-copy | 0 | **5** | 0 | 0 | Cdx: `extr/userdata/codex/_sampled/sqlite/logs_2.sqlite` (sanitized 사본 + raw 사본 동시 저장) | 외부 OTLP exporter용 sanitized — 같은 이벤트 2 카피 |
| Commit message E2E-encrypted embeddings | **5** | 0 | 0 | 0 | Csr: cursor-retrieval `CommitNoteWithEmbeddings` (`encrypted_relative_path+weight`) | git diff-context search를 E2E-encrypted로 — co-change 분석 |
| Deeplink encryption (sharing) | **5** | 0 | 0 | 0 | Csr: extensionHostProcess.js `deeplinkId` (string) + `encryptionKey` (bytes) + `ListDeeplinksRequest paging` | share link 자체에 암호화 키 박힘 — recipient만 복호화 |
| MITM CA + Host cert generation | 0 | **5** | 0 | 0 | Cdx: `network-proxy/src/mitm.rs:210~388` SSL/TLS intercept + rewrite rules | 기업 프록시 통합용 — sandbox 외 layer |
| DeviceCheck attestation (darwin+arm64 강제) | 0 | **5** | 0 | 0 | Cdx: `devicecheck.node` + `x-oai-attestation` header | Intel Mac/Linux/Windows 자동 reject — **negative invariant** (cross-platform 거부) |
| `redacted_read_result` PII separate channel | **5** | 3 | 3 | 4 | Csr: cursor-agent-exec `Qr` class wire-level | read result PII가 별도 channel — 모델 보는 게 != 사용자 보는 게 |
| **Memory Versions `redact` (terminal, no unredact)** [v6 신발견] | 0 | 0 | **5** | 0 | Cld: `_cli-symbols.txt` `memory_stores.memory_versions.{list,retrieve,redact}` + immutable versions | redact은 terminal state — 한 번 가린 메모리는 영구 hide. 음모/GDPR 호환 |
| **Vault Archive (immutable terminal state)** [v6 신발견] | 0 | 0 | **5** | 0 | Cld: `_cli-symbols.txt` `POST /v1/vaults/{vault_id}/archive` (no unarchive) | agent archive와 동일 paradigm — immutable deployment, audit-friendly |
| FIPS 140 (Cowork Linux daemon) | 0 | 0 | **5** | 0 | Cld: `vm_bundles/claudevm.bundle/` sdk-daemon Go runtime (FIPS 140 cryptographic module) | enterprise compliance — 정부/규제 OK |
| Statsig client API key hardcoded | 0 | 0 | **5** | 0 | Cld: `extr/claude/.vite/build/index.js:L67547` `statsig-api-key: client-ila3bcu9jdk...` + `productSurface="claude-desktop"` tag | client-side hardcoded key — feature flag/AB test 식별 |
| **`computer-use.lock` file-based mutex** [v8 신발견] | 0 | 0 | **5** | 0 | Cld: `_cli-symbols.txt` `computer-use.lock` 아티팩트 | file-based mutex — 여러 Claude instance 동시 computer-use 방지 |
| **PR output sink redaction + idempotency** [v15 신발견 ADR] | 4 | 3 | 4 | **5** | qta: **ADR-0313 pr-output-sink-redaction** (mandatory `redactPort` construct-time + idempotency marker `<!-- quanta:idempotency=` + body cap 65KB + multi-byte boundary handling) | PR comment에 secret leak 방지 — redactPort 의무, idempotency marker로 중복 방지 |
| **Cursor `statsigClientKey` + endpoint verbatim leak** [v15 신발견] | **5** | 4 | **5** | 0 | Csr: `product.json` `client-Bm4HJ0aDjXHQVsoACMREyLNxm5p6zzuzhO50MgtoT5D` + `statsigLogEventProxyUrl: https://api3.cursor.sh/tev1/v1` | feature flag backbone — client key build-time inject, user control 0 |
| **`tengu_*` color-code event families (8 colors)** [v8 신발견] | 0 | 0 | **5** | 0 | Cld: `_cli-symbols.txt` amber(10)/slate(10)/velvet(4)/ashen(1)/willow(1)/crimson(1)/hazel(1)/cedar(1) = 28 events | 색깔 이름이 cohort/feature 분류 — A/B testing per-event level 시사 |
| **quanta agent role enum + 39-nickname pool** [v9 신발견 ADR] | 3 | **5** | 3 | **5** | qta: **ADR-0042** agent-role-enum-maestro-nicknames (explorer/worker/none + 39개 거장 이름 + role→{allowedToolKinds, deniedToolKinds} 명시) | quanta가 Codex nickname pool + role policy 통합 흡수 |
| **quanta async tool kind (defineToolAsync + poll_deferred)** [v9 신발견 ADR] | 0 | 4 | 3 | **5** | qta: **ADR-0287** async-tool-kind + ADR-0286 deferred-result-registry (microtask + AbortController + LRU + 5-state Status) | placeholder yield → handle → final result. dispatch wire `<deferred handle="..."/>` envelope |
| **quanta loop trio integration** [v9 신발견 ADR] | 3 | 4 | 3 | **5** | qta: **ADR-0240** loop-trio-integration (auto-bg accept + automation tick + identity reminder + per-turn identity splice architect/editor mode) | 3개 composition-root 슬롯 in-loop 와이어 — agent 풀체인 |
| **quanta prompt-policy ladder L1-L9** [v9 신발견 ADR] | 0 | 4 | 4 | **5** | qta: **ADR-0016** prompt-policy-ladder-budget-honesty (claim-ladder FACT/INFERENCE/UNKNOWN + honesty-rail + L1-L9 trust gauge) | 모델 coherence 제어 — claim별 trust 등급 |
| **`/$bunfs/root/*.node` 5 native modules embedded** [v8 신발견] | 0 | 0 | **5** | 0 | Cld: `_cli-symbols.txt` image-processor.node / computer-use-swift.node / computer-use-input.node / audio-capture.node / url-handler.node (Bun SEA pattern, 단일 Mach-O binary 내장) | Bun Single Executable Application — Node 네이티브 모듈 5개를 binary 안에 embed |
| `disableSkillShellExecution` policy + bun audit level | 3 | 3 | **5** | 0 | Cld: `_cli-symbols.txt` + `/api/claude_code/policy_limits` (low/moderate/high/critical) | shell exec를 skill 단에서 policy로 block — bun audit과 통합 |

## T. 패치 / Diff / Edit detail [v5 신규 카테고리]

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| apply_patch V4A EBNF | 3 | **5** | 4 | 4 | Cdx: `apply_patch/` + diffy crate · qta: ADR-0028 | `*** Add/Delete/Update File:` + `@@` context anchor + `*** End of File` |
| `*** Move to:` rename atomic | 3 | **5** | 4 | 4 | Cdx: V4A EBNF | rename + edit atomic — 1 patch에 path 이동 |
| `apply_patch 'PATCH'` shell-arg form | 0 | **5** | 4 | 3 | Cdx: prompt "NEVER applypatch or apply-patch" | shell arg 1개로 전달 — agent가 escape하기 쉬움 |
| Fast-apply streamed full-content | **5** | 0 | 0 | 0 | Csr: AiService.StreamFastEdit (25 FastApplyModelType: `_DIFF`/`_REWRITE`/`_NOSPEC` × Codestral V4-V7) | 서버모델 종속 — quanta는 search_replace 유지 |
| `EditResult` typed oneof (Cursor envelope) | **5** | 3 | 3 | 4 | Csr: cursor-agent-exec `success\|file_not_found\|read_perm_denied\|write_perm_denied{is_readonly}\|rejected{reason}\|error{model_visible_error}` · qta: ADR-0114 | is_readonly = "권한없음" vs "readonly 모드 거부" 구분 — model_visible ≠ client_visible |
| `diff_string` + `lines_added/removed` | **5** | 3 | 3 | 3 | Csr: cursor-agent-exec `EditSuccess` | edit 성공 시 diff 본문 + 라인 카운트 wire |
| `after_full_file_content` REQUIRED | **5** | 0 | 0 | 0 | Csr: cursor-agent-exec `EditSuccess.after_full_file_content` | stream_content envelope에 전체 파일 박힘 — fast-apply에 필수 |
| `ReportEditFate` 호출 | **5** | 0 | 0 | 0 | Csr: agent.v1 RPC | edit 성공/실패 fate를 별도 RPC로 보고 — 통계 |
| Moved-code detector (Jaccard weighted) | 3 | 3 | 3 | **5** | qta: ADR-0109 `src/git/moved-code/` (Jaccard similarity weighted multiset) | logic/moved/mechanical/risks 4-kind 구조적 분류 — reviewer 부담↓ |
| MultiEdit baked-in | 4 | 3 | **5** | 3 | Cld: 1급 tool | 1 turn에 여러 edit 묶음 |
| Streamed edit content (no envelope, full-file) | **5** | 0 | 0 | 0 | Csr: AiService.StreamFastEdit | 일반 edit이 not diff — entire file rewrite |
| Apply agent diff | 4 | 3 | 4 | 3 | Csr: agent.v1 `ApplyAgentDiffToolCall` | full diff를 tool로 apply (composer 외부) |
| `*** Environment ID:` (apply_patch context) | 0 | **5** | 0 | 0 | Cdx: V4A EBNF | sandbox env 식별자 박힘 — replay 가능 |

## U. Bench / Eval / Experiments [v5 신규 카테고리]

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| SWE-bench harness (6-pick smoke baseline) | 1 | 0 | 0 | **5** | qta: `tests/smoke/swebench/{picks.jsonl,select.ts}` + ADR-0014 local validator + `QUANTA_REPAIR_ROUNDS=1` | Apple Silicon arm64 namespace=swebench prebuilt + max_workers=1 + 로컬 dataset (x86 conda SIGTRAP 회피) |
| Speculative branch search (N-best verifier-prover) [v3 신발견] | 3 | 0 | 0 | **5** | qta: ADR-0084 src/agent/branch-search/ | Agentless 기법 흡수 — patch candidate N개 병렬 → scorer/selector. SWE-bench SOTA |
| EvalTrackingService 21 Unary methods | **5** | 4 | 4 | 4 | Csr: workbench.desktop.main.js (Ray/S3/Slack training sink write-only) · qta: ADR-0087 storage/schema.ts (Metric+TokenUsage+status+params 흡수) | Cursor는 Ray cluster로 학습 데이터 sink — quanta는 shape만 흡수 |
| Metric{key,value,unit,step} envelope | 3 | 4 | 4 | **5** | qta: ADR-0087 + ADR-0144 src/observability/metrics.ts | 4-tuple metric envelope — step은 training iteration |
| `EXPERIMENT_*` 7 A/B gate | **5** | 3 | 4 | 3 | Csr: workbench `ASK_CODEBASE/CACHE/CHAT_AND_APPLY/SPEC_AND_APPLY/LOOP_ON_LINTS/REFLECT/REWORD_INSTRUCTIONS` | LOOP_ON_LINTS·REFLECT가 흥미 — experiment로 SOTA 패턴 테스트 |
| Statsig + GrowthBook A/B (full stack) | 3 | 4 | **5** | 3 | Cld: `index.js:L67547+67548` statsig.anthropic.com/v1/log_event + GrowthBook 통합 | client-side hardcoded key — server-driven flag |
| `cursor-commits scoreCommit` algorithm | **5** | 3 | 0 | 0 | Csr: cursor-commits/dist/main.js (`score = boundaryScore + contiguousSequenceScore`) | commit diff를 line-level semantic weighting으로 ranking |
| `BugfixVerdict` 5-value [Cursor wave 2] | **5** | 0 | 0 | 0 | Csr: extensionHostProcess.js `UNSPECIFIED\|FIXED\|FALSE_POSITIVE\|COULD_NOT_FIX\|RESOLVED_BY_OTHER_FIX` | bugfix 결과를 typed enum — BugBot 메트릭의 정답지 |
| `PostGenerationEvaluation` 3-value | **5** | 3 | 3 | 3 | Csr: extensionHostProcess.js `USEFUL\|USELESS` (ContextItemStatus 내) | context item이 진짜 도움됐는지 사후 평가 — retrieval 자가 학습 |
| Mock stream framework (1급 시민) | **5** | 3 | 3 | 3 | Csr: sharedProcessMain `mockAgentStreamController`/`mockComposerStreamController` | 테스트 first-class — production code path에 mock seam 박힘 |
| Hellgate adversarial battery | 1 | 1 | 1 | **5** | qta: `tests/**/*-hellgate.test.ts` 17+ batteries + 367 file | 384+ adversarial — "내가 이기는 축" 봉인 |
| `tengu_*` 2053 telemetry family (eval grid) | 3 | 4 | **5** | 3 | Cld: `_cli-symbols.txt:L108092+` | architectural-level instrumentation — spinner/memory/oauth/agent lifecycle 전부 grid |
| `/api/event_logging/batch` aggregator [Claude wave 2] | 3 | 3 | **5** | 3 | Cld: `extr/claude/.vite/build/index.js:L67579` `Promise.allSettled` 듀얼 send (Datadog + Statsig) | 수십 메트릭 한 번에 POST — 둘 다 실패해도 계속 |
| `gO()` buildType + commitHash embedded [Claude wave 2] | 3 | 4 | **5** | 3 | Cld: `index.js:L30409` `commitHash b8f837f8` + `2025-11-14T18:56:13Z` | 모든 이벤트에 commit SHA 자동 — release 추적 |
| `/api/claude_code/organizations/metrics_enabled` gating | 3 | 3 | **5** | 0 | Cld: `_cli-symbols.txt` | org-scope telemetry gating |

## V. 자율 Orchestration / Reactor Taxonomy [v10 신규 카테고리]

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| **자율 wake reason 17-variant taxonomy** | **5** | 0 | 0 | 3 | Csr: `extensionHostProcess.js` SIMULATED_MSG_REASON 17 verbatim · qta: ADR-0132 | ★ Cursor 단독 "agent 자율 wake-up 이유 전수 분류" — paradigm shift marker |
| **HeartBeat RRULE 시간 기반** | 3 | **5** | 3 | 4 | Cdx: `state_5 automation_update` + RRULE matrix (cron hourly+ vs heartbeat sub-minute) · qta: ADR-0215 | 시간 기반 자율 — Cursor "이유 기반"과 직교 |
| **Multiagent coordinator + self-delegation** | 4 | 4 | **5** | 3 | Cld: `multiagent:{type:"coordinator",agents:[1-20]}` + self-delegation | task delegation 기반 자율 — agent가 자기 자신을 sub-task로 호출 |
| **autonomous-proactive-reactor (guard+default-OFF)** | 4 | 3 | 3 | **5** | qta: ADR-0132 (temp cloud branch + simulated msg + 30s guard 3중) | safety-first 자율 — 정확성보다 절제 우선 |
| **Cursor Grind 2-phase (Planning + Execution)** [v10 신발견] | **5** | 0 | 0 | 0 | Csr: `workbench.desktop.main.js:L142586,L142592,L513597` (`start_grind_execution_tool_call` + `start_grind_planning_tool_call` + `grind_mode_config` + `grind_mode_tracking_state_blob_id` L134518-L134689) | 자율 research workflow를 planning → execution 2-phase로 명시화 |
| **Cursor next-edit prediction feedback loop** [v10 신발견] | **5** | 0 | 0 | 0 | Csr: `:L161235,L161341` `cursor_prediction_target` + `is_fused_cursor_prediction_model` + `:L166106,L166112` `accept_cursor_prediction_event` + `reject_cursor_prediction_event` | 사용자 accept/reject 신호가 prediction model에 reinforcement feedback |
| **Cursor Discovery Budget System** [v10 신발견] | **5** | 0 | 0 | 0 | Csr: `:L113387,L113429,L113434` `discovery_budget_reminder` + `discovery_rounds_remaining` + `discovery_effort` enum (LOW/MEDIUM/HIGH) | 자율 탐색을 round 단위로 budget — 무한 탐색 방지 |
| **`CLAUDE_CODE_PLAN_V2_*` multi-agent planning** [v10 신발견] | 0 | 3 | **5** | 0 | Cld: `_cli-symbols.txt` `CLAUDE_CODE_PLAN_V2_AGENT_COUNT` + `PLAN_V2_EXPLORE_AGENT_COUNT` + `PLAN_MODE_INTERVIEW_PHASE` | Plan mode 자체가 multi-agent (explore + plan + interview 3-phase) |

## W. Telemetry Exhaustiveness / Production-scale Observability [v10 신규 카테고리]

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| **Telemetry namespace exhaustive count** | 211 RPC | 70+ OTel canonical | **372 env + 1649+ tengu_*** | ~25 ADR | Cld: `_cli-symbols.txt` 372 `CLAUDE_CODE_*` env (v9 281→**372 verified**) + 1649+ `tengu_*` (v9 1150→**1649 verified**) | Claude의 exhaustive feature-state classification — 모든 동작에 telemetry hook |
| **`tengu_auto_*` 78 subgroup lifecycle** [v10 신발견] | 0 | 0 | **5** | 0 | Cld: tengu_auto_{mode_decision,mode_config,dream_{fired,completed,failed,skipped,toggled},compact_circuit_breaker,compact_rapid_refill_breaker,memory_toggled,mem_tool_denied} 78 events | "auto_dream_fired" 같은 이름 자체가 design signature — telemetry name = architecture description |
| **OTel canonical attribute vocabulary** | 3 | **5** | 4 | 4 | Cdx: `codex.{conversation,thread,turn,mcp,tool,task,multi_agent,startup,sqlite,db,memory,network_proxy,approval}.*` 70+ keys | Codex가 canonical attribute vocabulary 정착 — vendor-agnostic spec 채택 |
| **Production-scale log volume** | (cloud) | **5** | (cloud) | 0 | Cdx: `/userdata/codex/sqlite/logs_2.maxid.txt` **2,096,731,063 approx rows** + 8.5k threads | local production scale 검증 — 단순 dev data 아님 |
| **`_safe`+`_log_only` PII-stripped 2-copy** | 0 | **5** | 0 | 0 | Cdx: logs_2.sqlite | 같은 이벤트의 sanitized + raw 2 카피 — OTLP exporter용 |
| **`/api/event_logging/batch` aggregator** | 3 | 3 | **5** | 0 | Cld: `index.js:L67579` Promise.allSettled 듀얼 sink (Datadog + Statsig) | 둘 다 실패해도 계속 — fire-and-forget 패턴 |
| **`SecureCredentialFileDescriptor` 3-mode** [v10 신발견] | 0 | 0 | **5** | 0 | Cld: `_cli-symbols.txt` `CLAUDE_CODE_{API_KEY,OAUTH_TOKEN,WEBSOCKET_AUTH}_FILE_DESCRIPTOR` | 자식 process에 credential을 fd로 전달 — env var 노출 회피 |
| **PopcornWorkbookPanel 406 Excel function verbatim** [v11 정정] | 0 | **5** | 0 | 0 | Cdx: `PopcornElectronWorkbookPanel-CM0gf_-P.js` (v10 49→**406 verified**: STDEV/VAR/STDEVP/SUM/AVERAGE/VLOOKUP/FILTER/UNIQUE/TRANSPOSE/SUMPRODUCT/NETWORKDAYS/WORKDAY.INTL/DATE/TIME/IF/AND/OR 외 389개) | Codex가 Excel 완전체 vendored — 406 function fully embedded, no dynamic gen |
| **Codex production-scale: 16GB logs / 2.09B rows / 1009 JS / 31 WASM** [v11 신발견] | 0 | **5** | 0 | 0 | Cdx: logs_2.sqlite (16GB+2.09B rows verified) + assets/ 1009 JS files / 113MB / 31 WASM (tree-sitter+codecs) + state_5.sqlite 10 tables (thread_spawn_edges 7.4k / thread_dynamic_tools 10.6k / stage1_outputs 116) | enterprise scale 검증 — 단순 dev data 아님. 16GB log를 sliding window retention으로 cap |
| **Codex SQLite schema 10 tables verified** [v11 신발견] | 0 | **5** | 0 | 0 | Cdx: state_5.sqlite (sqlx_migrations/threads/thread_dynamic_tools/stage1_outputs/jobs/backfill_state/agent_jobs/agent_job_items/thread_spawn_edges/remote_control_enrollments) + 8.5k threads | full schema verified — v6 18 추정 정정 → **10 manifest** |
| **Codex Pet Spritesheet** (TUI persona) [v10 신발견] | 0 | **5** | 0 | 0 | Cdx: persistent.oaistatic.com/codex/pets/v1/ + Dewey/Fireball/Rocky/Seedy/Stacky/BSOD/Null-Signal 6 pet + `pet frame grid must cover spritesheet exactly` validator | TUI에 가상 pet persona — "Codex 자체가 entertainment surface 같이" |

## X. Real-time / Voice / WebRTC [v14 신규 카테고리]

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| **WebRTC SDP negotiation 8-method** | 0 | **5** | 0 | 4 | Cdx: `codex-rs/core/src/realtime_conversation.rs` ThreadRealtime{Start/AudioChunk/AppendAudio/AppendText/Stop/ListVoices/Sdp/Close} · qta: ADR-0208 + ADR-0230 | Codex single-vendor production-grade WebRTC — quanta 흡수 surface-only |
| **RTC SDP 7-stage state machine** | 0 | **5** | 0 | 3 | Cdx: ThreadRealtimeStart 38refs / ThreadRealtimeSdp 9refs / ThreadRealtimeStartedNotification | session lifecycle 7 stage 명시 — UI sync 직결 |
| **WebRTC ICE candidate marshaling** | 0 | **5** | 0 | 0 | Cdx: `WebRTC-ExtraICEPing` + `last_ping_sent` tracking + "Failed to connect realtime WebRTC" | explicit ICE marshaling — server VAD와 orthogonal |
| **VAD client/server split (PCM input)** | 0 | **5** | 0 | 0 | Cdx: `codex_realtime_voice_pcm` + `codex_realtime_voice_vad` + "SDP munging: audio codecs added/removed" | server VAD (OpenAI) + client PCM input — codec filtration 단계 |
| **Voice mute = out-of-band text injection** | 0 | **5** | 0 | 0 | Cdx: "Update mute (voice processing)" + `ThreadRealtimeAppendText` 우회 | session 안 끊고 modality 전환 — voice→text transparent 우회 |
| **Realtime conversation event 5-stream** | 0 | **5** | 0 | 3 | Cdx: `realtime_conversation_{started,audio,text,sdp,closed}` | session lifecycle 5-state stream |
| **`RealtimePort` 4-state lifecycle (closed→connecting→open→closing)** [v14 신발견] | 0 | 4 | 0 | **5** | qta: **ADR-0230 realtime-websocket-codex** (RealtimePort.connect/close/status + createBunWebSocketAdapter) | state-query 1급 method — quanta 단독 typed lifecycle |
| **AudioCodec negotiation marker (PCM/Opus)** [v14 신발견] | 0 | **5** | 0 | 4 | Cdx: codec munging chain · qta: `negotiateCodec(offered,supported)` pure fn | encode/decode는 follow-up — marker 보존 invariant 우선 |
| **Bidirectional FIFO frame ordering + binary pass-through** [v14 신발견] | 0 | 4 | 0 | **5** | qta: ADR-0230 `RealtimePort.send/onMessage` symmetric | binary chunk round-trip 보증 — quanta 단독 typed contract |
| **Voice / STT (modality slot)** | 3 | **5** | 4 | 4 | qta: ADR-0208 voice + 3 adapter (STT/recorder/echo-cancel) | quanta ADR-0208 3-adapter family + Codex production WebRTC |
| **Realtime audio handoff (session switching)** [v14 신발견] | 0 | **5** | 0 | 0 | Cdx: `RealtimeHandoffRequested` event (4 params + session metadata) | session 중간 audio session 자체 교체 — WebRTC re-negotiate 없이 |

## Y. Build / Distribution / Update [v14 신규 카테고리]

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| **Sparkle 7 flavor + EdDSA pinned** | 4 | **5** | 4 | 0 | Cdx: 7 flavor(Dev/InternalAlpha/Nightly/Owl/Agent/PublicBeta/Prod) + SUPublicEDKey `mNfr1v9t63BfgD...` | flavor별 icon+feed path 분리 + EdDSA pinning |
| **Sparkle feed runtime injection (build-time)** | 0 | **5** | 0 | 0 | Cdx: `package.json:L101-102` codexSparkleFeedUrl + codexSparklePublicKey verbatim (Info.plist 아님) | EdDSA key가 build-time inject — runtime config 회피, security boundary 명확 |
| **`appcast.xml` CDN feed schema** [v14 신발견] | 4 | **5** | 4 | 0 | Cdx: persistent.oaistatic.com/codex-app-prod/appcast.xml + Sparkle v7 XML 형식 | DMG distribution artifact + multiple path pool (pets/v1 + app-prod 분리) |
| **Codex.dmg + `hdiutil` distribution chain** [v14 신발견] | 0 | **5** | 0 | 0 | Cdx: "Mounting Codex Desktop installer..." + `/Volumes/codex-app-installer-` + `hdiutil attach/detach` | macOS DMG mount/detach 자동 — installer chain 풀 control |
| **electron-forge maker 6-platform** [v14 신발견] | 4 | **5** | 4 | 0 | Cdx: `rebuild:native-modules && rebuild:forge-natives && electron-forge {package\|make\|publish}` + maker-{dmg/deb/rpm/squirrel/zip/msix} v7.11.1 | DMG/DEB/RPM/Squirrel(Windows)/ZIP/MSIX 6-platform 통합 빌드 |
| **Native module rebuild chain (31 WASM)** [v14 신발견] | 4 | **5** | 4 | 0 | Cdx: `prepare-dev` + `rebuild:native-modules.mjs` orchestrates node-gyp/node-addon-api + tree-sitter + codecs (31 WASM) | node native + WASM 통합 컴파일 — better-sqlite3/pty/objc-js per platform rebuild |
| **Bun SEA pattern (5 .node embedded)** [v10 보강] | 0 | 0 | **5** | 0 | Cld: `/$bunfs/root/*.node` (image-processor + computer-use-swift + computer-use-input + audio-capture + url-handler) — 단일 Mach-O binary 내장 | Bun Single Executable Application — 5 .node binary 안 embed |
| **Claude Squirrel install + Touch ID** [v14 신발견] | 0 | 0 | **5** | 0 | Cld: Squirrel.Windows updater + 4-signal (install/updated/obsolete/uninstall) + Touch ID cert chain | Windows updater Sparkle 대안 — ownership-fix Touch ID flow |
| **Claude 18-year Developer ID Profile** | 0 | 4 | **5** | 0 | Cld: Bundle `com.anthropic.claudefordesktop` + Team `Q6L2SF6YDW` Anthropic PBC + valid 2026-04-30 ~ 2044-04-25 | Developer ID 서명 (App Store 아님) + hardened runtime + virtualization entitlement |
| **microVM build artifact (rootfs.img.zst + sessiondata.img)** | 0 | 0 | **5** | 0 | Cld: `vm_bundles/claudevm.bundle/` rootfs.img.zst(압축) + rootfs.img(전개) + sessiondata.img(RW) + vmIP/machineIdentifier/gvisorMacAddress | rootfs RO + sessiondata RW (COW pattern) — vendored microVM |
| **Statsig/GrowthBook gradual rollout (95→5%)** [v14 신발견] | 4 | 3 | **5** | 3 | Cld: `statsig.anthropic.com/v1/log_event` + GrowthBook split (canary gate strategy) | 95→5% gradual rollout — version 별 statsig variant 세분화 |
| **Cursor cloudflare CDN + retry** [v14 신발견] | **5** | 3 | 4 | 0 | Csr: api3.cursor.sh + cloudflare pool + retry + canary gate (statsig) | binary distribution을 CDN으로 — fallback retry policy 명시 |
| **codexSparklePublicKey verbatim EdDSA pin** | 0 | **5** | 0 | 0 | Cdx: `mNfr1v9t63BfgDtlw4C8lRvSY6uMggIXABDOCi3tS6k=` (EdDSA public key build-time inject) | EdDSA key 자체가 build artifact에 박힘 — rotation 위해서는 새 binary 필요 (의도적 immutable) |

---

## 한눈 요약

### quanta 5점 단독 (정직성·하드게이트 축)
verify-guard / closeout-4truth / hellgate / parse-test-failure / fs-jail brand / HARD_DENY 9-rule / secret 10-regex+entropy+Luhn / PII redaction / stream HOL+ordering / queued-follow-up superset / per-tool+per-turn checkpoint / 9-git-tool / token-budget breaker / multi-source rules detector / Anthropic prompt-cache tracker / compaction breaker / hard abort fence

### 카테고리별 우위
- **Cursor**: 도구레이어·IDE 통합·Background-PR·Retrieval(13 reranker)·Mock·Cmd-K·Tab·자율 reactor
- **Codex**: 모델/메모리 인프라·Sandbox/Seatbelt·Reverse MCP·Subagent tool·Popcorn 4-channel·Personality slot·encrypted reasoning
- **Claude**: MCP 표준 확장·MDM·팀-메모리·microVM·Disclaimer wrapper·section cache·multi-cloud
- **quanta**: 검증·정직성·정책 게이트

### ★★★ 최대 갭 (paradigm-level)
1. `SIMULATED_MSG_REASON_*` 자율 reactor (Cursor 단독)
2. OS sandbox/microVM (3사 모두 풀, quanta=Docker optional)
3. Computer Use / Browser engine (3사 풀, quanta 0)
4. Fast-Apply 25-model + Cmd-K warming triple
5. Cloud handoff + multi-device sync
6. 13-reranker hybrid retrieval
7. GUI surface (quanta=CLI-only by design)

### 의식적 negative invariant (절대 안 함)
Chronicle ambient 1388 summaries · TCC.db 직접 read · AI-tracking hash DB(metric inflation) · 잠금화면 auto-unlock · Apple Events 마케팅 과장 · Popcorn 4-채널 · DeviceCheck platform 강제 · NSAllowsArbitraryLoads · Sparkle feed runtime injection · accepted_line_fingerprints 류 라인 analytics · analytics queue 강제 · 평문 OAuth client_id

---

## Verification status & 후속

### 검증 강도 분류

| 셀 종류 | 신뢰도 | 본 표 비중 |
|---|---|---|
| **A** quanta 5점 + ADR 파일명 ls 확인됨 (`docs/decisions/00XX-*.md` 실존) | 높음 | ~25% |
| **B** 경쟁사 메모리 + `.extracted_source/` path 박힘 (memory snapshot 시점 검증) | 중간 | ~50% |
| **C** 점수 매핑 (0~5 정성 판단, 특히 중간값 2/3/4) | **휴리스틱** | ~25% |

### Spot-check 결과 (2026-05-26 병렬 검증, 4 agent)

**quanta ADR 정밀 매핑** (Agent A, 4/4 hit):
| 메모리 claim | 실제 ADR# |
|---|---|
| ContextProvider = ADR-0096 | → **ADR-0080-ide-context-provider-seam.md** |
| PhaseGate = ADR-0097 | → **ADR-0088-phasegate-hitl-ladder.md** |
| reflect-gate = ADR-0098 | → **ADR-0089-lint-grounded-reflect.md** |
| PII redaction = ADR-0168 | → **ADR-0171-pii-redaction.md** |

→ 메모리는 user-deference renumber로 stale. 표는 정정 반영.

**Cursor claim grep** (Agent B, **5/5 hit · 100%**):
1. `SIMULATED_MSG_REASON_PLAN_EXECUTION` ✓ @ extr/cursor/out/vs/workbench/api/node/extensionHostProcess.js
2. `BUGBOT_AUTOFIX_MODE_AUTO_MERGE` ✓ @ extensionHostProcess.js
3. `tinderdiffeditor` ✓ @ extr/cursor/out/cli.js + workbench
4. `agent.v1` ✓ @ extr/cursor/out/vs/workbench/workbench.desktop.main.js
5. `RerankerAlgorithm` ✓ @ extensionHostWorkerMain.js (LULEA, UMEA 포함 12 variant)

**Codex claim grep** (Agent C, **5/5 hit · 100%**):
1. `codex_lmstudio/ollama` ✓ @ extr/codex-cli/_cli-symbols.txt:L53168
2. `codex_rmcp_client` ✓ @ extr/codex-cli/_cli-symbols.txt:L48629
3. `personality_default/friendly` ✓ @ extr/codex-cli/_cli-symbols.txt:L48563
4. `auto_review/guardian_subagent` ✓ @ extr/codex/webview/assets/use-permissions-mode-Ch7rOI7L.js
5. `*** Move to:` (V4A) ✓ @ codex-cli patch grammar

**Claude claim grep** (Agent D, **4/5 hit**):
1. `CLAUDE_CODE_USE_FOUNDRY` ✓ @ extr/claude-code-cli/_cli-symbols.txt (21 occurrences)
2. `team_memory` ✓ @ _cli-symbols.txt (27 refs + 2 API endpoint)
3. `tasks/list` ✓ (7회) — **`TaskMessageQueue` miss** (관련 없는 queueMicrotask만)
4. `FloatingPenguinMini` **❌ MISS** — "Penguin" codename은 hit이지만 정확한 명칭 미발견 (minified 변화 또는 메모리 부정확)
5. `POSIX_SPAWN_SETDISCLAIM` ✓ + `disclaimer` ✓ @ userdata/claude shell wrapper

**총괄: 19/20 cell hit · 95% accuracy.** 메모리가 거의 정확했고, 1건만 보수화 필요 (FloatingPenguinMini).

### Draft v15 — wave 12 (2026-05-26 #15, 4-agent: Cursor 9 + Codex 12 + Claude 80+ items in 10 groups + quanta 12 ADR = **65 신발견** + 2 정정)

**v15 표 반영: 13 신규 row + 2 정정**:
- **★ quanta GitHub trunk 4 ADR 발굴**: 0311 github-actions-trigger-adapter / 0312 github-app-webhook-host-scaffold / 0313 pr-output-sink-redaction / 0314 mention-filter-trust-scope (★ paradigm-level new domain)
- **★ quanta 추가 ADR 3개**: 0271 why-meta-LLM / 0297 CliFeatureConfig unification / 0307 repl-host-slim-down
- Cursor: Sentry 37-type integration / cursorTrustedExtensionAuthAccess whitelist / cursorTracing API proposal / statsigClientKey verbatim + endpoint leak / Anysphere fork mapping 8-path
- Codex: 41 codex_* crate verified (v9 42 → 41) / 123 rollout summaries timestamped / transcription-history.jsonl multilingual
- Claude: 11 MCP tool verbatim (v12 13 → 11 정확) / /api/oauth/* 8 endpoints + tengu_ 32 sub-family (advisor 6 / vertex 9 / voice 6 / worktree 7 / ws_transport 4)

**v15 ★ 정정**:
- Codex codex_* crate: v9 42 → **41 verified manifest**
- Claude MCP tool: v12 13 → **11 verified**
- Claude /api/oauth/*: v7 6 → **8 verified**

**v15 미반영 (verification only)**:
- Cursor: Sentry 11 payload traces / Policy Watcher SCMInputFontSize/DisableFeedback/UpdateMode 3-field / webviewContentExternalBaseUrlTemplate UUID isolation / HallucinatedFunctionsProtoPrompt service v2 stable / MCP OAuth 8-layer concurrency patch
- Codex: 64 native-menu-locale + main-BwqrdVu3.js 1.6MB + worker.js 1.7MB / 16 shell snapshots UUID-keyed / agent_jobs/agent_job_items/backfill_state SQLite 3-table schema / OAuth flow react component
- Claude: handoff/chrome-native-host/mid-conversation/disclaimer 4 function / oauth_error_{status,type} / tengu_fork_{agent_query,subagent_enabled} / mcp__ide__{getDiagnostics,executeCode} verbatim
- quanta: ADR-0049 portlet-seam-isolation / 0051 tier-1-entrypoint-ratchet / 0055 closure-cell-pattern / 0063 no-cross-surface-imports / 0065 env-override-flag-precedence / 0068 port-injection-surface-contract / 0073 typecheck-biome-ratchet-gate

### Draft v14 wave 11 — ★ 자율주행 종료 (2026-05-26 #14, final synthesis + X/Y 신규 카테고리)

**v14 표 반영: X/Y 2 신규 카테고리 + 23 row 추가**:
- **X. Real-time/Voice/WebRTC 카테고리 신설 (11 row)**: WebRTC SDP 8-method · RTC SDP 7-stage · ICE candidate marshaling · VAD client/server PCM split · Voice mute out-of-band · Realtime event 5-stream · RealtimePort 4-state lifecycle · AudioCodec negotiation marker · Bidirectional FIFO frame · Voice STT modality slot · Realtime audio handoff
- **Y. Build/Distribution/Update 카테고리 신설 (13 row)**: Sparkle 7 flavor EdDSA · feed runtime injection · appcast.xml CDN schema · Codex.dmg hdiutil chain · electron-forge maker 6-platform · native rebuild 31 WASM · Bun SEA 5 .node · Squirrel install + Touch ID · 18-year Developer ID · microVM build artifact · Statsig/GrowthBook 95→5% gradual rollout · Cursor cloudflare CDN + retry · codexSparklePublicKey verbatim EdDSA pin

**v14 핵심 통찰** (cross-vendor convergence):
1. **X (Real-time/Voice) — Codex 단독 production-grade**: WebRTC SDP + 7-stage + ICE + VAD split + voice mute out-of-band injection 모두 5점. Claude/Cursor 0점 (voice 1-shot STT만). quanta ADR-0208+0230 surface-only MVP
2. **Y (Build/Distribution) — Codex/Claude 양강**: Codex Sparkle+EdDSA build-time + electron-forge 6-platform + 31 WASM rebuild. Claude Squirrel+18-year DevID+microVM artifact+Statsig gradual rollout. Cursor cloudflare CDN. quanta CLI-only로 0점
3. **paradigm shift in v14**: "build-to-ship orchestration"이 4-vendor 3개 production-grade 달성 → **Y는 cross-vendor convergence zone** (선택 기준이 design decision)
4. **negative invariant**: Sparkle feed URL runtime injection (Codex)는 Info.plist 아님 — 보안 boundary 명확
5. **★ 자율주행 종료 신호**: v10 (586+) → v14 (758+) = 172 신발견 net + 2 신규 카테고리 (X/Y) + 7 count 정정. 매 wave 신발견 sparse 패턴 — 새 영역 좁아짐 의미

### Draft v13 wave 10 (2026-05-26 #13, 4-agent: Cursor 12 + Codex 11 + Claude 0(failed) + quanta 12 = **35 신발견**)

**v13 표 반영: 12 신규 row**:
- A 루프: RTC SDP 7-stage + ICE candidates · Voice mute out-of-band text injection
- K UX: Sparkle feed runtime injection (codexSparkleFeedUrl + codexSparklePublicKey verbatim) · Codex.dmg distribution chain · electron-forge maker 6-platform
- L IPC: Cursor 60 aiserver.v1 + 13,528 protobuf stubs · cursor-proclist native binding 7-tuple
- G 검증: ratchet-proof rail (ADR-0057) · heuristic-ban registry (ADR-0053)
- A 루프: streaming-dispatch-overlap (ADR-0059) · per-turn-mutable-authority (ADR-0061) · caller-side-wrapper-seam (ADR-0067)

**v13 미반영 (verification)**:
- Cursor: CursorPredictionService AcceptCursorPredictionEvent / TextMateTokenizer Worker / ShadowWorkspaceService ephemeral / best_of_n_group_id + try_use_best_of_n_promotion + free_best_of_n_promotion / AggMetricBatcher (A0s) timeout-driven flush / Sentry 38 trace types / CursorIgnoreControls.hierarchicalEnabled+ignoreSymlinks / FileChangesAggregator vscode-watcher-snapshot
- Codex: VAD PCM split + ICE-ExtraICEPing / persistent.oaistatic.com/codex-app-prod/appcast.xml feed schema / pets/v1/codex-spritesheet-v4.webp / prepare-dev + rebuild:native-modules pnpm
- quanta: ADR-0049 portlet-seam-isolation / 0051 tier-1-entrypoint-ratchet / 0055 closure-cell-pattern / 0063 no-cross-surface-imports / 0065 env-override-flag-precedence / 0068 port-injection-surface-contract / 0073 typecheck-biome-ratchet-gate

### Draft v12 wave 9 (2026-05-26 #12, 4-agent: Cursor 14 + Codex 15 + Claude 10 + quanta 10 = **49 신발견** + 1 count 정정)

**v12 표 반영: 10 신규 row + 1 정정**:
- **★ Codex Rule-DSL count: 1060 → 1062 verified**
- 신규: StreamUiBestOfNJudge 3-transport · HallucinatedFunctionsService Opus2 3-step chain · _boundaryScore/_contiguousSequenceScore 수식 verbatim · Cursor 60+ MainThread shape services · FastApplyService+FastSearchService · ToolCallEventService+ProfilingService · Codex Vite 1009 JS+31 WASM · Codex Session JSONL+Index Twin (947KB+670KB dual-write) · Claude 13 MCP tool namespace verbatim · Claude Hook block 3-pair · Claude 5 Worktree config · quanta ADR-0278/0279/0280 automation chain

**v12 미반영 (verification)**:
- Cursor: CursorPredictionService AcceptCursorPredictionEvent pipeline / TextMate Tokenization grammar / best_of_n_group_id + try_use_best_of_n_promotion / ShadowWorkspaceService ephemeral
- Codex: codex-dev.db automations/automation_runs/inbox_items + RRULE rrule TEXT column / Memory Rollout Summaries 125 subdirs / 65 native menu locale files / app-session-O7kcZj7R.js 4.6MB / Skill registry vendored versioned 26.521.10419 / Shell Snapshot Isolation 1.4MB 18 dirs / Transcript+Voice History append-only / Config Vendor Imports offline-first
- Claude: 32 tengu_{advisor,vertex,voice,worktree,ws_transport} / 14 API endpoints 풀 (claude_code+oauth) / 50+ Environment Control Flags / 8+ Feature Gates / Advisor model + voice events

### Draft v11 wave 8 깊이 (2026-05-26 #11, 4-agent: Cursor 15 + Codex 15 + Claude 0(failed) + quanta 18 = **48 신발견** + 2 count 정정)

**v11 표 반영: 11 신규 row + 2 정정**:
- **★ Codex Excel functions: v10 49 → v11 406 verified** (PopcornElectronWorkbookPanel-CM0gf_-P.js verbatim, vendored Office formula engine)
- **★ Cursor SubagentType: v6 9 → v11 11 manifest** (+ CUSTOM + UNSPECIFIED)
- 신규: Codex 16GB logs / 2.09B rows production scale + 10 SQLite tables manifest + 1009 JS / 113MB / 31 WASM
- 신규: Cursor InjectedText 8-variants + DiffEditor 27+ components + Subagent state 80+ patterns
- 신규 quanta ADR: 0023 byte-identical SOTA++ / 0027 anti-signals+injection hardening / 0032 OTel canonical / 0044 negative invariants / 0046 permission stack 3-layered / 0251 streaming boomerang / 0254 semantic-search port / 0255 cross-subagent todo readback / 0256 role-based model override

**v11 line-exact 핵심**:
- Cursor: SubagentType 11 verbatim (+ CUSTOM/UNSPECIFIED) / InjectedText 8 variant + L27446-L33906 / DiffEditor 27+ (Hunk/Selection/Contribution/Widget/ViewModel/ViewState toolbars) / Subagent state 80+ pattern
- Codex: PopcornElectronWorkbookPanel 406 Excel functions verbatim / logs_2.sqlite 16GB + 2.09B rows / state_5.sqlite 10 table manifest (thread_spawn_edges 7.4k row + thread_dynamic_tools 10.6k row + stage1_outputs 116 row) / app-session-O7kcZj7R.js 43.3k lines / 1009 JS files / 31 WASM (tree-sitter+codecs) / 64 locale files / 3023 Rust panic-site paths

**v11 미반영 (verification)**:
- Cursor: MainThreadLocalization/Mcp/NotebookDocuments/NotebookEditors 4 Shape services / HallucinatedFunctions 2 core / `_boundaryScore` + `_contiguousSequenceScore` 함수 / workspace_trust_controls 2 fields / external_source_metadata field
- Codex: comment-preload.js 384k lines / 1060 prefix-based rules / vendor_imports/ 7.6MB / skills/ 500KB / sandbox-preload 76 lines / plugins/cache versioned 26.521.10419
- quanta: ADR-0005 (의도적 결번) / 0009 LSP diagnostics / 0010 trajectory observability / 0012 LoC budget retire / 0035 JSONL cumulative retention / 0036 plan mode dispatch seam-block / 0037 queued follow-ups / 0039 plugin manifest layout / 0043 desktop surface reference / 0250 inline-trigger Aider-style / 0252 template-literal expander Windsurf / 0253 Devin playbook→bun:test / 0257 AI-attribution training-data search / 0275 real-API smoke eval

### Draft v10 wave 7 깊이 + V/W 신규 카테고리 (2026-05-26 #10, 4-agent: Cursor 18 + Codex 22 + Claude 17 + Cross-vendor 17 = **74 신발견** + 1 count 정정 + V/W 신규 카테고리)

**v10 표 반영: V/W 카테고리 +17 row + 정정**:
- **V. 자율 Orchestration / Reactor Taxonomy 신규 카테고리 (8 row)**: SIMULATED_MSG_REASON 17-variant taxonomy / HeartBeat RRULE / Multiagent coordinator+self-delegation / autonomous-proactive-reactor (quanta) / Cursor Grind 2-phase (Planning+Execution) / cursor_prediction_target feedback loop / Discovery Budget (effort enum LOW/MED/HIGH) / CLAUDE_CODE_PLAN_V2_* multi-agent planning
- **W. Telemetry Exhaustiveness / Production-scale 신규 카테고리 (9 row)**: 372 CLAUDE_CODE_* + 1649+ tengu_* count verified / tengu_auto_ 78 subgroup / OTel canonical 70+ / 2.096B log row production scale / _safe+_log_only 2-copy / /api/event_logging/batch dual sink / SecureCredentialFileDescriptor 3-mode / PopcornWorkbookPanel 49 Excel verbatim / Codex Pet Spritesheet 6-persona

**v10 ★ 정정**:
- CLAUDE_CODE_* env: v7 243 → v9 281 → **v10 372 verified**
- tengu_* count: v4 2053(occurrences) → v6 1150 → **v10 1649 manifest verified**

**v10 cross-vendor convergence 핵심 17 비교 관찰 (분리 섹션 보고)**:
- **OAuth PKCE S256**: Cursor/Codex/Claude 3-vendor 완전 수렴 (secrets 미저장)
- **OS-level sandbox**: 3-vendor 모두 채택 (quanta 단독 갭, ★★★)
- **Subagent fork**: Cursor 6-category(legacy) → Codex/Claude spawn+personality(modern)
- **Voice modality**: Codex 단독 WebRTC (out-of-band text injection)
- **Auto-compact trigger**: Codex 5-axis(formal) / Claude AUTO_COMPACT_WINDOW(economic) / quanta 4-truth(quality gate)
- **6 model enum verbatim**: 3-vendor에 gpt-5.5 언급 (Cursor composer-1 leak / Codex NUX step 4 / Claude explicit enum + claude-mythos preview)
- **tengu_auto_dream** name = "design signature" (telemetry naming as architecture)

**v10 line-exact 핵심**:
- Cursor: `:L142586,L142592,L513597` Grind start_grind_execution/start_grind_planning_tool_call + L134518-L134689 grind_mode_config / `:L161235,L161341` cursor_prediction_target+is_fused_cursor_prediction_model / `:L166106,L166112` accept/reject_cursor_prediction_event / `:L113387,L113429,L113434` discovery_budget+rounds_remaining+effort / `:L126811,L563419,L842415` ContextPlannerCapability / `:L1154330` MainThreadMcp + 89 MainThread services
- Codex: `PopcornElectronWorkbookPanel-CM0gf_-P.js` 49 Excel functions / persistent.oaistatic.com/codex/pets/v1/ 6 pet spritesheet / `logs_2.maxid.txt` 2,096,731,063 rows / sandbox-preload 12-port verbatim
- Claude: `CLAUDE_CODE_PLAN_V2_AGENT_COUNT` + PLAN_V2_EXPLORE_AGENT_COUNT + PLAN_MODE_INTERVIEW_PHASE / `tengu_auto_*` 78 (auto_dream_fired/completed/failed/skipped/toggled) / `CLAUDE_CODE_{API_KEY,OAUTH_TOKEN,WEBSOCKET_AUTH}_FILE_DESCRIPTOR` 3-mode

**v10 미반영 (verification)**:
- Cursor: _decorationsTree + InjectedText 11 variants (L27446-L33906) / DiffEditorHunkToolbar / AgentToolDefinition.inputSchema (L493620) / Stream ChunkIdentity (L151111) / 89 MainThread services
- Codex: 65 native menu locales / app-session-O7kcZj7R.js 43k lines / Sandbox-preload bootstrap detail / 8.5k threads SQLite scale
- Claude: tengu_api 47 / tengu_voice 6 / tengu_worktree 7 / `CLAUDE_CODE_IS_COWORK` + `USE_COWORK_PLUGINS` flag / handoff() function
- Cross-vendor convergence 17 비교 관찰 (별도 documentation 권장)

### Draft v9 wave 6 깊이 (2026-05-26 #9, 4-agent: Cursor 25 + Codex 22 + Claude 21 + quanta 20 = **88 신발견** + 3 정정)

**v9 표 반영: 16 신규 row + 4 정정**:
- ★ codex_* crate count **131→42 verified manifest** (v8 잘못 박힘 → 정정)
- ★ CLAUDE_CODE_* env **243→281**
- ★ ANTHROPIC_* env **48→42**
- ★ /api/claude_code/* endpoint **36→8** + **/api/oauth/* 6** 분리
- ★ tengu_* 1150 verified (v4 2053 / v6 1150 차이 — 1150 manifest, 2053은 occurrences)
- 신규 row: codex_memories_write Phase 1/2 detail / codex_hooks Guardian / Credential store 3-mode / model_instructions_file / 6 model enum verbatim / 1150 tengu_ 9-cluster taxonomy / Cursor Git context provider 15+ method / Cursor worktree integration / Cursor fork 6-category / Cursor MainThread/ExtHost RPC + 3 native modules / quanta agent-role enum + nickname + async tool kind + loop trio + prompt-policy ladder

**v9 line-exact 핵심**:
- Cursor: extension 3-tier dep graph (cursor-checkout→cursor-resolver→cursor-socket) / 3 native modules / `out/vs/{base,code,editor,glass,platform,workbench}/` / MainThread/ExtHost proxy + 15+ ToolCall protobuf types / Git context provider 15+ method / worktreeComposerMappings
- Codex: 42 crate verified manifest / codex_memories_write phase1/phase2/runtime/storage.rs / codex_hooks guardian/review_session.rs / codex_network_proxy mitm.rs + network_policy.rs + connect_policy.rs / codex_sandboxing dynamic policy (Seatbelt+seccomp) / codex_state SQLite migrations / codex_rollout experiment + SQLite columns / Codex.toml `cli_auth_credentials_store` + `model_instructions_file`
- Claude: 281 CLAUDE_CODE_* verified / 42 ANTHROPIC_* / 6 model enum (gpt-5.5 frontier + 5.4 + claude-mythos preview + opus/sonnet/haiku) / 1150 tengu_ family 9-cluster (auto_ 78개 최대) / 8 /api/claude_code/* + 6 /api/oauth/* 14 endpoint
- quanta: ADR-0003 test-pyramid 5-tier · ADR-0006 runtime-sandbox OS-agnostic port · ADR-0016 prompt-policy-ladder L1-L9 · ADR-0018 mode-enum plan-review-audit · ADR-0019 code-mod edit-strategy 4-surface · ADR-0040 skills vs extensions split · ADR-0041 subagent 6-tool standard · ADR-0042 agent role enum + maestro nicknames · ADR-0050 trust-scope registry wire-up · ADR-0100 destructive git HARD_DENY 6 rules · ADR-0128 plan-queue helper 12-field · ADR-0129 localize recall@1 closure · ADR-0131 memory outcome grammar 4-state · ADR-0206 per-thread dynamic tools · ADR-0214 typed LLMErrorKind 16 · ADR-0220 git directive emit · ADR-0240 loop trio · ADR-0286/0287 async tool kind

### Draft v8 wave 5 깊이 (2026-05-26 #8, 4-agent: Cursor 18 + Codex 25 + Claude 23 + quanta 20 = **86 신발견**)

**v8 표 반영: 18 신규 row + 2 정정**:
- **A 루프**: UnifiedMode 6-mode + ThinkingLevel 3-tier + ComposerCheckpointService Git-like + GetLatestAgentConversationState cloud-backed + ConversationState resumable
- **B 도구**: bestOfNDefaultModels production verbatim · SwWriteTextFileWithLintsRequest + FixLintsSubagent
- **F 샌드박스**: Skybridge CSP triple validation · initId 128-char · 12-port whitelist
- **H 메모리**: Cross-session memory inject (ADR-0282) · ConversationState
- **K UX**: AppleScript 300KB syntax bundle · PopcornWorkbookPanel 80+ Excel function · context-compaction first-class event
- **P 자율**: Automation RRULE matrix (cron hourly+ vs heartbeat sub-minute) · TOML registry
- **I 모델**: 9 anthropic-beta version stratification + 131 codex_* crate verified
- **S 보안**: computer-use.lock mutex · tengu_* color-code 8 families · `/$bunfs/root/*.node` 5 modules

**v8 line-exact 핵심**:
- Cursor: `workbench.desktop.main.js:L845457` UnifiedMode + `:L150461` ThinkingLevel + `:L201715` bestOfNDefaultModels verbatim 3-model + `:L565319-L566183` StreamUnifiedChat Req/Resp + `:L147784` SwWriteTextFileWithLints + `:L154954` FixLintsSubagent + `:L959934` ComposerCheckpointService + `:L971104` acceptPlan + `:L962479` removeMessagesAfterBubble + `:L793407,L1196550` GetLatestAgentConversationState + `:L823789` StreamComposer + `:L694679` ConversationState + `:L102583` AiAttribution per-tool
- Codex: `sandbox-preload.js:L39-L41` CSP triple + `:L26-27` initId regex + `:L49,L64-71` 12 ports + `applescript-BBCXWTjO.js` 300KB + `PopcornElectronWorkbookPanel-CM0gf_-P.js` 80+ functions + `local-conversation-thread-BX7YNcUw.js` context-compaction case + cron vs heartbeat RRULE + 131 crate verified
- Claude: `mainView.js` claude.settings.MCP `getMcpServersConfigWithStatus`+revealLogs / claude.web.DeepLink handleDeepLink / claude.hybrid.DesktopIntl / claude.internal.ui + tengu_* 8 color families (amber/slate/velvet/ashen/willow/crimson/hazel/cedar) + 9 beta API verbatim (token-counting-2024-11-01 외) + Bun SEA pattern 5 .node modules
- quanta: ADR-0282 cross-session memory · ADR-0292 conv-checkpoint-auto-record · ADR-0303 thin-surface-headless-core · ADR-0260 BM25+ripgrep · ADR-0261 pluggable embedder registry · ADR-0287 async-tool-kind-poll-deferred · ADR-0246 bridge-attestation-sts

**v8 미반영 신발견 50+ (verification만)**:
- Cursor: _decorationsTree InjectedText system L51114+ / Extension Priority Tiers (RBu always-local / VKl remote-safe) / StreamComposer vs StreamChat 분리
- Codex: ProseEditor CRDT comment-node offset / Workbook CRDT empty-state sentinel / speed bias affects chats+subagents+compaction together / Skybridge sandbox-preload.js bootstrap
- Claude: mcp__claude-in-chrome__{tabs_context_mcp,gif_creator} (tabs_context_mcp must be called first) / structured-outputs-2025-12-15 / message-batches-2024-09-24 / token-counting-2024-11-01 verbatim
- quanta: ADR-0228 queued-followup-per-msg-mutators / ADR-0243 n-phase-hitl / ADR-0298 subagent-fanout-parallel / ADR-0265 search-pipeline-composer / ADR-0276 multimodal-embedding-mvp / ADR-0277 codebase-indexer / ADR-0230 realtime-websocket-codex / ADR-0308/0309/0310 multi-surface composition

### Draft v7 wave 4 깊이 (2026-05-26 #7, 3-agent: Cursor 22 + Codex 28 + Claude 24 = **74 신발견** + 3 count 정정)

**v7 표 반영: 12 신규 row + 3 count 정정**:
- **T 패치**: 3-phase warming line-exact / ComposerCapabilityRequest 15-subtype
- **A 루프**: Submission 11-variant verbatim (메모리 6→11 정정) / Realtime Conversation Stack WebRTC / Realtime event 5-stream
- **F 샌드박스**: GuardianAssessmentEvent 4-action
- **L IPC**: Claude 7 IPC namespace + 79 method verbatim
- **I 모델**: **CLAUDE_CODE_* 10→243** · **ANTHROPIC_* 22→48** · **/api/claude_code/* 10→36** · PKCE OAuth Desktop S256
- **K UX**: OpenDocuments IPC · Slack marketplace · 3 parallel runtime workers

**v7 line-exact 핵심**:
- Cursor: `extensionHostProcess.js:L158715` PreloadEditRequest / `:L143669` WarmApplyRequest / `:L158457` StreamFastEditRequest / `:L131774-L132665` ComposerCapabilityRequest 15-subtype / `:L102071` ConversationAction / `:L105778` AskQuestionInteractionQuery (allow_multiple+selected_option_ids) / `:L102377` BackgroundSubagentAction / `:L146896-L147669` UsageEventDetails 7-subtype / `:L229434` PreWarmPodRequest / `:L130131` ShadowHealthCheckRequest
- Codex: `codex-rs/core/src/{realtime_conversation,realtime_context}.rs` + 8 ThreadRealtime method / WAL_AUTOCHECKPOINT=1000+WAL_SYNCHRONOUS=2 / OAuth client_id `app_EMoamEEZ73f0CkXaXp7hram` / runtime worker 3.8MB+2.2MB×2 verified
- Claude: 7 IPC namespace + 79 method 풀 매핑 / 243 CLAUDE_CODE_* + 48 ANTHROPIC_* + 36 /api/claude_code/* count 정정 / `slack.com/marketplace/A08SF47R6P4-claude` App ID / TEAM_MEMORY_SYNC_URL + checksum + tombstoned keys

**v7 미반영 신발견 50+ (verification만)**:
- Cursor: HallucinatedFunctionsProtoPrompt @ L253999 · DashboardAction @ L40155 · SlashEditFollowUpWithPreviousEditsRequest @ L158311 · StreamSlashEditFollowUpResponse @ L158356
- Codex: prune_stage1_outputs_for_retention slow query · TUI pet assets `persistent.oaistatic.com/codex/pets/v1/` · SQLite WAL config · 6 JS bundle sizes
- Claude: `tengu_fork_subagent` + `CLAUDE_CODE_FORK_SUBAGENT` subagent fork gate · disableSkillShellExecution + bun audit low/moderate/high/critical · 7 API host ecosystem · NSUserActivityTypes Handoff · Cowork memory tombstones+checksums+per-repo

### Draft v6 wave 3 깊이 (2026-05-26 #6, 4-agent: Cursor 20 + Codex 15 + Claude 21 + quanta 24 = **80 신발견**)

**v6 표 반영 row: 9 신규 + 1 정정**:
- **D Hook event 수**: Claude 14 → **22 verified** (PermissionDenied/PermissionRequest/Setup/InstructionsLoaded/WorktreeCreate/Remove 등 추가)
- **A 루프**: Turn 6-API + Thread-Follower 5 message (Codex remote control primitives)
- **H 메모리**: ADR-0021 5-layer working state · ADR-0082 citation provenance · ADR-0008 SOTA memory tier+kind+vector
- **I 모델**: gpt-5.5 NUX leak + xhigh effort + 4 model tier env
- **M Subagent**: BackgroundComposerService 114 method (12-cluster) · AiProjectService 8-RPC 4-phase pipeline · multiagent thread_message paired
- **N 관측성**: AutoDream 4-state lifecycle
- **S 보안**: Memory Versions redact terminal · Vault Archive immutable

**v6 깊이 매핑 line-exact 핵심**:
- Cursor: `extensionHostProcess.js:L243974+` BackgroundComposerService / `:L129432+` AiProjectService / `:L259387,L259399,L259405` streamReview/streamSlowReview/streamCodeTour / `:L253358` GetGitGraphRelatedFiles / `:L218072` EffectivePlugin / `:L158147` FastApplyModelType 25 verbatim / `:L157858` should_resolve / `:L140380` CmdKSelection / `:L50701` cursor_prediction_target / `:L44074` RerankerAlgorithm 12 with LULEA_HAIKU
- Codex: `app-server-manager-signals-BEaGjuc8.js:L8-19` Turn 6-API / `models_cache.json:L7-44` gpt-5.5 detail / `config.toml:L2,4,41` xhigh+plan_mode+NUX leak / `permissions-mode-defaults-TVsdTyUZ.js` agent-mode-by-host
- Claude: `_cli-symbols.txt` 11 Managed Agents API hierarchy (/v1/{agents,sessions,threads,events,environments,vaults,credentials,files,skills,memory_stores,memory_versions}) + 22 hook events + AutoDream 4-state + Beta API 7개 (managed-agents-2026-04-01/skills-2025-10-02/oauth-2025-04-20/files-api-2025-04-14/environments-2025-11-01 + Structured Outputs/User Profile)
- quanta: 표 미박힌 ADR 24개 발굴 — **★ ADR-0021 5-layer / ADR-0082 citation provenance / ADR-0008 SOTA memory가 가장 paradigm**

**v6 wave 3 미반영 신발견 56개** (verification 만, 표 row 안 박힘):
- Cursor: DashboardService 12+ method · streamReview/streamSlow SLO routing · BugConfig anti-annoyance · EffectivePlugin provenance · cursorsandbox 플랫폼별 binary · CursorRule 4-variant 강조 · should_resolve PR auto-close · CmdKSelection ContextItem · cursor_prediction_target schema · GetGitGraphRelatedFiles RPC · ContinueWithCloudComposer
- Codex: gpt-5.5 reasoning_effort tiers · Bundled vs Primary-Runtime invariant 강조 · background-subagent 26 refs · interruptConversation/Self pair · agent-mode-by-host-id 4-mode (auto/custom/full-access/read-only) · side-conversation prompt verbatim · exec_command_{begin,end,output_delta} 3-event · plugin marketplace cache 구조 · PostCompact + PreCompact hooks
- Claude: 22 Hook Event Types 풀 list · 11 Managed Agents resource hierarchy · Beta API 7개 · Session SSE+paginated dedupe · cowork_settings/cowork_plugins events · tool permission cross-thread routing (session_thread_id) · ElicitationHooks parseOutput JSON decoder · Hook exit code 2 = blocking · CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS env · 25 concurrent threads max
- quanta: ADR 21건 추가 (0002/0004/0011/0015/0022/0026/0031/0033/0034/0038/0045/0054/0072/0074/0090/0095/0134/0142/0157/0173/0192)

### Draft v5 wave 2 신발견 + S/T/U 카테고리 신설 (2026-05-26 #5, 3-agent 깊이)

**S/T/U 3개 신규 카테고리 추가** (이전 18 → **21 카테고리**, +39 row):
- **S. 데이터 보안 / Encryption** (11 row): reasoning encrypted/Bridge XSS isolation/MITM CA/DeviceCheck/FIPS 140/redacted_read/PII 2-copy/E2E commit embeddings/deeplink encryption/Statsig hardcoded key/disableSkillShellExecution
- **T. 패치/Diff/Edit detail** (13 row): apply_patch V4A EBNF/Move to atomic/Fast-apply 25 model/EditResult typed oneof/diff_string+lines/after_full_file_content/ReportEditFate/moved-code Jaccard/MultiEdit/Streamed full-file/ApplyAgentDiff/Env ID
- **U. Bench/Eval/Experiments** (15 row): SWE-bench harness/Speculative branch search/EvalTrackingService 21/Metric envelope/EXPERIMENT_* 7 A/B/Statsig+GrowthBook/cursor-commits scoreCommit/BugfixVerdict 5/PostGenerationEvaluation/Mock stream/Hellgate/tengu_ 2053/event_logging batch/buildType+commitHash/org metrics gating

**v5 wave 2 깊이 발굴 (3 agent: Cursor 23 + Codex 21 + Claude 20 = 64 신발견)**:

**Cursor 23개** — 핵심:
- `ClientSideToolV2 40-enum` numeric ID (TODO_READ/WRITE, TASK_V2, CALL_MCP_TOOL, APPLY_AGENT_DIFF 등)
- `SimulatedMsgReason 17 variant verbatim` (메모리 10+ 정정)
- `BugfixVerdict 5-value` + `PrivacyMode 5` + `PrivacyModeStatus 4`
- `ContextItem 7-variant union` (LspSubgraph/Cpp/SparseFile/Outline/CmdKSelection/FileDiffHistory/Cached)
- `GitGraphService.StreamCodeTour` (Blame stream)
- `WorktreeEvent.WorktreeComposerMapping` metadata
- `LifecycleService.ClaimWorker` (pooled-VM)
- `cursor-resolver-helper 8 auth provider chain`
- `cursor-commits scoreCommit` (boundary + contiguous sequence)
- `ReloadAgentSkills/Plugins` hot reload RPC
- `CursorRule 4-variant` (GLOBAL/FILE_GLOBS/AGENT_FETCHED/MANUALLY_ATTACHED)
- `deeplink encryption` (encryptionKey bytes + ListDeeplinksRequest paging)
- `ExecServerMessage 20 slot` (shell_args/grep_args/computer_use_args 등 wire)
- `SubagentType 9 verbatim` (BASH/SHELL/COMPUTER_USE/BROWSER_USE/CURSOR_GUIDE/DEBUG/EXPLORE/MEDIA_REVIEW/VM_SETUP_HELPER/CUSTOM)

**Codex 21개** — 핵심:
- SQLite `agent_jobs + agent_job_items` (CSV row-by-row batch + result_json per item)
- `jobs.ownership_token` (분산 lease UUID)
- `backfill_state` watermark (last_success_at + last_watermark)
- `threads.reasoning_effort` 6-tier (none/minimal/low/medium/high/xhigh)
- `threads.thread_source` (api/local/spawned 출처 audit)
- `remote_control_enrollments` 7-tuple (websocket_url + account + app_server + env)
- `automation_update.destination` ∈ {thread, workspace}
- `electron-persisted-atom-state` 6 keys (avatar/bounds/local-remote-installation/main-window/saved-roots)
- `comment-preload.js 383K lines` (CRDT + Manhattan scoring overlay)
- `thread_dynamic_tools.input_schema` (inline JSON, additionalProperties:false)
- 19 .codex-global-state.json keys 풀 (메모리 ~6 → 19)
- 10+ state_5 SQLite table 신확인 (메모리 ~8 → 18)

**Claude 20개** — 핵심:
- `gO() buildType:prod` + `commitHash b8f837f8` + `2025-11-14T18:56:13Z` embedded (`index.js:L30409`)
- `CLAUDE_AI_URL` env override + `yr() URL resolver` dev/prod 분기 (`index.js:L51701-L51706`)
- `/api/bootstrap` (`L52213`) + `/api/event_logging/batch` (`L67579`)
- `statsig.anthropic.com/v1/log_event` (`L67548`) + hardcoded key `client-ila3bcu9jdk...` (`L67547`)
- MCP `sampling/createMessage` (`L68582`) + `elicitation/create` (`L68630`) + `completion/complete` (`L68653`)
- `/api/organizations/{id}/dxt/{blocklist,can_install}` extension governance (`L84014,L84018`)
- `/api/organizations/{id}/wiggle/upload-file` (`L82470`) — **`wiggle` 코드네임** (파일 수신부)
- `developer_settings.json` config (`L84925`)
- `isInternalBuild` flag schema (`L4162`, 현재 false=공개)
- `Promise.allSettled` 듀얼 sink (Datadog + Statsig 둘 다 실패해도 계속, `L67657`)
- `commitHash` 모든 telemetry 이벤트에 자동 (`L67624`)

### Draft v4 audit 결과 (2026-05-26 4-agent 병렬 #4, **꼼꼼 audit**)

**총 5점/4점 cell 카운트** (4-agent 실측):
- quanta: 33+2 = 35 cell
- Cursor: 94+50 = **144 cell** (최다, 표 24%)
- Codex: 64 cell (모두 5점)
- Claude: 61+29 = 90 cell

**v4 신발견 추가 row 4개**:
- **C MCP**: `codex_mcp_server` (Codex 자체가 MCP server로 다중 클라 제공)
- **K UX**: Cursor `glass.*` command enum (20+ items, browser automation 별도 namespace)
- **F 샌드박스**: Cursor `cursor-shadow-workspace` extension (격리 workspace context, Codex Code Mode paradigm 매칭)

**v4 source line-exact 보강 핵심 7건**:
- Codex MITM hook: `network-proxy/src/mitm.rs:210~388` (SSL/TLS intercept + CA generation)
- Codex shell-escalation: `shell-escalation/src/` `SuperExecRequest`+`ESCALATE_SOCKET`+`EXEC_WRAPPER`
- Claude tengu_ count 정정: **1155 → 2053** (실측 family)
- Claude CLAUDE_CODE_RATE_LIMIT_TIER: `:L120343`
- Claude CLAUDE_CODE_AGENT_COST_STEER: `:L124072`
- Claude CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: `:L126701`
- Claude SUBAGENT_MODEL: `:L129751` / AUTO_COMPACT_WINDOW: `:L136373,L139685` / AGENT_TEAMS: `:L117378,L129956`
- Cursor cursor-socket injectFailure path + Update chunk 13 verbatim + glass.* path + agent.v1 protobuf 강화

**v4 0점 spot-check 결과 (정정 없음 — 0점 정당)**:
- Computer Use·Reverse MCP·codex_network_proxy·Personality slot·Chronicle·Popcorn·TCC.db·Bedrock Mantle = vendor 단독 paradigm으로 0점 그대로 정당
- Cursor=0인 Reverse MCP/Personality/Chronicle = negative invariant (적극 미흡수)
- Claude=0인 Local model/Reverse MCP/Chronicle/Browser engine/Popcorn = 정당
- quanta=0인 Computer Use/Browser/Mobile pairing = 의식적 미흡수

### Draft v3 신발견 (2026-05-26 4-agent 병렬 합집합 확장)

**총 13개 신규 row 추가 + 2개 정정** (이전 row ~220 → ~233):

**★ 최대 발견 — quanta P/D 카테고리 정정**:
- **자율 reactor (P)**: quanta는 0점이 아니라 **4점** — ADR-0132 `autonomous-proactive-reactor` 존재 (CI 완료/PR comment 외부 trigger로 agent 자율 wake, default-OFF + 30s guard 3중)
- **Hook bidirectional RPC (D)**: quanta 3점 → **4점** — ADR-0133 `hook-bidirectional-rpc` 존재 (6 lifecycle event Request/Response paired)

**B 도구 — 3 신규 row**:
- `Code Mode` (Codex 격리 코드 실행, `shell_snapshot.rs`+`code_mode_only` 권한)
- `StartGrind` 2-phase tool (Cursor `StartGrindExecutionToolCall`+`StartGrindPlanningToolCall`)
- `SetupVmEnvironment` tool (Cursor agent-driven VM provisioning)

**C MCP/스킬 — 3 신규 row (Claude Managed Agents Beta paradigm)**:
- `Managed Agents Beta` (multiagent coordinator 1-20 specialist + self-delegation, `anthropic-beta: managed-agents-2026-04-01`)
- `Memory Versions + Redact API` (`memory_stores.memory_versions.{list,retrieve,redact}` + FUSE-mount)
- `MCP OAuth Validate` (`vaults.credentials.mcp_oauth_validate` token validation pre-attach)

**I 모델/라우팅 — 3 신규 row**:
- `Subagent model override` (`CLAUDE_CODE_SUBAGENT_MODEL` env)
- `Auto-compact window threshold` (`CLAUDE_CODE_AUTO_COMPACT_WINDOW` env)
- `claude-opus-4-7` (Opus 4.7 tier)

**M Subagent — 3 신규 row**:
- `Multiagent Coordinator + self-delegation`
- `AGENT_TEAMS experimental flag`
- `Thread Dynamic Tools` (Codex state_5 `defer_loading` + namespace)

**N 관측성 — 2 신규 row**: Notification Preferences API · Organization Metrics gating

**P 자율 — 3 신규 row**:
- `HeartBeat Automations` (Codex RRULE + heartbeat vs cron 분리)
- `Tool failure exploration ladder` (quanta ADR-0062 단독 5점)
- `Speculative branch search` (quanta ADR-0084 SWE-bench Agentless 흡수, 단독 5점)

**R 엔터프라이즈 — 3 신규 row**: Policy Limits · Penguin Mode (gvisor microVM API) · Remote Control Enrollments

### Draft v2 깊이 매핑 결과 (2026-05-26 4-agent 병렬)

**quanta 31 cell src 매핑 완료** (Agent A, **31/31 = 100% hit**):
- 핵심 line-exact 16건: `src/agent/guards/verify-guard.ts:35` · `src/storage/fs-jail-lib.ts:6` · `src/permission/git-write-guard.ts:99` · `src/agent/follow-up-queue.ts:128` · `src/agent/compaction-breaker.ts:48` · `src/agent/budget/meter.ts:18` · `src/agent/per-tool-checkpoint/three-way-restore.ts:231` · `src/observability/prompt-cache/index.ts:12` · `src/llm/spinner-stall/index.ts:16` · `src/rules/matcher.ts:106` · `src/agent/repo-rules.ts:228` · `src/permission/auto-approval-review.ts:140` · `src/agent/loop.ts:443` · `src/security/secret-detection/composite-scanner.ts` · `src/security/pii-redaction/composite-scanner.ts` · `src/tool/git/{blame,blame-heatmap,churn,...}.ts`
- 발견: Hellgate `tests/` 367 파일 (메모리 "17 batteries"는 보수적 카운트)

**Cursor 47 cell file 매핑** (Agent B, 46/47 hit, FloatingPenguinMini 정확명 miss):
- 파일 집중도: `workbench.desktop.main.js` (28건/60%) · `extensionHostProcess.js` (18건/38%) · `agent.v1` protobuf (15건/32%)
- SIMULATED_MSG_REASON = 10+ variant (PLAN_EXECUTION/COMMIT_REMINDER/BACKGROUND_TASK_COMPLETION/DIFF_TAB_CREATE_PR/MULTITASK_SPLIT_PRS/BUILD_IN_PARALLEL/BABYSIT_PR_IN_CLOUD/CI_PANEL_INVESTIGATE_FAILURE/UNSPECIFIED+USER_*_SUBAGENT 2)
- RerankerAlgorithm = **12 variant** verified (LULEA, UMEA + 10 others)

**Codex 60+ cell 매핑** (Agent C, line-exact 5건):
- `_cli-symbols.txt:L48563` personality_default/friendly/pragmatic
- `_cli-symbols.txt:L48629` codex_rmcp_client (rmcp::transport::WorkerTransport)
- `_cli-symbols.txt:L53168` codex_lmstudio
- `_cli-symbols.txt:L56884` codex_ollama
- `permissions-mode-helpers-*.js:L379` guardian_subagent (auto_review 인접)
- 파일 집중도: `_cli-symbols.txt` (50건) · `.vite/build/` (10건) · `userdata/codex/` (15건)

**Claude 37 cell 매핑** (Agent D, line-exact 8건):
- `_cli-symbols.txt:L108092+` tengu_* 80+ family
- `_cli-symbols.txt:L113086` ANTHROPIC_IDENTITY_TOKEN_FILE
- `_cli-symbols.txt:L114120~L114124` CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY,MANTLE} 4 env
- `_cli-symbols.txt:L115476` ANTHROPIC_FEDERATION_RULE_ID
- `_cli-symbols.txt:L117531` CLAUDE_CODE_REMOTE_MEMORY_DIR
- `_cli-symbols.txt:L126373` /api/auth/trusted_devices
- `_cli-symbols.txt:L137612` /api/claude_code/team_memory
- `_cli-symbols.txt:L214666` /api/claude_code_grove
- 12건은 verified-miss (minified bundle 또는 quanta 단독 feature)

### 다음 후속 (Draft v3 후보)

1. **남은 ~155개 5점 cell도 file:line 박기** — 본 v2에서 핵심 30개만 반영. 나머지는 보고는 받았으나 표 미반영
2. **중간 점수 보수화 wave** — 2/3/4에 `?` 또는 점수 폭(`3-4`)
3. **negative invariant 컬럼 추가** — "computer use=quanta=0"이 "갭"인지 "의식적 미흡수"인지 구분
4. **빌드 변화 대응** — 분기별 `.extracted_source/` 재추출 cadence
5. **자매 문서 link** — `docs/analysis/경쟁사리뷰/code-agent-loop/{cursor,codex,claude}*.md` 깊이 ref

### 사용된 1차 소스 (디렉토리 레벨)

```
quanta:
  docs/decisions/0001-*.md ~ 0227-*.md (334개)
  src/{agent,llm,permission,checkpoint,git,observability,...}/
  ~/.claude/projects/-Users-songmin-quanta-codeagent-v3/memory/

경쟁사:
  .extracted_source/cursor/ (Applications/Cursor.app extensions)
  .extracted_source/codex/ (Codex.app + comment-preload.js 38MB)
  .extracted_source/codex-cli/ (_cli-symbols.txt)
  .extracted_source/claude/ (Claude 2.app + main-*.js)
  .extracted_source/claude-code-cli/ (_cli-symbols.txt)
  .extracted_source/userdata/{codex,claude}/ (~/.codex, ~/.claude state)

문서:
  docs/analysis/경쟁사리뷰/code-agent-loop/
  docs/analysis/경쟁사리뷰/code-agent-suit/
  docs/analysis/경쟁사리뷰/may-21-claude-desktop-*.md
```

---

**Generated**: 2026-05-26 / **Draft v15** (15 wave 누적 **823+ 신발견** / **25 카테고리 A~Y** / ~418 row / 245+ row 정정-보강. v15 ★ 핵심: **quanta GitHub trunk 4 ADR 발굴** (0311 github-actions-trigger / 0312 webhook-host-scaffold / 0313 PR redaction / 0314 mention-filter-trust-scope) + 추가 ADR 3개 (0271 why-meta-LLM / 0297 CliFeatureConfig / 0307 repl-host-slim-down). v15 정정: Codex crate 42→**41 verified** / Claude MCP tool 13→**11** / /api/oauth 6→**8**. Cursor Sentry 37-type + cursorTracing API proposal + Anysphere fork 8-path. Codex 123 rollout summaries + transcription-history multilingual)
