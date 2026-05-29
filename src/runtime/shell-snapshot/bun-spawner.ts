/**
 * ADR-0238 — production `Bun.spawn`-backed `SnapshotSpawner`.
 *
 * Sibling to the deterministic `headless-stub.ts` test adapter. The slice
 * (`zsh-capture.ts` / `bash-capture.ts`) consumes a {@link SnapshotSpawner}
 * port; this adapter is the ONLY production implementation, instantiated at
 * the composition root and threaded into `createShellSnapshotPort`.
 *
 * Contract honoured:
 *   - **no-throw** — every failure mode collapses to the typed
 *     `{ code, stdout, timedOut, spawnFailed?, detail? }` shape the adapter
 *     converts into a `SnapErr`. We catch around `Bun.spawn` (ENOENT / EACCES
 *     on the shell binary) AND around the async stdout drain (broken pipe
 *     after kill) so the caller never observes a thrown exception.
 *   - **timeoutMs** — enforced via a single `setTimeout` that issues
 *     `proc.kill()` and records `timedOut = true`. We do NOT use Bun's native
 *     `timeout` spawn option because it surfaces as an unstable exit code
 *     (`null` / `SIGKILL`) that races with our spawn-failure branch — explicit
 *     timer + kill keeps the path testable and the typed shape stable.
 *   - **stdout capture** — full body read via `new Response(proc.stdout).text()`,
 *     same idiom as `os-sandbox/linux.ts` defaultSpawner. The captured body
 *     is the caller-side trim/empty check responsibility (the capture
 *     adapters treat empty → `empty-capture` error).
 *   - **stderr discarded** — the snapshot dump scripts (`typeset -p; …`) emit
 *     a small amount of harmless stderr (e.g. unbound-variable warnings under
 *     `set -u`). Persisting only stdout matches Codex's behaviour
 *     (`~/.codex/shell_snapshots/*.sh` contains stdout only).
 *
 * Plane-clean: imports ONLY from `./zsh-capture` (for the {@link SnapshotSpawner}
 * type) and the Bun global. No reach across slices.
 */

import { errMessage } from "@/shared"
import type { SnapshotSpawner } from "./zsh-capture"
/** Default hard-timeout for `capture` calls when the caller does not pass
 *  one. Mirrors the slice-default `DEFAULT_CAPTURE_TIMEOUT_MS` (10s) — kept
 *  in sync via the explicit upstream constant. The factory accepts an
 *  override so a composition root can tune the cap globally without
 *  threading it through every callsite. */
export const DEFAULT_BUN_SPAWNER_TIMEOUT_MS = 10_000

/** Bun-spawner factory options. All optional — the bare `createBunSpawner()`
 *  call yields a production-shaped adapter with safe defaults. */
export interface BunSpawnerOptions {
  /** Hard cap on every spawn — when `opts.timeoutMs` is OMITTED by the
   *  caller, this default applies. When the caller PASSES a `timeoutMs`,
   *  that wins (the upstream capture adapters already supply a default). */
  readonly defaultTimeoutMs?: number
}

/** Bun.spawn-backed production adapter. Returns a {@link SnapshotSpawner}
 *  whose `run` method honours the closed contract:
 *
 *    - resolves with `{ code: null, spawnFailed: true, detail }` when the
 *      binary cannot be spawned (ENOENT / EACCES) — the upstream capture
 *      adapter converts this into `SnapErr.shell-missing`.
 *    - resolves with `{ code: <exit>, stdout, timedOut: true }` when the
 *      timer fires before `proc.exited` resolves — converted upstream into
 *      `SnapErr.capture-timeout`.
 *    - resolves with `{ code: <exit>, stdout, timedOut: false }` on a
 *      normal exit (including non-zero exit; the upstream guards on
 *      `code === null` ONLY, so a non-zero exit with non-empty stdout
 *      proceeds — matches Codex's permissive dump semantics).
 *
 *  The adapter is STATELESS — call it once at composition-root and reuse the
 *  returned object across the session.
 */
export const createBunSpawner = (opts: BunSpawnerOptions = {}): SnapshotSpawner => {
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_BUN_SPAWNER_TIMEOUT_MS
  return {
    async run(argv, runOpts) {
      const timeoutMs = runOpts.timeoutMs > 0 ? runOpts.timeoutMs : defaultTimeoutMs
      // Bun.spawn is happy with a ReadonlyArray<string>; copy defensively
      // to satisfy the (string[]) overload signature and so a downstream
      // mutator cannot reach the caller's argv.
      const argvCopy = [...argv]
      // SPAWN — synchronous throw on missing binary becomes `spawn-failed`.
      // `Bun.spawn` throws synchronously on ENOENT (verified against
      // bun-1.1+), so a try/catch here is necessary.
      let proc: ReturnType<typeof Bun.spawn>
      try {
        proc = Bun.spawn(argvCopy, {
          stdout: "pipe",
          stderr: "pipe",
        })
      } catch (e) {
        const detail = errMessage(e)
        return { code: null, stdout: "", timedOut: false, spawnFailed: true, detail }
      }

      // TIMEOUT — single setTimeout that issues `proc.kill()`. The timer is
      // cleared on normal exit (no leaked handles in the success path). We
      // set `timedOut` BEFORE issuing the kill so the post-`exited` branch
      // can distinguish a timeout from a user-triggered kill.
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          proc.kill()
        } catch {
          // Already exited concurrently — `proc.kill()` may throw on a
          // already-dead pid. Best-effort; the `await proc.exited` below
          // will resolve regardless.
        }
      }, timeoutMs)

      // STDOUT DRAIN — wrap in try/catch because reading from a stream
      // attached to a killed process can throw "Stream closed" on some Bun
      // versions. We treat that as "empty stdout" — the caller's
      // `empty-capture` or `capture-timeout` branch then fires.
      let stdout = ""
      try {
        stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
      } catch {
        stdout = ""
      }

      // EXIT — `proc.exited` resolves regardless of normal / killed
      // termination. Type-cast: Bun types this as `Promise<number>` but in
      // practice can be `null` after `kill()`; we coerce a null to 1 so the
      // upstream branch sees a defined number (the upstream only
      // null-guards `code` to detect spawn-failure, which we have already
      // handled above).
      const rawExit = (await proc.exited) as number | null
      clearTimeout(timer)

      // EXIT CODE NORMALISATION — after a kill, Bun may surface `null`. We
      // coerce to 1 so the upstream's `code === null` branch (reserved for
      // spawn-failure) is NOT mistakenly tripped. A timed-out run reports
      // `timedOut: true` so the upstream picks the timeout branch first.
      const code = rawExit === null ? 1 : rawExit

      return { code, stdout, timedOut }
    },
  }
}
