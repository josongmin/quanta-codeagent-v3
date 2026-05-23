# ADR-0124: Conversation checkpoint store — primitive for the missing rollback half

- **상태**: Accepted
- **날짜**: 2026-05-24
- **관련**: ADR-0108 (Shadow ODB foundation), ADR-0118 (rewindToLast), ADR-0122 (per-file restore), ADR-0123 (verify-checkpoint bridge)
- **SOTA 출처**: Hermes Agent `/rollback`(file + conversation 둘 다), Cline `Restore Files & Task`(3-mode)
- **참조**: `src/agent/conversation-checkpoint.ts`, `tests/unit/conversation-checkpoint-hellgate.test.ts`

## 맥락

ADR-0108 line의 5개 슬라이스(0108→0116→0118→0119)는 **파일 상태**의 snapshot/restore를 완전히 봉인했다 — Cursor의 `gix-snapshot`을 typed·inspectable로 흡수, safety-net + HITL + 자동 checkpoint(ADR-0121)까지.

그런데 industry SOTA(Hermes Agent, Cline)는 **파일 + 대화 둘 다** 복원한다. Hermes의 `/rollback N`은:

> "Restores tracked files in your working directory. Undoes the last conversation turn so the agent's context matches the restored filesystem state."

Cline의 `Restore Files & Task` 모드도 동일한 의도 — 파일과 메시지 history가 *짝지어* 복원돼야 의미가 있다 (메시지에는 "방금 X를 했다"가 들어있는데 파일은 X 이전 상태면, agent context가 깨진다).

quanta는 파일 측 완비, 대화 측 **0**. 본 ADR은 그 갭의 절반(primitive) 을 닫는다.

## 결정

신규 plane-clean 모듈 `src/agent/conversation-checkpoint.ts`:

```ts
interface ConversationSnapshot {
  readonly id: string                          // 호출자가 부여 (보통 turnId)
  readonly takenAt: number                     // epoch ms (injected clock)
  readonly messages: ReadonlyArray<Message>    // 캡처 시점의 frozen shallow copy
}

interface ConversationCheckpointStore {
  record(id: string, messages: ReadonlyArray<Message>): void
  list(): ReadonlyArray<ConversationSnapshot>           // newest-first
  restore(id: string): ReadonlyArray<Message> | null
  prune(keep: number): number                            // returns evicted
  clear(): void
}

const defaultConversationCheckpointStore = (opts?: {
  maxEntries?: number   // default 50
  now?: () => number    // default Date.now (테스트에서 pin)
}) => ConversationCheckpointStore
```

## 계약 (5)

1. **순수**. 인메모리, 0 I/O, 0 SQLite. 영속화는 follow-up.
2. **no-throw**. 단 programmer-bug 입력(`messages`가 non-array)만 `ConversationCheckpointError` throw.
3. **exactOptionalPropertyTypes**. `now`/`maxEntries`는 OMITTED, 절대 `field: undefined` 아님.
4. **불변성**. `record`는 `messages.slice()` + `Object.freeze` — 호출자가 source array를 push/replace해도 stored snapshot은 무영향(HELL-8/9).
5. **LRU eviction**. cap 초과 시 oldest(lowest `takenAt`) drop. 같은 id 재-record는 **replace + touch**(LRU 가장 newest로 이동 + `takenAt` 갱신, dup 안 만듦; HELL-5/6/7).

## Default-OFF

이 슬라이스를 **자동으로 인스턴스화하는 곳 없음**. 미래 consumer 후보:
- `apps/agent` bootstrap — 매 턴 종료 시 `store.record(turnId, messages)` 1줄
- `/rewind` skill (ADR-0122) — `restore(turnId)` 호출 후 caller가 messages 교체
- 자동 recovery 훅 — verify fail 시 직전 turn으로 restore

본 ADR이 닫지 않는 것 = consumer wiring. 사용자 in-flight 영역(`session-resources`, `recovery`)이 정착하면 별도 ADR로 wire.

## Hellgate (23 cases)

`tests/unit/conversation-checkpoint-hellgate.test.ts` 가 7 cluster로 봉인:

- **Happy path 4**: record+list 단일, list newest-first, restore returns frozen, unknown id → null
- **Replacement 3**: same id replace not dup / LRU touch on replace / takenAt 갱신
- **Immutability 3**: source mutation does NOT leak, frozen array assertion, list() identity per call
- **LRU 3**: at-cap evict oldest, maxEntries=1 only newest, maxEntries=0 clamped to 1
- **prune & clear 5**: prune(N) drops oldest, prune>=size no-op, prune(0) clears all, prune(negative) clamps, clear empties
- **Input contract 3**: empty array OK, non-array throws, empty id OK
- **Clock injection 2**: takenAt verbatim, default `Date.now` runtime sanity

전부 인메모리(I/O 0). 23 pass / 0 fail.

## Alternatives rejected

1. **`@/store/sqlite`-backed persistence by default** — 인메모리 cost 매우 작고(messages가 토큰 cap 안에 있음), 영속화는 process restart 시 의미 — 별도 follow-up.
2. **Generic over `<T>`** — `Message` 콘크리트가 더 명확. 다른 type 필요하면 그때 generic.
3. **Auto-record at turn boundary inside the store** — 호출 시점(`record`)을 호출자가 통제하는 게 plane-clean. store는 dumb primitive.
4. **Deep freeze messages** — inner Message 객체는 호출자가 정당하게 mutate할 수 있음(streaming 누적 등). 배열 레벨만 freeze.
5. **Eviction = drop newest** — 항상 oldest LRU; "방금 한 작업은 가장 복원 가치 큼" invariant.

## SOTA++ 자리매김

| Agent | 대화 rollback | 파일 rollback | 둘 동시 복원 |
|---|---|---|---|
| Hermes Agent | ✅ `/rollback N` | ✅ shadow git | ✅ atomically |
| Cline | ✅ "Restore Task" | ✅ shadow git | ✅ "Restore Files & Task" |
| Aider | partial (`/undo`) | partial (git reset) | ❌ |
| Claude Code 2.1 | ✅ MessageSelector | ✅ per-edit file shadow | ✅ together |
| Codex | ❌ | ❌ | ❌ |
| Cursor | ❌ (IDE undo) | ✅ gix-snapshot | ❌ |
| **quanta (이전)** | ❌ | ✅ (0108-0123) | ❌ |
| **quanta (본 ADR)** | ✅ primitive | ✅ | follow-up wire |

= "in-memory pure primitive로 file/conversation rollback을 *동등하게* 다룰 수 있게 한 첫 closed-port 구현". consumer wiring은 사용자 in-flight 영역(`session-resources`, `recovery`)이라 의도적 deferred.

## Follow-up (이 ADR이 닫지 않는 것)

- **Consumer wiring**: `apps/agent` bootstrap에서 store 인스턴스화 + 매 턴 종료 시 `record` 호출. 사용자 in-flight 정착 후.
- **`/rewind` skill 확장**: 현재 ADR-0122의 skill은 파일만. `restore-conversation` 옵션 추가하여 짝지어 복원.
- **Persistence**: 프로세스 재시작에도 살아남는 SQLite-backed 변종. session DB와 분리하여 영속화.
- **Auto-record on close**: 매 LLM 메시지 도착 직후 record (Claude Code의 per-message 패턴).
