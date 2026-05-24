# claude-repomap — 기깔난 기능 → v3 코드 위치 한 줄 인덱스

> 코드 에이전트 suite(Claude Desktop 1.7196.3 / Claude Code v2 / Codex / Cursor) 분석에서 추린
> "기깔난" 기능과 그것이 v3 어디에 사는지 한 줄 매핑. 에디터에서 코드 위치 클릭 → 바로 점프.
>
> **출처 태그**: `CD`=Claude Desktop · `CCv2`=Claude Code v2 · `CX`=Codex · `CR`=Cursor · `v3`=quanta 고유 발전
> **상태**: ✅ 구현 · 🟡 부분/opt-in · ❌ 미구현(출처만)

---

## 1. 응답 처리 / LLM adapter

| 기능 | 코드 위치 | 한 줄 | 출처 |
|---|---|---|---|
| ✅ SSE wire→neutral 정규화 | [anthropic.ts `mapRawEvent`](../../../src/llm/adapters/anthropic.ts#L295) | RawEvent(7종) → StreamEvent(8종) pure switch | CD |
| ✅ StreamEvent union | [llm/types.ts:62](../../../src/llm/types.ts#L62) | text/tool_use/usage/stream_reset/response_in_progress/message_stop | v3 |
| ✅ 스트림 메시지 재조립 | [assemble.ts `assembleFromEvents`](../../../src/llm/assemble.ts#L11) | event[] → {message, stopReason}, tool_use_delta는 no-op | v3 |
| ✅ prompt cache 정렬 | [anthropic.ts `cacheConversationPrefix`](../../../src/llm/adapters/anthropic.ts#L128) | 마지막 text block에 ephemeral cache_control (tool_use 회피) | CCv2 |
| ✅ provider 폴백 + tombstone | [llm/fallback.ts](../../../src/llm/fallback.ts) | 529 overload → swap model + `stream_reset`로 dead partial 폐기 | CCv2 |
| ✅ path별 retry 분류 | [agent/retry.ts `classifyLLMError`](../../../src/agent/retry.ts) | PTL→compaction / retryable→backoff / fatal→throw | v3 |
| ✅ stream hang guard | [anthropic.ts:235 `withStreamTimeout`](../../../src/llm/adapters/anthropic.ts#L235) | firstChunk + idle deadline → stream_corrupt | v3 |
| ✅ tool input JSON 안전 | [anthropic.ts `finalizeToolInput`](../../../src/llm/adapters/anthropic.ts#L350) | malformed JSON → stream_corrupt LLMError | v3 |
| ✅ anthropic-beta 채널 | [anthropic.ts:20 `betaHeaders`](../../../src/llm/adapters/anthropic.ts#L20) | skills-2025-10-02 / oauth-2025-04-20 / environments-2025-11-01 | CD |
| 🟡 OpenAI Responses SSE+WS 디코드 | [llm/streaming-events.ts](../../../src/llm/streaming-events.ts) | response.in_progress 흡수 + unknown은 null+rate-limit log | CX |

## 2. Agent loop / turn

| 기능 | 코드 위치 | 한 줄 | 출처 |
|---|---|---|---|
| ✅ ReAct 루프 | [agent/loop.ts](../../../src/agent/loop.ts) | turn 단위 while, FSM 없음 (RFC §1.2) | v3 |
| ✅ streaming 인터리브 dispatch | [agent/streaming-dispatch.ts `streamingTurn`](../../../src/agent/streaming-dispatch.ts) | tool_use_end 즉시 dispatch(concurrency-safe만), unsafe는 HOL barrier | CCv2 |
| ✅ thinking heartbeat seam | [streaming-dispatch.ts `InProgressHandler`](../../../src/agent/streaming-dispatch.ts) | response_in_progress → "thinking…" 콜백 | CD/CX |
| ✅ 단일-tier compaction | [agent/compaction.ts](../../../src/agent/compaction.ts) | 120k threshold, tool_use/result 짝 보전 | CCv2 |
| ✅ verify-guard / closeout-guard | [agent/verify-guard.ts](../../../src/agent/verify-guard.ts) · [closeout-guard.ts](../../../src/agent/closeout-guard.ts) | test 검증 regex / 종료 안전 — git status noise 회피 | v3 |
| ✅ follow-up queue | [agent/follow-up-queue.ts](../../../src/agent/follow-up-queue.ts) | 긴 턴 중 사용자 입력 큐잉 (pausedReason) | CX |

## 3. 권한 / admissibility (응답의 tool_use 분기)

| 기능 | 코드 위치 | 한 줄 | 출처 |
|---|---|---|---|
| ✅ admissibility SSOT 6-stage | [agent/admissibility-gate.ts `runAdmissibilityGate`](../../../src/agent/admissibility-gate.ts#L335) | mode→HITL→stack→trust→policy→hook 단일 파일 순서 | CX |
| ✅ HITL 4-tier | [permission/types.ts `HITLTier`](../../../src/permission/types.ts) | hand-off/always-confirm/pre-approval/none | CX |
| ✅ ReviewerTier 3 + Outcome 8 | [permission/types.ts `ReviewerTier`](../../../src/permission/types.ts) | user/auto_review/guardian_subagent × 8 terminal state | CX |
| ✅ trust-scope 5-tier 2D matrix | [permission/trust-scope.ts](../../../src/permission/trust-scope.ts) | always_allow/project/workspace/session/once_only/deny | CD `saveTrust` |
| ✅ trust-scope wire-up (ask 분기) | [admissibility-gate.ts `resolveAskBranch`](../../../src/agent/admissibility-gate.ts#L274) | grant 있으면 onConfirm skip, once_only 인라인 consume | CD (ADR-0050) |
| ✅ permission stack | [permission/stack](../../../src/permission/) | per-thread × per-host × post-denial precedence | CX (ADR-0046) |
| ✅ PreToolUse 2-matcher | [agent/tool-matchers.ts](../../../src/agent/tool-matchers.ts) | FS도구(7) vs Task(agent-spawn) 분리 = AWF_GUARDED | CD |
| ✅ Plan/Default collaboration | [agent/mode.ts `CollaborationMode`](../../../src/agent/mode.ts#L73) | plan에서 mutating 차단, dev-channel 메시지로만 sticky 전환 | CX |
| ✅ AgentMode 4-posture | [agent/mode.ts `MUTATING_MODES`](../../../src/agent/mode.ts) | default/plan/review/audit, fail-closed | CX |
| ✅ auto mode 분류기 | [permission/classifier.ts](../../../src/permission/classifier.ts) | ask 대신 LLM 분류 (AFK) — CD에 없는 v3 발전 | v3 |

## 4. Session / rewind / fork

| 기능 | 코드 위치 | 한 줄 | 출처 |
|---|---|---|---|
| ✅ message-id rewind | [session/store.ts `rewindToMessage`](../../../src/session/store.ts) | msgId 이후 transcript truncate (Phase-A snapshot) | CD `rewind` (ADR-0052) |
| ✅ session fork | [session/store.ts `forkSession`](../../../src/session/store.ts#L232) | structuredClone 풀 세션 복사, source 불변 | CD `forkSession` |
| ✅ msg-id 부여 | [session/store.ts `assignMessageIds`](../../../src/session/store.ts) | 미배정 메시지에 uuid, 기존 id 보존 | CD |
| ✅ JSONL envelope (5 record) | [session/envelope.ts](../../../src/session/envelope.ts) | session_meta/turn_context(17필드)/event_msg/response_item/thread_spawn | CX (ADR-0034) |
| ✅ persistent worktree fork | [runtime/worktree-fork.ts `createPersistentWorktree`](../../../src/runtime/worktree-fork.ts) | safeId/safeBranch 인젝션 가드, top-level 대화 분기 | CD `forkSession --worktree` |
| ✅ CLI fork/rewind 명령 | [apps/cli/session-commands.ts](../../../src/apps/cli/session-commands.ts) | `fork <id> [--worktree]`, `rewind <id> <msg-id>` | CD |
| ❌ teleport-to-cloud | (미구현) | 로컬 세션 → 클라우드 readiness check + 이주 | CD `teleportToCloud` |
| ❌ side chat | (미구현) | 메인 컨텍스트 공유 + 답 격리 보조 채팅 | CD `startSideChat` |
| ❌ CLI↔Web 양방향 | (미구현, web surface 도착 시) | importCliSession / logCliEvent | CD |

## 5. Git mutating tools

| 기능 | 코드 위치 | 한 줄 | 출처 |
|---|---|---|---|
| ✅ git_commit (wip/regular) | [tool/git/commit.ts](../../../src/tool/git/commit.ts) | wip→pre-approval-ok, regular→always-confirm | CD `commitWipForBranchSwitch` (ADR-0053) |
| ✅ git_branch_switch (autoWip) | [tool/git/branch-switch.ts](../../../src/tool/git/branch-switch.ts) | dirty+autoWip → wip 커밋 후 전환, 인젝션 regex 가드 | CD (ADR-0053) |
| ✅ read-only git 4종 | [tool/git/](../../../src/tool/git/) | status/log/diff/blame | CCv2 |
| ✅ mutating-tool plan-block 테이블 | [agent/mode.ts `MUTATING_TOOL_TABLE`](../../../src/agent/mode.ts#L144) | git_commit/branch_switch = git_mutating, plan에서 차단 | CX |
| ❌ PR/auto-merge/ultrareview | (미구현) | createLocalPr/enableAutoMerge/launchUltrareview/reviewDiff | CD |

## 6. Prompt / cache

| 기능 | 코드 위치 | 한 줄 | 출처 |
|---|---|---|---|
| ✅ system prompt (static 캐시) | [agent/prompt.ts `buildTurnContext`](../../../src/agent/prompt.ts) | per-turn dynamic은 trailing `<system-reminder>`로 분리 | CCv2 |
| ✅ 4-section preset | [agent/prompt-sections.ts `fourSectionPreset`](../../../src/agent/prompt-sections.ts) | base+project_md+session_ctx+user_append, 각 cache breakpoint | CD `systemPromptSectionCache` (ADR-0051) |
| ✅ cache breakpoint budget | [prompt-sections.ts `validateSectionsCacheBudget`](../../../src/agent/prompt-sections.ts) | Anthropic 4-breakpoint cap 가드 | CD |
| ✅ reminder boundary defang | [agent/prompt.ts `escapeReminderBoundary`](../../../src/agent/prompt.ts) | repoRules/memory가 system-reminder 위조 못 하게 | v3 |

## 7. Metrics / observability

| 기능 | 코드 위치 | 한 줄 | 출처 |
|---|---|---|---|
| ✅ token usage 카운터 | [agent/metrics.ts `AgentRecorder.tokensUsed`](../../../src/agent/metrics.ts) | gen_ai.usage.input/output_tokens + cache_read | CD `getContextUsage` (ADR-0054) |
| ✅ context-usage status line | [apps/cli/status-line.ts `formatContextUsage`](../../../src/apps/cli/status-line.ts) | surface-agnostic 20-char bar `[█░] 50k/200k (25%)` | CD (ADR-0054) |
| ✅ OTel attribute vocab | [observability/vocabulary.ts](../../../src/observability/vocabulary.ts) | quanta.{thread,memory}.* + gen_ai.usage.* canonical keys | CX |
| ✅ 가격 계산 | [observability/pricing.ts](../../../src/observability/pricing.ts) | in/out/cache_read per-M, pinned pricing version | v3 |

## 8. MCP

| 기능 | 코드 위치 | 한 줄 | 출처 |
|---|---|---|---|
| ✅ MCP stdio client | [mcp/client.ts](../../../src/mcp/client.ts) | spawn→initialize→tools/list+call, per-req timeout, env scrub | CD/CX |
| ✅ JSON-RPC 2.0 codec | [mcp/jsonrpc.ts](../../../src/mcp/jsonrpc.ts) | newline-delimited, envelope 검증(id spoof 방어) | CD/CX |
| ❌ Tasks API + TaskMessageQueue | (미구현) | tasks/{list,get,result,cancel} 장기실행 + SSE 재연결 drain | CD `directMcpHost` |
| ❌ Elicitation (form/url + OAuth) | (미구현) | elicitation/create → 사용자 입력/브라우저 OAuth | CD |

## 9. Subagent (멀티 에이전트 오케스트레이션)

| 기능 | 코드 위치 | 한 줄 | 출처 |
|---|---|---|---|
| ✅ agent tool (Task) 진입점 | [subagent/agent-tool.ts `createAgentTool`](../../../src/subagent/agent-tool.ts#L301) | 이름있는 profile(Explore/Plan) 또는 general fork 디스패치 | CCv2/CX |
| ✅ continue_from (재개) | [agent-tool.ts:50 `continue_from`](../../../src/subagent/agent-tool.ts#L50) | 직전 시도의 finalText 이어받기, LRU evict 시 에러 | CX |
| ✅ checkpoint (상태 파일) | [agent-tool.ts:57 `checkpoint`](../../../src/subagent/agent-tool.ts#L57) | `<cwd>/.subagent-state/<taskId>.md`, worktree와 상호배타 | CX |
| ✅ exec_command (75% 사용) | [tools-6.ts `ExecCommandInputSchema`](../../../src/subagent/tools-6.ts#L57) | PTY 세션 명령 실행, discriminated union 출력 | CX |
| ✅ write_stdin (24%) | [tools-6.ts `WriteStdinInputSchema`](../../../src/subagent/tools-6.ts#L97) | 실행 중 PTY에 stdin 주입 (interactive REPL) | CX |
| ✅ spawn_agent | [tools-6.ts `SpawnAgentInputSchema`](../../../src/subagent/tools-6.ts#L124) | 자식 에이전트 spawn (비동기 handle 반환) | CX |
| ✅ wait_agent | [tools-6.ts `WaitAgentInputSchema`](../../../src/subagent/tools-6.ts#L154) | 자식 완료 대기 (블로킹 join) | CX |
| ✅ close_agent | [tools-6.ts `CloseAgentInputSchema`](../../../src/subagent/tools-6.ts#L179) | 자식 종료 + 리소스 회수 | CX |
| ✅ send_input | [tools-6.ts `SendInputInputSchema`](../../../src/subagent/tools-6.ts#L202) | 실행 중 자식에게 메시지 전달 | CX |
| ✅ 6-tool contract 테이블 | [tools-6.ts `SUBAGENT_6_TOOL_CONTRACTS`](../../../src/subagent/tools-6.ts#L232) | 6 도구 in/out 스키마 closed registry | CX |
| ✅ agent role 정책 | [subagent/role.ts `getToolPolicyForRole`](../../../src/subagent/role.ts#L89) | explorer(42%)/worker(16%)/none(28%) → 도구 allowlist | CX |
| ✅ ToolKind × role 게이트 | [role.ts:24 `TOOL_KINDS`](../../../src/subagent/role.ts#L24) | role별 허용 ToolKind, UnknownAgentRoleError fail-closed | CX |
| ✅ 거장 nickname 풀 | [nicknames.ts `MAESTRO_NICKNAMES`](../../../src/subagent/nicknames.ts#L24) | 39 닉네임, seed 기반 assign + sequential 충돌회피 | CX |
| ✅ LRU registry | [subagent/registry.ts](../../../src/subagent/registry.ts) | continue_from 조회 + finalText 보존, LRU eviction | v3 |
| ✅ taskKind/resultShape/ownedSurfaces | [subagent/types.ts](../../../src/subagent/types.ts) | 작업종류 × 결과형 × 소유/금지 surface 선언 | CX (subagent-sota) |
| ✅ thread_spawn 링크 (JSONL) | [session/envelope.ts `ThreadSpawnRecord`](../../../src/session/envelope.ts#L210) | parent_session/turn → child_session 계보 기록 | CX |
| ✅ depth+1 격리 fork runner | [subagent/index.ts](../../../src/subagent/index.ts#L17) | 필터된 registry + own surface, depth 한계 enforce | v3 |
| ✅ worktree 격리 spawn | [runtime/worktree-fork.ts](../../../src/runtime/worktree-fork.ts) | isolation:"worktree" → 자식 throwaway worktree | CD/v3 |
| ❌ side-conversation prompt | (미구현) | 자식에게 별도 dev-message 컨텍스트 주입 | CX round-4 |

## 10. Runtime / OS 격리

| 기능 | 코드 위치 | 한 줄 | 출처 |
|---|---|---|---|
| ✅ disclaimed shell launch | [runtime/shell-disclaim.ts](../../../src/runtime/shell-disclaim.ts) | bash --noprofile --norc / zsh -f → 사용자 dotfile 미실행 | CD `POSIX_SPAWN_SETDISCLAIM` |
| ✅ Docker/Local sandbox | [runtime/sandbox.ts](../../../src/runtime/sandbox.ts) | env allowlist scrub, DockerSandbox | v3/CX |
| ✅ fs jail | [storage/service.ts `FsJailError`](../../../src/storage/service.ts) | assertPathInsideBaseDir, symlink escape 차단 | CD `ERR_SAFE_FS_*` |
| ✅ shell runner | [runtime/shell.ts `runShell`](../../../src/runtime/shell.ts) | env scrub + timeout 통합 | v3 |
| ❌ native disclaim broker (entitlement) | (미구현, ROI 낮음) | true TCC/entitlement 격리는 native shim 필요 | CD |

## 11. Tools (도구 사용 인프라)

| 기능 | 코드 위치 | 한 줄 | 출처 |
|---|---|---|---|
| ✅ tool registry | [tool/registry.ts `ToolRegistry`](../../../src/tool/registry.ts) | name→Tool 맵, 필터 가능(subagent depth), get/has | v3 |
| ✅ tool factory | [tool/factory.ts](../../../src/tool/factory.ts) · [tool/index.ts `defaultTools`](../../../src/tool/index.ts) | 표준 도구셋 조립 | v3 |
| ✅ tool schema/contract | [tool/types.ts `Tool`](../../../src/tool/types.ts) | isReadOnly/isConcurrencySafe/hitlTier/extractShellCommand 선언 | v3 |
| ✅ concurrency-safe 선언 | [tool/types.ts `isConcurrencySafe`](../../../src/tool/types.ts) | streamingTurn 인터리브 dispatch 가부 결정 | CCv2 |
| ✅ HITL tier 선언 (per-tool) | [tool/edit/index.ts `hitlTier`](../../../src/tool/edit/index.ts) | edit=pre-approval-ok, 도구가 자기 위험도 self-declare | CX |
| ✅ bash (HITL git-prefix 가드) | [tool/bash/index.ts](../../../src/tool/bash/index.ts) | git push/commit/checkout → always-confirm, GIT_PREFIX regex | CX hitl-audit |
| ✅ edit (exact+fuzzy) | [tool/edit/index.ts](../../../src/tool/edit/index.ts) | old_string 정확/공백관용 매칭, mismatch hint | CCv2 |
| ✅ apply-patch V4A | [tool/apply-patch.ts](../../../src/tool/apply-patch.ts) | `*** Move to:` rename + edit atomic, EBNF grammar | CX |
| ✅ scripted-replace | [tool/scripted-replace.ts](../../../src/tool/scripted-replace.ts) | 다중 정규식 치환 배치 | v3 |
| ✅ deferred tool (lazy schema) | [tool/deferred.ts](../../../src/tool/deferred.ts) | 미사용 도구 스키마 지연 로드, ToolSearch로 fetch | CCv2/CX |
| ✅ output spill 가드 | [tool/output-spill.ts](../../../src/tool/output-spill.ts) | 거대 출력 디스크 spill + keep-tail, 컨텍스트 폭주 방지 | v3 |
| ✅ file-tree summary | [tool/file-tree-summary/](../../../src/tool/file-tree-summary/) | 대형 디렉터리 요약 표현 | v3 |
| ✅ test failure parser | [tool/parse-test-failure/](../../../src/tool/parse-test-failure/) | 테스트 출력 → 구조화 실패 (verify-guard 연동) | v3 |
| ✅ LSP navigation | [tool/lsp_nav/index.ts](../../../src/tool/lsp_nav/index.ts) | 정의/참조 점프, LSP adapter 경유 | v3/CX |
| ✅ diagnostics | [tool/diagnostics/](../../../src/tool/diagnostics/) | LSP 진단 수집 | v3 |
| ✅ localize (코드 위치 탐색) | [tool/localize/index.ts](../../../src/tool/localize/index.ts) | 심볼/패턴 → 파일:라인 후보 | v3 |
| ✅ test-runner | [tool/test-runner/](../../../src/tool/test-runner/) | 테스트 실행 + 결과 파싱 | v3 |
| ✅ read/write/glob/grep | [tool/read](../../../src/tool/read/) · [write](../../../src/tool/write/) · [glob](../../../src/tool/glob/) · [grep](../../../src/tool/grep/) | 표준 도구셋, fs-jail 통과 | CCv2 |
| ✅ working-state 메타툴 | [tool/update-working-state.ts](../../../src/tool/update-working-state.ts) | ownerShortlist/hypothesis/blockers/nextStepQueue/deferredValidation | CX memory L3 |
| ✅ tool result evidence | [tool/types.ts `ToolResultEvidence`](../../../src/tool/types.ts) | stderr tail 등 증거 첨부 (verify-guard 입력) | v3 |

## 12. CLI / surface

| 기능 | 코드 위치 | 한 줄 | 출처 |
|---|---|---|---|
| ✅ built-in slash 5종 | [apps/cli/slash-commands.ts](../../../src/apps/cli/slash-commands.ts) | /context /usage /color /navigate /wait, surface-agnostic dispatch | CD |
| ✅ session 명령 | [apps/cli/session-commands.ts](../../../src/apps/cli/session-commands.ts) | fork/rewind/list/archive | CD |
| ✅ dotenv 로더 | [apps/cli/dotenv.ts](../../../src/apps/cli/dotenv.ts) | KEY=VALUE, 기존 env 비override | v3 |
| ✅ provider 자동 선택 | [apps/cli/internal.ts](../../../src/apps/cli/internal.ts) | ANTHROPIC/OPENAI key 기반 분기 | v3 |

## 13. Skills / Plugins

| 기능 | 코드 위치 | 한 줄 | 출처 |
|---|---|---|---|
| ✅ system skill 번들 | [skill/system-skills/](../../../src/skill/system-skills/) | progress-audit SKILL.md, version-pinned (ADR-0045) | CX/CD |
| ✅ skill 30MB cap | [skill/skill-size.ts](../../../src/skill/skill-size.ts) | discoverSkills 크기 가드 | CD |
| ✅ plugin manifest/loader | [skill/plugin-manifest.ts](../../../src/skill/plugin-manifest.ts) · [plugin-loader.ts](../../../src/skill/plugin-loader.ts) | .codex-plugin/plugin.json + .mcp.json + skills | CX |
| ✅ tool-search (deferred) | [skill/tool-search.ts](../../../src/skill/tool-search.ts) | deferred tool 스키마 lazy fetch | CCv2/CX |

## 14. 메모리 / 컨텍스트 (장기 + 작업 메모리)

| 기능 | 코드 위치 | 한 줄 | 출처 |
|---|---|---|---|
| ✅ 장기 메모리 store | [memory/index.ts](../../../src/memory/index.ts) · [ports.ts](../../../src/memory/ports.ts) | PersistentStorePort, episodic/semantic tier | CX 2-phase |
| ✅ recall (per-turn) | [agent/memory.ts `recallContext`](../../../src/agent/memory.ts) | 의미+태그+freshness 랭킹, recallLimit/tiers | CX |
| ✅ 세션종료 distill | [agent/memory-distill.ts](../../../src/agent/memory-distill.ts) | transcript → 구조화 레코드 (LLM, 휴리스틱 fallback) | CX |
| ✅ consolidate (dedup/merge) | [agent/memory-consolidate.ts](../../../src/agent/memory-consolidate.ts) · [memory/consolidate](../../../src/memory/consolidate/) | 신규 레코드 ↔ 근접중복 LLM 머지/supersede | CX |
| ✅ 임베딩 semantic recall | [agent/memory-embedder.ts](../../../src/agent/memory-embedder.ts) · [memory/vector.ts](../../../src/memory/vector.ts) | 벡터 유사 + dedup | CX |
| ✅ eviction sweep | [memory/eviction.ts](../../../src/memory/eviction.ts) | tier별 cap, decayed/deleted 정리 | v3 |
| ✅ self-edit 메모리 도구 | [agent/memory-tools.ts](../../../src/agent/memory-tools.ts) | memory_search/write/update 메타툴 | CX |
| ✅ working-state (L3) | [agent/working-state.ts](../../../src/agent/working-state.ts) | 세션 작업 메모리: hypothesis/blockers/nextStep | CX |
| ✅ compaction breaker | [agent/compaction-breaker.ts](../../../src/agent/compaction-breaker.ts) | 무의미 compaction(컨텍스트 안 줄음) 차단 | v3 |
| ❌ memory sync mass-delete guard | (미구현) | push_refused_mass_delete — 대량삭제 거부 | CD `CoworkMemory` |

## 15. Mid-turn steering / collaboration

| 기능 | 코드 위치 | 한 줄 | 출처 |
|---|---|---|---|
| ✅ mid-turn steering | [agent/steering.ts](../../../src/agent/steering.ts) · [tests/integration/loop-steer.test.ts](../../../tests/integration/loop-steer.test.ts) | 턴 진행 중 사용자 입력 주입 | CX round-3 |
| ✅ follow-up queue | [agent/follow-up-queue.ts](../../../src/agent/follow-up-queue.ts) | 긴 턴 중 입력 큐잉, pausedReason | CX |
| ✅ collaboration mode (Plan/Default) | [agent/mode.ts `CollaborationMode`](../../../src/agent/mode.ts#L73) | dev-channel 메시지로만 sticky 전환 | CX |
| ✅ work metrics collector | [agent/work-metrics-collector.ts](../../../src/agent/work-metrics-collector.ts) | 턴/도구/토큰 작업 통계 수집 | v3/CR |
| ❌ background task suggestion | (미구현) | popBackgroundTaskSuggestion — idle 능동 제안 | CD `Radar` |

## 16. Claude Desktop LocalSessions 130-메서드 중 기깔난 것 (v3 매핑)

| CD 기능 | v3 상태 / 위치 | 한 줄 |
|---|---|---|
| `rewind` | ✅ [session/store.ts `rewindToMessage`](../../../src/session/store.ts) | msg-id 시간여행 (ADR-0052) |
| `forkSession` | ✅ [session/store.ts:232](../../../src/session/store.ts#L232) | 풀 세션 분기 |
| `warmSession` | ❌ 미구현 | hover-warm 콜드스타트 제거 |
| `setEffort` (5단계) | 🟡 [session/envelope.ts `EffortSchema`](../../../src/session/envelope.ts) | low/medium/high/max enum 정의됨, 런타임 wire 부분 |
| `setPermissionMode` | ✅ [permission/types.ts `PermissionMode`](../../../src/permission/types.ts) | default/acceptEdits/bypass/auto |
| `getContextUsage` | ✅ [apps/cli/status-line.ts](../../../src/apps/cli/status-line.ts) | 토큰 미터 (ADR-0054) |
| `summarizeTranscript` | 🟡 [agent/compaction.ts](../../../src/agent/compaction.ts) | 자동 compaction은 있음, 명시 trigger/cancel은 부분 |
| `commitWipForBranchSwitch` | ✅ [tool/git/branch-switch.ts](../../../src/tool/git/branch-switch.ts) | autoWip (ADR-0053) |
| `createLocalPr`/`enableAutoMerge` | ❌ 미구현 | PR 생성/auto-merge |
| `launchUltrareview` | 🟡 CLI `/ultrareview` (별도 트랙) | native IPC 노출은 미구현 |
| `teleportToCloud` | ❌ 미구현 | 로컬→클라우드 이주 |
| `startSideChat` | ❌ 미구현 | 메인 보호 보조 채팅 |
| `importCliSession`/`logCliEvent` | ❌ 미구현 (web surface 시) | CLI↔Web 양방향 |
| `getInstalledEditors`/`openInEditor` | ❌ 미구현 | 15-editor 동적 진입 |
| SSH 풀 (config/trust/interactive pw) | ❌ 미구현 | 원격 작업 |

---

## 17. 미구현 — Claude Desktop에 있고 v3에 없음 (출처만, 코드 위치 없음)

| 기능 | 출처 | 비고 |
|---|---|---|
| ❌ Cowork microVM (Go runtime + vsock + FUSE + MITM) | CD `yukonSilver` | 자체 게스트 빌드 필요, Tier 3 |
| ❌ Computer Use 엔진 (mouse/key/screen napi) | CD `claude-native` | Rust napi 작성, Tier 3 |
| ❌ Radar Cards (능동 제안) | CD `CoworkRadar` | Tasks API 선행 필요 |
| ❌ Bridge preflight + attestation | CD `LocalAgentModeSessions` | 원격 에이전트 surface 도착 시 |
| ❌ Hardware Buddy (BLE 펫) | CD `claude.buddy` | niche |
| ❌ iOS Simulator 제어 | CD `claude.simulator` | 모바일 dev 도착 시 |
| ❌ Office Add-in | CD `officeAddin` | 별도 도메인 |
| ❌ WakeScheduler (OS 깨우기) | CD `WakeScheduler` | pmset/launchd 통합 |
| ❌ MDM mdmKey 마커 | CD | preference schema metadata, enterprise 진입 시 |
| ❌ 별도 origin user-content | CD `claudeusercontent.com` | web surface 도착 시 |
| ❌ 3-tier model env + region | CD `ANTHROPIC_DEFAULT_*` | enterprise multi-region |
| ❌ Cursor resume-by-ID JSONL transcript | CR | [[cursor-3.2-absorption]] 참조 |
| ❌ Cursor 20 hook events (updated_input/followup) | CR | [[cursor-3.2-absorption]] |
| ❌ Cursor .mdc 4-primitive glob Rule | CR | [[cursor-3.2-absorption]] |

---

**참조 문서**: [feature-catalog](../may-21-claude-desktop-feature-catalog.md) · [code-agent-deep-dive](../may-21-claude-desktop-code-agent-deep-dive.md) · [query-usecase](../may-21-coding-agent-query-usecase.md)
**관련 메모리**: [[claude-desktop-1-7196-catalog]] · [[cursor-3.2-absorption]] · [[codex-absorption-complete]] · [[cc-v2-sota-absorption]]
