# Headless / SDK 양방향 제어 프로토콜 + 출력 포맷

`@anthropic-ai/claude-agent-sdk`의 `query()`가 Claude Code를 프로그래밍적으로 구동하는 방식. SDK는 CLI를 `--print --input-format stream-json --output-format stream-json` 으로 자식 프로세스로 띄우고, **stdin/stdout을 newline-delimited JSON 메시지 채널**로 삼아 양방향 통신한다. 단순 "프롬프트→결과" 파이프가 아니라, **CLI가 실행 중간에 SDK 쪽으로 콜백(`control_request`)을 역호출**할 수 있는 풀-듀플렉스 RPC 채널이라는 점이 이 아키텍처의 핵심이다.

추출 위치 핵심:
- 메인 print/SDK 드라이버 루프 `printDriverLoop`(`A64`) — [`extracted-functions.js:21043`](../../extracted-functions.js#L21043)
- SDK 세션 제너레이터 `sdkSession.submitMessage`(`m_4`) — [`extracted-functions.js:21007`](../../extracted-functions.js#L21007) 부근
- stdio 메시지 트랜스포트 클래스 `structuredIO`(`yR_`) — [`extracted-functions.js:20542`](../../extracted-functions.js#L20542)
- inbound control_request 디스패처 — [`extracted-functions.js:21059`](../../extracted-functions.js#L21059)
- `initialize` 핸들러 `handleInitialize`(`sdkInitHandshake`) — [`extracted-functions.js:21068`](../../extracted-functions.js#L21068)
- REPL bridge 변종(원격 제어) `bridgeIngress`(`UGK`)/`bridgeHandleControlRequest`(`FGK`) — [`extracted-functions.js:17675`](../../extracted-functions.js#L17675), [`17676`](../../extracted-functions.js#L17676)
- 텔레메트리 이벤트 카탈로그 — [`extracted-functions.js:5735`](../../extracted-functions.js#L5735)

표기: minified 식별자는 `백틱`, 직관 이름은 `직관이름(\`min\`)` 병기. 글로서리 미등재 신규 식별자가 대부분이라 본 문서에서 새로 명명한다. 신뢰도 **확인**=코드 본문 검증, **추정**=호출/문자열 추론.

---

## 1. 호출 그래프

### 1.1 프로세스/채널 부트스트랩

```
SDK query() (외부 패키지)
  └─ spawn: claude --print --input-format stream-json --output-format stream-json
                   --replay-user-messages [--verbose] [--permission-mode ...]
       (bridge 변종 인자 verbatim: extracted-functions.js:18071)
       │
       ▼  CLI 프로세스 진입 (print 모드 진입점)
  printEntry  (--print 분기)
  ├─ structuredIO 인스턴스 생성 = new yR_(stdin, replayUserMessages, sessionState)
  │    └─ this.structuredInput = this.read()       # stdin newline-JSON async generator
  ├─ D64(...)                                       # 초기 메시지/resume/teleport 로드
  ├─ j64(permissionPromptToolName|"stdio", ...)     # canUseTool 어댑터 구성
  └─ for await (c of A64(structuredIO, mcpClients, commands, tools, msgs,
                         canUseTool, ...))          # ← printDriverLoop
       └─ switch (outputFormat) { text | json | stream-json }   # 최종 출력 형태
```

### 1.2 printDriverLoop(`A64`) 내부 두 갈래

`printDriverLoop`(`A64`)은 **두 개의 동시 async 태스크**를 띄운다 (확인, [`extracted-functions.js:21043`](../../extracted-functions.js#L21043)~`21059`):

```
A64
├─ [태스크 A] outbound query 처리 (do/while + submitMessage)
│   └─ xl_(workload, () => Fq6(... p_4({...canUseTool:T, commands, prompt, ...})))
│        └─ p_4 → 내부적으로 m_4.submitMessage (SDK 세션 제너레이터)
│             └─ W7O(iI({... canUseTool:r, toolUseContext:TH ...}))
│                  └─ runTurnLoop(`runTurnLoop`)             # agent-loop.md
│        yield 되는 SDK 메시지 → h.enqueue(...)       # h = structuredIO.outbound (Pn 큐)
│        d("tengu_sdk_result", {subtype, num_turns, duration_ms, ...})  # 턴 종료마다
│
└─ [태스크 B] inbound control 루프
    for await (WH of structuredIO.structuredInput) {   # stdin 메시지 스트림
      if (WH.type === "control_request") switch (WH.request.subtype) {
        "interrupt"            → v.abort()           # AbortController
        "initialize"           → await p7O(...)      # handleInitialize → control_response
        "set_permission_mode"  → setAppState(toolPermissionContext.mode 갱신)
        "set_model"            → SZ(model); notifyMetadataChanged
        "set_max_thinking_tokens" → s = q64(...)
        "mcp_status" | "get_binary_version" | "get_context_usage"
            | "get_session_cost" | "mcp_message" | "rewind_files"
            | "read_file" | "file_suggestions" | "seed_read_state"
            | "cancel_async_message" | "end_session" → 각 핸들러 → control_response
      }
      else if (WH.type === "user")  → NY({mode:"prompt", value, uuid})  # 새 프롬프트 주입
    }
```

### 1.3 역방향(CLI→SDK) control_request 발신: structuredIO(`yR_`)

CLI가 SDK에게 콜백을 요청하는 경로 (확인, [`extracted-functions.js:20543`](../../extracted-functions.js#L20543)~`20544`):

```
structuredIO.sendRequest(request, schema?, abortSignal?, requestId?)
  ├─ outbound.enqueue({type:"control_request", request_id, request})  # stdout으로
  ├─ pendingRequests.set(requestId, {request, resolve, reject, schema})
  └─ await Promise            # SDK가 control_response 줄 때까지 대기
       └─ finally: d("tengu_sdk_control_roundtrip", {subtype, duration_ms, aborted})

structuredIO.processLine(line)   # stdin에서 control_response 도착 시
  └─ pendingRequests.get(response.request_id)
       ├─ schema.parse(response.response)  # Zod 검증 (실패 → reject)
       └─ K.resolve(parsed)  → 위 await 깨어남

발신자들 (모두 sendRequest 래핑):
  ├─ createCanUseTool()        → subtype:"can_use_tool"        (퍼미션 콜백)
  ├─ createHookCallback(id)    → subtype:"hook_callback"       (SDK 정의 hook)
  ├─ handleElicitation(...)    → subtype:"elicitation"         (MCP elicitation)
  ├─ requestUserDialog(...)    → subtype:"request_user_dialog"
  ├─ createSandboxAskCallback  → subtype:"can_use_tool"        (sandbox 네트워크 승인)
  ├─ sendMcpMessage(...)       → subtype:"mcp_message"         (SDK MCP 서버 호출)
  └─ requestOAuthTokenRefresh  → subtype:"oauth_token_refresh"
```

핵심 함수 매핑:

| 직관 이름(`min`) | 위치 | 역할 |
|---|---|---|
| `printDriverLoop`(`A64`) | ef.js:21043 | print 모드 메인 드라이버 (outbound query + inbound control 2-task) |
| `sdkSession`(`m_4`) | ef.js:21007 부근 | SDK 세션 클래스, `submitMessage` async gen이 `runTurnLoop` 구동 |
| `structuredIO`(`yR_`) | ef.js:20542 | stdio newline-JSON 트랜스포트 + control RPC + stall/schema 워치독 |
| `handleInitialize`(`sdkInitHandshake`) | ef.js:21068 | `initialize` control_request 처리 → capabilities 응답 |
| `createCanUseTool`(메서드) | ef.js:20544 | 퍼미션 결정을 control_request로 SDK에 위임하는 콜백 빌더 |
| `normalizeSdkDecision`(`htH`) | ef.js:20534 | SDK 퍼미션 응답 → 내부 `behavior` 결정으로 정규화 |
| `bridgeHandleControlRequest`(`FGK`) | ef.js:17676 | REPL bridge(원격) 측 control_request 핸들러 |
| `sdkOutMsgSchema`(`EnK`) | ef.js:20530 | outbound SDK 메시지 union Zod 스키마 (schema-violation 검출용) |
| `printOutputFormatSwitch` | ef.js:21041~21042 | `switch(outputFormat)` text/json/stream-json 최종 출력 |

---

## 2. 핵심 로직

### 2.1 세 가지 출력 포맷 (`text` / `json` / `stream-json`)

`printDriverLoop`(`A64`)이 `submitMessage`에서 yield되는 SDK 메시지를 어떻게 stdout으로 흘리는지가 포맷마다 다르다 (확인, [`extracted-functions.js:21041`](../../extracted-functions.js#L21041)~`21042`).

루프 본체에서 메시지 필터링 (확인):

```
for await (c of A64(...)) {
  if (outputFormat === "stream-json" && verbose)
    await structuredIO.write(c)              // 모든 메시지를 즉시 한 줄씩 emit

  if (c.type !== "control_response" && c.type !== "control_request"
      && c.type !== "control_cancel_request"
      && !(c.type==="system" && (subtype==="session_state_changed"
            | "task_notification" | "task_started" | "task_updated"
            | "task_progress" | "notification" | "post_turn_summary"
            | "task_summary"))
      && c.type !== "stream_event" && c.type !== "keep_alive"
      && c.type !== "prompt_suggestion" && c.type !== "transcript_mirror") {
    if (p /* json && verbose */) S.push(c)    // json+verbose: 누적 배열
    x = c                                      // 마지막 "유의미" 메시지
  }
}

switch (outputFormat) {
  case "json":
    if (!x || x.type !== "result") throw Error("No messages returned")
    if (verbose) u9(SH(S) + "\n")              // 누적 배열 전체를 JSON으로 1회 출력
    // (비 verbose json은 별도 분기에서 result.result 텍스트만, 추정)
    process.exit(x.type==="result" && x.is_error || Q ? 1 : 0)
  // case "text": result.result 문자열만 stdout (추정 — 별도 분기, 코드 인접)
  // case "stream-json": 위 if문에서 이미 줄단위 emit 완료
}
```

| 포맷 | 무엇을 emit | 형태 | exit code |
|---|---|---|---|
| `text` (기본 `--print`) | 최종 `result` 메시지의 `result` 텍스트만 | plain text (`추정` — switch에 명시 case 없이 fall-through, `x` 사용) | `is_error`면 1 |
| `json` | `--verbose`면 필터 통과 메시지 **전부**를 배열로 1회 / 비 verbose면 단일 `result` 객체 | 단일 JSON | `result.is_error`면 1 |
| `stream-json` | 모든 SDK 메시지를 **발생 즉시** 한 줄당 1 JSON object (NDJSON). `--verbose` 시 control/stream_event/keep_alive 포함 전부 | NDJSON 스트림 | 동일 |

`stream-json`은 SDK가 실제로 쓰는 포맷이다. `--verbose`와 결합해야 `stream_event`(토큰 델타) / `control_request` / `keep_alive` 같은 저수준 메시지까지 전달된다. `--verbose` 없으면 assistant/user/result/system 정도만 흐른다 (확인 — 위 `if (outputFormat==="stream-json" && verbose)` 가드).

`submitMessage`이 yield하는 메시지 타입(확인, [`extracted-functions.js:21007`](../../extracted-functions.js#L21007) 부근 `switch(a.type)`):

```
assistant / user / system(subtype: init|status|notification|api_retry|compact_boundary)
stream_event(message_start|message_delta|message_stop, ttft_ms?)
result(subtype: success|error_during_execution|error_max_turns
       |error_max_budget_usd|error_max_structured_output_retries
       |error_during_execution)
tool_use_summary / sdk_status→system.status / progress
```

`result` 메시지 스키마 (확인, `BU8` 빌더 [`extracted-functions.js:21058`](../../extracted-functions.js#L21058)~`21068`):

```
{
  type:"result", subtype, is_error, api_error_status?,
  duration_ms, duration_api_ms, ttft_ms?,
  num_turns, result /*텍스트*/, stop_reason,
  session_id, total_cost_usd, usage, modelUsage,
  permission_denials:[], structured_output?,
  terminal_reason /*runTurnLoop 종료 reason*/,
  fast_mode_state?, deferred_tool_use?, origin?, uuid,
  errors?[]   // 에러 subtype일 때
}
```

`terminal_reason`이 `runTurnLoop`(`runTurnLoop`)의 종료 reason(`completed`/`max_turns`/`prompt_too_long`/...)을 그대로 통과시킨다 — agent-loop.md §3.3과 직결되는 SDK 노출점.

### 2.2 양방향 control 프로토콜 — 메시지 봉투

채널 위를 흐르는 4종 제어 메시지 (확인):

```
{type:"control_request",  request_id, request:{subtype, ...}}        # 요청
{type:"control_response", response:{subtype:"success"|"error",
                                    request_id, response?|error?}}    # 응답
{type:"control_cancel_request", request_id}                          # 취소
{type:"keep_alive"}                                                  # 하트비트
```

방향이 **양쪽 다** 가능하다는 게 핵심:

- **SDK → CLI control_request**: `initialize`, `interrupt`, `set_model`, `set_permission_mode`, `set_max_thinking_tokens`, `mcp_status`, `mcp_message`, `get_context_usage`, `get_session_cost`, `get_binary_version`, `rewind_files`, `read_file`, `file_suggestions`, `cancel_async_message`, `end_session`, `seed_read_state` (inbound 디스패처 [`extracted-functions.js:21059`](../../extracted-functions.js#L21059)).
- **CLI → SDK control_request**: `can_use_tool`(퍼미션), `hook_callback`(SDK-정의 hook), `elicitation`(MCP), `request_user_dialog`, `mcp_message`(SDK MCP 서버 호출), `oauth_token_refresh` (`structuredIO.sendRequest` 발신자들, [`extracted-functions.js:20544`](../../extracted-functions.js#L20544)).

판별 가드 (확인, [`extracted-functions.js:17671`](../../extracted-functions.js#L17671)~`17672`):

```
isControlResponse(H) = H.type==="control_response" && "response" in H
isControlRequest(H)  = H.type==="control_request" && "request_id" in H && "request" in H
```

### 2.3 init 핸드셰이크 (`handleInitialize` / `tengu_sdk_init_handshake`)

SDK가 채널을 연 직후 `{type:"control_request", request:{subtype:"initialize", ...}}`을 보낸다. CLI는 `handleInitialize`(`sdkInitHandshake`)로 처리 (확인, [`extracted-functions.js:21068`](../../extracted-functions.js#L21068)):

요청에 실릴 수 있는 필드 (확인): `systemPrompt`, `appendSystemPrompt`, `planModeInstructions`, `appendSubagentSystemPrompt`, `toolAliases`, `excludeDynamicSections`, `promptSuggestions`, `forwardSubagentText`, `skills`, `agents`, `hooks`, `jsonSchema`, `title`, `sdkMcpServers`, `webSearchIsolationExemptMcpServers`, `agentProgressSummaries`.

처리:

```
handleInitialize(req, requestId, alreadyInit, outbound, commands, models, ...):
  if (alreadyInit)  → control_response error "Already initialized"
                       (+ pending_permission_requests 첨부)
  // 런타임 설정을 세션 state(A)에 머지
  A.systemPrompt / appendSystemPrompt / planModeInstructions / ... 갱신
  if (req.toolAliases) setAppState(toolPermissionContext.toolAliases 갱신)
  if (req.skills)  zV6(req.skills)            // SDK 제공 skill 등록
  if (req.agents)  agents.push(...jY_(...))   // SDK 정의 subagent 등록
  if (req.hooks)   각 hook → $.createHookCallback(callbackId, timeout) 등록
                    → b6H(변환된 hook 맵)      // SDK 정의 hook 활성화
  if (req.jsonSchema) KV6(req.jsonSchema)     // structured output 스키마

  // capabilities 응답 조립
  response = {
    commands:  [...userInvocable slash commands {name,description,argumentHint,aliases}],
    agents:    [...{name,description,model}],
    output_style, available_output_styles,
    models, account:{email,organization,subscriptionType,tokenSource,
                      apiKeySource,apiProvider}, pid:process.pid,
    fast_mode_state?   // z4()&&u2() 일 때
  }
  outbound.enqueue({type:"control_response",
                    response:{subtype:"success", request_id, response}})

  d("tengu_sdk_init_handshake", {
     uptime_ms: round(process.uptime()*1000),
     mcp_client_count, mcp_pending_count, mcpNonBlocking, session_mirror })
```

`sdkMcpServers`는 inbound 디스패처에서 별도 선처리: `for (s of req.sdkMcpServers) $[s] = {type:"sdk", name:s}` — 즉 SDK 프로세스 안에서 도는 MCP 서버를 등록하고, 이후 그 도구 호출은 CLI→SDK `mcp_message` control_request로 역marshalling된다 (확인, [`extracted-functions.js:21059`](../../extracted-functions.js#L21059)).

`tengu_sdk_init_handshake` 페이로드: `{uptime_ms, mcp_client_count, mcp_pending_count, mcpNonBlocking, session_mirror}` (확인).

### 2.4 canUseTool 콜백의 마샬링 (CLI → SDK 라운드트립)

이 프로토콜에서 가장 정교한 부분. CLI의 권한 시스템(permission-system.md, `decidePermission`)이 "사용자에게 물어봐야 한다"는 결론(`behavior:"ask"`)에 도달하면, 인터랙티브 다이얼로그 대신 **`can_use_tool` control_request를 SDK로 보내고 응답을 await** 한다.

`createCanUseTool()`가 반환하는 비동기 콜백 (확인, [`extracted-functions.js:20544`](../../extracted-functions.js#L20544)):

```
createCanUseTool() = async (tool, input, ctx, _, toolUseId, precomputed) => {
  // 1. 우선 로컬 결정 (precomputed ?? AM(...) = resolvePermissionDecision)
  let z = precomputed ?? await AM(tool, input, ctx, _, toolUseId)
  if (z.behavior === "allow") return z                  // 즉시 통과, RPC 없음
  if (z.behavior === "deny") {
     outbound.enqueue({type:"system", subtype:"permission_denied",
                       tool_name, tool_use_id, agent_id,
                       decision_reason_type, decision_reason, message})
     return z                                            // 즉시 거부, RPC 없음
  }
  // z.behavior === "ask" 인 경우만 SDK 라운드트립
  let suggestions = z.suggestions
  if (tool.name===Bash && input.command 문자열 && suggestions)
     suggestions = [...$DH(command), ...suggestions]     // bash 도메인 제안 보강

  // 2. 두 경로를 race: PermissionRequest hook  vs  SDK can_use_tool
  let hookP = wHO(tool,...).then(d=>({source:"hook",decision:d}))   // PermissionRequest hook
  let sdkP  = sendRequest({
        subtype:"can_use_tool",
        tool_name, display_name, input,
        description?, permission_suggestions, blocked_path,
        decision_reason, decision_reason_type,
        classifier_approvable,        // safetyCheck 존재 시 수동승인 필요 여부
        tool_use_id, agent_id
     }, /*응답스키마*/, abortSignal, requestId).then(r=>({source:"sdk",result:r}))

  let winner = await Promise.race([hookP, sdkP])
  if (winner.source==="hook" && winner.decision) {
     sdkP.catch(()=>{}); Y.abort()                       // SDK 요청 취소
     return winner.decision
  }
  let r = (winner.source==="hook") ? await sdkP : winner.result
  return htH(r, tool, input, ctx)                         // normalizeSdkDecision
}
```

`normalizeSdkDecision`(`htH`) (확인, [`extracted-functions.js:20534`](../../extracted-functions.js#L20534)): SDK가 돌려준 `{behavior:"allow"|"deny", updatedInput?, updatedPermissions?, interrupt?, message?}`를 내부 결정으로 변환. `allow` + `updatedPermissions`면 `mergePermissionRules`로 권한 규칙을 세션에 머지하고 `persistPermissionRules`로 디스크 영속화. `deny` + `interrupt:true`면 `ctx.abortController.abort()`로 즉시 턴 중단. 항상 `decisionReason:{type:"permissionPromptTool", permissionPromptToolName, toolResult}` 부착.

`can_use_tool` 요청 스키마 (확인, [`extracted-functions.js:20530`](../../extracted-functions.js#L20530), Zod `.describe()` verbatim):

```
{
  subtype:"can_use_tool", tool_name, input:Record<string,unknown>,
  permission_suggestions?:[...], blocked_path?, decision_reason?,
  decision_reason_type?:enum(su6)   // "Structured discriminator for why auto-mode
       // escalated. Lets SDK hosts make policy (e.g. auto-deny safetyCheck)
       // without parsing decision_reason text. For compound bash commands this
       // is 'subcommandResults' even when a safetyCheck is nested inside"
  classifier_approvable?:boolean    // "false = at least one safety check requires
       // manual approval (e.g. Windows path bypass, dangerous rm); true = all
       // safety checks MAY be classifier-approved"
  title?, display_name?, tool_use_id, agent_id?, description?
}
```

SDK 호스트가 `decision_reason` 텍스트를 파싱하지 않고도 `decision_reason_type`/`classifier_approvable` 만으로 정책 결정(예: safetyCheck면 자동 거부)을 내릴 수 있게 구조화한 것이 설계 의도(스키마 `.describe()`에 명시). 이는 auto-mode classifier(auto-mode-classifier.md)의 분류 결과를 SDK까지 노출하는 통로다.

라운드트립이 끝나면 `structuredIO.sendRequest`의 `finally`가 항상 `d("tengu_sdk_control_roundtrip", {subtype, duration_ms, aborted})` 를 emit (확인, [`extracted-functions.js:20544`](../../extracted-functions.js#L20544)). 즉 `can_use_tool`/`hook_callback`/`elicitation` 등 **모든** CLI→SDK 라운드트립 지연이 계측된다.

### 2.5 인터럽트 / 모드·모델 변경

inbound 디스패처(확인, [`extracted-functions.js:21059`](../../extracted-functions.js#L21059)):

- `interrupt`: `v.abort()` (현재 턴 AbortController) + `m.abortController?.abort()`(prompt-suggestion) → `runTurnLoop`이 `aborted_streaming`/`aborted_tools`로 종료. control_response success 즉시 회신.
- `set_permission_mode`: `setAppState(s => ({...s, toolPermissionContext: B7O(req, requestId, ctx, outbound), isUltraplanMode: req.ultraplan ?? ...}))`. `_KH()`(`permissionModeEnum`) 검증된 6모드 중 하나. 별도 `onPermissionModeChanged` 콜백이 변경 시 `{type:"system",subtype:"status",permissionMode}` 를 outbound로 푸시 → SDK가 모드 변경 사실을 확인.
- `set_model`: `model ?? "default"` → `"default"`면 `iM()` 기본, 아니면 그대로. `SZ(model)` + `notifyMetadataChanged({model})`. 실제 모델이 바뀌면 콜백으로 통지.
- `set_max_thinking_tokens`: `s = q64(req.max_thinking_tokens, o)` — 다음 턴 thinking 예산 조정 (agent-loop-thinking-effort.md 연계).
- `get_context_usage`: `XD6(...)` 호출로 카테고리별 토큰 분해(시스템 프롬프트/도구/메시지...) 응답 — 스키마 `AMj` (확인, 매우 상세: `categories/memoryFiles/mcpTools/systemPromptSections/messageBreakdown/apiUsage`).
- `end_session`: epoch 검사(`z64`) 후 stale면 무시, 아니면 `v.abort()` + 루프 `break`로 세션 종료.

### 2.6 stall 워치독 + schema-violation 샘플링

`structuredIO.trackWrite(H)`가 outbound 메시지를 쓸 때마다 두 워치독을 돌린다 (확인, [`extracted-functions.js:20543`](../../extracted-functions.js#L20543)):

```
trackWrite(H):
  clearTimeout(stallTimer)
  if (H.type !== "result" && !stallFired)
    stallTimer = setTimeout(lastType => {
       if (sessionState.getState() !== "running") return
       stallFired = true
       d("tengu_sdk_stall", {
          session_age_ms: now - createdAt,
          session_state, last_message_type:lastType,
          pending_control_requests: pendingRequests.size })
    }, AHO /*=300000ms=5분*/, H.type)
    stallTimer.unref()

  if (H.type !== "system" && Math.random() < YHO /*=0.01*/) {
    let r = EnK().safeParse(H)              // sdkOutMsgSchema union 검증
    if (!r.success)
       d("tengu_sdk_schema_violation", {
          message_type:H.type,
          error_path: r.error.issues[0]?.path.join(".") ?? "" })
  }
```

- **stall 검출**: 마지막 outbound가 `result`가 아닌데 5분(`AHO=300000`) 동안 다음 메시지가 안 나가고 세션이 여전히 `running`이면 `tengu_sdk_stall` emit. `result`를 쓰면 타이머가 리셋만 되고 안 건다(정상 종료). `resetStallWatchdog()`로 `stallFired` 해제 가능.
- **schema-violation 샘플링**: 1%(`YHO=0.01`) 확률로 outbound 메시지를 `sdkOutMsgSchema`(`EnK`, 8-멤버 union)로 검증. 불일치면 `tengu_sdk_schema_violation`에 `message_type` + 첫 issue의 `error_path`를 기록. SDK 계약 회귀를 프로덕션에서 모니터링하는 카나리.

상수(확인, [`extracted-functions.js:20547`](../../extracted-functions.js#L20547)): `$HO=1000`(resolvedToolUseIds LRU 캡), `zHO=30000`(oauth_token_refresh 타임아웃 ms), `AHO=300000`(stall 워치독 ms), `YHO=0.01`(schema 샘플 비율).

### 2.7 세션 크래시 복구

`printDriverLoop`(`A64`)의 outbound 태스크가 `try/catch`로 감싸여 있고 (확인, [`extracted-functions.js:21058`](../../extracted-functions.js#L21058) `catch(WH)`):

```
catch (WH) {
  d("tengu_sdk_session_crash", g7O(WH))            // 스택/메시지 직렬화
  if (!X) d("tengu_sdk_result", {subtype:"error_during_execution",
            is_error:true, num_turns:0, duration_ms:0, ...}), X=true
  try {
    if (sessionMirror) await dL()
    nG6(sessionState, PH(WH))
    await structuredIO.write({type:"result", subtype:"error_during_execution",
       is_error:true, num_turns:0, stop_reason:null, session_id,
       total_cost_usd:0, usage:$W, modelUsage:{}, permission_denials:[],
       errors:[PH(WH), ...aXH().map(e=>e.error)], uuid})  // SDK에 명시적 result 통보
  } catch {}
  await Promise.race([flushSessionState(), r6(5000,{unref:true})])  // 5초 내 플러시
  m.abortController?.abort()
  D4(1)                                              // exit code 1
  return
}
finally {
  await flushInternalEvents(); await flushDeliveryAcks() (5초 캡)
  sessionState.notifyStateChanged("idle")
}
```

크래시 시에도 SDK 쪽에 `result(error_during_execution)`를 **반드시 한 줄 써서** 통보 → SDK `query()`가 무한 대기에 빠지지 않게 한다. `tengu_sdk_session_crash` 페이로드는 `g7O(WH)`(예외 직렬화). 추가로 `SIGINT` 핸들러는 진행 중이면 `tengu_sdk_result{subtype:"terminated"}` 를 별도 emit (확인, [`extracted-functions.js:21043`](../../extracted-functions.js#L21043) `S9(async()=>{...})`).

### 2.8 TTFT 계측 (`tengu_sdk_ttft`)

`submitMessage`이 첫 assistant 메시지를 받은 시각을 기록한다 (확인, [`extracted-functions.js:21007`](../../extracted-functions.js#L21007) 부근):

```
let c = 0   // first-assistant timestamp
...
case "assistant": if (!c) c = Date.now(); ...
...
// 최종 result emit 직전
if (!__/*에러아님*/ && c) d("tengu_sdk_ttft", {ttft_ms: c - Q, model: String(K_)})
yield {type:"result", ..., ttft_ms: !__&&c ? c - Q : undefined, ...}
```

`Q`=submitMessage 시작 시각. `tengu_sdk_ttft = {ttft_ms, model}` 는 사용자 프롬프트 수신부터 첫 assistant 토큰까지의 체감 지연. 에러로 끝나면 emit 안 함. `result.ttft_ms`로도 SDK에 그대로 노출. (별도로 `printDriverLoop`은 `stream_event.message_start.ttftMs`로 API 수준 TTFT를 `pushApiMetricsEntry`에 적재 — [`extracted-functions.js:14064`](../../extracted-functions.js#L14064), 이건 API 메트릭이고 위 `tengu_sdk_ttft`와 별개.)

### 2.9 REPL bridge 변종 (원격 제어)

claude.ai/모바일 원격 제어용 별도 채널이 같은 봉투 포맷을 재사용한다 (확인, `bridgeHandleControlRequest`(`FGK`) [`extracted-functions.js:17676`](../../extracted-functions.js#L17676)). inbound control_request를 `transport.write`로 응답하며 동일 subtype 집합(`initialize`/`set_model`/`set_permission_mode`/`set_color`/`rename_session`/`file_suggestions`/`read_file`/`mcp_status`/`mcp_authenticate`/`mcp_oauth_callback_url`/`mcp_reconnect`/`interrupt`)을 처리. `outboundOnly` 세션은 `initialize` 외 모든 inbound를 `error: "This session is outbound-only. Enable Remote Control locally to allow inbound control."`(`lh3`)로 거부. ingress 측 `bridgeIngress`(`UGK`)는 echo/재전달 dedup 링버퍼(`aaH`)로 중복 메시지를 거른다. background-daemon-teammate.md의 원격 브릿지와 같은 계열.

---

## 3. State / Schema

### 3.1 `structuredIO`(`yR_`) 인스턴스 상태 (확인, [`extracted-functions.js:20542`](../../extracted-functions.js#L20542))

| 필드 | 타입 | 의미 |
|---|---|---|
| `input` | AsyncIterable | stdin 원시 청크 |
| `structuredInput` | AsyncGenerator | `read()` — newline-split → `processLine` → 파싱된 메시지 |
| `pendingRequests` | `Map<requestId, {request,resolve,reject,schema}>` | in-flight CLI→SDK control_request |
| `outbound` | `Pn` 큐 | stdout으로 나갈 메시지 큐 (`enqueue`/`done`) |
| `resolvedToolUseIds` | `Set` (LRU 캡 `$HO=1000`) | 중복 `can_use_tool` 응답 무시용 |
| `stallTimer`/`stallFired` | Timer/bool | §2.6 stall 워치독 |
| `createdAt` | number | 세션 생성 시각 (stall age 계산) |
| `inputClosed` | bool | stdin EOF — 닫히면 pending 전부 reject |
| `replayUserMessages` | bool | `--replay-user-messages` 모드 |
| `sessionState` | `NR_` | running/idle/requires_action 상태 머신 |
| `onControlRequestSent`/`Resolved`/`onCommandLifecycle` | cb | 라이프사이클 훅 |

### 3.2 control_request subtype 카탈로그

**SDK → CLI** (inbound, 확인 [`extracted-functions.js:21059`](../../extracted-functions.js#L21059); Zod 스키마 [`extracted-functions.js:20530`](../../extracted-functions.js#L20530)):

| subtype | request 필드 | 응답 |
|---|---|---|
| `initialize` | systemPrompt/agents/hooks/skills/jsonSchema/sdkMcpServers/title/... | capabilities {commands,agents,models,account,pid,...} |
| `interrupt` | — | success (즉시) |
| `set_permission_mode` | `mode`(6모드), `ultraplan?` | success |
| `set_model` | `model?` | success (변경 시 status 푸시) |
| `set_max_thinking_tokens` | `max_thinking_tokens:number\|null` | success |
| `rename_session` | `title` | success (bridge) |
| `set_color` | `color` | success (bridge) |
| `mcp_status` | — | `{mcpServers:[...]}` |
| `mcp_message` | `server_name, message` | success (SDK MCP 서버로 전달) |
| `get_context_usage` | — | 토큰 분해 `AMj` 스키마 |
| `get_session_cost` | — | `{text}` (ANSI-stripped) |
| `get_binary_version` | — | `{version, buildTime?}` |
| `rewind_files` | `user_message_id, dry_run?` | rewind 가능 여부 |
| `read_file` | `path, max_bytes?, encoding?` | 파일 내용 |
| `file_suggestions` | `query` | `{suggestions:[{path,score?}]}` |
| `seed_read_state` | `path, mtime` | readFileState 시드 |
| `cancel_async_message` | `message_uuid` | `{cancelled}` |
| `end_session` | `reason?` | success → 루프 종료 |

**CLI → SDK** (outbound, 확인 [`extracted-functions.js:20544`](../../extracted-functions.js#L20544) / `17828`):

| subtype | request 필드 | 응답 스키마 |
|---|---|---|
| `can_use_tool` | tool_name/input/decision_reason_type/classifier_approvable/permission_suggestions/blocked_path/tool_use_id/agent_id | `{behavior, updatedInput?, updatedPermissions?, interrupt?, message?}` |
| `hook_callback` | `callback_id, input, tool_use_id?` | hook 결과 (`ysH()`) |
| `elicitation` | mcp_server_name/message/mode/url/elicitation_id/requested_schema/title | `{action,...}` (실패 시 `{action:"cancel"}`) |
| `request_user_dialog` | dialog_kind/payload/tool_use_id | `{behavior}` (실패 `{behavior:"cancelled"}`) |
| `mcp_message` | server_name/message | `{mcp_response}` |
| `oauth_token_refresh` | — | `{accessToken}` (timeout `zHO=30000`) |

### 3.3 control_response 스키마 (확인)

```
성공: {type:"control_response",
       response:{subtype:"success", request_id, response?:any}}
실패: {type:"control_response",
       response:{subtype:"error", request_id, error:string,
                 pending_permission_requests?:[...]}}
```

`structuredIO.processLine`/`injectControlResponse`이 `request_id`로 `pendingRequests` 매칭 → 등록된 Zod `schema`로 `response.response` 파싱 (실패 시 reject) → await 깨움. 매칭 후 `{type:"control_cancel_request", request_id}`을 다시 써서 SDK에 "처리 완료, 취소 불필요" 통지 (확인). 응답 못 찾으면 `resolvedToolUseIds`에 이미 있으면 무시(중복), 아니면 `unexpectedResponseCallback`.

### 3.4 SDK 텔레메트리 이벤트 (확인, [`extracted-functions.js:5735`](../../extracted-functions.js#L5735) 카탈로그)

| 이벤트 | 페이로드 | 발생 |
|---|---|---|
| `tengu_sdk_init_handshake` | uptime_ms, mcp_client_count, mcp_pending_count, mcpNonBlocking, session_mirror | `handleInitialize` 완료 |
| `tengu_sdk_control_roundtrip` | subtype, duration_ms, aborted | 모든 CLI→SDK control_request 종료(`finally`) |
| `tengu_sdk_result` | subtype, is_error, num_turns, duration_ms, duration_api_ms, saw_retry, saw_compact, retry_status, api_error_status | 각 query 종료 / SIGINT(`terminated`) / 크래시 |
| `tengu_sdk_schema_violation` | message_type, error_path | outbound 1% 샘플이 `sdkOutMsgSchema` 위반 |
| `tengu_sdk_session_crash` | (예외 직렬화 `g7O`) | outbound 태스크 throw |
| `tengu_sdk_stall` | session_age_ms, session_state, last_message_type, pending_control_requests | 5분 무출력 + running |
| `tengu_sdk_ttft` | ttft_ms, model | 첫 assistant 수신 (에러 아닐 때) |

`run_phase`(`Z`) 값: `init` → `draining_commands` → `waiting_for_agents` → `finally_flush` → `finally_post_flush` (확인) — 크래시/종료 시 어느 단계였는지 식별.

---

## 4. 차이점 / 아키텍처 함의

v0.2.8에는 이 양방향 채널이 사실상 없었다(`--print`가 단방향 텍스트/JSON 덤프에 가까웠음). v2.1.143의 변화:

| 영역 | v0.2.8 | v2.1.143 |
|---|---|---|
| 채널 | stdout 단방향 (text/json) | stdin↔stdout 풀-듀플렉스 NDJSON RPC (`stream-json`) |
| 퍼미션 | 인터랙티브 다이얼로그 또는 `--dangerously-skip` | `can_use_tool` control_request로 SDK에 위임, hook과 `Promise.race` |
| canUseTool 결정 노출 | 없음 | `decision_reason_type`+`classifier_approvable`로 auto-mode classifier 결과 구조화 노출 |
| 런타임 제어 | 불가 | `set_model`/`set_permission_mode`/`set_max_thinking_tokens`/`interrupt`를 실행 중 주입 |
| SDK MCP | 별도 stdio 서버 spawn | `initialize.sdkMcpServers` 등록 → `mcp_message` 역호출로 SDK 프로세스 내부에서 도구 실행 |
| SDK hook | 없음 | `initialize.hooks` → `hook_callback` control_request 역호출 |
| 관측성 | 거의 없음 | init/roundtrip/result/ttft/stall/schema/crash 7종 전용 텔레메트리 |
| 크래시 처리 | 프로세스 죽으면 SDK 무한대기 | `result(error_during_execution)` 강제 통보 + 5초 플러시 캡 |
| 출력 메시지 | text or 단일 json | `result`에 `terminal_reason`/`num_turns`/`structured_output`/`fast_mode_state`/`permission_denials` 풍부 |

### "기깔나는" 포인트

1. **퍼미션이 IPC 콜백이다.** `decidePermission`이 `ask`를 내면 CLI는 멈추고 stdout으로 `can_use_tool`을 쏜 뒤 stdin에서 결정을 기다린다. SDK 호스트(파이썬/TS)가 임의 비동기 로직(웹훅, DB, 사람 승인)으로 답할 수 있다. 게다가 같은 결정을 `PermissionRequest` hook과 **레이스**시켜 먼저 끝나는 쪽을 채택하고 다른 쪽을 `control_cancel_request`로 취소한다 (확인).

2. **SDK MCP 서버의 역마샬링.** `sdkMcpServers`로 등록된 서버의 도구를 모델이 호출하면, CLI는 그 도구를 직접 실행하지 못하므로 `mcp_message` control_request로 **SDK 프로세스에 실행을 위임**하고 JSON-RPC 메시지를 그대로 터널링한다 (`OH.client.transport.onmessage(message)`, 확인). 즉 도구 실행 주체가 프로세스 경계를 넘는다.

3. **schema-violation 카나리.** 자기 출력의 1%를 자기 스키마로 재검증해 위반을 텔레메트리로 보낸다 — SDK 계약(타입) 드리프트를 프로덕션에서 조기 탐지하는 self-monitoring.

4. **stall 워치독의 의미론적 정확성.** 단순 타이머가 아니라 "마지막 메시지가 `result`가 아니고(=아직 끝나지 않았고)" + "세션이 여전히 `running`" 두 조건을 모두 봐서, 정상적으로 idle/완료된 세션을 stall로 오탐하지 않는다 (확인).

### 추정 / 확인 필요

- `outputFormat==="text"` 의 정확한 emit 본체: `switch`에 `case "json"`만 명시 추출되고 `text`/`stream-json`은 fall-through 또는 인접 분기로 보임. `text`가 `x`(마지막 result)의 `.result` 텍스트만 출력한다는 것은 인접 코드/관례로 **추정**.
- `submitMessage`이 `sdkSession`(`m_4`) 클래스 메서드인지 `p_4`라는 별도 래퍼를 거치는지: `printDriverLoop`은 `p_4({...})`를 호출하고 `m_4`는 `submitMessage` async gen을 가짐. 둘의 정확한 연결(`p_4`가 `m_4` 인스턴스를 감싸는지)은 **추정** (호출 시그니처는 일치 확인).
- `decision_reason_type` enum(`su6`)의 전체 값 목록은 본 추출에서 미해석 — auto-mode-classifier.md의 분류 카테고리와 교차검증 필요.
- bridge 변종(`FGK`)과 메인 stdio(`yR_`)가 동일 프로세스에서 동시 활성될 수 있는지는 미확인 (코드상 별도 진입 — `--sdk-url` 유무로 갈리는 것으로 **추정**).
