# T-505: Crash-resume workspace fingerprint + resume drift report (mark-time)

**RFC:** [05·W4](../05-rfc-git-state-and-resume-staleness.md) · **Priority:** P1 · **Size:** M · **Deps:** T-501 · **Posture:** rides `QUANTA_CRASH_RESUME` (default-OFF)

## Deliverable
1. Capture `{headSha, branch, dirtyPaths (bounded), opState}` **once per turn at `withCrashResumeMarker` mark-time** (`src/runner/orchestrate/crash-resume-wire.ts:60-76`); the composition root wires git access into the marker args — the `tool.invoked` flush seam stays git-free (R4-M4). Additive marker fields (`PersistedInterruptedTurn`, `src/session/types.ts:82-91`); old markers stay readable.
2. On resume, recompute and inject a deterministic drift section into the resume message (`src/session/crash-resume.ts:178-184`): "since interrupt: HEAD a1b2→c3d4, 4 files changed (list), branch switched". Non-git / probe failure → today's message (no-throw).

## Acceptance criteria
- [ ] Marker round-trip with and without new fields.
- [ ] Integration: crash → external commit → resume message carries drift lines.
- [ ] Non-git cwd → byte-identical legacy message.
- [ ] Exactly one probe per turn (cadence test).
- [ ] SOTA note: no competitor fingerprints drift on resume (exceed-class).
