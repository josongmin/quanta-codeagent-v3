/**
 * RAII-style guard for the lifecycle of a spawned child process.
 *
 * WHY THIS EXISTS — every spawn site in this slice (runShell's observer +
 * buffered paths, LocalSandbox.run, DockerSandbox.run) had grown the SAME
 * hand-written bookkeeping:
 *
 *   const kill = () => { try { proc.kill() } catch {} }
 *   const timer = setTimeout(kill, timeoutMs)
 *   try { ...consume proc... }
 *   catch (e) { kill(); throw e }      // ← easy to forget on a new site
 *   finally { clearTimeout(timer); signal?.removeEventListener(...) }
 *
 * Duplicating the `catch { kill(); throw }` at each call site means a future
 * spawn site can silently OMIT it and orphan a child on a mid-drain throw —
 * exactly the leak the recent fixes patched, one site at a time. This wrapper
 * folds the kill-on-throw AND the timer/listener teardown into a SINGLE place
 * so a new spawn site gets correct cleanup by construction; the only failure
 * mode left is forgetting to call `withSpawnedChild` at all — which is visible
 * in review because the spawn would have no guard around it.
 *
 * BEHAVIORAL CONTRACT (byte-identical to the prior inline guards):
 *  - Runs `body` to completion and returns its value on the normal path.
 *  - On ANY throw/rejection from `body` (observer raised, pipe read rejected,
 *    abort/timeout-induced read error, …) it calls `kill()` exactly once and
 *    rethrows the ORIGINAL error — it never swallows or wraps it.
 *  - `kill()` is expected to be no-op-safe after the child has already exited
 *    (the call sites pass a `try { proc.kill() } catch {}` closure); the guard
 *    does not add its own try/catch around it, preserving the existing shape.
 *  - The `finally` cleanup (clear the timeout timer, remove the abort listener)
 *    ALWAYS runs — on the normal path, the error path, and an abort/timeout —
 *    so the timer and listener can never be split from the spawn they guard.
 *  - The guard does NOT kill on the normal path: a successful `body` is
 *    responsible for having awaited `proc.exited` itself. The guard's kill is
 *    strictly the abnormal-exit safety net. This matches the prior inline code,
 *    where `kill()` lived only in the `catch`, never in the `try`'s success
 *    tail.
 *  - TERMINAL-EVENT NOTE: emitting the observer's terminal `exit`/`aborted`
 *    event stays INSIDE `body`, deliberately. The contract is "exactly one
 *    terminal event on normal completion / abort, and NONE on an internal
 *    throw" — keeping the emit in `body` (before its normal return) means a
 *    throw skips it for free, identical to the prior code.
 */

/** A spawned-child handle the guard needs to clean up. Structural — it only
 *  needs `kill`, which both `Bun.Subprocess` and our no-op-safe wrappers have.
 *  We deliberately do NOT depend on the full `Bun.Subprocess` type so the
 *  guard stays reusable for any spawn-like handle. */
export interface GuardedSpawnHooks {
  /** Terminate the child. MUST be no-op-safe if the child has already exited
   *  (call sites pass `() => { try { proc.kill() } catch {} }`). Invoked at
   *  most once, only on the abnormal (throw) path. */
  readonly kill: () => void
  /** Optional teardown that ALWAYS runs in `finally` alongside timer cleanup —
   *  e.g. `() => signal?.removeEventListener("abort", onAbort)`. Kept here so
   *  it can never be split from the spawn it belongs to. May be omitted. */
  readonly cleanup?: () => void
  /** Optional timeout timer to clear in `finally`. Passing it here (instead of
   *  clearing it inside `body`) guarantees it is cleared on every exit path. */
  readonly timer?: ReturnType<typeof setTimeout>
}

/**
 * Run `body` under the spawned-child guard described above.
 *
 * @param hooks  kill (no-op-safe), and optional `timer` + `cleanup` teardown.
 * @param body   consumes the child and returns the run's result. It owns
 *               awaiting `proc.exited` and emitting any terminal observer
 *               event on its normal-return path.
 * @returns      whatever `body` resolves to.
 * @throws       rethrows `body`'s original error AFTER calling `kill()`.
 */
export const withSpawnedChild = async <T>(
  hooks: GuardedSpawnHooks,
  body: () => Promise<T>,
): Promise<T> => {
  try {
    return await body()
  } catch (e) {
    // Abnormal exit: body never reached its `await proc.exited`, so the child
    // may still be running and would orphan. Kill it once, then rethrow the
    // ORIGINAL error untouched.
    hooks.kill()
    throw e
  } finally {
    if (hooks.timer !== undefined) clearTimeout(hooks.timer)
    hooks.cleanup?.()
  }
}
