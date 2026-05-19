# Streaming Tool Execution — `StreamingToolExecutor`

v2.1.143 신규. Statsig 게이트 `streamingToolExecution`이 켜져 있으면, 모델이
어시스턴트 응답을 **아직 다 스트리밍하지 않은 상태에서** 먼저 도착한
`tool_use` 블록을 즉시 실행한다. 텍스트 출력이 끝나기 전 도구가 끝나거나,
적어도 동시에 진행될 수 있어 turn 전체 지연이 줄어든다.

- 클래스 정의: `extracted-functions.js:13877` (`class gX_{...}`)
- Bq3 사용처: `extracted-functions.js:14057` 내부
  - 생성: `let TH = X.gates.streamingToolExecution ? new gX_(Z.options.tools, T, Z) : null`
  - `TH.addTool(toolUse, assistantMsg)` — 어시스턴트 스트림에서 `tool_use`가 보일 때마다
  - `TH.getCompletedResults()` — 매 스트림 이벤트 직후 완료된 것만 동기 yield
  - `TH.getRemainingResults()` — 스트림 종료 후 남은 도구 await
  - `TH.discard()` — streaming fallback / model fallback 시 호출

## 1. 호출 그래프

```
Bq3 (turn loop)
└── if (X.gates.streamingToolExecution)
    └── TH = new gX_(tools, canUseTool, toolUseContext)
        # 어시스턴트 스트림 루프
        for await (J_ of callModel(...)) {
            # 1) 모델이 yield한 이벤트는 그대로 caller(transcript/UI)로 통과
            yield b_
            # 2) tool_use 블록이 보이면 즉시 큐에 넣음
            if (J_.type === "assistant") {
                for (tool_use block u_ in J_.message.content)
                    TH.addTool(u_, J_)            # ── 비동기 실행 시작
            }
            # 3) 매 이벤트 직후 완료된 도구 결과를 동기 드레인
            for (l_ of TH.getCompletedResults())
                yield l_.message                  # tool_result + progress + bridge
        }
        # 스트림 종료 후
        if (TH)
            d("tengu_streaming_tool_execution_used", { tool_count })
        else
            d("tengu_streaming_tool_execution_not_used", { tool_count })

        # 4) 남은 결과 await — gate ON이면 TH.getRemainingResults(),
        #    OFF면 기존 Hj_ batch runner로 fallback
        gH = TH ? TH.getRemainingResults() : Hj_(_H, wH, T, Z)
        for await (T_ of gH) yield T_.message

# 스트리밍 실패 / 모델 fallback 경로
catch (ANH) {                                     # 모델 high-demand fallback
    for (G_ of wH) yield { type:"tombstone", message: G_ }
    TH.discard()
    TH = new gX_(...)                             # 새 인스턴스
}
onStreamingFallback = () => { H_ = true }         # 동일 turn 내 중도 폴백 신호
if (H_) {
    for (l_ of wH) yield { type:"tombstone", message: l_ }
    d("tengu_orphaned_messages_tombstoned", { orphanedMessageCount, ... })
    TH.discard(); TH = new gX_(...)
}
```

도구 한 개당 내부적으로는 결국 기존 단일-도구 파이프라인 `runSingleTool` (line 13866)를
그대로 호출한다 — 따라서 **PreToolUse hook, permission, isolation latch,
backfill, contextModifier 등은 모두 동일하게 적용된다 (확인)**. 단,
`AbortController`만 sibling-error 차단용 child controller로 바꿔서 넘긴다.

## 2. 핵심 로직

### 2.1 `constructor(toolDefinitions, canUseTool, toolUseContext)`

```
this.toolDefinitions = H
this.canUseTool      = _
this.toolUseContext  = q
this.siblingAbortController = ev(q.abortController)    # 자식 controller
this.tools = []
this.hasErrored = false
this.erroredToolDescription = ""
this.discarded = false
this.progressAvailableResolve = undefined
```

`ev(parent)` (line 8159)는 부모 signal이 abort되면 child도 abort되는 forwarded
`AbortController`를 만든다 (WeakRef로 누수 방지). 이렇게 만들어진
`siblingAbortController`는 다시 각 도구마다 한 번 더 `ev(...)`로 자식을
파생시켜, **한 도구가 에러 나면 형제 도구만 끊고 부모는 영향 없게** 한다.

### 2.2 `addTool(toolUse, assistantMessage)` — 큐 등록 + 즉시 디스패치 시도

```
addTool(H, _) {
    let q = eK(this.toolDefinitions, H.name, ...toolAliases)  # 도구 lookup
    if (!q) {
        # unknown tool → completed 상태로 바로 합성 에러 결과 푸시
        this.tools.push({
            id: H.id, block: H, assistantMessage: _,
            status: "completed",
            isConcurrencySafe: true,
            pendingProgress: [],
            pendingBridgeEvents: [],
            results: [D6({ content: [{ type:"tool_result", is_error:true, ... }], ... })]
        })
        return
    }
    let K = q.inputSchema.safeParse(H.input)
    let O = K?.success
        ? (() => { try { return Boolean(q.isConcurrencySafe(K.data)) } catch { return false } })()
        : false
    this.tools.push({
        id: H.id, block: H, assistantMessage: _,
        status: "queued",
        isConcurrencySafe: O,
        pendingProgress: [],
        pendingBridgeEvents: [],
        results: []
    })
    this.processQueue()
}
```

확인 사항:
- **input schema validation은 큐 등록 시점에 미리 시도** — 단순히
  `isConcurrencySafe()` 호출용 (Zod parsed input 필요). 그러나 실제 실행은
  `runSingleTool` 안에서 다시 검증한다.
- `isConcurrencySafe`가 false거나 schema validation 실패면 보수적으로
  **직렬 실행** (concurrency-unsafe로 분류).
- unknown tool은 promise 없이 즉시 `"completed"` — 다음
  `getCompletedResults()`가 합성 에러를 흘려보낸다.

### 2.3 `canExecuteTool(isConcurrencySafe)`

```
canExecuteTool(H) {
    let _ = this.tools.filter(q => q.status === "executing")
    return _.length === 0 || (H && _.every(q => q.isConcurrencySafe))
}
```

스케줄 규칙 (확인):
- 현재 실행 중이 0개 → 무조건 OK
- 새 도구가 concurrency-safe이고 실행 중 도구가 모두 concurrency-safe → 동시 실행
- 새 도구가 unsafe거나 실행 중에 unsafe가 하나라도 있음 → 새 도구는 대기

이건 비-스트리밍 경로의 `groupByConcurrencySafe` (`isConcurrencySafe` batcher) / `runConcurrentTools`/`runSerialTools`와
의미가 같다 — **read-only 묶음만 동시, write는 직렬**.

### 2.4 `processQueue()` — 큐 진행 (idempotent)

```
async processQueue() {
    for (let H of this.tools) {
        if (H.status !== "queued") continue
        if (this.canExecuteTool(H.isConcurrencySafe))
            await this.executeTool(H)        # await but executeTool fires-and-forgets
        else if (!H.isConcurrencySafe)
            break                            # head-of-line block: unsafe 만나면 그 뒤도 정지
    }
}
```

확인: `executeTool`은 내부에서 즉시 promise를 만들고 `H.promise`에 저장한 뒤
`.finally(()=>this.processQueue())`로 자기 자신을 다시 트리거한다. 그래서
`await this.executeTool(H)`는 도구 한 개의 동기 셋업(상태 전이 + promise
생성)만 기다리고 바로 다음 도구로 넘어간다 — **블로킹 await가 아니다 (확인)**.

### 2.5 `executeTool(H)` — 실제 `runSingleTool` 호출 + 진행 이벤트 수집

```
async executeTool(H) {
    H.status = "executing"
    this.updateInterruptibleState()
    let _ = []   # 결과 메시지 수집
    let q = []   # contextModifier 수집

    let O = (async () => {
        # 1) 시작 직전 abort 사유 검사 (sibling error / user interrupt / discarded)
        let T = this.getAbortReason(H)
        if (T) {
            _.push(this.createSyntheticErrorMessage(H.id, T, H.assistantMessage))
            H.results = _; H.contextModifiers = q
            H.status = "completed"
            this.updateInterruptibleState()
            return
        }

        # 2) sibling-only abort controller 파생
        let $ = ev(this.siblingAbortController)
        $.signal.addEventListener("abort", () => {
            # 형제 에러가 아니고 부모도 abort 아니면, 이 abort를 부모로 전파
            if ($.signal.reason !== "sibling_error" &&
                !this.toolUseContext.abortController.signal.aborted &&
                !this.discarded)
                this.toolUseContext.abortController.abort($.signal.reason)
        }, { once: true })

        # 3) 표준 단일-도구 파이프라인 호출 (validation+hooks+permission+call+post)
        let z = _j_(H.block, H.assistantMessage, this.canUseTool,
                    { ...this.toolUseContext, abortController: $ })
        let A = false   # 첫 에러 결과 도착 표시

        for await (let Y of z) {
            # bridge 이벤트 (dm = "type" in Y)
            if (dm(Y)) {
                H.pendingBridgeEvents.push(Y)
                this.progressAvailableResolve?.()
                this.progressAvailableResolve = undefined
                continue
            }

            # 중간에 abort 사유 발생 (예: user interrupt) → 합성 에러
            let w = this.getAbortReason(H)
            if (w && !A) {
                _.push(this.createSyntheticErrorMessage(H.id, w, H.assistantMessage))
                break
            }

            # 에러 tool_result 도착 — Bash/PowerShell 이고 unsafe면 형제 abort
            if (Y.message.type === "user" &&
                Y.message.message.content?.some(J => J.type === "tool_result" && J.is_error)) {
                A = true
                if (Q2.includes(H.block.name) && !H.isConcurrencySafe) {   # Q2 = ["Bash","PowerShell"]
                    this.hasErrored = true
                    this.erroredToolDescription = this.getToolDescription(H)
                    this.siblingAbortController.abort("sibling_error")
                }
            }

            if (Y.message) {
                if (Y.message.type === "progress") {
                    H.pendingProgress.push(Y.message)
                    this.progressAvailableResolve?.()
                    this.progressAvailableResolve = undefined
                } else {
                    _.push(Y.message)
                }
            }
            if (Y.contextModifier)
                q.push(Y.contextModifier.modifyContext)
        }

        H.results = _; H.contextModifiers = q
        H.status = "completed"
        this.updateInterruptibleState()

        # concurrency-unsafe (= 직렬) 도구의 contextModifier는 즉시 적용
        if (!H.isConcurrencySafe && q.length > 0)
            for (let Y of q)
                this.toolUseContext = Y(this.toolUseContext)
    })()

    H.promise = O
    O.finally(() => { this.processQueue() })
}
```

확인 사항:
- **권한/hook은 그대로** — `runSingleTool`를 호출하므로 PreToolUse → permission decision →
  hook chain → 도구 call → PostToolUse가 다 돈다. **interactive permission
  prompt까지 그대로** (확인): 사용자가 "Allow?" 선택하지 않으면 그 promise는
  pending 상태로 남고 `getCompletedResults`도 해당 도구는 건너뛴다.
- contextModifier는 **concurrent 도구는 즉시 적용 안 함** — 결과 yield 시점에
  caller가 `T_.newContext`로 받아 turn-level `dH`로 합친다 (`runTurnLoop` 14057,
  `if (T_.newContext) dH = {...T_.newContext, queryTracking:p}`). unsafe(직렬)
  도구는 안전하므로 인-클래스에서 즉시 합친다.
- **sibling error 전파**는 **Bash/PowerShell 이고 unsafe인 경우만** —
  read-only 도구의 에러로는 형제를 끊지 않는다.

### 2.6 `getCompletedResults()` — 동기 generator (스트림 중 폴링)

```
*getCompletedResults() {
    if (this.discarded) return
    for (let H of this.tools) {
        # bridge events (e.g. SDK control events) 먼저 드레인
        while (H.pendingBridgeEvents.length > 0)
            yield H.pendingBridgeEvents.shift()
        # progress 메시지 (실시간 출력) 드레인
        while (H.pendingProgress.length > 0)
            yield { message: H.pendingProgress.shift(), newContext: this.toolUseContext }
        if (H.status === "yielded") continue
        if (H.status === "completed") {
            H.status = "yielded"
            for (let _ of H.results)
                yield { message: _, newContext: this.toolUseContext }
            # UI에 "이 도구 끝남" 통보
            yield { type: "set_in_progress_tool_use_ids",
                    op: { action: "remove", ids: [H.id] } }
        } else if (H.status === "executing" && !H.isConcurrencySafe) {
            break    # head-of-line: unsafe 실행 중이면 그 뒤 결과도 막아 순서 보존
        }
    }
}
```

핵심 (확인):
- **`tools` 배열 순서대로 yield** — 모델이 보낸 `tool_use` 순서 보존.
- 앞쪽 도구가 아직 `executing`이고 그게 unsafe이면 break — 뒤쪽이 먼저
  끝났어도 yield 안 함 (순서 보장).
- 앞쪽이 concurrency-safe이면 break 없이 진행 — 뒤쪽이 먼저 끝나면 먼저 yield.
  (concurrent 묶음 내에서는 도착 순서 → tools 배열 순서로 정렬되어 나옴)
- 동기 generator라서 매 스트림 이벤트마다 0-cost 폴링.

### 2.7 `getRemainingResults()` — async generator (스트림 종료 후)

```
async *getRemainingResults() {
    if (this.discarded) return
    while (this.hasUnfinishedTools()) {
        await this.processQueue()
        let H = false
        for (let _ of this.getCompletedResults()) {
            H = true; yield _
        }
        # 실행 중 도구가 있고, 이번 라운드에 yield 한 게 없고, pending도 없으면
        # 도구 promise 중 하나가 끝날 때까지 대기 (or progress 도착 시 깨움)
        if (this.hasExecutingTools() && !H && !this.hasPendingProgress()) {
            let _ = this.tools
                .filter(K => K.status === "executing" && K.promise)
                .map(K => K.promise)
            let q = new Promise(K => { this.progressAvailableResolve = K })
            if (_.length > 0)
                await Promise.race([..._, q])
        }
    }
    for (let H of this.getCompletedResults()) yield H   # 마지막 flush
}
```

`progressAvailableResolve`는 **progress/bridge 이벤트 도착 시 깨우는 latch**
역할 — 도구가 끝나지 않아도 progress가 나오면 즉시 그걸 yield하기 위함.

### 2.8 `discard()` — 폴백/Tombstone 경로

```
discard() { this.discarded = true }
```

확인 사항:
- **promise를 abort하지 않는다** — `discarded` 플래그만 켠다.
- 다음 `getAbortReason(H)` 호출에서 `"streaming_fallback"`을 반환하므로,
  진행 중 `runSingleTool` 루프 안의 abort 검사에서 합성 에러로 종료된다.
- `getCompletedResults`/`getRemainingResults`는 `discarded`면 즉시 `return` —
  더 이상 어떤 도구 결과도 caller로 흘려보내지 않는다.
- 실제 in-flight `runSingleTool` AbortController는 **명시적으로 abort되지 않는 것으로
  보인다 (추정)** — 그 도구들은 백그라운드에서 계속 돌고 결과는 버려진다.
  단, `siblingAbortController`도 끊지 않으므로 도구 자체는 끝까지 실행될
  수 있다. **확인 필요**: 메모리/리소스 누수 위험. (도구가 자체적으로
  child abort를 통해서만 끝나도록 설계됨)

대신 Bq3는 `discard()` 직후 즉시 새 `StreamingToolExecutor` 인스턴스를 생성한다:
```js
if (TH) TH.discard(); TH = new gX_(Z.options.tools, T, Z)
```
이전 인스턴스는 GC 대상이 되지만 도구 promise가 살아 있어 hold할 수 있다 (추정).

### 2.9 합성 에러 메시지 (`createSyntheticErrorMessage`)

`reason` 3종:
- `"user_interrupted"` — `Ctrl+C` 등. 메시지는 `UiH(DVH)` (보존된 사용자
  거부 문구).
- `"streaming_fallback"` — `<tool_use_error>Error: Streaming fallback -
  tool execution discarded</tool_use_error>`.
- 그 외 (sibling error) — `Cancelled: parallel tool call ${erroredDesc}
  errored` 또는 `Cancelled: parallel tool call errored`.

각 결과는 `is_error: true`로 마킹된 `tool_result` 한 블록 + `D6(...)` user
메시지로 포장된다.

### 2.10 `getAbortReason(H)`

우선순위:
1. `this.discarded` → `"streaming_fallback"`
2. `this.hasErrored` → `"sibling_error"`
3. 부모 `abortController.signal.aborted` → `signal.reason === "interrupt"`이면
   해당 도구의 `interruptBehavior()`이 `"cancel"`일 때만 `"user_interrupted"`
   (`"block"`이면 null 반환 — 도구가 인터럽트를 무시하고 계속).
4. 그 외 abort → 무조건 `"user_interrupted"`.
5. 둘 다 아님 → null (정상 진행).

`interruptBehavior` 매핑은 도구 정의의 메서드. 없거나 throw하면 `"block"`
(기본) — Ctrl+C로 죽지 않는다.

### 2.11 `updateInterruptibleState()`

```
let H = this.tools.filter(_ => _.status === "executing")
this.toolUseContext.setHasInterruptibleToolInProgress?.(
    H.length > 0 && H.every(_ => this.getToolInterruptBehavior(_) === "cancel")
)
```

UI에 "지금 Ctrl+C로 끊을 수 있는 도구가 돌고 있다"는 신호. **모든** 실행
중 도구가 cancellable이어야만 true (어느 하나라도 `"block"`이면 인터럽트는
효과 없으므로 UI도 false). 매 상태 전이마다 호출.

## 3. State / Schema

### 3.1 `StreamingToolExecutor` 인스턴스 필드

```ts
class gX_ {
    toolDefinitions: ToolDef[]
    canUseTool: (...) => Promise<PermissionDecision>
    toolUseContext: ToolUseContext
    tools: TrackedTool[]                  // FIFO 큐 (모델이 보낸 순서)
    hasErrored: boolean                   // sibling error 발생 (Bash/PowerShell unsafe)
    erroredToolDescription: string        // "Bash(npm install)" 같은 표시용
    siblingAbortController: AbortController   // 자식 controller (부모↔형제 격리)
    discarded: boolean                    // streaming fallback / model fallback
    progressAvailableResolve?: () => void // getRemainingResults 깨우기용 latch
}
```

### 3.2 `TrackedTool` (`tools[]` 원소) 형태

```ts
type TrackedTool = {
    id: string                    // toolUse.id
    block: ToolUseBlock           // 모델이 보낸 원본 block
    assistantMessage: AssistantMessage   // 이 toolUse를 담은 어시스턴트 메시지 (sourceUUID용)
    status: "queued" | "executing" | "completed" | "yielded"
    isConcurrencySafe: boolean    // schema parse 성공 + isConcurrencySafe()==true
    pendingProgress: ProgressMsg[]      // executeTool이 푸시, getCompletedResults가 드레인
    pendingBridgeEvents: BridgeEvent[]  // ditto (set_in_progress_tool_use_ids 등)
    results: Message[]                  // 최종 결과들 (tool_result, 부수 user msg)
    contextModifiers?: ((ctx)=>ctx)[]   // 누적된 contextModifier
    promise?: Promise<void>             // executeTool의 IIFE — Promise.race 대상
}
```

상태 전이:
```
queued → executing → completed → yielded
                                     ↑
                                 (terminal)
```

unknown tool은 큐 등록 시 바로 `completed`.

### 3.3 yield되는 이벤트 종류

`getCompletedResults` / `getRemainingResults`가 흘리는 값:

| 형태 | 출처 | 설명 |
|---|---|---|
| `{ type: "set_in_progress_tool_use_ids", op: { action: "remove", ids: [id] } }` | 도구 완료 yield 끝에 | UI 진행 표시 제거 |
| bridge events (`dm(Y)` true) | `runSingleTool` 내부 (SDK control) | 그대로 통과 |
| `{ message: ProgressMsg, newContext: ctx }` | 도구 실행 중 progress | 실시간 출력 |
| `{ message: ToolResultUserMsg, newContext: ctx }` | 도구 완료 결과 | 최종 tool_result |

`newContext`는 caller(Bq3)가 `dH = {...T_.newContext, queryTracking:p}`로
turn-level ctx에 머지한다 (concurrent 도구의 contextModifier 반영).

### 3.4 Bq3 측 상태와의 상호작용

Bq3 (line 14057) 내부 변수:
- `wH` — 누적된 어시스턴트 메시지 (tombstone 시 모두 yield 후 비움)
- `JH` — 누적된 사용자(tool_result) 메시지
- `_H` — 누적된 tool_use 블록 (텔레메트리 + emitToolUseSummaries용)
- `t` — `_H.length > 0` 플래그
- `TH` — 현재 `StreamingToolExecutor` 인스턴스 (gate off면 `null`)
- `H_` — `onStreamingFallback` 콜백이 켜는 폴백 신호 (turn 내부)
- `KH` — 마지막 `stop_reason`

폴백 시 (`H_ === true` 또는 `FallbackTriggeredError` 예외):
```js
for (l_ of wH) yield { type:"tombstone", message: l_ }
wH.length = 0; JH.length = 0; _H.length = 0; t = false
TH.discard(); TH = new gX_(Z.options.tools, T, Z)
```

### 3.5 텔레메트리

| 이벤트 | 언제 | 페이로드 |
|---|---|---|
| `tengu_streaming_tool_execution_used` | 매 turn 스트림 종료 후, `TH != null`이면 | `{ tool_count, queryChainId, queryDepth }` |
| `tengu_streaming_tool_execution_not_used` | 매 turn, `TH == null`이면 | `{ tool_count, queryChainId, queryDepth }` |
| `tengu_orphaned_messages_tombstoned` | `H_ === true` 폴백 시 | `{ orphanedMessageCount, queryChainId, queryDepth }` |
| `tengu_model_fallback_triggered` | `FallbackTriggeredError` 예외 경로 | `{ original_model, fallback_model, entrypoint, ... }` |

확인: turn당 정확히 한 번 (used XOR not_used). `tool_count`는 스트림 동안
누적된 `_H.length` (= 모델이 호출한 tool_use 수).

### 3.6 Tombstone의 SDK 수신측 동작

`extracted-functions.js:21007` (SDK message accumulator):

```js
case "tombstone": {
    let OH = ZH.findLastIndex(IH => IH.uuid === a.message.uuid)
    if (OH !== -1) {
        ZH.splice(OH, 1)
        if (NH > OH) NH--
        if (dH > OH) dH--
    }
    let LH = this.mutableMessages.findLastIndex(IH => IH.uuid === a.message.uuid)
    if (LH !== -1) this.mutableMessages.splice(LH, 1)
    break
}
```

확인: tombstone은 **transcript에서 해당 어시스턴트 메시지를 splice로 제거**.
인덱스 포인터(`NH`, `dH`)도 보정. 즉 "버려진 응답"은 로그에 흔적 없이 사라진다.
UI 측(`extracted-functions.js:15566`)에는 `$?.(H.message)` 콜백으로 통보.
**그래서 캐시 write도 사실상 영향 없음 (추정)**: tombstone 이후 후속 API 호출은
`x` (`messages`)에 tombstoned 메시지가 없는 상태로 진행. tool_use가 있는
어시스턴트 턴은 자연스럽게 캐시 미스가 된다 (= 새 prefix). `skipCacheWrite`는
Bq3 entry param이므로 streaming tool exec와 무관 (확인).

### 3.7 Permission 경로 (확인)

`gX_.addTool` → `gX_.executeTool` → `_j_(block, assistantMsg, canUseTool, ctx)`
→ `wrapToolWithProgressQueue` → `executeToolPipeline`:
- `runPreToolUseHooks` (PreToolUse hooks)
- `precheckBashMisuse` (Bash misuse pre-check)
- `decidePermission` (permission decision: allow/deny/ask)
- `runPermissionDeniedHook` (PermissionDenied hook on deny → retry signal)
- 실제 `tool.call(...)`
- `runPostToolUseHooks` (PostToolUse hooks)

확인: **streaming tool exec는 _j_를 1:1로 그대로 사용**한다 — 빠른 경로 없음.
사용자가 interactive permission prompt에 답해야 하는 도구라면, 그 답이 올
때까지 `runSingleTool`가 await한다. 단, **다른** concurrency-safe 도구는 그 사이에도
병렬로 진행될 수 있다 — 이게 v0.2.8 대비 가장 큰 체감 차이 중 하나 (추정).

## 4. 차이점 (v0.2.8 대비)

v0.2.8: 모델 응답이 **완전히 끝난 뒤** (`stop_reason` 도착 + 모든 content
yield 완료) tool_use를 모아서 `runToolBatch`를 호출. 사용자는
"모델 응답 → 도구 실행 → 다음 응답"의 순차적 대기를 경험.

v2.1.143 (gate ON):
- 도구 실행이 **첫 tool_use 블록 도착 시점에 시작**. 모델이 텍스트를 더
  생성하는 동안 도구는 이미 돌고 있음.
- 텍스트 출력과 tool_result 출력이 **인터리브**된다. 단, gX_는 `tools` 배열
  순서를 보장하므로 결과 자체는 모델이 호출한 순서대로 caller로 전달됨.
- concurrency-safe 묶음 동안에는 도구들이 동시에 진행 (semaphore 없음 —
  단순 `canExecuteTool` 검사만). unsafe(write) 도구가 큐 앞에 있으면
  head-of-line block.
- 폴백/실패는 `tombstone`으로 우아하게 — 도구 결과까지 합성 에러로 정리하고
  transcript에서 어시스턴트 메시지를 splice out하여 깨끗하게 재시도.
- 모든 권한/hook 시멘틱은 동일 — `runSingleTool`를 우회하지 않음.

게이트 OFF면 기존 `dispatchToolBatch` (concurrent/serial batch runner, line 10727)로 폴백 —
v0.2.8 모델과 동등.

부수 차이:
- **Bash/PowerShell sibling-error 전파**가 명시적으로 `bashPowershellAbortPair` 배열로 정의됨
  (v0.2.8엔 read-only 묶음만 있었으니 sibling 개념도 사실상 없었음).
- `interruptBehavior` per-tool 정책 (cancel/block) — Ctrl+C 시 도구를
  죽일지 무시할지 도구가 선언.
- progress 메시지 latch (`progressAvailableResolve`) — 도구 promise가 끝나기
  전에도 실시간 출력이 caller로 흐르도록.
- `set_in_progress_tool_use_ids` op 이벤트 — UI에 "실행 중 도구 ID 셋"을
  관리시키는 fine-grained 신호 (v0.2.8엔 없음).

## 5. 미확인/추정 사항 (명시)

| 항목 | 상태 | 비고 |
|---|---|---|
| `discard()` 시 in-flight `runSingleTool`의 child AbortController가 끊기는지 | 추정: 끊지 않음 | 코드 경로상 `siblingAbortController`도 abort하지 않고, 도구는 자체 `getAbortReason` 검사 시점에서만 종료. 도구가 그 사이 무거운 작업을 하고 있으면 백그라운드 잔류 가능 |
| 캐시 write 영향 | 확인: 무관 | `skipCacheWrite`는 Bq3 entry param. tombstone은 transcript에서 splice — 후속 prompt에 tombstoned 어시스턴트가 안 들어가므로 자연스럽게 캐시 키가 갱신될 뿐 |
| Permission interactive prompt 대기 시 다른 도구 진행 | 확인: 진행 (concurrency-safe인 한) | `runSingleTool` 호출이 도구별 독립 promise라서 한 도구의 prompt 대기가 다른 도구를 막지 않음 |
| 도구 결과 순서 vs 모델 text 순서 | 확인: 모델 호출 순서는 보존 (`tools` 배열), 단 모델 text 사이사이에 tool_result가 끼어들 수 있음 | caller(Bq3)는 매 스트림 이벤트 직후 `getCompletedResults`를 폴링하므로 인터리브 발생 |
| 텔레메트리 emit 시점 | 확인: 매 turn `query_tool_execution_start` 직전 (도구 실행 직전, 스트림 종료 후) | `tool_count = _H.length` |
| `progressAvailableResolve` race | 추정: 안전 (단일 turn 내 단일 caller) | 단일 generator consumer만 있다는 가정 — 명시적 lock 없음 |

## 6. 인용 라인 (extracted-functions.js)

- `class gX_` 선언 — line 13877, byte offset 10050781
- `function ev` — line 8159, byte 5854253
- `async function* _j_` — line 13866, byte 10031836
- `function dm` — line 13866 인근, byte 10031836
- Bq3에서 `new gX_(...)` — line 14057, 3회 (생성/streaming-fallback/model-fallback)
- 텔레메트리 emit — line 14057, byte 10141900 인근
- Tombstone splice (SDK accumulator) — line 21007, byte 14378800 인근
- Tombstone UI 핸들러 — line 15566, byte 10837350 인근
- `Q2 = [Cq, y9]` (Bash, PowerShell) — line 5777, byte 4471784
