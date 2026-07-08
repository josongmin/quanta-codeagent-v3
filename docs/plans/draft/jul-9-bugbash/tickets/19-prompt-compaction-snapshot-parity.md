# ALBB-19 — Prompt / compaction / context snapshot parity

**Priority:** P2  
**Wave:** D  
**Depends on:** ALBB-08, ALBB-09  
**Owner:** `src/agent/prompt.ts`, `src/agent/loop/context-assembler.ts`, `src/agent/loop/compaction-wire.ts`, `src/host/runtime/agent-config-assembler.ts`

## Goal

Stop silent drift between what compaction / snapshots see vs what live turns
assemble. Two defects are genuinely actionable and one is user-visible; the rest
are cosmetic or dead. **Rescoped** (see verdict below) to the two that change
behavior: **#3 skill_activation never fires**, and **#1 cache-metrics are inert**
(dead observability we still pay to wire). The remaining items are documented as
won't-fix with evidence so they are not re-flagged by the next audit sweep.

## Ground-truth (verified 2026-07-09, line refs current)

### #3 — `activeSkills: []` hardcoded ⇒ `skill_activation` events NEVER fire  (REAL, user-visible)

The composition-root snapshot closure hardcodes an empty skill set:

```ts
// src/host/runtime/agent-config-assembler.ts:832-841
getSnapshot: () =>
  captureSnapshot({
    cwd: cfg.cwd,
    mode: typeof cfg.mode === "string" ? cfg.mode : "default",
    model: (cfg.llm as { model?: string }).model ?? "",
    repoRulesPaths: /* …live… */,
    activeSkills: [],          // ← frozen empty, every turn
  }),
```

Because `activeSkills` is *always* `[]`, the detector's skill pass can never see a
diff:

```ts
// src/agent/context-change/detector.ts:157  (Pass 6)
if (!sameStringArray(prev.activeSkills, current.activeSkills)) {   // always false: [] vs []
  const added = diffAdded(prev.activeSkills, current.activeSkills)  // always []
  for (const skillId of added) { events.push({ kind: "skill_activation", … }) }
}
```

So `skill_activation` `ContextEvent`s are structurally unreachable on the live
path — the injection channel (`inject.ts:89`) is dead for skills. Meanwhile the
LIVE per-turn skill set already exists one seam away:

```ts
// src/agent/loop/context-assembler.ts:344
const augmentedSkills = augmentActiveSkillsWithPlugin(activeSkills, pluginActivation)
// …:371 fed into the prompt, but NOT into the snapshot closure
...(augmentedSkills !== undefined ? { activeSkills: augmentedSkills } : {}),
```

**Wrinkle to respect:** the closure is a zero-arg thunk captured *once* at the
composition root (`agent-config-assembler.ts:832`), reading `cfg.*`; it is invoked
via `buildContextEventsProducer` (`codex-r2-wire-install/install.ts:96-121`).
`augmentedSkills` is computed *per turn* inside `context-assembler.ts:344` and is
**not** in the closure's scope. Also, the snapshot is consumed by
`resolveContextEventsForTurn(config)` at `context-assembler.ts:337`, which runs
**before** `augmentedSkills` is computed at `:344`. A correct fix must publish the
live skill ids to a cursor the closure reads, and order that publish before the
`:337` consume (or explicitly accept a one-turn lag and pin it in the test).

Note the skill-object → id shape mismatch: snapshot `activeSkills` is
`readonly string[]` (ids/names — `snapshot.ts:35`), but `augmentedSkills` are skill
*objects* (prompt.ts:841 maps `skill.name`). The bridge must project to
`skill.name`/id strings, not push objects.

### #1 — `systemPromptCache` + `withCacheMetrics` are INERT on the live path (REAL — ZERO metrics, dead wiring)

`AgentConfig.system` is a **non-optional** string:

```ts
// src/agent/types.ts:157
system: string
```

The live assembler always sets it, and always forwards the (metrics-wrapped)
cache:

```ts
// src/agent/loop/context-assembler.ts:357
system: config.system,
// …:376-380
...(config.systemPromptCache !== undefined ? { systemPromptCache: config.systemPromptCache } : {}),
...(config.systemPromptCacheKey !== undefined ? { systemPromptCacheKey: config.systemPromptCacheKey } : {}),
```

`buildTurnContext` resolves system with `??`, so the cache branch is dead whenever
`input.system` is defined — which is *always* on the live path:

```ts
// src/agent/prompt.ts:763-764
const basePrompt =
  input.system ?? resolveCachedSystemPrompt(input.systemPromptCache, input.systemPromptCacheKey)
// resolveCachedSystemPrompt (:862) → cache.getOrBuild(...) at :869 — NEVER reached live
```

The metrics decorator only emits *inside* the wrapped methods:

```ts
// src/observability/codex-r2-metrics/cache-metrics-decorator.ts:40-48
getOrBuild(key, factory): CachedPrompt {
  const before = inner.peek(key)
  const out = inner.getOrBuild(key, factory)
  safeEmit(() => { if (before === null) emit.counter(`${cache}.misses`, 1)
                   else emit.counter(`${cache}.hits`, 1) })
  return out
},
```

Since `getOrBuild`/`peek` are never invoked on the live turn path, **zero**
`codex_r2.cache.*` counters ever fire in a real session (the disk/sqlite
`getOrBuild` calls under `session-resource-registry/*` are the REPLAY path, a
different concern — they do not exercise the wrapped live cache). So the
composition root pays to build `wrappedCache` (`agent-config-assembler.ts:813-816`,
`+827`) purely for observability that is structurally dead. This is sharper than
the original ticket wording: not *false* cache-hits — **no** cache metrics at all.

## Verdict on the other three (won't-fix, evidence attached — do NOT re-flag)

- **#2 — summarizer system is "thin" (`staticSystemFor`).** REAL but cosmetic, and
  the original Acceptance premise is *wrong*. `staticSystemFor(config)`
  (`compaction-wire.ts:579`) builds a system block from `config.system` ONLY (no
  repoRules / sessionCtx / memory / skills) and feeds it — via
  `context-assembler.ts:316` → `maybeCompact` → `runProactiveTier2` — to the
  **summarizer LLM's own prompt** (`compaction-wire.ts:310`, `:537`). It does
  **not** touch the compaction *trigger*: the token estimate is messages-only
  (`runMicrocompactPrepass` → `estimateTokens(snapshot)`, `compaction-wire.ts:485`;
  `estimateTokens([...snapshot])` at `:120`). So "compaction token estimate uses
  same repo/session authority as live turn" was never a real gap. Impact is bounded
  to summary quality and only worth touching if a summary-quality regression is
  actually measured (measure-first). **Won't-fix unless measured.**

- **#4 — `validateSectionsCacheBudget` return discarded.** REAL but dormant. The
  call at `prompt.ts:797` ignores its result, but `ok:false` is unreachable by
  construction: `fourSectionPreset` emits ≤4 cached sections, so the 4-breakpoint
  budget can never be exceeded today (the comment at `:793-796` says exactly this).
  A dev-warning is a cheap future-proofing nicety, not a live defect. **Won't-fix
  (dormant); revisit only if the preset ever grows past 4 sections.**

- **#5 — `TurnContextConfig` Pick stale.** NON-BUG. `TurnContextConfig`
  (`types.ts:794`) has **zero** consumers — the only other reference is a comment at
  `types.ts:92`. It is a dead type; a "stale Pick" on an unused type changes
  nothing. **Won't-fix (dead code); delete opportunistically, not as a bug.**

## Required changes (rescoped to #3 + #1)

1. **#3 — thread the LIVE skill set into the snapshot closure (fail-closed).**
   Publish the per-turn `augmentedSkills` ids to a session-scoped cursor that the
   `getSnapshot` closure reads, mirroring the existing structural side-channel
   pattern already used for the metrics emitter
   (`agent-config-assembler.ts:822-823` sets `(cfg as {…}).metricsEmitter = …`).
   - Project `augmentedSkills` → `skill.name`/id `string[]` before publishing
     (shape mismatch above).
   - Publish **before** `resolveContextEventsForTurn(config)` at
     `context-assembler.ts:337`, or explicitly accept + pin a one-turn lag in the
     test. Prefer publish-before-consume so activation surfaces the same turn.
   - This mirrors how Claude Code / Codex surface tool- and skill-activation as
     first-class session events; it is the narrowest correct fix (no new type
     surface — structural side-channel, same as the emitter).

2. **#1 — cache/metrics HONESTY: pick ONE, measure first, no perf claim without a
   counter.**
   - **Option A (default — delete dead wiring):** remove the `wrappedCache`
     construction + forwarding (`agent-config-assembler.ts:813-816`, `:827`) so we
     stop paying to build observability that never emits. Lowest risk; removes a
     misleading "we have cache metrics" signal.
   - **Option B (engage the port):** make `config.system` optional/absent on the
     default path so `prompt.ts:764`'s `??` actually falls through to
     `resolveCachedSystemPrompt`. Only justified if a counter proves it matters —
     instrument `getOrBuild` invocations over a real session; if the count is 0
     after the change fails to engage, revert to Option A.
   - **Measure-first:** do NOT claim a cache/perf win without a counter showing
     non-zero `codex_r2.cache.hits`. Absent that evidence, Option A is the answer.

3. **Correct the ticket Acceptance (below):** the old line 1 ("compaction token
   estimate uses same authority") is false — the trigger is messages-only. Replaced.

## Acceptance

- **#3:** Driving two turns where turn N+1 activates a skill emits **exactly one**
  `skill_activation` `ContextEvent` carrying the newly-added skill id; turn N (no
  new skill) emits none. Reverting the closure to `activeSkills: []` makes this
  test RED (red-on-injection).
- **#1:** Either (A) the `wrappedCache` wiring is gone and no `codex_r2.cache.*`
  metric is registered on the default live path, OR (B) a session run shows a
  non-zero `codex_r2.cache.hits`/`.misses` counter (proving `getOrBuild` engaged).
  A bare "cache is wired" assertion is NOT acceptable — the counter is the witness.
- **#2 / #4 / #5:** marked won't-fix with the evidence above; no assertion required
  unless a summary-quality regression (#2) is measured, in which case add a
  summarizer-system parity assertion (NOT a token-estimate one).

## Proof rails

```sh
# existing behavioral hellgates that pin the affected surfaces
bun test src/agent/context-change/__tests__/detector.hellgate.test.ts
bun test tests/unit/codex-r2-metrics-cache-hellgate.test.ts
bun test tests/unit/agent/prompt-sections.test.ts tests/unit/agent/prompt-assembled-capture-hellgate.test.ts

# NEW hard-gate for this ticket (#3 + #1), red-on-injection:
#   tests/unit/agent/albb-19-compaction-system-parity.test.ts
#   - #3: two-turn drive; assert exactly ONE skill_activation ContextEvent
#         with the added skill id; MUTATION pin: revert the closure to
#         `activeSkills: []` ⇒ test must go RED.
#   - #1: assert Option A (no cache-metric registered on default path) OR
#         Option B (getOrBuild invoked ⇒ non-zero counter); MUTATION pin:
#         re-introducing the `input.system ?? …` short-circuit with a wired
#         cache ⇒ zero-metric assertion must go RED.
bun test tests/unit/agent/albb-19-compaction-system-parity.test.ts   # (new)
```

> The old proof-rail path `tests/unit/codex-r2/` does **not** exist; the real
> cache-metrics hellgate is `tests/unit/codex-r2-metrics-cache-hellgate.test.ts`
> and the real skill/detector hellgate is
> `src/agent/context-change/__tests__/detector.hellgate.test.ts`.
