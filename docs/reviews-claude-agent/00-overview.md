# Claude Code v2.1.143 — 시스템 개요

추출 대상: `/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`
- Bun-compiled Mach-O arm64 native binary (198 MB)
- 메타: `VERSION="2.1.143"`, `GIT_SHA="cfb8132e4c3551e2773f41a1900efd1cc93637db"`, `BUILD_TIME="2026-05-15T17:39:39Z"`

추출 파일 (현재 디렉토리):

| 파일 | 내용 | 크기 |
|---|---|---|
| `cstring.bin` | `__cstring` 섹션 raw | 3.5 MB |
| `extracted-code.js` | function/const 포함 JS 라인 | 14 MB / 1,068줄 |
| `extracted-functions.js` | function 경계로 split | 14 MB / 21,311줄 / 17,301 함수 |
| `all-big-strings.txt` | 1,000자+ 문자열 모음 | 14 MB |
| `biggest-blob.formatted.js` | 단일 최대 블롭 | 415 KB |
| `system-prompts.txt` | system prompt 추출본 | 192 KB |

## 추출본의 한계

- **식별자 minified**: `runTurnLoop`, `runSingleTool`, `BetaToolRunner`, `headerMain` 같은 식별자만 남음
- **파일/모듈 경계 손실**: Bun lazy-init 패턴 (`var X = R(() => {...})`)으로 추정만 가능
- **TypeScript 타입 손실**: 타입은 함수 사용 패턴에서 역추론
- **JSX → createElement**: UI 컴포넌트 트리가 호출 그래프로 평탄화
- **주석 제거**

대신, **문자열 리터럴은 거의 100% 보존** — 시스템 프롬프트, hook 페이로드, 에러 메시지, Statsig 게이트 키, 모델 ID, 텔레메트리 이벤트 이름까지 그대로.

## 모듈 인벤토리

각 모듈 문서는 4섹션 구조 (호출 그래프 / 핵심 로직 / State·Schema / v0.2.8 대비 차이).

### 핵심 실행 파이프라인

| 모듈 | 문서 | 한 줄 요약 |
|---|---|---|
| Agent loop (turn 상태머신) | [agent-loop.md](agent-loop.md) + 12 deep-dives ↓ | `runTurnLoop` async generator, single `while(true)` + 6 `transition.reason` + 7 `continue` 경로 + 17 `return` 경로 |
| └ R1: stream events 인터페이스 | [agent-loop-stream-events.md](agent-loop-stream-events.md) | callModel ↔ Bq3 yield 타입, `backfillObservableInput` 패칭, `onHintCleared` 콜백 |
| └ R1: memdir prefetch | [agent-loop-memdir-prefetch.md](agent-loop-memdir-prefetch.md) | `using P = ga7(...)` 6 가드, `MAX_SESSION_BYTES=61440`, `transformMemdirResults` 변환 |
| └ R1: Stop hook + goal eval | [agent-loop-stop-hook-deep.md](agent-loop-stop-hook-deep.md) | `runStopHooks`/`dispatchStopHook`/`runPostToolBatchHook`/`startPostTurnSummary`, `/goal` + `evaluateGoal` LLM evaluator |
| └ R1: messageQueue + refresh + maxTurns | [agent-loop-message-queue.md](agent-loop-message-queue.md) | `SnH`/`makeSystemReminderAttachment` drain, 3-priority queue, maxTurns 3 사이트·5 retry 스킵 |
| └ R1: AKH/Uq3/zNH + error bodies | [agent-loop-compact-flatten.md](agent-loop-compact-flatten.md) | `flattenCompactionResult` 5-field concat, `contextPressureLevel` 4-tier, canonical 에러 메시지 verbatim |
| └ R1: error predicates + ANH | [agent-loop-error-predicates.md](agent-loop-error-predicates.md) | `predicateApiError`/`predicatePromptTooLong`/`predicateImageError`/`predicateMaxOutputTokens`, `FallbackTriggeredError` 발생 조건 (`qA3=3`+Opus+fallback) |
| └ R2: 프롬프트 주입 (loop 관점) | [agent-loop-prompt-injection.md](agent-loop-prompt-injection.md) | `assembleSystemPrompt` 세션당 1회, 동적 컨텍스트는 `<system-reminder>` user 메시지로 (캐시 prefix 보존) |
| └ R2: 한 턴 액션 타임라인 | [agent-loop-turn-timeline.md](agent-loop-turn-timeline.md) | Phase 0/A–E 전수 부수효과, 13 perf marker + 17 telemetry |
| └ R2: loop 내 퍼미션 전 경로 | [agent-loop-permission-flow.md](agent-loop-permission-flow.md) | 라이브 콜체인, prompt는 yield 아닌 React dialog, deny→`ask`→항상 continue |
| └ R2: thinking/effort 주입 | [agent-loop-thinking-effort.md](agent-loop-thinking-effort.md) | trigger-word 소멸(`ultrathink`만), effort `EAH` 우선순위, fast=`speed:"fast"` |
| └ R2: tools 배열 주입 | [agent-loop-tools-injection.md](agent-loop-tools-injection.md) | 조립은 `callModelOuter` preamble, serializer `serializeToolsApi`, deferred는 다음 턴 재포함, `toolChoice:void 0` |
| └ R2: 메시지 정규화/합류 | [agent-loop-message-normalization.md](agent-loop-message-normalization.md) | `sliceAtCompactBoundary`=boundary 슬라이스, `replaceOversizedResults`=200KB `<persisted-output>` 치환, `persistToolResultDualTrack` dual-track |
| Tool execution pipeline | [tool-execution.md](tool-execution.md) | `Hj_/N05/y05/v05/_j_/r63/a63` — per-input `isConcurrencySafe` batching + contextModifier batched/serial 분기 + `fH` tool_result 조립 |
| Tool interface contract | [tool-interface.md](tool-interface.md) | `YC1` 8 defaults + `X9()` wrapper, 18-area diff vs v0.2.8 |
| Permission system | [permission-system.md](permission-system.md) | `decidePermission` (hook vs rule vs canUseTool) → `resolvePermissionDecision` (rule → mode → auto-mode classifier `runAutoModeClassifier`) — 3연속/20총 denial limit |
| Hook system (29종) | [hook-system.md](hook-system.md) | `coreHookEngine` core + `oneShotHookEngine` one-shot engines, `hookEventRegistry` 29-event registry, 4-source merge, `Ty8=2000ms` slow threshold |
| Streaming tool execution | [streaming-tool-execution.md](streaming-tool-execution.md) | `StreamingToolExecutor` re-uses `runSingleTool` pipeline + child AbortController, tombstone via SDK accumulator splice |
| callModel retry layer | [call-model.md](call-model.md) | `callModelOuter` outer + `buildCreatePayload` builder + `retryHelper` 3-tier retry (backoff / 7 directives / outer stale·404·context-hint) + `nonStreamingFallback` non-streaming fallback |

### 메모리 / 컨텍스트 관리

| 모듈 | 문서 | 한 줄 요약 |
|---|---|---|
| Compaction 3-tier | [compaction-system.md](compaction-system.md) | SDK `sdkCompactionCheck` + CLI `Ia7→$rH` + reactive `u47+o47+rY6`; `microcompact`는 사실상 hook 자리, 실로직은 `timeBasedMicrocompact` time-based + `onHintCleared`에 분산 |
| System prompts | [system-prompts.md](system-prompts.md) | master `assembleSystemPrompt` (line 18960), 5 static + ~18 dynamic 섹션, `dynamicBoundaryMarker` boundary marker로 prompt cache split |
| ToolUseContext 구조 | [tool-use-context.md](tool-use-context.md) | main ctx는 REPL `replCtxBuilder` (line 20703), 서브에이전트 fork는 `forkToolUseContext` — share-by-ref / snapshot / reset / wrap 4가지 패턴 |

### v2 신규 서브시스템

| 모듈 | 문서 | 한 줄 요약 |
|---|---|---|
| Subagent system | [subagent-system.md](subagent-system.md) | 단일 `Agent` 도구 (`Task` alias) + `TaskOutput`/`TaskStop`, 3 모드 (foreground/background/auto-bg-2s), `taskBudget`이 API body `task_budget` 필드로 전달 |
| Skill system | [skill-system.md](skill-system.md) | `Skill`/`ToolSearch` 도구, discovery prefetch + conditional `paths` 활성화 + fork-mode subagent, `skillOverrides` setting |
| MCP integration | [mcp-integration.md](mcp-integration.md) | 9 transports, `Np` tool registration, `advisor_20260301` server-side advisor, 8-tier scope priority, XAA cross-app OAuth |
| Plan mode | [plan-mode.md](plan-mode.md) | `EnterPlanMode` / `ExitPlanMode`, `iZ()` opusplan/haiku swap @200k (`Y_6`), plan은 도구 필터가 아닌 `checkPermissions`의 `behavior:"ask"`로 차단 |
| Worktree + isolation | [worktree-system.md](worktree-system.md) | `EnterWorktree` / `ExitWorktree`, `<repo>/.claude/worktrees/<name>` + branch `worktree-<name>`, Agent isolation은 `agent-<id>` + `QL8` diff 자동 제거 |
| Cron / Schedule | [cron-schedule.md](cron-schedule.md) | `CronCreate`/`CronDelete`/`CronList` (Cron CRUD) + `ScheduleWakeup`, 2-tier 저장 (in-memory + `.claude/scheduled_tasks.json`), POSIX dom-OR-dow parser |

### 심층 / "기깔나는" 영역 (숨겨진 메커니즘)

| 모듈 | 문서 | 한 줄 요약 |
|---|---|---|
| Auto-mode classifier | [auto-mode-classifier.md](auto-mode-classifier.md) | ~12,000단어 verbatim 권한판정 시스템 프롬프트 (`classifierSystemPrompt` "security monitor for autonomous AI coding agents", HARD/SOFT BLOCK + 7 User Intent rules), 2-stage XML classifier, AFK beta sticky circuit-break, denial limit 연속3/총20. classifier는 별도 Haiku 아닌 **메인 모델**(2-stage+1h 캐싱이 비용 절감) |
| Speculation / precompute | [speculation-precompute.md](speculation-precompute.md) | **완전한 speculative-execution 엔진**(`speculativeExecEngine`/`speculativeExecEngine` — LLM이 다음 프롬프트 예측→COW FS overlay에서 미리 실행→pipelined chaining)이 코드에 존재하나 `JX8()` false로 **하드 비활성화**. active한 건 precomputed compaction cross-fork borrow(`startPrecomputeFork`/`precomputeRegistry`)뿐 |
| Background daemon + teammate | [background-daemon-teammate.md](background-daemon-teammate.md) | macOS launchd `com.anthropic.claude-daemon`, `getpeereid` FFI peer-UID guard, spare-pool/roster 워커, 3-mode teammate (in-process `inProcessTeammate` / tmux `tmuxTeammate` / remote) + `SendMessage(to:)`, claude.ai/mobile 리모트 브릿지, ~60 bg/daemon 이벤트 |
| Statsig 게이트 카탈로그 | [statsig-gates.md](statsig-gates.md) | 145 게이트, `evalStatsigGate` 우선순위 `m3_→p3_→GrowthBook→default` + `clientDataCache` 우회. `copper_lantern`=데몬 self-destruct 킬스위치, `velvet_cascade`/`vellum_lantern`=3중 모델 라우팅, `orchid_mantis`=/schedule 자가영업 A/B |
| Bash sandbox / isolation | [bash-sandbox.md](bash-sandbox.md) | macOS verbatim deny-default seatbelt SBPL (`sandbox-exec -p`), Linux `bwrap --unshare-net`+seccomp; "persistent shell"은 실은 per-command spawn(cwd 파일+`sessionEnvVars`); `_simulatedSedEdit`는 sed 미실행·preview write; 30000자 disk-spill / 64MB hard cap |
| Telemetry / observability | [telemetry-observability.md](telemetry-observability.md) | **1,122 distinct `tengu_*` 이벤트**, 하드코딩 Datadog 토큰(firstParty 전용, batch100/15s), 툴별 RSS/heap/external delta 프로파일링, 30+ `query_*` perf marker, `sha256(userID)%30` 코호트 |

### 사용자 경험 / 통합 영역 (R3 — 미문서화였던 큰 기능)

| 모듈 | 문서 | 한 줄 요약 |
|---|---|---|
| Rewind / checkpoint / undo | [rewind-checkpoint.md](rewind-checkpoint.md) | 더블탭 Esc / `/rewind`(alias checkpoint·undo) → `MessageSelector` → code-only/conversation-only/both 복원. **git 아닌** per-edit content-addressed shadow copy(`<configDir>/file-history/<sessionId>/<sha>@v<n>`), 메시지 경계 스냅샷, 최근 100개. bash/수동/서브에이전트 변경 복원 불가. SDK `rewindFiles()` |
| Chrome / computer-use / 멀티모달 | [chrome-computer-use.md](chrome-computer-use.md) | claude-in-chrome dual transport(stdio MCP+native host vs OAuth WS 클라우드 브릿지+멀티디바이스 페어링), 22 chrome 도구 + OS 전역 computer-use MCP(글로벌 락+Esc-abort), 스크린샷→tool_result 이미지 블록, `bypassPermissions→CLAUDE_CHROME_PERMISSION_MODE=skip_all` |
| Auth / OAuth / quota | [auth-quota.md](auth-quota.md) | OAuth refresh **dual file lock**(`.oauth_refresh.lock`) — 데몬/CLI/bg/cron이 한 `.credentials.json` 공유. 구독 `claude_max/pro/enterprise/team`, 5h/7d/overage 롤링 한도 `anthropic-ratelimit-unified-*` + 클라이언트 조기경고 곡선, `quotaPrecheckPing` `max_tokens:1` Haiku 사전핑, 7-provider 매트릭스 |
| SDK control protocol | [sdk-control-protocol.md](sdk-control-protocol.md) | 3 output(text/json/stream-json NDJSON) + **full-duplex stdio JSON RPC** — CLI가 SDK로 역호출(`can_use_tool`/`hook_callback`/`mcp_message`), SDK-MCP 도구 프로세스 경계 reverse-marshal, `initialize` 핸드셰이크, 5min stall(`sdkStallMs`)·1% schema canary |
| IDE / LSP / diagnostics | [ide-lsp-integration.md](ide-lsp-integration.md) | **닫힌 자가수정 루프**: edit baseline → `getNewDiagnostics` 델타 → `<system-reminder>`로 다음 턴 주입. 포트 lockfile(`~/.claude/ide/<port>.lock`) ws/sse-ide MCP, 3-way diff 뷰어, `lspRecommendation`=마켓플레이스 넛지(5회 무시 시 비활성) |
| Hidden gems | [hidden-gems.md](hidden-gems.md) | Deepgram Nova-3 STT 음성입력(서버 프록시+circuit-breaker), `tengu_flicker` 터미널 오버플로 감지, "go to sleep" 키워드 텔레메트리, ~200 휘적 스피너 동사, `/btw` 대화-fork 사이드질문, OSC 9;4 진행바, Apple Terminal bell 설정 파싱, easter egg 부재 확인 |

> **식별자 직관 이름**: minified 토큰(`runTurnLoop`/`makeApiErrorMessage`/`makeToolResultMessage`...)의 추론된 직관 이름 + 역인덱스는 [identifier-glossary.md](identifier-glossary.md)에 통합. 본문은 바이너리 grep 추적성 위해 minified 유지, 글로서리에서 역참조.

## 검증된 minified ↔ 의미 매핑

### 메인 루프 / 도구 실행

| Minified | 역할 | 위치 |
|---|---|---|
| `runTurnLoop` | 메인 turn loop (async generator) | extracted-functions.js:14057 |
| `dispatchToolBatch` | tool batch runner | line 10727 |
| `groupByConcurrencySafe` | `isConcurrencySafe(input)` batcher | line 10728 |
| `runConcurrentTools` | concurrent runner (`V76 + V05` semaphore) | line 10730 |
| `runSerialTools` | serial runner | line 10729 |
| `runSingleTool` | single tool runner (lookup + isolation + dispatch) | line 13870 |
| `wrapToolWithProgressQueue` | a63 wrapper (progress queue) | line 13871 |
| `executeToolPipeline` | single tool full pipeline | line 13875 |
| `runPreToolUseHooks` | PreToolUse hooks runner (7 event types) | (in a63) |
| `runPostToolUseHooks` | PostToolUse hooks runner | (in a63) |
| `runPostToolUseFailureHooks` | PostToolUseFailure hooks runner | (in a63) |
| `runStopHooks` / `dispatchStopHook` | Stop / SubagentStop hooks runner | (in Bq3) |
| `decidePermission` | permission decision orchestrator | line 13603 |
| `resolvePermissionDecision` | rule → mode → classifier 결정 함수 | (in QA6) |
| `runAutoModeClassifier` | auto-mode classifier (별도 LLM 호출) | — |
| `runPermissionDeniedHook` | PermissionDenied hook runner (retry 신호) | (in a63) |
| `forkToolUseContext` | ToolUseContext fork builder (subagent) | line 9845 |
| `StreamingToolExecutor` | streaming tool execution class | (in Bq3) |
| `checkIsolationLatch` | isolation latch deny check | (in _j_) |
| `precheckBashMisuse` | bash 명령 misuse pre-check | (in a63) |

### SDK 레벨 (Anthropic SDK 내부)

| Minified | 역할 |
|---|---|
| `BetaToolRunner` | `BetaToolRunner` 클래스 (line 1942) |
| `sdkDispatchTools` | SDK in-class tool dispatcher |
| `sdkCompactionCheck` | SDK in-class compaction check |
| `BetaManagedAgents` | `BetaManagedAgents` 클래스 (Anthropic managed agents API) |

### Compaction

| Minified | 역할 |
|---|---|
| `runAutocompact` → `autocompactImpl` | CLI autocompact 진입점 (extracted-functions.js:14782/14741) |
| `reactiveCompactPhaseA` | reactive compact phase A (line 9883) |
| `reactiveCompactPhaseB` | reactive compact phase B — user-wait (line 9894) |
| `compactProgressQueue` | reactive compact yield* helper (line 14784) |
| `microcompactNoop` | `J.microcompact` — 실질 no-op hook 자리 (line 8419) |
| `timeBasedMicrocompact` | time-based microcompact 본체 (`tengu_time_based_microcompact`, line 8424) |
| `decideReactiveCompact` | reactive compact 결정 함수 (8개 조건) |
| `rapidRefillCounter` | rapid-refill counter |
| `buildContextMgmtParam` | API `context_management` 빌더 — `clear_thinking_20251015`만 emit (`compact_20260112` 미사용) |
| `startPrecomputeFork` | precompute fork (백그라운드 요약 미리 생성) |
| `sdkCompactionPrompt` | SDK 짧은 continuation summary prompt 상수 |
| `rapidRefillBreakerMsg` | rapid-refill breaker 에러 메시지 |
| `sdkCompactionThreshold` | 100,000 — SDK compaction threshold |
| `rapidRefillCap` / `rapidRefillCap` | 3 — rapid-refill 횟수 cap |

### System prompts

| Minified | 역할 |
|---|---|
| `assembleSystemPrompt` | master prompt 빌더 (line 18960) |
| `selectPromptHeader` | 3 header 선택자 (Vertex / non-interactive 분기) |
| `headerMain` | `"You are Claude Code, Anthropic's official CLI for Claude."` |
| `headerSdkAppend` | `"... running within the Claude Agent SDK."` (non-interactive + append) |
| `headerSdkAgent` | `"You are a Claude agent, built on Anthropic's Claude Agent SDK."` |
| `sectionSystem` | `# System` 섹션 빌더 |
| `sectionDoingTasks` | `# Doing tasks` 섹션 빌더 (line 18953) |
| `sectionUsingTools` | `# Using your tools` 섹션 빌더 |
| `securityGuardPrompt` | security guard prompt (line 18941) |
| `dynamicBoundaryMarker` | `"__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"` — cache split marker |
| `sectionCacheHelper` / `sectionCacheHelper` | dynamic section 캐시 helper (`F_.systemPromptSectionCache`) |
| `oneHourCacheGate` | 1h cache + 1st-party 게이트 |
| `billingHeaderBuilder` | `x-anthropic-billing-header` 빌더 |

### callModel 레이어

| Minified | 역할 |
|---|---|
| `callModelOuter` | callModel 외부 함수 (3계층 retry 최상단) |
| `buildCreatePayload` | messages.create payload 빌더 |
| `retryHelper` | retry 헬퍼 (backoff + 7 directive) |
| `nonStreamingFallback` | non-streaming fallback |
| `insertCacheMarkers` | cache_control marker 삽입 |
| `clientRequestIdHeader` | `x-anthropic-client-request-id` 헤더 키 |

### Plan / Worktree / Cron / Schedule

| Minified | 역할 |
|---|---|
| `EnterPlanMode` | `EnterPlanMode` 도구 |
| `ExitPlanMode` | `ExitPlanMode` 도구 |
| `iZ` | plan mode 모델 swap (opusplan / haiku) |
| `Y_6` | 200k 토큰 초과 검사 |
| `H9K` | plan_mode_floor (auto-mode classifier 우회 차단) |
| `EnterWorktree` | `EnterWorktree` 도구 |
| `ExitWorktree` | `ExitWorktree` 도구 |
| `VEK` / `qyH` / `kEK` / `iQ8` | worktree 경로/브랜치 명명 helpers |
| `Jf_` | Agent isolation worktree 생성기 |
| `QL8` | worktree diff 검사 (변경 없으면 자동 제거) |
| `evH` | WorktreeCreate hook stdout/hookSpecificOutput |
| `hsH` | WorktreeRemove hook (fire&forget) |
| `Qe5` | `enforce_web_search_mcp_isolation` org policy |
| `CronCreate` | `CronCreate` 도구 |
| `CronDelete` | `CronDelete` 도구 |
| `CronList` | `CronList` 도구 |
| `ScheduleWakeup` | `ScheduleWakeup` 도구 |
| `EV` / `ZFH` | cron 파서 (POSIX dom-OR-dow) |
| `f85` | cron-tick lead 보정 |
| `NGH` / `LFH` | `.claude/scheduled_tasks.json` reader/writer |

### Hook system

| Minified | 역할 |
|---|---|
| `coreHookEngine` | core hook engine |
| `oneShotHookEngine` | one-shot hook engine |
| `hookEventRegistry` | 29-event registry |
| `hookEventNames` | `["PreToolUse", ...]` 29-event 배열 (line 3565) |
| `hookPayloadBase` | 공통 hook payload base Zod 스키마 |
| `makeHookProgressMsg` | `hook_progress` 메시지 빌더 |
| `slowHookWarnMs` | 2,000 — Slow* 경고 임계 (ms) |

### Skill system

| Minified | 역할 |
|---|---|
| `Skill` | `Skill` 도구 |
| `ToolSearch` | `ToolSearch` 도구 |
| `startSkillDiscoveryPrefetch호출자` | `startSkillDiscoveryPrefetch` 함수 호출자 |
| `pluginRelevance` | plugin relevance helper |

### Tool name 상수

| Const | Tool |
|---|---|
| `Bash` | `"Bash"` |
| `Read` | `"Read"` |
| `Edit` | `"Edit"` |
| `Write` | `"Write"` |
| `Agent` | `"Agent"` |
| `Task` | `"Task"` (alias of `Agent`) |
| `NotebookEdit` | NotebookEdit |
| `BashOutput` | bash 계열 도구 (BashOutput 추정) |
| `PowerShell계열` | PowerShell 계열 (추정) — `StreamingToolExecutor`의 `Q2=[Cq,y9]` sibling-abort 트리거 |

### 공통 헬퍼

| Minified | 역할 |
|---|---|
| `telemetryEnabled` | telemetry-enabled flag 함수 |
| `evalStatsigGate` | Statsig gate 평가 (memoized) |
| `apiProvider` | API provider 식별 (firstParty/anthropicAws/vertex/bedrock/mantle) |
| `freshAgentId` | fresh agent UUID 생성 |
| `estimateMessageTokens` | 메시지 토큰 추정 (taskBudget 차감용) |
| `estimateTokensForModel` | 모델별 토큰 추정기 |
| `extractGitCommitId` | git commit hash regex parser |

## 시스템 상수

### Hook 29종 (`hookEventNames` 배열)

```
PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch,
Notification, UserPromptSubmit, UserPromptExpansion,
SessionStart, SessionEnd,
Stop, StopFailure, SubagentStart, SubagentStop,
PreCompact, PostCompact,
PermissionRequest, PermissionDenied,
Setup, TeammateIdle,
TaskCreated, TaskCompleted,
Elicitation, ElicitationResult,
ConfigChange,
WorktreeCreate, WorktreeRemove,
InstructionsLoaded, CwdChanged, FileChanged
```

### Permission mode 6종

```
default | acceptEdits | bypassPermissions | plan | dontAsk | auto
```

- `auto` — LLM classifier `runAutoModeClassifier`가 권한 판단 (v2 신규). 3연속/20총 denial limit.
- `dontAsk` — pre-approved 아니면 deny.
- `bypassPermissions` — `allowDangerouslySkipPermissions` 필요.

### Permission decision schema (`permissionDecisionSchema`)

```
{ behavior: "allow", updatedInput?, updatedPermissions?, toolUseID?, decisionClassification? }
| { behavior: "deny", message, interrupt?, toolUseID?, decisionClassification? }
```

Classification (`decisionClassificationEnum`): `user_temporary | user_permanent | user_reject`

### Hook payload base (`hookPayloadBase`)

```
{
  session_id, transcript_path, cwd,
  permission_mode?,
  agent_id?,           // subagent 식별
  agent_type?,         // "general-purpose", ...
  effort?: { level },  // "low"/"medium"/"high"/"xhigh"/"max" — CLAUDE_EFFORT env
}
```

### Bq3 D struct (turn state)

```
{
  messages, toolUseContext,
  maxOutputTokensOverride,
  compactTracking: { compacted, turnId, turnCounter, consecutiveFailures, consecutiveRapidRefills },
  stopHookActive, stopHookBlockingCount,
  maxOutputTokensRecoveryCount,
  hasAttemptedReactiveCompact,
  turnCount,
  pendingToolUseSummary,
  transition: { reason }
}
```

`transition.reason`:
- `malformed_tool_use_retry`
- `reactive_compact_retry`
- `precomputed_compact_swap`
- `max_output_tokens_recovery`
- `stop_hook_blocking`

종료 return reason: `completed`, `rapid_refill_breaker`, `prompt_too_long`, `image_error`, `model_error`, `stop_hook_prevented`, `max_turns`, `aborted_streaming`.

## v0.2.8 → v2.1.143 차이 요약

| 영역 | v0.2.8 | v2.1.143 |
|---|---|---|
| 루프 구조 | `query()` 재귀 generator | `Bq3()` while + transition state machine |
| 동시성 | `isReadOnly` boolean (도구별) | `isConcurrencySafe(parsedInput)` (도구+입력별) |
| Permission 모드 | 4 | 6 (auto, dontAsk 추가) |
| Hook | 0 | 29 |
| Compaction | `/compact` 수동 only | 3-tier (SDK/auto/reactive) + precompute fork + rapid-refill-breaker |
| Streaming tool exec | 없음 | `StreamingToolExecutor` (응답 중 도구 실행 시작) |
| Model fallback | 없음 | `FallbackTriggeredError` 예외 → same-turn fallback + tombstone |
| Subagent | 단일 `AgentTool` (sidechain log) | `Agent` (3 모드) + `TaskOutput` + `TaskStop` + `task_budget` |
| Skill | 없음 | discovery prefetch + `Skill`/`ToolSearch` 도구 + deferred tool injection |
| Plan mode | 없음 | mode + 도구 ask 차단 + opusplan/haiku swap |
| Worktree | 없음 | tools + isolation latch + agent worktree branch |
| Cron / Schedule | 없음 | 4 tools + daemon-backed scheduler |
| MCP | 있음 | + server_tool_use + advisor (`advisor_20260301`) + 8-tier scope |
| 도구 인터페이스 | call / validate / needsPerm / isReadOnly | + Zod in/out + mapper + concurrency + observable + ctxModifier + size limits |
| 컨텍스트 mutation | 도구가 ctx 직접 mutate | 명시적 `contextModifier` 반환 (concurrent batch 일괄) |
| 체인 추적 | 없음 | `queryTracking { chainId, depth }` |
| 자원 관리 | manual | `using ... = ga7(...)` (ES2026 disposable) |
| Retry 정책 | 단순 backoff + fallback model | 7 directive (afk-beta/advisor-strip/media-strip/cache-diagnosis/thinking-type/mid-conv-system/context-hint) + 3-tier retry |
| Prompt 조립 | 단일 `getSystemPrompt()` | master `assembleSystemPrompt` + 5 static + 18 dynamic 섹션 + Statsig gates + cache boundary marker |

## 문서 작성 규칙

- 각 모듈 문서는 4섹션 필수:
  1. **호출 그래프** — 진입점부터 leaf까지 함수 호출 순서
  2. **핵심 로직** — 의사코드 또는 디파라프레이즈된 JS
  3. **State / Schema** — 데이터 구조, Zod 검증, 이벤트 페이로드
  4. **차이점 (v0.2.8 대비)** — 있으면

- 식별자 표기: minified 이름은 `백틱` (예: `runTurnLoop`). 의미 이름은 평문 (예: "turn loop").
- 인용 시 라인 번호: `extracted-functions.js:14057`.
- 추정/미확인 사항은 명시: "확인", "추정", "확인 필요" 표기.
- 한국어 산문, 이모지 없음.

## 읽는 순서 권장

처음 보는 사람:
1. [agent-loop.md](agent-loop.md) — 전체 흐름 잡기
2. [tool-execution.md](tool-execution.md) → [tool-interface.md](tool-interface.md) → [tool-use-context.md](tool-use-context.md) — 도구 실행 3총사
3. [permission-system.md](permission-system.md) → [hook-system.md](hook-system.md) — 결정/확장 레이어
4. [compaction-system.md](compaction-system.md) → [call-model.md](call-model.md) — 컨텍스트/API 관리
5. [system-prompts.md](system-prompts.md) — 프롬프트 조립
6. [streaming-tool-execution.md](streaming-tool-execution.md) — latency 최적화
7. v2 신규 — [subagent-system.md](subagent-system.md), [skill-system.md](skill-system.md), [mcp-integration.md](mcp-integration.md), [plan-mode.md](plan-mode.md), [worktree-system.md](worktree-system.md), [cron-schedule.md](cron-schedule.md)
