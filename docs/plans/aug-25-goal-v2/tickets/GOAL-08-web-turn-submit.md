# GOAL-08 — Atomic turn.submit, admission port, and web goal controls

> **ARCHIVED TICKET** — 당시 실행 입력이다. 현재 GOAL-08 browser control 판정은 **DONE**이다.
> 아래 2026-08-30 결함 두 건은 후속 구현으로 닫혔다. 현재 상태는 [`../README.md`](../README.md)를 따른다.

> **구현 대조 (2026-08-30, 코드 확인)** — 원자적 `turn.submit`은 구현됐고, 주변 명세가 다르다.
> - `session.objective.work` 커맨드는 만들지 않았다. 웹 `/goal work`는 커넥션 레이어 out-of-band 프레임 `{kind:"goalWork", text, requestId?}`(`src/apps/web-daemon/goal-work-frame.ts`)로 host 동사 `turn.submitGoalWork`를 부른다 — 커널 리듀서에 닿지 않는다. 사유는 `receipts/GOAL-08.yaml` round5.
> - `GoalContinuationAdmissionPort`는 존재하지 않는다. 실물은 `createTurnSubmitAuthority`(issue/consume/revoke)와 커널의 `consumeTurnSubmitProvenance` + `claimGoalAttemptForTurn`으로 쪼개져 있다.
> - provenance는 `{kind, objectiveId, objectiveRevision, attemptId}` 4필드뿐 — 프롬프트 digest/ordinal/epoch 바인딩 없음. 커맨드는 `text`/`images`를 직접 싣고(`expectedSessionRevision`도 추가됨) 커널이 그 텍스트를 실행한다.
> - **2026-08-31 정정**: 승인 재개 goal attribution은 구현됐다. 이 티켓의 미귀속 판정은 superseded다.
> - **2026-08-31 정정**: browser `/goal` mutation·verification producer와 daemon E2E가 구현됐다.
>   always-on wake/checkpoint projection만 별도 R4로 남는다.

**Priority:** P1 · **Depends on:** GOAL-05A and GOAL-07 · **Owner:** session protocol/kernel plus web composition

**Receipt:** docs/plans/aug-25-goal-v2/receipts/GOAL-08.yaml

## Purpose

Submit a continuation atomically under the existing session command lease, prove it owns a host-issued wake reservation, and expose complete daemon/web goal control without mixing user and autonomous input.

## Protocol command

Additive turn.submit reuses the existing SessionCommandEnvelope expectedRevision field; no second session-revision field is introduced.

Autonomous payload contains only an opaque host claim reference plus the normal envelope. It does not accept client text or images.

The reservation stores immutable server-generated prompt bytes/digest and host provenance: objectiveId/revision, attemptId/ordinal, sessionEpoch, activityEpoch, and kind. validateAndConsume returns that bound prompt/provenance to the kernel. A general client-authored atomic submit, if later needed, is a separate command/authorization contract.

Register it in the command union, codec, builder, type list, and exhaustive reducer tests. Existing input.append and turn.run semantics remain unchanged.

Add a separate authenticated session.objective.work command for explicit user goal work. It carries user text/images plus session/objective expected revisions, binds actor/provenance at the host, persists GOAL-04 beginAttempt, and atomically appends/runs under the dispatch lease. It cannot carry autonomous provenance or a reservation.

## Admission port

Define a GoalContinuationAdmissionPort at the kernel/host boundary:

- reserve is owned by GOAL-06 controller.
- validateAndConsume checks current objective, revision, session/activity epoch, ordinal, unused reservation, and bound payload digest.
- release handles typed pre-run rejection/cancel.
- commit/settlement closes the accepted claim.

Kernel receives this port; it must not import the wake registry. When goal mode/admission is absent, goal-continuation submit is rejected even if the payload is syntactically valid. External clients cannot mint a valid reservation.

## Atomic handler

Under one dispatch lease:

1. Validate envelope expectedRevision.
2. Require idle turn, no approval, no pending attach/close, and empty draft.
3. Validate and consume admission, retrieving immutable host prompt/provenance.
4. Commit GOAL-04 beginAttempt persistence, then append the bound input and start the turn atomically. No paid body runs if start persistence fails.
5. On failure before run, leave transcript unchanged and release reservation.
6. Settlement/finally closes or releases the claim exactly once.

## Web/daemon composition

- Compose the shared GOAL-06 controller after sharedSession creation.
- Controller enqueues turn.submit, not split append/run.
- CLI/follower and goal features share one activeTurnRef.
- Attach success cancels/rearms through GOAL-07; daemon close awaits stop/disposal.
- Restored active goals reconcile evidence and auto-rearm after daemon restart.
- serve-stdio is explicitly outside scheduler scope until it gains a lifecycle owner; document/capability-test this exclusion.
- If a goal-attributed web turn ends awaiting approval, persist its objective/epoch provenance with the pending approval. Approval resolution revalidates current state and mints a fresh linked reservation/attempt, then uses turn.submit. It never emits a bare turn.run; stale/changed goals do not auto-resume.

## Web controls

Use the existing session.objective.mutate protocol for create/edit/pause/resume/clear, manual criterion complete/reopen, check/criterion changes, and budget amendment. Add typed host commands for verification and explicit goal.work; verification is not a domain mutation, and goal.work is the only user turn that mints user-requested-goal-work provenance.

The objective pane exposes the GOAL-05 data model, including validation, stale evidence, requested/effective budget, blocker, and next wake reason. Web is a daemon surface, not proof of IDE integration.

## RED rails

1. Concurrent user input and goal submit become separate turns or typed rejection, never one mixed input.
2. Approval/draft/active turn/attach rejects with transcript unchanged.
3. Existing expectedRevision mismatch rejects.
4. Wrong objective revision, epoch, ordinal, or reservation rejects before agent body.
5. Reused reservation rejects.
6. Valid reservation with substituted text/image or a client-authored image rejects; kernel runs only the bound host prompt.
7. Goal off/admission absent rejects forged continuation.
8. Pre-run rejection releases reservation; accepted begin/settlement closes it once.
9. Attach makes old-epoch queued submit stale.
10. Daemon close leaves zero timers/subscriptions/claims.
11. Restored eligible goal rearms once; paused/blocked/completed/contract-missing does not.
12. All web mutations hit the same user-fixed authority capability, 4000-char limit, and reread renderer.
13. Approval resume mints a fresh linked claim; bare turn.run, changed objective, or old epoch executes zero bodies.
14. A static structural test proves controller calls turn.submit and has an anti-vacuum/injected split-call failure.
15. session.objective.work mints user-requested provenance; plain input.append/turn.run cannot self-assert it.

## E2E

- WebSocket/API creates a goal through session objective command, scheduler runs one replay continuation, concurrent user message stays separate.
- Approval pending suppresses unrelated wake; approval resolution resumes through a fresh goal claim without losing accounting.
- Attach/restart rejects old epoch and rearms eligible current goal.
- Web criterion/check/budget/verify/pause/resume/clear controls round-trip.

## Verification

    bun test tests/unit/protocol tests/unit/kernel src/kernel/session/__tests__
    bun test tests/unit/apps/web-daemon/goal-wake-compose.test.ts tests/unit/apps/web-daemon
    bun test tests/integration/goal-web-submit-daemon-e2e.test.ts
    bun run test:contract
    bun run typecheck
    bun run lint:debt

## Stop conditions

- Kernel imports the concrete wake registry.
- A continuation can use split append/run.
- A client can self-issue valid provenance.
- Daemon teardown or attach leaves an owned timer/claim behind.
