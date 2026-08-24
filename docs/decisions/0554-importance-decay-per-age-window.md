# ADR-0554 — Importance decay is bounded to once per age window, not once per session

Status: Accepted (2026-08-25)
Slice: `src/memory/eviction.ts` · `src/memory/types.ts` · `src/memory/adapters/{in-memory,sqlite}.ts` · `src/agent/memory.ts` (`sweepEviction`)
Feature: `memory-decay-per-age-window` (extends `memory-eviction-planner`)
Related: RFC §6.3 (long-term memory tiers) · C5 hellgate (`tests/unit/memory-hellgate.test.ts`)

## Context

The eviction planner decays "archived" survivors — entries older than `STALE_MAX_MS` (30d) — by halving their importance (`EVICTION_DECAY = 0.5`). Its gate was:

```ts
const shouldDecay = (e, now) =>
  bucketOf(now - e.createdAt) === "archived" && e.importance > DECAY_MIN_IMPORTANCE
```

That is a pure function of **age**. It says nothing about when the entry was *last* decayed. Meanwhile `sweepEviction` runs inside every `persistSession`, and the interactive host persists once per turn. So once an entry crossed the 30-day line it was halved on every subsequent turn.

Measured: an entry at importance 0.5 that is 31 days old, four sessions in one afternoon — 0.5 → 0.25 → 0.125 → 0.0625 → 0.03125 (it stops only at the 0.05 floor). The ranking importance term is `importance * 4`, so the entry's contribution fell from 2.0 to 0.125 points. That — not tier weighting — is what produced the measured "31-day semantic entry scores 9, 1-hour episodic entry scores 11" inversion. Decay was coupled to **session count** when the model behind it is **elapsed time**.

Three cheaper fixes were considered and rejected:

- **Exempt the `semantic` tier from decay.** Contradicts RFC §6.3 (both tiers decay; semantic is only capped more generously) and is pinned by `eviction.test.ts` and the C5 hellgate. It also changes cap eviction: hot-ancient semantic entries then outrank and evict 2-day-old ones (measured).
- **Key freshness on `updatedAt`.** Both adapters stamp `updatedAt = Date.now()` unconditionally in `update()`, and `reinforce()` calls `update()` on every recall. `updatedAt` therefore means "last touched for any reason": using it as the decay clock double-counts access — a recall would *shield* an entry from decay, and a merge would *force* one.
- **Raise `TIER_WEIGHT`.** An arbitrary threshold that papers over a rate bug.

## Decision

Decay each entry **at most once per age window**. The window is the existing archived boundary, `DECAY_WINDOW_MS = STALE_MAX_MS` (30d) — no new interval is introduced.

- `MemoryEntry` gains an optional, additive `lastDecayedAt?: number`. `normalizeEntry` carries it only when finite (a corrupt value degrades to "never decayed").
- `shouldDecay` becomes: archived **and** above the floor **and** (`lastDecayedAt` absent **or** `now - lastDecayedAt >= DECAY_WINDOW_MS`).
- The decay write in `sweepEviction` sets `lastDecayedAt: now` alongside the halved importance, using the same injected clock the planner used.
- SQLite persists it as `last_decayed_at INTEGER`, added to `NEW_COLUMNS` so a pre-0554 database is migrated on open via the existing `PRAGMA table_info` diff + `ALTER TABLE … ADD COLUMN` path. The in-memory adapter carries it through its normalize/clone path unchanged.

## Consequences

- **Legacy rows** (no `lastDecayedAt`) decay on their first sweep exactly as before, then join the window. The C5 boundary contracts — "exactly 30d ⇒ stale, not decayed", "30d + 1ms ⇒ decayed on first sweep" — are untouched and still green.
- **Tier symmetry is kept.** Neither tier is exempt; both are bounded identically (pinned by H4 in the new hellgate).
- **The window is independent of `updatedAt`.** An entry recalled just now but last decayed a window ago still decays; an entry with a 60-day-old `updatedAt` but decayed just now does not (pinned by H5, including a real `recallContext` reinforce between two same-clock sweeps).
- Decay rate is now a function of wall-clock age alone: an archived entry loses at most one halving per 30 days regardless of how many sessions run. The half-life of an untouched archived memory is therefore 30 days, which is the number the bucket thresholds already implied.
- The planner remains pure and `now`-injectable; the sweep remains best-effort per entry.
- Pinned by `tests/unit/memory/decay-frequency-hellgate.test.ts` (H1–H6). Red-on-injection verified for both halves of the fix: reverting `shouldDecay` to age-only fails 8/15; dropping the `lastDecayedAt` stamp from the sweep write fails 4/15.
