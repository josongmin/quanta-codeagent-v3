# ADR-0356 — Multi-process lockfile for the disk-backed session registry

Status: Accepted
Date: 2026-05-27

## Context

ADR-0348 shipped the JSONL disk adapter for `SessionResourceRegistry`.
Per its own `#Concurrency` section the adapter assumes a single
writer: every `meta.json` is rewritten via temp+rename and every
`events.jsonl` / `prompt-cache.jsonl` append rides on
`fs.appendFile`. Two quanta processes pointing the same `storageDir`
at the same `sessionId` therefore race in two distinct ways:

1. `meta.json` temp+rename — writer A's `meta.json.tmp-<hex>` can be
   renamed by writer B between A's `writeFile` and A's `rename`. The
   resulting `meta.json` reflects the latest-rename winner only; A's
   `lastTouched` is lost.
2. `events.jsonl` interleave — POSIX `O_APPEND` is per-syscall
   atomic, but the disk-store does `appendFile(path, line + "\n")`
   which translates to one `write(2)` whose atomicity at sizes
   smaller than `PIPE_BUF` is documented but not portable. Empirically
   the lines can interleave on networked file systems even when
   under `PIPE_BUF`.

Codex's analogue (`logs_2.sqlite`) ducks the issue by leaning on
SQLite WAL; that backend is tracked separately (ADR-0357 candidate
slot). The remit of this ADR is the JSONL stack only.

Note: the R9 audit listed multi-process safety as ADR-0353. After
ADR-0355 was adopted as the cross-machine *negative* the open
implementation slot for "single-machine multi-process" rolled
forward to 0356.

## Decision

Add a per-session lockfile at `<storageDir>/<sanitized-id>/.lock`,
acquired LAZILY on first `getOrCreate(id)` and held for the lifetime
of that session in this process. The lock is created atomically via
`fs.open(lockPath, "wx")` — Node's `wx` flag is `O_CREAT | O_EXCL |
O_WRONLY`, the same primitive `src/stream/adapters/jsonl-retention.ts`
already uses for its tmpfile. Contention triggers a sleep-poll loop
bounded by a caller-tunable timeout; a lockfile whose mtime predates
a configurable stale threshold (default 30 s) is reclaimed
unconditionally (crashed-holder recovery).

A separate **process-local holder map** keyed by the absolute lock
path makes the lock re-entrant for same-process callers. Two adapter
instances in one PID share a refcounted handle; only the LAST
`release()` physically unlinks the file. This is correctness, not
optimization — without it ADR-0348's existing "second registry
instance reads first registry's writes" cohort (B / H / M hellgate)
would deadlock against itself.

On acquisition failure the disk-store falls back to **memory-only**:
the synchronous in-memory store + cache are still handed out; every
disk-mirror write is silently suppressed. This preserves the
NO-THROW invariant of ADR-0348 and keeps the running process usable
even when another process owns the lock.

### API

```typescript
export interface SessionLock {
  release(): Promise<void>  // NO-THROW, idempotent
}

export async function acquireSessionLock(
  storageDir: string,
  sessionId: string,
  opts?: {
    readonly timeoutMs?: number          // default 5000
    readonly retryIntervalMs?: number    // default 100
    readonly staleThresholdMs?: number   // default 30000
    readonly now?: () => number
  },
): Promise<SessionLock | null>
```

`SessionLock | null` is the closed surface — `null` means "fall back
to memory-only" and never throws.

`DiskRegistryConfig.lock?: AcquireSessionLockOpts` lets composition
roots tune the policy (e.g. `timeoutMs: 0` for non-blocking probes,
larger `staleThresholdMs` for slow filesystems). Absent means
defaults.

### Stale-threshold rationale (30 s)

The disk-store holds the lock from `getOrCreate` until `evict` /
`clear`. Within a single turn that's microseconds. Across many
turns the holder calls `now()` every couple seconds to write
`meta.json`, which bumps the lockfile's mtime via touch. The 30 s
threshold sits two orders of magnitude above the natural touch
cadence, so a healthy holder cannot trip its own stale check, while
a crashed process is reclaimed within one or two `getOrCreate`
calls (under typical systemd / launchd restart latency).

## In-house prior art (cited verbatim from the brief)

- `src/auth/lock-file-based.ts:19-21` — same exclusive-create
  pattern with stale-reap, but for OAuth refresh tokens. We took
  the structure (read existing → decide live vs stale → exclusive
  create) and replaced the JSON-payload TTL with mtime-based
  staleness (the disk-store does not need to know who holds the
  lock, only that it's stale).
- `src/stream/adapters/jsonl-retention.ts:174` — the docblock
  literally reads "atomic rewrite: write to `<file>.tmp` with
  O_EXCL, fsync, then rename" and uses `fs.open(tmpPath, "wx")`.
  Confirms the Node `wx` ≡ `O_EXCL` semantics we rely on.
- `src/lsp/adapters/file-write-atomic.ts` — temp+rename mirror that
  ADR-0348 already uses for `meta.json`. This ADR layers a flock on
  top of that pattern; together they're write-strategy + mutex.

## Non-goals

- **Cross-machine** (NFS lease semantics). Explicitly deferred by
  ADR-0355. The lockfile DOES survive on NFS but its atomicity
  contract is provider-dependent; quanta makes no guarantees.
- **Shared-read locks.** The disk-store's read path (background
  replay on first `getOrCreate`) is gated by the same write lock —
  multiple readers would need a reader-writer extension which is
  out of scope.
- **SQLite backend.** Tracked separately. SQLite WAL has its own
  cross-process semantics and is not subject to this ADR.

## Wiring

Internal to ADR-0348. The lock is engaged whenever
`createDiskSessionResourceRegistry` is used; no composition-root
changes required. ADR-0351 env-var swap (`QUANTA_SESSION_REGISTRY_
DISK_DIR`) automatically picks up the new safety.

## Test coverage

- `__tests__/file-lock.hellgate.test.ts` — 13 cases: empty-dir
  acquire / foreign fresh lock / stale reclaim / concurrent winners /
  re-acquire after release / `timeoutMs: 0` / mock-clock budget /
  double release idempotent / external unlink swallowed / fs error
  null / 0o600 perm / `now()` seam / constants sanity.
- `__tests__/disk-store-flock.hellgate.test.ts` — 6 cases: happy
  path / lock failure ⇒ memory-only / in-process re-entrancy /
  evict releases / clear releases / stale lock cleanup at
  disk-store level.
- ADR-0348's existing 39 disk-adapter hellgate cases (B / H / M
  cross-process resurrection) all pass against the new lock without
  modification, thanks to the same-process re-entry map.

Total slice tests: 39 (ADR-0348) + 19 (ADR-0356) = 58 / 132 expects /
0 fail.

## Tradeoffs

- The lock is held for the lifetime of a session in this process.
  Long-running quanta processes therefore prevent any other process
  from writing to the same session — that's the whole point. A
  process that wants to "pass the baton" must call
  `registry.evict(id)` first.
- Acquisition is async but `getOrCreate` stays sync (the public
  contract from ADR-0345). The lock promise is reused by every
  disk-mirror op, so callers that immediately `store.append`
  observe the same eventual disk write they did before — gated
  behind the lock instead of fire-and-forget.
- The same-process holder map is a `Map<string, Holder>` keyed by
  absolute lock path. Two registries that mint different
  `storageDir` paths for the same `sessionId` (an unusual config)
  remain unaware of each other. That's a deliberate non-goal:
  composition roots that share state share a `storageDir`.

## References

- ADR-0345 — in-memory `SessionResourceRegistry`.
- ADR-0347 — process-level singleton wire.
- ADR-0348 — JSONL disk adapter (this lockfile is the multi-process
  safety patch).
- ADR-0351 — env-var swap (`QUANTA_SESSION_REGISTRY_DISK_DIR`).
- ADR-0355 — cross-machine negative.
- `src/auth/lock-file-based.ts` — prior-art exclusive-create.
- `src/stream/adapters/jsonl-retention.ts` — prior-art `wx` flag.
