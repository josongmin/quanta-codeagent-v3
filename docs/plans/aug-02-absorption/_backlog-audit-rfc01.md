# RFC-01 Persistence/Resume — backlog audit vs CURRENT code

**Audit basis:** working tree @ `main` (HEAD includes `159c57624` "wire captureCheckpoint into the live loop" + follow-on message-id / rehydrate / restore-coordinator commits). Read-only.

**Headline:** the README/RFC status table is **STALE**. All three sub-items have shipped substantial, wired, gated implementations since the RFC was written. Verdicts move A1 `NOT READY`→**ALREADY-BUILT (partial)**, A2 `DESIGN FIRST`→**ALREADY-BUILT+wired (partial)**, A7 `READY/S`→**ALREADY-BUILT+wired**. What remains are narrow correctness/recovery gaps, not the headline gaps the RFC describes.

Owner-local RFC-01 tests: **48 pass / 0 fail** (`context-headroom-advisory`, `rewind-capture-feeder-hellgate`, `rewind-capture-turn-wire-hellgate`, `rewind-restore-coordinator-e2e`, `aug02-feeder-deferred-status`, `crash-resume-hellgate`).

---

## A1 — on-disk thread store / durable session state → **ALREADY-BUILT (partial)**

Round-1 verdict: ALREADY-BUILT. Round-2: held, with two concrete residual gaps.

**What's built + wired (per the confirmed-correction, INJECTION not event-fold):**
- Durable rollback/checkpoint records ride the existing `SavedSession` atomic snapshot — schema wired into the loader/saver: `src/session/store.ts:252-253` (zod fields), `:365-372` (read-preserve), `:446-462` (read-modify-write carry-forward). Types at `src/session/types.ts:194,203,211,230,256-270`. This is the RFC01-0 durable contract, LANDED — no new store/DB.
- **Cold-start transcript rehydrate is LIVE and has a production producer.** `rehydrateResumeTranscript` (`src/sdk/runtime/session/rehydrate.ts:130`) loads the lossless `SavedSession` via `loadSessionById`, validates fail-closed, and `runtime.ts` injects it: `src/sdk/runtime/runtime.ts:39-45` (`durableTip > 0 ? await rehydrateResumeTranscript(...)`), consumed at `src/sdk/runtime/session.ts:69-72` (seeds `createKernelSessionState({...messages})`). This directly closes the RFC's identified A1 delta ("seq resumes but transcript/revision do NOT rehydrate").
- **Fail-closed identity/tamper gate is real** (`validateResumeSnapshot`, `rehydrate.ts:90-119`): identity mismatch and non-Message transcript entries THROW `ResumeRehydrateRefusedError` before any session is assembled. Verified live: the crash-resume hellgate log shows the schema loader refusing a tampered `content:"string"` snapshot.
- **Gate/byte-identical:** rides `QUANTA_SESSION_EVENT_LOG_DIR` (`src/config/knob-inventory/extra.ts:776`). In-memory log ⇒ `tip()===0` ⇒ `rehydratedMessages===undefined` ⇒ empty-transcript cold start unchanged. NOT a new SQLite store (Non-goal #1 respected).

**Round-2 refutation attempts / residual gaps:**
1. **`revision` still does NOT rehydrate** — `session.ts:60` comment confirms it stays a fresh-per-process counter (deferred to the ticket-05 owner). The RFC flagged this exact open-question (#2); still open. Low impact (revision is a wire-continuity counter, not semantic state).
2. **Two-rail reconciliation is by-design-split, not unified** — the `@/session` `.jsonl` appender vs the `@/kernel/session` JSONL is resolved by making the `SavedSession` snapshot the SOLE transcript authority and the kernel log seq-only (rehydrate.ts header "TWO-RAIL INDEPENDENCE"). This is the RFC's A1-b "no-dual-write" decision, implemented. Not a gap; a resolved design choice.
3. **Rehydrate only covers `messages`, not tool-use/result pairing, approval state, or artifacts** as separate exact-roundtrip fixtures — the RFC01-4 admission RED ("each semantic component missing ⇒ resume refused") is only partially realized: the tamper gate validates message *shape*, not tool_use↔tool_result pairing or approval/artifact identity. This is the RFC's own "NOT READY until full-fidelity roundtrip RED" bar; it is *relaxed* in the shipped version (ships transcript-only rehydrate).

**Improvement / real minimal delta (ROI):**
- (MED ROI) Add `revision` rehydrate behind the same gate + a fixture — closes open-Q#2, gives true continuity. Needs ticket-05 owner sign-off (already flagged).
- (MED ROI) Strengthen `validateResumeSnapshot` to reject a transcript with an orphaned tool_result / unpaired tool_use (reuse the `toolUseIds`/`toolResultRefs` helpers already imported in `compaction-wire.ts`). Cheap, closes the "parses-but-semantically-corrupt" hole the header itself admits is only shape-checked. Low LOC, high safety ROI.

---

## A2 — ThreadRollback durable turn-checkpoint mapping + rollback coordinator → **ALREADY-BUILT+wired (partial)**

Round-1 verdict: ALREADY-BUILT (this is what `159c57624` + follow-ons delivered). Round-2: held; the file-restore vertical is a complete wired slice; the **crash-recovery half is a genuine dead seam.**

**What's built + wired (full intent→effect→receipt saga):**
- **Coordinator** `executeRollback` (`src/agent/thread-rollback.ts:148`): persist `requested` intent → `ThreeWayRestorePort` restore → terminal `rolled_back`/`rollback_failed` receipt. Correct ordering (intent-before-effect, receipt-after-effect), idempotent on `operationId`, fail-closed on missing checkpoint mapping. Record helpers (`src/session/rollback-record.ts`) are pure + append-only + fail-closed on unknown state/version.
- **Checkpoint mapping capture** `captureCheckpoint` / `resolveRollbackTarget` (`src/agent/thread-rollback-checkpoint.ts`) binds a live ShadowOdb SHA to `(turnId,messageId)`, resolves target ONLY from the durable mapping (no branch/path/ordinal heuristic).
- **Production feeder is WIRED** (this was the `159c57624` GAP): `feedCheckpointCapture` (`src/agent/rewind-capture-feeder.ts:123`) ← `buildRewindCaptureHook` (`src/host/runtime/internal/context-binding/rewind-capture-wire.ts:37`) ← fired in `persist-turn.ts:157-166` after the id-mode save, wired at `turn-runner.ts:165`. Gated `QUANTA_REWIND_CAPTURE`, best-effort/non-throwing.
- **The message-id gap the commit's SCOPE NOTE flagged is CLOSED.** The commit said "the live loop does not yet assign message ids … the feeder safely no-ops." Since then, `maybeAssignMessageIds` (`persist-turn.ts:94-134`) mints stable `m{k}` ids at the persist boundary, gated by `messageIds || rewindCapture` (`:133`) — so enabling capture now implies id-assignment and the feeder is no longer inert. Collision-safe (seeds past the used-id set).
- **Front-door LIVE:** `/rewind --restore-files` routes through `buildRewindRestoreCoordinator` (`src/apps/cli/repl/rewind-restore-coordinator-wire.ts`) → `executeRollback` + `buildRollbackEffectPort` (real ShadowOdb effect), gated `QUANTA_REWIND_GIT`. Every non-`rolled_back` outcome fail-closes to a refusal (no partial truncation).

**Round-2 refutation attempts / residual gaps (confirmed by the repo's own honesty test `tests/adversarial/aug02-feeder-deferred-status.test.ts`):**
1. **Crash-recovery is a DEAD SEAM.** `resumePendingRollback` (`thread-rollback.ts:246`) and `pendingOperationIds` (`rollback-record.ts:108`) have **NO production caller** — grep-proven (`aug02-feeder-deferred-status.test.ts:102-105`). So a crash *between* intent-persist and terminal-receipt leaves a durable `requested` op that nothing surfaces or offers to recover on restart. The saga writes the recovery breadcrumb but nothing reads it. This is the single most material A2 gap.
2. `rewind.ts` transcript owner still safe-degrades (`"file restore not yet wired"`) for the no-coordinator path — by-design (the coordinator is a separate CLI-dispatch wire), asserted at `aug02-feeder-deferred-status.test.ts:114-122`. Not a gap; the two paths are intentionally separate owners.
3. `expectedFileHashes` is captured as `{}` by the feeder (`rewind-capture-feeder.ts:145`) — the "expected current file hashes" TOCTOU guard the RFC/records support is present in the schema but the feeder never populates it, so the restore leg is SHA-pinned only, not hash-verified against a drifted tree.

**Improvement / real minimal delta (ROI):**
- (HIGH ROI, small) Wire the crash-recovery half: on session resume, scan `pendingOperationIds(saved.rollbackOperations)` and surface a `recovery_required` prompt / a `/rewind --recover <op>` verb that calls `resumePendingRollback`. Turns the durable recovery breadcrumb from dead-write into a live guarantee — the whole point of persisting intent-before-effect. One CLI verb + one resume-time scan.
- (MED ROI) Populate `expectedFileHashes` in the feeder from the same registry snapshot, and enforce it in the effect port before restore — closes the "tree drifted since capture" TOCTOU the records were designed for.

---

## A7 — context-headroom pre-overflow advisory → **ALREADY-BUILT+wired**

Round-1 verdict: ALREADY-BUILT. Round-2: held clean — this is the most complete of the three.

**What's built + wired:**
- **Pure edge-latch** `stepHeadroomLatch` (`src/agent/compaction/background.ts:104`): armed→emit-once-above-threshold→disarm; re-arms only after usage drops below the reset boundary; degenerate `limit<=0` never crosses. Correct hysteresis (re-arm evaluated first, `:117`).
- **Wired into the LIVE compaction loop** (not a dead seam): `emitContextHeadroomAdvisory` (`src/agent/loop/compaction-wire.ts:100`) is called from `maybeCompact` at `:688`, reusing the SAME `before` footprint + `bgLimitTokens` threshold the compaction path already resolved (no new estimator/knob, per the confirmed-correction).
- **Event fully threaded through the closed union:** `context_headroom_crossed` in `src/stream/types.ts:222,751-764`, projected in `item-lifecycle.ts:105`, `item-stream-projector.ts:143`, classified non-accounting in `jsonl-recorder.ts:23-27,232,521-525`, rendered in `stdout.ts:235-240,472-478`, and in the CLI timeline panel (`timeline-panel.ts:177`). This is the exhaustive-record cascade done correctly.
- **Gate/byte-identical:** strict-`"1"` `QUANTA_CONTEXT_HEADROOM_ADVISORY` (`runtime-config.ts:125`, knob `knobs-a.ts:27`). Unset ⇒ never emitted, latch never touched (`compaction-wire.ts:108` early return). Per-session latch map with leak-cleanup on session end (`forgetMicrocompactSession`, `:85-90`).
- Observability-only: the comment + wiring confirm it NEVER drives loop-stop or compaction — matches the RFC's "advisory not control authority" stop-rule.

**Round-2 refutation:** could not refute. The RFC's optional `rollout_budget` HARD-CAP half was explicitly DROPPED in the confirmed-correction ("새 rollout hard cap/stop reason은 DROP"), and correctly there's no hard-cap here. Nothing to fix.

**Improvement (ROI):** none material. (LOW ROI, optional) the threshold and reset boundary are the same value (`compaction-wire.ts:118-123`), so the advisory fires exactly at the compaction trigger — arguably it should fire *before* it (a fraction of the window) to be a genuine PRE-overflow warning rather than coincident-with-compaction. A `headroomFraction` knob (< the compaction threshold) would make it earlier-warning. Efficacy-unmeasured; measure-first.

---

## Round 2 vs Round 1 — what changed

Round 1 (existence/wiring) established all three as ALREADY-BUILT and wired — the big surprise vs the stale RFC. Round 2 (adversarial refutation) did **not** overturn any ALREADY-BUILT verdict but sharpened each with concrete residual gaps:
- **A2:** downgraded to "partial" — the repo's own honesty test proves the **crash-recovery half (`resumePendingRollback` / `pendingOperationIds`) is a dead seam** (durable recovery breadcrumb with no reader). This is the top actionable gap.
- **A1:** downgraded to "partial" — `revision` non-rehydrate (open) and transcript-only (no tool-pair/approval/artifact) roundtrip mean the RFC's own full-fidelity admission bar is *relaxed*, not met; tamper gate is shape-only.
- **A7:** confirmed clean; only refinement is earlier-warning threshold (measure-first).
No verdict was refuted to GAP; the shipped code is real, gated default-OFF, and non-vacuous (red-on-injection rails present in the hellgates).
