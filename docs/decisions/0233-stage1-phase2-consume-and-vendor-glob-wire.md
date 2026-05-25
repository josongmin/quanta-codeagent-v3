# ADR-0233: Stage1→Phase2 reuse-consume + vendor-detector ↔ glob-rules wire

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related ADRs**: ADR-0205 (multi-source rules vendor-detector slice),
  ADR-0216 (`Stage1StorePortV2` agent-side persist seam), ADR-0068
  (2-phase memory consolidator), ADR-0207 (`Stage1OutputsStore` LRU port)
- **References**: `src/agent/memory-consolidator-hook.ts` (Wire 1),
  `src/agent/glob-rules.ts` (Wire 2), `src/agent/types/memory-config.ts`
  (knobs for Wire 1), `src/agent/types/rules-config.ts` (knobs for Wire 2),
  `tests/unit/stage1-phase2-consume-wire-hellgate.test.ts` (15 cases),
  `tests/unit/vendor-detector-glob-rules-wire-hellgate.test.ts` (14 cases)

## Background

Two L3-mature slices were already shipped with their `deliberate_hold`s
pointing at the same kind of follow-up: a "wire the consumer" step that
the slice itself deliberately left out so the slice could land
independent of any caller's adoption schedule.

- **ADR-0205** (multi-source rules vendor-detector). Detects 6 vendors'
  rule files (cursor / cline / roo / aider / windsurf / quanta) and
  normalizes to a single `DetectedRule` shape. The catalog entry's
  `deliberate_hold.promotion_path` is verbatim: _"`@/agent/glob-rules.ts:
  loadGlobRules` calls `createDefaultVendorDetector().detectAll()`,
  adapts the result to GlobRule[], and composes with the legacy single-
  source loader."_

- **ADR-0216** (`Stage1StorePortV2` agent-side). 4-verb persist seam
  (`write / read / incrementUsageCount / selectForPhase2`) with two
  default adapters (`inMemoryStage1Store` + `sqliteStage1Store`). Phase 1
  upsert is wired via the consolidator's session-end hook. Phase 2's
  reuse-or-refresh logic — which is the WHOLE point of the per-row
  `usageCount + selectedForPhase2` columns — was deliberately deferred.

This ADR completes both wires.

## Wire 1 — Stage1→Phase2 reuse consume helper

### Surface

`consumeStage1ForPhase2(input): Promise<Stage1ConsumeOutcome>` lives in
`src/agent/memory-consolidator-hook.ts` alongside the existing session-
end hook + Phase 2 auto-trigger hook (the slice's natural home — every
consolidator orchestration helper sits here).

```ts
type Stage1ConsumeOutcome =
  | { kind: "reuse"; record: Stage1Record }
  | { kind: "refresh"; reason: Stage1ReuseRefreshReason }
```

The helper reads a per-thread `Stage1Record` from the V2 port and
decides reuse-vs-refresh against two policy knobs:

```ts
MemoryConsolidatorBlock.stage1ReuseThresholdSec?: number   // default 3600
MemoryConsolidatorBlock.maxUsageBeforeRefresh?: number     // default 5
```

Both knobs clamp to their defaults on invalid input (NaN / Infinity /
≤0) so a host that hands us nonsense does not silently treat every row
as expired.

### Algorithm (deterministic)

```
1. store === undefined        ⇒ refresh + "store_missing"
2. threadId.length === 0      ⇒ refresh + "thread_id_empty"
3. store.read(threadId)
   - throw                    ⇒ refresh + "store_error"
   - ok:false OR value:null   ⇒ refresh + "no_record"
4. now - generatedAt > thresholdSec * 1000
                              ⇒ refresh + "expired"
5. usageCount >= maxUsage     ⇒ refresh + "over_used"
6. store.incrementUsageCount(threadId)
   - throw                    ⇒ refresh + "store_error"
7. store.selectForPhase2([threadId])
   - throw                    ⇒ refresh + "store_error"
8. ⇒ reuse + record (with original usageCount; caller sees the
                     pre-mutation snapshot)
```

The verb order **increment THEN select** is load-bearing: if `select`
throws AFTER `increment` lands, the row's usageCount is still accurate
(we won't double-count when the caller retries) and the
`selectedForPhase2` flag is unchanged from its prior value.

### Default-OFF posture

When `store` is undefined the helper returns
`{ kind: "refresh", reason: "store_missing" }` and the caller falls
through to the existing flow — byte-identical to every host that has
not wired `stage1StoreV2`.

### Test pins (15 cases)

- 2 default-OFF (store missing / threadId empty).
- 2 happy reuse (verb order; post-state mutation visible).
- 3 refresh reasons (no_record / expired / over_used).
- 3 knob behaviours (defaults pinned + clamp on NaN/Infinity / 0).
- 4 no-throw (read throws / increment throws / select throws / read
  returns ok:false).
- 1 outcome-shape discrimination (no record on refresh, no reason on
  reuse).

## Wire 2 — vendor-detector ↔ glob-rules composer

### Surface

`loadGlobRulesWithVendors(cwd, opts?): Promise<GlobRule[]>` lives in
`src/agent/glob-rules.ts` as a NEW super-set of `loadGlobRules`. The
existing `loadGlobRules(cwd)` stays untouched — every legacy caller
(rule-indicator CLI, hosts already wired to `globRules`) sees byte-
identical output.

A separate pure composer `composeGlobRulesWithDetected(legacy, detected,
opts?)` is exposed so a host that has both lists already can compose
without re-running I/O.

### Knobs (on `AgentConfig.rules`, new `RulesConfigBlock`)

```ts
type RulesConfigBlock = {
  vendorDetectorEnabled?: boolean                  // default false
  detector?: VendorDetectorPort                    // default createDefaultVendorDetector()
  vendors?: ReadonlyArray<VendorId>                // default all 6
  priority?: ReadonlyArray<VendorId>               // default canonical order
}
```

`vendorDetectorEnabled` defaults to `false` even though the detector
slice is L3-stable: the wire must be opt-in so every legacy caller of
`loadGlobRules` is byte-identical.

### Composition rules

1. Legacy rules are bucketed as `quanta` for priority purposes (the
   legacy loader walks `.quanta/rules` first, so attributing legacy
   rules to quanta keeps existing precedence semantics).
2. Detector rules are filtered by the optional `vendors` whitelist.
3. Collision resolution: when the same absolute `sourcePath` appears in
   both lists, the lower priority-index wins. On a true tie the legacy
   rule keeps the slot (legacy is positionally earlier in the map).
4. Output is sorted: priority asc, then `sourcePath` asc.
5. `MAX_RULE_FILES = 256` cap is honoured across the composition (the
   per-turn `selectGlobRules` cost is O(N rules × K paths); the cap
   bounds N regardless of how many vendors ship rule files).

### Knob: `priority` override

A user can flip collision precedence by passing
`{ priority: ["windsurf", "quanta", ...] }`. The override defines
explicit precedence for the listed vendors; unmentioned vendors fall
back to their canonical priority but offset PAST the override's length,
so a partial list (`["cursor"]`) puts cursor first and preserves the
canonical relative order of the rest.

### Default-OFF posture

- `opts === undefined` ⇒ legacy output (no detector call).
- `opts.vendorDetectorEnabled !== true` ⇒ legacy output (no detector
  call).
- `detector.detectAll` throws ⇒ legacy output (no escape across the
  port boundary; matches the slice's no-throw contract).

### Test pins (14 cases)

- 2 default-OFF (opts absent / explicitly false; detector NOT invoked).
- 4 opt-in composition (basic compose; all 6 vendors flow; subset
  filter drops; default detector fallback).
- 4 collision resolution (legacy ties on quanta; foreign vendor losing
  to legacy; priority override flipping winner; deterministic ordering).
- 4 no-throw + edge (detector throws; detector returns 0 rules;
  whitespace-only body dropped; inert rule dropped).

## Anti-goals

- **No silent widening of `loadGlobRules(cwd)`**. The legacy function
  signature and behaviour are frozen — composition is a NEW surface.
- **No vendor-metadata round-trip into the rendered prompt block**. The
  detector's `metadata` field (Aider's `model:`, etc.) is detector-side
  diagnostics only; the renderer reads body + description + globs only.
- **No retry / reuse-counter sliding window on Wire 1**. Two knobs (age
  + usage) is enough; an LRU/recency policy would belong to ADR-0207's
  `Stage1OutputsStore.prune` surface, not to this helper.

## Negative invariants

1. Wire 1 NEVER returns `{ kind: "reuse" }` with a half-mutated row —
   if either mutate-verb throws, the outcome demotes to refresh.
2. Wire 2 NEVER lets a detector throw escape — the legacy result is
   ALWAYS the fallback (the session-start path cannot crash on a buggy
   detector).
3. Neither wire mutates the caller's `AgentConfig` — knobs are read by
   value.

## Status

Accepted, landed on main 2026-05-25. 29 hellgate tests pass; tsc clean
on the wired files; biome clean on the wired files (the 2 pre-existing
complexity warnings on `loadGlobRules` + `runMemoryConsolidatorHookInner`
are NOT touched by this slice).
