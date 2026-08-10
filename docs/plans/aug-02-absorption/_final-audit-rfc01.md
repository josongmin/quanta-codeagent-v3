# FINAL code-grounded audit — RFC-01 persistence leftovers (2 items)

HEAD `c46c60f4e`. Read-only. Verdicts for the 2 items from `_backlog-audit-rfc01.md`.

## Concurrent-commit check (the "danger zone" commits)
- `6355cbb89` RFC-13 HOP-2 — only adds stable **message-id** assignment at `persistTurn`.
  `git show 6355cbb89 | grep expectedFileHashes` → **no hits**. Did NOT touch hashes or checkpoint schema.
  Touches: persist-turn.ts, runtime-config(+knobs), 2 tests. (verified)
- `159c57624` — wires the **capture feeder** (`buildRewindCaptureHook` → `feedCheckpointCapture`) into the live loop, default-OFF.
  This is the A2 feeder my landing referenced; it does NOT populate `expectedFileHashes` (passes none ⇒ `{}`).
- `615b9b586` (feeder-checkpoint-capture) — same feeder slice; no hash population.
→ No concurrent session has populated `expectedFileHashes` or rehydrated `revision`.

---

## Item 1 — A2 `expectedFileHashes` populated
**VERDICT: NOT-NECESSARY (defensive-only, dead schema slot). Leave `{}`.**

Current reality (still `{}`):
- Live feeder wire passes NO `expectedFileHashes`:
  `src/host/runtime/internal/context-binding/rewind-capture-wire.ts:51-56` (only sessionId/workspace/messages/latestAnchorSha).
- Feeder defaults to `{}`: `src/agent/rewind-capture-feeder.ts:145` (`input.expectedFileHashes ?? {}`).
- Capture primitive copies it verbatim: `src/agent/thread-rollback-checkpoint.ts:84`.

Why NOT necessary (adversarial necessity check):
- The restore leg NEVER reads `expectedFileHashes`. The sole tree-mutation owner
  `buildRollbackEffectPort` resolves purely by SHA:
  `src/apps/cli/repl/per-tool-checkpoint-wire.ts:114-116` — find registry entry whose
  `.sha === checkpoint.checkpointSha`, then `restoreFiles(entry.tag)`. No hash compare, no drift check.
- `grep -rn expectedFileHashes src` over non-test code = only the schema field
  (`src/session/rollback-record.ts:54`, `src/session/types.ts:223`) + the write path. **Zero consumers.**
- The type doc ("lets the effect fail closed when the tree drifted", types.ts:209/220) describes an
  UNIMPLEMENTED aspiration. The record's `checkpointSha` is already the content-addressed anchor; restore
  is SHA-pinned (records that WROTE the shadow head), so TOCTOU-over-restore is not the exposure the SHA
  path has. Populating the map would be inert until a hash-verifying restore leg is ALSO built.
- Correctness impact of leaving it `{}`: none. `{}` is documented as a valid non-lossy record
  (types.ts:221). No fail-open/fail-closed behavior hinges on it today.

Minimal delta IF ever wanted (not recommended now): would require BOTH (a) a hash source at the boundary
AND (b) a hash-compare gate inside `buildRollbackEffectPort` before `restoreFiles`. Populating the field
alone is pure dead weight. Defer until a restore-time drift guard is actually specced.

---

## Item 2 — A1 `revision` rehydrate
**VERDICT: NOT-NECESSARY (intentional by-design; refusing is correct). Do NOT rehydrate.**

Current reality (still true — revision resets to 0 on resume):
- On resume only `seq` is restored from the durable tip; `revision` passes through cold-start 0:
  `src/sdk/runtime/session.ts:73-74` — `initialState = durableTip>0 ? {...createdState, seq: durableTip} : createdState`.
  `createKernelSessionState` seeds `revision:0` (`src/kernel/session/state.ts:99`).
- Explicit design comment: `src/sdk/runtime/session.ts:59` — "`revision` deliberately does NOT resume here".
- Rehydrate module only injects the transcript (messages), never revision:
  `src/sdk/runtime/session/rehydrate.ts:10,130-136`.

Why NOT necessary (adversarial necessity check):
- `revision` is an **in-session optimistic-concurrency counter**, bumped per accepted command
  (`src/kernel/session/reducer.ts:28`) and checked only when a command carries an OPTIONAL
  `expectedRevision` (reducer.ts:72; bridge.ts:630-635). It is a compare-and-swap guard for
  **concurrent live writers on one connection** (web daemon), NOT a durable identity.
- `expectedRevision` is optional on every command (`src/protocol/session/commands.ts:7`); a client
  supplies it only for a CAS write it just observed. Nothing persists or replays a revision high-water
  mark across a resume boundary. Resume/replay is keyed on `seq`/`resumeFromEventId` only
  (`src/ipc/session/bridge.ts` planSessionReplay `resumeFromSeq/tip`; `src/mcp/...resumeFromEventId`).
- After a restart there are, by definition, no in-flight racing writers from the dead process, so
  starting `revision` at 0 is CORRECT. Rehydrating a stale revision would give clients a phantom
  high-water they never held and could spuriously reject the first legitimate command. Resetting is the
  safe posture, not a bug.

Minimal delta: none. This is a decision, not a gap.

---

## Bottom line
Neither item is genuine remaining work. Both are documented-intentional current states, not oversights,
and neither has a consumer that would make the "missing" value load-bearing. No concurrent commit
populated either. **Recommend: close both as WONTFIX/by-design; do NOT build.**
