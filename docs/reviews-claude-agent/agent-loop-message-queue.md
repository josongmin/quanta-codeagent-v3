# Bq3 turn-end mechanisms — `SnH` / refresh / maxTurns / taskBudget

`runTurnLoop` (turn loop) 본문의 마지막 ~1/4 구간(스트림 종료 → tool batch → `continue` 직전)에서 일어나는 4개의 end-of-turn 메커니즘을 분리해서 본다. agent-loop.md 의 §2 의사코드의 마지막 단계를 정밀화한 문서. 메인 문서: [agent-loop.md](agent-loop.md).

## 1. 호출 그래프

```
Bq3 (turn loop) — end-of-turn 단계
│
├─ tool batch 실행 / PostToolBatch hook (qP_)
│
├─ messageQueue 처리                       ← (A)
│    ├─ Z.messageQueue.getCommandsByMaxPriority("next")
│    │    └─ filter: !Nc9 (slash 아님) + agentId 매칭
│    ├─ for await of SnH(null, dH, null, RH, [...x,...wH,...JH], z)
│    │    └─ B93(H,_,q,K,O,T,$)          (line 14251)
│    │         ├─ Lw6(K, model)           queued_commands attachment
│    │         ├─ o$("date_change", ...)
│    │         ├─ o$("deferred_tools_delta", ...)
│    │         ├─ o$("nested_memory", ...)
│    │         ├─ o$("dynamic_skill", ...)
│    │         ├─ o$("skill_listing", ...)
│    │         ├─ o$("plan_mode", ...)
│    │         ├─ o$("auto_mode", ...)
│    │         ├─ o$("todo_reminders", ...)
│    │         ├─ o$("agent_pending_messages", ...)
│    │         ├─ o$("critical_system_reminder", ...)
│    │         ├─ [main-thread only] ide_selection, ide_opened_file,
│    │         │   output_style, diagnostics, lsp_diagnostics,
│    │         │   unified_tasks, async_hook_responses,
│    │         │   memory_update, token_usage, budget_usd,
│    │         │   output_token_usage, verify_plan_reminder,
│    │         │   thinking_reminder
│    │         └─ d("tengu_attachments", {attachment_types: [...]})
│    └─ messageQueue.remove(processedPrompts)   pH = filter mode === "prompt"|"task-notification"
│         └─ onCommandLifecycle(uuid, "started")
│
├─ memdir prefetch flush (using P / ga7)   already documented in agent-loop.md §3.5
│
├─ skill discovery prefetch flush  (Uy8().collectSkillDiscoveryPrefetch)
│
├─ refreshTools / refreshMcpClients         ← (B)
│    ├─ dh.options.refreshTools?.()
│    │    └─ d("tengu_mcp_tools_refreshed_mid_turn", ...) if MCP count changed
│    └─ dh.options.refreshMcpClients?.()
│
├─ maxTurns 검사                            ← (C)
│    │  oH = C + 1 (turnCount + 1)
│    └─ if (Y /*maxTurns*/ && oH > Y)
│         yield {type:"max_turns_reached", maxTurns:Y, turnCount:oH}
│         return {reason:"max_turns", turnCount:oH}
│
└─ D = {... turnCount:oH, transition:undefined ...}; continue
                                           ↑
        taskBudget 차감(f)은 D 재할당 직전이 아니라 compaction 성공 직후 일어남 ← (D)
```

(A)/(B)/(C)/(D) 표시는 §2 의사코드 라벨과 동일.

호출 사이트 확인 (`extracted-functions.js` 14057 라인 내부 offset 기준 단일 줄 검색 결과):

| 호출 | 위치 (라인 14057 내부 offset) |
|---|---|
| `Z.messageQueue.getCommandsByMaxPriority("next")` | 한 곳 |
| `SnH(null, dH, null, RH, ...)` | 한 곳 (turn-end) |
| `dh.options.refreshTools?.()` | 두 곳: tool 결과 처리 시 `i0(...)` 의 `Z.options.refreshTools?.() ?? Z.options.tools` (image inject 용) + turn-end `if (dH.options.refreshTools)` |
| `dh.options.refreshMcpClients?.()` | 한 곳 (turn-end 만) |
| `RA8(x)` (taskBudget 차감) | 두 곳: autocompact 성공 직후 + reactive compact 성공 직후 |
| `max_turns_reached` yield | 세 곳: stop hook block 분기, aborted_tools 분기 (informational only), 정상 turn-end |

주요 정의:

| 함수 / 식별자 | 정의 위치 | 역할 |
|---|---|---|
| `SnH(H,_,q,K,O,T,$)` | [`extracted-functions.js:14323`](../../extracted-functions.js#L14323) | `makeSystemReminderAttachment` 호출 후 attachment yield. 7-arg async generator. |
| `B93(H,_,q,K,O,T,$)` | [`extracted-functions.js:14251`](../../extracted-functions.js#L14251) | turn-end attachment 빌더 (queued_commands / IDE / memory / skill / mode / token usage / …) |
| `Lw6(queued, model)` | [`extracted-functions.js:14255`](../../extracted-functions.js#L14255) | queued prompts → `queued_commands` attachment 변환 |
| `Nc9(cmd)` | [`extracted-functions.js:8117`](../../extracted-functions.js#L8117) | `value.startsWith("/") && !skipSlashCommands` predicate (slash command 필터) |
| `U93` | [`extracted-functions.js:14352`](../../extracted-functions.js#L14352) | `Set(["prompt","task-notification"])` — `Lw6` 가 처리하는 모드 |
| `l_5()` factory | [`extracted-functions.js:8121`](../../extracted-functions.js#L8121) | messageQueue 본체 (in-memory singleton `WA = l_5()`) |
| `TH6` | [`extracted-functions.js:8143`](../../extracted-functions.js#L8143) | `{now:0, next:1, later:2}` priority 순서 |
| `g_5` | [`extracted-functions.js:8143`](../../extracted-functions.js#L8143) | `Set(["task-notification"])` — `getMainThreadQueueLength` 가 제외할 모드 (정확히는 `w()` filter 안쓰임 — 추정용) |
| `RA8(messages)` | [`extracted-functions.js:8504`](../../extracted-functions.js#L8504) | 가장 최근 assistant 메시지의 usage 에서 `input+output` 토큰 합 |
| `wYH(msg)` | [`extracted-functions.js:8500`](../../extracted-functions.js#L8500) | usage 추출 — `lz_` 에 포함된 placeholder text 거르고 model !== `jG` 만 |
| `Wn(messages)` / `cz_(usage)` | [`extracted-functions.js:8503`](../../extracted-functions.js#L8503), [`8502`](../../extracted-functions.js#L8502) | RA8 의 sister — `input + cache_creation + cache_read + output` 전체 합 (RA8 와 달리 caching 포함) |
| `i0(messages, tools, model)` | [`extracted-functions.js:15542`](../../extracted-functions.js#L15542) | image inject — tool 결과에 deferred-tool 응답에 들어있는 image 를 user 메시지 attachment 로 변환. `refreshTools?.() ?? tools` 사용 |
| `mJH(ctx, querySource)` | [`extracted-functions.js:14051`](../../extracted-functions.js#L14051) | turn aborted/end 마커 (`u4H().markTurnAborted`) — REPL main thread + non-subagent 만 |
| `Ijq` | [`extracted-functions.js:3565`](../../extracted-functions.js#L3565) | SessionEnd hook `reason` enum (`clear/resume/logout/prompt_input_exit/other/bypass_permissions_disabled`) — **messageQueue 와 무관**, SessionEnd 만 사용 |

## 2. 핵심 로직 (의사코드)

### 2.1 (A) messageQueue 드레이닝 — turn-end 직후

```
// 1) 어떤 큐를 빨아들일지 결정 — querySource 따라 분기
let isMainThread = querySource.startsWith("repl_main_thread") || querySource === "sdk"
let myAgentId   = ctx.agentId
let queuedCommands = ctx.messageQueue.getCommandsByMaxPriority("next").filter(cmd => {
  if (Nc9(cmd)) return false                                    // ── 슬래시 명령은 제외
  if (isMainThread) return cmd.agentId === undefined             // main: 자기 agentId 없는 것만
  return cmd.mode === "task-notification" && cmd.agentId === myAgentId  // subagent: 자기 한정 task-notification 만
})

// 2) SnH 가 B93 (turn-end attachments) 을 yield — queued_commands 가 그중 하나
let appendedAttachments = []
for await (const event of SnH(null, dh, null, queuedCommands,
                              [...msgs, ...collectedAssistant, ...collectedToolResults],
                              querySource)) {
  yield event                                                    // 스트림에 흘림
  appendedAttachments.push(event)                                // 다음 턴 messages 에도 합산
}

// 3) 처리한 큐 항목 제거 + lifecycle 알림
let processedPrompts = queuedCommands.filter(c =>
  c.mode === "prompt" || c.mode === "task-notification")
for (const cmd of processedPrompts) {
  if (cmd.uuid) {
    lifecycleUuids.push(cmd.uuid)                                // _ array (caller 추적)
    ctx.onCommandLifecycle?.(cmd.uuid, "started")
  }
}
ctx.messageQueue.remove(processedPrompts)
```

`getCommandsByMaxPriority("next")` 가 리턴하는 것 (소스 [`8143`](../../extracted-functions.js#L8143)):

```
function E(prio) {
  let limit = TH6[prio]              // "next" → 1
  return H.filter(c => TH6[c.priority ?? "next"] <= limit)
}
```

즉 `"now"` (0) 와 `"next"` (1) 둘 다 포함, `"later"` (2) 는 제외. 큐에 남기는 것 (다음 turn-end에서 다시 노출됨).

### 2.2 `SnH` / `makeSystemReminderAttachment` 가 yield 하는 attachment 종류 (`tengu_attachments` 텔레메트리 라벨)

`makeSystemReminderAttachment` 의 `o$(label, fn)` 호출 라벨 = attachment.type. 전체 목록 (소스 [`14251`](../../extracted-functions.js#L14251) 확인):

| 라벨 | 어디서나 (`j = !ctx.agentId` 분기) | 트리거 |
|---|---|---|
| `at_mentioned_files` | both (H 가 있을 때만) | 사용자 입력에 `@path` 멘션 |
| `mcp_resources` | both (H) | 입력에 `@mcp:` 리소스 |
| `agent_mentions` | both (H) | 입력에 `@agent:` 멘션 |
| `queued_commands` | both | 큐된 prompt/task-notification 처리 |
| `date_change` | both | 날짜 바뀜 |
| `ultrathink_effort` | both (H) | "ultrathink" 키워드 |
| `deferred_tools_delta` | both | tool deferred 활성화 변화 |
| `agent_listing_delta` | both | activeAgents 변화 |
| `mcp_instructions_delta` | both | MCP 서버 instructions 변화 |
| `changed_files` | both | watcher가 잡은 파일 변경 |
| `nested_memory` | both | 새 CLAUDE.md 발견 |
| `dynamic_skill` | both | 새 skill 디렉터리 |
| `skill_listing` | both | skill 목록 변화 |
| `plan_mode` | both | plan mode 진입 |
| `plan_mode_exit` | both | plan mode 종료 |
| `auto_mode` | both | auto mode 진입 |
| `auto_mode_exit` | both | auto mode 종료 |
| `todo_reminders` | both | TodoWrite 상태 |
| `teammate_mailbox` | both (`K7()` ON) | 팀메이트 메일박스 |
| `team_context` | both (`K7()` ON) | 팀 컨텍스트 |
| `agent_pending_messages` | both | subagent 보낸 메시지 |
| `critical_system_reminder` | both | ctx.criticalSystemReminder_EXPERIMENTAL |
| `ide_selection` | main only | IDE 현재 선택 |
| `ide_opened_file` | main only | IDE 활성 파일 |
| `output_style` | main only | output 스타일 변경 |
| `diagnostics` | main only | linter |
| `lsp_diagnostics` | main only | LSP |
| `unified_tasks` | main only | task store |
| `async_hook_responses` | main only | 비동기 hook 결과 |
| `memory_update` | main only | 메모리 갱신 |
| `token_usage` | main only | token usage 리포트 |
| `budget_usd` | main only | `maxBudgetUsd` 사용량 |
| `output_token_usage` | main only | output token 사용량 |
| `verify_plan_reminder` | main only | plan 확인 |
| `thinking_reminder` | main only | thinking 사용량 |

**main only** 라벨 = subagent ctx 에서는 안 만들어진다 (`j = !ctx.agentId` 분기 OFF). 즉 subagent 의 turn-end 는 IDE/diagnostic/LSP/token-usage attachment 가 없다 — 확인.

비활성화 escape hatch (`extracted-functions.js:14251`):
```
if (xH(process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS) || xH(process.env.CLAUDE_CODE_SIMPLE))
  return Lw6(K, z)                                    // queued_commands 만 처리
```

또한 전체 attachment 빌더에 **1초 timeout** 적용 (`setTimeout(z=>z.abort(), 1000, A)`) — 1s 안에 안 끝나면 AbortController 로 잘림. 확인.

### 2.3 (B) refreshTools / refreshMcpClients

```
if (dh.options.refreshTools) {
  let newTools = dh.options.refreshTools()                       // 새 tool[] 동기 리턴
  if (newTools !== dh.options.tools) {                           // 참조 비교
    let oldMcpCount = countMcp(dh.options.tools)                 // tools.filter(t => !!t.mcpInfo).length
    let newMcpCount = countMcp(newTools)
    if (oldMcpCount !== newMcpCount)
      d("tengu_mcp_tools_refreshed_mid_turn", {
        oldMcpCount, newMcpCount,
        recovered: oldMcpCount === 0 && newMcpCount > 0           // 0 → N: 복구
      })
    dh = { ...dh, options: { ...dh.options, tools: newTools } }
  }
}
if (dh.options.refreshMcpClients) {
  let newClients = dh.options.refreshMcpClients()
  dh = { ...dh, options: { ...dh.options, mcpClients: newClients } }
}
```

특이점:

- **refreshMcpClients 는 차분 비교 없이 무조건 교체** — refreshTools 만 `newTools !== dh.options.tools` 참조 동등 검사. 확인.
- 새 `dh` 객체는 turn-end의 D 재할당 시 `eH = {...dh, queryTracking:p}` 형태로 다음 턴의 `toolUseContext` 가 됨. 즉 hot-reload 가 **다음 턴부터** 반영. 확인.
- 한 가지 추가 위치 (`expandAttachments` 안): tool 결과를 image 로 변환할 때 `dh.options.refreshTools?.() ?? dh.options.tools` 를 사용 — 즉 stream 도중에도 fresh tool 리스트로 image inject 가능 — 확인. (telemetry 안 보냄.)
- REPL 의 refreshMcpClients 구현 (line 20703): `() => HR_(Y, $H.getState().mcp.clients)` — Zustand 스토어의 mcp.clients 슬라이스 + helper.
- SDK 의 refreshMcpClients 구현 (line 21007 부근): `() => [...z().mcp.clients, ...JH, ...zH.clients]` — 정적 init + dynamic 추가.

### 2.4 (C) maxTurns 정확 정산표

`turnCount` 는 `D.turnCount` 로 carry. 초기값 `1` (Bq3 진입 시).

각 `continue` / `return` 분기에서의 turnCount 변화 (전수 검사, **확인**):

| 분기 | `transition.reason` | turnCount 변화 | maxTurns 검사 여부 |
|---|---|---|---|
| Bq3 진입 | — | 초기 `1` | 검사 안 함 (첫 턴) |
| 내부 `FallbackTriggeredError` (model fallback) catch — 같은 inner-while 재시작 | (변경 없음, same turn) | 변화 없음 | 검사 안 함 |
| reactive compact 성공 → `D = {...,turnCount:C}; continue` | `precomputed_compact_swap` or `reactive_compact_retry` | 그대로 carry | 검사 안 함 |
| max_output_tokens 복구 → `D = {...,turnCount:C}; continue` | `max_output_tokens_recovery` | 그대로 carry | 검사 안 함 |
| malformed tool_use 재시도 → `D = {...,turnCount:C}; continue` | `malformed_tool_use_retry` | 그대로 carry | 검사 안 함 |
| Stop hook blocking, 정상 → `D = {...,turnCount:nextTurnCount}; continue` | `stop_hook_blocking` | **+1** (`b_ = C+1`) | **검사**: `if (Y && b_ > Y) return max_turns` |
| Stop hook blocking, cap 초과 (`B_ > p_`, 기본 8) | (없음, terminate) | (cap 초과시 +1 후 종료, 단 hit_cap=true 텔레메트리) | (검사 후 cap 우선) |
| aborted_tools (signal.aborted 한 tool exec) | (없음, terminate) | `T_=C+1` 계산만, yield `max_turns_reached` event(만약 초과면) 후 `aborted_tools` 종료 | **informational only** — `return reason: "aborted_tools"` |
| 정상 next_turn (tool exec → next turn) | `next_turn` | **+1** (`oH = C+1`) | **검사**: `if (Y && oH > Y) return max_turns` |

소스 인용 (`extracted-functions.js:14057` 단일 줄 내):

```js
// Stop hook block 분기:
let b_ = C+1, B_ = I+1
if (Y && b_ > Y)
  return d("tengu_stop_hook_block_count", {count:B_, ..., hit_max_turns:true, hit_cap:false}),
         yield T9({type:"max_turns_reached", maxTurns:Y, turnCount:b_}),
         {reason:"max_turns", turnCount:b_}

// 정상 next-turn 분기:
let oH = C+1
if (Y && oH > Y)
  return yield T9({type:"max_turns_reached", maxTurns:Y, turnCount:oH}),
         mJH(Z,z),
         {reason:"max_turns", turnCount:oH}

// aborted_tools 분기:
let T_ = C+1
if (Y && T_ > Y)
  yield T9({type:"max_turns_reached", maxTurns:Y, turnCount:T_})
return mJH(Z,z), {reason:"aborted_tools"}                       // ← 종료 reason 은 abort 우선
```

확인 포인트:

- **maxTurns 검사는 3곳**: stop hook block 분기, aborted_tools 분기 (informational), 정상 next_turn 분기. autocompact / reactive compact / max_output_tokens recovery / malformed retry / model fallback 5개 분기는 검사 안 함.
- aborted_tools 의 경우 reason 은 `"aborted_tools"` 로 유지되고 `max_turns_reached` 이벤트는 정보용으로만 yield (UI에 표시되게).
- 초과 시 yield 되는 `max_turns_reached` 이벤트 형태:
  ```
  T9({type: "max_turns_reached", maxTurns: Y, turnCount: nextTurnCount})
  ```
  `T9(payload)` = SDK 메시지 wrapping helper.
- return value: `{reason: "max_turns", turnCount: nextTurnCount}` (정상/stop block) 또는 `{reason: "aborted_tools"}` (abort 우선).

기본값:

- `maxTurns` 는 caller (`H.maxTurns`) 가 명시할 때만 활성화. undefined 면 `Y` 가 undefined → `Y && oH > Y` 가 false → 무한 (사용자가 abort 할 때까지).
- SDK/CLI 진입점에서 `--max-turns <n>` flag (line 5778, 7834, 8353, 9257 등 — 다수 진입점) → caller-side 에서 `maxTurns: n` 으로 전달.
- 서브에이전트(`runAgent` → Bq3) 의 경우 거의 항상 `maxTurns` 가 설정됨 (line 9847 `subagent runner` 참조 — `maxTurns` 가 명시 전달). 무한 재귀 방지.

### 2.5 (D) taskBudget 차감 (`f = remaining`)

Bq3 변수 초기화:
```
let f = void 0                              // remaining; 첫 차감 시 lazy 초기화
```

차감 사이트 2곳, 둘 다 **compaction 성공 직후**:

**사이트 1 — autocompact (tier 2) 성공 후**:
```js
if (H.taskBudget) {
  let B_ = RA8(x)                            // x = 현재(compact 직전) messages
  f = Math.max(0, (f ?? H.taskBudget.total) - B_)
}
F = { compacted:true, turnId:J.uuid(), turnCounter:0, ... }
let b_ = AKH(e); for (const B_ of b_) yield B_
x = b_                                       // messages 를 compact 결과로 교체
```

**사이트 2 — reactive compact (tier 3, `reactiveCompactPhaseB` phase B) 성공 후**:
```js
if (compactResult) {
  if (H.taskBudget) {
    let a = RA8(x)
    f = Math.max(0, (f ?? H.taskBudget.total) - a)
  }
  let __ = AKH(compactResult)
  // ... messages 교체, D 갱신
}
```

**RA8 의 동작** (`extracted-functions.js:8504`, **확인**):
```js
function RA8(H) {
  let _ = H.length - 1
  while (_ >= 0) {
    let q = H[_], K = q ? wYH(q) : void 0   // wYH: msg.message.usage if assistant + valid
    if (K) {
      let O = K.iterations
      if (O && O.length > 0) {
        let T = O.at(-1)
        return T.input_tokens + T.output_tokens
      }
      return K.input_tokens + K.output_tokens
    }
    _--
  }
  return 0
}
```

즉 RA8 는:
- 메시지 배열 뒤에서부터 첫 번째 **valid assistant message 의 usage** 를 찾고,
- 그 usage 가 `iterations` 배열을 가지면 **마지막 iteration 의 input+output**,
- 없으면 그 usage 자체의 input+output 을 리턴.
- **cache_read / cache_creation 은 포함하지 않음** (`Wn`/`cz_` 와 차별점).

따라서 `f` 차감 의미: "이번 compaction 직전 마지막 모델 호출에서 사용한 raw 토큰" 만큼 budget 깎임. **누적 sum 이 아니라 가장 최근 호출분만**. 추정: compact 전후 모델이 보는 토큰 양을 기준으로 한 단위 차감 — 실제로는 매 턴이 아니라 **compact 가 발생한 턴**에만 차감되므로 정확한 누적은 아니다. (이게 의도된 동작인지 버그성인지는 미확인.)

**callModel 로 전달**:
```js
J.callModel({
  ...,
  options: {
    ...,
    ...(H.taskBudget && {
      taskBudget: {
        total: H.taskBudget.total,
        ...(f !== void 0 && { remaining: f })       // f 가 undefined 면 remaining 생략
      }
    })
  }
})
```

`f === void 0` (첫 호출 / 한 번도 compact 안 일어남) 이면 `remaining` 필드 자체 없음 → API body 의 `output_config.task_budget` 에는 `total` 만 들어감. 확인.

**`f === 0` 일 때 자체 종료?** Bq3 본문에 `if (f === 0)` 같은 조건 없음. 즉 0이 되어도 Bq3 가 종료하지 않고 그대로 `remaining: 0` 을 서버로 보낸다. **서버 측 (Anthropic API beta `task-budgets-2026-03-13`) 이 어떻게 처리하는지는 본 추출본의 범위 밖** — 시스템 프롬프트에 "running countdown 을 모델이 보고 self-moderate" 라는 문구가 있음 (line 4153 부근). 즉 budget 0 → 모델이 알아서 짧게 응답하도록 유도되는 형태. 추정.

**`task_budget` CLI flag** (line 19033 부근):
```
--task-budget <tokens>   API-side task budget in tokens (output_config.task_budget)
```
hidden flag (`.hideHelp()`). 최소 20,000 (시스템 프롬프트 문구). 정수 + positive 검증.

`H.taskBudget` shape (caller가 넘기는 것):
```ts
{ total: number }                            // 또는 { total: number, remaining?: number }
```

API body 에서는 `output_config.task_budget: { type: "tokens", total, remaining }` 형태로 빌더 (`oB3` 또는 유사) 가 변환. 확인.

## 3. State / Schema

### 3.1 messageQueue 스토어 구조

본체: `WA = l_5()` ([`extracted-functions.js:8143`](../../extracted-functions.js#L8143)). **in-memory singleton** — 디스크 영속 없음. `ctx.messageQueue` 는 같은 객체의 참조 (REPL ctx 와 subagent ctx 모두 share, ED8 도 share).

큐 항목 shape (filter 코드와 enqueue 호출 합산 — 확인):
```ts
interface QueuedCommand {
  uuid?: string
  mode: "prompt" | "task-notification" | (other)  // U93 가 처리하는 모드는 "prompt" + "task-notification" 만
  value: string | ContentBlock[]
  priority?: "now" | "next" | "later"             // 미지정 시 enqueue/enqueuePendingNotification 가 default 설정
  agentId?: string                                 // subagent 가 enqueue 한 경우
  pastedContents?: Record<id, { type: "image"|..., source?: ..., content?: ... }>
  skipSlashCommands?: boolean                      // bridge / channel 이 enqueue 할 때 true (Nc9 우회)
  isMeta?: boolean
  origin?: { kind: "channel"|"peer"|"task-notification", server?: string, from?: string }
  bridgeOrigin?: boolean
  clientPlatform?: string
  workload?: string
  preExpansionValue?: string
  fileAttachments?: ...
}
```

API (확인):

| 메서드 | 시그니처 | 동작 |
|---|---|---|
| `enqueue(cmd)` | `(QueuedCommand & {priority?:string}) => void` | priority 기본 `"next"`. 큐 끝에 push. `O()` 로 snapshot 갱신 + 구독자 emit. |
| `enqueuePendingNotification(cmd)` | 동일 | priority 기본 `"later"`. 그 외 동일. |
| `dequeue(filter?)` | `((cmd)=>bool)? => QueuedCommand?` | priority 가 가장 작은 (가장 빨리 처리할) 항목 1개 splice. |
| `dequeueAll()` | `() => QueuedCommand[]` | 전부 비움. |
| `dequeueAllMatching(filter)` | `((cmd)=>bool) => QueuedCommand[]` | match 만 splice. |
| `peek(filter?)` | 동일 시그니처 | dequeue 하지 않고 minimum-priority 1개 리턴. |
| `remove(items)` | `(QueuedCommand[]) => void` | 객체 동등 비교로 splice. |
| `removeByFilter(filter)` | `((cmd)=>bool) => removed[]` | 조건 통과한 것 splice 후 리턴. |
| `clearCommandQueue()` | `() => void` | 비움. |
| `resetCommandQueue()` | `() => void` | clearCommandQueue + 구독자 set 클리어. |
| `getCommandQueueSnapshot()` | `() => readonly QueuedCommand[]` | 동결 사본. |
| `getCommandQueue()` | `() => QueuedCommand[]` | 가변 사본 (`[...H]`). |
| `getCommandQueueLength()` | `() => number` | length. |
| `getMainThreadQueueLength()` | `() => number` | `agentId === undefined` 개수. |
| `hasCommandsInQueue()` | `() => boolean` | length > 0. |
| `recheckCommandQueue()` | `() => void` | snapshot 만 다시 굳히고 emit. |
| `popAllEditable(suffix, cursorOffset)` | `(string, number) => {text, cursorOffset, images}?` | REPL UI 가 사용자 키로 큐 → 입력창에 합칠 때. `jGH(cmd)` 가 editable 인 것만, nonEditable 은 큐에 다시 push. |
| `getCommandsByMaxPriority(prio)` | `("now"\|"next"\|"later") => QueuedCommand[]` | `TH6[prio] <=` 인 것 (dequeue 아님, view). |
| `subscribe(fn)` | snapshot 변경 알림. |
| `markCancelPending(id)` / `consumeCancelPending(id)` | | abort flag |

### 3.2 priority 순서

`TH6` ([`extracted-functions.js:8143`](../../extracted-functions.js#L8143)):
```ts
{ now: 0, next: 1, later: 2 }
```

- `"now"` — 가장 우선. 사용 사례 미확인 (코드 상 `getCommandsByMaxPriority("now")` 직접 호출은 없음, peek/dequeue 의 internal sort 만 사용).
- `"next"` — 기본 enqueue (`enqueue()`). turn-end `SnH` 가 이 prio 까지 빨아들임.
- `"later"` — `enqueuePendingNotification()`. turn-end 에서 빨려들지 않고 큐에 남음.

### 3.3 슬래시 명령 (`Nc9`) 처리

`Nc9(cmd) = typeof cmd.value === "string" && cmd.value.trim().startsWith("/") && !cmd.skipSlashCommands` ([`extracted-functions.js:8117`](../../extracted-functions.js#L8117)).

- Bq3 turn-end 의 messageQueue 드레이닝은 `Nc9` 통과 항목을 **제외**. 즉 슬래시 명령은 SnH 로 안 들어감.
- 슬래시 명령은 REPL 계층(`MFK`, [`extracted-functions.js:20060`](../../extracted-functions.js#L20060))이 별도로 처리:
  - **현재 턴 진행 중 enqueue 된 슬래시 명령**: 큐에 남아있다가, 턴 끝나면 REPL UI 가 `MFK({queuedCommands: W, ...})` 호출 — 거기서 `/clear`, `/compact`, `/logout` 등을 case-by-case 디스패치 (해당 슬래시 명령 정의의 `call(args, ctx)` 호출 → 자체적으로 새 Bq3 시작하거나 세션 종료).
- 따라서 **`/compact` 가 mid-turn 에 enqueue 된 시나리오**: 현재 Bq3 가 정상 종료 (next_turn 또는 다른 reason) → REPL 이 큐를 보고 슬래시 명령을 처리 → `kw3` (compact 액션, [`extracted-functions.js:15875`](../../extracted-functions.js#L15875) 근방) 가 별도로 실행 → 결과 메시지 추가 후 새 prompt 입력 대기. 즉 **/compact 가 Bq3 안에서 트리거되어 querySource="compact" 로 재진입하는 식이 아님**. (추정 검증 필요: REPL 의 `kw3` 가 직접 compact 만 하고 끝나는지, 아니면 곧바로 `Bq3({..., querySource: "compact"})` 를 다시 도는지. `kw3` 본체에 새 Bq3 호출은 보이지 않음 — 자체 `pt + $rH` 만 호출하고 `{type:"compact", compactionResult, displayText}` 리턴. 즉 **/compact = no new turn**, 단지 messages 만 compact 결과로 교체하고 다음 user prompt 대기.) 확인.

### 3.4 `messageQueue` 소유 / 생명주기

- 단일 모듈 스코프 변수 `WA = l_5()` (extracted-functions.js:8143) — 프로세스 단위 singleton.
- `forkToolUseContext` (line 9845) 의 subagent ctx 생성 시 `messageQueue: parent.messageQueue` (shared ref) — 모든 ctx 가 동일한 큐를 본다 (확인).
- 세션 종료 (`Ijq` reason 중 `"clear"` / `"logout"`) 시 `resetCommandQueue()` 호출되는지: 직접 호출처 grep 안 보임. **확인 필요** — 추정: 프로세스 종료 시 자연 GC, `clear` 시에는 별도 reset 없이 messages 만 reset 되는 듯.

### 3.5 enqueue 사용처 (선별, 확인)

| 사이트 | priority | 모드 | 출처 |
|---|---|---|---|
| 사용자가 turn 도중 prompt 입력 → submit 시 `--isAlreadyProcessing=true` 분기 | `"next"` | `"prompt"` | line ~17139 `NY({...})` (PromptInput 컴포넌트) |
| MCP 채널 inbound notification | `"next"` | `"prompt"` (skipSlashCommands: true) | channel handler |
| REPL bridge inbound | `"next"` | `"prompt"` (bridgeOrigin or skipSlashCommands) | bridge handler |
| task-notification (subagent → parent) | `"next"` | `"task-notification"` (agentId set) | subagent 완료 |
| `Lc9` (line 8143 `Lc9((H)=>NY({mode:"prompt",value:'/'+H}))`) | `"next"` | `"prompt"` (slash-prefixed) | OS/system 트리거 — keyboard shortcut → slash command 자동 입력 |
| pending notification | `"later"` | various | `enqueuePendingNotification` |

### 3.6 turn-end attachment 외부 영향

`SnH` 가 yield 한 attachment 들은 두 군데로 흐른다:
1. `yield T_` — generator 호출자(REPL/SDK)가 받음 (UI 렌더 / SDK 메시지 스트림).
2. `JH.push(T_)` — Bq3 의 `JH` (= `collectedToolResults`) 배열에 추가. 이게 다음 턴 `D.messages = [...x, ...wH, ...JH]` 의 `JH` 라서 **다음 모델 호출 입력에도 포함**.

즉 queued user prompt 는 다음 턴 messages 의 user 메시지로 자연스럽게 들어간다 — replace 가 아니라 **append**. 확인.

### 3.7 `taskBudget` schema 흐름

```
CLI/SDK caller
   │  --task-budget 8192      or    sdkOptions.taskBudget = 8192
   ▼
ClaudeCodeOptions.taskBudget: number    (단일 숫자)
   │
   ▼  (CLI 진입점, line 19033 등)
H.taskBudget = { total: 8192 }          (Bq3 caller 가 객체로 wrap)
   │
   ▼  Bq3 본문 — f 초기값 void 0
       compaction 성공 시: f = max(0, (f ?? total) - RA8(messages))
   │
   ▼  callModel(...)
options.taskBudget = { total, ...(f !== void 0 && {remaining: f}) }
   │
   ▼  payload builder (oB3 등)
output_config: { task_budget: { type: "tokens", total, remaining? } }
   │
   ▼  API request (beta header "task-budgets-2026-03-13")
```

확인: 본 추출본 범위에서 server 측 동작은 알 수 없음. 시스템 프롬프트의 설명문 (line 4153 부근) 만 참고.

## 4. 차이점 (v0.2.8 → v2.1.143)

| 영역 | v0.2.8 | v2.1.143 |
|---|---|---|
| 큐 기반 mid-turn 입력 | 없음 | `messageQueue` (3-priority, 18 메서드) + turn-end `SnH` 자동 드레인 |
| Turn-end attachment | 없음 | `makeSystemReminderAttachment` 가 33+ 종 라벨 attachment 빌드 (queued/IDE/memory/skill/mode/diagnostic/usage) — 1s timeout |
| Slash 명령 | 입력 시 즉시 처리 | enqueue 가능 — turn 도중 입력해도 큐에 남고 턴 종료 후 REPL 가 처리 (`Nc9` 필터로 Bq3 분리) |
| Tool list hot-reload | 없음 (정적 `options.tools`) | turn-end `refreshTools?.() / refreshMcpClients?.()` 호출 — 변경 시 `tengu_mcp_tools_refreshed_mid_turn` |
| Subagent → parent 알림 | 없음 | `task-notification` mode 로 messageQueue 사용 |
| maxTurns 한도 | 없음 | `maxTurns` 옵션 — 3개 경로에서 검사 (stop hook block / aborted_tools informational / next_turn) — 5개 retry 경로는 검사 안 함 |
| Budget 추적 | 없음 | client-side `taskBudget.remaining` 차감 + API `output_config.task_budget` 전달 (beta) |
| 외부 메시지 채널 | 없음 | MCP channel / REPL bridge 가 `enqueue({skipSlashCommands:true})` 로 prompt 주입 |

## 5. Sanity-check 메모

- `Ijq` 는 SessionEnd hook 의 `reason` enum 일 뿐, messageQueue / `SnH` / Bq3 turn loop 와 직접적 코드 경로 없음. 사용자 요청서의 "intersect with messageQueue" 는 의미상 무관. SessionEnd 가 발생하면 프로세스가 끝나므로 결과적으로 큐도 사라지지만, 큐 자체에 `Ijq` 가 들어가지는 않는다. 확인.
- `SnH` 의 `H` 인자 = 사용자 prompt 문자열 (있을 때만 at-mention/mcp-resource/agent-mention attachment 만듦). turn-end 호출에선 `null` — 즉 거기서는 user-input parse-time 류 attachment 가 비활성, queued_commands + IDE/memory/skill 류만 yield 됨. 확인.
- `estimateMessageTokens` 가 "가장 최근 assistant usage 의 input+output" 만 보는 점은 budget 차감의 정확도를 떨어뜨릴 수 있다. 즉 compact 가 일어나지 않는 턴들의 token 사용분은 누적 차감되지 않는다. 추정 의도: budget 은 모델 self-moderation 용 hint 이지 hard cap 이 아니므로 정확도가 중요하지 않다 — 서버 측 enforcement 가 따로 있을 것으로 추정.
- `dh.options.refreshTools` 와 `dh.options.refreshMcpClients` 가 동시에 set 되어 있어도 둘은 독립 — refreshMcpClients 가 새 클라이언트를 추가해도 `tools` 는 refreshTools 가 호출되어야 갱신된다. REPL ctx 는 둘 다 등록하므로 일관성 유지. SDK ctx 도 마찬가지. 확인.
- `messageQueue.remove(processedPrompts)` 는 `mode === "prompt" || mode === "task-notification"` 만 — 즉 다른 mode (예: 이론상 "now"/"later" priority 만의 `mode` 항목, 또는 다른 enqueue 경로) 가 있다면 처리됨에도 큐에 남을 수 있다. 단 현재 모든 enqueue 사이트가 둘 중 하나의 mode 를 쓰므로 사실상 안전. 확인.
- `makeSystemReminderAttachment` 의 1초 timeout 은 attachment promise 들이 전체적으로 1s 안에 안 끝나면 AbortController 로 abort — 즉 IDE/LSP 가 느려도 turn-end 가 1s 이상 지연되지 않음. 단 `Promise.all` 이라 abort 후에도 settled 까지 기다리는지(아니면 reject 로 즉시 통과되는지)는 미확인. 추정: `o$` wrapper 가 abort signal 을 받아 reject 로 즉시 propagate.
- `--task-budget` flag 가 `.hideHelp()` 인 점 — 정식 노출 X (beta 기능). SDK 진입점에서는 `taskBudget` 옵션으로 노출 (line 9258 부근). 확인.
