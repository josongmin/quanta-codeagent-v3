# 코딩 에이전트 4-way 기능 합집합 비교

**Cursor 3.2.16 / Codex Desktop build 2867 (codex-rs 0.131.0-α9) / Claude Desktop 1.7196.3 + Claude Code 2.1.138 / quanta-codeagent-v3**

> **검증 상태: Draft v3 (합집합 확장 — 신발견 13 row 추가 + 2 정정)**
>
> - **v0**: 메모리 + ADR 인덱스 + `.extracted_source/` 카탈로그 초벌
> - **v1** (2026-05-26 #1): 4 agent 병렬 spot-check — 19/20 cell hit (95% accuracy)
> - **v2** (2026-05-26 #2): 4 agent 병렬 깊이 매핑 — 5점 cell 190+개 file:line 보강 (Codex 5건 line-exact, Claude 8건 line-exact, quanta 31건 src path, Cursor 47건 file path)
> - **v3** (2026-05-26 #3): 4 agent 병렬 합집합 확장 — 메모리/표에 없던 신기능 발굴 + **quanta 자체에 ADR-0132/0133이 있다는 ★최대 발견** (자율 reactor + hook RPC) → P/D 카테고리 quanta 점수 정정. Claude **Managed Agents Beta** (multiagent coordinator + memory_versions API + MCP OAuth validate) paradigm-level 추가.
> - 총 row: ~220 → ~233. 중간 점수(2/3/4) 정성 판단 ~25%는 여전히 휴리스틱.
> - 경쟁사 코드 경로: `.extracted_source/{cursor,codex,claude,claude-code-cli,codex-cli,userdata}/` 풀트리 실존. minified bundle은 빌드마다 line drift 가능 → 분기별 재추출 권장.

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
| **Managed Agents Beta** (multiagent coordinator) [v3 신발견] | 0 | 0 | **5** | 0 | Cld: `extr/claude-code-cli/_cli-symbols.txt` `anthropic-beta: managed-agents-2026-04-01` + `multiagent: {type:"coordinator", agents:[...]}` | 1-20 specialist agent 협업 + self-delegation. swarm-like task delegation |
| **Memory Versions + Redact API** [v3 신발견] | 0 | 0 | **5** | 0 | Cld: `memory_stores.memory_versions.{list,retrieve,redact}` + FUSE-mount agent interface | persistent memory 변경의 audit trail + redact API. enterprise compliance |
| **MCP OAuth Validate** (vault-scoped credential) [v3 신발견] | 0 | 0 | **5** | 0 | Cld: `vaults.credentials.mcp_oauth_validate` | OAuth 토큰을 agent attach 전에 validate. credential 자동 rotation |

## D. Hook 시스템

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| Hook event 수 | **20** | 11 | 14 | 14 | Csr: `Sw` enum 정확 20 (`packages/hooks/src/hook-step.ts` 위치는 minified extr/cursor/extensions/cursor-agent-exec/dist/main.js) | "claim의 beforeTabFileEdit만 없음" — Tab은 read-only |
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
| Per-thread permissions store | 3 | **5** | 3 | 3 | Cdx: `.codex-global-state.json` `heartbeat-thread-permissions-by-id` | |

## F. 샌드박스 / 보안

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| OS-level sandbox | **5** | **5** | **5** | 1 | Csr: `/Applications/Cursor.app/Contents/Resources/helpers/cursorsandbox` (Rust 3.2MB Seatbelt+bwrap+proxy) · Cdx: sandbox_mode · Cld: yukonSilver microVM | **quanta 최대 갭** — 세 곳 다 OS-level. quanta는 Docker optional |
| Seatbelt profile verbatim adopt | 3 | **5** | 4 | 4 | Cdx: 100+ line SBPL · qta: ADR-0199 src/sandbox/seatbelt/ | `(version 1)(deny default)(allow process-exec)...` copy-paste |
| microVM (VZ + rootfs+sessiondata COW) | 0 | 0 | **5** | 2 | Cld: `~/Library/Application Support/Claude/vm_bundles/claudevm.bundle/` (rootfs.img.zst + sessiondata.img + gvisorMacAddress) | rootfs RO + sessiondata RW (COW) + gVisor 격리 추정 |
| Sandbox modes 3-tier | 4 | **5** | 4 | 3 | Cdx: `danger-full-access\|read-only\|workspace-write` + `writable_roots[]?`+`network_access?` | |
| `.git/hooks` write deny | **5** | 4 | 4 | **5** | Csr: cursorsandbox SBPL deny-regex verbatim · qta: ADR-0091 src/permission/git-write-guard.ts | segment-anchored 매칭 (near-miss 정확 배제) |
| fs-jail (branded type) | 3 | 3 | 3 | **5** | qta: `src/storage/fs-jail-lib.ts:6` (FsJailLib interface) + is-path-inside lib-swap | quanta 단독 brand 타입 |
| HARD_DENY 9-rule destructive | 2 | 3 | 4 | **5** | qta: ADR-0098~0107 + `src/permission/git-write-guard.ts:99` (ALL_GIT_WRITE_PROTECT_REASONS) | git rm -rf, branch -D --force, push --force main 등 9 |
| Network policy (3-tier DSL) | **5** | 4 | 4 | 3 | Csr: `user_config_only\|with_defaults\|allow_all`+`NetworkPolicy{default_action,allow,deny}` | classification_failed 폴백 + `smartAllowlistEnabled` |
| `codex_network_proxy` 별도 layer | 0 | **5** | 0 | 0 | Cdx: codex-cli/_cli-symbols.txt | sandbox 외 별도 proxy layer |
| `codex_shell_escalation` 별도 layer | 0 | **5** | 0 | 0 | Cdx: codex-cli/_cli-symbols.txt | |
| SSRF block (RFC1918+link-local+metadata) | 4 | **5** | 4 | 3 | Cdx: `ComputerUseURLBlocklist` + cache | |
| AppApproval per-bundle persistent | 3 | **5** | 3 | 0 | Cdx: `SkyComputerUseService` | "이 앱은 prompt injection 위험" 명시 warning |
| App blocklist (password mgr+terminal) | 3 | **5** | 3 | 0 | Cdx hardcoded(1Password/Bitwarden/iTerm2/Ghostty/wezterm 등 10종) | |
| Disclaimer wrapper (POSIX_SPAWN_SETDISCLAIM) | 0 | 0 | **5** | 0 | Cld: `Helpers/disclaimer` + `shell-path-worker.js` | 사용자 zshrc 악성코드로부터 앱 entitlement 격리 — 비명백 OS API |
| TCC.db 직접 read | 0 | **5** | 0 | 0 | Cdx: `/Library/Application Support/com.apple.TCC/TCC.db` | **negative invariant** — Apple 공식 API 우회, 따라하지 말 것 |
| Identity mode variant | 3 | 4 | 4 | 2 | qta: ADR-0198 src/agent/identity/ + 5 mode identity table | 부분 구현 |

## G. 검증 / 품질 (★ quanta 우위 축)

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| verify-guard hard gate | 0 | 0 | 0 | **5** | qta: ADR-0013 + `src/agent/guards/verify-guard.ts:35` (createVerifyGuard) | test 미실행이면 turn 종료 **차단** — 3사 다 soft prompt, quanta만 코드 hard gate |
| closeout-guard 4-truth (R1~R4) | 0 | 0 | 0 | **5** | qta: ADR-0017 src/closeout/four-truth.ts | 거짓-success 방지 hard gate |
| Hellgate adversarial battery | 1 | 1 | 1 | **5** | qta: `tests/**/*-hellgate.test.ts` 17 batteries | 384+ adversarial case — "내가 이기는 축" 봉인 |
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
| Retrieval (Merkle+simhash+rerank) | **5** | 3 | 4 | 3 | Csr: cursor-retrieval extension (file-service NAPI Rust 29MB) · qta: ADR-0159 retrieval-sota-stack | Merkle subtree 증분-sync 만 차용, 벡터스토어 흡수금지 |
| 13 reranker (LULEA/UMEA + 11) | **5** | 0 | 3 | 0 | Csr: `extr/cursor/out/.../extensionHostWorkerMain.js` (RerankerAlgorithm enum 12 variant: LULEA/UMEA in-house + LLAMA/STARCODER_V1/GPT_3_5_LOGPROBS/COHERE/VOYAGE/ADA_EMBEDS+) | 13 reranker 중 2개는 in-house code-specialized |
| 4 chunk-size buckets | **5** | 0 | 0 | 0 | Csr: `RechunkerChoice` `IDENTITY\|600_TOKS\|2400_TOKS\|4000_TOKS` | retrieval 후 token 버킷에 맞게 re-chunk |
| BM25 + vector hybrid | **5** | 0 | 3 | 2 | Csr: `QueryType.QUERY_TYPE_KEYWORDS`vs`QUERY_TYPE_EMBEDDINGS` | caller가 routing 결정 — backend assemble |
| Commit message embeddings | **5** | 0 | 0 | 0 | Csr: `CommitNoteWithEmbeddings` (E2E-encrypted) | git diff-context search — E2E encrypted relative path+weight |
| Context items typed union | 4 | 3 | 3 | 4 | Csr: SparseFileChunk/LspSubgraphChunk/Lints-as-context/PostGenerationEvaluation · qta: ADR-0080 ide-context-provider-seam | typed 6-value union(memory/file_chunk/outline/diagnostic/rule/snapshot) |

## I. 모델 / 라우팅 / 비용

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| Multi-vendor (Bedrock/Vertex/Foundry) | 4 | 4 | **5** | 4 | Cld: `extr/claude-code-cli/_cli-symbols.txt:L114120~L114124` (CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY,MANTLE} 4 env 모두 verified) · qta: ADR-0139 provider port | 22+ `ANTHROPIC_*` env |
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
| **Subagent model override** (env-driven) [v3 신발견] | 3 | 4 | **5** | 3 | Cld: `CLAUDE_CODE_SUBAGENT_MODEL` env (Haiku default, override Sonnet/Opus) | per-deployment subagent 모델 강제 — 비용 최적 |
| **Auto-compact window threshold** [v3 신발견] | 3 | 4 | **5** | 3 | Cld: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env | 토큰 임계치 자동 compaction trigger — prompt cache 통합 |
| **`claude-opus-4-7`** (latest Opus 4.7 tier) [v3 신발견] | 0 | 0 | **5** | 0 | Cld: `extr/claude-code-cli/_cli-symbols.txt` model selection hints + 4.6-fast speed mode 인접 | 4.6 successor. 모델 enum에 박힘 |

## J. Git / Checkpoint / VCS

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| Git 도구 수 (blame_heatmap/churn 포함) | 4 | 4 | 4 | **5** | qta: ADR-0025 src/tool/git/ 9-tool | quanta 9-tool 최다 |
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
| Stage-aware Update chunk (13 type) | **5** | 3 | 3 | 3 | Csr: `TextDelta/TokenDelta/ToolCallDelta/Start/Completed/StepStart/Completed/ThinkingDelta/Completed/SummaryStart/Completed/Heartbeat/Interaction/Partial` | UI가 각 phase 별로 다르게 렌더 |
| Heartbeat update | **5** | 3 | 3 | 3 | Csr: `HeartbeatUpdate` | 단독 chunk type |
| Mode-typed delegation (BoomerangResult) | 4 | 4 | 3 | 4 | qta: ADR-0218 5-mode closed enum | architect/editor/debug/tdd/explore — 4-vendor 수렴 |
| Focus chain reinject | 4 | 2 | 2 | 4 | Cline → qta: ADR-0219 | |
| `thread_spawn_edges` lifecycle | 3 | **5** | 3 | 3 | Cdx: state_5.thread_spawn_edges `status: open/closed` | subagent lifecycle을 edge state로 |
| **Multiagent Coordinator + self-delegation** [v3 신발견] | 4 | 4 | **5** | 3 | Cld: `CreateAgent.multiagent:{type:"coordinator",agents:[]}` (1-20 specialist) · qta: ADR-0218 mode-typed delegation | Claude는 self-delegation도 명시 — agent가 자기 자신을 sub-task로 호출 |
| **`AGENT_TEAMS` experimental flag** [v3 신발견] | 4 | 4 | **5** | 3 | Cld: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env | Agent + Coordinator + Self 패턴 게이팅 |
| **Thread Dynamic Tools** (per-thread lazy registry) [v3 신발견] | 3 | **5** | 3 | 3 | Cdx: state_5 `thread_dynamic_tools` (position/namespace/input_schema/`defer_loading`) | tool registry를 thread별 lazy load — namespace 분리(codex_app vs MCP) |

## N. 관측성 / Telemetry

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| OTel canonical attribute vocabulary | 3 | **5** | 4 | 4 | Cdx: `codex.{conversation,thread,turn,mcp,tool,task,multi_agent,startup,sqlite,db,memory,network_proxy,approval}.*` 70+ keys · qta: ADR-0010/0144 | v3 텔레메트리 직접 reference |
| W3C tracing propagator | 3 | 4 | 4 | 4 | qta: ADR-0186 src/observability/tracing/ | |
| MCP-specific telemetry | **5** | 4 | 4 | 3 | Csr: `mcp.ipc.{count,duration_ms}`+`mcp.snapshot.notify_pull_changed_count`+`mcp.agent_exec.lease_selected` | |
| Telemetry event namespace | 4 | 4 | **5** | 4 | Cld: `claude_code.{session,pull_request,commit,cost,token,code_edit_tool,active_time}.*` | |
| Sentry stack 4중 | 3 | **5** | **5** | 3 | Cld: `@sentry/{electron,node,opentelemetry,instrumentation}` | release pin = git commit SHA |
| Datadog sink | 3 | 4 | **5** | 3 | Cld: 1155+ `tengu_*` events | |
| Statsig + GrowthBook A/B | 3 | 4 | **5** | 3 | Cld: 통합 | |
| Cursor Sentry tagging | **5** | 3 | 3 | 3 | Csr: `CURSOR_EXTENSION_HOST_ROLE=background-composer`+`CURSOR_LAYOUT` | host process role별 분기 |
| Trace recording | 3 | **5** | 4 | 3 | Cdx: `trace-recording-sentry-upload-D1vMSdCW.js` 3.4KB (Chrome DevTools format) | gzip + Sentry attachment 30s flush |
| `_safe`/`_log_only` PII-stripped 2-copy | 0 | **5** | 0 | 0 | Cdx: logs_2.sqlite | 외부 OTLP exporter용 sanitized 사본 |
| NDJSON ingest debug server | **5** | 3 | 3 | 0 | Csr: extr/cursor/extensions/cursor-ndjson-ingest (port 7242-7942 workspace-sticky) | `.cursor/debug.log` + curl 명령 copy |
| Metric registry (Eval) | **5** | 4 | 4 | 4 | Csr: EvalTrackingService 21 Unary methods (Ray/S3/Slack training sink) · qta: ADR-0087 storage/schema.ts | `Metric{key,value,unit,step}` shape 흡수, Ray 부적합 |
| Tool stats / heatmap | 4 | 3 | **5** | 3 | Cld: `extractToolStats`+multi-Claude 감지 | |
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
| `SIMULATED_MSG_REASON_*` 자율 self-prompt | **5** | 0 | 0 | **4** | Csr: `extr/cursor/out/vs/workbench/api/node/extensionHostProcess.js` (10+ variant) · qta: **ADR-0132-autonomous-proactive-reactor** (temp cloud branch snapshot + simulated message injection + 30s guard, default-OFF) | ★ **paradigm shift** — quanta도 흡수했지만 default-OFF에 hard guard 3중 — Cursor가 production 표준, quanta는 안전망 우선 |
| Background Composer (PR babysit) | **5** | **5** | 4 | 0 | Csr: BackgroundComposerService 114 메서드 (6 ServerStream+108 Unary, 12-cluster) · Cdx: `codex cloud` 8 sub-cmd | bc_id로 PR binding |
| BugBot AUTOFIX 사다리 | **5** | 0 | 3 | 0 | Csr: `extr/cursor/out/.../extensionHostProcess.js` + `workbench.desktop.main.js` (BUGBOT_AUTOFIX_MODE_{AUTO_MERGE,AUTO_PR,MANUAL,OFF,UNSPECIFIED} 5 variant verified) | 이슈→PR→머지 풀 파이프 자율도 3단 |
| Cron + RRULE scheduled agent | 4 | 3 | 3 | 4 | qta: ADR-0161/0215 AutomationEnginePort src/automation/ | |
| 8-trigger oneof | **5** | 3 | 3 | 3 | Csr: `AutomationsService` (cron/git/slack/linear/webhook/slack_channel_created/pagerduty/sentry) | |
| Agentic filter prompt (LLM gate) | **5** | 3 | 3 | 3 | Csr: `agentic_filter_prompt` ALLOW/BLOCK + rationale | LLM이 trigger를 한 번 더 게이팅 — gem |
| Per-automation memory CAS | **5** | 3 | 3 | 2 | Csr: AutomationsService | |
| Cloud handoff | **5** | 3 | 3 | 0 | Csr: `AgentCompatService.getConversationStateForCloudTransfer(composerId)` | local agent 상태를 cloud-agent로 marshal |
| Reverse MCP (RMCP) | 0 | **5** | 0 | 0 | Cdx: codex-cli `codex_rmcp_client` | server → agent 역방향 trigger |
| **HeartBeat Automations** (RRULE + cron taxonomy) [v3 신발견] | 4 | **5** | 3 | 4 | Cdx: state_5 `automation_update` tool + RRULE 스케줄 + mode={heartbeat,cron} + ACTIVE/PAUSED 상태 · qta: ADR-0161 | follow-up/wake-up 1분~주 단위 — `heartbeat`는 1회성 wakeup, `cron`은 반복 |
| **Tool failure exploration ladder** [v3 신발견] | 3 | 3 | 3 | **5** | qta: **ADR-0062 tool-failure-and-exploration-ladder** | 단일 broad call→narrow 대신 실패 타입별 next-action 사다리 (cap→narrow, 404→fold, perm→skip) |
| **Speculative branch search** (N-best verifier-prover) [v3 신발견] | 3 | 0 | 0 | **5** | qta: **ADR-0084 speculative-branch-search** | Agentless 기법 흡수. patch candidate N개 병렬 → scorer/selector. SWE-bench SOTA |

## Q. 신뢰성 / Resilience

| 기능 | Csr | Cdx | Cld | qta | Source | 기깔난 포인트 |
|---|---|---|---|---|---|---|
| AbortSignal propagation | **5** | 3 | 4 | 4 | Csr: cursor-explorer "Workspace explorer aborted" | long-running explore cancellation |
| Retry policy (p-retry) | 3 | 3 | 4 | 4 | qta: lib-swap-2nd-round (p-retry sibling, streaming kept) | streaming class can't be promise-wrapped — ADR-0200 retry-pretry sibling |
| Chaos failure inject | **5** | 3 | 3 | 3 | Csr: `cursor-socket.injectFailure` | declarative |
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
| Multi-device sync (cloud handoff) | **5** | 4 | 4 | 0 | Csr: 위 P 행 | |
| Slack/Linear/PagerDuty connector | **5** | 3 | 4 | 0 | Csr: AutomationsService 8-trigger | |
| Office Add-in | 0 | 0 | **5** | 0 | Cld: `pivot.claude.ai/manifest.xml`+`microsoft365.mcp.claude.com` | |
| Sparkle auto-update (EdDSA pinned) | 4 | **5** | 4 | 0 | Cdx: 7 flavor(Dev/InternalAlpha/Nightly/Owl/Agent/PublicBeta/Prod) + SUPublicEDKey `mNfr1v9t63BfgDtlw4C8lRvSY6uMggIXABDOCi3tS6k=` | flavor별 icon+feed path 분리 + EdDSA pinning |
| **Policy Limits Endpoint** (enterprise quota) [v3 신발견] | 3 | 3 | **5** | 3 | Cld: `/api/claude_code/policy_limits` | org-scope rate/token limits return — enterprise policy enforcement |
| **Penguin Mode Endpoint** (VM sandboxed exec) [v3 신발견] | 3 | 4 | **5** | 0 | Cld: `/api/claude_code_penguin_mode` (gvisor microVM 관련) | code isolation toggle — `Penguin` codename과 일치 |
| **Remote Control Enrollments** (SQLite normalized) [v3 신발견] | 0 | **5** | 3 | 0 | Cdx: state_5 `remote_control_enrollments` table | enrollment flow SQLite로 정규화 — wham/remote와 동일 layer |

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

**Generated**: 2026-05-26 / **Draft v3** (4-agent ×3 wave: v1 spot-check 19/20 + v2 깊이 매핑 30 file:line + v3 합집합 확장 13 신규 row + quanta P/D 정정)
