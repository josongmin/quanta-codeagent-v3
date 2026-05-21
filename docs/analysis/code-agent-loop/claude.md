# Claude (Anthropic Messages API + Claude Code 2.1.138 / Desktop 1.7196.3) — Agent Loop (요청→응답→분기 + 통제 모델)

> [cursor.md](cursor.md)의 자매 문서. 같은 6-섹션 구조. Cursor는 자체 protobuf(agent.v1/aiserver.v1)였지만 **Claude는 표준 Anthropic Messages API(REST+SSE)** 위에 산다 — 복잡성이 wire가 아니라 도구/MCP/IPC 계층에 있다.

## 0. 증거 파일 & 표기

| 출처 | 신뢰도 | 비고 |
|---|---|---|
| `@anthropic-ai/sdk` `resources/messages/messages.d.ts` | **확정** | wire 타입 ground truth (SDK 동봉) |
| Claude Code 2.1.138 바이너리 (`~/Library/Application Support/Claude/claude-code/2.1.138/claude.app/.../claude`, 205MB Mach-O) | **추론** | minified JS 임베드, strings 기반 |
| Claude Desktop 1.7196.3 IPC 카탈로그 ([[claude-desktop-1-7196-catalog]]) | **확정** | 616 IPC method 추출 |

표기: `CD`=Claude Desktop · `CC`=Claude Code · `★`=핵심 · `⚠️`=정정/주의

---

## 1. 아키텍처 — 빌더+트랜스포트가 같은 프로세스 (Cursor와 정반대)

```
[사용자 입력 (Desktop ion-dist composer / CLI stdin)]
   │  Desktop: IPC LocalSessions.sendMessage (MessagePort, 614 method 중)
   │  CLI: stdin → queryInstance
   ▼
① 세션 상태 병합  ← sessionStore + transcript JSONL(append-only) + working state
   │  CLAUDE.md/rules/skills/memory recall을 토큰예산 내로 패킹
   ▼
② Messages API request 조립 (@anthropic-ai/sdk) — 모델이 실제 보는 것
   │  messages.create({ model, max_tokens, system, messages, tools, stream:true, thinking? })
   ▼
   POST https://api.anthropic.com/v1/messages   (SSE)
   headers: anthropic-version / anthropic-beta / x-api-key / anthropic-workspace-id
```

**핵심**: Cursor는 "엔진=빌더, IDE=transport"로 분리됐지만, Claude는 **요청 빌더 + transport가 같은 프로세스**(CLI=단일 바이너리가 SDK 직접 호출; Desktop=main process가 SDK 호출 후 IPC로 renderer에 stream). Cursor의 90필드 자체 protobuf 같은 envelope 없음 — 표준 Messages API 1개.

### `messages.create` 엔드포인트
`POST /v1/messages` (Anthropic) · Bedrock/Vertex/Foundry는 base URL 스왑 (`ANTHROPIC_{BEDROCK,VERTEX,FOUNDRY}_BASE_URL`)

---

## 2. 요청 경로 (입력 → envelope → LLM)

### ① 입력 envelope: `MessageParam` — 역할 **딱 2종** (Cursor HUMAN/AI와 동일)
```ts
MessageParam { role: 'user' | 'assistant', content: string | ContentBlockParam[] }
```
`system`/`tool` 역할이 메시지 레벨에 **없다** — Cursor와 똑같은 구조적 선택.
- **시스템 프롬프트** = 메시지 아님, `system` 파라미터 (string | TextBlockParam[], cache_control) ← Cursor `explicit_context.context`에 대응
- **도구 결과** = 역할 아님, `user` 메시지 안 `tool_result` 블록 ← Cursor field-18 `tool_results`에 대응

### `ContentBlockParam` — 입력 가능 블록 **7종** (Cursor SelectedContext 28멤버보다 단순)
`text` / `image` / `tool_use` / `tool_result`(tool_use_id + content + is_error) / `document`(PDF·plaintext + citations) / `thinking` / `redacted_thinking`

### ★ 도구를 모델에 알리는 법 (Cursor와 핵심 대조)
| | Cursor | Claude |
|---|---|---|
| 빌트인 | `supported_tools`에 enum id만 (스키마 서버전용) | **`tools[]`에 풀 JSON 스키마** `{name, description, input_schema}` — 클라가 다 전송 |
| MCP | `mcp_tools` 동적 스키마 | 동일 — `tools[]`에 MCP 도구 머지 |
| 강제 | tool_choice enum 없음 | **`tool_choice: {auto\|any\|tool\|none}` 있음** (Cursor엔 없던 강제 게이트) |

→ Claude는 **빌트인 도구 스키마를 클라가 다 본다** = 흡수 관점에서 Cursor(서버전용)보다 투명.

### 요청측 enum / 라우팅
- 모델: `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL` + `SMALL_FAST_MODEL_AWS_REGION` + Bedrock/Vertex/Foundry base URL (Cursor `model_details`에 대응)
- thinking: `{type:"enabled", budget_tokens}` (Cursor ThinkingLevel 대신 토큰 예산)
- mode: permission `default/acceptEdits/bypassPermissions/plan` + Desktop effort `default/max/high/medium/low` (Cursor UnifiedMode/AgentMode 7종 대응, 더 적음)
- system 캐시: `cache_control:{type:"ephemeral"}` 최대 4 breakpoint

### ★ 시스템 프롬프트 본문 — 실제 보내는 텍스트 (CC 바이너리 verbatim)

identity는 **실행 모드별 3-variant**:
| 조건 | identity 문장 (verbatim) |
|---|---|
| 표준 인터랙티브 | `You are Claude Code, Anthropic's official CLI for Claude.` |
| 비대화형 + appendSystemPrompt | `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.` |
| Agent SDK / side-question | `You are a Claude agent, built on Anthropic's Claude Agent SDK.` |

tone/style (verbatim 발췌): "Keep responses concise and actionable" · "minimize output tokens" · "concise summary". 구체 `NEVER`/`ALWAYS` 규칙은 minified로 코드화 → 텍스트 추출 불가.

**도구 설명**(`tools[].description`)도 system 페이로드의 일부 — 예 `Read`: *"Reads a file from the local filesystem … cat -n format, line numbers starting at 1 …"*. ripgrep 검색 도구: *"built on ripgrep. Prefer this over grep/rg via Bash — results integrate with the permission UI"*.

### system-reminder 패턴 — per-turn dynamic (캐시 prefix **밖**)

캐시 prefix(불변) vs per-turn(매턴 신규)의 분리가 핵심:

| 캐시 prefix에 고정 | per-turn `<system-reminder>` (캐시 밖) |
|---|---|
| identity + tone 규칙 | skills 목록 (가용 skill 변동) |
| 도구 description + deferred tool 목록 | git status 변화 (add/commit/branch 후) |
| available agent types | environment (cwd/platform/date/gitStatus) |
| **CLAUDE.md** (프로젝트 지침) | thinking-block 조정 지시 |
| | TodoWrite 상태 reminder |
| | side-question 격리 reminder (아래) |

side-question reminder (verbatim, 별도 경량 에이전트 spawn 시):
```
<system-reminder>This is a side question from the user. You must answer this
question directly in a single response.
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently
- You share the conversation context but are a completely separate instance
```

### ★ 상황별 페이로드 변화 (어떻게 상황에 맞춰 보내나)

| 상황 | system 파라미터 | per-turn reminder 추가 | 메시지 구조 | 캐시 |
|---|---|---|---|---|
| **첫 턴** | identity + CLAUDE.md | skills + env + thinking 가이드 | user 메시지만 | prefix 생성 |
| **후속 턴** | 동일 (불변) | **변경분만** (git status, 새 skill) | user + 전체 history | prefix 재사용 (cache hit) |
| **tool_use 후** | 동일 | — | assistant(tool_use) + user(tool_result, id 매칭) | prefix 불변 |
| **compaction 후** | 동일 | `[earlier conversation truncated for compaction retry]` | `<conversation summary>` 메시지 + 이후 suffix | **prefix 재생성** |
| **Plan mode** | 동일 | plan 파일 경로 + custom instructions | plan 승인 대기 | 유지 |
| **side-question** | Agent variant | "separate agent" 격리 reminder | 독립 메시지 + 공유 context | 격리 prefix |
| **max_tokens 후** | 동일 | "continue exactly where you left off" | partial 유지 + continuation | 불변 |

### 토큰 예산 패킹 (상황 압박 시 무엇을 자르나)
- **auto-compact 임계**: 모델 컨텍스트 윈도우 비율 (Sonnet 4.6 = 200K, Opus 4.6 = 1M)
- **skill description truncation**: skill 목록이 설정 비율(기본 1%) 초과 시 `[... skill content truncated for compaction; use Read on the skill path …]`
- **post-compact 파일 복원**: 최대 50K 토큰, per-file 5K 제한
- **rapid-refill breaker**: 3턴 내 3회 compact → thrashing 차단

### v3 대응 (같은 패턴이 어디 있나)
| CC 패턴 | v3 |
|---|---|
| identity system 프롬프트 | [prompt.ts `buildSystemPrompt`](../../../src/agent/prompt.ts) — "You are Quanta…" (static, byte-stable) |
| per-turn `<system-reminder>` | [prompt.ts `buildTurnContext`](../../../src/agent/prompt.ts) — dynamic을 trailing user `<system-reminder>` 1개로 분리 (캐시 prefix 불변) |
| CLAUDE.md 주입 | [prompt-sections.ts `fourSectionPreset`](../../../src/agent/prompt-sections.ts) — project_md section (ADR-0051) |
| reminder 위조 방어 | [prompt.ts `escapeReminderBoundary`](../../../src/agent/prompt.ts) — repoRules/memory가 system-reminder 경계 위조 못 하게 |
| compaction 마커 | [compaction.ts](../../../src/agent/compaction.ts) — `<conversation summary>` 합성 user 메시지 |
| rapid-refill breaker | [compaction-breaker.ts](../../../src/agent/compaction-breaker.ts) — 무의미 compact thrash 차단 |
| skill truncation | [skill/skill-size.ts](../../../src/skill/skill-size.ts) — 30MB cap |

⚠️ 못 본 부분(서버 블랙박스): 코어 시스템 프롬프트의 정확한 `NEVER`/`ALWAYS` 규칙(minified), 빌트인 도구의 서버측 동작, 컨텍스트 reranking — `/v1/messages` 서버가 일부 추가 주입 가능성.

---

## 3. 응답 경로 (typed enum / 메시지 형태 / 전체 타입)

### 외곽 = SSE 스트림 `RawMessageStreamEvent` (6 + 2 = **8종**, Cursor InteractionUpdate 21멤버보다 적음)
```ts
message_start · content_block_start · content_block_delta · content_block_stop
· message_delta · message_stop   (+ ping 하트비트 · error)
```
순서: `message_start` → (`content_block_start` → `content_block_delta`×N → `content_block_stop`)×블록 → `message_delta` → `message_stop`

### content block (출력) = **4종** (Cursor ToolCall 44멤버와 극명한 대조)
`text` / `tool_use` / `thinking` / `redacted_thinking`
→ ★ Cursor는 44개 typed ToolCall이 wire에 있지만 **Claude는 `tool_use` 1종 + `name` 문자열로 도구 구분**. 도구가 enum이 아니라 name.

### delta (블록 내부 증분) = **5종**
`text_delta` / `input_json_delta`(도구 인자 누적) / `thinking_delta` / `signature_delta`(thinking 서명) / `citations_delta`

### ★ `stop_reason` enum — 턴 종료의 핵심 (Claude Code 바이너리에서 **8종**)
```
end_turn · tool_use · max_tokens · stop_sequence
· pause_turn · refusal · content_filtered · guardrail_intervened
```
→ ★ **Cursor는 stop_reason literal이 agent.v1에 아예 없었고**(TurnEndedUpdate 토큰회계 + ShellAbortReason로 구조 전달), Claude는 **명시 enum 8종**. 두 시스템의 가장 큰 응답 설계 차이 — Claude=종료 의미를 1급 enum, Cursor=구조(이벤트 종류).

### `message_delta`가 실어주는 것
`stop_reason` + `Usage{ input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }`

### error event (스트림 중)
`overloaded_error`(529) / `rate_limit_error`(429) / `api_error`(5xx) / `invalid_request_error`(400)

### SDK 타입 union (ground truth)
```ts
type RawMessageStreamEvent = RawMessageStartEvent | RawContentBlockStartEvent
  | RawContentBlockDeltaEvent | RawContentBlockStopEvent | RawMessageDeltaEvent | RawMessageStopEvent
type ContentBlock      = TextBlock | ToolUseBlock | ThinkingBlock | RedactedThinkingBlock
type ContentBlockParam = TextBlockParam | ImageBlockParam | ToolUseBlockParam | ToolResultBlockParam
  | DocumentBlockParam | ThinkingBlockParam | RedactedThinkingBlockParam
type RawContentBlockDelta = TextDelta | InputJSONDelta | CitationsDelta | ThinkingDelta | SignatureDelta
type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'   // SDK; 런타임은 +pause_turn/refusal/content_filtered/guardrail_intervened
```

---

## 4. 응답으로부터의 전체 분기 트리

Claude Code `continueConversation()` (for-each 메시지 순회 루프, generator 아님)가 SSE를 디스패치:

```
SSE event
├─ message_start ──────────→ usage 누적 [발행 없음]
├─ content_block_start
│   ├─ text ───────────────→ 텍스트 블록
│   ├─ tool_use ───────────→ 도구 호출 (name, id)
│   ├─ thinking ───────────→ 추론 pane
│   └─ redacted_thinking ──→ 가려진 추론
├─ content_block_delta
│   ├─ text_delta ─────────→ UI 스트리밍, 게이트 없음, 계속
│   ├─ input_json_delta ───→ 도구 인자 JSON 누적 (완성은 _stop)
│   ├─ thinking_delta ─────→ 추론 스트리밍
│   ├─ signature_delta ────→ thinking 서명
│   └─ citations_delta ────→ 인용
├─ content_block_stop ─────→ 블록 확정 (tool_use면 JSON.parse → input; tengu_duplicate_tool_use_id 검증)
│
├─ message_delta(stop_reason) ── ★ 핵심 분기 ★
│   ├─ tool_use ───────────→ 루프 계속: 도구 dispatch (CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY 병렬)
│   │                          → iL8(id)=tool_result 블록 → _addMessage → continueConversation()
│   ├─ max_tokens ─────────→ 루프 계속: continuation (이어쓰기 재호출)
│   ├─ end_turn ───────────→ 종료
│   ├─ stop_sequence ──────→ 종료
│   ├─ pause_turn ─────────→ 중단: server-tool/사용자 개입 대기 → 그대로 재전송해 재개
│   ├─ refusal ────────────→ 종료 (정책 거부 표시)
│   ├─ content_filtered ───→ 종료
│   └─ guardrail_intervened → 종료
│
├─ message_stop ───────────→ 스트림 끝
├─ ping ───────────────────→ 무시
└─ error ──────────────────→ overloaded/rate_limit/api → 백오프 재시도; invalid_request → fatal
```

### HITL/권한 게이트 (분기 트리 위에 얹힌 평면, Cursor reviewKind에 대응)
도구 dispatch **전**: TCC 권한(Computer Use) · trust scope 5단계 · HITL 4-tier(hand-off/always-confirm/pre-approval/none) · bridge preflight(원격) · MCP `elicitation/create`(사용자 입력/OAuth) · `tool_choice` 강제.

### tool_result 형태 (Cursor exec 쌍에 대응)
`iL8(toolUseID)` = `{type:"tool_result", content, is_error, tool_use_id}` → `_addMessage` → `continueConversation()` 재진입. MCP 도구는 `mcpCallTool`로 위임 후 결과 주입.

⚠️ Cursor는 24개 ExecServerMessage⇄ExecClientMessage 쌍으로 실행을 IDE에 위임하지만, Claude는 **도구 실행이 같은 프로세스**(CLI) 또는 IPC `respondToToolPermission`(Desktop) — 별도 exec 프로토콜 없음.

---

## 4.5 ★ Loop lifecycle — 한 턴에서 일어나는 모든 일 (단계별)

분기 트리(§4)는 "응답 1건"을 처리하는 법이고, 이 절은 **`while` 한 바퀴(= 1 turn)에서 처음부터 끝까지 일어나는 모든 일**. CC는 `continueConversation()` for-each, v3는 [loop.ts](../../../src/agent/loop.ts) `while`. 단계는 동형.

```
┌─ TURN 진입 ──────────────────────────────────────────────────┐
│ [P1] abort 체크 ─ signal.aborted → 즉시 {kind:"aborted"}        │
│ [P2] memory recall ─ semantic+tag+freshness, recallLimit개      │
│ [P3] proactive compaction 체크 ─ estimateTokens ≥ threshold?    │
│         → 초과면 요약(older→1 synthetic msg) + breaker 기록      │
│ [P4] working-state 주입 ─ hypothesis/blockers/nextStep          │
│ [P5] skill activation gate ─ glob/description 매칭 → extraTools  │
│ [P6] buildTurnContext ─ system(캐시 prefix) + dynamic reminder   │
│         (per-turn <system-reminder> 1개를 tail user 메시지로)    │
└──────────────────────────────────────────────────────────────┘
                          │
┌─ STREAM 소비 ────────────────────────────────────────────────┐
│ [S1] messages.create({stream:true}) → SSE                      │
│ [S2] withStreamTimeout 감싸기 (firstChunk + idle deadline)      │
│ [S3] message_start → usage(input/cache_read) 누적               │
│ [S4] 이벤트별 처리 (interleaved):                                │
│       text_delta        → onTextDelta(UI) + assemble append     │
│       tool_use_start     → assemble push {tool_use, input:{}}    │
│       input_json_delta   → slot.json 누적 (UI엔 reveal)          │
│       tool_use_end       → JSON.parse → ★ concurrency-safe면     │
│                            즉시 dispatch (in-flight, await 안 함) │
│       thinking_delta     → drop(Phase1) 또는 heartbeat           │
│       response_in_progress → "thinking…" 콜백                    │
│       message_delta      → stop_reason + output_tokens           │
│ [S5] head-of-line barrier ─ 첫 concurrency-UNSAFE tool 이후 모든  │
│       호출 deferred (stream 중 시작 안 함)                       │
└──────────────────────────────────────────────────────────────┘
                          │
          ┌───────────────┴───────────────┐
   stream error                      정상 assembled
          │                               │
┌─ 에러 복구 ─────────┐      ┌─ 결정 (decideOnAssembled) ───────────┐
│ decideOnStreamError │      │ max_tokens & <3 → nudge "continue"    │
│  retryable → backoff│      │ tool_use & 0 parsed → nudge "re-issue"│
│   (exp+jitter, ≤3)  │      │ empty & <2 → nudge "empty"            │
│  PTL → reactive     │      │ else → proceed                        │
│   compaction → retry│      └───────────────────────────────────────┘
│  fatal → error      │                  │
│  529/overload →     │           ┌──────┴──────┐
│   FallbackLLM swap  │      hasTools          !hasTools
│   (stream_reset     │           │              │
│    tombstone)       │      ┌─ TOOL 실행 ─┐  completed→finish
└─────────────────────┘      │ per tool_use:│
                             │ admissibility│
                             │  6-stage gate│  ← [G] 아래
                             │ execute      │
                             │ (fs-jail +   │
                             │  disclaim)   │
                             │ result 수집  │
                             │ model-call   │
                             │  order 정렬  │
                             └──────────────┘
                                    │
┌─ TURN 종료 후 ────────────────────────────────────────────────┐
│ [E1] verify-guard ─ 코드수정 턴인데 test 검증 bash 없으면 nudge   │
│ [E2] closeout-guard ─ 종료 직전 4-truth-surface reminder 1회      │
│ [E3] tool_result blocks → working memory append (다음 턴 history)│
│ [E4] persistSession ─ distill(LLM) → consolidate(dedup/merge)    │
│         → eviction sweep (tier cap)                              │
│ [E5] metrics ─ turns++/tool_calls/tokensUsed/stop_reason         │
│ [E6] envelope JSONL append ─ turn_context+event_msg+response_item│
│ [E7] maxTurns 카운터 ─ ★ "tools" 결과만 증가 (retry/nudge는 X)    │
└──────────────────────────────────────────────────────────────┘
                          │
              tools면 → 다음 turn (while 계속)
              completed/error/aborted면 → finish(reason, turns)
```

### [G] 도구 dispatch 전 admissibility 6-stage (매 tool_use마다)
```
1. mode block      ─ plan/review/audit에서 mutating 도구 차단
2. HITL 4-tier     ─ hand-off→deny / always-confirm→onConfirm / none→pass
3. permission stack ─ per-thread × per-host × post-denial precedence (opt-in)
4. trust scope     ─ always_allow/project/workspace/session/once_only grant 체크
5. permission policy ─ HARD_DENY(보안경계) + mode 결정(auto=classifier)
6. PreToolUse hook ─ repo-local hook이 마지막 deny 가능 (Task/FS matcher 분리)
```

### 한 턴 안 SAME-TURN 복구 (turn 카운터 안 쓰고 재진입)
| 트리거 | 동작 | 예산 |
|---|---|---|
| transient stream error (429/5xx/timeout) | exp backoff + jitter 후 같은 턴 재스트림 | ≤3회 |
| prompt_too_long (PTL) | reactive compaction 후 재시도 | (compaction 실패 시 error) |
| max_tokens stop | "continue" nudge + partial 유지 후 재스트림 | ≤3회 |
| tool_use stop인데 0개 파싱 | "re-issue valid tool call" nudge | ≤1회 |
| empty turn | "continue or final answer" nudge | ≤2회 |
| 529 overload ×N | FallbackLLM provider swap + stream_reset tombstone | provider 소진까지 |

→ 이 복구들은 **turn slot을 안 먹음**(`maxTurns`는 실제 tool 진행한 턴만 카운트). 무한 empty/malformed 스핀은 예산 cap으로 차단.

### CC vs v3 단계 대응
| 단계 | Claude Code | v3 |
|---|---|---|
| recall/compaction | auto-compact 임계 + post-compact 파일복원 | [P2/P3] recallContext + compactIfNeeded |
| stream 소비 | continueConversation for-each | [S] streamConsume → streamingTurn |
| 병렬 도구 | `MAX_TOOL_USE_CONCURRENCY` | concurrency-safe 인라인 + HOL barrier |
| 도구 게이트 | HITL + permission + sandbox | admissibility 6-stage |
| 종료 결정 | stop_reason 8-way | decideOnAssembled (hasTools 기반 3-way) |
| 복구 | rapid-refill breaker (3턴 3회) | compaction-breaker + SAME-TURN 예산 |
| persist | transcript JSONL append | envelope JSONL + distill/consolidate |

---

## 5. ★ 통제 모델 — 동작은 무엇으로 통제되는가 (핵심 결론, Cursor와 동일 구조)

### 닫힌 것 vs 열린 것
**에이전트가 실제로 실행하는 동사(actuation verb)는 enum으로 닫혀 있다.** 모델이 wire로 낼 수 있는 건 `tool_use` 블록의 `name` 하나, 그 name은 request `tools[]`에 광고된 것뿐 (광고 안 된 이름 = 핸들러 없음 → error). Claude Code 표준 도구셋 **13종**(`Bash/Read/Write/Edit/MultiEdit/Glob/Grep/NotebookEdit/WebFetch/WebSearch/TodoWrite/Task/ExitPlanMode`) + Desktop 추가(`browser_batch`/`computer_use`/`tabs_context_mcp` 등)로 닫힘. "고를 수 있는 동사 목록"은 그게 전부.

**그러나 enum이 닫혔다 ≠ 효과가 닫혔다.** 13종 중 둘이 만능 게이트 (Cursor의 shell/mcp와 동일 함정):
- **`Bash`** — 값 하나지만 임의 명령(`rm`/`curl`/`python -c`/빌드/네트워크). 셸로 되는 모든 게 이 한 도구 안에. 무한 효과 백도어.
- **MCP 도구** — `tools[]`에 런타임 동적 주입. 설치한 MCP 서버 따라 호출 표면 무한 확장.
- (`computer_use`/`browser_batch` — GUI 동작 전체를 한 값에, Desktop 한정)

### 통제 평면 (분산)
| 닫혔나 | 무엇이 통제 (Claude) |
|---|---|
| actuation 동사 (어떤 도구) | ✅ `tools[]` 13종 + MCP | wire (name 문자열) |
| **어떤 도구를 고르나** | ❌ | **api.anthropic.com 서버 프롬프트 + 모델 weights** (블랙박스). 코어 시스템프롬프트/persona/refusal 서버전용 |
| **모델이 뭘 보나** | ❌ | recall + CLAUDE.md/skills 주입 + 서버측 컨텍스트 |
| actuation **효과** (실제로 뭘 하나) | ❌ | Bash + MCP가 열린 게이트 |
| 효과를 가두는 것 | enum 아님 → | **sandbox**(seatbelt 프로파일 / Cowork microVM Go-runtime+vsock+MITM / `disclaimer` POSIX_SPAWN_SETDISCLAIM / Landlock+seccomp) + **permission**(HITL 4-tier / trust 5단 / AWF PreToolUse hook / admissibility) |

**결론**: "저 enum 범위 안에서만 동작이 통제된다"는 **틀렸다**. *행동 종류*는 enum(13+MCP)으로 닫혀 있지만(closed action space), *효과*는 Bash/MCP가 열린 문이라 안 닫힘. 진짜 울타리는 enum 옆이 아니라 **아래(sandbox + permission)**. Cursor와 정확히 동일한 결론 — 통제는 한 곳이 아니라 계층 분산.

### Cursor vs Claude — 통제 분산 대조
| 평면 | Cursor | Claude |
|---|---|---|
| 두뇌(도구 선택) | api2.cursor.sh 서버+weights (블랙박스) | api.anthropic.com 서버+weights (블랙박스) — 동일하게 안 보임 |
| 빌트인 도구 스키마 | 서버전용 (enum id만) | **클라가 다 봄** (`tools[]` 풀 스키마) ← Cursor보다 투명 |
| OS 샌드박스 | cursorsandbox (Seatbelt/Bubblewrap+프록시) | seatbelt 프로파일 / Cowork microVM / disclaimer / Landlock |
| out-of-band 정책 | hooks + permission DSL + classifier + .mdc | AWF PreToolUse hook + HITL/trust + skills + CLAUDE.md |
| 루프 통제 | ClientContinuationConfig (idle/max_loops) | stop_reason 분기 + max_tokens continuation |

### 클라에서 못 본 서버 블랙박스
코어 시스템 프롬프트/persona/refusal 로직 · 컨텍스트 reranking · `model_name`→provider 매핑 · 빌트인 도구 **구현**(스키마는 보이나 동작은 서버) · `claude-mythos-preview` 미공개 모델. (Cursor의 reranker/코어프롬프트와 동일한 블랙박스)

---

## 6. quanta 흡수 시사점

- 베낄 수 있는 것 = **action space 계약**(도구 enum + stop_reason 8종 분기트리) + **hook/permission/sandbox 평면**. v3는 [tool-matchers](../../../src/agent/tool-matchers.ts) / [admissibility-gate](../../../src/agent/admissibility-gate.ts) / [shell-disclaim](../../../src/runtime/shell-disclaim.ts) / [fs-jail](../../../src/storage/service.ts)로 3평면 이미 보유.
- **"통제가 한 곳"이 아니라 계층 분산** — Cursor도 Claude도 v3도 동일(loop 결정 + admissibility + sandbox).
- ★ **흡수 갭**: v3 [decideOnAssembled](../../../src/agent/loop.ts#L726)는 stop_reason을 `max_tokens`/`tool_use`(+no tools)/empty 3종만 명시 분기하고 `hasTools` 기반으로 단순화. Claude의 8종 중 **`refusal`/`pause_turn`/`content_filtered`/`guardrail_intervened`는 v3 미처리**(`proceed`→completed). server-tool/Bedrock guardrail 도입 시 갭.
  - **권고**: `refusal` 1-분기 추가(거부 사유 surface, ~30분)가 즉시 가치. `pause_turn`은 server-tool 흡수 시, `content_filtered`/`guardrail`은 Bedrock 도입 시 보류.
- **v3가 더 방어적인 부분**: `tool_use` stop인데 파싱된 tool_use 0개 → malformed 재발행(Claude Code에도 검증 있으나 v3는 명시 nudge), empty-turn nudge 2회.

---

**자매 문서**: [cursor.md](cursor.md)
**참조**: [claude-repomap](../code-agent-suit/claude-repomap.md) · [feature-catalog](../may-21-claude-desktop-feature-catalog.md) · [code-agent-deep-dive](../may-21-claude-desktop-code-agent-deep-dive.md)
**메모리**: [[claude-desktop-1-7196-catalog]] · [[cc-v2-sota-absorption]]
