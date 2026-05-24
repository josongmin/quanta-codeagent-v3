# ADR-0183: Streaming cancellation + cleanup

- **상태**: Accepted
- **날짜**: 2026-05-25
- **관련**: ADR-0138 (budget breaker — wires `cancel("budget-breach")`), ADR-0123 (verify-checkpoint bridge — wires `cancel("verify-guard")`), ADR-0128 (plan-queue — wires `cancel("user-abort")`); 이전 슬롯 0177/0181는 사용자 점유 → 0183 사용
- **참조**: `src/agent/streaming-cancellation/{types,default,llm-stream-cancel,index}.ts`, `tests/unit/streaming-cancellation-hellgate.test.ts`

## 맥락

매 모던 agent (Cursor, Claude Code, Codex, OpenHands)는 mid-stream cancel + 부분 상태 cleanup이 1급. 우리 LLM port는 `AbortSignal` threading만 있고:
1. *왜* abort됐나는 잃어버림 (모든 cancel이 `aborted=true`로만 surface)
2. cleanup orchestration 없음 (handler 등록 + bounded parallelism + 에러 캡처)
3. 부분 결과 salvage 정책 없음 (partial text + 완성된 tool_use만 actionable)

ADR-0138 budget breaker / ADR-0123 verify-guard / ADR-0128 plan-queue 등이 *왜* abort인지 알면서 일반 AbortSignal만 fire 하기 때문에 ledger / metrics / observability가 cause-blind. 본 ADR이 typed cause + cleanup orchestrator + 부분-결과 salvage를 봉인.

## 결정

신규 plane-clean 슬라이스 `src/agent/streaming-cancellation/`:

### Part 1 — typed cause + signal/controller (`types.ts` + `default.ts`)

```ts
type CancellationCause =
  | "user-abort"
  | "budget-breach"
  | "timeout"
  | "verify-guard"
  | "permission-deny"
  | "side-conversation"
  | "compaction-needed"
  | "host-shutdown"
  | "external"

interface CancellationSignal {
  readonly aborted: boolean
  readonly cause: CancellationCause | null
  readonly abortedAt: number | null
  addEventListener("abort", () => void): void
  removeEventListener("abort", () => void): void
}

interface CancellationController {
  signal: CancellationSignal
  cancel(cause): void                       // first-cause-wins
  registerCleanup(h): () => void            // returns deregister fn
  finalize(partial): Promise<CancellationOutcome>  // bounded-parallel cleanup
}
```

**First-cause-wins**: 첫 cancel이 latched. 둘째 cancel은 no-op. 가장 *causally-correct* 이유 보존 (budget-breach가 먼저 → user-abort 1 tick 후는 redundant).

**Bounded parallelism**: default 4. Serial(1)은 socket-block 위험, unbounded는 FD starvation 위험. 4 = 1 turn당 평균 active resource 수 대비 안전.

**Listener semantics**: WHATWG AbortSignal 미러. abort 후 등록한 listener도 즉시 synchronous fire (race 없는 wire pattern).

**finalize idempotent**: outcome cached, handler는 1회만 실행 (side-effect 가진 cleanup 보호).

### Part 2 — `fromAbortSignal` / `toAbortSignal` round-trip

기존 `AbortSignal` 사용 callsite와 호환 (Anthropic/OpenAI/Bedrock/Vertex/Foundry SDK 모두 `AbortSignal` 수용).

### Part 3 — `cancellableStream` wrap (`llm-stream-cancel.ts`)

```ts
const stream = cancellableStream({ source, controller })
for await (const ev of stream) { ... }
const partial = stream.partial()     // 부분 텍스트 + 완성된 tool_use
const outcome = await stream.outcome()  // null if 안 cancel; CancellationOutcome if cancel
```

Salvage 정책:
- `text_delta` → `partialText` 누적
- `tool_use_start` + `tool_use_end` 쌍 완성 시에만 `toolUses[]` 노출 (partial JSON은 actionable 아님 — silent drop)
- `usage` → 최신 값 overwrite
- `stream_reset` tombstone → 누적 상태 discard (provider 죽고 fallback swap 시)

**hasUsableToolUses**: `toolUses.length > 0`의 명시적 carrier (caller가 "execute or rollback?" 판단 시 사용).

## Default-OFF

caller가 controller 인스턴스화 + signal threading 안 하면 기존 AbortSignal 경로 그대로 작동 (byte-identical). 슬라이스 자체는 자동 wire 0.

## Hellgate (26 cases)

- **A. CancellationSignal 6**: initial state / cancel → aborted / sync listener / multi listeners / removeEventListener / 후 등록 listener도 sync fire
- **B. Controller idempotency 3**: 같은 cause cancel × 2 → 1 fire / 다른 cause → first wins / abortedAt first only
- **C. AbortSignal round-trip 3**: pre-aborted → external / cancel → AbortSignal aborts / 명시적 cause 보존
- **D. CleanupHandler 6**: 호출 with cause / multi handlers / throw 캡처 + 나머지 continue / deregister / finalize-without-cancel = synthetic external / idempotent cached
- **E. cancellableStream salvage 8**: text 결합 / 완성 tool_use / 미완성 tool_use 제외 / usage 누적 / outcome null when not cancelled / outcome 후 cancel resolves / stream_reset reset / cleanup propagates

26 pass / 0 fail.

## Alternatives rejected

1. **단순 AbortSignal로 충분** — cause 손실, cleanup orchestration 부재.
2. **Cancel 시 throw** — partial 손실. SDK 컨벤션은 iterator-aborts-cleanly.
3. **Unbounded parallel cleanup** — FD starvation 위험.
4. **Cause를 handler 결정** — caller가 *왜* (Esc vs budget vs guard) 안다. 명시적 cause가 audit-clean.
5. **Latest-cause-wins** — 1 tick late budget-breach가 causally earlier user-abort를 가림 → 거짓 cause로 alarm 잘못 라우팅.

## SOTA++ 자리매김

| Agent | typed cancel cause | partial salvage | cleanup orchestration |
|---|---|---|---|
| Claude Code | partial (string cause) | ✅ stop_reason synthetic | ❌ (transcript only) |
| Cursor | proprietary | ✅ | ✅ |
| OpenHands | ✅ enum | partial | ✅ per-action |
| Anthropic SDK | ❌ (AbortError only) | N/A | N/A |
| **quanta** | ✅ 9-arm closed | ✅ typed + tool-use 정책 | ✅ ordered + bounded parallel |

= "9-arm causally-typed cancel + first-cause-wins + bounded parallel cleanup + 부분-결과 salvage 정책 모두 closed-port로 봉인. ADR-0138/0123/0128/0177(시블링 mid-turn) 모두 cause로 라우팅 가능."

## Follow-up

- **ADR-0123 wire**: verify-guard fail → `cancel("verify-guard")`
- **ADR-0138 wire**: budget hard breach → `cancel("budget-breach")`
- **ADR-0178 wire**: mid-turn `cancel-and-*` mode → `cancel("user-abort")`
- **Metrics**: `cancel_rate{cause}` counter via MetricSink (ADR-0144)
- **CLI surface**: `Esc-Esc` → cancel("user-abort"); `Cmd-K` → cancel-and-replace path
