# GOAL-01 — Domain v2, snapshot migration, and public mutator closure

> **ARCHIVED TICKET** — 당시 실행 입력이다. 현재 판정은 **DONE**이다. 세부 잔여 계획은
> [`../NEXT-PLAN.md`](../NEXT-PLAN.md)를 따른다.

> **구현 대조 (2026-08-30, 코드 확인)** — 도메인은 명세대로 랜딩했고 이름이 여럿 다르다.
> - `OBJECTIVE_MUTATION_KINDS` → `OBJECTIVE_OPERATION_KINDS`(`src/objective/mutations.ts`) · `ObjectiveReadPort`에 `getRevision` 없음(`get/list/readDomain`) · 명세된 6개 이름있는 capability(`VerifierCommitPort` 등)는 존재하지 않고 actor-keyed `ObjectiveCapabilities` 하나로 통합됐다(`src/objective/capabilities.ts`).
> - mutation union에 티켓에 없는 `markCriterionVerified`·`abandonAttempt`가 추가돼 있다.
> - "CLI·모델·웹이 같은 한도를 **import**한다"는 미구현 — `slash/goal-cmd.ts`와 `tool/objective/index.ts`가 4000을 각자 리터럴로 재선언한다.
> - mutator closure는 타입이 아니라 allowlist 라쳇으로만 강제된다: `ObjectivePort`가 아직 11개 직접 writer를 노출한다(`src/objective/types.ts`).
> - RED 10/12/13은 부분 커버(스테일 revision 재커밋, CLI·웹 경계의 4000자 케이스, 스냅샷 버전 parity 테스트가 각각 없음).

**Priority:** P0 · **Depends on:** GOAL-00R · **Owner:** objective domain/schema

**Receipt:** docs/plans/aug-25-goal-v2/receipts/GOAL-01.yaml

## Purpose

Make one authority the only writer, bind every receipt to an authority-issued objective generation, remove direct status/usage mutation, and migrate persisted sessions without attaching legacy evidence to a new goal.

## Write set

- src/objective/{types,provenance,mutations,authority,identity,index}.ts
- src/objective/core-store/{cell,rehydrate,objective-ops}.ts
- src/objective/{progress-receipt,criteria/model}.ts
- src/session/{types,store}.ts plus the existing runner snapshot build/restore adapters
- Direct consumers that no longer compile after public mutators are removed
- Owner-local unit, migration, architecture, and persistence tests

provenance.ts owns ObjectiveActor and creator types. types.ts and mutations.ts import it; types.ts must not import mutations.ts.

## Domain contract

    type ExplicitObjectiveStatus = "active" | "paused"
    type ObjectiveActor = "user" | "model" | "continuation" | "verifier" | "system"

    type ObjectiveMutation =
      | { kind: "create"; definition: GoalDefinition }
      | { kind: "replace"; definition: GoalDefinition }
      | { kind: "clear" }
      | { kind: "setExplicitStatus"; status: ExplicitObjectiveStatus }
      | { kind: "addBlocker"; reason: string; waitingOn: WaitingOn }
      | { kind: "clearBlocker"; blockerId: string }
      | { kind: "setNextActions"; actions: readonly string[] }
      | { kind: "markCriterion"; criterionId: string; met: boolean }
      | { kind: "amendBudget"; budget: ObjectiveBudgetLimit }
      | { kind: "invalidateVerification"; objectiveId: string; checkIds: readonly string[]; receiptIds: readonly string[]; observedSourceDigest?: string; reason: VerificationInvalidationReason }
      | { kind: "applyVerificationBatch"; batch: VerificationBatch }
      | { kind: "beginAttempt"; attempt: ObjectiveAttemptStart }
      | { kind: "settleAttempt"; settlement: ObjectiveAttemptSettlement }
      | { kind: "markUsageLimited"; untilEpochMs: number }
      | { kind: "restore"; snapshot: ObjectiveDomainSnapshot }

- Remove set, updateStatus, and recordUsage.
- Objective gains objectiveId, createdBy, and optional migrationSource: legacy-v1.
- Domain normalization owns MAX_GOAL_CHARS=4000 for create/replace/migration. CLI, model, web, and codecs import or exercise this same limit.
- create requires absence. replace requires presence and issues a new ID. Caller input never contains an ID.
- clear deletes core and progress state and increments the thread revision; it never resets revision to zero.
- Snapshot v2 persists a thread authority envelope even when objective is null: threadId, monotonic revision, objective:null, and empty progress. This tombstone rejects stale pre-clear commands after restart.
- Pause/resume and same-ID budget amendment preserve the ID.
- replace preserves the supplied definition, but all completion, verifier, blocker, next-action, attempt, and progress evidence starts empty.
- OBJECTIVE_MUTATION_KINDS is exhaustive and independently checked against dispatch and policy tables.

## Authority boundary

Introduce ObjectiveReadPort with readDomain/getRevision. Keep the raw ObjectiveAuthority inside the composition root; ordinary consumers do not receive it.

- Composition mints actor-fixed capabilities: ModelObjectiveCommands, UserGoalControl, VerifierCommitPort, SettlementPort, UsageLimitPort, and AttachRestorePort.
- Actor is not serialized in model/web mutation payloads and is not caller-selectable. Each capability binds actor and its allowed mutation subset before prepare/commit.
- Compatibility helpers may exist only as private composition/test adapters over an actor-fixed capability.
- Tool, slash/web, verifier, settlement, usage-limit, and attach each receive only their narrow capability plus ObjectiveReadPort. No consumer imports a cell writer or raw authority.
- Add an architecture test scanning live calls, with an anti-vacuum floor and an injected forbidden call, so deleting the actual authority call turns the test red.

## Identity and snapshot migration

- Default ID factory: crypto.randomUUID().
- Legacy ID: versioned, length-delimited canonical hash over thread ID, goal, created time, and schema marker. Raw string concatenation is forbidden.
- Legacy creator maps to createdBy:system and is tagged migrationSource:legacy-v1.
- Session DTO accepts a discriminated PersistedObjectiveSnapshotV1 | PersistedObjectiveSnapshotV2. The store loader preserves the raw version instead of rejecting v1 before composition.
- Normalize v1 to v2 once at the host adapter before calling the authority; all new encoding is v2.
- Legacy explicit completed is discarded; criteria receipts are retained and completion is re-derived.
- A snapshot missing thread X clears X's previous progress during restore.

## RED rails

1. Duplicate create -> objective-exists; replace without current objective -> objective-missing.
2. Replace changes ID and clears every evidence family; revision increments once.
3. Clear produces null state, zero progress receipts, and monotonic revision.
4. Old-ID progress/manual/verifier/attempt receipt is rejected without revision change.
5. v1 decode yields the same deterministic ID across repeated restore; ambiguous concatenation pairs hash differently.
6. v1 explicit completed cannot manufacture completed in v2.
7. A real SavedSession v1 file loaded through loadSessionById reaches the adapter and migrates; v2 round-trip preserves ID, creator, definition, progress, and revision.
8. setExplicitStatus(completed) and removed mutation kinds fail normalization.
9. A direct consumer writer call fails the authority-boundary test.
10. Clear -> persist -> restart retains null tombstone revision and rejects a stale expectedRevision.
11. Model/user capability cannot submit beginAttempt, verifier batch, restore, or system mutation by constructing a raw command.
12. Goal length 4000 passes and 4001 fails identically at CLI/model/web/domain/migration boundaries.
13. Mutation-kind, dispatch, actor-policy, and snapshot-version parity tests fail on one injected missing entry.

## Verification

    bun test tests/unit/objective tests/unit/objective-*.test.ts tests/unit/session
    bun test tests/unit/objective-slice-boundary.test.ts tests/unit/_arch
    bun test tests/integration/objective-*.test.ts tests/integration/goal-continuation-live-e2e.test.ts
    bun run typecheck
    bun run lint:debt

## Stop conditions

- Snapshot normalization occurs inside the authority or two codecs become writable truth sources.
- Removing direct writers requires a fallback writer path.
- Migration cannot be proven deterministic with a v1 fixture.
- Any unrelated dirty owner would need to be overwritten.
