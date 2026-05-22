# quanta vs Codex · Claude · Cursor — 축별 펼친 비교

> [cursor.md](cursor.md) · [claude.md](claude.md)의 자매. 점수 요약 아님 — **각 기능 축을 펼쳐서 4사가 그 축을 실제로 무엇을·어떻게 구현하는지** 나란히. quanta=코드 ground truth, 3사=문서/메모리(일부 추론 ≈).

표기: ✅완성 · 🟡부분 · ❌없음 · ≈추론

**검증 상태 (2026-05-22 실제 소스 재확인)**: quanta=코드 / **Codex 0.130.0**=`/opt/homebrew/lib/node_modules/@openai/codex` + `~/.codex/{config.toml,memories/,rules/,archived_sessions/}` 실제 확인 / **Cursor 3.2.16**=`/Applications/Cursor.app` extensions + `cursorsandbox` 바이너리 strings(minified 한계 — 숫자 일부 미검증) / **Claude Code 2.1.138**=205MB 바이너리 strings + Desktop asar.

> ⚠️ **이전 버전 정정 (실제 소스 검증으로 드러난 내 추론 오류)**:
> - **trust scope는 quanta 유일이 아니다** — Codex config.toml `trust_level="trusted/untrusted"`(per-project), Claude Code `trustedNetworkDirectories`/TrustDialog 실재. quanta는 5-tier matrix로 더 세분일 뿐.
> - **reviewer 개념도 quanta 유일이 아니다** — Claude Code `advisor` tool(stronger reviewer model) + code-reviewer/security-reviewer named subagent 실재. quanta가 유일한 건 **8-state ApprovalOutcome + invariant 검증 + typed 3-tier enum**(형식화), reviewer "기능"이 아님.
> - **Codex subagent = 9-tool**(6 아님), **memory = 3-layer**(durable+chronicle+ad_hoc, 2-phase 아님), **sandbox = sandbox_mode 3단 config**(seatbelt는 Rust 내부).
> - **Cursor hook 실측 ≤8**(내가 "20" 과장 — minified 한계), **44 ToolCall은 strings 미검증**(protobuf descriptor 기반 주장).

---

# A. LOOP / CONTROL FLOW

## A1. loop 구조
- **quanta** ✅ — `while` over turns ([loop.ts](../../../src/agent/loop.ts)). FSM 없음(RFC §1.2 명시). 한 turn = 1 LLM stream + tool dispatch. `runTurn`이 TurnResult(tools/completed/aborted/error) 반환, tools면 다음 turn.
- **Codex** 🟡≈ — round-robin 추론. lifecycle 단계 미도식. 이벤트 기반.
- **Claude** ✅ — `continueConversation()` for-each 메시지 순회 (generator 아님). sessionStore + queryInstance 상태.
- **Cursor** ✅ — gRPC BiDi 스트림. ConversationAction 주입 → InteractionUpdate 스트림. 엔진=빌더, IDE=transport 분리.

## A2. stop_reason 종료 분기
- **quanta** 🟡 — `decideOnAssembled` ([loop.ts:726](../../../src/agent/loop.ts#L726)): `refusal`→error 종료(✅ 이미 구현, L740), `max_tokens`→continuation nudge(≤3), `tool_use`+0파싱→malformed nudge(≤1), empty→nudge(≤2), 나머지→`hasTools`면 dispatch/아니면 completed. **`pause_turn`/`content_filtered`/`guardrail_intervened`는 의도적 미처리**(주석: server-tool 없으니 dead branch는 cargo).
- **Codex** ❌≈ — stop_reason literal 없음. TurnEnded(토큰회계)로 구조 전달.
- **Claude** ✅ — 8-way 명시 enum: end_turn/tool_use/max_tokens/stop_sequence/pause_turn/refusal/content_filtered/guardrail_intervened. 각 분기 명시.
- **Cursor** ≈ — stop_reason 없음. `turn_ended`(토큰) + `stop_category="needs_user_approval"` + cloud `provider_error/connection_error`.
- **판정**: Claude가 가장 풍부(8). quanta는 실용 핵심 4(refusal 포함) 처리 + 나머지 의도적 제외. **갭 아님 — 의도적 scope**.

## A3. SAME-turn 복구 (turn slot 안 먹는 재진입)
- **quanta** ✅ — `RecoveryAction` 6-enum(backoff/compact/nudge/proceed/completed/error). transient→exp backoff+jitter(≤3), PTL→reactive compaction, max_tokens→continue nudge(≤3), malformed→re-issue(≤1), empty→nudge(≤2). 모두 maxTurns 미증가.
- **Codex** 🟡≈ — 복구 분기 있으나 명시 enum 미확인.
- **Claude** 🟡 — max_tokens continuation + rapid-refill breaker(3턴 3회 차단). 나머지 minified로 텍스트 불명.
- **Cursor** 🟡 — `ClientContinuationConfig{idle_threshold, max_loops, nudge_message, escape_message}` 데이터 계약으로 거버넌스. 재진입은 simulated_msg_reason 태그.
- **판정**: quanta가 typed action enum으로 가장 명료. Cursor는 데이터 계약으로 거버넌스(다른 접근).

## A4. streaming tool dispatch (병렬/barrier)
- **quanta** ✅ — `streamingTurn` ([streaming-dispatch.ts](../../../src/agent/streaming-dispatch.ts)): `tool_use_end` 즉시 dispatch(in-flight, await 안 함, concurrency-safe만), 첫 concurrency-UNSAFE는 head-of-line barrier → 이후 전부 deferred. resultBlocks는 model-call order로 정렬.
- **Codex** 🟡≈ — sequential after stream close 추정.
- **Claude** ✅ — `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 병렬 제한. inline.
- **Cursor** ✅ — 한 assistant 메시지 N tool_call = 병렬, exec_id별 독립 ExecServerMessage. 도구간 순서 보장 없음(quanta는 보장).
- **판정**: quanta+Claude+Cursor 모두 병렬. quanta만 **HOL barrier + order 보장** 명시.

## A5. compaction (트리거/방식)
- **quanta** ✅ — proactive(`compactIfNeeded`, 120k threshold 전) + reactive(`reactiveCompact`, PTL 에러 후) + `CompactionBreaker`(3-strike thrash 차단, 15% progress ratio). `<conversation summary>` 합성 user 메시지. 6턴 keep.
- **Codex** ✅≈ — session-corpus 통계상 34% 세션 compaction. 방식 추론.
- **Claude** ✅ — auto-compact 임계(모델 윈도우 비율) + post-compact 파일복원(50K/파일 5K) + rapid-refill breaker. `[earlier conversation truncated]` 마커.
- **Cursor** ✅ — `ConversationTokenDetails{used,max}` 감시 → PreCompact hook → summary_started/summary/summary_completed. speculative summarization(WarmStream).
- **판정**: 4사 다 있음. Claude=파일복원까지, Cursor=speculative pre-warm, quanta=breaker pure-state-machine. 각자 강점 다름.

## A6. provider fallback
- **quanta** ✅ — `FallbackLLM` ([llm/fallback.ts](../../../src/llm/fallback.ts)): 529 overload → 다음 provider swap + `stream_reset` tombstone(dead partial 폐기). isFallbackTrigger 분류기.
- **Codex** 🟡≈ — 미확인.
- **Claude** 🟡 — overloaded_error/rate_limit → retry. provider swap 미확인(단일 provider 가정).
- **Cursor** 🟡 — `allow_model_fallbacks` bool + best_of_n. 서버측 라우팅.
- **판정**: quanta만 client-side stream_reset tombstone 명시. Cursor는 서버 라우팅(다른 층).

## A7. abort / cancel
- **quanta** ✅ — `AbortSignal` threading 전 구간 + `isAborted()` 체크. abort-aware sleep.
- **Codex** 🟡≈ — 미확인.
- **Claude** 🟡 — cancel flow implicit.
- **Cursor** ✅ — typed 4종: `cancel_action{reason}`(메인) / `cancel_subagent_action{id}`(자식만) / `ExecServerControlMessage.abort` / `ShellAbortReason{USER_ABORT,TIMEOUT}`.
- **판정**: Cursor가 가장 세분(자식 단독 취소). quanta는 signal-aware 일관. Claude 약함.

## A8. maxTurns / idle 거버넌스
- **quanta** ✅/❌ — maxTurns 카운터(tools 결과만 증가, recovery 미증가) ✅. **idle timeout/stream hang cap ❌**(turn 카운터만).
- **Codex** 🟡≈ — 미명시.
- **Claude** 🟡 — `withStreamTimeout`(firstChunk + idle deadline) ✅ — quanta엔 없는 stream hang guard.
- **Cursor** ✅ — `ClientContinuationConfig{idle_threshold, max_loops(hook loop_limit=5), nudge, escape}` 명시 거버넌스.
- **판정**: ★ **quanta 갭** — idle/stream-hang timeout 없음. Claude `withStreamTimeout` + Cursor `idle_threshold/max_loops` 둘 다 가짐. **흡수 우선순위 HIGH**.

## A9. subagent orchestration
- **quanta** ✅ — `agent-tool.ts`(Task) + 6-tool(exec_command/write_stdin/spawn/wait/close/send_input) + role(explorer/worker/none) + nickname + continue_from/checkpoint + depth+1 격리 fork + thread_spawn JSONL. background spawn 🟡(명시 약함).
- **Codex** ✅ — ✅소스확인 — **9 subagent tool**(close_agent/exec_command/read_thread_terminal/request_user_input/send_input/spawn_agent/update_plan/wait_agent/write_stdin) — archived_sessions JSONL 검증. quanta가 흡수한 건 6-tool subset.
- **Claude** 🟡 — side-question spawn(별도 경량 agent + 격리 reminder). createAgent/getAgents IPC.
- **Cursor** ✅ — task(19) → subagent_args(28): resume/fork/run_in_background/interrupt/readonly/mode. cancel_subagent. force_background_subagent. 자식 스트림 부모에 중첩(TaskToolCallDelta).
- **판정**: quanta(Codex 흡수)+Cursor 강함. quanta는 **background non-blocking fork가 약함**(Cursor force_background_subagent 대비). Claude는 side-question만.

---

# B. TOOLS / PERMISSION / SANDBOX

## B1. 도구 인벤토리
- **quanta** ✅ — 표준 13 + git(commit/branch_switch/blame/diff/log/status) + apply-patch + lsp_nav + localize + test-runner + deferred + working-state 메타툴.
- **Codex** ✅ — 표준 + 6 subagent tool + apply_patch V4A.
- **Claude** ✅ — 13 표준 + Desktop(browser_batch/computer_use/tabs_context_mcp).
- **Cursor** ✅ — 44 ToolCall (cursor.md protobuf descriptor 기준). ⚠️ strings grep으론 6개만 확인(SHELL/READ_FILE/EDIT_FILE/DELETE_FILE/SEARCH_CODE/RUN_TERMINAL — minified라 44 직접 미검증).
- **판정**: Cursor 도구 수 최다(44 descriptor 주장). quanta/Codex/Claude ~13-20. ⚠️ 44는 protobuf 분석값, strings 검증은 6.

## B2. 도구 계약 (모델에 스키마 노출)
- **quanta** ✅ — `tools[]`에 full JSON schema. `Tool` interface: isReadOnly/isConcurrencySafe/hitlTier/extractShellCommand 선언.
- **Codex** 🟡 — partial.
- **Claude** ✅ — `tools[]` full JSON schema 전송 (클라가 다 봄).
- **Cursor** ❌ — `supported_tools`에 **enum id만**, JSON 스키마 본체 서버전용(클라 추출 불가).
- **판정**: quanta/Claude 투명(스키마 노출). Cursor 불투명(enum만). quanta만 isConcurrencySafe로 streaming interleave 결정.

## B3. 권한 게이트 단계
- **quanta** ✅ — `runAdmissibilityGate` **8-stage 단일 함수**: mode→HARD_DENY(early)→pattern auto-pass→prefix-rule DSL→HITL→permission stack→trust scope→policy→hook. 전부 opt-in(absent이면 레거시 4-stage byte-identical).
- **Codex** ❌≈ — dispatch.ts에 분산(SSOT 아님). 1060 prefix_rule.
- **Claude** ✅(문서) — HITL + permission + sandbox + bridge preflight + TCC. 단계 문서화됐으나 SDK 코드엔 분산.
- **Cursor** ≈ — reviewKind + isExecutionBlocking + classifier. layer fusion(단일 함수 아님).
- **판정**: ★ quanta만 **단일 함수 8-stage SSOT**. 나머지 분산.

## B4. HITL tier
- **quanta** ✅ — `HITLTier` 4종(hand-off-required/always-confirm/pre-approval-ok/none). 도구가 self-declare(`tool.hitlTier`) + registry 패턴 composition(stricter 이김).
- **Codex** ✅ — hitl-audit.md 4-tier(quanta가 흡수 원본).
- **Claude** ✅ — always-confirm/pre-approval 등. Desktop trust + bridge.
- **Cursor** ≈ — reviewKind(edit/terminal/mcp/plan/web_fetch) + isExecutionBlocking(plan만 false). tier 명시 enum 아님.
- **판정**: quanta/Codex 명시 4-tier. Cursor는 reviewKind 5종(다른 분류축).

## B5. reviewer 다단 승인 (★ 정정)
- **quanta** ✅ — `ReviewerTier` 3종(user/auto_review/guardian_subagent) + `ApprovalOutcome` **8-state** + invariant 검증(OutcomeInvariantError) + sticky DenialMemory precedence. **typed enum + 컴파일타임 exhaustiveness**.
- **Codex** 🟡 — config `approvals_reviewer="user"` (reviewer 역할 개념 있음, 다단 outcome enum은 미확인).
- **Claude** 🟡 — ✅소스확인 — `advisor` tool(stronger reviewer model) + named reviewer subagent(code-reviewer/security-reviewer/tech-lead). **subagent 패턴** — outcome enum/invariant은 없음.
- **Cursor** 🟡 — 결정동사(RUN/SKIP/ALLOWLIST/REJECT_AND_TELL) per reviewKind. reviewer tier enum/outcome matrix 없음.
- **판정**: reviewer "기능"은 Codex/Claude도 있음(정정). **quanta만 8-state ApprovalOutcome + invariant 검증 + typed 3-tier**로 형식화 — 나머지는 subagent/config/결정동사 등 비형식.

## B6. trust scope (★ 정정)
- **quanta** ✅ — `TrustScope` 5-tier(always_allow/project/workspace/session/once_only/deny) 2D matrix(space×time) + once_only 인라인 consume + registry.
- **Codex** ✅ — ✅소스확인 — config.toml `[projects."path"] trust_level="trusted"/"untrusted"` per-project 2-state.
- **Claude** ✅ — ✅소스확인 — Claude Code(CLI) `trustedNetworkDirectories`/`TrustDialog`/"Trust this directory?" + Desktop `saveTrust` 5-scope.
- **Cursor** 🟡 — terminal `ALLOWLIST_COMMANDS` / edit `ACCEPT_AND_ALLOW_FOLDER` 영속(scope 개념은 있으나 5-tier matrix 아님).
- **판정**: ★ 정정 — **4사 다 trust 개념 보유**(내가 quanta 유일이라 한 건 오류). quanta=5-tier space×time matrix로 가장 세분, Codex=per-project 2-state, Claude=directory trust, Cursor=allowlist 영속.

## B7. rule DSL
- **quanta** ✅ — `RulesStore` prefix-rule(allow/deny/ask/no_match) + 3-layer(project>user>system) + noMatchPolicy(deny/fallthrough) + reviewer 에스컬레이션.
- **Codex** 🟡 — default.rules 1060 prefix_rule(100% allow, default-deny). passive denylist.
- **Claude** 🟡 — CLAUDE.md passive(rule이 아니라 instruction).
- **Cursor** 🟡 — .mdc 4-primitive glob rule (서버 적용) + server rules.
- **판정**: quanta=active gate(allow/deny/ask 분기). Codex=denylist. Claude=instruction. Cursor=.mdc glob(컨텍스트 주입).

## B8. OS sandbox (★ quanta 최대 갭)
- **quanta** 🟡 — Docker optional(`DockerSandbox`/`LocalSandbox`) + env allowlist scrub. **OS-레벨 강제 격리 default ❌**.
- **Codex** ✅ — ✅소스확인 — config `sandbox_mode` 3-mode(read-only/workspace-write/danger-full-access). `.codex-global-state.json` `agent-mode-by-host-id`. 실제 seatbelt/Landlock 강제는 codex-rs 바이너리 내부(npm wrapper엔 config만).
- **Claude** ✅ — Cowork microVM(Go-runtime+vsock+FUSE+MITM, FIPS) + seatbelt 프로파일 + `disclaimer` POSIX_SPAWN_SETDISCLAIM.
- **Cursor** ✅ — **cursorsandbox(Rust)**: Seatbelt/Bubblewrap + 인-프로세스 네트워크 프록시. `.git/{hooks,config}`/`.vscode` write deny-regex 차단.
- **판정**: ★★★ **quanta 단일 최대 갭**. 3사 전부 OS-레벨 강제 격리(Cursor Rust > Codex Seatbelt > Claude microVM). quanta는 Docker optional만. **흡수 우선순위 HIGH** (seatbelt+Landlock toggle).

## B9. shell 격리
- **quanta** ✅ — `shell-disclaim.ts`: bash `--noprofile --norc`/zsh `-f`로 dotfile skip(사용자 zshrc 악성코드 차단). Node/Bun이 POSIX_SPAWN_SETDISCLAIM 미노출이라 entitlement 격리는 ❌(주석 명시).
- **Codex** 🟡≈ — seatbelt 안에서 실행.
- **Claude** ✅ — `disclaimer` Mach-O(진짜 POSIX_SPAWN_SETDISCLAIM) + shell-path-worker.
- **Cursor** ≈ — cursorsandbox 안 dotfile hardening.
- **판정**: Claude가 진짜 OS disclaim(native binary). quanta는 dotfile-skip 근사(Node 한계 명시). 진짜 격리는 B8 sandbox에 의존.

## B10. fs-jail
- **quanta** ✅ — `FsJailError` + `assertPathInsideBaseDir` + symlink escape 차단 + `QUANTA_FS_JAIL=off` opt-out + branded type(컴파일타임 escape 방지) + anti-regression scanner.
- **Codex** ❌≈ — sandbox 레벨만(별도 fs-jail 없음).
- **Claude** 🟡 — `ERR_SAFE_FS_*`(escape/symlink/root/size) 런타임 가드.
- **Cursor** 🟡 — cursorsandbox deny-regex(`.git/hooks` 등).
- **판정**: quanta가 branded-type 컴파일타임 보장으로 가장 강함. Claude=런타임 ERR_SAFE_FS. 나머지 sandbox 의존.

## B11. PreToolUse hook
- **quanta** ✅ — `pre_tool_use` hook + Task matcher vs FS matcher 분리(AWF). `{deny}` 반환 시 차단.
- **Codex** ✅ — hook seam.
- **Claude** ✅ — AWF_GUARDED_TOOLS_MATCHER(흡수 원본) + Task matcher.
- **Cursor** ✅ — ✅소스확인(부분) — strings grep으로 **8 hook 확인**(preToolUse/updated_input/subagentStart/beforeShellExecution/beforeMCPExecution/afterFileEdit/followup_message/onHook) + permission(allow/ask/deny) + `updated_input`(args 재작성) + fail-closed. ⚠️ cursor.md의 "20-event"는 minified로 미검증(8개만 strings 확인).
- **판정**: Cursor가 hook 풍부(≥8 확인, updated_input 재작성은 quanta에 없는 강점). quanta/Codex/Claude는 pre/post + matcher 분리.

## B12. MCP
- **quanta** 🟡 — `McpClient` stdio JSON-RPC 2.0 + tools/list + tools/call. **Tasks/Elicitation/Sampling ❌**.
- **Codex** ✅ — MCP + Skybridge.
- **Claude** ✅ — directMcpHost(Tasks API + Elicitation form/url + Sampling + Streaming + OAuth 14-error). nodeHost 별도 process. 4 runtime(python/node/binary/uv).
- **Cursor** ✅ — mcp_tools 동적 스키마 + mcp_auth + list/read_mcp_resource.
- **판정**: ★ Claude가 MCP 최강(Tasks+Elicitation+OAuth). quanta는 표준 client만(**갭** — Tasks/Elicitation 미구현, 1주).

---

# C. PROMPT / CONTEXT / MEMORY

## C1. 시스템 프롬프트 구조
- **quanta** ✅ — 정책 스택 **L1-L9 명문화**(system safety > developer > app > permission > mode > repo-local > skill > user > working-state) + "user CANNOT override L1-L5". operating principles 14개 + evidence discipline + 4-truth.
- **Codex** ✅≈ — evidence discipline + trust ladder(흡수 원본). 정책 스택은 textual.
- **Claude** 🟡 — identity + tone. 코어 규칙은 서버 블랙박스(minified).
- **Cursor** 🟡 — explicit_context.context(서버 조립). 클라엔 빈 필드.
- **판정**: ★ quanta가 정책 스택을 코드에 명문화한 유일. 3사는 textual 또는 서버.

## C2. identity variant (★ quanta 갭)
- **quanta** ❌ — "You are Quanta…" 단일(persona slot은 default/friendly/pragmatic 있으나 실행모드 variant 아님).
- **Codex** ✅ — 모드별.
- **Claude** ✅ — 3-variant(표준/Agent SDK/side-question).
- **Cursor** ✅ — UnifiedMode 7종 + per-mode 서버 조립.
- **판정**: ★ quanta 갭 — 실행모드별 identity variant 없음. 비용 작음.

## C3. per-turn dynamic context
- **quanta** ✅ — `buildDynamicContext`: env(date/cwd) + modeNotice + repoRules(CLAUDE.md) + activeSkills + workingState(owner/hypothesis/blockers/nextStep/deferred) + memory hint. trailing `<system-reminder>` 1개로 통합 + `escapeReminderBoundary` 위조 방어. 캐시 prefix 불변.
- **Codex** ✅ — turn_context 17필드.
- **Claude** ✅ — 다중 별도 블록(skills/git status/thinking/todo/side-question). 위조 방어 미확인.
- **Cursor** ❌ — system-reminder 캐시 분리 안 함. explicit_context 매턴 전송. ContextItem 패킹(서버 rerank).
- **판정**: quanta가 단일 블록+위조방어로 가장 안전. Claude=다중블록(위조방어 약함). Cursor=캐시분리 안 함.

## C4. prompt cache
- **quanta** ✅ — `fourSectionPreset`(base/project_md/session_ctx/user_append) 각 cache breakpoint + MAX_CACHE_BREAKPOINTS=4 cap + `cacheConversationPrefix`(마지막 text 블록에 ephemeral) + per-turn은 trailing user로 분리(prefix 불변).
- **Codex** ✅≈ — prefix 캐시.
- **Claude** ✅ — `systemPromptSectionCache` 4-breakpoint(흡수 원본) + cache_read_input_tokens 추적.
- **Cursor** 🟡 — explicit_context 고정이나 mode-specific 서버렌더 매턴 전송. Warm RPC.
- **판정**: quanta/Claude 4-section 동등. Cursor 약함(매턴 전송).

## C5. memory (recall/distill/consolidate/eviction) — ★ quanta+Codex만 풀구현
- **quanta** ✅ — 2-phase recall(semantic+tag+freshness) + distill(LLM 대화→구조화) + consolidate(dedup/merge/supersede) + eviction(tier cap+decay) + working-state L3 + self-edit 도구. "routing only, not proof" 헤더 → closeout R4와 짝.
- **Codex** ✅ — ✅소스확인 — **3-layer**: `~/.codex/memories/memory_summary.md`(durable 463줄 SSOT) + `chronicle/`(10분 윈도우) + `ad_hoc/notes/`. config `memories=true, chronicle=true`. quanta(recall/distill/consolidate/eviction)와 구조 다름 — Codex는 파일 기반 durable+windowed.
- **Claude** ❌ — ✅소스확인 — Claude Code/Desktop 바이너리에 persistent memory 시스템 흔적 없음(CLAUDE.md만). recall/distill/episodic/semantic 미발견.
- **Cursor** 🟡 — `<memories>` 블록(100% 서버). 클라 memory store 없음.
- **판정**: ★★ quanta+Codex만 풀 memory 파이프라인. Claude/Cursor는 ❌(서버 또는 instruction).

## C6. skill 주입
- **quanta** ✅ — `renderActiveSkillsBlock`(progressive disclosure: 첫줄만 + invoke 시 SKILL.md 로드) + Trigger rules 4 + skill-size 30MB cap + activation glob.
- **Codex** ✅ — .system/ SKILL.md frontmatter(흡수 원본).
- **Claude** 🟡 — Desktop skills(30MB cap + slash menu) + side-question.
- **Cursor** ✅ — .mdc glob 매칭 + SKILL.md 본문 주입(babysit/verify-this/deslop/canvas/shell/split-to-prs 등 verbatim).
- **판정**: 4사 다 progressive disclosure. Cursor가 번들 skill 본문 가장 많음(verbatim 6+). quanta=Codex 흡수.

## C7. closeout / verify reminder
- **quanta** ✅ — 3-variant closeout(`CLOSEOUT_REMINDER` 기본 / `CLOSEOUT_4RULE_REMINDER` R1-R4 defended-claim / `CODE_MOD_CLOSEOUT_REMINDER` 4-truth-surface) + verify-guard(`VERIFY_FORCE_MESSAGE` + TEST_LIKE_RE 13패턴, git status noise 제외).
- **Codex** ✅ — response-assembly-and-closeout.md(흡수 원본) + surface-alignment.
- **Claude** 🟡 — code-mod 종료 가이드(다른 형태).
- **Cursor** 🟡 — verify-this/loop-on-ci SKILL.md(skill로 처리, 강제 게이트 아님).
- **판정**: ★ quanta가 3-variant + verify-guard regex로 가장 체계적(Codex 흡수). 강제 종료-차단 게이트는 quanta 우월.

## C8. mode별 프롬프트
- **quanta** ✅ — modeNotice 3종 verbatim(PLAN/REVIEW/AUDIT) + AgentMode 4(default/plan/review/audit) fail-closed + CollaborationMode(plan/default sticky).
- **Codex** ✅ — Default vs Plan(흡수 원본). dispatch-seam mutating 차단.
- **Claude** 🟡 — plan mode(getPlanForSession + 별도 산출물).
- **Cursor** ✅ — UnifiedMode 7(CHAT/AGENT/EDIT/PLAN/DEBUG/...) + mode_specific_context(서버). plan=enabledTools:[].
- **판정**: 4사 다 mode 있음. Cursor 7종 최다(서버 조립). quanta 4종 명시 코드.

---

# 요약 — 축별 승자

| 축 | 1위 | 비고 |
|---|---|---|
| A1 loop 구조 | 공동 | 각자 패러다임(while/for-each/BiDi) |
| A2 stop_reason | **Claude**(8) | quanta 실용4(refusal 포함), pause 의도제외 |
| A3 SAME-turn 복구 | **quanta**(6-enum) | Cursor=데이터계약 |
| A4 streaming dispatch | **quanta**(HOL barrier+order) | Claude/Cursor 병렬이나 order 미보장 |
| A5 compaction | 공동 | Claude=파일복원, Cursor=speculative, quanta=breaker |
| A6 fallback | **quanta**(stream_reset) | Cursor=서버라우팅 |
| A7 abort | **Cursor**(자식단독) | quanta=signal일관 |
| A8 idle/timeout | **Claude+Cursor** | ★ quanta 갭 |
| A9 subagent | **quanta+Cursor** | quanta bg-fork 약함 |
| B1 도구 수 | **Cursor**(44) | |
| B2 스키마 노출 | **quanta+Claude** | Cursor 불투명 |
| B3 게이트 SSOT | **quanta**(8-stage 단일함수) | 나머지 분산 |
| B4 HITL | **quanta+Codex**(4-tier) | |
| B5 reviewer/outcome | **quanta**(형식화 유일) | 8-state outcome+invariant은 유일; reviewer 기능은 Claude(advisor)도 있음 |
| B6 trust scope | **quanta**(5-tier matrix) | ★정정: 4사 다 trust 있음. Codex=2-state, Claude=dir, Cursor=allowlist |
| B7 rule DSL | **quanta**(active allow/deny/ask) | |
| B8 OS sandbox | **Cursor**(Rust)>Codex>Claude | ★★★ quanta 최대 갭 |
| B9 shell 격리 | **Claude**(native disclaim) | quanta=dotfile근사 |
| B10 fs-jail | **quanta**(branded type) | |
| B11 hook | **Cursor**(20 event+updated_input) | |
| B12 MCP | **Claude**(Tasks+Elicitation+OAuth) | ★ quanta 갭 |
| C1 정책스택 | **quanta**(L1-L9 코드) | |
| C2 identity variant | **Codex/Claude/Cursor** | ★ quanta 갭 |
| C3 dynamic context | **quanta**(단일+위조방어) | |
| C4 prompt cache | **quanta+Claude**(4-section) | |
| C5 memory | **quanta+Codex**(풀파이프라인) | Claude/Cursor ❌ |
| C6 skill | 공동 | Cursor 번들 최다 |
| C7 closeout/verify | **quanta**(3-variant+regex) | |
| C8 mode | 공동 | Cursor 7종 |

## quanta 갭 (펼친 우선순위)
1. **B8 OS sandbox** ★★★ — 3사 전부 OS 강제격리, quanta는 Docker optional. seatbelt+Landlock toggle. **HIGH**.
2. **A8 idle/stream-hang timeout** ★ — Claude withStreamTimeout + Cursor idle_threshold/max_loops. quanta 없음. **HIGH, 비용 작음**.
3. **B12 MCP Tasks+Elicitation** — Claude directMcpHost. quanta 표준 client만. **MID, 1주**.
4. **C2 identity variant** — 실행모드별. quanta 단일. **MID, 작음**.
5. **A9 background subagent fork** — Cursor force_background_subagent. quanta 약함. **MID**.
6. **B11 hook updated_input** — Cursor args 재작성. quanta는 deny만. **LOW**.

## quanta 고유 자산 (실제 소스 검증 후 — 진짜 3사 어디에도 없는 것만)
- **B5 ApprovalOutcome 8-state + invariant 검증(OutcomeInvariantError) + typed exhaustiveness** — reviewer "기능"은 Claude advisor도 있으나, **outcome enum + 컴파일타임 invariant**는 quanta만.
- **B3 admissibility 8-stage 단일함수 SSOT** — Codex는 dispatch 분산, Claude는 문서만, Cursor는 fusion. quanta만 단일 함수 canonical order.
- **B10 fs-jail branded type** (컴파일타임 path escape 방지 + anti-regression scanner) — Claude=런타임 ERR_SAFE_FS, 나머지 sandbox 의존.
- **A3 RecoveryAction 6-enum** (typed) / **A4 streaming HOL barrier + model-call order 보장**.
- **C1 정책스택 L1-L9 코드 명문화** / **C3 escapeReminderBoundary 위조방어** (per-turn 단일 reminder).
- **B7 rule DSL active allow/deny/ask** (Codex=denylist만, Cursor=.mdc glob 컨텍스트주입).

## quanta 고유 아님 (정정 — 내가 유일이라 했으나 3사도 보유)
- **trust scope** — Codex(per-project 2-state) + Claude(dir trust) 둘 다. quanta는 5-tier로 더 세분일 뿐.
- **reviewer 기능** — Claude advisor + named reviewer subagent. quanta는 형식화(8-state)가 다른 것.
- **5-tier가 아닌 trust 자체**는 흔함.

---
**자매**: [cursor.md](cursor.md) · [claude.md](claude.md)
