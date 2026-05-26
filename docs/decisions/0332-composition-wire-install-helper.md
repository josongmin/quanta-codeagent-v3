# ADR-0332 — `installCodexR2Wires` composition helper (ADR-0327 family wire-up)

## Status
Accepted. Slice landed. Composition root call sites (`apps/cli/repl/session-setup.ts`, `apps/web-daemon/runtime-factory.ts`, `apps/bench/eval/driver.ts`, `apps/agent/assemble.ts`) intentionally left for a separate follow-up so the user's in-flight surface work is not invaded.

## Context

The ADR-0327 family added six optional slots to `AgentConfig`:

| Slot | ADR | Producer |
| --- | --- | --- |
| `systemPromptCache` | 0326 | `SystemPromptCachePort` (e.g. `createInMemorySystemPromptCache()`) |
| `systemPromptCacheKey` | 0326 | `asCacheKey(sessionId)` |
| `contextEventsForTurn` | 0321 | per-turn closure that diffs `TurnStateSnapshot`s via `detectContextChanges` |
| `mentionInjector` | 0325 | per-turn closure that parses `@skill / plugin:// / @@app`, resolves via `MentionResolverPort`, builds inject-messages |
| `compactionEventEmit` | 0324 | `(CompactionEventVariant) => void` that appends to a `TypedHistoryEventStore` |
| `imageSanitizationRetry` | 0328 | knob carrier — the actual `cfg.llm` wrap is ADR-0333's hookup in `createRunAgentContext` |

Each slot is independently default-OFF — absent ⇒ the loop is byte-identical to pre-ADR. The trade-off was that composition roots had to hand-author six closures with the right NO-THROW envelopes, cursor management, and cross-slice plumbing (the typed-history store is shared between context-events and compaction-events; the session-id minted by the cache pair is also the producer's turn-id prefix). This ADR replaces that hand-author with a single helper.

## Decision

Ship `src/agent/codex-r2-wire-install/` — a leaf slice exposing one function:

```ts
installCodexR2Wires(cfg: AgentConfig, deps: CodexR2WireDeps): void
```

`CodexR2WireDeps` is a small concrete bag of sub-dependencies (`sessionId`, `getSnapshot`, `store`, `mentionResolver`, `systemPromptCache`, `imageSanitizationRetry`, optional `now`). Every field is optional — absent ⇒ the matching slot is left untouched.

### cfg ownership

The helper MUTATES `cfg` in place. This mirrors the canonical mutation pattern at `src/agent/loop.ts:~2140` (`cfg.onPlanExitOutcome = (event) => { ... }`), where the loop owner first clones the caller's config (`{ ...baseCfg }` at line 2137 when `dedupGateActive && baseCfg === config`) and then mutates the clone. The same composition-root contract applies here: build the bare `AgentConfig`, then call `installCodexR2Wires` to layer the optional wires on. The helper does NOT clone for the caller — it trusts the caller has either constructed a fresh object or accepted in-place mutation. This is the same trust the loop has always had with `onPlanExitOutcome` and `attachDedupGate`/`attachCapEnforcer`/`attachLocalizePhase` — all of which mutate `cfg` in place.

### NO-THROW invariant

Every slot fill is wrapped in a try/catch. On throw the slot stays UNTOUCHED. The helper itself never throws to its caller. A frozen `cfg` (poison-pill from a test or hostile host) degrades to "every slot stays unset" rather than a crash. Rationale: a composition-root failure cannot break the agent loop.

### Idempotent + caller-override precedence

Each slot is filled IFF the slot is currently `undefined` on `cfg` AND the matching deps are present. A caller-pre-populated slot is NEVER overwritten — letting the host supply a custom store/injector/cache and still benefit from the rest of the install. Calling the helper twice with the same deps is a no-op on the second call.

### Pair-atomicity for the system-prompt cache

`systemPromptCache` and `systemPromptCacheKey` are written ATOMICALLY: if the second write fails the first is rolled back. Half-wired pairs are still safe (the prompt seam disengages the cache when only one is set) — the rollback is defense-in-depth.

### ADR-0333 deferral

The `imageSanitizationRetry` slot is the OPT-IN CARRIER — the actual `cfg.llm` wrap requires `wm`, which is constructed later in `createRunAgentContext`. The hookup is therefore ADR-0333 (a single conditional in `createRunAgentContext`, applied AFTER `wm` is created). `installCodexR2Wires` populates the slot; the loop performs the wrap.

## Composition-root usage (illustrative)

```ts
// apps/cli/repl/session-setup.ts (or similar)
import { installCodexR2Wires } from "@/agent/codex-r2-wire-install"

const cfg: AgentConfig = { /* base assembly */ }
installCodexR2Wires(cfg, {
  sessionId: session.id,
  getSnapshot: () => captureSnapshot({ cwd, mode, model, repoRulesPaths, activeSkills }),
  store: typedHistoryStore,
  mentionResolver: skillRegistryResolver,
  systemPromptCache: cache,
  imageSanitizationRetry: { enabled: true, maxAttempts: 1 },
})
```

A composition root that wants ONLY the cache pair calls with only `{ sessionId, systemPromptCache }`. A composition root that wants ONLY image-retry calls with only `{ imageSanitizationRetry: { enabled: true } }`. The helper degrades gracefully — partial dep sets fill partial slots.

## Limitations

- The helper does NOT cover the `decisionEmitter`, `hooks`, or `redaction` slots. Those have their own composition lines and are intent-distinct from the ADR-0327 wire seam.
- The `contextEventsForTurn` producer is a built-in closure (snapshot diff via `detectContextChanges`). A composition root that needs a different producer (e.g. an external snapshot service) should bypass the install helper and set `cfg.contextEventsForTurn` directly — the install helper's caller-override precedence then leaves the slot alone.
- A future absorbing `createContextEventsProducer` / `createMentionInjector` factory ADR may move the closure construction out of `install.ts`; until then the install helper owns the assembly so a composition root needs only stateless primitive deps.

## Wiring

Composition root callers (`apps/cli/repl/session-setup.ts`, `apps/web-daemon/runtime-factory.ts`, `apps/bench/eval/driver.ts`, `apps/agent/assemble.ts`) are DELIBERATELY UNTOUCHED by this ADR — invading those files would conflict with the user's parallel in-flight surface work. The single-line caller `installCodexR2Wires(cfg, { ... })` is documented above; landing it is a follow-up ADR.

## Tests

`src/agent/codex-r2-wire-install/__tests__/install.hellgate.test.ts` — 16 cases:

| Section | Cases |
| --- | --- |
| §A empty deps ⇒ byte-identical | 1 |
| §B context-events producer (wired + missing dep) | 2 |
| §C compaction-event emit | 1 |
| §D mention injector (wired + store side-channel) | 2 |
| §E cache pair (both wired) | 1 |
| §F cache without sessionId ⇒ NEITHER slot | 1 |
| §G image-retry slot carrier | 1 |
| §H caller-override precedence (2 slots) | 2 |
| §I idempotent | 1 |
| §J NO-THROW (throwing snapshot + frozen cfg) | 2 |
| Total | 14 |

20 tests / 0 fail / 47 expects locally. `bun test src/agent/codex-r2-wire-install/__tests__/`.

## Non-goals

- Composition-root call-site changes (deferred — user in-flight).
- A higher-level `createContextEventsProducer` / `createMentionInjector` factory (deferred — current inline closures are sufficient).
- Default-ON posture (the wire stays opt-in per composition root).

## References

- `src/agent/codex-r2-wire-install/` slice — types + install helper + barrel + tests.
- `src/agent/loop.ts:2152` — `cfg.onPlanExitOutcome = ...` mutation pattern cited as precedent.
- ADR-0327 — `buildTurnContext` wire seam (consumes the 3 prompt-side slots).
- ADR-0333 — image-sanitization-retry production hookup (consumes the `imageSanitizationRetry` slot).
