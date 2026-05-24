# ADR-0166: Subagent conversation-seed replay (Phase 2.5)

- **상태**: Accepted
- **날짜**: 2026-05-25
- **관련**: ADR-0124 (`ConversationCheckpointStore` — in-memory `messages[]` snapshot/restore), ADR-0158 (Phase 1 — disk-backed `PersistedHandle` + `"interrupted"` arm), ADR-0159 (Phase 2 — interrupted-handle orchestrator + 3 stock resume policies — **predecessor**)
- **참조**:
  - `src/agent/subagent-resume/replay.ts` — `ReplayPolicy` port + 3 stock 정책 (`defaultReplayPolicy(opts)` / `alwaysReplayPolicy` / `skipReplayPolicy`) + `buildReplaySpec(handle, ctx, policy)` NO-THROW composer.
  - `src/agent/subagent-resume/resumer.ts` — `resumeInterruptedHandles({...replay?})` 가 replay 와이어 추가. `opts.replay` 없으면 ADR-0159 Phase 2 byte-identical.
  - `src/agent/subagent-resume/index.ts` — 배럴 갱신.
  - `src/agent/subagent-persistence-store/types.ts` — `PersistedHandle.conversationSnapshotId?: string` + `PersistedSubagentStatus` 의 `"resumed"` 6th arm.
  - `tests/unit/subagent-resume-replay-hellgate.test.ts` (17 case).

## 맥락

ADR-0159 Phase 2 가 `"interrupted"` handle 을 re-fork 하지만 **새 child 는 FRESH** 로 시작한다 — `spec.task` 만 보존, conversation 히스토리는 0. 이는 두 시나리오에서 정직하지 못함:

- A. interruption 직전에 child 가 tool result 를 받아 다음 turn 을 plan 중이었던 경우 — fresh fork 가 그 plan 을 잃는다.
- B. 사용자가 multi-turn 대화 도중 child 를 spawn 했고 그 context 가 의미 있는 경우 — fresh fork 는 `spec.task` 한 줄로 압축 손실.

ADR-0124 의 `ConversationCheckpointStore` 가 이미 in-memory `messages[]` snapshot 을 record/restore 한다. Phase 2.5 는 그 store 를 **resumer 의 OPTIONAL 와이어** 로 끌어와 re-fork 시 `seedMessages` 를 surface 로 흘려 넣는다.

**왜 OPTIONAL + Default-OFF**:
- Phase 2 의 byte-identical 계약은 회귀 위험이 가장 큰 surface 다. 본 슬라이스는 `ResumerOpts.replay` 가 absent 일 때 단 한 줄도 다르게 동작하지 않는다.
- ADR-0124 store 는 in-memory 라 process restart 후엔 비어 있다. 대부분의 caller (CLI one-shot) 는 wire 할 store 자체가 없다 — 본 슬라이스는 그들을 강제하지 않는다.
- `SubagentSpec` (ADR-0145 port) 는 stable. 본 슬라이스가 `initialMessages` 필드를 추가하지 않고, `seedMessages` 는 `ResumeOutcome` 의 OPTIONAL 필드로만 surface 한다 — downstream runner 가 conversation-seed init 을 지원할 때 그 때 pickup.

## 결정

### 1. Closed port: `ReplayPolicy`

```ts
type ReplayDecision =
  | { action: "replay-all"; reason: string }
  | { action: "replay-truncated"; keepLastN: number; reason: string }
  | { action: "skip-replay"; reason: string }

interface ReplayPolicy { decide(handle: PersistedHandle, snapshot: ReadonlyArray<Message> | null): ReplayDecision }
```

`decide` 는 PURE (no I/O). 3-arm decision 으로 surface 가 완전 enumerable.

### 2. Stock policies (3)

- **`defaultReplayPolicy(opts)`** — conservative.
  1. `snapshot === null` 또는 `length === 0` → `"skip-replay"`.
  2. `length <= maxMessages` (기본 200) → `"replay-all"`.
  3. `length > maxMessages` → `"replay-truncated"` with `keepLastN = maxMessages` (**TAIL-KEEP** — 마지막 N 보존).
- **`alwaysReplayPolicy`** — power user / test. snapshot 비어도 `"replay-all"` (empty seed 은 no-op).
- **`skipReplayPolicy`** — most conservative. ADR-0159 Phase 2 와 동일하게 behave (caller 가 wire 했더라도 명시적 opt-out).

**왜 TAIL-KEEP**: child 의 NEXT turn 이 중요. 가장 최근의 tool-result tail + 마지막 assistant turn 이 "interruption 직전 무슨 일이 있었나" 의 가장 informative context. Head-keep 은 원 task 는 보존하지만 in-flight tool trace 를 잃는다. Middle-keep 은 agent 에 의미 없음.

### 3. Composer: `buildReplaySpec`

```ts
buildReplaySpec(handle, ctx, policy)
  → Promise<{ seedMessages: ReadonlyArray<Message>; replayMetadata: Readonly<Record<string,string>> }>
```

**NO-THROW**: 모든 실패 경로 (`ctx.checkpointStore === null` / `handle.conversationSnapshotId` 부재 / `store.restore` throw) 를 `seedMessages=[]` + `replayMetadata.replayPolicy="skip-replay"` + audit-able `replayReason` 으로 collapse.

**Audit metadata ALWAYS populated**:
- `resumedFrom`: handle.id
- `replayPolicy`: 3-arm action
- `replayCount`: seedMessages.length (string)
- `replayReason`: decision.reason

`Record<string, string>` 제약 — caller 가 `spec.metadata` 에 그대로 merge 가능.

### 4. Resumer 와이어 (`opts.replay` OPTIONAL)

```ts
resumeInterruptedHandles({
  scheduler, store, policy, workspace, now?,
  replay?: { context: ReplayContext; policy: ReplayPolicy },
})
```

`opts.replay` ABSENT → ADR-0159 Phase 2 byte-identical (no replayMetadata 출력, fork spec.metadata 에 replay 키 없음).

`opts.replay` PRESENT → "resume" decision 마다:
1. `buildReplaySpec(handle, replay.context, replay.policy)` 호출 (NO-THROW).
2. `replayMetadata` 를 fork spec.metadata 에 merge. merge order: `old.metadata` < `replayMetadata` < `{resumedFrom: oldId}` — chain link 가 최후 승.
3. `seedMessages` 가 non-empty 면 `ResumeOutcome.seedMessages` 로 surface (empty 면 OMITTED — exactOptionalPropertyTypes 보존).
4. `replayMetadata` 는 wire 됐으면 skip-replay 라도 ALWAYS surface (audit trail).

### 5. `PersistedHandle.conversationSnapshotId?: string`

caller 가 fork / turn-boundary 에서 record. 본 슬라이스는 string 을 보존만 함 — 어떻게/언제 set 하는지는 caller 책임. Phase 1 byte-identical (legacy snapshots 에 필드 없어도 OK).

## 계약 (5)

1. **`policy.decide` PURE**: I/O 금지. snapshot 단일 인자 + 출력 3-arm. caller 가 mock 가능.
2. **NO-THROW composer**: `buildReplaySpec` 의 모든 실패 (store=null / id absent / store.restore throw) 가 `seedMessages=[]` + `skip-replay` audit 으로 collapse. 절대 reject 하지 않음.
3. **Default-OFF**: `ResumerOpts.replay` absent ⇒ ADR-0159 Phase 2 byte-identical. fork spec.metadata 에 replay 키 NONE, outcome 에 replayMetadata NONE.
4. **TAIL-KEEP**: `defaultReplayPolicy` 의 truncation 은 항상 last N 보존. composer 의 `ctx.maxMessages` 와 policy 의 `keepLastN` 은 BOTH 바인드 — `Math.min` 적용.
5. **exactOptionalPropertyTypes**: `ReplayedSpec.seedMessages` 는 ALWAYS array (skip-replay 시 `[]`). `ReplayContext.maxMessages` / `ResumeOutcome.seedMessages` / `ResumeOutcome.replayMetadata` 는 absent 시 OMITTED, never `undefined`-set.

## Hellgate (17 case)

`subagent-resume-replay-hellgate.test.ts`:

- **A. defaultReplayPolicy** (5):
  - HG-A1 snapshot null → skip-replay.
  - HG-A2 snapshot empty → skip-replay.
  - HG-A3 length ≤ max → replay-all.
  - HG-A4 length > max → replay-truncated with keepLastN=max.
  - HG-A5 opts.maxMessages override 적용 (50개 + max=4 → truncated).

- **B. alwaysReplay + skipReplay** (2):
  - HG-B1 alwaysReplay → empty/null/non-empty 전부 replay-all.
  - HG-B2 skipReplay → null/non-empty 전부 skip-replay.

- **C. buildReplaySpec** (6):
  - HG-C1 store=null → skip + audit.
  - HG-C2 no snapshotId → skip + audit "absent".
  - HG-C3 store hit + replay-all → seedMessages.length=N, replayCount=N.
  - HG-C4 truncated → length=keepLastN, last N preserved (tail-keep).
  - HG-C5 store.restore throws → skip "store-failed" + 원본 에러 메시지 carry.
  - HG-C6 metadata 의 모든 value 는 string.

- **D. Resumer integration** (4):
  - HG-D1 replay 미와이어 → Phase 2 byte-identical (replayMetadata/seedMessages 둘 다 undefined).
  - HG-D2 replay 와이어 + snapshot hit → seedMessages set + spec.metadata 에 replay 키 merge.
  - HG-D3 replay 와이어 BUT no snapshotId → skip-replay 도 audit metadata surface, seedMessages OMITTED.
  - HG-D4 chained resume → resumedFrom 이 immediate predecessor, pre-existing metadata 보존.

총 17 pass / 0 fail. ADR-0159 의 22 case + ADR-0124 의 case 도 byte-identical 유지 (62 pass / 178 expects).

## Default-OFF / byte-identical

- `subagent-background.ts` / `subagent-persistence-store/jsonl-store.ts` / `subagent-persistence-store/hydrating-scheduler.ts` 0줄 미수정. `types.ts` 만 두 라인 추가 (status `"resumed"` arm, `conversationSnapshotId?` 필드).
- `apps/agent` bootstrap 0줄 미수정. caller 가 `resumeInterruptedHandles({..., replay: {...}})` 명시 호출 시에만 활성화.
- `ResumerOpts.replay` absent 인 경우 fork spec / outcome / store 동작 모두 ADR-0159 byte-identical.

## Alternatives rejected

1. **`SubagentSpec` 에 `initialMessages?: ReadonlyArray<Message>` 추가**. 거절: ADR-0145 port stability 깨짐. `ResumeOutcome.seedMessages` surface 가 downstream-runner-opt-in 으로 비파괴.
2. **`buildReplaySpec` 가 throw**. 거절: orchestrator 의 NO-THROW per-handle 계약 (ADR-0159) 침해. collapse-to-skip-replay 가 honest.
3. **HEAD-KEEP truncation** (오래된 N 보존). 거절: agent 의 NEXT turn 에 가장 informative 한 건 가장 최근 tool-result tail. ADR-0044 의 negative invariant — 휴리스틱 결정은 검증된 시그널로만.
4. **자동 store 인스턴스화**: orchestrator 가 default `ConversationCheckpointStore` 생성. 거절: store ownership 이 caller 책임 (record 시점 / persistence 결정). default-OFF 정신과 충돌.
5. **`PersistedHandle.snapshotMessages: ReadonlyArray<Message>` 직접 직렬화**. 거절: jsonl-store size blow-up (ADR-0158 의 append-only line-per-state 와 충돌). snapshot id 만 보존하고 별도 store 가 재료 보관 — separation of concern.
6. **`replayMetadata` 만 surface, `seedMessages` 는 surface 안 함**. 거절: downstream runner 가 audit metadata 만 보고는 실제 messages 를 복원할 수 없음. caller 가 ckpt store id 로 재조회하는 round-trip 은 redundant.

## SOTA matrix

| Agent | Conversation snapshot record | Resume-with-seed | Truncation cap |
|---|---|---|---|
| Cursor 3.2.16 | ❌ (in-memory only) | — | — |
| Codex 0.131 | session JSONL (full transcript) | session reinit (~38%) | ❌ unbounded |
| Claude Code 2.1 | session JSONL | rewind | — |
| Hermes / Cline | files + conversation rollback | "Restore Files & Task" | — |
| **quanta (ADR-0124)** | ✅ in-memory | — | LRU (maxEntries=50) |
| **quanta (ADR-0159)** | ✅ via id | fresh fork (task only) | — |
| **quanta (본 ADR)** | ✅ via id | ✅ seed messages via composer | ✅ TAIL-KEEP, policy + ctx 양쪽 cap |

## Follow-up (본 ADR 이 닫지 않는 것)

- **Runner-side seed wire**: 실제 child runner 가 `seedMessages` 를 첫 turn 직전 prepend 하는 path. ADR-0145 port 확장 없이 runner adapter 가 outcome.seedMessages 를 직접 소비하도록. 별도 ADR.
- **Disk-persisted conversation snapshots**: 현재 ADR-0124 store 는 in-memory 라 process restart 후 손실. SQLite/jsonl 어댑터로 disk-backed 변형. Phase 3 후속.
- **Replay metric / span**: outcome.replayMetadata 를 OTel attribute 로 surface (ADR-0144 metrics registry + ADR-0074 span tree).
- **Per-message redaction**: `seedMessages` 가 secret 을 포함할 수 있음 — caller-supplied redaction hook 을 composer 의 post-policy step 으로 끼우는 path. 별도 ADR.
- **CLI `/resume --with-seed` flag**: bootstrap surface 의 opt-in. sibling PR.
