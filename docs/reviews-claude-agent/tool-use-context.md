# ToolUseContext 구조

mutable session/turn-scoped state. 모든 도구 호출, hook, permission 결정, compaction 경로에 `ctx`로 주입되는 거대한 단일 객체.

진입점:
- **메인 컨텍스트 생성**: REPL 컴포넌트의 `replCtxBuilder` useCallback (`extracted-functions.js:20703`) — App store, registries, refs 묶음.
- **파생 컨텍스트 생성 (subagent 등)**: `forkToolUseContext` (`extracted-functions.js:9845`) — 부모 ctx를 받아 일부는 공유, 일부는 스냅샷, 일부는 빈 값으로 채운다.

## 1. 호출 그래프

```
[REPL useCallback]
  lW(messages, attachments, abortController, model)  (line 20703)
    │  AppState / hooks ref / registries / runtime callbacks 묶어 ToolUseContext 리턴
    ▼
PL({cacheSafeParams: {toolUseContext, ...}})         (line 9847)  ─ forked agent runner
    │
    ▼
ED8(parentCtx, overrides)                            (line 9845)  ─ 파생 ctx 빌더
    │
    ├── from subagent runner (agent-loop):
    │     runAgent → ED8(parentCtx, {options, agentId, agentType,
    │                                messages, readFileState,
    │                                abortController, getAppState,
    │                                getToolPermissionContext,
    │                                getEffortValue,
    │                                shareSetAppState: !isolated,
    │                                shareSetResponseLength: true,
    │                                criticalSystemReminder_EXPERIMENTAL,
    │                                contentReplacementState})
    │
    ├── from reactive compact (compaction-system):
    │     fw5(ctx, controller) → ED8 우회. abortController만 교체.
    │
    └── from speculation (line 10756):
          PL({overrides: {abortController, requireCanUseTool: true}})
          → ED8 호출에서 requireCanUseTool=true

[일반 도구 호출에서 ctx 사용]
  a63 (single tool full pipeline) ← _j_ ← Hj_ ← Bq3 turn loop
    │   ctx.getToolPermissionContext / getAppState / messageQueue / readFileState …
    │   PreToolUse hook (dA6) ← ctx.sessionHooksRegistry
    │   Permission decision (QA6) ← ctx.localDenialTracking + ctx.setClassifierApprovals
    │   tool.call(input, ctx, …)
    │   PostToolUse (FA6)
```

## 2. 핵심 로직 — `forkToolUseContext` 파생 규칙

### 의사코드

```javascript
function ED8(parent, opts) {
  // ── abortController: 옵션 우선, 공유 플래그 있으면 부모 controller,
  //    아니면 ev() 로 wrapped 자식 controller (부모 abort → 자식 abort)
  const abortController =
    opts?.abortController ??
    (opts?.shareAbortController ? parent.abortController : ev(parent.abortController));

  // ── getAppState / getToolPermissionContext:
  //    명시 override 있거나 shareAbortController 면 부모 그대로,
  //    그 외엔 토큰권한컨텍스트.shouldAvoidPermissionPrompts=true 를 강제하는 wrapper.
  //    "subagent는 사용자 프롬프트를 띄울 수 없다"는 invariant.
  const getAppState =
    opts?.getAppState ??
    (opts?.shareAbortController
      ? parent.getAppState
      : () => {
          const s = parent.getAppState();
          if (s.toolPermissionContext.shouldAvoidPermissionPrompts) return s;
          return {
            ...s,
            toolPermissionContext: { ...s.toolPermissionContext, shouldAvoidPermissionPrompts: true }
          };
        });
  const getToolPermissionContext = /* 동일 패턴 */ ;

  return {
    // ── 공유 (같은 reference) ───────────────────────────────
    messageQueue:           parent.messageQueue,
    sessionEnvVars:         parent.sessionEnvVars,
    discoveredRemoteSkills: parent.discoveredRemoteSkills ?? new Map(),
    taskRegistry:           parent.taskRegistry,
    sessionHooksRegistry:   parent.sessionHooksRegistry,
    setClassifierApprovals: parent.setClassifierApprovals,
    getReplContexts:        parent.getReplContexts,
    setReplContext:         parent.setReplContext,
    setWebBrowserSlice:     parent.setWebBrowserSlice,
    abortSpeculation:       parent.abortSpeculation,
    agentLifecycle:         parent.agentLifecycle,
    teammateColors:         parent.teammateColors,
    applyAttributionOp:     parent.applyAttributionOp,
    requestDialog:          parent.requestDialog,
    getAutoCompactWindow:   parent.getAutoCompactWindow,
    getFastMode:            parent.getFastMode,
    getCacheBreakerPhrase:  parent.getCacheBreakerPhrase,
    getMcp:                 parent.getMcp,
    getWebBrowser:          parent.getWebBrowser,
    getComputerUseMcpState: parent.getComputerUseMcpState,
    getEffortValue:         opts?.getEffortValue ?? parent.getEffortValue,
    fileReadingLimits:      parent.fileReadingLimits,
    userModified:           parent.userModified,

    // ── 스냅샷 (deep clone) ────────────────────────────────
    readFileState:          y7H(opts?.readFileState ?? parent.readFileState),  // LRU 복제
    contentReplacementState: opts?.contentReplacementState ??
                             (parent.contentReplacementState
                               ? Ur9(parent.contentReplacementState)            // Set/Map clone
                               : undefined),

    // ── 새로 만든 빈 값 ─────────────────────────────────────
    nestedMemoryAttachmentTriggers: new Set(),
    loadedNestedMemoryPaths:        new Set(),
    dynamicSkillDirTriggers:        new Set(),
    discoveredSkillNames:           new Set(),
    memorySelector:                 jYH(),       // {stateByDir: Map, lastUsage: null}
    toolDecisions:                  undefined,

    // ── wrapped (proxy with override) ──────────────────────
    abortController, getAppState, getToolPermissionContext,
    isolationLatch: opts?.isolationLatch ?? parent.isolationLatch,

    // ── 부모로의 setAppState 게이트: Yw5 키만 통과 ─────────
    setAppState: opts?.shareSetAppState
      ? parent.setAppState
      : (updater) => parent.setAppState((s) => {
          const next = updater(s);
          if (next === s) return s;
          let changed = false;
          const merged = { ...s };
          for (const k of Yw5)              // Yw5 = ["frameUrls", "frameBannerHidden"]
            if (next[k] !== s[k]) { Object.assign(merged, {[k]: next[k]}); changed = true; }
          return changed ? merged : s;
        }),

    // ── shareSetAppState=false 면 사실상 봉인된 mutator ────
    setToolPermissionContext: opts?.shareSetAppState ? parent.setToolPermissionContext : () => {},
    applyFlagSettings:        opts?.shareSetAppState ? parent.applyFlagSettings        : () => {},
    setComputerUseMcpState:   opts?.shareSetAppState ? parent.setComputerUseMcpState   : undefined,
    localDenialTracking:      opts?.shareSetAppState ? parent.localDenialTracking      : nq6(),
                              // nq6() = { consecutiveDenials:0, totalDenials:0 } — 새 카운터

    // ── 응답 길이 / API metrics ────────────────────────────
    addResponseLength:    opts?.shareSetResponseLength ? parent.addResponseLength    : () => {},
    resetResponseLength:  opts?.shareSetResponseLength ? parent.resetResponseLength  : () => {},
    pushApiMetricsEntry:  opts?.shareSetResponseLength ? parent.pushApiMetricsEntry  : undefined,

    // ── 파일 히스토리: 파생 ctx 에서는 비활성 no-op ─────────
    getFileHistoryState: () => { return; },     // 부모는 진짜 store 리턴, 자식은 항상 undefined
    applyFileHistoryOp:  () => {},

    // ── 자식에서는 차단되는 UI/IO 핸들 ──────────────────────
    addNotification:    undefined,
    setToolJSX:         undefined,
    onCompactEvent:     undefined,
    openMessageSelector: undefined,

    // ── 입력에서 가져오는 필드 ─────────────────────────────
    options:                 opts?.options ?? parent.options,
    messages:                opts?.messages ?? parent.messages,
    turnStartIndex:          0,                                    // 항상 0 으로 재설정
    agentId:                 opts?.agentId ?? pm(),                // 명시 안 하면 새 UUID
    agentType:               opts?.agentType,
    precomputeSourceKey:     opts?.precomputeSourceKey,
    criticalSystemReminder_EXPERIMENTAL: opts?.criticalSystemReminder_EXPERIMENTAL,
    requireCanUseTool:       opts?.requireCanUseTool,

    // ── 체인 추적: depth +1, 새 chainId ────────────────────
    queryTracking: {
      chainId: crypto.randomUUID(),
      depth:   (parent.queryTracking?.depth ?? -1) + 1            // root → 0
    }
  };
}
```

### 파생 규칙 표 (`forkToolUseContext` 분류)

| 필드 | 분류 | 동작 |
|---|---|---|
| `messageQueue` | shared | 동일 참조 |
| `readFileState` | snapshot | `y7H()` 로 LRU 복제 (`vI(max, maxSize).load(dump())`) |
| `nestedMemoryAttachmentTriggers` | fresh | `new Set` |
| `loadedNestedMemoryPaths` | fresh | `new Set` |
| `sessionEnvVars` | shared | 동일 참조 |
| `dynamicSkillDirTriggers` | fresh | `new Set` |
| `discoveredSkillNames` | fresh | `new Set` (subagent별 분리된 skill discovery) |
| `discoveredRemoteSkills` | shared | `parent.discoveredRemoteSkills ?? new Map` |
| `memorySelector` | fresh | `jYH() = {stateByDir: new Map, lastUsage: null}` |
| `toolDecisions` | reset | `undefined` |
| `contentReplacementState` | snapshot | `Ur9({seenIds:new Set, replacements:new Map})` clone |
| `abortController` | wrapped | `ev()` 자식 controller — 부모 abort → 자식 abort |
| `getAppState` | wrapped proxy | `shouldAvoidPermissionPrompts: true` 강제 |
| `getToolPermissionContext` | wrapped proxy | 동상 |
| `setAppState` | gated | `Yw5 = ["frameUrls","frameBannerHidden"]` 키만 부모로 전달 |
| `setToolPermissionContext` | no-op | `() => {}` (subagent는 permission ctx 못 바꿈) |
| `applyFlagSettings` | no-op | `() => {}` |
| `setComputerUseMcpState` | disabled | `undefined` |
| `localDenialTracking` | fresh | `nq6()={consecutiveDenials:0,totalDenials:0}` (자식 카운터) |
| `addResponseLength` / `reset…` | no-op | 옵션 없으면 `() => {}` |
| `pushApiMetricsEntry` | disabled | `undefined` |
| `getFileHistoryState` | dead | 항상 `undefined` 리턴 |
| `applyFileHistoryOp` | no-op | (checkpoint/diff/undo 비활성) |
| `applyAttributionOp` | shared | 동일 참조 (subagent 호출 비용을 부모 attribution에 적립) |
| `requestDialog` | shared | (그러나 `shouldAvoidPermissionPrompts` 가 켜져 있어 실제론 안 띄움) |
| `addNotification` | disabled | `undefined` |
| `setToolJSX` | disabled | `undefined` |
| `onCompactEvent` | disabled | `undefined` |
| `openMessageSelector` | disabled | `undefined` |
| `isolationLatch` | inherited | `opts ?? parent` |
| `taskRegistry` | shared | (subagent 등록/조회용) |
| `sessionHooksRegistry` | shared | (자식이 추가하는 hooks 도 같은 레지스트리) |
| `setClassifierApprovals` | shared | auto-mode classifier 결과 적립 |
| `getReplContexts`/`setReplContext` | shared | REPL 도구가 자식에서도 동작 |
| `setWebBrowserSlice` | shared | |
| `abortSpeculation` | shared | |
| `agentLifecycle` | shared | `{registerName, markTypeInvoked, clearTodos}` — subagent도 todos clear 호출 |
| `teammateColors` | shared | `{assign, assignments, clear, index}` |
| `getAutoCompactWindow`/`getFastMode`/`getCacheBreakerPhrase`/`getMcp`/`getWebBrowser`/`getComputerUseMcpState` | shared | |
| `getEffortValue` | shared / opt | `opts ?? parent.getEffortValue` |
| `options` | opt / inherit | `opts.options ?? parent.options` |
| `messages` | opt / inherit | `opts.messages ?? parent.messages` |
| `turnStartIndex` | reset | `0` |
| `agentId` | opt / fresh | `opts.agentId ?? pm()` — 미지정시 새 UUID |
| `agentType` | opt | `opts.agentType` |
| `precomputeSourceKey` | opt | `opts.precomputeSourceKey` (borrow-from-precompute용 키) |
| `queryTracking` | derived | `{chainId: randomUUID(), depth: (parent?.depth ?? -1)+1}` |
| `fileReadingLimits` | shared | |
| `userModified` | shared | |
| `criticalSystemReminder_EXPERIMENTAL` | opt | `opts.criticalSystemReminder_EXPERIMENTAL` |
| `requireCanUseTool` | opt | `opts.requireCanUseTool` |

### `subagentAppStateWhitelist` (AppState 양방향 sync 화이트리스트)

```javascript
Yw5 = ["frameUrls", "frameBannerHidden"]
```

확인: subagent의 `setAppState` 호출 중 위 2개 키만 부모 AppState로 전달된다. (UI에서 새 frame URL을 띄우거나 banner를 숨기는 정도만 허용.) 나머지 mutation 은 전부 봉인. — 즉 **subagent는 부모의 cwd/permission/MCP 상태를 변경하지 못한다.**

### `shouldAvoidPermissionPrompts` 강제 이유

`forkToolUseContext` 의 wrapped `getAppState`/`getToolPermissionContext` 는 항상 `shouldAvoidPermissionPrompts: true` 를 강제 주입한다. **추정**: subagent는 사용자 IO 채널을 점유할 수 없으므로 permission dialog 를 띄울 수 없다. `decidePermission` 권한 결정에서 이 플래그가 켜져 있으면 `behavior: "ask"` 가 자동으로 `behavior: "deny"` 로 떨어진다 (`extracted-functions.js:15421` 부근 `resolvePermissionDecision` 함수 참조).

### `agentId` 와 `pm()`

```javascript
function pm(H) {
  const _ = crypto.randomBytes(8).toString("hex");
  return H ? `a${H}-${_}` : `a${_}`;
}
```

- 인자 없이 호출하면 `a` + 16 hex chars (예: `a1a2b3c4d5e6f708`)
- 인자가 있으면 `a${prefix}-${hex}` (예: `aforked-agent-1a2b3c4d5e6f7080`)
- ED8 의 fallback (`opts?.agentId ?? pm()`) 는 prefix 없이 호출 → **임의 spawn 도 새 agentId 부여**

### `queryTracking { chainId, depth }`

- `chainId`: 매 `forkToolUseContext` 호출마다 `crypto.randomUUID()` — 즉 같은 chain 이라도 fork 마다 새 chainId. **추정**: depth 만 incremental, chainId 는 fork 단위 식별.
- `depth`: `(parent.queryTracking?.depth ?? -1) + 1` — root (REPL ctx에는 queryTracking 없음 → undefined?) 에서 첫 fork = 0, 두번째 = 1, …
- 텔레메트리에서 `queryChainId`, `queryDepth` 로 보고 (`tengu_fork_agent_query` 이벤트, line 9848).

### `precomputeSourceKey`

reactive compact (`reactiveCompactPhaseA`/`reactiveCompactPhaseB`) 가 부모 turn의 미리계산된 compact 결과(precompute store `rI: Map`)에서 차용할 때 쓰는 키. `speculativeExecEngine` 에서 자동 채워짐:

```javascript
precomputeSourceKey: T?.precomputeSourceKey ?? P.agentId ?? "main"
```

따라서 main session은 `"main"` 키, subagent는 자기 agentId 키. compaction-system 문서의 `Pw5`(borrowed pending) / `Ww5`(consume ready) 가 이 키로 lookup.

## 3. State / Schema — 필드 카탈로그

분류는 목적별. minified ID는 백틱.

### Memory / Files

| 필드 | 타입 | 역할 |
|---|---|---|
| `readFileState` | LRU(`$r9` from `vI`) of `{content, timestamp, offset, limit, isPartialView, keepContent?, contentLength?}` | Read/Edit/Write 의 timestamp 기반 staleness 체크. Edit 전에 mtime > timestamp 면 거부 (line 13135). 도구의 `call(input, ctx)` 에서 `ctx.readFileState.set(path, …)` 로 갱신. fork 시 `y7H()` 로 dump+load 복제. |
| `loadedNestedMemoryPaths` | `Set<string>` | 이미 attachment 로 첨부한 nested CLAUDE.md 경로. 중복 첨부 방지 (line 14285). |
| `nestedMemoryAttachmentTriggers` | `Set` | nested memory 가 추가된 trigger 출처 추적. fork 시 empty. |
| `memorySelector` | `{stateByDir: Map, lastUsage: null}` | 메모리 디렉터리별 선택 상태. `jYH()` 로 fresh. |
| `fileReadingLimits` | `{maxTokens, maxSizeBytes}` | Read 도구가 `s7H()` 기본값을 ctx 값으로 override. subagent도 같은 값 공유 (Task tool 같은 곳은 무한대로 override 가능 — REPL `ce5`에서 `{maxTokens: Infinity, maxSizeBytes: 268435456}` 설정 사례 확인 line 13615). |
| `userModified` | boolean | permission dialog 에서 사용자가 input 을 수정했는지 추적 (write/edit 결과의 `userModified` 출력에 반영). |

### Skills / Subagents

| 필드 | 타입 | 역할 |
|---|---|---|
| `discoveredSkillNames` | `Set<string>` | 이번 session/agent 에서 로드된 skill 이름. fork 시 empty (subagent는 자기 set 으로 추적). |
| `discoveredRemoteSkills` | `Map<string, Skill>` | 원격 skill 정의 캐시. fork 시 부모와 공유. |
| `dynamicSkillDirTriggers` | `Set` | nested skill dir 자동 탐색 trigger. fork 시 empty. |
| `taskRegistry` | `{register, get, update, all, applyOffsetsAndEvict}` | subagent/task lifecycle store. 모든 child ctx 공유. |
| `agentLifecycle` | `{registerName, markTypeInvoked, clearTodos}` | agent 이름·타입 first-invocation 추적, todos 정리. 공유. |
| `teammateColors` | `{assign, assignments, clear, index}` | in-process teammate(swarm) 컬러 배정. 공유. |
| `agentId` | string (UUID-ish, `a` prefix) | 현재 agent 의 id. main은 REPL 에서 따로 안 줌 (?). subagent는 `pm()` 새로 생성. |
| `agentType` | string? | `"general-purpose"`, swarm teammate 이름 등. main 은 undefined. |

### Permission / Classifier

| 필드 | 타입 | 역할 |
|---|---|---|
| `getToolPermissionContext` | `() => ToolPermissionContext` | mode/alwaysAllowRules/cwd/additionalWorkingDirectories/shouldAvoidPermissionPrompts 등. subagent ctx 는 wrapper 로 `shouldAvoidPermissionPrompts:true` 강제. |
| `setToolPermissionContext` | function | main 에서만 동작. subagent 는 no-op (`shareSetAppState` 면 통과). |
| `setClassifierApprovals` | setter | auto-mode classifier 가 동일 input 재호출 시 cache (`S47`/`fwH`/`h47`/`C47`/`I47` 패밀리). 공유. |
| `localDenialTracking` | `{consecutiveDenials, totalDenials}` | auto-mode classifier 가 deny 했을 때 카운트. consecutiveDenials 가 임계치 넘으면 loop break. fork 시 fresh (subagent 본인의 deny streak 만 추적). main 으로 atomic write 는 `_oH` 가 처리 (있으면 ctx 의 localDenialTracking, 없으면 AppState 의 denialTracking 으로 fallback). |

### Hooks

| 필드 | 타입 | 역할 |
|---|---|---|
| `sessionHooksRegistry` | `{add, remove, clear}` | session 내내 살아있는 hook 핸들러 store. subagent 가 SubagentStop 등록 가능, finally 에서 `clear(agentId)` (line 14064 finally). 공유. |

### App State / Settings

| 필드 | 타입 | 역할 |
|---|---|---|
| `getAppState` | `() => AppState` | Zustand-like global store getter. subagent wrapper 가 permissionPrompts 막음. |
| `setAppState` | `(updater) => void` | main 은 직접, subagent 는 `subagentAppStateWhitelist` (`frameUrls`, `frameBannerHidden`) 만 통과시키는 게이트. |
| `applyFlagSettings` | function | CLI flag 결과를 AppState에 반영. subagent 면 no-op. |
| `getEffortValue` | `() => EffortLevel` | CLAUDE_EFFORT env 또는 hook 결과. `low|medium|high|xhigh|max`. |
| `getAutoCompactWindow` | function | reactive compact 의 token window. |
| `getFastMode` | function | thinking 비활성 등 fast mode flag. |
| `getCacheBreakerPhrase` | function | prompt cache 무효화용 phrase. |
| `options` | static config | `tools, commands, mainLoopModel, thinkingConfig, mcpClients, debug, verbose, isNonInteractiveSession, customSystemPrompt, appendSystemPrompt, agentDefinitions, refreshTools, …`. subagent 에서는 `opts.options` 로 override (subagent 만의 tools 리스트 등). |
| `messages` | array | 메시지 array reference. subagent 는 자기 슬라이스 받음. |
| `turnStartIndex` | number | 현재 turn 이 messages 의 어느 index 부터 시작했는지. ED8 에서 항상 0. main 도 REPL 에서 0 으로 설정. |

### MCP / Web / Computer Use

| 필드 | 타입 | 역할 |
|---|---|---|
| `getMcp` | function | MCP clients/tools/resources snapshot. |
| `getWebBrowser` | function | WebBrowser slice (Claude-in-Chrome 등). |
| `setWebBrowserSlice` | setter | 공유. |
| `getComputerUseMcpState` | function | computer-use lock/state. |
| `setComputerUseMcpState` | setter | subagent ctx 에서는 undefined (shareSetAppState 면 통과). |
| `isolationLatch` | `{current, exemptServers}` | worktree isolation (다른 cwd에서 일부 tool/MCP만 허용). `runSingleTool` 의 `checkIsolationLatch` 가 검사 (overview.md 참조). PL 에서 명시적으로 `{current: parent.isolationLatch?.current ?? null, exemptServers: parent.isolationLatch?.exemptServers}` 로 전달 보정. |

### UI / IO Callbacks

| 필드 | 타입 | 역할 / fork 후 |
|---|---|---|
| `requestDialog` | function | (permission dialog 직접 띄움 — REPL의 `G9`). subagent도 reference는 공유되나 `shouldAvoidPermissionPrompts` 때문에 호출 안 됨. |
| `addNotification` | function | OS 알림 핸들러. subagent 에서 `undefined`. |
| `setToolJSX` | function | tool 이 React 컴포넌트로 렌더하는 핸들. subagent 에서 `undefined`. |
| `onCompactEvent` | function | compact_progress / sdk_status 이벤트 분배 (compaction UI). subagent `undefined`. |
| `openMessageSelector` | function | 메시지 fork 선택 UI. subagent `undefined`. |
| `getReplContexts` | function | REPL slot 별 inner context (jupyter-like). 공유. |
| `setReplContext` | function | 공유. |

### Accounting / Metrics

| 필드 | 타입 | 역할 |
|---|---|---|
| `addResponseLength` | function | streaming output 토큰 누적기. subagent 면 `shareSetResponseLength` 켤 때만 통과. |
| `resetResponseLength` | function | 동상. |
| `pushApiMetricsEntry` | function | TTFT 등 API metric 로깅. 공유 옵션. |
| `applyAttributionOp` | reducer | `{kind: "incrementPermissionPrompt"}` 같은 attribution 카운터 op. REPL 의 store 에 `attribution` slice 가짐. **항상 공유** (subagent 비용도 부모 attribution 에 적립). |

### Attribution 의미 (`X75`/`G_6`/`P75`, line 8600–8603)

- `attributionAgent` — agent 호출 prefix(`agent:builtin:` / `agent:custom:`) 에서 추출한 이름 (예: `"general-purpose"`).
- `attributionSkill` — skill 이름 (skill 호출 트리거 시).
- `attributionPlugin` — skill 이 marketplace plugin 에서 왔으면 plugin 이름. `R_6` 가 known plugin set.

OTEL/Statsig metric 라벨로 사용 (line 9482 `egH`):
```
"agent.name", "skill.name", "plugin.name", "marketplace.name"
```

session log scan (line 16029 `kJ3`) 도 transcript JSONL에서 `"attributionAgent":` 등을 byte-level prefix search 로 추출 — 즉 **저장된 메시지에도 attribution 필드 직렬화됨** (`Wz3` 참조, line 15518).

### File History (`getFileHistoryState`/`applyFileHistoryOp`)

REPL ctx (line 20703):
```javascript
getFileHistoryState: () => $H.getState().fileHistory,
applyFileHistoryOp(op) {
  TH(s => {
    const next = SkH(s.fileHistory, op);
    return next === s.fileHistory ? s : {...s, fileHistory: next};
  });
}
```

- 도구가 파일을 수정할 때 `applyFileHistoryOp` 호출 → `fileHistoryReducer` reducer 가 history slice 업데이트.
- Edit/Write/Bash(`sed`) 호출 직전에 `CjH($, z, path, uuid)` 로 pre-edit snapshot 잡음 (line 13135 `Aj`(Write) 의 `call`, 13195 `Xp`(NotebookEdit), 15297 등).
- subagent 에서는 둘 다 비활성 (`getFileHistoryState: () => undefined`, `applyFileHistoryOp: () => {}`) — **subagent 파일 변경은 부모 file history 에 기록되지 않는다 (확인)**.

**추정**: file history는 `/checkpoint` 또는 undo/revert UI 용. v2 에 새로 추가된 추적 메커니즘.

### Experimental / 기타

| 필드 | 타입 | 역할 |
|---|---|---|
| `criticalSystemReminder_EXPERIMENTAL` | string? | (Zod schema) "Critical reminder added to system prompt". system-prompts.md 계열에서 system reminder 로 주입. subagent 정의에서 명시 가능. **추정**: 일반 `<system-reminder>` 보다 강한 priority. |
| `requireCanUseTool` | boolean | speculation (line 10756) 에서 `true`. `decidePermission` (line 13603) 가 hook 이 `allow` 로 결정해도 `requireCanUseTool` 면 canUseTool 콜백을 무조건 실행해 final 결정 — **즉 hook bypass 차단**. |
| `precomputeSourceKey` | string | reactive compact borrow lookup 키 (위 참조). |
| `contentReplacementState` | `{seenIds: Set, replacements: Map}` | 콘텐츠 치환(<redacted-…>) 추적. `cloneContentReplacement` 로 fork 시 deep clone. |
| `messageQueue` | queue handle | 외부 입력 메시지 큐. 공유. |
| `sessionEnvVars` | ref<Record> | session export 한 env vars. Bash tool 이 이 env 으로 child process 띄움. 공유. |
| `abortSpeculation` | function | speculation 중단 헬퍼. |
| `replHydration` | (선택) | subagent runner 에서 `RH.replHydration = Y.replHydration` 로 주입 (line 14064). `{kind:"resume"}` 같이 REPL resume 표시. ED8 출력에는 직접 없음 — 호출자 가 후에 set. |
| `renderedSystemPrompt` | (선택) | `replCtxBuilder`-호출자 (KhH 등) 가 system prompt 빌드 후 `s_.renderedSystemPrompt = Y7` 로 set (line 20703). debug/telemetry 용. |
| `preserveToolUseResults` | (선택) | subagent runner 가 `RH.preserveToolUseResults = true` 설정 (line 14064). |
| `onQueryEvent` | (선택) | REPL ctx 만. conversation_reset 등 query 이벤트 수신. |
| `setHasInterruptibleToolInProgress` | (선택) | REPL ctx 만. interrupt 가능한 도구 진행 중 플래그. |
| `resume` | (선택) | REPL ctx 만. `ayH` (session resume 트리거). |
| `setMessages` / `applyMessageOp` | (선택) | REPL ctx 만. 메시지 store 직접 mutate. ED8 출력에 없음 — subagent 는 자기 `messages` slice 만 다룸. |
| `emitToolProgress` | (선택) | REPL ctx 만. tool progress 이벤트 발행. |
| `appendSystemMessage` | (선택) | REPL ctx 만. system 메시지 append. |
| `sendOSNotification` | (선택) | REPL ctx 만. |
| `onChangeAPIKey` / `onChangeDynamicMcpConfig` / `onInstallIDEExtension` | (선택) | REPL ctx 만. |

### `localDenialTracking` 의미 (`nq6()`)

```javascript
function nq6() { return {consecutiveDenials: 0, totalDenials: 0}; }
```

- `consecutiveDenials` — 연속 deny 카운터. allow 가 나오면 `Zw_(M)` 로 reset (`extracted-functions.js:15421` 부근).
- `totalDenials` — 누적 deny.
- auto-mode classifier 가 deny 결정 시 `P47(M)` 로 증가시켜 `_oH(ctx, next)` 로 ctx 또는 AppState 에 write.
- subagent 마다 fresh 인 이유: **subagent 의 deny streak 가 부모 main 의 streak 과 섞이면 안 됨**.

### `readFileState` 운명

- 도구가 `call(input, ctx, signal, …)` 에서 `ctx.readFileState.set(path, {content, timestamp:fs.statMtimeMs, offset, limit, isPartialView, …})` 로 write.
- Edit/Write 의 `validateInput` 이 `ctx.readFileState.get(path)` 로 staleness 체크: `mtime > stored.timestamp` 면 "File has been modified since read" 거부.
- `tT` (Read) 가 dedup: 같은 offset/limit + 동일 mtime 이면 `file_unchanged` 토큰만 리턴 (line 14727 `tT.call` 의 dedup branch).
- forked agent 가 `speculativeExecEngine` finally 에서 자기 `readFileState.clear()` (line 9847) — 부모는 영향 없음 (스냅샷이라서).

## 4. 차이점 (v0.2.8 대비)

v0.2.8 ToolUseContext (re. 기억): flat 한 ~6개 필드.
```
{
  abortController,
  readFileTimestamps,      // 단순 Record<string, number>
  options,
  messageId,
  forkNumber,
  messageLogName
}
```

v2.1.143 의 변화:

| 영역 | v0.2.8 | v2.1.143 |
|---|---|---|
| 파일 추적 | `readFileTimestamps: Record<string, number>` | `readFileState`: LRU(`$r9`) of `{content, timestamp, offset, limit, isPartialView, ...}` — 토큰 dedup 까지 |
| 권한 | `options.dangerouslySkipPermissions` 정적 | `getToolPermissionContext()` 함수 + 6 modes + `localDenialTracking` 카운터 + classifier approvals + `requireCanUseTool` flag |
| 메모리 | 없음 | `loadedNestedMemoryPaths`, `nestedMemoryAttachmentTriggers`, `memorySelector` (per-dir state) |
| Skill | 없음 | `discoveredSkillNames`, `discoveredRemoteSkills`, `dynamicSkillDirTriggers` |
| Subagent | `forkNumber: number` (단순 식별자) | `agentId` UUID + `agentType` + `queryTracking {chainId, depth}` + `taskRegistry` + `agentLifecycle` + `teammateColors` |
| Hook | 없음 | `sessionHooksRegistry` 전체 store |
| MCP | `mcpClients` static | `getMcp()` reactive + `getComputerUseMcpState` + `isolationLatch` |
| AppState | tool ↔ store 직접 | `getAppState`/`setAppState` proxy + `subagentAppStateWhitelist` whitelist gating |
| Compaction | 없음 | `getAutoCompactWindow`, `precomputeSourceKey`, `onCompactEvent` |
| File history | 없음 | `getFileHistoryState`/`applyFileHistoryOp` (subagent 에선 비활성) |
| Attribution | 없음 | `applyAttributionOp` (`attributionAgent`/`Skill`/`Plugin`) |
| Metrics | message logs only | `addResponseLength`/`resetResponseLength`/`pushApiMetricsEntry` |
| Content rewrite | 없음 | `contentReplacementState {seenIds, replacements}` (sensitive content redaction) |
| 실험 | 없음 | `criticalSystemReminder_EXPERIMENTAL`, `requireCanUseTool` |
| Speculation | 없음 | `abortSpeculation` |

`forkNumber: number` → `queryTracking: {chainId: UUID, depth: number}` 가 가장 큰 의미 변화. 카운터에서 트리 구조로.

## 5. 외부 사용 패턴 요약

```
                    [REPL]                              [SDK / managed agents (oH_)]
                       │                                       │
                  lW (line 20703)                         자체 internal context
                       │                                  (j54 만 ToolUseContext 비슷한
                       │                                   {tools, messages, signal} 받음)
                       ▼
              [main ToolUseContext]
                       │
                       ├── Bq3 turn loop (agent-loop.md)
                       │     └── _j_/a63/Hj_ ─→ tool.call(input, ctx)
                       │           ├── PreToolUse  (uses ctx.sessionHooksRegistry)
                       │           ├── permission  (uses ctx.getToolPermissionContext,
                       │           │                ctx.localDenialTracking,
                       │           │                ctx.setClassifierApprovals)
                       │           └── PostToolUse
                       │
                       ├── reactive compact (u47/o47)
                       │     └── fw5(ctx, new AbortController) 로 abortController만 swap
                       │
                       ├── precomputed compact (x47, line 9875)
                       │     └── PL({overrides:{precomputeSourceKey:ctx.agentId??"main"}})
                       │
                       └── subagent / Task tool
                             └── runAgent → ED8(parentCtx, opts)
                                   ├── shareSetAppState: !isolated
                                   ├── shareSetResponseLength: true
                                   ├── 새 messages slice
                                   └── 자식 abortController
```

## 6. Sanity-check 메모

- ED8 은 `replHydration`, `renderedSystemPrompt`, `preserveToolUseResults` 등 후속 호출자가 직접 attach 하는 필드는 **포함하지 않는다**. ED8 직후 caller 가 mutate.
- REPL ctx 의 `nestedMemoryAttachmentTriggers: new Set` 은 callback 본문 안에서 매번 새로 만든다 (line 20703) — **확인 필요**: 이건 매 lW 호출마다 fresh 인 것으로 보임. 즉 REPL은 turn 단위로 reset. 자식(ED8)도 fresh. → 일관성 OK.
- 다른 ToolUseContext 같은 객체로 SDK 의 `BetaToolRunner` BetaToolRunner 가 있으나 그건 Anthropic SDK 의 다른 추상화(`{tools, messages, signal}` 만 받는 `sdkDispatchTools`) 라서 본 문서의 ToolUseContext 와 동일 layer 아님.
- `criticalSystemReminder_EXPERIMENTAL` 가 실제로 system prompt 어디에 주입되는지 grep 으로는 ED8 path-through 와 zod schema 외 직접 사용처를 못 찾음. **확인 필요** — 추정: subagent runner 의 system prompt builder 에서 condition 으로 inject.
- `Yw5 = ["frameUrls", "frameBannerHidden"]` 가 너무 좁아 보이는데, 이게 정말 subagent → parent AppState write 의 *전체* 허용 키 집합이 맞는지는 ED8 외에 grep 없음 → 본 문서 기준 **확인됨**(`subagentAppStateWhitelist` 가 ED8 외에는 정의/사용처 없음).
