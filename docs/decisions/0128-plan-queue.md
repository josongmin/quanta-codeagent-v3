# ADR-0128: Plan-queue helper — Codex mid-turn follow-up queue as a typed primitive

- **상태**: Accepted
- **날짜**: 2026-05-24
- **관련**: ADR-0123 (verify-checkpoint bridge — helper-only deferred-wire), ADR-0124 (conversation-checkpoint store — pure primitive sibling), ADR-0125 (turn-diff wiring consolidation — same deferred-wire family), ADR-0030 (mid-turn steering — future consumer), ADR-0037 (FollowUpQueue — wired sibling)
- **SOTA 출처**: Codex Desktop `queued-follow-ups[threadId → FollowUp[]]` (sole industry pattern — Claude Code, Cursor, v0.dev 모두 long turn 중 사용자 입력을 막거나 UI를 freeze)
- **참조**: `src/agent/plan-queue.ts`, `tests/unit/plan-queue-hellgate.test.ts`

## 맥락

Codex Desktop은 모델이 일하는 동안 사용자가 **추가 메시지를 타이핑**할 수 있다. 입력은 turn을 interrupt하지 않고 thread별 큐에 enqueue되며, 현재 turn 완료 시 next turn에 자동 dispatch된다. 12-field FollowUp context — `pausedReason` / `arrivedDuringTurn` / `source` 등 — 가 함께 캡처돼 replayer가 staleness를 판단할 수 있다.

**다른 modern agent는 전부 없다**:
- Claude Code 2.1 — turn 중 입력하면 UI freeze (next turn까지 대기)
- Cursor 3.2 — 입력은 받지만 다음 prompt에 단순 prepend (12-field context 없음)
- v0.dev — interrupt-or-wait (큐 없음)

quanta는 ADR-0037 `FollowUpQueue` (PausedReason 10-arm, wired into loop)를 이미 가지고 있지만, 그것은 **wired** 슬라이스다 — 호출자는 `cfg.followUpQueue`를 통해 곧장 loop tick에 묶인다. 본 ADR은 **pure helper** primitive — 12-field FollowUp + 6-arm PausedReason + 4-arm FollowUpSource + per-thread LRU + dedup-window을 typed-port로 노출하되 caller wiring은 **deferred** — 정확히 ADR-0123/0124 helper-only posture를 따른다.

왜 sibling이 따로 필요한가:
- ADR-0037 `FollowUpQueue`는 `popReady`/`drain` 위주 (loop의 단일-head model)
- 본 ADR `PlanQueueStore`는 `enqueue`/`drain` 위주 (mid-turn-steering surface가 한 turn 끝에 batched replay)
- 후자가 Codex의 12-field context와 직매핑되며 mid-turn surface (CLI typed-while-running, voice transcript, scheduled reminder) wiring의 **structural surface**

## 결정

신규 plane-clean 모듈 `src/agent/plan-queue.ts`:

```ts
interface FollowUp {
  readonly id: string               // fu-<thread>-<n>
  readonly threadId: string
  readonly text: string
  readonly source: FollowUpSource   // keystroke | voice | api | scheduled
  readonly enqueuedAtMs: number     // injected clock
  readonly pausedReason: PausedReason
  readonly arrivedDuringTurn: number
  urgent: boolean                   // OR-in during dedup
  drainedIntoTurn: number | null    // null until drain
  readonly metadata: Readonly<Record<string,string>>
  readonly textHash: string         // dedup key
  readonly label?: string           // exactOptional (omitted, not undefined)
}

interface PlanQueueStore {
  enqueue(input: Omit<FollowUp, "id"|"enqueuedAtMs"|"textHash"|"drainedIntoTurn">): string
  drain(threadId: string, currentTurn: number): ReadonlyArray<FollowUp>
  peek(threadId: string): ReadonlyArray<FollowUp>
  clear(threadId: string): number
  inspect(): ReadonlyMap<string, ReadonlyArray<FollowUp>>
}

const defaultPlanQueueStore = (opts?: {
  maxPerThread?: number              // default 32
  now?: () => number                 // default Date.now
  hash?: (text: string) => string    // default sha256.slice(0,16)
}) => PlanQueueStore
```

6-arm PausedReason: `tool_in_flight | subagent_running | review_blocked | compaction | rate_limit | other`.
4-arm FollowUpSource: `user_keystroke | voice_transcript | api_call | scheduled_reminder`.

## 계약 (6)

1. **순수**. 인메모리, 0 I/O, 0 SQLite. 영속화는 follow-up.
2. **NO-THROW**. 모든 method는 safe value로 fallback (`enqueue` 항상 string, `drain`/`peek` 항상 array).
3. **exactOptionalPropertyTypes**. `label` 미제공 시 entry에 `label` key 자체 OMITTED (HELL-22 검증).
4. **PER-THREAD ISOLATION**. 동일 텍스트 + 다른 thread = 두 entry 유지 (dedup은 per-thread; HELL-6).
5. **DEDUP WINDOW**. dedup은 LIVE entry (`drainedIntoTurn === null`)만 대상. drain된 entry는 재-enqueue 시 NEW entry (HELL-7).
6. **LRU eviction**. cap 초과 시 oldest **non-urgent** drop. 전부 urgent면 oldest urgent drop (cap은 hard ceiling; 호출자가 막을 수 없으므로 무언가는 drop; HELL-14/15/16).

## Default-OFF

이 슬라이스를 **자동으로 인스턴스화하는 곳 없음**. `AgentConfig.planQueue?: { store: PlanQueueStore }` 슬롯이 `FeaturesConfig` Pick union에 포함돼 있지만, loop/dispatch 어디서도 read하지 않는다. 미래 consumer 후보:

- **`mode.ts` mid-turn-steering wire** — `cfg.steerBarrier` 후속에서 `store.drain(sessionId, currentTurn)` 호출, drained entries를 user-message로 concatenate
- **CLI `raw-line-reader`** — long-running tool 중 사용자 keystroke를 `store.enqueue({source:"user_keystroke", pausedReason:"tool_in_flight", ...})`
- **voice transcript surface (Tauri)** — `source:"voice_transcript"`
- **scheduled reminder (cron)** — `source:"scheduled_reminder", pausedReason:"other"`

본 ADR이 닫지 않는 것 = consumer wiring + replay strategy (concatenate vs separate turn vs prepend) + UI for queue inspector. mode.ts/loop.ts 정착 후 별도 ADR.

## Hellgate (22 cases)

`tests/unit/plan-queue-hellgate.test.ts` 가 8 cluster로 봉인:

- **A. enqueue happy 4**: id format / insertion order / counter monotone / injected clock verbatim
- **B. dedup 3**: same text collapses / per-thread (not global) / drained entry don't dedup
- **C. urgent OR-in 2**: non→urgent upgrades / urgent→non stays urgent
- **D. drain 4**: empty thread / enqueued order + drainedIntoTurn / no double-drain / urgent-first within same enqueuedAtMs
- **E. LRU 3**: oldest non-urgent dropped / urgent preserved over non-urgent / all-urgent fallback drops oldest urgent
- **F. clear & inspect 3**: clear returns count / inspect cross-thread / inspect snapshot doesn't leak mutation
- **G. hash injection 2**: custom hasher used / default 16-hex prefix
- **H. exactOptional 1**: `label` omitted (not `undefined`) when not supplied

전부 인메모리(I/O 0). 22 pass / 53 expect / 0 fail.

## Alternatives rejected

1. **"Global queue (no threadId)"** — multi-session breaks; per-thread matches Codex의 thread-uuid keyed top-level state.
2. **FIFO without urgent ordering** — 사용자 intent signal (urgent flag) 손실. urgent OR-in + drain-time urgent-first 정렬이 표준.
3. **SQLite persistence by default** — 인메모리는 plane-clean; 영속화는 process restart 시 의미 → 별도 follow-up (ADR-0037 `followUpQueueSnapshotStore` 패턴 차용 가능).
4. **Drop NEWEST on overflow** — 가장 최근 = 가장 관련성 큼 invariant. oldest non-urgent drop이 LRU의 옳은 방향.
5. **Hard fail on all-urgent overflow** — 호출자가 막을 수 없는 condition; throw하면 mid-turn keystroke가 crash로 surfacing. oldest urgent drop + documented trade-off가 옳다.
6. **재사용 of ADR-0037 `FollowUpQueue`** — voice match: 0037은 wired `popReady(threadId, pausedReason)` API (loop tick에 묶인 head-of-queue model). 본 슬라이스는 batched-replay model (한 turn 끝에 `drain(threadId, currentTurn)`로 전체 batch surface). API 모양 자체가 다르며, 12-field context (specifically `arrivedDuringTurn` / `drainedIntoTurn` / `source` / `label`)도 0037에 없음.

## SOTA++ 자리매김

| Agent | Mid-turn follow-up 큐 | typed FollowUp context | per-thread isolation | dedup window |
|---|---|---|---|---|
| Codex Desktop | ✅ `queued-follow-ups` | ✅ 12-field (untyped JSON) | ✅ thread-uuid keyed | ❌ |
| Claude Code 2.1 | ❌ UI freezes | — | — | — |
| Cursor 3.2 | partial (next-prompt prepend) | ❌ | ❌ | ❌ |
| v0.dev | ❌ | — | — | — |
| **quanta (ADR-0037)** | ✅ wired `popReady` | 5-field | ✅ ThreadId branded | ❌ |
| **quanta (본 ADR)** | ✅ helper (deferred-wire) | ✅ 12-field typed | ✅ per-thread | ✅ live-window |

= "Codex의 mid-turn follow-up 패턴을 typed 12-field surface + per-thread LRU + dedup window로 흡수한 첫 closed-port primitive". wired sibling (ADR-0037)과 helper sibling (본 ADR)이 voice-match하면서 future surface 진입을 위한 structural seam을 확보.

## Follow-up (이 ADR이 닫지 않는 것)

- **mode.ts integration**: turn이 "paused" 상태로 진입하는 정확한 시점 정의 (tool dispatch 직전? llm stream open 직전?). `pausedReason` 6-arm을 mode.ts state-machine으로 매핑.
- **CLI typed-while-running keystroke wire**: `raw-line-reader`에 mid-turn enqueue 호출 추가. `urgent` 입력 모드 (Ctrl+U?) UI.
- **Replay strategy 결정**: drained entries를 (a) single concat user-message로 push할지, (b) 별도 turn으로 dispatch할지, (c) next user message에 prepend할지. Codex는 (a). 본 슬라이스는 strategy-agnostic.
- **UI for queue inspector**: `store.inspect()` 결과를 status-bar에 surface (pending count + urgent count).
- **Persistence**: ADR-0037 `followUpQueueSnapshotStore` 패턴 차용한 `planQueueSnapshotStore` 옵션.
- **0037과의 통합**: 두 슬라이스가 voice-match하면서 공존하지만, mid-turn-steering ADR이 정착하면 둘 중 하나로 수렴할 가능성 (현재는 둘 다 default-OFF이므로 충돌 없음).
