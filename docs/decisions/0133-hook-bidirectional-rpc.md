# ADR-0133 — Hook bidirectional Request/Response RPC paired (6 lifecycle events + prompt_hook injection)

- **Status**: Proposed (2026-05-24, W3 of [[0130-extracted-source-absorption-roadmap]])
- **Related**: [[glob-rules-and-hook-updated-input]] (현 hook system: pre_tool_use updated_input), [[cursor-3.2-absorption]] (20 hook events 카탈로그), [[cursor-absorption-r1-r4-hardening]] (post-hook input gap 발견 + 수정)
- **References**:
  - Cursor `cursor-agent-exec/dist/main.js` line 99000+ `ExecClientMessage` + line 99148 `ExecuteHookResult` + line 109060 `prompt_hook`
  - 6 hook event types: `pre_compact`, `subagent_start`, `subagent_stop`, `pre_tool_use`, `post_tool_use`, `post_tool_use_failure`
  - Paired Request/Response 10 종: `Pre{Compact,ToolUse}RequestQuery/Response`, `Post{ToolUse,ToolUseFailure}RequestQuery/Response`, `Subagent{Start,Stop}RequestQuery/Response`, `AskQuestionInteractionQuery/Response`, `McpAuthRequestQuery/Response`, `GenerateImageRequestQuery/Response`, `WebFetchRequestQuery/Response`

## Problem

우리 현 hook system ([[glob-rules-and-hook-updated-input]] 2026-05-23 도입):

- **단방향 callback**: hook이 input mutation은 가능 (`updated_input`) 하지만 LLM 호출 directing 불가
- **3 hook event** 정도만 (pre_tool_use 위주). pre_compact / subagent lifecycle은 missing
- **Hook 결과가 일시적**: hook이 다음 turn에 영향 주려면 별도 wiring 필요

Cursor agent-exec (R3 deep dive)는 **양방향 paired Request/Response RPC**:

- 6 lifecycle event: `pre_compact` (compaction 전), `subagent_start/stop` (subagent 생명주기), `pre_tool_use` (tool 실행 전), `post_tool_use` (성공), `post_tool_use_failure` (실패)
- 각 event는 **paired Query/Response message** — hook이 Response 안에 `prompt_hook` 등 wire하면 LLM 재호출 시 prompt 수정됨
- AskQuestion / McpAuth / GenerateImage / WebFetch도 같은 paired 패턴

핵심: **hook이 단순 mutator 아니라 first-class agent flow controller**.

## Decision

기존 `hooks` system을 superset으로 확장. **Backward compat 100%** (기존 `updated_input` hook 그대로 동작).

### 1. Hook event 확장 (3 → 6+)

```typescript
type HookEvent =
  // 기존 (변경 없음)
  | "pre_tool_use"          // tool 실행 전 (updated_input return)
  | "post_tool_use"         // tool 실행 후 (현재 logging만)
  | "post_tool_use_failure" // tool 실패 시 (NEW from Cursor)
  // 신규
  | "pre_compact"           // context compaction 직전 (NEW)
  | "subagent_start"        // subagent spawn 직후 (NEW)
  | "subagent_stop"         // subagent 종료 (NEW)
  // V2 (deferred)
  // | "ask_question"
  // | "mcp_auth"
  // | "generate_image"
  // | "web_fetch"
  ;
```

### 2. Hook Request/Response paired schema

기존 hook return은 `{ updated_input?: any } | void`. 신규는 union으로 확장:

```typescript
interface HookRequest<E extends HookEvent> {
  event: E;
  context: HookContext<E>;     // event 별 typed context
  abort_signal: AbortSignal;
}

interface HookResponse {
  // 기존
  updated_input?: unknown;     // pre_tool_use에서 input 수정

  // 신규 (Cursor inspired)
  prompt_hook?: {              // NEW: 다음 LLM 호출 시 system prompt 수정
    inject_before_user?: string;
    inject_after_system?: string;
  };
  tool_override?: {            // NEW: tool 정의 자체 수정 (lazy load)
    add?: ToolDefinition[];
    remove?: string[];         // tool name to disable for this turn
  };
  abort?: { reason: string };  // NEW: agent loop abort 요청
}
```

각 hook event는 paired:

| Event | Query payload | Allowed Response field |
|---|---|---|
| `pre_tool_use` | `{ tool_name, input }` | `updated_input`, `prompt_hook`, `tool_override`, `abort` |
| `post_tool_use` | `{ tool_name, input, output }` | `prompt_hook`, `abort` |
| `post_tool_use_failure` | `{ tool_name, input, error }` | `prompt_hook`, `tool_override`, `abort` |
| `pre_compact` | `{ messages_to_compact, is_first_compaction }` | `abort` (skip compact) |
| `subagent_start` | `{ subagent_id, parent_id, task_prompt }` | `prompt_hook`, `abort` |
| `subagent_stop` | `{ subagent_id, result }` | `prompt_hook` (parent에 inject) |

### 3. `is_first_compaction` flag

Cursor의 finding: 첫 compaction은 warm-up과 다르게 처리. 우리 compactor에 flag 전달, hook이 다르게 응답 가능.

### 4. Hook execution ordering invariant

- 같은 event 여러 hook 등록 시 **deterministic order** (등록 순 + tiebreaker는 hook name 알파벳)
- 한 hook이 `abort` 반환하면 나머지 hook skip
- `prompt_hook` 누적 (concat by inject_before_user / inject_after_system)
- `updated_input` 누적: 각 hook이 prev input → new input chain (메모리 [[cursor-absorption-r1-r4-hardening]]의 hook chain 패턴)

## Alternatives considered

1. **AskQuestion / McpAuth / GenerateImage / WebFetch 모두 같이 흡수**: deferred to V2 — 이번 ADR은 6 lifecycle만, 나머지 4는 별도 ADR (각 도구 specific).
2. **Hook을 plugin manifest로 declarative 정의** (Codex `.codex-plugin/plugin.json` 스타일): rejected for V1 — 우리 hook은 TypeScript code 등록 (runtime). plugin manifest는 별도 trajectory.
3. **abort signal 대신 throwing error**: rejected — throw는 catch 미스 시 silent. abort는 explicit return으로 audit 가능.
4. **Hook event를 BroadcastChannel로 노출** (renderer에서도 listen): deferred — desktop 진출 후.

## Invariants preserved

1. **Backward compat 100%**: 기존 hook handler signature `(input) => updated_input | void`는 그대로 동작. 신규 schema는 superset.
2. **closed-port**: HookExecutor는 port inject (memory [[may-23-structural-hexagonal-round]]), unit test 가능.
3. **deterministic order**: hook name 알파벳 tiebreaker — replay determinism 보존 ([[smoke-fixture-system]]).
4. **abort propagation**: abort_signal은 fetch / tool call 전체 chain wire.
5. **typed envelope** ([[may-21-codex-r7-sota-plus-plus]]): hook event는 union 확장 — exhaustive switch enforce.
6. **glob rules 호환** ([[glob-rules-and-hook-updated-input]]): hook과 glob rules 동시 등록 시 hook이 outer wrapper, glob rules 안쪽.

## Tradeoffs

- **Schema 확장 = 큰 surface**: 6 event × 4+ response field = 24+ combination. 일부는 mutually exclusive (subagent_start에 updated_input 무의미). mitigation: schema에 per-event allow-list (위 표).
- **prompt_hook 누적은 race**: 여러 hook이 inject_before_user 다 wire 시 prompt 길이 폭증. mitigation: max 10K chars per inject, exceed 시 hook execution warning + skip.
- **post_tool_use_failure가 retry loop 유발 가능**: hook이 매번 abort 안 하고 prompt_hook으로 "retry"만 inject 시 무한 loop. mitigation: tool retry count tracker (max 3 attempts per call_id).
- **subagent_start에 prompt_hook 가능 = subagent prompt 수정**: 부모 prompt 정책이 자식에 전파. 일관성 ↑이지만 cross-cut concern. mitigation: subagent 측 frontmatter (allowed-tools)와 충돌 시 frontmatter 우선.
- **메모리 [[cursor-absorption-r1-r4-hardening]] 7 버그 (특히 throwing matcher poison, YAML fold) 재발 위험**: hook 확장 시 같은 sanitization 적용 필수. mitigation: 기존 hardening test 모두 신규 schema에 재실행.

## Out of scope (deferred)

- **AskQuestionInteractionQuery / McpAuthRequest / GenerateImageRequest / WebFetchRequest** Request/Response — 각각 별도 ADR (특정 tool 의존).
- **declarative hook in plugin manifest** — V2 (plugin system 진화 후).
- **Hook event을 web/desktop renderer로 broadcast** — V3 (multi-surface 진출 후).
- **`session_start` hook** (Claude code-cli 발견의 카테고리) — V2, 별도 ADR.

## Validation (post-implementation)

- [ ] 기존 [[glob-rules-and-hook-updated-input]] 25 신규 test 모두 pass (schema 확장 후도)
- [ ] [[cursor-absorption-r1-r4-hardening]] 7 버그 case 재실행 — 모두 fix 유지
- [ ] 신규 hook event 6종 각각 unit test 5+ (event 발화 / response 적용 / abort 전파 / chain 누적 / error path)
- [ ] hook execution order determinism — 같은 hook set replay 시 byte-identical 보장
- [ ] prompt_hook 누적 10K 한도 lint warning
- [ ] tool retry count tracker — 3-attempts max 강제
- [ ] smoke battery 신규 case "hook-bidirectional" 카테고리 5+
