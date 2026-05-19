# Permission system

도구 호출 한 건마다 allow / deny / ask 를 결정하는 파이프라인. v2 의 핵심 변화는 (1) `decidePermission` 라는 외부 함수로 결정 로직이 분리됐고, (2) PreToolUse 훅 결과(`hookPermissionResult`)를 통합 처리하며, (3) `auto` 모드에서 별도 LLM classifier 가 동작하고, (4) `PermissionDenied` 훅이 재시도 신호를 보낼 수 있다는 점이다.

핵심 식별자:

| 식별자 | 역할 | 위치 |
|---|---|---|
| `QA6(H,_,q,K,O,T,$)` | 결정 오케스트레이터 (훅결과 vs. 정책 callback 분기) | `extracted-functions.js:13603` |
| `AM(H,_,q,K,O)` | 기본 `canUseTool` 콜백 — rule → mode → classifier 분기 | `extracted-functions.js:15421` |
| `FX_(H,_,q,K,O,T,$)` | `PermissionDenied` 훅 러너 (retry 신호) | `extracted-functions.js:18822` |
| `kJH(H,_,q)` | rule 평가 (deny / ask 룰만, allow 아님) | 15412 |
| `qz3(H,_,q)` | `resolvePermissionDecision` 내부 1차 평가 (allow까지 포함) | 15413 |
| `pX_` / `EC8` / `H1H` / `gNH` | alwaysDeny / alwaysAsk / allow 룰 lookup | 15397 / 15398 / 15392 / 15393 |
| `WV(ctx, updates[])` | 룰 업데이트 적용 — in-memory 머지 | 7347 |
| `FT(ctx, update)` | 단일 update reducer (`setMode`/`addRules`/`replaceRules`/`removeRules`/`addDirectories`/`removeDirectories`) | 7346 |
| `JI(updates)` / `$t(update)` | 룰 업데이트 디스크 영속화 (settings.json) | 7350 / 7349 |
| `vM_(...)` | auto-mode classifier — 별도 LLM 호출 | 12391 |
| `hR8(name, input)` | classifier 용 가짜 assistant tool_use 메시지 빌더 | 12401 |
| `nq6()` | localDenialTracking 초기값 `{consecutiveDenials:0,totalDenials:0}` | 9831 |
| `P47` / `Zw_` / `W47` | denial 카운터 증가 / 리셋 / 한도 체크 (max 3 연속, 20 총) | 9832-9834 |
| `_z3` | denial 한도 초과 시 prompt fallback 메시지 빌드 | 15407 |
| `_oH` | denial tracking 을 localDenialTracking 또는 appState 에 기록 | 15406 |
| `Hz3` | headless(`shouldAvoidPermissionPrompts`) 시 `PermissionRequest` 훅으로 위임 | 15405 |
| `p4H` | `PermissionRequest` 훅 러너 | 18823 |
| `c63` / `d63` | decisionReason → telemetry source 매핑 | 13862 / 13861 |
| `Q96` | `tool_decision` 텔레메트리 발행 + `toolDecisions` 맵 기록 | 10494 |
| `Es7` | 대화형 prompt UI 의 decision context 빌더 (`logDecision`, `persistPermissions`, `runHooks`, `handleUserAllow`, ...) | 14121 |
| `h47` / `E47` | auto-mode classifier 승인 캐싱 (toolUseID → reason) | 9864 / 9865 |
| `S47` / `fwH` | classifier "checking" 진행 표시 add/remove | 9866 / 9867 |
| `cM_` / `py` / `T_H` | auto-mode 게이트 체크 (Statsig, 모델 지원, 사용자 동의) | 15449-15453 |

---

## 1. 호출 그래프

```
Bq3 (turn loop)
└── Hj_ → y05/v05 → _j_ → r63 → a63 (single-tool full pipeline)
                                  │
                                  ├── inputSchema.safeParse / validateInput / wo7 (bash misuse)
                                  ├── dA6  (PreToolUse 훅 — hookPermissionResult / hookUpdatedInput / defer / stop)
                                  ├── QA6(hookResult, tool, input, ctx, AM, assistantMsg, toolUseID)   ◀ 결정 진입점
                                  │   ├── hookResult.behavior === "deny"   → 그대로 deny
                                  │   ├── hookResult 없음/기타            → AM(tool, input, ctx, msg, toolUseID)
                                  │   ├── hookResult.behavior === "allow"
                                  │   │   ├─ requiresUserInteraction & !updatedInput, 또는 ctx.requireCanUseTool
                                  │   │   │  → AM 호출 (훅 allow 무시)
                                  │   │   ├─ kJH(rule) deny/ask 발견      → deny 또는 AM(reprompt)
                                  │   │   └─ 그 외                          → 훅 allow 채택 (prompt 우회)
                                  │   └── hookResult.behavior === "ask"   → AM 호출 (훅 결과를 hint 로 전달)
                                  │
                                  ├── ctx.onPermissionDenial?.(tool, toolUseID, input)   ◀ deny 시
                                  ├── decision.behavior === "allow"  →  H.call(...)  →  FA6 (PostToolUse)
                                  └── decision.behavior !== "allow"  →  tool_result_error 메시지
                                      └─ decisionReason.type === "classifier" && classifier === "auto-mode"
                                         └─ FX_(...)  ◀ PermissionDenied 훅, retry 신호면 meta 메시지 추가

AM (= 기본 canUseTool, `_j` 모듈 export)
├── qz3(tool, input, ctx)                                 ◀ rule + tool.checkPermissions
│   ├── pX_ → alwaysDenyRules                             → {behavior:"deny", reason:{type:"rule"}}
│   ├── EC8 → alwaysAskRules                              → {behavior:"ask"}  (sandbox 예외)
│   ├── tool.checkPermissions(...)                        → allow/ask/deny passthrough
│   ├── mcpInfo.effectiveMaxPermission === "ask"          → {behavior:"ask", reason: org_ask_ceiling}
│   ├── mode === "bypassPermissions" || (plan & bypassAvailable)
│   │   └─ ask 가 dangerous rm 류가 아니면 → {behavior:"allow", reason:{type:"mode"}}
│   ├── tqK → alwaysAllowRules                            → {behavior:"allow", reason:{type:"rule"}}
│   └── (default) passthrough → {behavior:"ask"}
│
├── result.behavior === "allow"
│   └── (mode==="auto" && localDenialTracking.consecutiveDenials > 0)
│       → Zw_ (consecutiveDenials = 0)
│
└── result.behavior === "ask"
    ├── mode === "dontAsk"                                → deny  (reason:{type:"mode", mode:"dontAsk"})
    ├── mode === "auto"  ||  (mode === "plan" && isAutoModeActive)
    │   ├── safetyCheck / askRule / sandboxOverride / orgAskCeiling / planModeFloor 중 하나
    │   │   ├─ shouldAvoidPermissionPrompts            → asyncAgent deny
    │   │   └─ 아니면 fallback-to-ask (telemetry)
    │   ├── tool.requiresUserInteraction()              → fallback-to-ask
    │   ├── fastpath: tool.checkPermissions(...acceptEdits ctx) === "allow"
    │   │   → allow  (fastPath="acceptEdits", confidence="high")
    │   ├── fastpath: isAutoModeAllowlistedTool(name)
    │   │   → allow  (fastPath="allowlist", confidence="high")
    │   └── vM_(...) classifier 호출   ◀ 별도 LLM
    │       ├── X.shouldBlock === false            → allow {reason:{type:"classifier", classifier:"auto-mode", reason}}
    │       ├── X.shouldBlock & X.unavailable
    │       │   ├─ gate `tengu_iron_gate_closed`   → fail-closed deny
    │       │   └─ 그 외                            → fail-open fallback-to-ask
    │       ├── X.shouldBlock & X.transcriptTooLong → Agent 도구면 allow, 아니면 fallback-to-ask
    │       └── X.shouldBlock (true block)
    │           ├─ P47 (denial 카운터 ++)
    │           ├─ _z3 → 한도 초과(maxConsecutive=3 or maxTotal=20)면 prompt fallback
    │           └─ 그 외                            → deny {classifier:"auto-mode", reason}
    └── shouldAvoidPermissionPrompts (headless agent)
        └── Hz3 → p4H (PermissionRequest 훅) → allow/deny/fallback asyncAgent-deny
```

`canUseTool` (5번째 인자 `O`) 는 `runTurnLoop` 의 외부 호출자가 결정한다:

- **CLI main loop**: `iI({...,canUseTool: <대화형 prompt wrapper>})` — `Es7` 가 빌드한 객체로 `handleUserAllow`/`handleHookAllow` 분기 후 내부적으로 `resolvePermissionDecision` 류 로직 사용. (확인 — `Es7`/`Q96` 가 prompt 후 `decisionClassification` 분류)
- **Headless / hook-agent**: `iI({...,canUseTool: AM})` (18773 라인 — Agent stop hook 의 mini-loop, 이후 라인에 `canUseTool:AM` 등장)
- **MCP server**: `Y.call($??{}, w, AM, hf({content:[]}))` (19172)

---

## 2. 핵심 로직 (의사코드)

### 2.1 `decidePermission` — 결정 오케스트레이터

```js
// 인자: H = hookPermissionResult (PreToolUse 가 미리 분류한 것; optional)
//      _ = tool, q = input, K = toolUseContext, O = canUseTool (=AM),
//      T = assistantMessage, $ = toolUseID
async function QA6(H, _, q, K, O, T, $) {
  const requiresUI = _.requiresUserInteraction?.();
  const requireCanUseTool = K.requireCanUseTool;

  // case 1: 훅이 명시적 deny — 즉시 반영
  if (H?.behavior === "deny") return { decision: H, input: q };

  // case 2: 훅 결과가 없거나 allow/ask 가 아님 — canUseTool 로 위임
  if (H?.behavior !== "allow" && H?.behavior !== "ask") {
    return { decision: await O(_, q, K, T, $), input: q };
  }

  const behavior = H.behavior;
  const input = H.updatedInput ?? q;
  const hookSatisfiedUserInteraction = requiresUI && H.updatedInput !== undefined;

  // case 3: 훅이 allow 했지만 user-interaction 필수도구이거나 canUseTool 강제
  if (behavior === "allow" && (requiresUI && !hookSatisfiedUserInteraction || requireCanUseTool)) {
    return { decision: await O(_, input, K, T, $), input };
  }

  // case 4: 훅의 allow/ask 결과를 rule(deny/ask) 가 override 하는지 체크
  const ruleResult = await kJH(_, input, K);
  if (ruleResult?.behavior === "deny") {
    // deny rule 이 훅 결정을 무효화
    return { decision: ruleResult, input };
  }
  if (ruleResult?.behavior === "ask") {
    // ask rule 또는 안전 체크 → 전체 파이프라인 (AM) 호출
    return { decision: await O(_, input, K, T, $), input };
  }

  // case 5: 훅 allow 채택 — prompt 우회
  if (behavior === "allow") return { decision: H, input };

  // case 6: 훅이 ask 였음 — AM 호출하되 훅 hint(H)를 전달
  return { decision: await O(_, input, K, T, $, H), input };
}
```

핵심 포인트:

- 훅이 `allow` 라도 **deny 룰이 있으면 deny 가 이긴다** — 안전 우선.
- 훅이 `allow` 라도 **ask 룰**이면 전체 prompt 파이프라인을 거친다.
- `updatedInput` 은 권한 평가 시점부터 적용되며, 평가 후 `_.call()` 까지 그대로 전달된다.

### 2.2 `resolvePermissionDecision` — 기본 `canUseTool` (rule + mode + classifier)

```js
const AM = async (tool, input, ctx, assistantMsg, toolUseID) => {
  // 1차: deny 룰 → ask 룰 → tool.checkPermissions → mcp ceiling → bypass mode → allow 룰
  const T = await qz3(tool, input, ctx);

  if (T.behavior === "allow") {
    // auto 모드에서 연속 denial 카운터 리셋
    if (ctx.getToolPermissionContext().mode === "auto"
        && denialTracking?.consecutiveDenials > 0) {
      _oH(ctx, Zw_(denialTracking));
    }
    return T;
  }

  if (T.behavior === "ask") {
    const ctxPerm = ctx.getToolPermissionContext();

    // dontAsk: ask 결과는 모두 deny 로 강등
    if (ctxPerm.mode === "dontAsk") {
      return { behavior:"deny", decisionReason:{ type:"mode", mode:"dontAsk" }, message: ... };
    }

    // auto 또는 plan&autoActive: classifier 진입
    if (ctxPerm.mode === "auto" || (ctxPerm.mode === "plan" && isAutoModeActive())) {
      // classifier 가 처리 불가한 케이스 → fallback
      const unclassifiable = gQ(T.decisionReason, r => !r.classifierApprovable)
                           || T.decisionReason?.type === "sandboxOverride"
                           || DJ6(T.decisionReason)          // ask 룰
                           || tool.mcpInfo?.effectiveMaxPermission === "ask"
                           || H9K(T.decisionReason);          // plan mode floor

      if (unclassifiable) {
        if (ctxPerm.shouldAvoidPermissionPrompts)
          return { behavior:"deny", decisionReason:{ type:"asyncAgent", ... } };
        return T;  // user prompt 로
      }

      if (tool.requiresUserInteraction?.() && T.behavior === "ask") return T;

      // fastpath 1: acceptEdits 모드 가정으로 checkPermissions 재평가
      try {
        const fakeCtx = { ...ctx,
          getToolPermissionContext: () => ({ ...ctx.getToolPermissionContext(), mode:"acceptEdits" })
        };
        const fp = await tool.checkPermissions(parsedInput, fakeCtx);
        if (fp.behavior === "allow") {
          return { behavior:"allow", updatedInput: fp.updatedInput ?? input,
                   decisionReason:{ type:"mode", mode:"auto" } };
        }
      } catch (e) { /* fastpath_error 텔레메트리 */ }

      // fastpath 2: 안전 도구 allowlist
      if (isAutoModeAllowlistedTool(tool.name)) {
        return { behavior:"allow", updatedInput: input,
                 decisionReason:{ type:"mode", mode:"auto" } };
      }

      // classifier 본 호출 — vM_(messages, fakeAssistantToolUse, tools, ctx, signal)
      S47(setClassifierApprovals, toolUseID);  // "checking" 표시 (UI 스피너)
      let X;
      try {
        X = await vM_(ctx.messages, hR8(tool.name, input), ctx.options.tools, ctx.getToolPermissionContext(), ctx.abortController.signal);
      } finally {
        fwH(setClassifierApprovals, toolUseID);
      }
      // tengu_auto_mode_decision 텔레메트리 발행

      if (X.shouldBlock) {
        if (X.transcriptTooLong) {
          if (tool.name === Agent) return { behavior:"allow", ... };
          if (ctxPerm.shouldAvoidPermissionPrompts) throw AbortError;
          return { ...T, decisionReason:{ type:"other", reason:"Auto mode classifier transcript exceeded ..." } };
        }
        if (X.unavailable) {
          if (statsig("tengu_iron_gate_closed"))         // fail-closed
            return { behavior:"deny", decisionReason:{ type:"classifier", classifier:"auto-mode", reason:"Classifier unavailable" }, ... };
          return T;                                       // fail-open
        }
        const incremented = P47(denialTracking);          // ++consecutive, ++total
        _oH(ctx, incremented);
        const limitHit = _z3(incremented, X.reason, assistantMsg, tool, T, ctx);
        if (limitHit) return limitHit;                    // → prompt fallback
        return { behavior:"deny", decisionReason:{ type:"classifier", classifier:"auto-mode", reason: X.reason }, ... };
      }
      // classifier 통과
      _oH(ctx, Zw_(denialTracking));
      return { behavior:"allow", updatedInput: input,
               decisionReason:{ type:"classifier", classifier:"auto-mode", reason: X.reason } };
    }

    // auto 모드가 아닌데 headless면 PermissionRequest 훅으로 위임
    if (ctxPerm.shouldAvoidPermissionPrompts) {
      const hooked = await Hz3(tool, input, toolUseID, ctx, ctxPerm.mode, T.suggestions);
      if (hooked) return hooked;
      return { behavior:"deny", decisionReason:{ type:"asyncAgent", ... } };
    }
  }
  return T;   // 대화형 prompt UI 가 처리할 ask
};
```

### 2.3 `runPermissionDeniedHook` — PermissionDenied 훅 (retry 신호)

```js
async function* FX_(toolName, toolUseID, input, reason, ctx, mode, signal, timeoutMs = x5) {
  if (!hasHookFor("PermissionDenied", ctx.getAppState(), ctx.agentId)) return;
  const hookInput = {
    ...createBaseHookInput(mode, undefined, ctx),
    hook_event_name: "PermissionDenied",
    tool_name: toolName,
    tool_input: input,
    tool_use_id: toolUseID,
    reason
  };
  yield* T2({ hookInput, toolUseID, matchQuery: toolName, signal, timeoutMs, toolUseContext: ctx });
}
```

`executeToolPipeline` 안에서 deny 직후 호출되며, **반환값 중 `retry: true`** 가 하나라도 있으면 결과 메시지 뒤에 다음 meta 가 붙는다:

```
"The PermissionDenied hook indicated you may retry this tool call."
```

이는 LLM 에게 같은 도구를 다시 시도해도 좋다는 신호다. **단, classifier deny 일 때만 호출된다** (`executeToolPipeline`: `if (S.decisionReason?.type === "classifier" && S.decisionReason.classifier === "auto-mode")`). 룰 deny 나 훅 deny 에서는 호출되지 않는다 — 추정컨대 retry 가능한 시그널은 "이번 turn 의 분류기 판단 실수일 수 있음" 에 한정.

### 2.4 PermissionRequest 훅 vs PermissionDenied 훅 — 트리거 시점

| 훅 | 호출 위치 | 목적 |
|---|---|---|
| `PreToolUse` (`runPreToolUseHooks`) | `executeToolPipeline` 진입 직후, 입력 validation 후 | 입력 변환 / 차단 / 권한 사전판단 (`hookPermissionResult`) |
| `PermissionRequest` (`p4H`) | `resolvePermissionDecision` 내부, `Hz3` (headless) 또는 `Es7.runHooks` (대화형 prompt 직전) | 사용자 prompt 대신/전에 외부 시스템이 결정 |
| `PermissionDenied` (`runPermissionDeniedHook`) | `executeToolPipeline` 내, deny 결정 후 (단 `classifier=auto-mode` 일 때만) | 분류기 deny 를 외부에서 재량으로 retry 가능하게 |
| `PostToolUse` (`runPostToolUseHooks`) | `H.call` 성공 직후 | 결과 후처리 / 변형 |

---

## 3. State / Schema

### 3.1 Permission decision Zod schema (`permissionDecisionSchema`)

`extracted-functions.js` line 9615 메가블롭 내부에서:

```js
V6z = y.union([
  y.object({
    behavior: y.literal("allow"),
    updatedInput: y.record(y.string(), y.unknown()).optional(),
    updatedPermissions: y.array(lY_).optional(),       // 룰 업데이트 배열
    toolUseID: y.string().optional(),
    decisionClassification: b77.optional()             // "user_temporary"/"user_permanent"/"user_reject"
  }),
  y.object({
    behavior: y.literal("deny"),
    message: y.string(),
    interrupt: y.boolean().optional(),
    toolUseID: y.string().optional(),
    decisionClassification: b77.optional()
  })
]);
```

내부 표현(`resolvePermissionDecision` 등이 반환하는 객체)은 위 union 외에 `decisionReason`, `userModified`, `acceptFeedback`, `contentBlocks`, `suggestions` 도 갖는다. `permissionDecisionSchema` 는 SDK 외부 경계(`canUseTool`/`PermissionRequest` 훅 결과)에서 받는 모양.

### 3.2 `decisionClassification` — `decisionClassificationEnum` enum

```js
b77 = y.enum(["user_temporary", "user_permanent", "user_reject"])
  .describe(
    "Classification of this permission decision for telemetry. SDK hosts that prompt users " +
    "(desktop apps, IDEs) should set this to reflect what actually happened: " +
    "user_temporary for allow-once, " +
    "user_permanent for always-allow (both the click and later cache hits), " +
    "user_reject for deny. " +
    "If unset, the CLI infers conservatively (temporary for allow, reject for deny). " +
    "The vocabulary matches tool_decision OTel events (monitoring-usage docs)."
  );
```

**언제 어떤 값이 쓰이는가** (`c63`/`d63` 가 결정 — line 13861-13862):

| decisionReason.type | behavior | source 결과 (텔레메트리) |
|---|---|---|
| `permissionPromptTool` | allow | `toolResult.decisionClassification` 또는 `user_temporary` |
| `permissionPromptTool` | deny | `toolResult.decisionClassification` 또는 `user_reject` |
| `rule` (`source: session`) | allow | `user_temporary` |
| `rule` (`source: session`) | deny | `user_reject` |
| `rule` (`source: localSettings` / `userSettings`) | allow | `user_permanent` |
| `rule` (`source: localSettings` / `userSettings`) | deny | `user_reject` |
| `rule` (그 외 source) | any | `config` |
| `hook` | any | `hook` |
| `mode` / `classifier` / `subcommandResults` / `asyncAgent` / `sandboxOverride` / `workingDir` / `safetyCheck` / `other` | any | `config` |
| 없음 | any | `config` |

즉 `user_temporary` 는 "이번 세션만" / `user_permanent` 는 "settings 에 영속 저장" / `user_reject` 는 거부 — 외부 host (SDK) 가 명시 안 하면 CLI 가 보수적으로 추정.

### 3.3 Permission mode enum (`permissionModeEnum`)

```js
_KH = y.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"])
  .describe(
    "Permission mode for controlling how tool executions are handled. " +
    "'default' - Standard behavior, prompts for dangerous operations. " +
    "'acceptEdits' - Auto-accept file edit operations. " +
    "'bypassPermissions' - Bypass all permission checks (requires allowDangerouslySkipPermissions). " +
    "'plan' - Planning mode, no actual tool execution. " +
    "'dontAsk' - Don't prompt for permissions, deny if not pre-approved. " +
    "'auto' - Use a model classifier to approve/deny permission prompts."
  );
```

| Mode | 동작 시맨틱 (확인) |
|---|---|
| `default` | rule 평가 → `tool.checkPermissions` → ask 면 사용자 prompt |
| `acceptEdits` | `tool.checkPermissions` 가 edit 도구에 한해 allow 반환 (도구별 로직). prompt 안 함 |
| `bypassPermissions` | `qz3` 안에서 ask 결과를 곧장 `{behavior:"allow", reason:{type:"mode"}}` 로 승급 (단, dangerous rm/rmdir 류 safetyCheck 는 여전히 ask). `isBypassPermissionsModeAvailable` 필요 (`FT` 의 `setMode` 가드) |
| `plan` | tool 실행 차단(execution 차단 도구만 허용), `H9K(reason)` 로 plan-mode-floor 표식. plan + autoMode-active 면 classifier 동작 |
| `dontAsk` | `resolvePermissionDecision` 에서 `T.behavior==="ask"` 면 즉시 deny `{type:"mode", mode:"dontAsk"}`. allow 룰은 그대로 동작 → "pre-approved 가 아니면 거부" 의미 |
| `auto` | LLM classifier 가 prompt 대신 결정 (자세한 건 §3.5) |

`requiresUserInteraction()` 을 반환하는 도구(예: PermissionPromptTool 자체)는 `auto` 모드라도 classifier 우회 → fallback-to-ask.

### 3.4 Rule shape — `vJ8`, `NJ8`, `$QH`, `lY_`

```js
$QH = y.enum(["userSettings", "projectSettings", "localSettings", "session", "cliArg"]);
NJ8 = y.enum(["allow", "deny", "ask"]);
hz5 = y.enum(["allow", "deny", "ask", "defer"]);   // PreToolUse 훅 전용 ("defer" 포함)
vJ8 = y.object({
  toolName: y.string(),
  ruleContent: y.string().optional()        // ex: "Read(/path/**)" → ruleContent="/path/**"
});
lY_ = y.discriminatedUnion("type", [
  y.object({ type:"addRules",        rules: y.array(vJ8), behavior: NJ8, destination: $QH }),
  y.object({ type:"replaceRules",    rules: y.array(vJ8), behavior: NJ8, destination: $QH }),
  y.object({ type:"removeRules",     rules: y.array(vJ8), behavior: NJ8, destination: $QH }),
  y.object({ type:"setMode",         mode: _KH,                          destination: $QH }),
  y.object({ type:"addDirectories",  directories: y.array(y.string()),   destination: $QH }),
  y.object({ type:"removeDirectories", directories: y.array(y.string()), destination: $QH }),
]);
```

`toolPermissionContext` 형상 (`FT` 와 `H1H`/`gNH`/`FNH` 로 역추론):

```ts
type ToolPermissionContext = {
  mode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
  prePlanMode?: ...;
  alwaysAllowRules: Record<source, Rule[]>;
  alwaysDenyRules:  Record<source, Rule[]>;
  alwaysAskRules:   Record<source, Rule[]>;
  additionalWorkingDirectories: Map<string, { path, source }>;
  toolAliases: Record<string, string>;
  isBypassPermissionsModeAvailable: boolean;
  isAutoModeAvailable: boolean;
  shouldAvoidPermissionPrompts: boolean;       // headless agent 표시
  strippedDangerousRules?: ...;
  // ...
};
```

source 우선순위 (`JJ8` array): `policySettings` (FM) ... `cliArg` → `command` → `session` → `toolsNarrowing` (line 15421 `JJ6 = [...FM, "cliArg","command","session","toolsNarrowing"]`).

룰 매칭은 `hC8` (line 15394): `ruleContent` 가 없을 때만 toolName 단순 매치 + alias 확장 + MCP server-wildcard (`server*` 형태). `ruleContent` 가 있으면 도구가 `checkPermissions` 내부에서 자체 비교 (Bash 는 명령어 prefix, Read 는 path glob).

### 3.5 Auto-mode classifier (`runAutoModeClassifier`)

별도 LLM 호출이다 (메인 모델과 분리). 입력:

- `messages` — 현재 대화 transcript
- `hR8(toolName, input)` — 가짜 assistant message: `{ role:"assistant", content:[{ type:"tool_use", name, input }] }`
- `ctx.options.tools` — 현재 가용 도구 목록 (system prompt 에 포함)
- `ctx.getToolPermissionContext()` — 모드/룰
- `signal`

모델 선택은 `HC7()` — 별도의 lightweight classifier 모델 (정확한 모델 식별자는 `runAutoModeClassifier` 안에서 `HC7()` 호출로 결정됨, 확인 필요). 비용 텔레메트리에 `classifierModel`, `classifierCostUSD`, `classifierStage1/Stage2` 가 따로 기록되며 stage 분리 호출 가능 (`X.stage`, `X.stage1Usage`, `X.stage2Usage`) — 추정컨대 thinking + tool_use 의 2-stage.

응답은 `ZQ5` (이름 `NM_`) 라는 단일 도구를 `tool_choice` 로 강제하여 `{thinking, shouldBlock, reason}` 의 구조화 출력을 받음. `shouldBlock=true` 면 deny.

Classifier 입력에 포함되는 도구별 입력 attribute (확인 — `JC7`/`jC7`/`hR8` 가 추출):

- `file_path` (Read/Edit/Write/NotebookEdit)
- `command`, `bash_command` (Bash, `BashOutput`)
- `skill_name` (`mq8`)
- `subagent_type` (`pq8`)
- 그 외 도구 input 전체 — `_simulatedSedEdit` 같은 내부 hint 는 stripped

캐싱: `cache_control` 가 transcript 메시지에 ttl 로 붙어 메인루프와 별개로 classifier 캐시 hit 유도 — 동일 세션에서 반복 분류 시 cache_read 우세 (텔레메트리 `classifierCacheReadInputTokens`).

상태머신:

```
shouldBlock=false → allow {classifier:"auto-mode"}
shouldBlock=true & transcriptTooLong & tool=Agent → allow (안전 우회)
shouldBlock=true & transcriptTooLong & 그 외     → ask (사용자에게 위임, "Try /compact")
shouldBlock=true & unavailable                    → ironGate 게이트 따라 deny 또는 ask
shouldBlock=true (genuine)
  ├── P47 ++denials  → _z3 한도(3 연속 / 20 총) 초과 시 prompt fallback
  └── 그 외 → deny {classifier:"auto-mode", reason}
```

**Auto-mode classifier approval 캐시** (`h47` / `E47` line 9864-9865): toolUseID → reason 매핑을 `appState.classifierApprovals.approvals: Map` 에 보관. 같은 toolUseID 가 다시 평가될 때 재사용 가능. `S47`/`fwH` 는 진행중 표시 (`checking: Set`) 로 UI 스피너용. 컴팩션 후 (`sn`) `I47` 로 전체 클리어.

### 3.6 localDenialTracking (`localDenialTracker`)

```js
function nq6() { return { consecutiveDenials: 0, totalDenials: 0 }; }
```

- 위치: `ctx.localDenialTracking` (subagent / hook-agent 등 격리된 context) 또는 `appState.denialTracking` (메인).
- 갱신: `P47` 증가 / `Zw_` 연속만 리셋 / 초과 시 `_z3` 가 prompt fallback 메시지 생성.
- 한도 (`lq6`): `{ maxConsecutive: 3, maxTotal: 20 }` (line 9834).
- 한도 초과 시 메시지: "3 consecutive actions were blocked" 또는 "20 actions were blocked this session. Please review the transcript before continuing."
- 한도 초과 + headless (`shouldAvoidPermissionPrompts`) → `PO` (PermissionAborted) 예외로 agent 강제 종료.

### 3.7 `updatedInput` — 권한 결정이 입력을 재작성

`{behavior:"allow", updatedInput: {...}}` 또는 `{behavior:"deny", ...}` 양쪽 다 가능. `executeToolPipeline`:

```js
let { decision: S, input: X } = await QA6(L, H, X, K, O, T, _);
// ...
if (S.updatedInput !== undefined) X = S.updatedInput;
// ...
await H.call(P, { ...K, toolUseId:_, userModified: S.userModified ?? false }, ...);
```

`updatedInput` 의 원천:

1. **PreToolUse 훅**: `hookUpdatedInput` (별도 stream type) — `executeToolPipeline` 의 for-await 안에서 누적된 후 `decidePermission` 의 `q` 로 들어감. 훅 결과의 `updatedInput` 은 `decidePermission` 안에서 `H.updatedInput ?? q` 로 다시 채택.
2. **`tool.checkPermissions`** (즉 `qz3` 안에서): `aqK(T, input)` 가 `T.updatedInput ?? input` 반환.
3. **`PermissionRequest` 훅**: `permissionRequestResult.updatedInput`. `Hz3` 와 `Es7.runHooks` 모두 처리.
4. **사용자 prompt UI**: 사용자가 edit-tool 입력을 수정한 경우. `handleUserAllow` 가 `H.inputsEquivalent` 로 비교해 `userModified: true` 표시.
5. **고아 permission resume** (`ij7`): 세션 재개 시 deferred permission 결과의 `updatedInput` 적용.

실제 활용 사례 (도구별 자체 normalize): Bash 의 `_simulatedSedEdit` 분리, MCP 도구의 cwd 정규화, dangerous flag 제거 등 (추정 — 도구 구현 검토 필요).

### 3.8 `updatedPermissions` — 룰을 즉시 추가/영속화

사용자가 prompt UI 에서 "Always allow X" 클릭하거나 SDK 호스트가 결정 시 `{behavior:"allow", updatedPermissions: [...]}` 반환. 처리 흐름 (`Es7.persistPermissions`, line 14121, `Hz3` line 15405, `wHO` line 20547, `ij7` line 10733 모두 동일 패턴):

```js
JI(updatedPermissions);                                // 디스크 영속화 ($t 가 settings.json 에 기록)
ctx.setToolPermissionContext(W => WV(W, updatedPermissions));   // 인메모리 컨텍스트 머지
```

- `persistPermissionRules` (line 7350): `for (let _ of H) $t(_)` — 각 update 를 `$t` 로 디스크 기록 (`N38` 체크로 `localSettings`/`userSettings`/`projectSettings` 만 영속화; `session`/`cliArg` 는 메모리만).
- `$t` (line 7349): `setMode` 는 `defaultMode` 키, rule 들은 `permissions.allow`/`.deny`/`.ask` 에 머지/교체/제거.
- `mergePermissionRules` (line 7347): `H.reduce(FT)` — 순차 적용.
- `FT` (line 7346): 단일 update reducer.

`bypassPermissions` mode 는 session-scoped — `$t` 가 명시적으로 `defaultMode` 로 영속화하지 않음 (`"setMode:'bypassPermissions' is session-scoped"` 로그).

### 3.9 `onPermissionDenial` 콜백

`ctx.onPermissionDenial?.(tool, toolUseID, input)` — `executeToolPipeline` 에서 결정이 allow 가 아니면 호출. 설치 위치는 `forkToolUseContext` (ToolUseContext builder, line 9845) 이 ctx 를 상속할 때 보존되며, 실제 outer 콜백은 메인 query entry 또는 subagent 진입 함수에서 주입된다 (확인 필요 — 콜백 자체 식별자는 발견 안 됨, 추정컨대 SDK `query()` 옵션 또는 UI 가 prompt 거부 시 cleanup 용).

`toolDecisions: Map<toolUseID, { source, decision, timestamp }>` — `Q96` (line 10494) 가 prompt 처리 시 기록. `executeToolPipeline` 가 후속에 `K.toolDecisions?.get(_)` 로 텔레메트리 `decision_source`/`decision_type` 부착.

---

## 4. 텔레메트리 이벤트

| 이벤트 | 발행 시점 |
|---|---|
| `tool_decision` (`Y1`) | `executeToolPipeline` 결정 직후 (ask 아닌 경우, `toolDecisions` 에 없을 때) — `{decision: accept/reject, source, tool_name, tool_use_id}` |
| `tengu_tool_use_can_use_tool_allowed` | `executeToolPipeline` allow 분기 |
| `tengu_tool_use_can_use_tool_rejected` | `executeToolPipeline` deny 분기 |
| `tengu_auto_mode_decision` | `resolvePermissionDecision` classifier 호출 후 — `{decision, classifierModel, classifier{Stage1/2}{Input/Output/CacheRead/CacheCreation}Tokens, classifierDurationMs, classifierStage, classifierFailureMode, consecutiveDenials, totalDenials, ...}` |
| `tengu_auto_mode_fallback_to_ask` | classifier 우회 시 reason 와 함께 — `safety_check / ask_rule / plan_mode_floor / org_ask_ceiling / requires_user_interaction / transcript_too_long / classifier_unavailable_fail_open` |
| `tengu_auto_mode_denial_limit_exceeded` | `_z3` 한도 초과 |

`auto-mode` advisor 모델 가능성: **advisor 는 권한 결정에 관여하지 않는다** (확인). `advisorModel` 은 `runTurnLoop` 의 `callModel` 옵션 (line 14057 부근 `advisorModel: zH.advisorModel`) 으로 전달되는 메인 루프 보조 모델일 뿐, classifier (`runAutoModeClassifier` 가 `HC7()` 로 자체 모델 선택) 와 무관. `advisor_tool_result` 는 MCP-integration 영역 (확인은 mcp-integration.md 참조).

---

## 5. PreToolUse 훅과의 통합

`executeToolPipeline` 의 PreToolUse 단계 (`runPreToolUseHooks` 결과) 가 `decidePermission` 의 `H` 인자(`hookPermissionResult`) 로 들어간다. 훅이 반환하는 `permissionDecision`:

| `permissionDecision` | `decidePermission` 처리 |
|---|---|
| 미설정 | `H` 가 `undefined` → AM 호출 |
| `"allow"` | 훅 allow 채택 (단 deny rule / ask rule / requiresUserInteraction / requireCanUseTool 우선) |
| `"deny"` | 즉시 deny, AM 우회 |
| `"ask"` | AM 호출 (훅을 hint 로 전달, 6번째 인자) |
| `"defer"` | print-mode 만 허용, batch 에 1개일 때만 — `executeToolPipeline` 가 `hook_deferred_tool` attachment 발행하고 turn 중단 (resume 시 `localDenialTracker` 가 재실행) |

훅의 `hookUpdatedInput` 은 `executeToolPipeline` 가 별도 stream type 으로 누적해서 `X` 변수를 업데이트 → `decidePermission` 에 `q=X` 로 전달.

---

## 6. 차이점 (v0.2.8 대비)

| 항목 | v0.2.8 | v2.1.143 |
|---|---|---|
| 결정 함수 | `checkPermissionsAndCallTool` 인라인 (도구 실행과 한 함수) | `decidePermission` 외부 분리 + `resolvePermissionDecision` 별도 |
| Permission mode | 4종 (`default`, `acceptEdits`, `bypassPermissions`, `plan`) | 6종 (+`dontAsk`, +`auto`) |
| LLM classifier | 없음 | `auto` 모드 + `runAutoModeClassifier` (별도 모델, 2-stage 가능, 캐싱) |
| Denial tracking | 없음 | `localDenialTracking` / `appState.denialTracking` + `_z3` 한도 fallback (3 연속 / 20 총) |
| Hook 통합 | 없음 | PreToolUse 의 `hookPermissionResult` 를 `decidePermission` 가 정책과 머지 |
| PermissionRequest 훅 | 없음 | 대화형 prompt 직전 호출, 외부에서 결정/입력변경/룰추가 가능 |
| PermissionDenied 훅 | 없음 | `auto-mode` classifier deny 후에만 호출, `retry` 신호 가능 |
| `updatedPermissions` | 사용자 prompt UI 의 "always allow" 만 | 훅 / SDK canUseTool / fallback 경로 모두 발행 가능, `persistPermissionRules` 가 영속화 |
| `decisionClassification` | 없음 (텔레메트리 vocabulary 없음) | OTel `tool_decision` 와 동일한 `user_temporary` / `user_permanent` / `user_reject` |
| Decision reason 구조 | 단순 문자열 | discriminated union (`rule` / `mode` / `hook` / `classifier` / `safetyCheck` / `subcommandResults` / `sandboxOverride` / `workingDir` / `asyncAgent` / `permissionPromptTool` / `other`) |
| Headless 동작 | 없음 (REPL 전제) | `shouldAvoidPermissionPrompts` 분기 — `Hz3` 가 `PermissionRequest` 훅으로 위임, 실패 시 `asyncAgent` deny |
| Approval 캐시 | 없음 | `appState.classifierApprovals.approvals: Map<toolUseID, {classifier, reason}>` + `checking: Set` (UI 스피너) |
| `requireCanUseTool` flag | 없음 | `ctx.requireCanUseTool` 면 훅 allow 도 SDK canUseTool 강제 통과 |

---

## 7. 미확인 / 추정

- `onPermissionDenial` 콜백의 설치 위치 — `ctx` 에 존재하지만 진입점이 보이지 않음. SDK `query({ onPermissionDenial })` 또는 UI prompt cleanup 으로 추정.
- `runAutoModeClassifier` 의 정확한 모델 ID — `HC7()` 가 반환 (lazy init); 본 분석에서는 어떤 모델인지 미확인 (별도 lightweight classifier 추정).
- `requireCanUseTool` 의 origin — `K.requireCanUseTool` 로 접근, 확인되는 setter 없음. SDK 외부에서 주입하는 옵션 추정.
- `isAutoModeAllowlistedTool` 의 allowlist 내용 — `t$3.isAutoModeAllowlistedTool` (모듈 `oqK`/`rqK`), 실제 도구 목록은 확인 필요.
- `effectiveMaxPermission==="ask"` (MCP) 의 의미 — MCP 서버가 조직 정책으로 강제 ask ceiling 을 걸 수 있음을 시사. `sqK = "Your organization requires approval for this tool"`.
