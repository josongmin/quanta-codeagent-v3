# Agent loop ↔ permission flow (live `runTurnLoop` integration)

이 문서는 [permission-system.md](permission-system.md) (정적 결정 로직)·[tool-execution.md](tool-execution.md)·[streaming-tool-execution.md](streaming-tool-execution.md) 를 **턴 루프 `runTurnLoop` 의 실제 호출 체인 관점**에서 다시 꿰맞춘다. "모델이 `tool_use` 를 emit" → "도구가 실행되거나 거부됨" 까지의 end-to-end 흐름을, 비-스트림 경로(`dispatchToolBatch`)·스트림 경로(`StreamingToolExecutor`)·대화형 prompt 경로·6 모드별 동작·hook 타이밍·deny/ask 시 루프 효과 순서로 추적한다.

모든 라인/바이트는 `extracted-functions.js` 기준 (확인).

---

## 1. 호출 그래프 — 권한 결정의 정확한 경로

### 1.1 진입: `runTurnLoop` 가 `tool_use` 를 받는 두 경로

`runTurnLoop` 진입 시그니처 (확인, byte 10127079 / line 14057):

```
async function*Bq3(H,_){let{...,canUseTool:T,...}=H, ... }
```

`T` = caller 가 주입한 `canUseTool`. 스트리밍 컨테이너 생성 (확인, byte 10130873):

```
let TH = X.gates.streamingToolExecution ? new gX_(Z.options.tools, T, Z) : null
```

- `Z` = `toolUseContext`, `T` = `canUseTool`.
- gate ON → `StreamingToolExecutor` 인스턴스 `TH`. gate OFF → `TH=null`.

스트림 루프 동안 (확인, agent-loop.md §2 와 일치):
- `ev.type==="assistant"` 에서 `tool_use` 블록마다 `TH.addTool(toolUse, ev)` (스트림 경로, 즉시 디스패치 시작).
- 매 스트림 이벤트 직후 `for (r of TH.getCompletedResults()) yield r.message`.

스트림 종료 후 (확인, byte 10142235):

```
let gH = TH ? TH.getRemainingResults() : Hj_(_H, wH, T, Z);
for await (let T_ of gH){ if(dm(T_)){yield T_;continue} if(T_.message){ yield T_.message; ... JH.push(...userResults) } if(T_.newContext) dH={...T_.newContext,queryTracking:p} }
```

- `_H` = 누적 tool_use 블록, `wH` = 누적 assistant 메시지, `T` = canUseTool, `Z` = ctx.
- gate ON 이면 스트림 중 시작된 도구의 **남은 결과**만 `getRemainingResults()` 로 await.
- gate OFF 이면 스트림 종료 후 `Hj_(_H, wH, T, Z)` 로 일괄 batch.

### 1.2 공통 leaf 체인 (두 경로 모두 동일)

```
Bq3
├─ (stream)  gX_.addTool(toolUse, asstMsg)
│            └─ gX_.processQueue → gX_.executeTool
│                 └─ _j_(block, asstMsg, canUseTool=T, {...Z, abortController: child})
└─ (non-stream) Hj_(_H, wH, T, Z)
                 └─ N05 배쳐 → y05(concurrent) | v05(serial)
                      └─ _j_(block, asstMsg, canUseTool=T, ctx)

_j_ (byte 10031836 인근, line 13866)
 ├─ eK(...)                         도구 lookup (alias)
 ├─ cA6(tool, ctx)                  isolation latch (line 13612, byte 9876713)
 │   └─ denyMessage 있으면 → <tool_use_error> 합성 후 return (a63 진입 안 함)
 └─ r63(...)  (line 13871)          progress 큐 어댑터 (Pn)
      └─ a63(...) (line 13875, byte 10039xxx)   single-tool full pipeline
          ├─ inputSchema.safeParse → 실패 시 InputValidationError return (ABORT)
          ├─ validateInput? → false 시 return (ABORT)
          ├─ wo7 (Bash 오용 사전 체크, non-blocking; cqK.set)
          ├─ backfillObservableInput
          ├─ dA6 (PreToolUse hooks, line 13604, byte 9871xxx)
          │   └─ yield: message | hookPermissionResult | hookUpdatedInput
          │             | preventContinuation | stopReason | additionalContext
          │             | defer | stop
          ├─ C = ctx.getToolPermissionContext().mode      ← 권한 직전 mode 스냅샷
          ├─ m = Date.now()
          ├─ p = await QA6(L, H, X, K, O, T, _)            ← 권한 결정 진입
          │       L=hookPermissionResult  H=tool  X=input  K=ctx
          │       O=canUseTool(=T)  T=asstMsg  _=toolUseID
          │   └─ S = p.decision ;  X = p.input
          ├─ x = Date.now()-m
          ├─ if (x>=Ty8 && C==="auto")  N("Slow permission decision: ...")
          ├─ if (S.behavior!=="allow") K.onPermissionDenial?.(H,_,X)
          ├─ if (S.behavior!=="ask" && !K.toolDecisions?.has(_))
          │       Y1("tool_decision",{decision, source:c63(...), tool_name, tool_use_id})
          ├─ [deny/ask 분기] → tool_result(is_error:true) + FX_ (classifier deny 만)
          └─ [allow 분기] → tool.call(...) → FA6(PostToolUse) → fH(결과 조립)
```

### 1.3 `decidePermission` 내부 분기 (확인, byte 9871664 / line 13603)

`QA6(H,_,q,K,O,T,$)` — `H=hookPermissionResult, _=tool, q=input, K=ctx, O=canUseTool, T=asstMsg, $=toolUseID`:

| # | 조건 | 동작 |
|---|---|---|
| 1 | `H?.behavior==="deny"` | `N("Hook denied ...")`, `{decision:H, input:q}` — 즉시 deny, `O` 미호출 |
| 2 | `H?.behavior` 가 `allow`/`ask` 둘 다 아님 (undefined 포함) | `{decision: await O(_,q,K,T,$), input:q}` — canUseTool 위임 |
| 3 | `Y==="allow"` & `(z&&!j \|\| A)` (`z`=requiresUserInteraction, `j`=hook이 updatedInput 으로 충족, `A`=`K.requireCanUseTool`) | `await O(_,w,K,T,$)` — hook allow 무시하고 canUseTool 강제 |
| 4 | `kJH(_,w,K)?.behavior==="deny"` | rule deny 가 hook 결정 override → `{decision: ruleResult, input:w}` |
| 5 | `kJH(...)?.behavior==="ask"` | ask rule/safety → `await O(_,w,K,T,$)` (전체 파이프라인) |
| 6 | `Y==="allow"` (위 다 통과) | `{decision:H, input:w}` — hook allow 채택, **prompt 우회** |
| 7 | (`Y==="ask"`) | `{decision: await O(_,w,K,T,$,H), input:w}` — hook 을 6번째 인자 hint 로 전달 |

`O` (= `canUseTool`) 가 caller 별로 다름:
- **CLI REPL main**: `Mr3` 가 만든 클로저 (byte 13551766, line 20021). 내부에서 `resolvePermissionDecision` 호출 후 `behavior==="ask"` 면 `is7`/`aUK`/`rUK` 로 대화형 dialog.
- **Subagent / teammate**: `j93` (byte 10199347, line 14154) — `resolvePermissionDecision` 후 ask 면 `requestDialog` 또는 `Rq6`/`Nq6` request-id 기반 승인.
- **Headless / hook-agent**: `resolvePermissionDecision` 직접 (permission-system.md §1 확인).

### 1.4 `resolvePermissionDecision` (기본 canUseTool, byte 10782886 / line 15421)

```
AM = async (H,_,q,K,O) => {                     // H=tool _=input q=ctx K=asstMsg O=toolUseID
  T = await qz3(H,_,q)                            // 1차: rule + checkPermissions + bypass
  if (T.behavior==="allow") { ...auto 모드 연속denial 리셋(Zw_)... ; return T }
  if (T.behavior==="ask") {
    z = q.getToolPermissionContext()
    if (z.mode==="dontAsk") return {behavior:"deny", decisionReason:{type:"mode",mode:"dontAsk"}, message:O9K(H.name)}
    if (z.mode==="auto" || (z.mode==="plan" && e$3?.isAutoModeActive())) {
      ...unclassifiable 분기 / fastpath / vM_ classifier...   // §6
    }
    A = q.getToolPermissionContext()
    if (A.shouldAvoidPermissionPrompts) {                     // §5
      Y = await Hz3(...)  ;  return Y ?? {behavior:"deny", decisionReason:{type:"asyncAgent"}, ...}
    }
  }
  return T                                        // ask → 대화형 prompt UI 가 처리
}
```

`qz3` (byte 10779661 / line 15414) 1차 평가 순서 (확인):
`pX_`(alwaysDeny rule) → `EC8`(alwaysAsk rule, sandbox Bash 예외) → `tool.checkPermissions(input,ctx)` → deny passthrough / requiresUserInteraction+ask passthrough / ask-rule(`DJ6`) passthrough → MCP `effectiveMaxPermission==="ask"` → **bypass gate** (`z = mode==="bypassPermissions" || (mode==="plan" && isBypassPermissionsModeAvailable)`) → `tqK`(alwaysAllow rule) → 최종 passthrough→ask.

---

## 2. 모드별 동작 표

`executeToolPipeline` 는 권한 직전 `C = K.getToolPermissionContext().mode` 를 스냅샷. 결정은 전부 `qz3` 1차 → `resolvePermissionDecision` 2차에서 갈린다. 각 도구의 `checkPermissions(parsedInput, ctx)` 가 1차 `qz3` 안에서 호출되어 `allow`/`ask`/`deny`/`passthrough` 중 하나를 반환 — 모드 처리는 그 결과를 가공한다.

| mode | interactive prompt 트리거 | silent-allow | silent-deny | `checkPermissions` 의 역할 |
|---|---|---|---|---|
| `default` | `qz3` 가 최종 `ask` (rule ask, safetyCheck, checkPerm ask, MCP ceiling, passthrough→ask) → `resolvePermissionDecision` 이 `T` 그대로 반환 → REPL `Mr3` 가 `is7` 로 dialog | `qz3` 가 `allow` 반환 (checkPerm allow / alwaysAllow rule) | `qz3` 가 `deny` (alwaysDeny rule, checkPerm deny) | 도구별 핵심 게이트. allow/ask/deny 직접 결정. ask 면 prompt |
| `acceptEdits` | edit 도구가 `checkPermissions` 에서 ask 를 반환할 때만 (도구가 acceptEdits 를 안 보는 경우). 그 외 default 와 동일 | Edit/Write/NotebookEdit 등이 `ctx.mode==="acceptEdits"` 를 보고 자체적으로 `allow` 반환 | default 와 동일 (deny rule) | **도구가 모드를 직접 읽음**. acceptEdits 일 때 edit 류가 allow 를 자가 반환하는 게 핵심 (`executeToolPipeline` 자체엔 acceptEdits 분기 없음) |
| `bypassPermissions` | `qz3` 의 `A` 가드: ask 의 decisionReason 이 `Dangerous rm operation`/`Dangerous rmdir operation` safetyCheck 면 **여전히 ask** (prompt) | 그 외 모든 `ask` → `{behavior:"allow", updatedInput:aqK(T,_), decisionReason:{type:"mode", mode:"bypassPermissions"}}` (확인). `allow`/`deny` 는 그대로 | alwaysDeny rule 은 그대로 deny | 결과가 ask 여도 대부분 allow 로 승급. **`isBypassPermissionsModeAvailable` 필요** (§12) |
| `plan` | plan 자체는 도구 필터가 아님 — 실행 차단 도구가 `checkPermissions` 에서 `ask`(plan-mode-floor `H9K`) 반환 → prompt. `plan & isBypassPermissionsModeAvailable` 면 bypass 처럼 동작 | plan 모드가 허용한 도구(Read 등)는 checkPerm allow | — | plan 모드 floor 표식(`H9K(decisionReason)`)은 classifier 우회 + ask 로 surfacing. plan+autoActive 면 §6 classifier |
| `dontAsk` | **없음** | `qz3`=allow (alwaysAllow rule, checkPerm allow) → pre-approved 통과 | `resolvePermissionDecision` 에서 `T.behavior==="ask"` 면 즉시 `{behavior:"deny", decisionReason:{type:"mode",mode:"dontAsk"}, message:O9K(name)}` — "pre-approved 아니면 deny" | checkPerm 가 allow 면 통과, ask 면 deny 로 강등됨 |
| `auto` | classifier 가 `unavailable`+fail-open, `transcriptTooLong`(Agent 외), denial 한도 초과 → fallback-to-ask → REPL prompt | classifier `shouldBlock===false`, 또는 fastpath(acceptEdits 가정 allow / allowlist) | classifier `shouldBlock===true`(genuine), `unavailable`+iron-gate, `shouldAvoidPermissionPrompts`+unclassifiable | checkPerm ask 가 classifier 진입 트리거. ask 가 아니면(allow/deny) classifier 미호출 — `qz3` 결과 그대로 |

핵심: **모드는 `checkPermissions` 결과를 받아 가공할 뿐, 도구의 `checkPermissions` 가 1차 게이트.** `acceptEdits` 는 `executeToolPipeline`/`resolvePermissionDecision` 에 분기가 없고 *도구가* `ctx.getToolPermissionContext().mode` 를 읽어 allow 를 자가 반환하는 패턴이다 (확인 — `resolvePermissionDecision` 의 auto-mode fastpath 가 `getToolPermissionContext: ()=>({...,mode:"acceptEdits"})` 로 가짜 ctx 를 만들어 `checkPermissions` 를 재호출하는 코드가 그 증거, byte 10782886 인근).

---

## 3. 대화형 prompt 메커니즘 — 루프 suspension

### 3.1 prompt 은 yield 이벤트가 아니다 (확인)

권한 prompt 는 `runTurnLoop` 가 yield 하는 이벤트가 **아니다**. 별도 pub/sub 채널(`requestDialog`) 로 디스패치되는 React UI 다. 흐름:

```
Bq3 → _j_ → r63 → a63
   └─ p = await QA6(L,H,X,K,O,T,_)         ← 여기서 await 가 걸려 멈춤
        └─ O = canUseTool = Mr3 클로저
             └─ f = new Promise(X => {
                   AM(...).then(W => {
                     if (W.behavior==="allow") X(buildAllow(...))      // prompt 없이 resolve
                     else switch(W.behavior){
                       case "ask": is7({ctx,...}, X)                   // ← dialog 띄움
                     }})})
             return f                        ← 이 Promise 가 pending 인 동안 a63 정지
```

`is7` (byte 10192246 / line 14144) → `OrH` (line 14145~14151). `OrH` 의 `S()`:

```
function S(){ ...
  D(q.dialog, descriptor, {signal})            // D = K.toolUseContext.requestDialog
    .then(l => { if(claim()) x(l) }) }
```

`requestDialog` (REPL: `G9 = useMemo(()=>pl9(oK.current))`, byte 14019323):

```
pl9(H) → async function(q,K,O){ ... return l65(H,q,K,O) }
l65(H,_,q,K){ let {replied:z} = H.request({kind,payload},K); T = await z; ... }
nFK().request({kind,payload},opts){
  ... H.emit({id, kind, payload})              // ← 채널에 dialog 요청 발행
  return {id, replied:Y /*Ca() promise*/, update}
}
```

즉:
1. `executeToolPipeline` 가 `await QA6(...)` 에서 멈춤 (확인).
2. `decidePermission`→`canUseTool`(`Mr3`)→`resolvePermissionDecision`→ask→`is7`→`OrH`→`S()`→`requestDialog`→`nFK.request` 가 `H.emit({id,kind,payload})` 로 dialog 요청을 채널에 발행.
3. 채널 구독자(REPL 렌더러) 가 permission dialog 컴포넌트를 **렌더**.
4. `nFK.request` 가 돌려준 `replied` Promise 는 사용자가 클릭해 `reply()` 가 불릴 때까지 pending.
5. `replied` resolve → `l65` 의 `await z` 풀림 → `OrH.x(l)` 가 결정 객체로 `X(...)`(=`Y`) resolve → `Mr3` 의 `f` Promise resolve → `decidePermission` 의 `await O(...)` 풀림 → `executeToolPipeline` 재개.

### 3.2 모델 스트림은 멈추는가

스트림 자체는 **이미 끝난 상태**에서 도구 batch 가 도는 게 비-스트림 경로(`dispatchToolBatch`)다 — 모델 스트림과 권한 대기가 동시에 일어나지 않는다.

스트림 경로(`StreamingToolExecutor`)에서는 도구가 스트림 진행 중 시작된다. 이때 한 도구가 `await QA6(...)` 에서 prompt 대기하더라도:
- 그 도구의 `runSingleTool` 호출은 `gX_.executeTool` 안의 독립 IIFE Promise (`H.promise`) — **다른 concurrency-safe 도구는 그 사이 병렬 진행** (확인, streaming-tool-execution.md §2.5).
- 모델 텍스트 스트림(`callModel` for-await)은 별개 async 흐름이라 prompt 대기와 무관하게 계속 yield 됨.
- 단, 스트림이 끝나면 `getRemainingResults()` 가 prompt-pending 도구의 promise 를 `Promise.race` 로 await — 이 시점에 루프는 사용자 응답을 기다리며 자연 정지.

권한 prompt UI 는 `runTurnLoop` 의 yield 프로토콜과 **무관한 별도 채널**이라, agent-loop.md §4 yield 타입 표에 "permission request" 가 없는 게 정상 (확인). yield 되는 건 dialog 결과가 나온 *후*의 `tool_result` (allow→실제 결과, deny/ask→`is_error:true`) 뿐이다.

---

## 4. 스트리밍 도구 실행 + 권한 상호작용

streaming-tool-execution.md §3.7 의 "`runSingleTool` 재사용 (full permission semantics 보존)" 주장을 교차검증 — **확인됨**.

`gX_.executeTool` (byte 10050xxx 인근) 의 핵심:

```
let z = _j_(H.block, H.assistantMessage, this.canUseTool, {...this.toolUseContext, abortController: $})
for await (let Y of z) { ... }
```

- `this.canUseTool` = `runTurnLoop` 가 `new gX_(Z.options.tools, T, Z)` 로 넘긴 `T` (확인).
- ctx 는 `{...toolUseContext, abortController: child}` — **`requestDialog`/`getToolPermissionContext`/`shouldAvoidPermissionPrompts` 전부 그대로 spread 됨**. 즉 PreToolUse hook → `decidePermission` → `resolvePermissionDecision` → classifier/대화형 prompt → `runPermissionDeniedHook` 가 비-스트림과 1:1 동일하게 돈다. 빠른 경로 없음.
- prompt 필요 도구가 스트림 중 디스패치되면 그 도구의 `runSingleTool` 가 `await QA6` 에서 멈춤 → `H.promise` 가 pending → `getCompletedResults()` 는 그 도구를 건너뜀(`status` 가 `completed` 가 아님). **다른 concurrency-safe 도구는 계속 진행** (확인). "pre-approved-only in stream mode" 같은 제약은 **없다** — full 권한 시맨틱 보존.
- model fallback(`FallbackTriggeredError`)/streaming fallback 시 `TH.discard()` → 새 `StreamingToolExecutor`. `discard()` 는 `discarded=true` 만 세팅하므로 prompt-pending 중인 `runSingleTool` 는 다음 `getAbortReason` 검사에서 `"streaming_fallback"` 합성 에러로 종료 (in-flight 권한 prompt 는 명시적으로 닫지 않음 — `OrH` 의 abort 리스너가 ctx.abortController 경유로만 닫힘; 추정).

---

## 5. `shouldAvoidPermissionPrompts` (subagent / headless)

tool-use-context.md 대로 서브에이전트/headless ctx 는 `shouldAvoidPermissionPrompts=true`. `resolvePermissionDecision` 안에서 두 군데가 이를 처리 (확인, byte 10782886 인근):

(a) **auto 모드 + unclassifiable** (safety_check / ask_rule / org_ask_ceiling / plan_mode_floor / sandboxOverride):

```
if (Y||w||j||J||D) {
  if (z.shouldAvoidPermissionPrompts)
    return {behavior:"deny", message:T.message,
            decisionReason:{type:"asyncAgent",
              reason:"Action requires interactive approval and permission prompts are not available in this context"}}
  if (Y||j||J||D) return d("tengu_auto_mode_fallback_to_ask",{...}), T   // 비-headless 만 prompt
}
```

→ headless 면 **deny** (`type:"asyncAgent"`). prompt 로 못 빠짐.

(b) **ask 인데 auto 모드 아님** (default/acceptEdits/plan 등에서 ask):

```
A = q.getToolPermissionContext()
if (A.shouldAvoidPermissionPrompts) {
  Y = await Hz3(H,_,O,q,A.mode,T.suggestions)      // PermissionRequest hook 위임
  if (Y) return Y
  return {behavior:"deny", decisionReason:{type:"asyncAgent",
            reason:"Permission prompts are not available in this context"},
          message:K9K(H.name)}
}
```

→ `Hz3` (byte 10776348 / line 15405) 가 `p4H` (PermissionRequest hook) 를 돌려서:
- hook `allow` → updatedInput 재검증(`kJH`) 통과 시 `{behavior:"allow", decisionReason:{type:"hook",hookName:"PermissionRequest"}}`. `updatedPermissions` 있으면 `persistPermissionRules` + `setToolPermissionContext(WV(...))`.
- hook `deny` → `{behavior:"deny", ...}` (interrupt 면 `abortController.abort()`).
- hook 결과 없음 → `Hz3` 가 `null` → `resolvePermissionDecision` 이 **`asyncAgent` deny** 로 fallback.

추가: auto 모드 classifier `transcriptTooLong` 이면서 headless → `throw new PO("Agent aborted: auto mode classifier transcript exceeded context window in headless mode")` (도구 아님, agent 강제 종료). denial 한도 초과 + headless → `_z3` 가 `throw new PO("Agent aborted: too many classifier denials in headless mode")` (확인, byte 10777540).

요약: **headless 에서 QA6 는 prompt 대신 (1) PermissionRequest hook 위임, (2) `asyncAgent` deny, (3) 한도/transcript 초과 시 `PO` 예외로 agent abort** — auto-allow read-only 같은 동작은 없다 (단, auto 모드의 fastpath allowlist/acceptEdits 가정은 headless 와 무관하게 먼저 적용됨).

---

## 6. auto-mode classifier `runAutoModeClassifier` — 루프 내 위치와 latency

### 6.1 어디서 도는가

`runAutoModeClassifier` (byte 9141435 / line 12391) 는 **별도 LLM 호출** (`querySource:"auto_mode"`, `tool_choice:{type:"tool", name:NM_}`, tools:`[ZQ5]`, 확인). 호출 위치는 `resolvePermissionDecision` 안 → `decidePermission` 안 → `executeToolPipeline` 안:

```
a63: m=Date.now(); p=await QA6(L,H,X,K,O,T,_); x=Date.now()-m
       └─ QA6 → O(=canUseTool) → AM → (ask & mode=auto) → vM_(...)  ← 여기
```

즉 classifier 는 **a63 의 권한 세그먼트 안에서 동기적으로 blocking** — 그 도구의 `tool.call()` 은 classifier 가 끝날 때까지 시작 안 된다. classifier 가 도는 동안:
- `S47(q.setClassifierApprovals, O)` 로 "checking" 표시(UI 스피너) on, `finally` 에서 `fwH(...)` 로 off (확인, byte 10785541).
- 스트림 경로면 다른 concurrency-safe 도구는 병렬 진행 가능 (classifier 도 결국 그 도구의 독립 promise 안).

### 6.2 latency 경고

`executeToolPipeline` (byte 10039xxx, line 13875):

```
let x=Date.now()-m;
if (x>=Ty8 && C==="auto")
  N(`Slow permission decision: ${x}ms for ${H.name} (mode=${C}, behavior=${S.behavior})`,{level:"info"})
```

- `Ty8=2000` (확인, byte 10050565). `C` = 권한 직전 mode 스냅샷.
- **mode 가 `auto` 일 때만** 이 경고 — classifier LLM 호출이 2초 넘으면. 즉 "Slow permission decision" 는 사실상 `runAutoModeClassifier` latency 경고. `permissionDurationMs:x` 는 `tengu_tool_use_success` 에도 들어감 (확인).
- `[Stall] tool_dispatch_start ... permissionDecisionMs=${x}` 로그도 별도로 찍힘 (확인).

### 6.3 2-stage classifier

`tengu_auto_mode_decision` 텔레메트리에 `classifierStage`, `classifierStage1*`/`classifierStage2*` (Input/Output/CacheRead/CacheCreation Tokens, DurationMs, RequestId, MsgId, CostUSD) 가 별도로 기록됨 (확인, byte 10783xxx). `runAutoModeClassifier` 본문은 `uQ5()` 게이트면 `bQ5(...)` (2-stage 경로), 아니면 단일 호출(`stage:"tool_use"`). stage1 = thinking/policy, stage2 = tool_use 구조화 출력 (추정 — 텔레메트리 필드 모양으로 역추론).

### 6.4 denial 한도 fallback (정확한 상수)

```
nq6()  = {consecutiveDenials:0, totalDenials:0}                 (byte 6557954, line 9831)
P47(H) = {...H, consecutiveDenials:+1, totalDenials:+1}         (line 9832)
Zw_(H) = consecutiveDenials===0 ? H : {...H, consecutiveDenials:0}  (line 9833, 연속만 리셋)
W47(H) = H.consecutiveDenials>=3 || H.totalDenials>=20          (line 9834)
lq6    = {maxConsecutive:3, maxTotal:20}                        (line 9834, yD8 init — 확인)
```

classifier genuine block 시 (확인, `resolvePermissionDecision` 본문):

```
let G=P47(M); _oH(q,G); N("Auto mode classifier blocked action: ...",{level:"warn"})
let L=_z3(G,X.reason,K,H,T,q)            // 한도 체크
if (L) return L                          // 한도 초과 → prompt fallback (return O=T ask)
return {behavior:"deny", decisionReason:{type:"classifier",classifier:"auto-mode",reason:X.reason}, message:T9K(X.reason)}
```

`_z3` (byte 10777540 / line 15407):
- `!W47(H)` 면 `null` (한도 미달 → 그냥 deny).
- 한도 초과: `tengu_auto_mode_denial_limit_exceeded` 발행 (`{limit: total?"total":"consecutive", mode: headless?"headless":"cli", consecutiveDenials, totalDenials, toolName}`).
- headless(`shouldAvoidPermissionPrompts`) → `throw new PO("Agent aborted: too many classifier denials in headless mode")`.
- total 초과 시 카운터 리셋(`_oH(T,{...H,totalDenials:0,consecutiveDenials:0})`).
- 반환: `{...O, decisionReason:{type:"classifier",classifier:j,reason:\`${w}\nLatest blocked action: ${_}\`}}` — `O` 는 원래 `T`(ask) 라 prompt 로 surfacing (cli 일 때).

관련 텔레메트리(확인): `tengu_auto_mode_decision`(allowed/blocked/unavailable/fastpath_error/parse_failure/interrupted), `tengu_auto_mode_fallback_to_ask`(safety_check/ask_rule/plan_mode_floor/org_ask_ceiling/requires_user_interaction/transcript_too_long/classifier_unavailable_fail_open), `tengu_auto_mode_denial_limit_exceeded`, `tengu_auto_mode_subsequent_approval`(deny 후 같은 도구 나중에 allow 된 경우 — `Mr3` 에서 `recordDenial`/`removeDenial`).

unavailable 처리: `xR("tengu_iron_gate_closed",...)` true → fail-closed deny (`{type:"classifier",reason:"Classifier unavailable"}`), false → fail-open `tengu_auto_mode_fallback_to_ask{reason:"classifier_unavailable_fail_open"}` 후 `T` 반환(prompt).

---

## 7. `PermissionRequest` / `PermissionDenied` hook 타이밍

| hook | 러너 | 발생 위치 | "전에" vs "대신" |
|---|---|---|---|
| `PreToolUse` | `runPreToolUseHooks` (line 13604) | `executeToolPipeline` 입력검증 후, `decidePermission` 전 | hook 결과(`hookPermissionResult`)가 `decidePermission` 의 `H` 인자로 들어가 정책과 머지 |
| `PermissionRequest` | `p4H` (line 18823) | `resolvePermissionDecision` 내부 — headless 면 `Hz3`, 대화형이면 `Mr3`→`Es7.runHooks` 가 **dialog 띄우기 직전** | prompt **전에** 호출. hook 이 allow/deny 면 prompt 를 **대신**함 (외부 시스템이 결정). hook 결과 없으면 prompt 진행(또는 headless 면 asyncAgent deny) |
| `PermissionDenied` | `runPermissionDeniedHook` (line 18822) | `executeToolPipeline` 의 deny 분기 안, **단 `decisionReason.type==="classifier" && classifier==="auto-mode"` 일 때만** | deny **후** 호출. retry 신호 수신용 |
| `PostToolUse` | `runPostToolUseHooks` (line 13600) | `executeToolPipeline` 의 `tool.call` 성공 직후 | — |

`runPermissionDeniedHook` (byte 12832856 / line 18822):

```
async function*FX_(H,_,q,K,O,T,$,z=x5){
  if(!JS("PermissionDenied", O.getAppState(), O.agentId??k_())) return;     // hook 없으면 no-op
  w = {...T5(T,void 0,O), hook_event_name:"PermissionDenied",
       tool_name:H, tool_input:q, tool_use_id:_, reason:K}
  yield* T2({hookInput:w, toolUseID:_, matchQuery:H, signal:$, timeoutMs:z, toolUseContext:O})
}
```

`executeToolPipeline` 의 deny 분기에서 (확인, byte 10039xxx):

```
if (S.decisionReason?.type==="classifier" && S.decisionReason.classifier==="auto-mode") {
  let wH=!1
  for await (let JH of FX_(H.name,_,X,S.decisionReason.reason??"Permission denied",K,C,K.abortController.signal))
    if (JH.retry) wH=!0
  if (wH) f.push({message: D6({content:"The PermissionDenied hook indicated you may retry this tool call.", isMeta:!0})})
}
return f
```

→ classifier-auto-mode deny 일 때만 `runPermissionDeniedHook` 호출. hook 이 `retry:true` 를 하나라도 반환하면 `is_error:true` tool_result 뒤에 **isMeta 메시지** 추가. 이게 `runTurnLoop` 로 yield 되어 `JH`(collectedToolResults)·`x`(다음 턴 messages)에 들어가므로, **다음 턴에 모델이 그 meta 를 보고 재시도 가능**하다고 인지. rule deny / hook deny 에는 `runPermissionDeniedHook` 안 불림 — retry 가능 신호는 "분류기 판단 실수 가능성" 에만 한정.

`p4H` (byte 12833170 / line 18823): `hook_event_name:"PermissionRequest"`, payload 에 `tool_name, tool_input, permission_suggestions`. `dialog` 이 뜨기 전(`is7` 호출 전, `Es7.runHooks` 가 먼저)에 실행 — `runHooks` 가 hook allow/deny 면 `handleHookAllow`/`buildDeny` 로 prompt 우회.

---

## 8. Deny → 루프 효과 (continue, terminate 아님 — 확인)

`executeToolPipeline` deny 분기 (byte 10039xxx, line 13875):

```
if (S.behavior!=="allow") {
  N(`${H.name} tool permission denied`)
  GD8("reject", toolDecisions?.get(_)?.source||"unknown")        // OTEL tool_blocked_on_user close
  d("tengu_tool_use_can_use_tool_rejected", {messageID, toolName, ...})
  let e = S.message
  if (W && !e) e = `Execution stopped by PreToolUse hook${G?`: ${G}`:""}`
  let HH = [{type:"tool_result", content:e, is_error:!0, tool_use_id:_}]
  let o = S.behavior==="ask" ? S.contentBlocks : void 0           // §9
  if (o?.length) HH.push(...o)
  ...imagePasteIds...
  f.push({message: D6({content:HH, imagePasteIds:s, toolUseResult:`Error: ${e}`, sourceToolAssistantUUID:T.uuid})})
  if (classifier auto-mode) { ...FX_ retry... }                  // §7
  return f
}
```

이 `f` 배열(= `out`)이 `wrapToolWithProgressQueue`→`StreamingToolExecutor`/`dispatchToolBatch`→`runTurnLoop` 로 흘러 `T_.message` 로 yield 됨. `runTurnLoop` 는:

```
for await (let T_ of gH){
  ... yield T_.message
  if (!_P_(T_.message)) JH.push(...userResults)        // 다음 턴 messages 누적
}
... D = {messages:[...x, ...wH, ...JH], ..., transition:{reason:"next_turn"}}
// continue (while 자연 순환)
```

→ deny tool_result(`is_error:true`, `<tool_use_error>`-스타일 content)가 `JH` 에 들어가 다음 턴 `D.messages` 에 포함됨. 루프는 **종료하지 않고 다음 턴으로 continue**, 모델은 거부를 보고 적응(다른 접근/사과 후 진행 등). 종료(`return`)는 deny 자체로는 일어나지 않는다 — hook `stop`/`preventContinuation`/`defer` 나 abort 같은 별개 신호에서만 (agent-loop.md §2 return 표).

`ctx.onPermissionDenial?.(H,_,X)` 는 deny 결정 직후(behavior !== "allow") 호출되는 **부수효과 콜백** (확인, `executeToolPipeline`: `if(S.behavior!=="allow")K.onPermissionDenial?.(H,_,X)`). 결정엔 영향 없고, caller(SDK/UI)가 거부를 관찰하는 hook (예: prompt UI cleanup, SDK `query()` 옵션). 설치 위치는 `forkToolUseContext` 가 ctx 상속 시 보존 (확인, byte 9878709).

---

## 9. `ask` 결정 — deny 와 구분

`ask` decision 은 deny 와 다르게 `contentBlocks` 를 첨부할 수 있다. `executeToolPipeline` deny 분기 안:

```
let o = S.behavior==="ask" ? S.contentBlocks : void 0
if (o?.length) HH.push(...o)
```

→ behavior `ask` 면 `S.contentBlocks` (예: 이미지 — 사용자가 prompt 에서 거부하며 붙인 피드백/스크린샷) 를 tool_result content 에 추가. 이미지 있으면 `Ao7(K.messages)` 로 imagePasteIds 할당.

중요: REPL 에서 사용자가 dialog 의 **deny 버튼**을 누르면 `OrH.x(F)` 의 `case "deny"` 가 `Y(K.cancelAndAbort(F.feedback,void 0,F.contentBlocks))` 를 호출하고, `Es7.cancelAndAbort` 는 **`{behavior:"ask", message:D, contentBlocks:w}`** 를 반환한다 (확인, byte 10181027 / line 14121). 즉 *사용자의 거부 클릭은 루프 입장에서 `behavior:"deny"` 가 아니라 `behavior:"ask"`* — 모델에 "사용자가 거부했고 다음은 이렇게" 식의 피드백+첨부를 전달하는 형태. 진짜 `behavior:"deny"` 는 rule/hook/classifier deny 에서 나온다. 두 경우 모두 `executeToolPipeline` 의 `S.behavior!=="allow"` 분기로 들어가 `is_error:true` tool_result + (ask 면)contentBlocks 가 붙고, 루프는 continue. 모델이 받는 것: tool_result content = 거부 메시지 + (ask 의 경우) 사용자 첨부 블록들.

`OrH.x(F)` 의 `case "deny"` vs `case "cancelled"`: deny 는 `K.cancelAndAbort(F.feedback,...)` (feedback 보존), cancelled(Ctrl+C 등)는 `K.cancelAndAbort(void 0,!0)` (abort 플래그 → `abortController.abort()`).

---

## 10. `updatedInput` / `updatedPermissions` write-back (턴 내 효과)

### 10.1 `updatedInput`

`executeToolPipeline`: `p=await QA6(...); X=p.input; ... if(S.updatedInput!==void 0) X=S.updatedInput;` → 이후 `tool.call(P,...)` 가 갱신된 input 으로 실행 (확인). 원천: PreToolUse hook `hookUpdatedInput`, `tool.checkPermissions` 의 `updatedInput`(`aqK`), PermissionRequest hook, 사용자 prompt 수정(`handleUserAllow` 가 `inputsEquivalent` 비교 후 `userModified`), deferred resume.

### 10.2 `updatedPermissions`

사용자가 "Always allow" 클릭 또는 hook/SDK 가 `updatedPermissions:[...]` 반환 시. 처리 패턴 (확인 — `Es7.persistPermissions` byte 10181027, `Hz3` byte 10776348, `j93` byte 10199347 모두 동일):

```
persistPermissions(A){ if(A.length===0) return !1
  JI(A)                                            // 디스크 영속화 ($t→settings.json)
  T(WV(q.getToolPermissionContext(), A))           // T = setToolPermissionContext, WV=reduce(FT)
  return A.some(Y => N38(Y.destination)) }          // localSettings/userSettings/projectSettings 면 true
```

- `JI(updates)` = `for(_ of H) $t(_)` — `$t` 가 `N38(destination)` 검사로 `local/user/projectSettings` 만 디스크 기록. `session`/`cliArg` 는 메모리만. `bypassPermissions` setMode 는 session-scoped (`$t` 가 defaultMode 로 영속화 안 함).
- `T(WV(...))` = `setToolPermissionContext(W => WV(W, rules))` — **인메모리 ctx 즉시 머지**.

**턴 내 효과**: `setToolPermissionContext` 가 ctx 의 `getToolPermissionContext()` 가 보는 룰을 갱신하므로, **같은 턴의 후속 도구**(serial 이면 즉시, concurrent 묶음이면 그룹 종료 후 contextModifier 일괄 적용 시점)가 새 alwaysAllow 룰을 본다 → 같은 류 도구 재요청 시 `qz3` 의 `tqK`(alwaysAllow) 가 잡아 prompt 우회. `Mr3` 의 deny 추적(`recordDenial`/`removeDenial`)도 같은 세션 내 동일 도구+input 의 후속 allow 를 `tengu_auto_mode_subsequent_approval` 로 텔레메트리.

---

## 11. `toolDecisions` ctx 필드 — 재진입 중복 prompt 방지

`Q96` (byte 7688027 / line 10494):

```
function Q96(H,_,q){ ...
  if(!T.toolDecisions) T.toolDecisions = new Map
  T.toolDecisions.set(z /*toolUseID*/, {source:j, decision:A, timestamp:Date.now()})
  Y1("tool_decision",{decision:A, source:j, tool_name, tool_use_id:z}) }
```

`Q96` 는 대화형 prompt 결정(`Es7.logDecision`)·`Mr3` deny 시 호출 — toolUseID 별 결정을 ctx 의 `toolDecisions` Map 에 캐시.

`executeToolPipeline` 의 활용 (확인):
- `if (S.behavior!=="ask" && !K.toolDecisions?.has(_)) Y1("tool_decision",{...})` — 이미 `toolDecisions` 에 있으면 **중복 텔레메트리 안 찍음** (재진입 = defer/resume 후 같은 toolUseID 재평가 시).
- allow/deny 양쪽에서 `Q = K.toolDecisions?.get(_)` 로 `decision_source`/`decision_type` 를 `tool_result` 로그·`GD8` OTEL 에 부착.
- `executeToolPipeline` `finally`: `if(toolDecisionEntry) ctx.toolDecisions?.delete(id)` (tool-execution.md §2.7 확인) — 도구 완료 후 해당 엔트리 제거(턴 누수 방지).

효과: defer 후 resume(`ij7`)으로 같은 `tool_use_id` 가 다시 `executeToolPipeline` 에 들어와도, 이미 prompt 거쳐 `toolDecisions` 에 결정이 박혀 있으면 텔레메트리·소스 부착만 재사용하고 사용자에게 **다시 묻지 않는다** (재-prompt 는 `canUseTool` 이 캐시된 결정을 재현하거나, `j93`/`Mr3` 의 6번째 인자 `A`(미리 계산된 decision)로 우회 — `Mr3`: `(J!==void 0?Promise.resolve(J):AM(...))`, 확인).

---

## 12. `bypassPermissions` 게이트 / `dontAsk` 정확한 로직

### 12.1 bypass 게이트

`qz3` (확인, byte 10779661 / line 15414):

```
let z = $.mode==="bypassPermissions" || ($.mode==="plan" && $.isBypassPermissionsModeAvailable)
let A = z && T?.behavior==="ask"
        ? gQ(T.decisionReason, j => j.reason.startsWith("Dangerous rm operation")
                                  || j.reason.startsWith("Dangerous rmdir operation"))
        : void 0
if (T?.behavior==="ask" && (A || !z&&(gQ(T.decisionReason)||...sandboxOverride||H9K(...)))) return T
if (z) return {behavior:"allow", updatedInput:aqK(T,_), decisionReason:{type:"mode", mode:$.mode}}
```

- `bypassPermissions` 모드면 ask 결과를 곧장 allow 로 승급. **단 `Dangerous rm/rmdir` safetyCheck ask 는 여전히 prompt(`return T`)**.
- `isBypassPermissionsModeAvailable` 가 게이트 — `pC8` (byte 10797832 / line 15446):

```
let J = Z_("tengu_disable_bypass_permissions_mode", !1)
let M = settings.permissions?.disableBypassPermissionsMode === "disable"
let f = (K==="bypassPermissions" || O /*=allowDangerouslySkipPermissions*/) && !J && !M
... isBypassPermissionsModeAvailable: f ...
```

즉 `bypassPermissions` 모드 또는 `allowDangerouslySkipPermissions=true` 이면서, Statsig `tengu_disable_bypass_permissions_mode` OFF 이고 settings 가 disable 안 했을 때만 `f=true`. `plan` 모드는 `f` 가 true 여야 bypass-처럼 동작. (CLI 진입 시 `dangerouslySkipPermissions` 플래그 → `permissionMode:"bypassPermissions"`, `allowDangerouslySkipPermissions` 로 전달 — 확인, byte 14535642/14513775 인근.)

`setMode` 가드(`FT` reducer, permission-system.md §3.8 확인): bypass 로 전환은 `isBypassPermissionsModeAvailable` 통과 필요, session-scoped(디스크 미영속).

### 12.2 `dontAsk` 정확한 로직

`resolvePermissionDecision` (확인, byte 10783077):

```
if (T.behavior==="ask") {
  let z = q.getToolPermissionContext()
  if (z.mode==="dontAsk")
    return {behavior:"deny", decisionReason:{type:"mode",mode:"dontAsk"}, message:O9K(H.name)}
  ...
```

- `qz3` 1차가 `allow` 면 (alwaysAllow rule 또는 `checkPermissions` allow) → `resolvePermissionDecision` 의 `T.behavior==="allow"` 분기로 그대로 통과 (pre-approved).
- `qz3` 1차가 `ask` 면 (rule ask, safetyCheck, checkPerm ask, passthrough→ask) → `dontAsk` 가 **즉시 `behavior:"deny"`** (`decisionReason:{type:"mode",mode:"dontAsk"}`, message `O9K(name)`).
- `qz3` 1차가 `deny` 면 그대로 deny.

= "pre-approved(allow rule / checkPerm allow) 아니면 deny, 절대 prompt 안 함". deny 이므로 `executeToolPipeline` 의 deny 분기 → tool_result(is_error) → 루프 continue (모델이 거부 인지). classifier(`runPermissionDeniedHook`) 는 안 불림(`type:"mode"` 이지 `type:"classifier"` 아님).

---

## 부록: 핵심 라인 인덱스 (확인)

| id | byte / line | 역할 |
|---|---|---|
| `runTurnLoop` | 10127079 / 14057 | turn loop, `canUseTool:T` 디스트럭처 |
| `new gX_(...)` | 10130873 / 14057 | `X.gates.streamingToolExecution ? new gX_(Z.options.tools,T,Z) : null` |
| tool dispatch | 10142235 / 14057 | `gH = TH?TH.getRemainingResults():Hj_(_H,wH,T,Z)` |
| `decidePermission` | 9871664 / 13603 | 결정 오케스트레이터 (7 분기) |
| `checkIsolationLatch` | 9876713 / 13612 | isolation latch (Qe5 org policy 게이트) |
| `runPreToolUseHooks` | (line 13604) | PreToolUse hooks runner |
| `executeToolPipeline` perm 세그먼트 | 10039xxx / 13875 | `m=Date.now();p=await QA6(...);x=...;Slow 경고;deny/ask 분기;FX_` |
| `slowHookWarnMs` | 10050565 | `=2000` |
| `resolvePermissionDecision` | 10782886 / 15421 | 기본 canUseTool (rule→mode→classifier) |
| `qz3` | 10779661 / 15414 | 1차 평가 + bypass 게이트 |
| `kJH` | 10778764 / 15412 | rule(deny/ask) 평가 (QA6 case 4/5) |
| `_z3` | 10777540 / 15407 | denial 한도 fallback |
| `Hz3` | 10776348 / 15405 | headless PermissionRequest 위임 |
| `_oH` | 10777367 / 15406 | denialTracking write (local vs appState) |
| `localDenialTracker`/`P47`/`Zw_`/`W47`/`lq6` | 6557954~ / 9831-9834 | denial 카운터 (3 연속 / 20 총) |
| `runAutoModeClassifier` | 9141435 / 12391 | auto-mode classifier (별도 LLM) |
| `runPermissionDeniedHook` | 12832856 / 18822 | PermissionDenied hook (retry 신호) |
| `p4H` | 12833170 / 18823 | PermissionRequest hook |
| `Es7` | 10181027 / 14121 | 대화형 decision ctx (cancelAndAbort→behavior:"ask") |
| `Mr3` | 13551766 / 20021 | REPL canUseTool 클로저 (AM→is7) |
| `j93` | 10199347 / 14154 | subagent/teammate canUseTool (requestDialog/Rq6) |
| `is7`/`OrH` | 10192246~ / 14144-14151 | dialog dispatch + 사용자 응답 핸들러 |
| `pl9`/`l65`/`n65`/`requestPermissionDialog` | 5911024~ / 8265-8270, 13596328/20101 | requestDialog 채널 (`H.request`→`replied` await) |
| `Q96` | 7688027 / 10494 | toolDecisions Map 기록 + tool_decision 텔레메트리 |
| `pC8` | 10797832 / 15446 | toolPermissionContext init (`isBypassPermissionsModeAvailable:f`) |

## 미확인 / 추정

- `discard()` 시 prompt-pending 중인 `runSingleTool` 의 in-flight dialog 가 명시적으로 닫히는지 — `OrH` 의 abort 리스너가 `ctx.abortController` 경유로만 닫히므로, `discarded` 플래그만으로는 dialog 가 화면에 남을 수 있음 (추정).
- `runAutoModeClassifier` 2-stage 분리 트리거(`uQ5()` 게이트)의 정확한 stage 의미 — 텔레메트리 필드(Stage1/Stage2)로 thinking+tool_use 2단계 추론 (추정).
- `onPermissionDenial` 의 실제 주입 진입점 — `forkToolUseContext` 가 보존만 함, SDK `query()` 옵션/UI cleanup 추정 (permission-system.md §7 와 동일 결론).
- classifier 모델 ID — `HC7()` lazy init, 별도 lightweight 모델 (미확인).
