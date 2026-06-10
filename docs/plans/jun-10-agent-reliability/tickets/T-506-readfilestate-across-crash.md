# T-506: ReadFileState persistence across crash (capability-plumbed, bounded)

**RFC:** [05·W5](../05-rfc-git-state-and-resume-staleness.md) · **Priority:** P1 · **Size:** L · **Deps:** T-505 (headSha fence) · **Posture:** rides `QUANTA_CRASH_RESUME`

## Deliverable
1. **Plumbing (R4-M3):** `ReadFileState` lives behind the RuntimeSession boundary (`src/host/runtime/agent-config-assembler.ts:580`); the flush caller (`src/runner/orchestrate/session-turn-driver.ts:153`) can't reach it. The composition root that owns both threads a `snapshotReadBaselines(): ReadonlyArray<{path, mtimeMs}>` capability into the marker flush args.
2. Persist bounded baselines (own bound, e.g. most-recent-N — the 8192 `DEFAULT_RANGE_DEDUP_CAP` is the **range-dedup** map, orthogonal; do not reuse).
3. On resume: rehydrate; **invalidate stale-on-arrival** entries (current mtime moved → first write denies, forcing re-read); **whole-map invalidation on T-505 headSha mismatch** (branch switch ⇒ all baselines suspect — fail toward re-reads). Sessions without the capability (thin-client/remote) degrade to today.

## Acceptance criteria
- [ ] Hellgate: read → crash → external modify → resume → edit attempt **denies stale**.
- [ ] Unmodified file → edit proceeds.
- [ ] headSha mismatch → all baselines invalidated.
- [ ] Bound respected at cap; no-capability degrade test.
