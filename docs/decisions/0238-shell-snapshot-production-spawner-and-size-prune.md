# ADR-0238: Shell-snapshot — production Bun spawner, size-budget prune, CLI opt-in

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0204 (the slice primitive: closed port + adapters +
  file-store + headless stub), ADR-0235 (the runShell prefix wire +
  AgentConfig.shellSnapshot 5-knob block).
- **References**:
  `src/runtime/shell-snapshot/bun-spawner.ts` (new — production adapter),
  `src/runtime/shell-snapshot/file-store.ts` (`pruneToSizeBudget` added),
  `src/runtime/shell-snapshot/port.ts` (`pruneToSizeBudget` method on
  `ShellSnapshotPort`),
  `src/runtime/shell-snapshot/index.ts` (re-exports + factory wires both
  prune methods),
  `src/agent/shell-snapshot-session.ts` (two-phase prune at session start),
  `src/runner/assemble/config.ts` (`SessionDeps.shellSnapshot` + conditional
  spread),
  `src/apps/cli/internal.ts` (`buildShellSnapshotConfig`),
  `src/apps/cli/repl/session-setup.ts` (composition-root opt-in),
  `tests/unit/runtime/shell-snapshot-bun-spawner-hellgate.test.ts` (10 cases),
  `tests/unit/runtime/shell-snapshot-prune-by-size-hellgate.test.ts` (10 cases).

**ADR-number reconciliation.** Initially booked 0237 but a sibling track
(`0237-llm-error-16-kind-layer-owned-arms-wire.md`) had already taken that
number in a parallel agent's batch. Per the user-deference / parallel-track
renumber policy, our slice moved to the next-free **0238** (cross-refs in
src/tests/catalog/memory updated atomically).

## Context

ADR-0204 shipped the per-turn shell-snapshot primitive and ADR-0235 wired
it through `runShell` end-to-end, exposing a typed
`AgentConfig.shellSnapshot` 5-knob block:

```ts
shellSnapshot?: {
  readonly port: ShellSnapshotPort
  readonly shell?: "auto" | "zsh" | "bash"
  readonly captureAtTurnStart?: boolean
  readonly cleanupOlderThanMs?: number
  readonly maxSizeBytes?: number
  readonly shellEnv?: string
}
```

Three loose ends remained:

1. **No production `SnapshotSpawner`.** The slice only shipped
   `headless-stub.ts` for tests. Any caller wanting a real per-turn shell
   capture had to build a `Bun.spawn`-backed adapter themselves.
2. **`maxSizeBytes` knob exposed but unenforced.** The session helper only
   called `port.prune(cleanupOlderThanMs)` (age-based). A long-running
   session could accumulate fresh-but-large snapshots and overflow disk
   even with the byte cap configured.
3. **No CLI opt-in.** The composition root (`apps/cli`) had no env or
   flag path that produced an `AgentConfig.shellSnapshot` — users would
   have to manually instantiate it, which is impossible without a
   production spawner anyway (loop #1).

The catalog entry for ADR-0204+0235 was marked
`Configurable: integrated` but the three holes above made "integrated"
aspirational rather than literal.

## Decision

### 1. Production `Bun.spawn`-backed adapter

Add `src/runtime/shell-snapshot/bun-spawner.ts` exporting
`createBunSpawner(opts?)`. The factory returns a `SnapshotSpawner` that:

- Catches the synchronous `Bun.spawn` throw on ENOENT/EACCES and converts
  it into `{ code: null, spawnFailed: true, detail }` — upstream's
  `shell-missing` branch fires.
- Enforces a hard `timeoutMs` via `setTimeout(proc.kill, …)`. We do NOT
  use Bun's native `timeout` spawn option because it surfaces as a
  null exit code that races with our spawn-failure branch.
- Captures `proc.stdout` via `new Response(stream).text()` (same idiom
  as `os-sandbox/linux.ts` `defaultSpawner`), tolerating a "stream
  closed" throw after `kill()` by returning an empty body.
- Normalises a post-kill `null` exit code to `1` so the upstream's
  `code === null` branch (reserved for spawn-failure) is never
  mis-tripped on a normal timeout path.
- Discards stderr — matches Codex's behaviour
  (`~/.codex/shell_snapshots/*.sh` is stdout-only).

Default timeout: `DEFAULT_BUN_SPAWNER_TIMEOUT_MS = 10_000` (matches the
slice-default capture timeout). Override via `defaultTimeoutMs`.

### 2. `pruneToSizeBudget` — size-based eviction

Add `pruneToSizeBudget(maxBytes, home?)` to `file-store.ts`. Semantics:

- Missing directory → `0` (idempotent).
- `maxBytes <= 0` clamps to `0` (callers can intentionally empty).
- `sum <= budget` → no-op (`0` removed).
- Otherwise: stat every `.sh` file, sort ASC by mtime, unlink the oldest
  one at a time until the running sum is at or below the budget.
- **Never empty the directory** — the most recent file is always kept,
  even if it singly exceeds the budget. A lone oversized capture is an
  operator-visible failure, NOT a data-loss source.
- Per-file unlink failures are tolerated (best-effort, like `prune()`).
  The failed file's bytes still come off the running sum so the loop is
  bounded.
- Non-`.sh` files are never touched.

The closed `ShellSnapshotPort` interface gains the matching method, and
`createShellSnapshotPort` wires it through. The session helper at
`src/agent/shell-snapshot-session.ts` now calls BOTH prunes at session
start, age-first:

```ts
async pruneOnStart() {
  try { await port.prune(cleanupOlderThanMs) } catch (e) { emitError(...) }
  try { await port.pruneToSizeBudget(maxSizeBytes) } catch (e) { emitError(...) }
}
```

Failures of one phase do NOT abort the other — partial cleanup beats
none.

### 3. CLI composition-root opt-in

Add `buildShellSnapshotConfig()` in `src/apps/cli/internal.ts`. Reads the
env knobs:

```
QUANTA_SHELL_SNAPSHOT          1 → enable (also: `--shell-snapshot` flag)
QUANTA_SHELL_SNAPSHOT_SHELL    auto | zsh | bash   (default "auto")
QUANTA_SHELL_SNAPSHOT_TURN     "0" → one-shot at session start
                                (else per-turn capture)
QUANTA_SHELL_SNAPSHOT_CLEANUP  int ms age-based prune cutoff
                                (default 864e5*10 = 10 days)
QUANTA_SHELL_SNAPSHOT_MAX_MB   int MB size cap for the snapshot dir
                                (default 100MB)
QUANTA_SHELL_SNAPSHOT_TIMEOUT  int ms per-capture spawn timeout (default 10s)
```

Returns `AgentConfig["shellSnapshot"] | undefined`. The CLI's session
setup spreads it conditionally into `SessionDeps.shellSnapshot`, and
`assembleConfig` spreads it into the final `AgentConfig` — so unset env
keeps the assembled config byte-identical to the legacy path.

The `$SHELL` env literal is read ONCE here and forwarded as `shellEnv`
so the agent slice (`@/agent`) never reaches into `process.env`
(ADR-0144 slice purity).

## Consequences

**Positive**
- The 5-knob `AgentConfig.shellSnapshot` block is now literally
  configurable — every knob has a working end-to-end path from
  environment to spawned shell argv. The catalog "Configurable:
  integrated" badge is now true.
- A user with `QUANTA_SHELL_SNAPSHOT=1` set in `~/.zshrc` gets
  hermetic per-turn shells with their aliases / functions preserved
  across `fork`/`resume` without writing a line of TS.
- Disk-overflow risk closed: a 30-day session no longer accumulates
  unbounded `.sh` files under `~/.quanta/shell_snapshots/`.

**Negative / accepted trade-offs**
- Adding `pruneToSizeBudget` to the closed `ShellSnapshotPort` interface
  is technically a breaking type change. The only out-of-tree implementer
  (the integration test stub) was already updated in
  `tests/integration/shell-snapshot-runshell-wire-hellgate.test.ts` (a
  prior session pre-added the no-op `pruneToSizeBudget`), so this round
  closes the surface gap.
- `Bun.spawn` throwing synchronously on ENOENT requires a try/catch
  around what reads as an async API. The asymmetry is a Bun-specific
  quirk documented in the adapter; we accept the dual-error path
  (sync throw → catch, async exit-code null) to keep the typed
  `SnapshotSpawner` contract clean.
- The "never empty the directory" rule means a single 200MB snapshot
  bypasses a 100MB cap. The alternative (delete the only file) is
  worse: it loses the live snapshot the current turn needs. Operator
  observability covers the corner — the `pruneToSizeBudget` return
  count of `0` despite over-budget is the signal.

## Rejected alternatives

- **Use Bun's native `timeout` spawn option.** Faster to write but
  surfaces as `proc.exited === null` on timeout — collides with the
  spawn-failure null code path and forces an extra distinguishing flag.
  Explicit `setTimeout(kill)` keeps the typed shape stable.
- **Auto-detect `process.env.QUANTA_SHELL_SNAPSHOT` from the runner
  layer instead of the CLI.** Violates ADR-0144 slice purity (the
  `@/runner` and `@/agent` slices read no env). Composition root is the
  right ownership.
- **Default-ON shell snapshot.** Per RFC §1.2, every new mutation slot
  must be default-OFF byte-identical. A user who has `zsh` configured
  with a heavy rc-file would see a 200-300ms latency hit on every
  turn-start; opt-in is the safer landing.
