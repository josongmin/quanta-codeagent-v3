# RFC-01 — Persistence / Resume Absorption (Codex A1 / A2 / A7)

**Status**: RE-AUDITED — A7 READY; A2 DESIGN FIRST; A1 NOT READY
**Owner**: (unassigned)
**Source audit**: `docs/analysis/aug-02-competitor-corpus-refresh-audit.md` §3.1 / §3.2 / §3.5
**Discipline**: hellgate (RED e2e → TDD → adversarial audit ≥3R → self-audit); every item lands **default-OFF & byte-identical** when disabled; leaf-crate unit tests (static-first punchcard); measure-first for any efficacy claim.

---

## 2026-08-03 current-HEAD correction (authoritative)

Audit basis: `main@0a00ced392102073fe35eccd202bca92cabd71dc`. 이 절과 아래 과거 초안이 충돌하면 **이 절이 우선**한다.

| Item | corrected verdict | owner delta | admission / stop rule |
|---|---|---|---|
| A1 boot rehydrate | **현재 event fold 설계 DROP.** Kernel JSONL은 wire replay/seq continuity rail이며 semantic state SSOT가 아니다. `SessionEvent`만으로 transcript/tool result/approval/artifact/revision exact 복원은 불가능하고 CLI resume은 이미 `@/session` snapshot을 쓴다. | SDK restart도 기존 `SavedSession` atomic snapshot/loader authority를 확장한다. 별도 checkpoint store/projector는 만들지 않는다. identity는 `{sessionId, throughSeq, revision, schemaVersion}`까지 검증한다. | projection seq가 tip보다 앞서거나 gap/identity mismatch가 있으면 partial rehydrate 금지. tool-use/result, approvals, artifacts, revision exact roundtrip RED가 없으면 구현 시작 금지. |
| A2 ThreadRollback | **real gap, 기존 file owner 재사용.** 새 checkpoint backend와 physical JSONL truncate는 금지한다. | durable `messageId/turnId → ShadowOdb checkpoint tag/SHA` mapping + coordinator. 순서는 `rollback_requested` append → `ThreeWayRestorePort`/ShadowOdb tree mutation → `rolled_back` receipt, 실패 시 `rollback_failed`. Event log는 append-only다. | mapping/SHA 부재·이동, dirty/untracked conflict이면 mutation 없이 fail-closed/HITL. 성공 event를 tree mutation보다 먼저 append하지 않는다. |
| A7 headroom | **대부분 구현됨.** output/total-token cap, `BudgetMeter` headroom, budget breach, proactive/speculative compaction은 기존 substrate다. | context-window headroom의 edge-latched advisory event만 추가한다. 새 rollout hard cap/stop reason은 DROP. | 동일 threshold에서 1회만 emit, reset 조건 명시, gate OFF exact behavior proof. |

실행 순서: **A7 → A2 mapping/coordinator → A1 authority decision**. 아래의 `rehydrateState(events)`, physical log truncate, 새 hard-cap 설계는 superseded candidate이며 구현 근거로 사용하지 않는다.

### SOTA++ direction — durable projection + effect saga

- **Hybrid authority가 목표다.** 현재 `@/session` materialized snapshot을 semantic projection authority로 유지하고 kernel JSONL은 ordered receipt/wire history로 둔다. 완전한 replay schema가 생기기 전에는 event-sourcing을 표방하지 않는다.
- A1은 새 `ProjectionCheckpoint` store를 만들지 않는다. 기존 `SavedSession` schema에 optional projection metadata `{schemaVersion,throughSeq,revision,projectionHash}`와 필요한 semantic state를 추가하고 기존 atomic save/load를 사용한다. full event history 전환은 모든 state-changing input/result의 deterministic replay와 migration proof가 생긴 뒤 별도 결정한다.
- A2는 rollback “command”가 아니라 idempotent operation이다. 기존 session envelope/receipt rail에 `{operationId,targetTurn,checkpointSha,expectedFileHashes}` intent를 기록하고 `ThreeWayRestorePort` effect 뒤 terminal receipt를 기록한다. restart에서 pending을 success로 추정하거나 blind retry하지 않고 operator-visible recovery 상태로 둔다.
- tree mutation authority는 계속 `ThreeWayRestorePort` 하나다. session은 target/receipt를 소유하고 agent adapter가 effect를 실행한다. 새 ODB 또는 session-owned file writer는 금지한다.
- A7 advisory는 기존 activity/observability projection으로만 노출하고 budget/compaction control authority가 되지 않는다.
- **중복 금지:** 새 session store, event projector, rollback writer, checkpoint backend, hash helper를 만들지 않는다. `SavedSession`, existing atomic writer/canonical encoder, session envelope, `ThreeWayRestorePort`, ShadowOdb를 재사용한다.

## 구현 액션리스트 (authoritative)

**SOLID 경계:** durable record의 schema/atomic I/O는 `@/session`, working-tree effect는 `ThreeWayRestorePort`, 둘을 순서화하는 application service는 cross-slice가 허용된 `@/agent`가 소유한다. headroom은 기존 compaction usage의 관찰 projection이며 control policy가 아니다.

### Symbol-level reuse / delete / new ledger

| disposition | existing/new symbol | exact action | 금지되는 평행 구현 |
|---|---|---|---|
| **EXTEND** | `SavedSession`, `saveSessionById`, `loadSessionById` | rollback/checkpoint/projection optional record와 migration만 추가 | `RollbackStore`, `CheckpointStore`, 별도 JSON persistence |
| **REUSE** | `JsonlSessionEventLog` | append-only receipt continuity 확인에만 사용 | event fold projector, physical truncate, semantic SSOT 승격 |
| **REUSE** | `ThreeWayRestorePort`, `defaultThreeWayRestore`, ShadowOdb refs | 유일 file-tree mutation effect | session/file-specific restore writer, 두 번째 ODB |
| **EXTEND** | `rewindSession` | coordinator 결과 뒤 transcript projection 갱신 | CLI/SDK별 rewind 구현 |
| **EXTEND** | `resolveCompactionLimitTokens`, compaction `UsageSnapshot` | A7 입력 authority로 직접 사용 | token/headroom estimator 또는 별도 limit knob |
| **NEW — ONE ONLY** | `thread-rollback` application service under `src/agent/` | intent→effect→terminal 순서화만 담당 | store/hash/restore 구현을 application service에 포함 |

**삭제/대체 완료 조건:** archive의 `rehydrateState(events)`, rollout hard cap, physical log truncate 후보는 production symbol/knob/test를 만들지 않는다. CLI와 SDK에 별도 rollback orchestration이 생기면 해당 change는 merge 불가다.

### RFC01-0 — durable rollback contract 고정 (P0, S)

- **Depends:** 없음.
- **Owner/write-set:** `src/session/types.ts`, `src/session/store.ts`, 신규 `src/session/rollback-record.ts`, `tests/unit/session-store.test.ts`.
- **Actions:**
  1. `SavedSession`에 optional, versioned `rollbackCheckpoints[]`와 `rollbackOperations[]`를 추가한다. checkpoint는 `{turnId,messageId,checkpointSha,expectedFileHashes}`를, operation은 `{operationId,targetTurnId,state: requested|rolled_back|rollback_failed,requestedAt,terminalAt?,errorCode?}`를 가진다.
  2. 기존 session atomic load/save와 canonical encoder만 사용해 intent/terminal receipt를 저장한다. kernel JSONL은 물리 truncate하지 않는다.
  3. schema migration은 구버전 record를 빈 optional collection으로 읽는 방향만 허용하고 unknown state/version은 fail-closed 한다.
- **RED:** intent 저장 후 process를 끊고 reload했을 때 pending operation과 checkpoint identity가 exact round-trip되지 않는 테스트.
- **GREEN/DoD:** old snapshot 호환, canonical round-trip, duplicate `operationId` idempotency, missing/moved SHA no-mutation proof.
- **Stop:** 별도 DB/JSONL/store/hash helper가 필요해지거나 full transcript state가 이 schema에 중복되면 중단하고 owner contract를 재감사한다.

### RFC01-1 — A7 context-headroom advisory (P0, S)

- **Depends:** 없음. RFC01-0과 병렬 가능.
- **Owner/write-set:** `src/agent/compaction/types.ts`, `src/agent/compaction/background.ts`, `src/agent/loop/compaction-wire.ts`, `src/stream/types.ts`, 신규 `tests/unit/context-headroom-advisory.test.ts`.
- **Actions:**
  1. 현재 `UsageSnapshot {usedTokens,limitTokens}`와 compaction threshold를 입력으로 받는 pure edge latch를 둔다. 별도 token estimator/limit knob은 만들지 않는다.
  2. 기존 `AgentEvent`에 stable, low-cardinality `context_headroom_crossed` arm을 추가하고 `{usedTokens,limitTokens,thresholdTokens}`만 보낸다.
  3. 동일 crossing에서는 1회 emit하고 compaction/usage가 reset boundary 아래로 돌아온 뒤에만 재-arm한다. event consumer가 loop stop/compaction trigger를 결정하지 못하게 한다.
- **RED:** threshold 아래→위→위→reset→위 입력에서 event count가 `2`가 아닌 owner-local test.
- **GREEN/DoD:** existing measured/estimated baseline과 동일 수치, gate OFF event/text/spec deep-equal, exhaustive event projections compile.
- **Stop:** `BudgetMeter` 또는 context-warning의 두 번째 usage 계산이 필요하거나 advisory가 control authority가 되면 DROP한다.

### RFC01-2 — checkpoint mapping capture (P0, M)

- **Depends:** RFC01-0.
- **Owner/write-set:** `src/agent/per-tool-checkpoint/port.ts`, `src/agent/per-tool-checkpoint/three-way-restore.ts`, `src/storage/shadow-odb/`, 신규 `src/agent/thread-rollback-checkpoint.ts`, `tests/unit/per-tool-checkpoint-hellgate.test.ts`.
- **Actions:**
  1. turn이 durable boundary에 도달할 때 existing ShadowOdb ref/SHA를 `turnId/messageId`에 결합한다. 임의 branch/path 이름으로 checkpoint를 추정하지 않는다.
  2. checkpoint와 expected file hashes를 RFC01-0 record에 저장한 뒤에만 rollback target으로 노출한다.
  3. dirty/untracked/unrelated files 보존 계약을 기존 three-way restore test matrix에 추가한다.
- **RED:** target mapping 없음, moved SHA, unrelated dirty file 각각에서 restore가 호출되거나 file이 변하는 테스트.
- **GREEN/DoD:** exact target만 restore 가능하고 stale/missing/conflict는 typed refusal이며 모든 unrelated content는 byte-identical.
- **Stop:** ShadowOdb 외 checkpoint backend 또는 session-owned file writer가 필요하면 중단한다.

### RFC01-3 — ThreadRollback effect saga + product wire (P0, M-L)

- **Depends:** RFC01-0, RFC01-2.
- **Owner/write-set:** 신규 `src/agent/thread-rollback.ts`, `src/session/rewind.ts`, `src/apps/cli/rewind-cmd.ts`, `src/apps/cli/repl/per-tool-checkpoint-wire.ts`, `tests/integration/session-rewind-e2e.test.ts`, `tests/unit/session-rewind-reconcile-e2e-hellgate.test.ts`.
- **Actions:**
  1. `@/agent` coordinator가 `requested` persist → `ThreeWayRestorePort.restore` → terminal receipt persist 순서만 실행한다. transcript projection은 effect 성공 뒤 existing rewind owner가 갱신한다.
  2. restart에서 pending은 `recovery_required`로 surface하고 자동 성공/재시도하지 않는다. 동일 `operationId` 재호출은 terminal receipt를 반환한다.
  3. CLI/SDK entry는 coordinator 한 곳을 호출하고 각각 file restore를 재구현하지 않는다.
- **RED:** intent 뒤 crash, restore 뒤 terminal persist 전 crash, restore conflict, duplicate submit의 4개 integration fixture.
- **GREEN/DoD:** success-before-effect 불가능, pending operator-visible, append-only history 유지, transcript/file checkpoint identity 일치.
- **Stop:** rollback 중 현재 turn identity가 바뀌거나 tree mutation caller가 둘 이상 생기면 publish 금지.

### RFC01-4 — A1 boot rehydrate admission (P1, M; conditional)

- **Depends:** RFC01-0 및 full-fidelity snapshot contract RED.
- **Owner/write-set:** `src/session/types.ts`, `src/session/store.ts`, `src/sdk/runtime/session.ts`, `tests/integration/crash-resume-hellgate.test.ts`, `tests/integration/session-envelope-store-seam.test.ts`.
- **Actions:**
  1. tool-use/result, approval state, artifacts, transcript, revision을 한 `SavedSession` projection으로 exact round-trip하는 failing fixture를 먼저 고정한다.
  2. optional `{schemaVersion,throughSeq,revision,projectionHash}`를 existing snapshot에 추가하고 boot loader가 identity/gap/hash를 검증한 뒤에만 runtime 초기 상태를 주입한다.
  3. kernel JSONL `tip()`은 receipt continuity 검증에만 사용한다. events-only fold와 partial merge는 하지 않는다.
- **RED:** 각 semantic component 하나씩 누락/변조했을 때 resume가 거부되지 않는 fixture.
- **GREEN/DoD:** clean restart exact equality, gap/ahead/hash mismatch fail-closed, old snapshots는 명시적 non-rehydrate path, CLI와 SDK 동일 loader.
- **Stop:** 현재 state를 lossless하게 encode할 owner가 확정되지 않거나 event fold가 다시 필요해지면 **NOT READY**로 유지한다.

### Landing rail

1. `bun test tests/unit/session-store.test.ts tests/unit/per-tool-checkpoint-hellgate.test.ts tests/unit/shadow-odb-hellgate.test.ts`
2. `bun test tests/unit/session-rewind-reconcile-hellgate.test.ts tests/unit/session-rewind-reconcile-e2e-hellgate.test.ts tests/integration/session-rewind-e2e.test.ts`
3. `bun test tests/unit/loop/token-baseline-capture-hellgate.test.ts tests/unit/background-compaction-hellgate.test.ts tests/integration/crash-resume-hellgate.test.ts`
4. `bun run typecheck`와 `bun test tests/unit/god-code-ratchet.test.ts`.

Rail 1은 schema/effect owner, Rail 2는 product rollback, Rail 3은 A7/A1 conditional proof다. 새 test 이름은 해당 packet의 RED부터 추가하되 기존 rail을 대체하지 않는다.

## Archived pre-correction draft (non-authoritative)

아래 내용은 최초 gap 가설과 adversarial audit 이력을 보존하기 위한 것이다. 구현 ticket/DoD/노력치는 위 current-HEAD correction과 README만 사용한다. README의 중복/휴리스틱 삭제 register와 충돌하는 archive 항목은 구현 후보로 복구하지 않는다.

### Original motivation

Codex 5973's largest engine-side gap (per the corpus refresh) is a durable persistence substrate: an append-only **rollout** log projected into current state via a **byte-offset cursor** (`thread_history_projection_state.next_rollout_byte_offset`), a turn-level **ThreadRollback** op + `ThreadRolledBackEvent`, and a **rollout_budget** / **SafetyBuffering** headroom signal. The audit flagged this HIGH-ROI as the toolchain for crash-recovery and durable resume.

The **"backlog=graveyard" lesson (jul-18)** demands we confirm the *real* delta against `src/` before designing. This RFC does that first, and the result substantially re-scopes all three items — most of A1 is **already built**.

## Non-goals

- SQLite adoption for the session log. Grounding (below) shows quanta's append-only JSONL + `tip()` high-water mark is already the functional equivalent of Codex's rollout+byte_offset; introducing a `bun:sqlite` thread store would be re-inventing a shipped seam and adding a schema-migration surface for no measured gain. (SQLite reuse is noted only as an *available* pattern, not adopted.)
- Multi-agent `thread_spawn_edges` RECURSIVE-CTE traversal — quanta already has subagent lineage (jul-15 sub-agents panel); out of scope here.
- Power-loss / OS-crash `fsync` durability as a *hard* guarantee (see A1-c: offered as an opt-in policy, not the default).
- Efficacy claims. This RFC ships mechanism default-OFF; any "resume improves X" claim is a separate measure-first task.

---

## Current state (code-grounded — this is the load-bearing section)

### A1 — on-disk rollout → projection: **ALREADY ~80% BUILT**

quanta has **two** on-disk session rails, both append-only JSONL, plus a snapshot:

1. **`@/session` rail** (`src/session/`, ADR-0034):
   - Whole-file atomic snapshot `<sessionsRoot>/<id>.json` (V2 schema, `SavedSession`), real-atomic via per-writer `.tmp.<pid>.<rand>` + `rename()` — `src/session/store.ts:66-80`. This is the resume SSOT today.
   - Append-only event log `<id>.jsonl` with 5 record kinds (`session_meta`, `turn_context`, `event_msg`, `response_item`, `thread_spawn`) — `src/session/envelope.ts:1-20`. Canonical byte-identical encoding (sorted keys) — `src/session/envelope-encoder.ts:1-16`. Append primitive `appendEnvelope` — `src/session/store.ts:543-553`.
   - Crash-resume: persisted `interruptedTurn` marker on `SessionMeta` — `src/session/types.ts:64-92`; recovery module `src/session/crash-resume.ts` (289 lines); wired via `src/runner/orchestrate/crash-resume-wire.ts`.
   - **FINDING**: the `<id>.jsonl` append log has **no production appender wired outside the store** — grep for `appendEnvelope`/`turn_context` writers in `src/runner`/`src/agent` returns only the batch `turnContextMutator` config slot, not a session-log writer. The `.jsonl` rail is a *built-but-largely-dormant* replay log; the `.json` snapshot is the live SSOT. This is a real (small) delta.

2. **`@/kernel/session` rail** (`src/kernel/session/`) — **the live resume substrate**:
   - `KernelEventLogPort` (`ports.ts:254-256`): `append(SessionEvent)` / `list()`.
   - `InMemorySessionEventLog` (default) — `event-log.ts`.
   - `JsonlSessionEventLog` (`event-log-jsonl.ts`, 312 lines): append-only `<dir>/<sessionId>.jsonl`, one `@/protocol/session` codec envelope per line; **`tip()`** = max seq high-water mark (the byte-offset-cursor equivalent), **`readFrom(afterSeq)`** = replay feed, crash-torn-final-line recovery (truncate + warn), single-writer hardlink lock with dead-pid reclaim. Durability policy: per-append `writeSync` on O_APPEND fd survives *process* crash; `fsync` deliberately NOT issued (documented, ticket-05-deferred).
   - Composition seam `createSessionPersistence` gated by **`QUANTA_SESSION_EVENT_LOG_DIR`** (DEFAULT-OFF) — `src/host/runtime/persistence.ts:24-31`.
   - **Resume consumer is LIVE**: `src/sdk/runtime/session.ts:48-55` reads `durableLog.tip()` and resumes seq issuance from it; `src/sdk/connect.ts` surfaces `resume: "replayed" | "snapshot_fallback"`; `src/ipc/session/attach-flow.ts` carries the resume outcome.

   **FINDING**: seq issuance resumes from `tip()`, but **`revision` and the transcript projection do NOT rehydrate** on cold start — `session.ts:56` comment: *"revision deliberately does NOT resume here"*, and `createKernelSessionState` starts with an empty transcript regardless of the durable log. The reducer (`reducer.ts`, 301 lines) is a pure event→state projector but is **not driven over `readFrom(0)` at boot**. So today: a restart continues *seq numbering* but starts with an *empty conversation*. **This is the genuine A1 delta** — projection-rehydrate, not the store itself.

**Net A1 delta**: (a) drive the reducer over `durableLog.readFrom(0)` at session create to rehydrate transcript + revision (cold-start projection); (b) reconcile the two dormant/live JSONL rails (decide SSOT: promote kernel log, keep `@/session` snapshot for CLI listing UX, or bridge); (c) optional fsync-batching durability policy. **NOT** a new SQLite store.

### A2 — ThreadRollback op + event: **GENUINE GAP (partial base exists)**

- `rewindToMessage(id, msgId)` (transcript truncation, snapshot-write) + `forkSession` — `src/session/store.ts`; typed wrapper `rewindSession` — `src/session/rewind.ts:1-55`.
- **FINDING**: `rewindSession` **does NOT restore file state** — `rewind.ts:17-24`: *"NEVER resets the working tree ... File restore now safely degrades to 'unchanged' until a per-message checkpoint mapping is wired."* The `RewindGitPort` exists but is a soft no-op when unwired.
- **FINDING**: `quanta.turn.rolled_back` is defined in the observability vocabulary (`src/observability/vocabulary.ts:58`) but is **UNUSED** — no emitter anywhere in `src/`. There is **no `ThreadRollback` submission op and no `ThreadRolledBackEvent`** in `@/protocol/session`.
- Shadow-ODB checkpoint infra EXISTS (`src/storage/shadow-odb/`) — content-addressed store with atomic init markers — a viable per-turn checkpoint backend to wire the missing file-restore to.

**Net A2 delta**: promote rewind from a REPL-only transcript truncation to a first-class turn-level op (`ThreadRollback` command + `ThreadRolledBackEvent`) that (i) truncates the kernel event log to a checkpoint seq and (ii) restores applied edits via a per-turn shadow-ODB checkpoint. Emit the already-reserved `turn.rolled_back` vocab.

### A7 — rollout_budget + SafetyBuffering: **GENUINE GAP**

- Compaction is **reactive-only**: `src/agent/compaction.ts` triggers on `triggerTokenCount` ≥ threshold and summarizes with reason `token_budget_exceeded` (`compaction.ts:817`) — *after* the fact. No pre-overflow headroom event.
- Objective store has a `budget_limited` state (`src/agent/objective/types.ts:47`, `store.ts:97`) but that is **goal-scoped** (a `/goal`'s own token/turn cap), not a per-turn bounded-autonomy output budget, and it produces no headroom-warning event.
- **FINDING**: no `SafetyBuffering` / pre-overflow event; no `rollout_budget` output cap distinct from compaction threshold.

**Net A7 delta**: (a) a `SafetyBuffering` event emitted when projected turn output crosses a headroom fraction of the context/compaction limit (pure derivation off the existing `token-baseline` numbers — no new estimator); (b) an optional `rollout_budget` hard cap on cumulative turn output that stops the loop with a typed reason. Both observability/policy, default-OFF.

### God-code / ratchet baseline (must not regress)

- `src/kernel/session/scheduler.ts` = **975 lines** — perilously close to the 1000-line god-module ratchet. **Do not add to it.**
- `src/session/store.ts` = 625, `src/session/import-export.ts` = 635, `event-log-jsonl.ts` = 312, `reducer.ts` = 301. New code must land in new files, not these.

---

## Design

Reuse-first. Concrete files to add/touch, per item.

### A1 — cold-start projection rehydrate (+ rail reconciliation)

**Flow**: `createRuntimeSession` (`src/sdk/runtime/session.ts`) already grabs `durableLog = isDurableSessionEventLog(...)`. When `durableTip > 0`, instead of only setting `seq: durableTip`, fold `durableLog.readFrom(0)` through the existing pure `reducer.ts` to reconstruct `{ transcript, revision, seq }`.

- **Add** `src/kernel/session/rehydrate.ts` (~120 lines, new file — keeps scheduler/reducer untouched): `rehydrateState(events, hostDescription) → KernelSessionState`. Pure fold reusing `reducer`'s event handlers (extract the event→state arm into a shared `applyEvent` if not already isolated; if extraction would bloat `reducer.ts`, add a thin `projectEvents` export instead — measure line delta first).
- **Touch** `src/sdk/runtime/session.ts:53-55`: `const initialState = durableTip > 0 ? rehydrateState(durableLog.readFrom(0), hostDescription) : createdState`. Guarded so in-memory log path is **byte-identical** (no durable log ⇒ `createdState` unchanged).
- **Rail reconciliation (decision)**: keep the `@/session` `<id>.json` snapshot as the CLI-listing/UX SSOT; treat the `@/kernel/session` JSONL as the authoritative *event* rail for resume. Do **not** wire the dormant `@/session` `.jsonl` appender — retiring/documenting it is cheaper than dual-writing (avoids the two-appender crash-consistency hazard, see R1). Add a doc note in `envelope.ts` marking the `@/session` `.jsonl` as replay-only/dormant.
- **A1-c optional durability**: `src/kernel/session/event-log-jsonl.ts` add an opt-in `fsyncPolicy: "none" | "batch"` (default `"none"` = byte-identical). `"batch"` fdatasyncs on `close()` and every N appends. Gated behind the same dir env + a `QUANTA_SESSION_EVENT_LOG_FSYNC` sub-knob.

### A2 — ThreadRollback op + event

**Data/protocol** (`@/protocol/session`):
- **Add** command `ThreadRollback { toSeq: number }` (builder in `builders`, mirroring `buildTurnCancel`).
- **Add** event `ThreadRolledBackEvent { fromSeq, toSeq, restoredCheckpoint?: string }`.
- **Touch** `reducer.ts`: a `rollback` arm that truncates transcript to the message at `toSeq`, bumps revision, emits `ThreadRolledBackEvent`. Pure — no fs. (Watch line budget; if it pushes reducer past ~340, split the rollback arm into `reducer-rollback.ts`.)

**Effect side** (composition, not reducer):
- **Add** `src/session/rollback-checkpoint.ts` (~150 lines): per-turn checkpoint capture/restore over **existing** `src/storage/shadow-odb/` — snapshot the working tree to a content-addressed ref at turn start; on rollback, restore that ref. Injected `RewindGitPort`-style port so `@/session` stays layer-isolated.
- **Wire** `rewindSession` (`src/session/rewind.ts`) to dispatch the new op when the durable rail is active, and fill the currently-degraded `fileStateNote` with a real restore. CLI `/rewind` (`src/apps/cli/rewind-cmd.ts`) unchanged in shape.
- **Emit** `quanta.turn.rolled_back` (already reserved, `vocabulary.ts:58`).

### A7 — SafetyBuffering + rollout_budget

- **Add** `src/agent/compaction/headroom.ts` (~90 lines): pure `computeHeadroom(currentTokens, limitTokens, fraction) → { crossed, headroomTokens }` off the existing `token-baseline` numbers (`resolveCompactionLimitTokens`, `triggerTokenCount`). Emit a `SafetyBuffering` event when `crossed` flips true (edge-triggered, once per crossing).
- **Add** `SafetyBufferingEvent` + optional `RolloutBudgetExceededEvent` to `@/protocol/session` (or the agent event bus — pick the surface the loop already emits on; do not duplicate).
- **rollout_budget**: an optional cumulative-output-token cap on the agent loop; when exceeded, stop with typed reason `rollout_budget_exceeded` (reuse the recovery-reason enum family, `src/agent/recovery-reason.ts`). Distinct from goal `budget_limited`.

---

## Data model

No SQL. Everything rides the existing JSONL envelope + protocol codec.

**Kernel event log line** (unchanged wire — `@/protocol/session` `encodeSessionEvent`), new event variants appended to the closed union:
```
SessionEvent =
  | ...existing...
  | { type: "thread_rolled_back", seq, fromSeq, toSeq, restoredCheckpoint? }
  | { type: "safety_buffering",  seq, headroomTokens, limitTokens }
  | { type: "rollout_budget_exceeded", seq, usedTokens, capTokens }   // optional
```
**Projection cursor**: reuse `tip()` (max seq) — the byte-offset equivalent. No `next_rollout_byte_offset` column; the JSONL line boundary + seq is the cursor.

**Checkpoint index** (A2): reuse `src/storage/shadow-odb/` content-addressed refs; per-turn ref recorded on the `turn_context`-equivalent kernel event (add `checkpointRef?` to the turn-start event). No new table.

---

## Default-OFF gate

- **A1 projection-rehydrate**: rides the **existing** `QUANTA_SESSION_EVENT_LOG_DIR` gate. Unset ⇒ in-memory log ⇒ `durableTip === 0` ⇒ `createdState` untouched ⇒ **byte-identical**.
- **A1-c fsync**: `QUANTA_SESSION_EVENT_LOG_FSYNC` (default off ⇒ `"none"` ⇒ byte-identical writeSync path).
- **A2 ThreadRollback**: new event variants are additive to a closed union (existing readers ignore unknown? — NO, quanta uses exhaustive `Record<Union,…>` guards, so adding a variant is a *compile-forced* update, which is the desired drift-guard, not a runtime break). The op is only dispatchable when the durable rail + a new `QUANTA_THREAD_ROLLBACK` gate are on; CLI `/rewind` keeps its existing `QUANTA_REWIND` gate and its current degraded behavior when the new gate is off ⇒ **byte-identical**.
- **A7**: `QUANTA_SAFETY_BUFFERING` / `QUANTA_ROLLOUT_BUDGET` — unset ⇒ no event emitted, loop unchanged ⇒ **byte-identical**.

All gates live in `src/config/knob-inventory/extra.ts` next to the existing `QUANTA_SESSION_EVENT_LOG_DIR` entry, with the same drift-guard.

---

## TDD + hellgate plan (leaf-crate unit tests; static-first)

1. **RED e2e first** (per item):
   - A1: a hellgate that starts a durable session, appends N events, drops the runtime, re-creates it, and asserts the **transcript** (not just seq) is restored. Today this is RED (transcript empty). Fixture in `src/kernel/session/__tests__/rehydrate-hellgate.test.ts`.
   - A2: hellgate — apply an edit in turn 2, `ThreadRollback` to turn-1 seq, assert (i) `ThreadRolledBackEvent` emitted, (ii) transcript truncated, (iii) working-tree file reverted via shadow-ODB. RED today (no op, file-restore is a no-op).
   - A7: hellgate — feed a transcript that crosses the headroom fraction, assert exactly one `SafetyBuffering` event (edge-triggered), and that crossing the hard cap stops with `rollout_budget_exceeded`.
2. **red-on-injection** for each: revert the projection fold / the rollback arm / the headroom emit in-tree and confirm the hellgate goes RED (guards against vacuous tests — jul-13 lesson: fake-endpoint tests hid 6 seam bugs).
3. **Byte-identical proof**: a test asserting that with all new gates unset, `createRuntimeSession` produces a state deep-equal to `createKernelSessionState(hostDescription)` and no fs write occurs (spy on the fd).
4. **Concurrency**: reuse/extend the single-writer-lock tests already in `src/kernel/session/__tests__/`; add a two-writer race asserting the second open fails closed.
5. **Crash-consistency**: extend the torn-final-line recovery test to cover a rollback-truncation interleaved with a torn append.
6. Adversarial audit ≥3R (below) → self-audit → structural TDD backfill.

No full build required for the unit layer (`bun test <leaf>` only) — punchcard-compatible.

---

## Effort (S/M/L)

| Item | Scope | Effort |
|---|---|---|
| A1-a cold-start projection rehydrate | new `rehydrate.ts` + 3-line `session.ts` touch + hellgate | **S–M** |
| A1-b rail reconciliation (doc dormant `@/session` .jsonl, no dual-write) | doc + guard test | **S** |
| A1-c opt-in fsync-batch durability | `event-log-jsonl.ts` policy + knob | **M** |
| A2 ThreadRollback op+event (protocol + reducer arm) | protocol codec + reducer + drift-guard | **M** |
| A2 shadow-ODB per-turn checkpoint + file-restore wire | new `rollback-checkpoint.ts` + rewind wire | **M–L** |
| A7 SafetyBuffering event | pure `headroom.ts` + emit | **S** |
| A7 rollout_budget hard cap | loop stop-reason + knob | **S–M** |

Total: no L-alone item except the A2 checkpoint restore (the only piece touching the working tree). A1's headline "on-disk store" collapses to **S–M** because the store already ships.

---

## Risks + traps

- **backlog=graveyard (realized)**: A1's assumed "in-memory only" (jul-16 memory) was **stale** — `JsonlSessionEventLog` + live `connect({resume})` already exist. Designing a SQLite thread store would have been pure re-invention. The real delta is projection-rehydrate.
- **Dual-rail crash-consistency**: two JSONL logs (`@/session` + `@/kernel/session`) with different codecs. Dual-writing invites split-brain on crash. Design deliberately does **not** dual-write (A1-b).
- **god-code**: `scheduler.ts`=975, near the 1000 ratchet. New logic goes in new files; reducer arms split if they push `reducer.ts` past budget.
- **Concurrent sessions commit to this repo** (memory: concurrent-session-git-hazard): the shadow-ODB checkpoint restore (A2) does a working-tree mutation — must NOT `git reset --hard` blindly (the existing `rewind.ts` already learned this: interior rewind wiped turns 1..N). Restore is scoped to the checkpoint ref, stash-first, never a session-start SHA.
- **fsync default**: leaving fsync off means power-loss can lose the final batch. Documented; hard durability is opt-in only, matching the shipped policy comment.
- **Closed-union drift**: adding event variants is compile-forced across `Record<Union,Verdict>` guards (exhaustive-record pattern) — a feature, but touches every projection site; budget for the cascade.
- **Vacuous-test trap**: seq-only resume tests would pass without transcript rehydrate. Hellgate asserts transcript content + red-on-injection.

---

## Sequencing / deps on other RFCs

- A1 depends on **ADR-0540 Wave 2 / transport-unified-sdk ticket 05** (the `connect({resume})` consumer). That consumer is LIVE; A1-a is the missing projection half — can land independently.
- A2 file-restore depends on `src/storage/shadow-odb/` (shipped) — no external RFC.
- A7 is independent (rides `@/agent/compaction` token-baseline).
- Order: **A1-a → A1-b** (foundation) → **A7** (cheap, independent) → **A2** (heaviest; needs A1's durable rail active to truncate the event log).

## Open questions

1. Rail reconciliation: retire the dormant `@/session` `.jsonl` appender outright, or keep it as a CLI-only replay artifact? (Leaning retire-with-doc.)
2. Should `revision` rehydrate too, or stay a fresh-per-process counter? (Ticket-05 comment defers it; A1-a proposes rehydrating it for true continuity — needs the ticket-05 owner's sign-off.)
3. `rollout_budget` surface: agent-loop stop-reason vs protocol event — which bus does the loop already emit stop-reasons on? (Confirm before duplicating.)
4. Checkpoint granularity: per-turn shadow-ODB snapshot cost on large trees — measure before default-considering.

---

## Audit log (R1 → R2 → R3)

### Round 1 — adversarial: "the plan re-invents shipped infra"

**Attack**: The mandate's A1 ("add a SQLite thread store") assumes no on-disk log exists. Grep says otherwise: `JsonlSessionEventLog` (`event-log-jsonl.ts`) + `tip()`/`readFrom` + `connect({resume})` consumer are LIVE. A SQLite DDL port would be a graveyard re-build (jul-18) and would add a schema-migration + `bun:sqlite` handle-lifecycle surface (cf. the WAL-handle release dance in `context-binding.ts:222`) for zero measured benefit.
**Also found**: the *assumed* delta (persistence) is wrong; the *real* delta is that seq resumes but **transcript/revision do not** (`session.ts:56`). Two separate JSONL rails exist (`@/session` dormant-appender vs `@/kernel/session` live) — a hidden dual-write coupling hazard if a naive design "just also writes the session log."
**Design change**: dropped SQLite entirely (Non-goal #1). Re-scoped A1 to **projection-rehydrate** (A1-a) + explicit **no-dual-write** rail reconciliation (A1-b). Effort dropped from L to S–M.

### Round 2 — adversarial: "byte-identical / god-code / concurrency violations"

**Attack 1 (byte-identical)**: A1-a touches `session.ts`'s hot `createRuntimeSession`. If rehydrate runs unconditionally it breaks the in-memory (default) path. **Check**: guarded by `durableTip > 0`, and in-memory log has no `tip()` ⇒ `durableTip=0` ⇒ `createdState` untouched. Added an explicit byte-identical test (TDD step 3) spying the fd for zero writes. **Pass after guard.**
**Attack 2 (god-code)**: adding a reducer arm for rollback + rehydrate fold to `reducer.ts` (301) or `scheduler.ts` (975) risks the 1000/150 ratchet — `scheduler.ts` is 25 lines from the module cap. **Change**: rehydrate → new `rehydrate.ts`; rollback arm splits to `reducer-rollback.ts` if `reducer.ts` exceeds ~340; NOTHING added to `scheduler.ts`. Documented in Risks.
**Attack 3 (concurrency/git)**: A2 file-restore mutates the working tree while concurrent sessions commit to this repo (memory hazard). A blind `git reset --hard <session-start-sha>` is exactly the data-loss bug `rewind.ts:17-24` already documents. **Change**: restore is scoped to a **per-turn** shadow-ODB checkpoint ref, stash-first, never a coarse session SHA. Added to Risks + the A2 hellgate asserts only the intended file reverts.
**Attack 4 (vacuous test)**: a "resume works" test that only checks `seq` would be green today yet the transcript is empty. **Change**: hellgate asserts transcript *content* + red-on-injection (revert the fold → RED). Added as TDD steps 1–2.

### Round 3 — adversarial (convergence): "crash-consistency + hidden ordering + drift"

**Attack 1 (crash-consistency)**: rollback truncates the kernel event log; a crash between "truncate log" and "restore working tree" leaves log and tree out of sync (Codex's `ThreadRollbackFailed`, noted in `error-classifier.ts:131`). **Resolution**: order the effect so the event log is the SSOT — append `ThreadRolledBackEvent` **first** (durable), then restore the tree; on restart, an un-restored rollback event is idempotently re-applied from the checkpoint ref (the ref is content-addressed, restore is idempotent). No new mechanism — reuses shadow-ODB idempotence + torn-line recovery. Converges: no code change to the plan, only the ordering is now specified (mirrors the existing `close()` "append terminal event FIRST, then release fd" discipline in `session.ts`).
**Attack 2 (closed-union drift)**: three new `SessionEvent` variants ripple through every exhaustive `Record<Union,Verdict>` projection (exhaustive-record-classification-drift-guard). Could silently under-handle. **Resolution**: this is desired — the compile-forced update IS the drift-guard; budgeted as "the cascade" in Risks. Not a defect.
**Attack 3 (A7 double-fire)**: a token-count that oscillates around the headroom fraction would spam `SafetyBuffering`. **Resolution**: edge-triggered (emit once per crossing, latch until it drops back below), asserted in the A7 hellgate ("exactly one event"). Already in the design; now pinned by test.
**No new structural changes** — R3 refined ordering + test assertions only. **Converged.**
