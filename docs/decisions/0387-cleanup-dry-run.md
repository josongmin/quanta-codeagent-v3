# ADR-0387 — `/session-registry cleanup --dry-run` (preview without commit)

Status: Accepted — 2026-05-28
Supersedes: none
Extends: ADR-0379 (`/session-registry cleanup` immediate-sweep slash)

## Context

ADR-0379 shipped `/session-registry cleanup` which runs an immediate
sweep (TTL eviction + sliding-window byte-cap eviction + PASSIVE WAL
checkpoint, optional RESTART per ADR-0375) and renders post-sweep
stats. The sweep is COMMIT-only — there is no way for an operator to
see "what would I lose if I run this" before pressing the button.

Codex operators routinely run `sqlite3 logs_2.sqlite 'SELECT COUNT(*)
FROM sessions WHERE last_touched < ?'` on the production DB before
invoking the retention daemon to estimate impact. Our equivalent
should not require operators to know which sub-folder we keep the
SQLite file in.

## Decision

Add a `--dry-run` flag to `/session-registry cleanup` that:

1. Calls **new leaf count functions** that mirror the sweep algorithm
   but use SELECT/scan-only semantics — NO DELETE, NO `unlink`, NO
   `writeFile`.
2. Renders a `Dry-run:` block with per-backend (disk + sqlite)
   candidate counts split by axis (TTL + size).
3. Returns exit 0 without running the actual sweep — the operator
   re-invokes without `--dry-run` once they are satisfied.

### New leaf APIs

```typescript
// src/agent/session-resource-registry/disk-adapter/gc.ts
export async function countDiskRegistryCleanupCandidates(
  cfg: DiskRegistryConfig,
): Promise<DiskCleanupCandidates>

// src/agent/session-resource-registry/sqlite-adapter/gc.ts
export function countSqliteRegistryCleanupCandidates(
  cfg: SqliteRegistryConfig,
): SqliteCleanupCandidates
```

Both return `{ wouldEvictByTtl, wouldEvictBySize, inspectedSessions, ... }`.
The `sweep*` functions are NOT mutated — the dry-run path is a parallel
implementation, not a refactor of the sweep, so the byte-identical
contract for ADR-0379 holds.

### Algorithm — SQLite

The sweep uses:

```sql
DELETE FROM sessions
WHERE session_id IN (
  SELECT session_id FROM (
    SELECT session_id,
      SUM(total_estimated_bytes) OVER (
        ORDER BY last_touched DESC
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS cum
    FROM sessions
  ) WHERE cum > ?
)
```

The count inverts the outermost statement — same window, but
`SELECT COUNT(*) ... WHERE cum > ?` instead of `DELETE ... WHERE
session_id IN (...)`. The window itself excludes rows the TTL pass
would have already removed (`WHERE last_touched >= ?` before the
window) so the size-axis count is what sweep would do AFTER TTL
deletion — matching the actual eviction order (case [JJ] + [KK]
verify the counts equal `sweep*Registry`'s actual delete counts).

### Algorithm — disk

The sweep walks `readdir(storageDir)` → per-entry `stat` → `readMeta`
→ `truncateSession` or `removeSession`. The count walks the same
entries but classifies each as `ttl-candidate` / `size-candidate` /
`untouched` / `skip` and returns the counts — no `rm`, no
`writeFile`.

### Slash command

```
/session-registry cleanup --dry-run
```

The `cleanup` sub-command now parses its argv: any occurrence of
`--dry-run` flips to the preview handler. Other unrecognized flags
are gracefully ignored (case [26]).

Output shape:

```
## Session Registry — Dry-run

Dry-run: disk backend (/path/to/sessions)
  would evict by TTL:    3
  would evict by size:   1
  inspected sessions:    12

(no commit — re-run without --dry-run to apply)
```

When neither backend env var is set the output is:

```
## Session Registry — Dry-run

Dry-run: no on-disk backend configured (in-memory only — nothing to preview).
```

## Backward compatibility

`/session-registry cleanup` (no flag) is BYTE-IDENTICAL to ADR-0379.
Case [25] of the slash hellgate explicitly pins this — the existing
"Sweep complete." marker is rendered + the registry state mutates as
before.

## Wiring

The slash command file `src/apps/cli/session-registry-cmd.ts` is the
ONLY caller of the new count functions in this slice. No agent loop,
no composition root, no other surface depends on them. Future
operator surfaces (e.g. a `/session-registry stats --detail`) MAY
reuse the count functions but that is out of scope for this ADR.

## NO-THROW

Both count functions are wrapped:

- Disk: missing `storageDir` ⇒ `{ wouldEvictByTtl: 0, wouldEvictBySize: 0,
  inspectedSessions: 0, storageDir }`. Per-entry stat / readFile errors
  classify as `"skip"` (same as sweep's `processEntry`).
- SQLite: open-fail / corrupt DB ⇒ `EMPTY_CANDIDATES`. Each SQL step
  is wrapped — a single failed query degrades to 0 for that axis.

The slash itself adds a defence-in-depth try/catch around the top-level
call; failure ⇒ exit 1 + stderr message (operator explicitly requested
the preview).

## Idempotency

Two consecutive `countDiskRegistryCleanupCandidates` calls on the same
filesystem state return identical results. Two consecutive
`countSqliteRegistryCleanupCandidates` calls leave the DB row count
unchanged (case [MM] explicitly verifies the post-count session count
equals the pre-count value). Case [5] of the disk hellgate verifies
the same on the filesystem.

## Cost

- Disk: O(N) `readdir` + `stat` + `readFile` per entry — identical to
  one sweep pass, but no writes. For a ~500-session deployment this
  is ~50 ms wall clock.
- SQLite: 3 SELECTs — `COUNT(*) WHERE last_touched < ?`, the window
  COUNT, and the total `COUNT(*)`. Each is < 1 ms on a healthy DB.

## Non-goals

- **Per-session detail** — listing exactly which session IDs would be
  evicted. Operator workflow does not need this; the count is enough
  to answer "is the threshold tuned correctly". A future `cleanup
  --dry-run --verbose` could add this if anyone asks.
- **Truncation byte estimates** — for disk the count is per-session
  (would-be-truncated count), not "would shrink by X bytes". The
  truncation algorithm is line-aware so the exact retained byte count
  is sensitive to JSON line lengths; reporting it would require
  walking the full file twice.
- **Mode for `evict`** — `evict <id>` is per-id explicit; no dry-run
  needed.

## Test coverage

15 new cases:

- Disk gc hellgate `[1]..[5]` (5 cases) — empty dir / TTL candidates /
  size candidates / NO-THROW / idempotent fs.
- SQLite gc hellgate `[II]..[MM]` (5 cases) — empty DB / TTL count
  matches sweep / size count matches sweep / NO-THROW / idempotent
  DB.
- Slash hellgate `[22]..[26]` (5 cases) — flag triggers preview /
  marker absence / registry unchanged / no-flag preserves ADR-0379 /
  unknown flag ignored.

The TTL-count-matches-sweep + size-count-matches-sweep tests are the
crucial correctness signal — they prove the SELECT WHERE clause
inverts the DELETE WHERE clause correctly.
