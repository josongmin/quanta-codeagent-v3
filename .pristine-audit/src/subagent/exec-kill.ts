/**
 * WS1 (jul-12 OmO absorption) — the process-kill handle + factory `exec_command`
 * uses to tear down its `bash -lc` child. Split out of `handlers-6.ts` so that
 * module stays under the god-MODULE ratchet (>1000 lines) — the kill contract is
 * a cohesive unit that reads better on its own anyway.
 *
 * Slice-clean: imports only the `bun` Subprocess type. The *implementation* of a
 * tree-aware escalating kill lives in @/runtime (`escalatingKill` +
 * `defaultPpidWalkKiller`), which @/subagent may NOT import — so the composition
 * root (`agent/tier1/subagent.ts`) injects a {@link MakeProcKill} factory and
 * this slice only ever sees the structural {@link ProcKillHandle}. Absent ⇒
 * {@link legacyKillHandle} (single-pid, byte-identical to the pre-WS1 behavior).
 */

import type { Subprocess } from "bun"

/** Structural mirror of @/runtime `EscalatingKill`: SIGTERM the process tree now,
 *  escalate to SIGKILL after a grace window unless the child exits first. */
export interface ProcKillHandle {
  /** No-op-safe / idempotent tree SIGTERM (then escalating SIGKILL). */
  readonly kill: () => void
  /** Clear the pending SIGKILL grace timer (call in the exec `finally`). */
  readonly disarm: () => void
}

/** Factory the composition root injects: wrap a spawned child in an escalating,
 *  tree-aware kill. Absent ⇒ {@link legacyKillHandle} (byte-identical). */
export type MakeProcKill = (proc: Subprocess<"pipe", "pipe", "pipe">) => ProcKillHandle

/** The pre-WS1 single-pid fallback: SIGTERM only the shell's own pid, no grace
 *  timer. Used when no tree-killer factory is injected — byte-identical to the
 *  legacy timeout/abort behavior. */
export const legacyKillHandle = (proc: Subprocess<"pipe", "pipe", "pipe">): ProcKillHandle => ({
  kill: () => {
    try {
      proc.kill()
    } catch {
      // already dead
    }
  },
  disarm: () => {},
})
