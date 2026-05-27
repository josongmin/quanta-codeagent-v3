# ADR-0334 — Composition-root call sites for `installCodexR2Wires`

## Status
Accepted. ADR-0332 install helper shipped without callers; ADR-0334 closes the gap by adding one-line install calls in the four composition roots flagged in ADR-0332 §Wiring. Default-OFF semantics are preserved at every site: an absent dep yields a byte-identical pre-install cfg.

## Context

ADR-0332 introduced `installCodexR2Wires(cfg, deps)` — a single-call mutator that fills the 6 ADR-0327-family wire slots on an `AgentConfig`:

| Slot | ADR | Filled when |
| --- | --- | --- |
| `systemPromptCache` + `systemPromptCacheKey` | 0326 | `deps.systemPromptCache` AND `deps.sessionId` present |
| `contextEventsForTurn` | 0321 | `deps.getSnapshot` AND `deps.store` present |
| `mentionInjector` | 0325 | `deps.mentionResolver` present |
| `compactionEventEmit` | 0324 | `deps.store` present |
| `imageSanitizationRetry` | 0328 | `deps.imageSanitizationRetry` present (the slot is the opt-in carrier; ADR-0333 wraps `cfg.llm` later) |

ADR-0332 deliberately left the four composition roots (`apps/agent/assemble.ts`, `apps/agent/run.ts`, `apps/agent/mode-presets/interactive.ts`, `apps/bench/eval/driver.ts`) UNTOUCHED — invading them would have collided with parallel in-flight surface work. With the install helper stable + the slice's 14 hellgate cases green, the wire-up is safe to land as its own atomic ADR.

Net result without ADR-0334: the helper is dead code (16 hellgate cases pass; 0 production callers). ADR-0334 makes the helper reachable.

## Decision

Call `installCodexR2Wires(cfg, deps)` from every composition root that constructs an `AgentConfig` destined for `runAgent`. Each surface picks its own deps policy — listed below.

### Per-surface deps matrix

| Surface | sessionId | systemPromptCache | store | getSnapshot | mentionResolver | imageSanitizationRetry | Rationale |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `apps/agent/assemble.ts` (primary) | ✓ (`cfg.sessionId`) | ✓ (in-memory) | ✓ (in-memory) | ✓ (closure over cfg) | — | — | Centralised wire site. Mints fresh in-memory adapters per assemble. Skips `mentionResolver` (host-specific; assemble cannot resolve `@skill / plugin:// / @@app` without a registry — left for follow-up) and `imageSanitizationRetry` (ADR-0333 owns the wrap, fed from cfg-side knobs). |
| `apps/agent/run.ts` (`runAgentLifecycle` + `runAgentLifecycleWith`) | ✓ (`cfg.sessionId`) | — | — | — | — | — | Empty-ish deps. The cfg arriving here was already (probably) wired by assemble. The call here is the caller-override-precedence belt-and-suspenders: if a host bypassed assemble and built the cfg by hand, run.ts ensures the install pass is still attempted. Idempotent — slots already set are left alone. |
| `apps/agent/mode-presets/interactive.ts` | ✓ | — | — | — | — | — | Same belt-and-suspenders posture: `assembleAgentConfig` (called by this preset) already wired the slots when sessionId+adapters were available. The redundant call documents the surface's "ADR-0332 family is active here" intent. |
| `apps/bench/eval/driver.ts` (`createBenchSessionHost`) | — | — | — | — | — | — | Empty deps ⇒ cfg untouched. Bench replay determinism is paramount — wiring an in-memory adapter PER instance could perturb tokenisation (system-prompt cache reuses the same prompt-string ⇒ identical token counts) but the conservative posture is to opt OUT until a dedicated bench audit clears it. The call site is recorded so a future bench wire change is a single edit, not a code archaeology task. |

### Idempotent + caller-override precedence (revisited)

ADR-0332 §Idempotent + caller-override precedence guarantees that every install call:

1. NEVER overwrites a slot that is ALREADY set. A host that pre-populated `cfg.mentionInjector` keeps its injector even when assemble.ts later runs an install pass.
2. Calling install twice with the same deps is a no-op on the second pass. assemble→run→interactive's cascading install calls collapse into a single effective install per cfg.

ADR-0334 relies on this contract; it does NOT re-prove it (covered by ADR-0332 §H and §I hellgate cases).

### Bench-replay determinism analysis

The bench wiring intentionally passes empty deps. The risk surface if we were to enable the cache pair:

- `systemPromptCache` is a token-budget optimisation. The prompt seam disengages the cache when only one of the pair is set, and when wired it returns IDENTICAL bytes for IDENTICAL inputs (in-memory map; no I/O). Bench instances do not share a session id (`bench-${crypto.randomUUID()}` per call), so the cache key never matches across instances. WITHIN an instance the cache hit/miss pattern affects token accounting but NOT the prompt bytes the model sees.
- The bigger concern is OBSERVABLE bytes. If a future wire emits `prompt_cache_read` / `prompt_cache_create` events onto the stream (the slice does not today; the cache is silent), bench JSONL would gain non-deterministic timing noise.

Conclusion: empty deps is the only safe default for bench. A future bench audit MAY opt in once a deterministic-fixture path is verified.

## Wiring (call-site shapes)

```ts
// apps/agent/assemble.ts — assembleAgentConfig (return-value path)
const cfg: AgentConfig = { ...req.base, modePolicy: policy, budgetMeter: meter }
installCodexR2Wires(cfg, {
  sessionId: cfg.sessionId,
  systemPromptCache: createInMemorySystemPromptCache(),
  store: createInMemoryTypedHistoryEventStore(),
  getSnapshot: () =>
    captureSnapshot({
      cwd: cfg.cwd,
      mode: typeof cfg.mode === "string" ? cfg.mode : "default",
      model: (cfg.llm as { model?: string }).model ?? "",
      repoRulesPaths: cfg.repoRules?.paths ?? [],
      activeSkills: [],
    }),
})
return cfg
```

```ts
// apps/agent/run.ts — runAgentLifecycle / runAgentLifecycleWith (pre-run insertion)
installCodexR2Wires(cfg, { sessionId: cfg.sessionId })
const outcome = await run(cfg)
```

```ts
// apps/agent/mode-presets/interactive.ts — runMode (after assembleAgentConfig)
const cfg = assembleAgentConfig({ ...req, base: stubBase(req) })
installCodexR2Wires(cfg, { sessionId: cfg.sessionId })
```

```ts
// apps/bench/eval/driver.ts — createBenchSessionHost (empty deps)
installCodexR2Wires(config, {})
```

## Non-goals

- A shared store/cache lifecycle across sessions. Each composition root mints its own in-memory adapter — sessions are independent. A future ADR may introduce a registry that hands out per-process or per-host stores, but ADR-0334 stays out of that scope.
- Wiring the `mentionResolver`. The skill registry resolver needs the registered skill set, which is built later in the runtime assembly (ADR-0325 family). Wiring this requires a dedicated follow-up ADR.
- Wiring `imageSanitizationRetry`. ADR-0333 owns the production hookup (wrap of `cfg.llm` at `createRunAgentContext` time). ADR-0334 does NOT pre-populate the slot.
- Mutating the bench replay path. Bench stays empty-deps until a dedicated bench audit clears determinism.

## Wiring backward-compat

Every install call is idempotent + caller-override safe. Hosts that pre-populated any of the six slots (e.g. tests that build a custom AgentConfig + set `cfg.mentionInjector` directly) are NEVER overwritten. Composition roots that chain through `assemble → interactive → run` collapse to a single effective install pass (the second + third invocations no-op).

## Tests

`tests/unit/composition-roots-codex-r2-wire-hellgate.test.ts` — 4 surface-specific integration cases plus the negative invariants:

| Section | Cases |
| --- | --- |
| §A assemble.ts wires slots when adapters present | 2 |
| §B run.ts is idempotent (assemble already filled) | 1 |
| §C interactive.ts cfg has the slots set | 1 |
| §D bench/eval/driver.ts is byte-identical (empty deps) | 1 |
| §E caller-override precedence across surfaces | 1 |
| §F NO-THROW under hostile cfg | 1 |
| Total | 7 |

(Plus ADR-0332's 16 cases continue to guard the helper itself.)

## References

- ADR-0332 — `installCodexR2Wires` composition helper.
- ADR-0327 — `buildTurnContext` wire seam (consumes the 3 prompt-side slots).
- ADR-0333 — image-sanitization-retry production hookup (owns the `cfg.llm` wrap).
- `src/agent/codex-r2-wire-install/` — slice (helper + types).
- `src/apps/agent/assemble.ts` — primary call site.
- `src/apps/agent/run.ts` — belt-and-suspenders call sites.
- `src/apps/agent/mode-presets/interactive.ts` — preset call site.
- `src/apps/bench/eval/driver.ts` — empty-deps call site.
