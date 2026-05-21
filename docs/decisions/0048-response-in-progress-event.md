# ADR-0048: `response.in_progress` streaming event 처음부터 처리 — Codex forward-compat gap 보완

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: ADR-0033 (JSON-RPC envelope), ADR-0034 (session JSONL envelope),
  [[codex-desktop-build-2867-round-4]] §J ("WebSocket event.kind 12종 — `response.in_progress`는 Codex가 미처리"),
  [[codex-otel-attribute-vocabulary]]

## 맥락

[[codex-desktop-build-2867-round-4]] §J에서 Codex Desktop build 2867의 WebSocket 채널
(`wss://chatgpt.com/backend-api/codex/responses`)이 발행하는 12종의 `event.kind`가
forensics로 확정되었다:

```
response.created
response.in_progress           ← Codex가 silent-drop (forward-compat gap)
response.completed
response.output_item.added / done
response.content_part.added / done
response.output_text.delta / done
response.function_call_arguments.delta / done
response.custom_tool_call_input.delta
```

`response.in_progress`는 OpenAI Responses API v2 사양에는 명확히 존재하지만
Codex 자체 dispatcher가 매칭 case를 갖지 않아 silent drop된다 — UI가 "thinking…"
indicator를 표시할 hook이 사라지는 것이며, "the model is alive vs. the network
stalled"을 사용자가 분간 못 하게 된다.

v3는 같은 WS / SSE wire를 흡수하는 시점에서 **처음부터** 이 이벤트를 처리한다.
주변 가치:
1. UI "thinking…" indicator의 의미 있는 1-shot signal.
2. 미지의 `event.kind`가 들어와도 throw하지 않고 카운터 + 디버그 로그로 흡수하는
   forward-compat 표준 패턴.
3. SSE wire-level parser를 SDK 외부에 두어서, OpenAI/Anthropic SDK 양쪽 모두
   추후 같은 envelope을 받을 때 재사용 가능한 토대.

## 결정

### Part A — `src/llm/streaming-events.ts` (신규)

세 개의 public 엔트리 포인트 + forward-compat 헬퍼 1개:

- **`parseSseFrame(block: string) → ParsedSseFrame | null`** — WHATWG HTML §9.2
  서버-센트 이벤트 파싱 규칙: CRLF/LF 모두 수용, BOM strip, multiple `data:`
  lines는 `"\n"`으로 concat, comment line (`:` prefix) 건너뜀, `data:` 부재 시
  `null`.
- **`splitSseFrames(buf: string) → { frames, remainder }`** — fragmented TCP
  read를 위한 streaming-friendly splitter. 호출자는 `remainder`를 다음 chunk
  앞에 prepend해서 재호출.
- **`decodeSseEvent(frame)`** / **`decodeWsEvent(raw)`** — frame의 JSON payload를
  파싱해 `DecodedProviderEvent` discriminated union으로 lifting. payload의
  `type`/`kind` 필드가 우선이고, 없으면 SSE `event:` 이름 fallback.
- **`logUnknownEventRateLimited(ev, now?)`** — unknown event를 debug log로
  전달하되 token-bucket rate limit (10 lines / 60s)을 적용. 1000개가 쏟아져도
  log volume이 bound된다. 함수가 emit 여부를 boolean으로 return해서 테스트가
  logger threshold (`info` default)와 무관하게 검증 가능.

`DecodedProviderEvent`는 12개의 known kind + `{ kind: "unknown"; rawKind; data }`
escape hatch로 구성된다. `data: Record<string, unknown>`로 유지한 이유는
**OpenAI Responses API v2의 inner shape가 public spec으로 안정화되지 않았기 때문**;
known field (`message`, `progress`, `created_at`)는 call site에서 opportunistic
pluck. (한계 §a 참조)

### Part B — `StreamEvent` 유니온에 `response_in_progress` variant 추가

`src/llm/types.ts`의 `StreamEvent`에:

```ts
| {
    type: "response_in_progress"
    message?: string         // optional human-readable status
    progress?: number        // 0..1 ratio
    createdAt?: number       // provider millis, when supplied
  }
```

`assembleFromEvents`는 이 variant를 명시적으로 skip — heartbeat은 누적 content가
아니므로 reconstructed message에 영향이 없어야 한다 (heartbeat 없는 stream과
byte-identical).

### Part C — streaming-dispatch 의 in-progress indicator seam

`src/agent/streaming-dispatch.ts`에 additive하게:

```ts
export interface InProgressIndicator {
  kind: "in-progress"
  message?: string
  progress?: number      // 0..1 if available
  timestamp: number      // receive-side millis (always populated)
}
export type InProgressHandler = (indicator: InProgressIndicator) => void
```

`StreamingTurnArgs`에 optional `onInProgress?: InProgressHandler` 필드 추가.
이벤트가 들어왔을 때 handler가 등록되어 있으면 정확히 한 번 호출된다 —
`createdAt`이 있으면 그걸 timestamp로, 없으면 `Date.now()`. handler가 없을 때는
이벤트가 silently absorb되어 outcome (`message`/`stopReason`/`resultBlocks`)이
heartbeat 없는 stream과 완전히 동일.

### Part D — forward-compat 카운터

unknown event는 `kind: "unknown", rawKind`로 surfacing되어 호출자가 metric counter
(`quanta.stream.event.kind.<rawKind>`)와 rate-limited debug log로 처리할 수 있다.
metrics 키 vocabulary는 ADR-0032의 OTel 카탈로그를 따른다 (`codex.*` namespace를
v3의 `quanta.*` namespace에 mirror).

## 근거

- **Codex가 silent-drop ⇒ v3는 처음부터 흡수**: forward-compat gap은 land된
  코드의 표면에 묻히지 않고 처음부터 보완하는 것이 비용이 낮다.
- **SDK 외부 wire-level parser**: Anthropic SDK는 자체 parser를 가져서 본 모듈을
  당장 호출하지 않는다 — 그러나 OpenAI Responses API를 직접 wire에서 흡수할 때
  (Codex 표면을 따라가는 추후 phase) 재사용 표면이 이미 있다.
- **`data: Record<string, unknown>` 유지**: OpenAI Responses inner shape가 spec
  안정 미달 — 타이트 union으로 묶으면 OpenAI side가 schema를 흔들 때마다 v3
  patch가 필요해진다. opportunistic pluck이 더 안전.
- **rate-limited log + 함수 return**: 로그 폭주 방지 + threshold-agnostic 검증
  ("debug" 로그가 default level에서 dropped여도 unit test가 invariant를 검증).

## 대안

- **이벤트를 그대로 ignore (Codex 패턴 답습)**: 기각 — UI "thinking…" indicator의
  signal 누락은 사용자 경험에 직접 손해, 흡수 비용이 매우 낮다.
- **`data`를 타이트 discriminated union으로**: 기각 — OpenAI side shape churn이
  있음, spec 안정화 전엔 loose `Record<string, unknown>`이 강건. 안정화되면
  Part A를 후속 ADR에서 tighten.
- **`onInProgress`를 `streamingTurn`의 mandatory arg**: 기각 — 기존 호출 site
  전부에 변경을 요구. optional이 격리 원칙에 맞다.
- **rate limiter를 무한 token bucket으로**: 기각 — 1000+/sec 폭주 시 stderr 폭주.

## 결과·트레이드오프

- **얻은 것**: 13 deterministic tests (10 unit + 3 integration), 12 known event
  kinds 흡수, forward-compat unknown 경로, in-progress indicator seam, SSE/WS
  parser robustness (fragmented frames / CRLF / multi-line data / 1MB payload /
  BOM JSON / deeply nested / malformed JSON / 1000-event rate limit).
- **비용**: `src/llm/streaming-events.ts` 1 신규 파일 (~280 LOC), `StreamEvent`
  유니온에 variant 1개 추가, `streaming-dispatch.ts`에 args 1개 + handler 호출 1개
  added (no rename, no semantic change to existing path).

## 한계 (LIMITATIONS)

- **(a) `data` shape이 public spec 미달**: `Record<string, unknown>`로 유지.
  call site에서 `message`/`progress` 같은 known field만 opportunistic pluck.
  OpenAI가 spec 안정화하면 후속 ADR에서 Zod schema로 tighten.
- **(b) wire-level parser는 SDK가 가져가는 SSE 경로와 중복 가능성**: Anthropic
  SDK는 자체 parser를 가져 본 모듈을 우회한다 — OpenAI Responses API를 wire에서
  직접 흡수하는 phase에서 비로소 본 모듈이 hot path가 된다.
- **(c) `onInProgress` handler의 예외는 caller 책임**: streaming-dispatch는
  handler를 inline 호출만 한다 — handler가 throw하면 stream consumer가 throw한다.
  user code는 자체 try/catch로 wrap해야 함 (JSDoc에 명시).
- **(d) timestamp는 receive-side wall clock**: `Date.now()` fallback이라
  byte-identical replay (ADR-0023) 불변식 외부 — assembler가 이 variant를
  skip하므로 message reconstruction에는 영향 없으나, indicator log를 replay할
  때는 시간이 흔들린다 (deliberate; replay에 indicator log를 포함시키지 않음).

## 불변식 영향

- **assembleFromEvents byte-identical**: heartbeat skip이 명시되어 outcome
  변동 없음 (integration test로 pin).
- **streaming-dispatch additive**: 기존 14개 streaming-dispatch test 모두 통과.
- **slice 격리 유지**: `src/llm/streaming-events.ts`는 `@/shared/logger`만 import.
- **신규 npm dep 0**.
- **OTel canonical key 준수**: `quanta.stream.event.kind` / `quanta.stream.in_progress.count`
  (ADR-0032 vocabulary).
