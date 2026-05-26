# ADR-0327 — `buildTurnContext` wire seam for ADR-0321 / 0325 / 0326

Status: Accepted (seam landed default-OFF; producer wire follows in subsequent commits of this ADR)
Date: 2026-05-27

## Context

Three sibling slices (ADR-0321 context-change persistent injection,
ADR-0325 mention-based explicit injection, ADR-0326 system-prompt session
cache) landed as **default-OFF, slice-fence clean** ports with no
production caller. That makes them inert — the model never sees a
context-update envelope, never sees a mention injection, the
`buildSystemPrompt()` factory is re-invoked every turn.

This ADR adds the **single integration seam** in `buildTurnContext`
([src/agent/prompt.ts:397](src/agent/prompt.ts)) so the three slices can
be reached by upstream wiring (loop / session-setup) without the slices
themselves having to mutate `prompt.ts`.

## Decision

Add **three optional fields** to `TurnContextInput`:

| field | feeds | when absent |
|---|---|---|
| `systemPromptCache?` + `systemPromptCacheKey?` | ADR-0326 — `cache.getOrBuild(key, buildSystemPrompt)` | per-call build (legacy) |
| `contextChangeEvents?` | ADR-0321 — `buildPersistentInjectionMessages(events)` spliced AFTER baseMessages, BEFORE reminder | no splice |
| `mentionInjectionMessages?` | ADR-0325 — caller-built `Message[]` spliced in the same slot, AFTER context-change | no splice |

When ALL THREE are absent, `buildTurnContext` is **byte-identical** to
the pre-ADR-0327 implementation — pinned by hellgate
[tests/unit/prompt-adr-0327-wire-hellgate.test.ts](tests/unit/prompt-adr-0327-wire-hellgate.test.ts).

### Splice order

Final `messages` array shape (with everything wired):

```
[
  ...input.baseMessages,
  …optional hook-context user message (ADR-0133),
  …N persistent context-change envelopes (ADR-0321),
  …M mention-injection user messages (ADR-0325),
  …optional <system-reminder> tail (ADR-0004),
]
```

The chronological rationale:
- `baseMessages` is canonical history (prior turns).
- `hook-context` is hook-emitted pre-turn signal (handler output).
- `context-change` events are state transitions **observed between the
  previous turn end and this turn start** — they SHOULD precede
  mention-driven injections because they describe the world the
  mentions are addressing.
- `mention-injection` is user-driven invocation FOR this turn.
- `<system-reminder>` carries per-turn dynamic state (date, cwd, mode
  notice, …) and rides the tail to keep the cached system prefix
  byte-stable (ADR-0004).

### Cache bypass when caller provides `system`

When `input.system` is set, the cache is **NOT engaged** — the caller
already owns its own static prefix and presumably memoizes it. Engaging
the cache here would shadow that contract.

```ts
const basePrompt =
  input.system ?? resolveCachedSystemPrompt(input.systemPromptCache, input.systemPromptCacheKey)
```

`resolveCachedSystemPrompt` engages the cache only when BOTH
`systemPromptCache` and `systemPromptCacheKey` are present; either-or
absent ⇒ legacy `buildSystemPrompt()` per call.

### Producer wire (follow-up commits in this ADR)

The seam is inert until a producer fills the three new fields. The
producer wire lives in the agent loop and session setup — separate
commits of this ADR (loop hooks, session-level store + cache instance).
This ADR's seam commit ships the in-prompt half only.

## Non-goals

- **Compaction event emit**: covered by ADR-0324 producer wire (separate
  follow-up). The seam here does not assume any specific producer.
- **Resolver impl for mentions**: ADR-0325 ships parser + emitter +
  inject-message builder; resolver implementations (skill registry,
  plugin manifest, app catalog) are separate ADRs.
- **Cache invalidation policy**: ADR-0326 ships `clearAll` /
  `invalidate` on the port; the seam never invalidates — that's the
  session-lifecycle owner's job (follow-up commit).

## Files

- `src/agent/prompt.ts` (seam) — TurnContextInput +3 fields,
  `resolveCachedSystemPrompt` / `appendContextChangeMessages` /
  `appendMentionInjectionMessages` helpers at module scope.
- `tests/unit/prompt-adr-0327-wire-hellgate.test.ts` (NEW) — 11
  hellgate cases: byte-identical (3), cache wire (3), context-change
  wire (2), mention wire (2), combined order (2), system array
  invariance (1).

## Hellgate

- byte-identical when all three wires absent
- cache misses on first build, hits on second (factory called once)
- caller `system` bypasses cache (no engage)
- 1 event ⇒ 1 spliced message at exact slot (after baseMessages, before
  reminder)
- empty array ⇒ no splice (== absent)
- combined order: hook → context-change → mention → reminder
- system array byte-identical to legacy when ALL wires active (only
  messages array gains entries)

11 pass / 28 expects / 0 fail.

## Consequences

- Pro: three slices reachable by single upstream wire (TurnContextInput
  field) without each slice mutating prompt.ts.
- Pro: seam is observability-grade — caller passes data, helpers are
  pure, no in-seam I/O.
- Con: producer wire still required for end-to-end value; this ADR
  alone leaves the channels inert.

## Wiring follow-up (in this ADR)

- **Loop hook**: turn boundary — capture prev/current TurnStateSnapshot
  (`@/agent/context-change`), emit events into `TypedHistoryEventStore`,
  pass `events = store.since(lastTurnAt)` to `buildTurnContext`.
- **Loop hook**: user-input arrival — invoke mention parser
  (`@/agent/mention-injection`) on the latest user-role text content,
  resolve via the configured `MentionResolverPort`, pass built
  `Message[]` to `buildTurnContext`.
- **Session setup**: create `TypedHistoryEventStore` and
  `SystemPromptCachePort` once per session, plumb both through
  `AgentConfig` to the loop. Cache key = session id (the bench replay
  recorder is the natural drift-detector wrapping site, per ADR-0326).
- **Compaction emit**: at the compaction call sites, emit a
  `compaction_event` typed variant (ADR-0324) so the model can see the
  pass as a typed narrative event.
