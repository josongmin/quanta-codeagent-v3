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
/** Grace period between the polite SIGTERM and the forceful SIGKILL. A child
 *  that traps or ignores SIGTERM (`trap '' TERM`) would otherwise run to
 *  natural completion despite an abort/timeout; after this window we escalate
 *  to SIGKILL (signal 9), which cannot be trapped. Kept as an UPPER_SNAKE_CASE
 *  named const — the runtime scanner bans bare magic timeouts. Well-behaved
 *  children exit on the initial SIGTERM long before this fires, so their
 *  timing is unchanged (the grace timer is cleared the moment the child
 *  exits). */
export const KILL_GRACE_MS = 2_000;
/**
 * Build a SIGTERM→SIGKILL escalating kill for a spawned child.
 *
 * WHY — `proc.kill()` sends a single SIGTERM. A child that traps or ignores
 * TERM (`trap '' TERM; sleep 30`) survives the abort/timeout and runs to
 * natural completion, defeating cancellation. This wraps the polite kill so
 * that, if the child has NOT exited within {@link KILL_GRACE_MS}, we escalate
 * to SIGKILL (signal 9) — which the OS delivers unconditionally.
 *
 * The grace timer is one-shot and self-clearing: it is cleared when the child's
 * `exited` promise resolves (well-behaved children exit on TERM before it
 * fires, so SIGKILL is never sent and their timing is unaffected) and again in
 * `disarm`, so it can never outlive the child.
 *
 * Centralized here so every spawn site (runShell, LocalSandbox, DockerSandbox)
 * gets the same escalation by passing this `kill` to {@link withSpawnedChild}
 * and `disarm` in its `cleanup`.
 */
export const escalatingKill = (proc) => {
    let graceTimer;
    const disarm = () => {
        if (graceTimer !== undefined) {
            clearTimeout(graceTimer);
            graceTimer = undefined;
        }
    };
    // Clear the grace timer the instant the child is reaped — covers the common
    // case where the child exits on SIGTERM (or on its own) before the grace
    // window elapses, so the SIGKILL is never sent and the timer never leaks.
    void proc.exited.then(disarm, disarm);
    const kill = () => {
        try {
            proc.kill(); // polite SIGTERM first
        }
        catch {
            // already exited
        }
        // Arm the escalation only once; a re-entrant kill() must not stack timers.
        if (graceTimer !== undefined)
            return;
        graceTimer = setTimeout(() => {
            graceTimer = undefined;
            try {
                proc.kill("SIGKILL"); // signal 9 — uncatchable, for TERM-trapping children
            }
            catch {
                // already exited in the grace window
            }
        }, KILL_GRACE_MS);
        // Don't let the grace timer keep the event loop alive on its own.
        graceTimer.unref?.();
    };
    return { kill, disarm };
};
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
export const withSpawnedChild = async (hooks, body) => {
    try {
        return await body();
    }
    catch (e) {
        // Abnormal exit: body never reached its `await proc.exited`, so the child
        // may still be running and would orphan. Kill it once, then rethrow the
        // ORIGINAL error untouched.
        hooks.kill();
        throw e;
    }
    finally {
        if (hooks.timer !== undefined)
            clearTimeout(hooks.timer);
        hooks.cleanup?.();
    }
};
