# ADR-0184: Conversation checkpoint store — swap self-rolled Map+LRU for `lru-cache`

- Status: Accepted (sibling adapter; the self-rolled Map impl stays on disk)
- Date: 2026-05-25
- Related: ADR-0124 (conversation-checkpoint, original self-impl), ADR-0166
  (subagent conversation replay — consumer of this store)
- SOTA reference: **`lru-cache@11`** (https://github.com/isaacs/node-lru-cache)
  — the canonical Node LRU. Battle-tested across npm itself, `make-fetch-happen`,
  `cacache`, and the rest of the npm CLI ecosystem. Ships replacement / LRU
  touch / `pop()` LRU / `peek()` (read without recency update) /
  `entries()` MRU→LRU iteration / optional TTL / optional `maxSize`
  byte-accounting as first-class primitives.

## Context

ADR-0124 stood up `ConversationCheckpointStore` as a hand-rolled
`Map<string, ConversationSnapshot>` (~150 LOC in
`src/agent/conversation-checkpoint.ts`). It implements:

- `set`-with-replacement → delete + set, to keep Map insertion order = LRU order
- `prune(keep)` → take `Array.from(store.keys()).slice(0, drop)` and delete each
- `list()` → `Array.from(store.values()).reverse()` (Map iterates oldest→newest)
- LRU eviction on cap → while-loop `store.delete(store.keys().next().value)`

The user principle is explicit: **"외부에 잘 만들어진 거 있으면 외부 거 써"**.
`lru-cache@11.5.0` is already installed and exposes every operation the
hand-rolled store fakes with Map gymnastics — by an isaacs-maintained
library used in production by npm itself.

Negative invariants we are NOT violating:

- Public surface (`ConversationCheckpointStore`, `ConversationSnapshot`,
  `ConversationCheckpointStoreOpts`, `ConversationCheckpointError`) stays
  byte-identical.
- The Map-based `defaultConversationCheckpointStore` STAYS on disk and stays
  exported — this is a SIBLING adapter, not a replacement. Consumers pick.
- No call-site change in the agent loop, ADR-0166 replay, or any consumer.

## Decision

A sibling adapter `src/agent/conversation-checkpoint-lru.ts` (~95 LOC) that
constructs an `LRUCache<string, ConversationSnapshot>({ max })` and projects
its operations into the existing `ConversationCheckpointStore` interface:

```
src/agent/
  conversation-checkpoint.ts        — UNCHANGED. Map-based self-impl.
                                       Owns the interface + the error class.
  conversation-checkpoint-lru.ts    — NEW. lru-cache-backed adapter.
                                       Re-imports types + error from the sibling.
  index.ts                          — adds `export { lruConversationCheckpointStore }`.
```

Semantic mapping (lru-cache → our contract):

| our op           | lru-cache call                          | note                                              |
|------------------|-----------------------------------------|---------------------------------------------------|
| `record` replace | `cache.set(id, snap)`                   | on existing key, set BOTH replaces AND touches MRU |
| `record` evict   | (automatic via `max`)                   | no manual loop                                    |
| `list`           | spread `cache.entries()` (MRU→LRU)      | newest-first comes for free; no `.reverse()`      |
| `restore`        | `cache.peek(id)`                        | `peek` deliberately does NOT update recency       |
| `prune`          | loop `cache.pop()` until `size <= keep` | `pop()` removes + returns the LRU in O(1)         |
| `clear`          | `cache.clear()`                         | identical                                         |

The **`peek` vs `get` choice** is load-bearing: the Map impl never reorders
on read (only `record` writes to the Map), and HELL-6 only asserts that
`record` touches LRU. If we used `get`, a `restore(t1)` between two
`record(t2)` calls would silently move `t1` to MRU, breaking parity with
the Map impl. `peek` preserves the "writes touch, reads don't" semantic.

Default-OFF: nothing in the loop instantiates either store. ADR-0124's
"opt-in by constructing the factory" stays in force; consumers now have
two factories to pick from. The hellgate proves observational equivalence
across all 23 ADR-0124 invariants.

## Hellgate parity (23 cases)

`tests/unit/conversation-checkpoint-lru-hellgate.test.ts` mirrors the
ADR-0124 hellgate verbatim, swapping only the factory call. Same 7
describe blocks / 23 cases:

| group                 | cases                                            |
|-----------------------|--------------------------------------------------|
| happy path            | LRU-1..4 — record/list/restore + null on miss    |
| replacement semantics | LRU-5..7 — dedup / LRU touch / takenAt update    |
| immutability          | LRU-8..10 — source mutation / array frozen / list identity |
| LRU eviction          | LRU-11..13 — at-cap evict / max=1 / max=0 clamp  |
| prune & clear         | LRU-14..18 — drop oldest / no-op / clamp / clear |
| input contract        | LRU-19..21 — empty msgs / non-array throws / empty id |
| clock injection       | LRU-22..23 — injected `now` / default `Date.now` |

Original 23-case battery
(`tests/unit/conversation-checkpoint-hellgate.test.ts`) MUST stay green —
the sibling Map impl is unchanged.

## Alternatives rejected

- **`quick-lru`.** Smaller, ESM-only, no `peek`. Without `peek`, every
  `restore` would silently move the entry to MRU and we'd break the
  Map-impl parity on read ordering. Filling that gap by reimplementing
  `peek` ourselves defeats the "use the external thing" point.
- **`tiny-lru`.** Smaller surface, but the maintainer base is one person
  and the production adoption is shallow vs. `lru-cache` (used by npm CLI
  itself). For a primitive sitting on the conversation-state critical
  path, "battle-tested" outweighs "tiny".
- **Keep the Map-only impl.** It works and is tested. But it costs us the
  optional TTL + size-accounting follow-ups for free, costs 150 LOC of
  surface area, and violates the user's explicit "외부 거 써" principle for
  a 1-to-1 fit. The Map impl stays as a zero-dep fallback (we don't
  *remove* it); we add the lru-cache adapter as the recommended factory.
- **Drop the Map impl in this ADR.** Premature. Soft-deprecate later once
  the lru-cache adapter has soaked through the consumer path and we've
  confirmed no edge case (e.g. `peek` vs `get` recency semantics in
  ADR-0166 replay) breaks. Removal requires another ADR.

## SOTA realignment

Per the 2026-05-23 four-way audit (`agent-loop-4way-comparison`),
Cursor/Codex/Claude Code do NOT expose a conversation-checkpoint primitive
as a typed agent-callable surface — they rely on session-level reload.
quanta still uniquely surfaces this store; only the in-memory BACKEND of
that primitive is being swapped. The unique-vs-competitor surface is
unaffected.

## Migration

- **No call-site change required.** Either factory satisfies
  `ConversationCheckpointStore`. ADR-0166 replay and any future `/rewind`
  command can swap `defaultConversationCheckpointStore()` for
  `lruConversationCheckpointStore()` as a one-line change.
- **No new devDep.** `lru-cache@11.5.0` is already installed in the lockfile.
- **Public type re-use.** The new file imports the interface + error class
  from the sibling so we don't fork the contract.

## Follow-up

- **TTL-based expiry.** lru-cache supports `ttl` + `ttlAutopurge`. Once
  ADR-0166 replay grows a "snapshots older than N hours are stale" rule,
  it's a single option flip on the constructor — no new code in our adapter.
- **`maxSize` byte-accounting.** lru-cache supports `maxSize` +
  `sizeCalculation` (return bytes per entry). When a representative
  corpus indicates count-based caps are too coarse for long-message
  snapshots, swap `max` for `maxSize` + `sizeCalculation: (snap) =>
  estimateBytes(snap.messages)`. Adapter signature unchanged.
- **Soft-deprecate the Map impl** after one release window with the
  lru-cache adapter as the documented default, sealed by another ADR.
- **Consider migrating `defaultConversationCheckpointStore` consumers**
  (currently none in-loop; future ADR-0166 hook and a `/rewind` command
  are the candidates) to the lru-cache factory once the TTL follow-up
  lands — the lru impl becomes strictly more capable at that point.
