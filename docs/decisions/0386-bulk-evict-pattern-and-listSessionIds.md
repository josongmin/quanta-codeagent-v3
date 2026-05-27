# ADR-0386 — Bulk evict pattern + closed-port `listSessionIds` extension

Status: Accepted
Date: 2026-05-28

## Context

Two related operator gaps surfaced after ADR-0374 + ADR-0384 shipped:

1. **Bulk eviction.** The slash takes one id at a time. A common
   cleanup workflow is "drop every session whose id starts with
   `test-`" (after a test run leaves orphaned sessions in the disk or
   sqlite backend). Today the operator types N evict calls.
2. **Enumeration absence.** The closed `SessionResourceRegistry` port
   (ADR-0345) exposes `size()` but NOT `keys()`. A caller (test cleanup,
   bulk operator, future GC) cannot ask "which ids are tracked?". The
   inspector slash surfaces aggregate counts, not the id set.

Codex addresses both gaps via raw SQL — `SELECT session_id FROM
sessions WHERE session_id LIKE 'test-%'` + a follow-up
`DELETE WHERE …`. Our closed-port discipline + REPL surface need an
equivalent.

## Decision

Two parallel changes:

### Part 1 — closed-port read-only `listSessionIds()`

Extend `SessionResourceRegistry` (`src/agent/session-resource-registry/types.ts`)
with:

```typescript
/** ADR-0386 — read-only enumerate of currently tracked session ids.
 *  Returns a snapshot array; order is implementation-defined; NO-THROW
 *  (backend failure ⇒ []). */
listSessionIds(): readonly string[]
```

Semantics:

- **In-memory backend** (`in-memory-registry.ts`) —
  `Array.from(this.entries.keys())` after a TTL sweep.
- **Disk backend** (`disk-adapter/disk-store.ts`) — the in-process Map,
  NOT a filesystem walk. Same surface as `size()` on this adapter —
  cross-process visibility belongs to the inspector slash, not the
  closed port.
- **SQLite backend** (`sqlite-adapter/sqlite-store.ts`) — the in-process
  Map, NOT `SELECT session_id FROM sessions`. Same reasoning.

NO-THROW: any backend error ⇒ `[]`. Return is `readonly` to prevent
accidental in-place mutation; the array is a fresh allocation, not the
backing Map's internal storage.

### Part 2 — `/session-registry evict --pattern <glob>` slash

```
/session-registry evict --pattern "test-*"
```

Glob alphabet: `*` (zero-or-more any-char) + `?` (exactly-one any-char).
Every other regex metacharacter is **escaped** by the helper so a
pattern of `a.b` matches the literal id `a.b`, NOT `axb`.

Algorithm (`renderBulkEvict` in `src/apps/cli/session-registry-cmd.ts`):

1. Compile `pattern → regex` via `globToRegex` (escape + `*`→`.*` +
   `?`→`.` + `^…$` anchor).
2. Read `listSessionIds()` from the live registry.
3. Filter ids by `regex.test(id)`.
4. Safety:
   - 0 matches ⇒ `No sessions matched <pattern>` + exit 0
   - matches > `BULK_EVICT_MAX_MATCHES` (= 100) ⇒ refuse + exit 1
5. Loop `registry.evict(id)` for each match. NO-THROW: a hostile evict
   aborts the loop with the partial count + exit 1.

Output (success path):

```
evicted N sessions matching test-*
(irreversible)
```

The `(irreversible)` warning mirrors ADR-0384 — operator hygiene parity
across the single-id and bulk forms.

## Why a closed-port read-only addition (variant)

ADR-0335 established the precedent: closed ports may grow read-only
variants when the additive shape preserves the existing contract
byte-identical. `listSessionIds` is purely additive — no existing port
method changes. The 3 backends each pass the existing 14-case
`registry.hellgate.test.ts` after the addition; the new 6 cases (§O–§T)
pin the new contract.

The alternative — exposing a sibling inspector function
`enumerateRegistryIds(registry)` — would require backend-type dispatch
at the call site (the slash would need to know whether the registry is
sqlite / disk / in-memory to call the right enumerator). A port method
is the simplest possible surface.

## Why glob with `*` and `?` only (no `[abc]`, no `**`)

- **`*` + `?`** cover 95% of operator intent ("test-*", "sess-?",
  "*-cleanup"). The 5% that wants character classes can fall back to
  per-id evict.
- **No `**`** — sessions ids are flat (no path-like hierarchy), so
  `**` would not differ from `*`.
- **No regex metas** — escaping every non-glob char makes the pattern
  predictable AND eliminates an injection vector (an operator who
  types `--pattern ".+"` does not accidentally match every id).

The choice mirrors the gitignore + minimatch defaults; operators with
shell habit will type the glob they expect.

## Why max 100 matches

Operator-typing safety. A typo of `*` (instead of `test-*`) on a
machine with 10000 live sessions would otherwise wipe everything in
one keystroke. 100 is informed by typical operator working sets —
a single dev/test box rarely holds > 100 live session ids at once
(the SQLite backend's default 14-day retention × ~1 session/dev/day).

Operators who genuinely want to evict more than 100 can:

- Narrow the pattern.
- Loop `evict <id>` per session (the per-id form has no cap).
- Use `cleanup` (ADR-0379) which sweeps via the RETENTION POLICY, not
  a glob — distinct intent.

The threshold is a closed-port constant. A `--max <N>` override would
defeat the purpose (the typo case becomes harder to detect).

## Non-goals

- **Cross-process bulk evict.** `listSessionIds` reads in-process Map
  only. Operators who need to evict ids that some OTHER process
  registered must run the slash inside that process or use the
  cleanup-by-retention path.
- **Async / Promise return for `listSessionIds`.** Sync mirrors
  `size()` discipline; making one async would force all 3 backends
  into async + the metrics decorator into a promise return — out of
  scope for one read-only addition.
- **glob alphabet extension.** Adding `[abc]` / `{a,b}` / `**` would
  multiply edge cases. Operators who need that complexity should fall
  back to a future regex-mode (`--regex <pattern>`).
- **Per-id `--dry-run`.** The 0-match / over-cap branches surface
  intent (the operator can refine the glob and re-run); a dedicated
  dry-run mode is YAGNI.

## Implementation surface

```
src/agent/session-resource-registry/types.ts                          — port +1 method
src/agent/session-resource-registry/in-memory-registry.ts             — impl
src/agent/session-resource-registry/disk-adapter/disk-store.ts        — impl
src/agent/session-resource-registry/sqlite-adapter/sqlite-store.ts    — impl
src/observability/codex-r2-metrics/registry-metrics-decorator.ts      — decorator pass-through
src/apps/cli/session-registry-cmd.ts                                  — slash dispatch + renderBulkEvict + globToRegex
```

## Tests

11 new hellgate cases pin the port + slash:

- `registry.hellgate.test.ts` §O–§T (6 cases, in-memory backend)
- `disk-store.hellgate.test.ts` §O–§Q (3 cases, disk backend)
- `sqlite-store.hellgate.test.ts` [17]–[19] (3 cases, sqlite backend)
- `session-registry-slash.test.ts` [25]–[31] (7 cases, bulk evict
  slash + glob injection safety)

## Trade-offs

- `listSessionIds` allocates one fresh array per call. For a registry
  with 100k entries the allocation is ~800KB. Operators hit the slash
  rarely; the cost is bounded.
- Bulk evict caps at 100 — operators with bigger working sets fall
  back to retention sweep.

## Future work

- Promote `--pattern` to `--regex` for power users (closed alphabet
  expansion). Out of scope.
- Expose `lastEvictionInfo()` per ADR-0384 §Future work — bytes
  reclaimed per bulk run.
- Cross-process visibility via the inspector slash (already exists for
  aggregate counts, not for the id set).
