# 식별자 글로서리 (minified → 직관 이름)

Claude Code v2.1.143은 Bun으로 컴파일되며 식별자가 minify되어 `Bq3`·`y1`·`D6` 같은 의미 없는 토큰만 남았다. 이 문서는 분석 문서 전반에서 등장하는 minified 식별자에 **추론된 직관 이름**을 부여한 단일 권위 매핑이다.

## 왜 본문 일괄 치환을 하지 않나

- **grep 추적성**: 모든 분석 문서는 `extracted-functions.js`의 원본 minified 토큰으로 바이너리와 대조 가능해야 한다. 본문을 직관 이름으로 일괄 치환하면 원본 대조가 불가능해진다.
- **오역 위험**: 같은 짧은 토큰이 스코프마다 다른 것을 가리킬 수 있다. 자동 치환은 위험.
- **표기 컨벤션**: 앞으로 작성/수정하는 문서는 `직관이름(\`minified\`)` 병기 형식을 권장. 예: "turn loop(`Bq3`)이 도구 배치(`Hj_`)를 디스패치한다".

집계 방식: `docs/analysis/*.md` 전체에서 매핑 테이블 행 750개를 추출 → 일반 영단어 노이즈 제거 → 543개 고유 minified 식별자 → 의미가 검증/추정된 것에 직관 이름 부여. 신뢰도: **확인** = 코드 본문으로 검증, **추정** = 호출 패턴/문자열로 추론.

---

## 1. Agent turn loop

| 직관 이름 | minified | 종류 | 역할 | 신뢰도 |
|---|---|---|---|---|
| `runTurnLoop` | `Bq3` | fn* | 메인 turn loop. 단일 `while(true)` + transition 상태머신 (ef.js:14057) | 확인 |
| `defaultLoopDeps` | `Sa7` | fn | `{callModel, microcompact, autocompact, uuid, now}` 기본 deps 빌더 | 확인 |
| `snapshotGates` | `ya7` | fn | gates/sessionId 스냅샷 | 확인 |
| `startMemdirPrefetch` | `ga7` | fn | `using P` disposable — 메모리 디렉토리 prefetch (ef.js:14303) | 확인 |
| `transformMemdirResults` | `Qa7` | fn | prefetch 결과 → user 메시지 변환 (readFileState dedup) | 확인 |
| `lastTurnBoundaryIndex` | `Uq3` | fn | 마지막 turn boundary index 계산 → `turnStartIndex` (ef.js:14058) | 확인 |
| `FallbackTriggeredError` | `ANH` | class | 모델 fallback 트리거 예외 (ef.js:15638) | 확인 |
| `tombstonePartialThenError` | `Ua7` | fn* | 부분 assistant 메시지 tombstone + 최종 에러 메시지 emit | 확인 |
| `persistTurnFailure` | `pJH` | fn | 턴 실패를 transcript+telemetry에 기록 | 확인 |
| `runStopFailureHook` | `$NH` | fn | StopFailure hook executor | 확인 |
| `abortCleanup` | `mJH` | fn | abort 경로 정리 (ef.js:14051) | 확인 |
| `markTurnActive` | `u4H` | fn | repl_main_thread 턴 활성 마킹 | 추정 |
| `persistTranscript` | `T57` | fn | 메시지 배열 transcript 영속화 | 추정 |
| `detectBreakKeyword` | `ma7` | fn | 응답 텍스트에서 "잠깐 쉬자" 류 키워드 감지 → telemetry | 추정 |

## 2. Tool 실행 파이프라인

| 직관 이름 | minified | 종류 | 역할 | 신뢰도 |
|---|---|---|---|---|
| `dispatchToolBatch` | `Hj_` | fn* | tool batch runner. concurrent/serial 분기 (ef.js:10727) | 확인 |
| `groupByConcurrencySafe` | `N05` | fn | `isConcurrencySafe(input)` 기준 연속 그룹화 (ef.js:10728) | 확인 |
| `runConcurrentTools` | `y05` | fn* | concurrent runner (`V76`+`V05` semaphore) (ef.js:10730) | 확인 |
| `runSerialTools` | `v05` | fn* | serial runner (ctx per-tool 전파) (ef.js:10729) | 확인 |
| `runSingleTool` | `_j_` | fn* | 단일 도구 runner: lookup+isolation+dispatch (ef.js:13870) | 확인 |
| `wrapToolWithProgressQueue` | `r63` | fn | a63 wrapper — progress 이벤트 큐(`Pn`) (ef.js:13871) | 확인 |
| `executeToolPipeline` | `a63` | fn | 단일 도구 풀 파이프라인: schema→validate→preHook→perm→call→postHook (ef.js:13875) | 확인 |
| `checkIsolationLatch` | `cA6` | fn | worktree/sandbox isolation latch deny 검사 | 확인 |
| `precheckBashMisuse` | `wo7` | fn | bash 명령 misuse 사전체크 (find -exec 등) | 확인 |
| `mergeConcurrencyGroups` | `V76` | fn | async generator 병합 (동시성 제한) | 추정 |
| `concurrencyLimit` | `V05` | fn/const | 동시 실행 상한 semaphore | 추정 |
| `lookupTool` | `eK` | fn | tools+alias 맵에서 도구 조회 (ef.js:5747) | 확인 |
| `buildAliasMap` | `AC1` | fn | 도구 alias → 도구 맵 빌드 | 확인 |
| `isVirtualMessage` | `_P_` | fn | tool result를 모델에 안 돌려보낼지 판정 | 추정 |
| `expandAttachments` | `i0` | fn | 첨부 메시지 → API content block 확장 (ef.js:15542) | 확인 |
| `enforceBase64Limit` | `y$_` | fn | base64 크기 제한 (초과 시 `mUH` throw) (ef.js:7870) | 확인 |
| `perModelLimits` | `mA` | fn | 모델별 한도(maxBase64Size 등) (ef.js:7176) | 확인 |
| `extractGitCommitId` | `jf8` | fn | bash stdout에서 git commit hash 추출 | 확인 |

## 3. Permission

| 직관 이름 | minified | 종류 | 역할 | 신뢰도 |
|---|---|---|---|---|
| `decidePermission` | `QA6` | fn | permission 결정 오케스트레이터 (ef.js:13603) | 확인 |
| `resolvePermissionDecision` | `AM` | fn | rule → mode → auto classifier 결정 | 확인 |
| `runAutoModeClassifier` | `vM_` | fn | auto-mode 권한 classifier (메인 모델 LLM 호출) | 확인 |
| `runPermissionDeniedHook` | `FX_` | fn* | PermissionDenied hook (retry 신호 가능) | 확인 |
| `classifierSystemPrompt` | `TC7` / `yR8` | const | ~12k단어 "security monitor" classifier 프롬프트 | 확인 |
| `classifierTwoStage` | `bQ5` | fn | 2-stage XML classifier (fast→thinking) | 확인 |
| `localDenialTracker` | `nq6` | fn | per-tool 로컬 deny 카운트 추적기 초기화 | 확인 |
| `permissionDecisionSchema` | `V6z` | zod | `{behavior:"allow"\|"deny", ...}` Zod 스키마 | 확인 |
| `permissionModeEnum` | `_KH` | zod | `default\|acceptEdits\|bypassPermissions\|plan\|dontAsk\|auto` | 확인 |
| `decisionClassificationEnum` | `b77` | zod | `user_temporary\|user_permanent\|user_reject` | 확인 |
| `mergePermissionRules` | `WV` | fn | toolPermissionContext에 새 규칙 병합 | 확인 |
| `persistPermissionRules` | `JI` | fn | 권한 규칙 디스크 영속화 | 추정 |
| `requestPermissionDialog` | `nFK` | fn | 인터랙티브 권한 React dialog pub-sub | 확인 |

## 4. Hooks (29종)

| 직관 이름 | minified | 종류 | 역할 | 신뢰도 |
|---|---|---|---|---|
| `coreHookEngine` | `T2` | fn | core hook 실행 엔진 | 확인 |
| `oneShotHookEngine` | `f2` | fn | one-shot hook 엔진 | 확인 |
| `hookEventRegistry` | `bp3` | obj | 29-event 레지스트리 | 확인 |
| `hookEventNames` | `mk` | const[] | 29 hook 이름 배열 (ef.js:3565) | 확인 |
| `runPreToolUseHooks` | `dA6` | fn* | PreToolUse hook runner (7 이벤트 타입) | 확인 |
| `runPostToolUseHooks` | `FA6` | fn* | PostToolUse hook runner | 확인 |
| `runPostToolUseFailureHooks` | `gA6` | fn* | PostToolUseFailure hook runner | 확인 |
| `runStopHooks` | `Va7` | fn* | Stop/SubagentStop hook runner | 확인 |
| `dispatchStopHook` | `x4H` | fn | Stop/SubagentStop trampoline (agentId 분기) | 확인 |
| `runPostToolBatchHook` | `qP_` | fn* | PostToolBatch hook (즉시 hook_stopped 종료) (ef.js:18821) | 확인 |
| `hookPayloadBase` | `Aw` | zod | 공통 hook payload Zod (session_id/cwd/agent_id/effort...) | 확인 |
| `makeHookProgressMsg` | `jo7` | fn | `hook_progress` 메시지 빌더 | 확인 |
| `slowHookWarnMs` | `Ty8` | const | `2000` — Slow* hook 경고 임계(ms) | 확인 |
| `otelMeter` | `t5H` | fn | OTEL meter accessor | 확인 |
| `lookupStopSessionHook` | `OJH` | fn | sessionHooks Stop 이벤트 lookup | 추정 |
| `evaluateGoal` | `UhK` | fn | `/goal` LLM evaluator (ef.js:18766) | 확인 |
| `startPostTurnSummary` | `t47` | fn | PostTurnSummary 백그라운드 시작 (ef.js:9904) | 확인 |
| `awaitPostTurnSummary` | `da7` | fn | PostTurnSummary promise 처리 (ef.js:15609) | 확인 |

## 5. Compaction

| 직관 이름 | minified | 종류 | 역할 | 신뢰도 |
|---|---|---|---|---|
| `runAutocompact` | `Ia7` | fn* | CLI autocompact 진입점 (ef.js:14782) | 확인 |
| `autocompactImpl` | `$rH` | fn* | autocompact 본체 (ef.js:14741) | 확인 |
| `reactiveCompactPhaseA` | `u47` | fn* | reactive compact A — precomputed swap 시도 (ef.js:9883) | 확인 |
| `reactiveCompactPhaseB` | `o47` | fn* | reactive compact B — 동기 요약 (ef.js:9894) | 확인 |
| `compactProgressQueue` | `rY6` | fn* | compact 작업+진행이벤트 합류 wrapper (ef.js:14784) | 확인 |
| `decideReactiveCompact` | `b47` | fn | reactive compact 트리거 조건(8개) 평가 | 확인 |
| `startPrecomputeFork` | `x47` | fn | 백그라운드 요약 미리 생성 | 확인 |
| `microcompactNoop` | `pt` | fn | `J.microcompact` — 실질 no-op hook 자리 (ef.js:8419) | 확인 |
| `timeBasedMicrocompact` | `Xi9` | fn | time-based microcompact 본체 (ef.js:8424) | 확인 |
| `flattenCompactionResult` | `AKH` | fn | compact 결과 → 5-field concat 메시지 평탄화 (ef.js:14736) | 확인 |
| `rapidRefillCounter` | `Qy8` | fn | 연속 rapid-refill 카운터 | 확인 |
| `buildContextMgmtParam` | `gEK` | fn | API `context_management` 빌더 (`clear_thinking_20251015`만) | 확인 |
| `sdkCompactionPrompt` | `_Hq` | const | SDK 짧은 continuation summary 프롬프트 | 확인 |
| `rapidRefillBreakerMsg` | `gy8` | const | rapid-refill breaker 에러 메시지 | 확인 |
| `sdkCompactionThreshold` | `HHq` | const | `100000` — SDK compaction 토큰 임계 | 확인 |
| `rapidRefillCap` | `oY6`/`UE8` | const | `3` — rapid-refill 횟수 cap | 확인 |
| `blockingLimitMsg` | `wg` | const | `"Prompt is too long"` (ef.js:7944) | 확인 |
| `contextPressureLevel` | `zNH` | fn | 4-tier `ok\|warn\|compact\|blocked` 컨텍스트 압력 | 확인 |
| `precomputeRegistry` | `rI` | Map | `<sourceKey,{status,precomputedAtUuid,settled}>` | 확인 |

## 6. callModel / API 레이어

| 직관 이름 | minified | 종류 | 역할 | 신뢰도 |
|---|---|---|---|---|
| `callModelOuter` | `DSK` | fn* | callModel 최상단 (3계층 retry + tools preamble, ef.js:19054) | 확인 |
| `buildCreatePayload` | `K_` | fn | `messages.create` payload 빌더 (ef.js:19057) | 확인 |
| `retryHelper` | `RJ6` | fn* | retry 헬퍼 (backoff + 7 directive) | 확인 |
| `nonStreamingFallback` | `YSK` | fn* | non-streaming fallback | 확인 |
| `insertCacheMarkers` | `wU3` | fn | cache_control 마커 삽입 | 확인 |
| `clientRequestIdHeader` | `wmH` | const | `x-anthropic-client-request-id` 헤더 키 | 확인 |
| `serializeToolsApi` | `Xj6` | fn | 도구 → API 스키마 직렬화 (memoized via `Fj9`) | 확인 |
| `jsonStringify` | `SH` | fn | 단순 `JSON.stringify` (도구 직렬화 아님) | 확인 |
| `memoizeToolSchema` | `Fj9` | fn | `Xj6` 메모이제이션 캐시 | 추정 |
| `stainlessHelperHeader` | `bV_`/`rV6` | fn | `x-stainless-helper` 헤더 빌더 (API tools 무관) | 확인 |
| `contextMgmtBetaHeader` | `O2H` | const | `context-management-2025-06-27` beta (ef.js:4153) | 확인 |
| `redactThinkingBeta` | `xK_` | const | `redact-thinking-2026-02-12` beta (thinking display 시 strip) | 확인 |
| `dedupBetas` | `Ij9` | fn | beta 헤더 중복 제거 | 추정 |
| `serializeBetas` | `kP` | fn | beta 헤더 직렬화 | 추정 |
| `mergeHeaders` | `Mq` | fn | 헤더 병합 | 확인 |
| `apiProvider` | `Jq` | fn | provider 식별 (firstParty/anthropicAws/vertex/bedrock/mantle) | 확인 |

## 7. System prompt 조립

| 직관 이름 | minified | 종류 | 역할 | 신뢰도 |
|---|---|---|---|---|
| `assembleSystemPrompt` | `KZ` | fn | master prompt 빌더 (ef.js:18960) | 확인 |
| `sessionPromptInit` | `nr8` | fn | 풀 조립 1회 진입점 | 확인 |
| `combineSystemAndContext` | `ca7` | fn | systemPrompt[] + systemContext 결합 | 추정 |
| `wrapSystem` | `H4` | fn | system 배열 wrapper (ef.js:7945) | 추정 |
| `mergeUserContext` | `aY6` | fn | userContext를 messages에 머지 (callModel 입력 전용) | 추정 |
| `resolveUserSystemPrompt` | `pq3` | fn | custom+append 시스템 프롬프트 결합 (ef.js:14054) | 확인 |
| `selectPromptHeader` | `ri_` | fn | 3 header 선택 (Vertex/non-interactive 분기) | 확인 |
| `headerMain` | `N98` | const | `"You are Claude Code, Anthropic's official CLI for Claude."` | 확인 |
| `headerSdkAppend` | `WL9` | const | `"... running within the Claude Agent SDK."` | 확인 |
| `headerSdkAgent` | `ZL9` | const | `"You are a Claude agent, built on Anthropic's Claude Agent SDK."` | 확인 |
| `sectionSystem` | `zB3` | fn | `# System` 섹션 빌더 | 확인 |
| `sectionDoingTasks` | `AB3` | fn | `# Doing tasks` 섹션 빌더 (ef.js:18953) | 확인 |
| `sectionUsingTools` | `wB3` | fn | `# Using your tools` 섹션 빌더 | 확인 |
| `securityGuardPrompt` | `_d8` | const | security guard 프롬프트 (ef.js:18941) | 확인 |
| `dynamicBoundaryMarker` | `eo` | const | `"__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"` cache split 마커 | 확인 |
| `sectionCacheHelper` | `kG`/`v47` | fn | dynamic section 캐시 (`F_.systemPromptSectionCache`) | 확인 |
| `oneHourCacheGate` | `F$H` | fn | 1h cache + 1st-party 게이트 | 확인 |
| `billingHeaderBuilder` | `oi_` | fn | `x-anthropic-billing-header` 빌더 | 확인 |
| `makeSystemReminderAttachment` | `B93` | fn | `<system-reminder>` user 메시지 빌더 (ef.js:14251) | 확인 |

## 8. 메시지 빌더 / 정규화

| 직관 이름 | minified | 종류 | 역할 | 신뢰도 |
|---|---|---|---|---|
| `makeApiErrorMessage` | `y1` | fn | `isApiErrorMessage` assistant 메시지 빌더 | 확인 |
| `makeToolResultMessage` | `D6` | fn | tool_result user 메시지 빌더 (ef.js:15503) | 확인 |
| `makeAttachmentMessage` | `T9` | fn | attachment/meta 메시지 빌더 (ef.js:14331) | 확인 |
| `makeNotification` | `VO` | fn | UI notification 빌더 (warning/info/error) | 확인 |
| `makeMetaMessage` | `B9K` | fn | meta(isMeta) 메시지 빌더 | 추정 |
| `sliceAtCompactBoundary` | `ZA` | fn | compact_boundary 기준 슬라이스 (필터 아님) | 확인 |
| `replaceOversizedResults` | `cr9` | fn | 200KB 초과 tool_result → `<persisted-output>` 치환 | 확인 |
| `replaceOversizedImpl` | `O75` | fn | `cr9` 치환 본체 | 확인 |
| `persistToolResultDualTrack` | `YNH` | fn | API 트리밍 / 디스크 원본 dual-track 영속화 | 확인 |
| `replaceClearedHints` | `Nz_` | fn | hint 블록 → placeholder 치환 (ef.js:8422) | 확인 |
| `extractReadPaths` | `fi9` | fn | 메시지에서 Read 경로 추출 | 확인 |
| `toAbsolutePath` | `H9` | fn | 절대경로 정규화 | 확인 |
| `clearedHintPlaceholder` | `lz8` | const | `"[Old tool result content cleared]"` | 확인 |
| `persistedOutputCap` | `Xc9` | const | `200000` — tool_result 치환 임계 | 확인 |
| `resultSizeCapDefault` | `fc9` | const | `400000` | 추정 |
| `resultSizeCapMid` | `Mc9` | const | `50000` | 추정 |
| `transcriptChunk` | `BFH` | const | `2000` | 추정 |
| `mapResultBlock` | `Br9` | fn | tool result → block 매핑 (ef.js:8540) | 확인 |

## 9. ToolUseContext / state

| 직관 이름 | minified | 종류 | 역할 | 신뢰도 |
|---|---|---|---|---|
| `forkToolUseContext` | `ED8` | fn | 서브에이전트용 ctx fork 빌더 (ef.js:9845) | 확인 |
| `replCtxBuilder` | `lW` | fn | main ctx 생성 (REPL, ef.js:20703) | 확인 |
| `snapshotReadFileState` | `y7H` | fn | readFileState 스냅샷(deep clone) | 확인 |
| `cloneContentReplacement` | `Ur9` | fn | contentReplacementState 복제 | 추정 |
| `subagentAppStateWhitelist` | `Yw5` | const[] | `["frameUrls","frameBannerHidden"]` — fork setAppState 허용 키 | 확인 |
| `freshAgentId` | `pm` | fn | 새 agent UUID 생성 | 확인 |
| `estimateMessageTokens` | `RA8` | fn | 최근 assistant input+output 토큰 추정(taskBudget 차감) | 확인 |
| `estimateTokensForModel` | `Wf` | fn | 모델별 토큰 추정 | 확인 |

## 10. SDK 레이어 (Anthropic SDK 내부)

| 직관 이름 | minified | 종류 | 역할 | 신뢰도 |
|---|---|---|---|---|
| `BetaToolRunner` | `oH_` | class | SDK 내장 ToolRunner (ef.js:1942) | 확인 |
| `sdkDispatchTools` | `j54` | fn | SDK in-class tool dispatcher | 확인 |
| `sdkCompactionCheck` | `qHq` | fn | SDK in-class compaction 체크 | 확인 |
| `BetaManagedAgents` | `aH_` | class | Anthropic managed agents API 클라이언트 | 확인 |
| `ToolError` | `SEH` | class | 도구 에러 (content 보존) | 확인 |

## 11. 도구 이름 상수

| 도구 | minified | 신뢰도 |
|---|---|---|
| `Bash` | `Cq` | 확인 |
| `Read` | `pq` | 확인 |
| `Edit` | `k7` | 확인 |
| `Write` | `_4` | 확인 |
| `Agent` | `J7` | 확인 |
| `Task`(=Agent alias) | `Fu` | 확인 |
| NotebookEdit | `CP` | 확인 |
| BashOutput(추정) | `_I_` | 추정 |
| PowerShell계열(추정) | `y9` | 추정 |
| `EnterPlanMode` | `AY6` | 확인 |
| `ExitPlanMode` | `xL` | 확인 |
| `EnterWorktree` | `cn7` | 확인 |
| `ExitWorktree` | `tn7` | 확인 |
| `CronCreate` | `p_3` | 확인 |
| `CronDelete` | `F_3` | 확인 |
| `CronList` | `d_3` | 확인 |
| `ScheduleWakeup` | `Ll7` | 확인 |
| `Skill` | `InHq` | 확인 |
| `ToolSearch` | `yX_` | 확인 |

## 12. Streaming / fallback / 기타

| 직관 이름 | minified | 종류 | 역할 | 신뢰도 |
|---|---|---|---|---|
| `StreamingToolExecutor` | `gX_` | class | 응답 스트리밍 중 도구 실행 컨테이너 | 확인 |
| `bashPowershellAbortPair` | `Q2` | const[] | `[Cq,y9]` — sibling abort 트리거 도구 | 확인 |
| `telemetryEnabled` | `M$` | fn | telemetry 활성 플래그 | 확인 |
| `evalStatsigGate` | `Z_` | fn | Statsig gate 평가 (memoized) | 확인 |
| `statsigPriorityM` | `m3_` | fn | Statsig 우선순위 1차 소스 | 추정 |
| `statsigPriorityP` | `p3_` | fn | Statsig 우선순위 2차 소스 | 추정 |
| `pluginRelevance` | `tZ6` | fn | plugin 연관성 helper | 확인 |
| `startSkillDiscoveryPrefetch호출자` | `Uy8` | fn | skill discovery prefetch 시작 | 확인 |
| `daemonSupervisor` | `L84` | fn | 데몬 lease/zombie/upgrade-self-restart 관리자 | 확인 |
| `peerUidGuard` | `i64` | fn | `getpeereid` FFI peer-UID 검증 | 확인 |
| `inProcessTeammate` | `fq6` | fn | in-process teammate 실행 | 확인 |
| `tmuxTeammate` | `DR8` | fn | tmux teammate 실행 | 확인 |
| `bgWorkerDispatch` | `m_H`→`ax3`→`A84` | fn | 백그라운드 워커 dispatch 체인 | 확인 |
| `afkBetaFlag` | `CC` | const | `cM("afk_mode","afk-mode-2026-01-31")` beta | 확인 |
| `interruptMessage` | `EHH` | fn | abort/interrupt 메시지 빌더 (ef.js:15505) | 확인 |
| `predicateApiError` | `r47` | fn | API 에러 메시지 predicate (ef.js:9891) | 확인 |
| `predicateImageError` | `rD8` | fn | 이미지 처리 에러 predicate (ef.js:9892) | 확인 |
| `predicateMaxOutputTokens` | `Fa7` | fn | `apiError==="max_output_tokens"` predicate (ef.js:14053) | 확인 |
| `predicatePromptTooLong` | `OGH` | fn | 413/prompt-too-long predicate (ef.js:7913) | 확인 |
| `extractTokenGap` | `FUH` | fn | actual vs limit 토큰 갭 추출 | 확인 |
| `speculativeExecEngine` | `DX8`/`PL` | fn | (하드 비활성) speculative execution 엔진 | 확인 |
| `speculationEnabledGate` | `JX8` | fn | speculative exec 활성 게이트 (현재 false 고정) | 확인 |

## 12b. R3 — UX / 통합 영역

| 직관 이름 | minified | 종류 | 역할 | 신뢰도 |
|---|---|---|---|---|
| `oauthRefreshWithLock` | `E68` | fn | OAuth 토큰 refresh + dual file lock | 확인 |
| `deadRefreshTokenSet` | `y68` | Set | 죽은 refresh 토큰 집합 | 확인 |
| `mapSubscriptionTier` | `cB_` | fn | `claude_max/pro/...` → `max/pro/...` 매핑 | 확인 |
| `rateLimitWarnCurve` | `se1` | fn | 클라이언트 조기경고 곡선 | 추정 |
| `quotaMismatchState` | `Ve_` | fn | 429 상태 → `tengu_quota_mismatch` | 추정 |
| `quotaPrecheckPing` | `_H5` | fn | 시작 시 `max_tokens:1` Haiku 사전핑 | 확인 |
| `quotaGateDisabled` | `KxH` | fn | quota gate (하드 `return !1`) | 확인 |
| `chromeCloudBridge` | `hN_` | class | claude-in-chrome OAuth WebSocket 클라우드 브릿지 | 확인 |
| `messageSelector` | `Ec8` | class | rewind UI MessageSelector | 확인 |
| `fileHistoryReducer` | `SkH` | fn | file-history track/snapshot reducer | 확인 |
| `fileCheckpointEnabledCfg` | `EY` | fn | `fileCheckpointingEnabled` 설정 접근 | 확인 |
| `sdkInitHandshake` | `p7O` | fn | SDK `initialize` 핸드셰이크 | 확인 |
| `sdkStallMs` | `AHO` | const | `300000` — SDK 5min stall 임계 | 확인 |
| `sdkSchemaCanaryRate` | `YHO` | const | `0.01` — 1% schema 검증 카나리 | 확인 |
| `sdkRoundtripTimeoutMs` | `zHO` | const | `30000` — SDK control roundtrip 타임아웃 | 추정 |
| `sdkResultPollMs` | `$HO` | const | `1000` — SDK result poll 간격 | 추정 |
| `injectNewDiagnostics` | `W73`/`Z73` | fn | edit 후 신규 LSP 진단을 `<system-reminder>`로 주입 | 확인 |
| `lspPushRegistry` | `gn`/`Z77` | obj | CC 자체 LSP push 진단 레지스트리 | 추정 |

> R3 식별자 다수는 추출 누락/스코프 한정으로 라인 참조만 확보된 보조 식별자. 상세는 각 R3 문서 인라인 표 참조.

---

## 13. 역인덱스 (minified → 직관 이름, 알파벳순)

빠른 역참조용. 본문에서 minified 토큰을 만나면 여기서 조회.

```
$NH  runStopFailureHook        N05  groupByConcurrencySafe   _Hq  sdkCompactionPrompt
$rH  autocompactImpl           N98  headerMain               _P_  isVirtualMessage
AB3  sectionDoingTasks         Nz_  replaceClearedHints      _d8  securityGuardPrompt
AC1  buildAliasMap             O2H  contextMgmtBetaHeader    _j_  runSingleTool
AKH  flattenCompactionResult   O75  replaceOversizedImpl     a63  executeToolPipeline
AM   resolvePermissionDecision OGH  predicatePromptTooLong   aH_  BetaManagedAgents
ANH  FallbackTriggeredError    OJH  lookupStopSessionHook    aY6  mergeUserContext
AY6  EnterPlanMode(tool)       PL   speculativeExecEngine    b47  decideReactiveCompact
Aw   hookPayloadBase           QA6  decidePermission         b77  decisionClassification
B93  makeSystemReminderAttach  Qa7  transformMemdirResults   bQ5  classifierTwoStage
B9K  makeMetaMessage           Qy8  rapidRefillCounter       bV_  stainlessHelperHeader
BFH  transcriptChunk           RA8  estimateMessageTokens    bp3  hookEventRegistry
Bq3  runTurnLoop               RJ6  retryHelper              cA6  checkIsolationLatch
Br9  mapResultBlock            SEH  ToolError                ca7  combineSystemAndContext
CC   afkBetaFlag               SH   jsonStringify            cn7  EnterWorktree(tool)
CP   NotebookEdit(tool)        Sa7  defaultLoopDeps          cr9  replaceOversizedResults
Cq   Bash(tool)                T2   coreHookEngine           d_3  CronList(tool)
D6   makeToolResultMessage     T57  persistTranscript        da7  awaitPostTurnSummary
DSK  callModelOuter            T9   makeAttachmentMessage    dA6  runPreToolUseHooks
DR8  tmuxTeammate              TC7  classifierSystemPrompt   eK   lookupTool
DX8  speculativeExecEngine     Ty8  slowHookWarnMs           eo   dynamicBoundaryMarker
ED8  forkToolUseContext        Ua7  tombstonePartialThenErr  f2   oneShotHookEngine
EHH  interruptMessage          UE8  rapidRefillCap           fc9  resultSizeCapDefault
F$H  oneHourCacheGate          UhK  evaluateGoal             fi9  extractReadPaths
F_3  CronDelete(tool)          Uq3  lastTurnBoundaryIndex    fq6  inProcessTeammate
FA6  runPostToolUseHooks       Ur9  cloneContentReplacement  gA6  runPostToolUseFailure
FUH  extractTokenGap           Uy8  skillDiscoveryPrefetch   gEK  buildContextMgmtParam
FX_  runPermissionDeniedHook   V05  concurrencyLimit         gX_  StreamingToolExecutor
Fa7  predicateMaxOutputTokens  V6z  permissionDecisionSchema gy8  rapidRefillBreakerMsg
Fj9  memoizeToolSchema         V76  mergeConcurrencyGroups   i0   expandAttachments
Fu   Task(tool alias)          VO   makeNotification         i64  peerUidGuard
H4   wrapSystem                Va7  runStopHooks             jf8  extractGitCommitId
H9   toAbsolutePath            WL9  headerSdkAppend          jo7  makeHookProgressMsg
HHq  sdkCompactionThreshold    WV   mergePermissionRules     k7   Edit(tool)
Hj_  dispatchToolBatch         Wf   estimateTokensForModel   kG   sectionCacheHelper
Ia7  runAutocompact            Xc9  persistedOutputCap       kP   serializeBetas
Ij9  dedupBetas                Xi9  timeBasedMicrocompact    lW   replCtxBuilder
InHq Skill(tool)               Xj6  serializeToolsApi        lz8  clearedHintPlaceholder
J7   Agent(tool)               YNH  persistToolResultDual    m3_  statsigPriorityM
JI   persistPermissionRules    YSK  nonStreamingFallback     mA   perModelLimits
JX8  speculationEnabledGate    Yw5  subagentAppStateWhitelist mJH abortCleanup
Jq   apiProvider               Z_   evalStatsigGate          ma7  detectBreakKeyword
K_   buildCreatePayload        ZA   sliceAtCompactBoundary   mk   hookEventNames
KZ   assembleSystemPrompt      ZL9  headerSdkAgent           nFK  requestPermissionDialog
Ll7  ScheduleWakeup(tool)      _4   Write(tool)              nq6  localDenialTracker
L84  daemonSupervisor          _I_  BashOutput?              nr8  sessionPromptInit
Mc9  resultSizeCapMid          _d8  securityGuardPrompt      o47  reactiveCompactPhaseB
M$   telemetryEnabled          oH_  BetaToolRunner           oY6  rapidRefillCap
oi_  billingHeaderBuilder      pt   microcompactNoop         t47  startPostTurnSummary
p3_  statsigPriorityP          qHq  sdkCompactionCheck       t5H  otelMeter
p_3  CronCreate(tool)          qP_  runPostToolBatchHook     tZ6  pluginRelevance
pm   freshAgentId              r47  predicateApiError        tn7  ExitWorktree(tool)
pq   Read(tool)                r63  wrapToolProgressQueue    u47  reactiveCompactPhaseA
pq3  resolveUserSystemPrompt   rD8  predicateImageError      u4H  markTurnActive
ri_  selectPromptHeader        rI   precomputeRegistry       v05  runSerialTools
rV6  stainlessHelperHeader     rY6  compactProgressQueue     v47  sectionCacheHelper
vM_  runAutoModeClassifier     wB3  sectionUsingTools        wU3  insertCacheMarkers
wg   blockingLimitMsg          wmH  clientRequestIdHeader    wo7  precheckBashMisuse
x47  startPrecomputeFork       x4H  dispatchStopHook         xK_  redactThinkingBeta
xL   ExitPlanMode(tool)        y$_  enforceBase64Limit       y05  runConcurrentTools
y1   makeApiErrorMessage       y7H  snapshotReadFileState    y9   PowerShell?(tool)
yX_  ToolSearch(tool)          yR8  classifierSystemPrompt   zB3  sectionSystem
zNH  contextPressureLevel
```

## 커버리지

- 추출 소스: `docs/analysis/*.md` 30개 문서, 매핑 테이블 행 750개
- 고유 minified 식별자: 543개 (일반 영단어 노이즈 제거 후)
- 글로서리 등재: 의미가 검증(확인)/추론(추정)된 핵심 식별자 ~160개
- 미등재: 라인번호만 있고 의미 미확정인 보조 식별자 (~380개) — 해당 deep-dive 문서의 인라인 표 참조
- 최다 기여 문서: `00-overview.md`(시드), `agent-loop-*.md` 12개, `permission-system.md`, `compaction-system.md`

## 표기 컨벤션 (앞으로)

신규/수정 문서는 첫 등장 시 `직관이름(\`minified\`)` 병기, 이후 둘 중 하나로 일관 사용:
- 예: "turn loop(`Bq3`)이 매 턴 system prompt를 `assembleSystemPrompt`(`KZ`)로 조립한다."
- minified는 항상 백틱 유지 (바이너리 grep 추적성 보존).
