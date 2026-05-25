# ADR-0235: Per-turn shell-snapshot — runShell prefix wire (composition root)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0204 (the slice primitive — port + adapters + file-store +
  headless stub), ADR-0006 (env scrubbing — preserved across this wire),
  ADR-0081 (typed shell events — sibling seam threaded through the SAME
  ToolContext path).
- **References**:
  `src/agent/shell-snapshot-session.ts` (new helper),
  `src/agent/loop.ts` (turn-start capture + prune-on-start),
  `src/agent/dispatch.ts` (ctx.shellSnapshot population),
  `src/tool/types.ts` (`ShellSnapshotRestoreSeam` mirror + `ToolContext.shellSnapshot`),
  `src/tool/index.ts` (barrel export),
  `src/tool/bash/index.ts` (forward to `runShell`),
  `src/agent/types.ts` (`AgentConfig.shellSnapshot` config block + internal
  `shellSnapshotSession` slot),
  `tests/integration/shell-snapshot-runshell-wire-hellgate.test.ts` (19 invariants).

**ADR-number reconciliation.** Concurrent slices on the same date already
booked 0230 (`realtime-websocket-codex`), 0231 (`radar-cards-proposal-queue`),
0232 (spinner-stall LLM hook, in-flight on `src/llm/`), 0233 (mega-wire,
in-flight on `src/agent/types.ts`), 0234 (git-directive emit wire). This
slice took the next-free **0235**.

## Context

ADR-0204 shipped the per-turn shell snapshot primitive as a slice-only
landing: closed `ShellSnapshotPort` (`capture`/`restore`/`prune`), two
shell adapters (zsh / bash), file-store under `~/.quanta/shell_snapshots/`
(0700/0600), headless test stub, AND an opt-in `ShellOptions.shellSnapshot`
on `runShell` — but **no caller actually wired anything**. A `grep -rn
"shellSnapshot" src/` outside the slice directory and the runtime types
returned 0 hits in production paths. Bash invocations spawned through
`runShell` therefore lost user-defined aliases / functions / exported
parameters across forks/resumes, which was the asymmetry ADR-0204
explicitly identified vs. Codex.

The composition-root question ADR-0204 left open:

1. **Where does capture happen?** Per `runShell` is wrong (every call
   re-spawns `bash -i -c …`, killing the latency win). Once at session
   start risks staleness across long sessions. Codex's solution is
   **per-turn capture + reuse for every shell call in that turn**.
2. **How does the handle reach the bash tool?** Direct `runShell` keyword
   threading bypasses the agent loop's lifecycle (no per-turn reset, no
   knob surface, no metric hook). Routing through `AgentConfig` +
   `ToolContext` (the same seam every other agent-side capability uses
   — `onShellEvent`, `gitWriteGuard`, `planMutator`) is the consistent
   path.
3. **What if capture fails?** Network shells / write-failed disks / hung
   rc files must NOT crash the turn. The wire is no-throw: failure emits
   one `error` AgentEvent and the next dispatch falls back to the
   byte-identical legacy spawn.

## Decision

Add a **single-file helper** at `src/agent/shell-snapshot-session.ts` that
owns the per-session lifecycle, plus minimal seam additions:

### Helper (`src/agent/shell-snapshot-session.ts`)

```ts
buildShellSnapshotSession(cfg, emitError) → ShellSnapshotSession | undefined
```

Returns `undefined` when `cfg.shellSnapshot` is absent (default-OFF
zero-allocation byte-identical for every legacy caller). Otherwise returns
an object with three methods:

- `snapshotForTurn(turn)` — called by the loop at turn-start. Captures via
  `port.capture({shell, id:turn-${turn}})`. On failure, emits one `error`
  AgentEvent and leaves the current handle intact. Defense-in-depth:
  wrapped in try/catch in case a hostile adapter throws.
- `currentSeam()` — read by dispatch when populating `ToolContext`.
  Returns the `ShellSnapshotRestoreSeam` (`{handle, restore}`) when a
  valid handle exists, else `undefined` so dispatch omits the field
  under `exactOptionalPropertyTypes`.
- `pruneOnStart()` — called by the loop at session start. Drops
  snapshots older than `cleanupOlderThanMs`. Best-effort.

### Knobs (`AgentConfig.shellSnapshot`)

```ts
shellSnapshot?: {
  readonly port: ShellSnapshotPort                   // REQUIRED
  readonly shell?: "auto" | "zsh" | "bash"           // default: "auto" → $SHELL
  readonly captureAtTurnStart?: boolean              // default: true
  readonly cleanupOlderThanMs?: number               // default: 864e5 * 10 (10 days)
  readonly maxSizeBytes?: number                     // default: 100 * 1024 * 1024 (100MB)
}
```

`captureAtTurnStart:false` reverts to one-shot session-start capture (the
operator-explicit opt-in to less work + stale-env risk). `maxSizeBytes`
is currently a typed-config surface for the prune-by-size follow-up;
prune-by-age fires at session start unconditionally.

### Loop wire (`src/agent/loop.ts`, 3 small blocks)

1. **Construction** (after `buildTurnDiffSession`):
   ```ts
   const shellSnapshotSession = buildShellSnapshotSession(
     cfg, (m) => stream.emit({ type: "error", message: m })
   )
   if (shellSnapshotSession !== undefined) {
     await shellSnapshotSession.pruneOnStart()
     cfg.shellSnapshotSession = shellSnapshotSession
   }
   ```
2. **Per-turn tick** (right after the dedup-gate `stampTurn`, before
   `stream.emit({ type: "turn_start" })`):
   ```ts
   if (shellSnapshotSession !== undefined) {
     await shellSnapshotSession.snapshotForTurn(turn)
   }
   ```

### Dispatch wire (`src/agent/dispatch.ts`, 1 spread)

```ts
const seam = config.shellSnapshotSession?.currentSeam()
...(seam !== undefined ? { shellSnapshot: seam } : {})
```

### Tool wire (`src/tool/bash/index.ts`, 1 spread)

```ts
...(ctx.shellSnapshot ? { shellSnapshot: ctx.shellSnapshot } : {})
```

The runtime-level `ShellOptions.shellSnapshot` was shipped under ADR-0204
follow-up and already calls `port.restore` before spawning — this slice
just plumbs the right handle TO that opt-in.

### Slice fences preserved

- `@/tool` does **not** import `@/runtime/shell-snapshot` — the seam shape
  is mirrored as `ShellSnapshotRestoreSeam` in `src/tool/types.ts` (same
  pattern as `GitWriteGuard`, `PlanMutator`).
- `@/agent` reaches `@/runtime/shell-snapshot` only through the slice
  barrel (`SnapshotHandle` + `ShellSnapshotPort` types) — never into the
  slice internals.

## Consequences

- **Default-OFF byte-identical.** `cfg.shellSnapshot` absent ⇒ the helper
  returns `undefined`, the loop's two `if`-branches short-circuit before
  any allocation, dispatch's optional-chain returns `undefined` so the
  field is omitted from `ctx`, the bash tool's `?:{}` spread evaporates,
  and `runShell` falls through to the legacy `["bash","-lc",cmd]` argv.
  No regression for the 2425 existing tests.
- **Per-turn freshness + per-turn cost.** When wired with the default
  `captureAtTurnStart:true`, each turn spawns `bash -i -c "declare -p;
  declare -f; alias"` (or zsh equivalent) ONCE per turn boundary. A
  typical capture is ≈90KB / ≈10ms — within the per-turn budget
  envelope already established for `git rev-parse` (ADR-0125).
- **No-throw wire.** Every failure mode is converted to an `error`
  AgentEvent: `shell-missing`, `empty-capture`, `capture-timeout`,
  `write-failed`, `invalid-id`, plus a defense-in-depth `throw`
  catch. The next `runShell` falls back to the byte-identical legacy
  spawn (no `source` prefix). The turn never aborts because of a
  snapshot fault.
- **Operator surface.** `shellSnapshot.shell = "auto"` reads `$SHELL`
  basename: `zsh` ⇒ zsh adapter; everything else ⇒ bash adapter (the
  POSIX broadest surface). Explicit `"zsh"` / `"bash"` overrides. The
  capture id is `turn-${turn}` so on-disk artifacts are turn-traceable.
- **Composition root responsibilities.** The composition root (CLI repl
  / web shell / bench driver) constructs the `ShellSnapshotPort` via
  `createShellSnapshotPort(spawner)` and passes it in. Production
  spawners wrap `Bun.spawn`; tests inject the headless stub. The CLI is
  free to opt out entirely by not wiring the field.

## Negative invariants

- The runShell call does **not** insert `source <path>;` when
  `ctx.shellSnapshot` is absent. A grep for `source ${handle.path}`
  outside `src/runtime/shell-snapshot/index.ts#buildRestoredArgv` must
  remain empty.
- `cfg.shellSnapshotSession` is **never** assigned `undefined` (it is
  assigned only when defined). Dispatch always uses optional-chain
  access so a future absence does not surface as `null` deref.
- Capture failures **never** propagate as exceptions to the loop or
  dispatch. The single in-helper `try/catch` is the no-throw boundary.
- The helper does **not** mutate the caller's `AgentConfig` object —
  the `cfg.shellSnapshotSession = ...` assignment targets the loop's
  shallow copy (`cfg`), not the user-supplied `config`. This mirrors
  the existing `cfg.run = stamped` pattern.
- `captureAtTurnStart:false` ⇒ exactly ONE `port.capture` across the
  session, even when called for many turns (hellgate A10).
- No `runShell` caller outside `src/tool/bash/index.ts` is rewired by
  this ADR — `git/runner.ts`, `test-runner`, `grep`, `localize`,
  `file-tree-summary`, and the inline `Bun.spawn` sites in
  `worktree.ts` / `worktree-fork.ts` are untouched. Wiring those is a
  separate ADR (the snapshot is hermetic for bash today; the others
  use a narrow command repertoire that does not depend on user
  aliases).
