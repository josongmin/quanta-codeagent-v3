# Tool Execution Pipeline

`assistant` 메시지의 `tool_use` 블록들을 받아 `tool_result` (user) 메시지로 변환하는 다층 실행 스택. 진입은 turn loop `runTurnLoop`에서, leaf는 도구 인스턴스의 `tool.call(...)`.

소스: `extracted-functions.js`, 모듈 분리는 추정.

## 1. 호출 그래프

```
Bq3 (turn loop)
 └─ Hj_                              # batch runner — concurrency 그룹화 + 분기
     ├─ N05                          # isConcurrencySafe 배쳐
     ├─ y05                          # concurrent runner (safe 그룹)
     │   └─ V76(gens, V05())         # 세마포어 풀 (기본 10, env로 override)
     │       └─ _j_  (× N)           # single-tool dispatcher
     │           ├─ eK               # 도구 lookup (alias 포함)
     │           ├─ cA6              # isolation latch 체크
     │           └─ r63              # progress queue wrapper (Pn 비동기 큐)
     │               └─ a63          # 풀-파이프라인 (validate → hooks → permission → call → post)
     │                   ├─ inputSchema.safeParse
     │                   ├─ validateInput?
     │                   ├─ wo7      # bash 오용 사전 체크
     │                   ├─ backfillObservableInput
     │                   ├─ dA6      # PreToolUse hooks
     │                   ├─ QA6      # 권한 결정
     │                   ├─ tool.call(...)
     │                   ├─ mapToolResultToToolResultBlockParam
     │                   ├─ FA6      # PostToolUse hooks
     │                   ├─ BA6      # Edit/Write 후 readFileState 재동기화
     │                   ├─ FX_      # auto-classifier deny 시 PermissionDenied 훅 (재시도 신호)
     │                   ├─ gA6      # call 실패 시 PostToolUseFailure hooks
     │                   ├─ pr9/UFH  # 결과 크기 캡 + 디스크 persist
     │                   └─ jo7      # progress → hook_progress 메시지화
     └─ v05                          # serial runner (unsafe 그룹)
         └─ _j_ ... a63 ...          # 동일하지만 await 직렬 + ctx mutate per-tool
```

핵심 식별자 매핑(검증):

| 식별자 | 역할 | 위치 |
|---|---|---|
| `dispatchToolBatch` | tool batch runner | 10727 |
| `groupByConcurrencySafe` | concurrency-safe 배쳐 | 10728 |
| `runSerialTools` | serial runner | 10729 |
| `runConcurrentTools` | concurrent runner | 10730 |
| `mergeConcurrencyGroups` | n-way async generator merge (세마포어 풀) | 10722 |
| `concurrencyLimit` | concurrency limit (기본 10, `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`) | 10726 |
| `runSingleTool` | single-tool dispatcher | 13870 |
| `wrapToolWithProgressQueue` | a63 wrapper + progress queue | 13871 |
| `executeToolPipeline` | full single-tool pipeline (10,939자) | 13875 |
| `runPreToolUseHooks` | PreToolUse hooks 러너 (generator) | 13604 |
| `runPostToolUseHooks` | PostToolUse hooks 러너 | 13600 |
| `runPostToolUseFailureHooks` | PostToolUseFailure hooks 러너 | 13601 |
| `decidePermission` | 권한 결정 orchestrator | 13603 |
| `runPermissionDeniedHook` | PermissionDenied 훅 (재시도 신호 생성) | 18822 |
| `checkIsolationLatch` | isolation latch 거부 체크 | 13612 |
| `precheckBashMisuse` | bash 명령 오용 사전 체크 (non-blocking) | 15379 |
| `BA6` | Edit/Write 후 readFileState 재동기화 | 13592 |
| `lookupTool` | 도구 lookup (alias + memoized) | 5747 |
| `Pn` | push-기반 async iterator queue | 8499 |
| `dm` | `"type" in payload` (제어 메시지 판별) | 13866 |
| `makeToolResultMessage` | user message factory (`tool_result` 포함) | 15503 |
| `makeAttachmentMessage` | attachment 메시지 factory | 14331 |
| `makeHookProgressMsg` | progress 메시지 factory | 15510 |
| `mapResultBlock` / `mr9` / `pr9` / `UFH` | 결과 크기 캡 + persist 헬퍼 | 8537/8524/8537/8535 |
| `resultSizeCapMid` / `resultSizeCapDefault` | 기본 사이즈 상수 (50,000 / 400,000) | 8106 |

## 2. 핵심 로직 (pseudocode)

### 2.1 `dispatchToolBatch` — batch runner

```js
async function* Hj_(toolUses, prevMessages, queue, ctx) {
  let O = ctx
  for (const {isConcurrencySafe, blocks} of N05(toolUses, O)) {
    if (isConcurrencySafe) {
      // safe 그룹 → 동시 실행, contextModifier는 그룹 종료 후 일괄 적용
      const pendingMods = {}  // toolUseId → [modifyContext fn, ...]
      for await (const ev of y05(blocks, prevMessages, queue, O)) {
        if (dm(ev)) { yield ev; continue }              // 제어 op는 pass-through
        if (ev.contextModifier) {
          (pendingMods[ev.contextModifier.toolUseID] ??= [])
            .push(ev.contextModifier.modifyContext)
        }
        yield {message: ev.message, newContext: O}      // ctx는 아직 안 바뀜
      }
      // 모든 동시 도구 끝난 후 deterministic 순서로 ctx 변경 적용
      for (const block of blocks) {
        for (const fn of pendingMods[block.id] ?? []) O = fn(O)
      }
      yield {newContext: O}
    } else {
      // unsafe 그룹 → 직렬, ctx는 매 도구 직후 즉시 적용
      for await (const ev of v05(blocks, prevMessages, queue, O)) {
        if (dm(ev)) { yield ev; continue }
        if (ev.newContext) O = ev.newContext
        yield {message: ev.message, newContext: O}
      }
    }
  }
}
```

### 2.2 `groupByConcurrencySafe` — 배쳐 (per-input concurrency 그룹화)

`tool_uses` 배열을 inputSchema 파싱 → `isConcurrencySafe(parsedInput)` 평가 → 연속된 safe들끼리만 합치는 reduce. throw 시 unsafe로 fallback. 확인.

```js
function N05(toolUses, ctx) {
  return toolUses.reduce((acc, block) => {
    const tool = eK(ctx.options.tools, block.name, ctx.options.toolAliases)
    const parsed = tool?.inputSchema.safeParse(block.input)
    const safe = parsed?.success
      ? (() => { try { return Boolean(tool?.isConcurrencySafe(parsed.data)) } catch { return false } })()
      : false
    if (safe && acc.at(-1)?.isConcurrencySafe) {
      acc.at(-1).blocks.push(block)         // 직전 그룹에 합치기
    } else {
      acc.push({isConcurrencySafe: safe, blocks: [block]})  // 새 그룹
    }
    return acc
  }, [])
}
```

**구체 예시** — `[Read(safe), Read(safe), Bash(unsafe), Read(safe)]`:

| step | block | safe? | 마지막 그룹 safe? | 동작 | 그룹 상태 |
|---|---|---|---|---|---|
| 1 | Read#1 | ✓ | (없음) | 새 그룹 | `[{safe:T, [R1]}]` |
| 2 | Read#2 | ✓ | ✓ | 합치기 | `[{safe:T, [R1,R2]}]` |
| 3 | Bash | ✗ | ✓ | 새 그룹 | `[{safe:T,[R1,R2]}, {safe:F,[B]}]` |
| 4 | Read#3 | ✓ | ✗ | 새 그룹 | `[{safe:T,[R1,R2]}, {safe:F,[B]}, {safe:T,[R3]}]` |

→ 3개 그룹. 1·3번은 `runConcurrentTools`(동시), 2번은 `runSerialTools`(직렬).

### 2.3 `runConcurrentTools` — concurrent runner

```js
async function* y05(blocks, prevMessages, queue, ctx) {
  yield* V76(
    blocks.map(async function*(block) {
      yield* _j_(block, findAssistantMessage(prevMessages, block.id), queue, ctx)
      yield {type: "set_in_progress_tool_use_ids",
             op: {action: "remove", ids: [block.id]}}
    }),
    V05()  // 동시 실행 한도 (기본 10)
  )
}
```

`mergeConcurrencyGroups`은 n-way async generator merge: 풀에서 가장 먼저 끝난 next부터 yield. 풀 크기 = `parseInt(env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY) || 10`.

### 2.4 `runSerialTools` — serial runner

```js
async function* v05(blocks, prevMessages, queue, ctx) {
  let O = ctx
  for (const block of blocks) {
    for await (const ev of _j_(block, find(prevMessages, block.id), queue, O)) {
      if (dm(ev)) { yield ev; continue }
      if (ev.contextModifier) O = ev.contextModifier.modifyContext(O)   // ★ per-tool 즉시
      yield {message: ev.message, newContext: O}
    }
    yield {type:"set_in_progress_tool_use_ids", op:{action:"remove", ids:[block.id]}}
  }
}
```

차이: serial은 `contextModifier`를 매 도구 직후 즉시 적용해 다음 도구가 새 ctx를 본다. concurrent는 race 회피를 위해 그룹 종료 후 일괄 적용 (`dispatchToolBatch` 참고).

### 2.5 `runSingleTool` — single tool dispatcher

```js
async function* _j_(block, assistantMsg, queue, ctx) {
  const tool = eK(ctx.options.tools, block.name, ctx.options.toolAliases)
                ?? eK(FHH(), block.name)        // 보조: 핫스왑 안 된 도구 alias 검색
  if (!tool) {
    yield errorToolResult(`No such tool available: ${block.name}${suggestion(...)}`,
                          telemetry={event:"tengu_tool_use_error", error:"No such tool..."})
    return
  }
  try {
    if (ctx.abortController.signal.aborted) {
      yield cancelledToolResult(block.id, JVH)   // 정형 취소 메시지
      return
    }
    const latch = cA6(tool, ctx)                 // isolation latch
    if (latch.denyMessage) {
      yield errorToolResult(`<tool_use_error>${latch.denyMessage}</tool_use_error>`)
      return
    }
    yield* r63(tool, block.id, block.input, ctx, queue, assistantMsg,
               assistantMsg.message.id, assistantMsg.requestId,
               n63(name, mcpClients),    // mcpServerType
               i63(name, mcpClients))    // mcpServerBaseUrl
  } catch (e) {
    yield errorToolResult(`Error calling tool (${tool.name}): ${msg(e)}`)
  }
}
```

확인된 telemetry: `tengu_tool_use_cancelled`, `tengu_tool_use_isolation_latch_denied`, `tengu_tool_use_error`.

### 2.6 `wrapToolWithProgressQueue` — progress queue 어댑터

`executeToolPipeline`는 `function`(generator 아님). yield 대신 `w(event)` callback과 *return된 배열*로 결과를 전한다. `wrapToolWithProgressQueue`은 둘을 `Pn` 큐로 묶어 caller에게는 async iterator처럼 노출한다.

```js
function r63(tool, id, input, ctx, queue, asstMsg, msgId, reqId, mcpType, mcpUrl) {
  const q = new Pn
  a63(tool, id, input, ctx, queue, asstMsg, msgId, reqId, mcpType, mcpUrl,
      (ev) => {
        if (ev.type !== "progress") { q.enqueue(ev); return }
        // progress 이벤트는 jo7로 attachment 메시지화하고
        // tengu_tool_use_progress 텔레메트리 발사
        d("tengu_tool_use_progress", {...})
        q.enqueue({message: jo7({toolUseID: ev.toolUseID,
                                 parentToolUseID: id,
                                 data: ev.data})})
      })
    .then((arr) => { for (const m of arr) q.enqueue(m) })
    .catch((e) => q.error(e))
    .finally(() => q.done())
  return q
}
```

`Pn`: 단일 소비자 push-pull async iterator. 큐 ↔ pending Promise 둘 다 지원.

### 2.7 `executeToolPipeline` — full single-tool pipeline

대형 함수 (10,939자). 흐름을 단계별로 정렬:

```js
function a63(tool, id, rawInput, ctx, queue, asstMsg, msgId, reqId, mcpType, mcpUrl, emit) {
  const out = []                     // 누적 메시지
  const inputSize = SH(rawInput).length

  // ───── 1. 입력 검증 ─────
  const parsed = tool.inputSchema.safeParse(rawInput)
  if (!parsed.success) {
    return [errorToolResult(`InputValidationError: ${UA6(...)}`, ...)]
    // tengu_tool_use_error{error:"InputValidationError"}
    // ABORT — 도구 실행 안 함
  }
  const validate = await tool.validateInput?.(parsed.data, ctx)
  if (validate?.result === false) {
    return [errorToolResult(validate.message, errorCode: validate.errorCode)]
    // ABORT
  }

  // ───── 2. Bash 사전 미스유즈 체크 (non-blocking) ─────
  if (tool.name === "Bash" && "command" in parsed.data) {
    wo7(parsed.data.command, ctx.getToolPermissionContext(),
        ctx.abortController.signal, ctx.options.isNonInteractiveSession)
    // 결과는 cqK.set(id, promise)에 보관. permission 단계가 await 함. 실패해도 continue.
  }

  // ───── 3. _simulatedSedEdit 제거 + observable 입력 backfill ─────
  let input = parsed.data
  if (tool.name === "Bash" && "_simulatedSedEdit" in input) {
    const {_simulatedSedEdit, ...rest} = input; input = rest
  }
  let callInput = input               // tool.call에 넘길 원본
  let observableInput = tool.backfillObservableInput ? {...input} : null
  if (observableInput) {
    tool.backfillObservableInput(observableInput)   // mutates
    input = observableInput                         // hook/permission에 보일 input
  }

  // ───── 4. PreToolUse hooks (dA6) ─────
  let preventContinuation = false, stopReason, hookPermResult
  for await (const ev of dA6(ctx, tool, input, id, msgId, reqId, mcpType, mcpUrl)) {
    switch (ev.type) {
      case "message":              out.push(ev.message); // progress는 emit으로 분리
      case "hookPermissionResult": hookPermResult = ev.hookPermissionResult; break
      case "hookUpdatedInput":     input = ev.updatedInput; break
      case "preventContinuation":  preventContinuation = ev.shouldPreventContinuation; break
      case "stopReason":           stopReason = ev.stopReason; break
      case "additionalContext":    out.push(ev.message); break
      case "defer":                // interactive면 무시, 형제 tool 있어도 무시
                                   // 충족 시 hook_deferred_tool attachment 추가 후 즉시 return
      case "stop":                 out.push(errorToolResult(stopReason)); return out  // ABORT
    }
  }
  // 성능: PreToolUse 합산 시간이 Ty8=2000ms 이상이면 warn 로그

  // ───── 5. 권한 결정 (QA6) ─────
  const mode = ctx.getToolPermissionContext().mode
  const {decision, input: nextInput} = await QA6(hookPermResult, tool, input, ctx, ...)
  input = nextInput
  if (decision.behavior !== "allow") ctx.onPermissionDenial?.(tool, id, input)

  // 텔레메트리(`Y1("tool_decision", ...)`), OTEL `tool.blocked_on_user` 종료
  if (decision.decisionReason?.type === "hook"
      && decision.decisionReason.hookName === "PermissionRequest"
      && decision.behavior !== "ask")
    out.push(hook_permission_decision attachment)

  // ───── 5a. 거부 분기 ─────
  if (decision.behavior !== "allow") {
    out.push(toolResult({
      content: [{type:"tool_result", content:decision.message, is_error:true, tool_use_id:id},
                ...(decision.behavior === "ask" ? decision.contentBlocks ?? [] : [])],
      imagePasteIds: allocFor(images, ctx.messages)   // Ao7로 다음 paste id
    }))
    // auto-classifier deny면 FX_ 호출 → retry hint
    if (decision.decisionReason?.type === "classifier"
        && decision.decisionReason.classifier === "auto-mode") {
      let retry = false
      for await (const r of FX_(name, id, input, reason, ctx, mode, signal))
        if (r.retry) retry = true
      if (retry) out.push({message: D6({content:"The PermissionDenied hook indicated you may retry this tool call.", isMeta:true})})
    }
    return out                                  // 정상 종료 (ABORT)
  }

  // 권한 결정 자체가 입력을 수정했으면 반영
  if (decision.updatedInput !== void 0) input = decision.updatedInput

  // ───── 6. tool.call 직전 텔레메트리/메모리 측정 시작 ─────
  const startMem = process.memoryUsage()
  const t0 = Date.now()
  VY6("tool_exec")                              // 세션 활동 refcount++
  // callInput을 input으로 동기화 (file_path만 별도 보존)
  // ...
  emit({type:"set_in_progress_tool_use_ids", op:{action:"add", ids:[id]}})

  let called = false, result
  try {
    result = await tool.call(
      callInput,
      {...ctx, toolUseId:id, userModified: decision.userModified ?? false},
      queue, asstMsg, emit                       // emit은 progress callback 전달용
    )
    const dur = Date.now() - t0
    const endMem = process.memoryUsage()
    mk_(dur)                                    // 누적 tool duration
    called = true

    // ───── 7. tool.output OTEL 이벤트 (Read/Edit/Write/Bash 출력 첨부) ─────
    Y47("tool.output", {file_path?, content?, diff?, output?, bash_command?})

    // structured_output 도구는 attachment로 추가
    if ("structured_output" in result)
      out.push({message: T9({type:"structured_output", data:result.structured_output})})

    // ───── 8. 결과 → tool_result content_blocks 매핑 ─────
    const mapped = tool.mapToolResultToToolResultBlockParam(result.data, id)
    const resultSize = lengthOf(mapped.content)
    let toolOutput = result.data
    const newMessages = result.newMessages, contextModifier = result.contextModifier, mcpMeta = result.mcpMeta

    // ───── 9. tengu_tool_use_success — 메모리 델타 포함 ─────
    d("tengu_tool_use_success", {
      messageID, toolName, isMcp, durationMs:dur,
      rssDeltaBytes:       endMem.rss      - startMem.rss,
      heapUsedDeltaBytes:  endMem.heapUsed - startMem.heapUsed,
      externalDeltaBytes:  endMem.external - startMem.external,
      preToolHookDurationMs, permissionDurationMs,
      toolResultSizeBytes:resultSize, toolInputSizeBytes:inputSize,
      fileExtension?, filePathLen?, bashCommandLen?,
      readHasLimit?, readHasOffset?, ...
    })

    // ───── 9b. git commit id 추출 ─────
    if (name in (Bash|y9) && command.match(/\bgit\s+commit\b/) && result.data.stdout)
      g.git_commit_id = jf8(stdout)   // regex /\[[\w./-]+(?: \(root-commit\))? ([0-9a-f]+)\]/

    Y1("tool_result", { success:"true", duration_ms, tool_parameters?, tool_input?,
                        tool_input_size_bytes, tool_result_size_bytes,
                        decision_source?, decision_type?, mcp_server_scope? })

    // ───── 10. PostToolUse hooks (FA6) ─────
    const postOut = []
    let hookUpdated = false
    for await (const ev of FA6(ctx, tool, id, msgId, input, toolOutput, ...)) {
      if ("updatedToolOutput" in ev) { toolOutput = ev.updatedToolOutput; hookUpdated = true }
      else { postOut.push(ev) /* message */ }
    }
    // Edit/Write 후 hook이 파일 재작성한 경우 readFileState 재동기화
    const resync = BA6(name, id, input, ctx.readFileState)
    if (resync) postOut.push({message: resync})

    // ───── 11. tool_result 메시지 조립 (fH helper) ─────
    async function fH(rawOutput, alreadyMapped) {
      const blocks = [
        alreadyMapped
          ? await pr9(alreadyMapped, name, maxResultSizeChars, persistenceThresholdCeiling)
          : await UFH(tool, rawOutput, id)
      ]
      if ("acceptFeedback" in decision && decision.acceptFeedback)
        blocks.push({type:"text", text: decision.acceptFeedback})
      const extras = "contentBlocks" in decision ? decision.contentBlocks : void 0
      if (extras?.length) blocks.push(...extras)

      let imagePasteIds
      if (extras?.length) {
        const imgCount = H8(extras, b => b.type === "image")
        if (imgCount > 0) {
          const next = Ao7(ctx.messages)
          imagePasteIds = Array.from({length:imgCount}, (_,i) => next + i)
        }
      }
      out.push({
        message: D6({
          content: blocks,
          imagePasteIds,
          toolUseResult: ctx.agentId && !ctx.preserveToolUseResults ? void 0 : rawOutput,
          mcpMeta: ctx.agentId ? void 0 : mcpMeta,
          sourceToolAssistantUUID: asstMsg.uuid,
        }),
        contextModifier: contextModifier ? {toolUseID:id, modifyContext:contextModifier} : void 0
      })
    }

    if (RG(tool)) {  // MCP 도구: hook의 updatedToolOutput 적용은 fH 안에서 raw로
      await fH(toolOutput)
    } else {
      let mapped2 = mapped
      if (hookUpdated) {
        const validated = tool.outputSchema?.safeParse(toolOutput)
        if (validated && !validated.success) {
          // hook이 잘못된 모양으로 바꿈 — 원본 결과로 롤백 + hook_error_during_execution attachment
          toolOutput = result.data
          postOut.push(hook_error_attachment)
        } else {
          try {
            const remap = tool.mapToolResultToToolResultBlockParam(toolOutput, id)
            if (remap === void 0) postOut.push(hook_error_attachment) else mapped2 = remap
          } catch (e) { postOut.push(hook_error_attachment) }
        }
      }
      await fH(toolOutput, mapped2)
    }
    for (const m of postOut) out.push(m)
    for (const m of result.newMessages ?? []) out.push({message:m})

    // PreToolUse가 preventContinuation을 외쳤다면 attachment 추가
    if (preventContinuation)
      out.push({message: T9({type:"hook_stopped_continuation", message: stopReason || "...", ...})})

    return out
  } catch (e) {
    // ───── 12. tool.call 실패 경로 ─────
    const dur = Date.now() - t0
    mk_(dur)
    RD8({success:false, error:...})            // OTEL tool_exec span 종료
    if (e instanceof tVH) yY6(serverName, ...) // MCP auth 에러 → 앱 상태 표시
    if (!(e instanceof PO /* abort */)) {
      const {code, isSad} = Q63(e)             // 분류 (mcp_auth/shell/mcp_call/fs/other)
      isSad ? M6(name, code) : mH(name, code)
      d("tengu_tool_use_error", {error, isMcp, rssDelta, heapDelta, externalDelta, ...})
      Y1("tool_result", {success:"false", error_type, ...})
    }
    // PostToolUseFailure hooks (gA6) — 실패한 도구에 대해 LX_ 디스패치
    const failOut = []
    for await (const t of gA6(ctx, tool, id, msgId, input, errMsg, e instanceof PO, ...))
      failOut.push(t)
    out.push({
      message: D6({
        content:[{type:"tool_result", content:errMsg, is_error:true, tool_use_id:id}],
        toolUseResult:`Error: ${errMsg}`,
        mcpMeta: e instanceof UX_ ? e.mcpMeta : void 0,
        sourceToolAssistantUUID: asstMsg.uuid
      })
    }, ...failOut)
    return out
  } finally {
    NY6("tool_exec")                            // 세션 활동 refcount--
    if (toolDecisionEntry) ctx.toolDecisions?.delete(id)
  }
}
```

#### 단계별 abort 여부 정리

| 단계 | 실패/거부 시 | 도구 호출 |
|---|---|---|
| 1. `inputSchema.safeParse` 실패 | `InputValidationError` 메시지 즉시 반환 | **ABORT** |
| 1b. `validateInput` `result:false` | 도구 정의 에러 반환 | **ABORT** |
| 2. `precheckBashMisuse` Bash 사전 체크 | 비동기, fire-and-forget. 결과는 permission이 await | continue |
| 3. backfill | 결과를 input으로 덮어쓰지만 `callInput`은 원본 보존 | continue |
| 4. `runPreToolUseHooks`/PreToolUse | event 종류별:<br>• `stop` → 메시지 + 즉시 ABORT<br>• `defer`(print 모드, solo) → defer attachment + ABORT<br>• `hookPermissionResult deny` → `decidePermission`에 인계<br>• `preventContinuation` → 플래그만 set, 결과에 후처리로 attachment | 조건부 ABORT |
| 5. `decidePermission` permission | `allow` 외(`deny`/`ask`/`stop`) → tool_result(is_error) + auto-classifier 거부 시 `runPermissionDeniedHook` 호출 | **ABORT** |
| 6. `tool.call` 던짐 | 분류해 tengu_tool_use_error + Y1 tool_result success=false + `runPostToolUseFailureHooks` (PostToolUseFailure) 실행 | catch 처리만 |
| 7. `outputSchema` mismatch (hook이 망친 경우) | 원본 데이터로 롤백 + hook_error attachment | continue |
| 8. result size > cap | `mapResultBlock`/`pr9`/`UFH`로 디스크 persist + content를 외부 ref로 치환 | continue |

### 2.8 `runPreToolUseHooks` — PreToolUse hooks 러너 (이벤트 프로토콜)

내부에서 `GX_`(generic hook 디스패처)를 돌리며 hook 결과를 받는 대로 정형 이벤트로 변환해 yield. `executeToolPipeline`가 switch로 받는다.

| `type` | payload | a63 반응 |
|---|---|---|
| `message` | `{message:HookOutputMessage}` | progress면 emit callback, 아니면 `out.push` (transcript) |
| `hookPermissionResult` | `{behavior:"allow"\|"ask"\|"deny", updatedInput?, message?, decisionReason}` | `decidePermission`로 전달돼 permission 단계에 합쳐짐 |
| `hookUpdatedInput` | `{updatedInput}` (permissionBehavior 없을 때만) | `input` 즉시 교체 → 이후 permission/call이 이 input을 봄 |
| `preventContinuation` | `{shouldPreventContinuation:true}` | 플래그 set. 도구는 계속 실행되지만, 성공 후 `hook_stopped_continuation` attachment 추가 → turn loop가 종결 |
| `stopReason` | `{stopReason:string}` | 변수에 보관. stop/preventContinuation 메시지 텍스트로 사용 |
| `defer` | `{hookName}` | 비대화형(`isNonInteractiveSession`) + 형제 tool_use 없을 때만 유효. `hook_deferred_tool` attachment + 즉시 return (도구 실행 안 함). 인터랙티브거나 형제 있으면 무시 + warn 로그 |
| `additionalContext` | `{message:T9(hook_additional_context, contents:[strings...])}` | `out.push` — assistant가 다음 턴에 추가 컨텍스트로 본다 |
| `stop` | `{}` | `out.push(errorToolResult(stopReason))` 후 즉시 return — 도구 실행 안 함 |

내부 처리:
- `permissionBehavior === "defer"` → `Y` 변수에 hookSource 저장 후 `continue` (다른 이벤트와 별개로 모든 hook 끝난 뒤 마지막에 `defer` yield)
- `permissionBehavior === "deny"` → `w=true` set + `hookPermissionResult` yield (메시지 형식: ``${hookName} ${denied/allowed/asked} this tool``)
- hook이 throw → `hook_error_during_execution` attachment + `stop` yield (이 도구는 abort)
- `abortController.signal.aborted` → `hook_cancelled` attachment + `stop` yield, `tengu_pre_tool_hooks_cancelled` telemetry

전체 PreToolUse hook 소요 ≥ `Ty8=2000ms`면 warn 로그.

### 2.9 `runPostToolUseHooks` — PostToolUse hooks 러너

```
yield 종류 (a63 처리):
  message              → out.push
  blockingError        → hook_blocking_error attachment 추가
  updatedToolOutput    → toolOutput 변수 교체 + `hookUpdated=true` 플래그
  updatedMCPToolOutput → MCP 도구만 toolOutput 교체 (RG(tool) true일 때)
  preventContinuation  → hook_stopped_continuation attachment + 즉시 return
  additionalContexts   → hook_additional_context attachment
  hook throw           → hook_error_during_execution attachment (continue)
  hook cancelled       → hook_cancelled attachment (continue)
```

소요 ≥ 2000ms면 warn 로그.

### 2.10 `checkIsolationLatch` — isolation latch

```js
function cA6(tool, ctx) {
  const latch = ctx.isolationLatch
  if (!latch || !enableLatch()) return PASS
  const classified = ac7(tool, latch.exemptServers)  // "web"/"mcp"/null
  if (!classified) return PASS
  const current = latch.current
  if (current && current !== classified) {
    return {denyMessage: de5(current), classifiedAs: classified, activeLatch: current}
  }
  if (!current) { latch.current = classified; latch.onLatch?.(classified) }
  return PASS
}
```

- 한 세션 내에서 "web search 계열"과 "MCP 계열"이 한 번 라치된 후 반대 카테고리로 못 넘어가게 차단.
- `extracted-functions.js:13612` 확인.

## 3. State / Schema

### 3.1 `dispatchToolBatch` → caller 가 받는 이벤트 (`dm`이 true면 제어, 아니면 message)

```ts
type HjEvent =
  | {message: AnyMessage, newContext: ToolUseContext}      // 일반 결과
  | {newContext: ToolUseContext}                           // (concurrent 그룹 종료 후 ctx 일괄 반영)
  | {type: "set_in_progress_tool_use_ids",
     op: {action: "add"|"remove", ids: string[]}}          // emit/cleanup
  | {type: "tombstone" | "tool_use_summary" | ...}         // pass-through
```

### 3.2 `contextModifier` 데이터 형태 (확인)

도구가 `tool.call`에서 결과와 함께 반환:

```ts
interface ToolCallResult<T> {
  data: T
  contextModifier?: (ctx: ToolUseContext) => ToolUseContext   // pure fn 권장
  newMessages?: Message[]
  mcpMeta?: Record<string, unknown>
  structured_output?: unknown
}
```

`executeToolPipeline`는 `tool_result` 메시지에 `{toolUseID:id, modifyContext: fn}` 형태로 묶어 yield. 상위 러너 처리:

- **`runSerialTools` (serial)**: 매 도구 직후 `O = ev.contextModifier.modifyContext(O)` — 즉시 반영. 다음 도구가 새 ctx를 본다.
- **`runConcurrentTools` (concurrent)** → `dispatchToolBatch`이 받음: 그룹 전체가 끝날 때까지 `pendingMods[toolUseID]` 배열에 쌓아뒀다가, 그룹 종료 후 `blocks` 정의 순서대로 적용. **race 회피 — 동시 도구 두 개가 동일 ctx에 동시 mutate하면 결정성을 잃기 때문.** 추정 (`Hj_:10727`에서 확인).

### 3.3 `tool_result` 메시지 content 조립 (`fH` 내부)

성공 분기 최종 메시지의 `content` 배열 구성 순서:

```
[
  pr9(mapped, name, maxResultSizeChars, persistenceThresholdCeiling)
    또는 UFH(tool, rawOutput, id)        // 도구 본연 결과 (text/image blocks)
  decision.acceptFeedback                  // string → {type:"text", text:...} (있을 때만)
  ...decision.contentBlocks                // ask→allow된 경우 사용자 추가 첨부 등
]
```

추가 메타:
- `imagePasteIds`: `decision.contentBlocks`에 image가 있으면 `Ao7(ctx.messages)`로 다음 id 시작 위치 계산해서 image 개수만큼 연속 할당.
- `toolUseResult` (transcript 보존용 raw 데이터): `agentId`가 있고 `preserveToolUseResults`가 false면 undefined로 — 서브에이전트 transcript 절약.
- `mcpMeta`: `agentId` 있으면 누락. 그 외엔 `result.mcpMeta` 또는 (에러 경로) `UX_` 에러 인스턴스의 `mcpMeta` 보존.
- `sourceToolAssistantUUID`: 항상 원 assistant 메시지 uuid (체인 추적).

### 3.4 사이즈 캡 & persistence

상수: `Mc9=50,000` (`maxResultSizeChars` 기본), `fc9=400,000` (`persistenceThresholdCeiling` 기본). 확인 (line 8106).

```js
function mr9(toolName, perTool, ceiling=Mc9) {       // 실효 임계치 계산
  if (!Number.isFinite(perTool)) return perTool
  const override = Z_(r95, {})?.[toolName]            // Statsig override per-tool
  if (typeof override === "number" && override > 0) return override
  return Math.min(perTool, ceiling)
}
function Br9(blockParam, toolName, threshold) {       // 캡 적용 (이미 mapped 상태)
  const c = blockParam.content
  if (empty(c)) return {...blockParam, content: `(${toolName} completed with no output)`}
  if (!c) return blockParam
  if (alreadyExternal(c)) return blockParam            // 이미 ref면 통과
  const sz = byteSize(c)
  const T = threshold ?? fc9
  if (sz <= T) return blockParam                       // 임계 이하면 그대로
  const persisted = await DYH(c, blockParam.tool_use_id) // 디스크에 저장
  if (persistFailed(persisted)) return blockParam
  d("tengu_tool_result_persisted", { originalSizeBytes, persistedSizeBytes,
                                     estimatedOriginalTokens, estimatedPersistedTokens, thresholdUsed })
  return {...blockParam, content: MYH(persisted)}      // content를 외부 ref로 치환
}
function pr9(mapped, name, perTool, ceiling) { return Br9(mapped, name, mr9(name, perTool, ceiling)) }
function UFH(tool, raw, id)                {
  const mapped = tool.mapToolResultToToolResultBlockParam(raw, id)
  return Br9(mapped, tool.name, mr9(tool.name, tool.maxResultSizeChars, tool.persistenceThresholdCeiling))
}
```

분기: 성공 + PostToolUse hook이 결과를 안 건드린 경우 `pr9(mapped)`. 건드린 경우 `mapToolResultToToolResultBlockParam`을 재호출해 새 mapped로 `pr9`. MCP 도구는 매핑이 hook의 raw 값에 의존하므로 `UFH(tool, rawOutput, id)` 경로로 raw를 다시 매핑.

### 3.5 텔레메트리 이벤트 카탈로그 (a63/r63/_j_ 합산)

| 이벤트 | 트리거 | 주요 필드 |
|---|---|---|
| `tengu_tool_use_error` | input 검증 실패 / validateInput 실패 / unknown tool / call 실패 | `error`, `errorDetails`, `errorCode`, `toolName`, `toolInputSizeBytes`, mcp/queryChain… |
| `tengu_tool_use_cancelled` | abort 신호 | `toolName`, `toolUseID`, `isMcp` |
| `tengu_tool_use_isolation_latch_denied` | `checkIsolationLatch` deny | `isolationLatch`, `isolationClassifiedAs` |
| `tengu_tool_use_can_use_tool_rejected` | permission deny | `messageID`, `toolName`, mcp 정보 |
| `tengu_tool_use_can_use_tool_allowed` | permission allow | (성공 직전) |
| `tengu_tool_use_success` | call 성공 | `durationMs`, `rssDeltaBytes`, `heapUsedDeltaBytes`, `externalDeltaBytes`, `preToolHookDurationMs`, `permissionDurationMs`, `toolResultSizeBytes`, `toolInputSizeBytes`, `fileExtension`, `filePathLen`, `bashCommandLen`, `readHasLimit`, `readHasOffset` |
| `tengu_tool_use_progress` | progress 이벤트 | `messageID`, `toolName`, mcp/queryChain |
| `tengu_tool_empty_result` | 결과 content 비었음 | `toolName` |
| `tengu_tool_result_persisted` | 결과 디스크 persist | `originalSizeBytes`, `persistedSizeBytes`, `estimatedOriginalTokens`, `estimatedPersistedTokens`, `thresholdUsed` |
| `tengu_deferred_tool_schema_not_sent` | 스키마 누락 추정 (input 검증 실패 시 보조) | `toolName`, `isMcp` |
| `tengu_pre_tool_hooks_cancelled` | PreToolUse abort | |
| `tengu_pre_tool_hook_error` | PreToolUse throw | `duration`, mcp 정보 |
| `tengu_pre_tool_hook_deferred` | defer 충족 | `toolName` |
| `tengu_post_tool_hooks_cancelled` | PostToolUse abort | |
| `tengu_post_tool_hook_error` | PostToolUse throw | `duration` |
| `tengu_post_tool_failure_hooks_cancelled` | PostToolUseFailure abort | |
| `tengu_post_tool_failure_hook_error` | PostToolUseFailure throw | `duration` |

OTEL/Span:
- `tool_blocked_on_user` span: 권한 대기 (close 시 `decision`, `source` 어트리뷰트) — `GD8`로 종료
- `tool_exec` span: `tool.call` 실행 — `RD8`로 종료 (`success`, `error`)
- `Y47("tool.output", {...})` — 도구별 출력 발췌 (Read content/Edit diff/Write content/Bash output)

Logs 채널 (`Y1`):
- `Y1("tool_decision", {decision, source, tool_name, tool_use_id})` — `behavior !== "ask"`일 때
- `Y1("tool_result", {success, duration_ms, tool_parameters, tool_input, tool_input_size_bytes, tool_result_size_bytes, decision_source, decision_type, mcp_server_scope, error_type?, git_commit_id?})`

### 3.6 메모리 델타

```js
const startMem = process.memoryUsage()
// ... tool.call ...
const endMem = process.memoryUsage()

tengu_tool_use_success {
  rssDeltaBytes:      endMem.rss      - startMem.rss,
  heapUsedDeltaBytes: endMem.heapUsed - startMem.heapUsed,
  externalDeltaBytes: endMem.external - startMem.external,
}
```

실패 경로(`tengu_tool_use_error`)도 동일 델타를 함께 보낸다 (`!(e instanceof PO)` 분기).

### 3.7 Git commit 자동 감지

```js
function jf8(stdout) {
  return stdout.match(/\[[\w./-]+(?: \(root-commit\))? ([0-9a-f]+)\]/)?.[1]
}
```

`tool.name === Bash` 또는 `PowerShell계열`(추정: Bun/SDK Bash 별칭), `command` 안에 `\bgit\s+commit\b`이 있고 stdout이 있으면 commit id를 추출해 `Y1("tool_result", {tool_parameters:{...g, git_commit_id}})`에 포함. 확인.

### 3.8 `set_in_progress_tool_use_ids` op 패턴

도구 실행 진행 상태를 turn loop / UI가 추적할 수 있도록 emit하는 제어 메시지:

| 시점 | emitter | payload |
|---|---|---|
| `tool.call` 직전 | `executeToolPipeline`가 `emit({type:"set_in_progress_tool_use_ids", op:{action:"add", ids:[id]}})` (line 13875 후반부) | add |
| 도구 한 개 완료 | `runConcurrentTools`/`runSerialTools` 각각 `yield {type:"...", op:{action:"remove", ids:[block.id]}}` | remove |

`dispatchToolBatch`는 `dm(ev)`인 경우 무변경 pass-through. turn loop `runTurnLoop`는 이 op 메시지를 받아 transcript에는 안 쓰고 UI 상태로 사용 (00-overview에서 `set_in_progress_tool_use_ids`는 `cq6` 필터에 포함).

## 4. 차이점 (v0.2.8 대비)

| 항목 | v0.2.8 | v2.1.143 (`executeToolPipeline`) |
|---|---|---|
| 동시성 결정 | `runToolsConcurrently` / `runToolsSerially` 둘 중 하나. 기준은 `tool.isReadOnly` boolean (도구 단위) | `groupByConcurrencySafe`이 **입력별로** `tool.isConcurrencySafe(parsedInput)` 호출. 같은 도구도 입력에 따라 safe/unsafe 분기됨 (예: `Bash`도 read-only 명령이면 safe로 분류 가능, MCP 도구도 입력 기반 판단). 연속된 safe들끼리만 그룹핑돼 `runConcurrentTools`로, unsafe는 그룹 자체가 `runSerialTools` |
| Hook | 없음 | PreToolUse / PostToolUse / PostToolUseFailure / PermissionDenied / PermissionRequest 등 a63 내부에서 5개 단계 |
| Permission | 단순 allow/deny | `decidePermission`이 `hookPermissionResult`와 도구 자체 `checkPermissions`을 합산 + 6모드 + auto-classifier |
| Schema 검증 | 도구별 자체 검사 | `inputSchema.safeParse` → `validateInput?` 2단계, `UA6`가 Zod 이슈를 사람 읽기 좋은 메시지로 합성 |
| 결과 크기 | 임의 truncate | `maxResultSizeChars` / `persistenceThresholdCeiling` per-tool + Statsig override + 디스크 persist (`mapResultBlock`) |
| ContextModifier | 도구가 ctx를 직접 mutate | 도구는 `contextModifier: (ctx) => ctx`만 반환. **concurrent 그룹은 그룹 종료 후 일괄 적용**, serial은 즉시 |
| Progress | 없음 | `wrapToolWithProgressQueue`이 `Pn` 큐로 emit, `makeHookProgressMsg`이 attachment 메시지화 |
| Telemetry | 단순 success/error | 메모리 델타, 단계별 소요(pre/perm), 결과/입력 사이즈, 파일 메타, git commit id, mcp server scope, queryChain id/depth, requestId, classification 등 십수 개 필드 |
| Isolation | 없음 | `checkIsolationLatch` web/MCP 카테고리 라치 |
| Backfill observable input | 없음 | `tool.backfillObservableInput`이 hook/transcript에 보일 input을 도구가 자체 보정 (예: Bash가 `_simulatedSedEdit` 같은 internal 플래그를 외부 input에서 제거) |
| PostToolUse가 output 수정 | 없음 | `outputSchema` 재검증 → 실패 시 원본으로 롤백 + `hook_error_during_execution` |
| 파일 수정 후 동기화 | 없음 | `BA6`이 Edit/Write 후 hook이 파일 재작성한 경우 `readFileState` 재동기화 + `hook_additional_context`로 다음 Edit이 stale-file 에러를 안 내도록 안내 |
| Disposable resource | manual cleanup | `using ... = ga7(...)` (ES2026) — 확인은 다른 모듈, 여기서는 `VY6`/`NY6` refcount 패턴이 finally에서 짝맞춤 |

---

작성 기준: `extracted-functions.js` 라인 13875의 `executeToolPipeline` 본문 + 주변 helper (13592~13875), `Hj_/y05/v05/N05` (10727~10730), `wrapToolWithProgressQueue` (13871), `runSingleTool` (13870), `runPreToolUseHooks` (13604), `runPostToolUseHooks` (13600), `runPostToolUseFailureHooks` (13601), `runPermissionDeniedHook` (18822). 모든 라인 번호는 `extracted-functions.js` 기준.
