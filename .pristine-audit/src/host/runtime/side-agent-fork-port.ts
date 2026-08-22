/**
 * §4.3 — the REAL OS adapter for the side-agent process-fork port (V1).
 *
 * This is the SINGLE place that couples the pure `@/side-agent` supervisor to
 * `node:child_process.fork`. It satisfies {@link ProcessForkPort} so the
 * supervisor (`createSupervisedProcessDaemon`) depends only on the abstraction
 * and is unit-tested over a fake fork; this adapter is exercised by an
 * integration test that spawns a real child module.
 *
 * V1 scope: fork a Node child with IPC (`child.send` / `'message'` / `'exit'`).
 * Transport is the default Node IPC channel (a pipe) — the audit's "socket IPC"
 * is satisfied by the structured-message channel; a dedicated unix-socket
 * transport is the explicitly-deferred depth follow-up. NO launchctl/systemd.
 *
 * Default-OFF: nothing constructs this unless the composition root opts in under
 * `QUANTA_SIDE_AGENT_PROCESS` (`runtimeConfig().sideAgentProcess`).
 */

import { type ChildProcess, fork as nodeFork } from "node:child_process"
import { fileURLToPath } from "node:url"
import { defaultPpidWalkKiller, escalatingKill, type ProcessTreeKiller } from "@/runtime"
import type {
  ChildProcessHandle,
  ProcessForkPort,
  ProcessForkSpec,
  SideAgentIpcMessage,
} from "@/side-agent"

/**
 * Whole-tree killer for forked side-agents (D1 leak-fix — OmO R1-stopgap).
 *
 * A forked side-agent runs its OWN agent loop and can spawn descendants (bash
 * trees, test runners, LSP servers). The old `kill()` sent a single-PID SIGTERM
 * that hit ONLY the fork — its children reparented to init and LEAKED
 * (ports/CPU/locks; the documented "state=running but no process" orphan class).
 * Routing through {@link escalatingKill} + this ppid-walk killer signals the
 * WHOLE descendant tree and escalates SIGTERM→SIGKILL. The module-singleton
 * convention (ONE stateless ps-walker per surface; degrades to single-PID when
 * `ps` is absent or the child has no descendants — wiring it is never wrong)
 * matches `pty-backend`'s `PTY_TREE_KILLER`. NOTE: this surface is STRONGER than
 * pty-backend — pty signals the tree ONCE with no escalation; the side-agent
 * wraps the killer in `escalatingKill` (SIGTERM→grace→SIGKILL + reaped latch),
 * because a forked side-agent can hold a TERM-trapping child tree.
 */
const SIDE_AGENT_TREE_KILLER: ProcessTreeKiller = defaultPpidWalkKiller()

/**
 * Absolute path to the PRODUCTION side-agent child worker module
 * (`@/side-agent/worker-entry.mjs`) the process-backed registry forks. Resolved
 * relative to THIS module (the host composition root that knows on-disk layout)
 * so `@/side-agent` stays plane-clean and never needs its own filesystem path.
 *
 * The worker is a dependency-free `.mjs` (no `@/…` aliases) so it runs under the
 * bun OR node `execPath` that `child_process.fork` selects without a tsconfig
 * path-resolver.
 */
export const sideAgentWorkerModulePath = (): string =>
  fileURLToPath(new URL("../../side-agent/worker-entry.mjs", import.meta.url))

/** Wrap a live `ChildProcess` as a {@link ChildProcessHandle}. NO-THROW —
 *  `send`/`kill` on a dead child are swallowed (the supervisor's `onExit` is the
 *  authoritative liveness signal, not a thrown EPIPE).
 *
 *  `killer` is INJECTED (DIP — the unit hellgate passes a spy; production uses
 *  the module {@link SIDE_AGENT_TREE_KILLER}). Exported for that test.
 *
 *  ⚠️ node vs Bun: {@link escalatingKill} owns the SIGTERM→SIGKILL escalation and
 *  self-disarms via `KillableChild.exited` (a `Promise`). `node:child_process`
 *  has NO `.exited` promise (that is Bun.Subprocess), so we synthesize one from
 *  the `'exit'` event — that promise IS the reaped/disarm signal, so a leaked
 *  grace timer (the jun-28 bug class) cannot occur and a late kill() on a reaped
 *  (possibly recycled) pid is a no-op. */
export const wrapChild = (
  cp: ChildProcess,
  killer: ProcessTreeKiller = SIDE_AGENT_TREE_KILLER,
): ChildProcessHandle => {
  let exited = false
  // Adapt node ChildProcess → the KillableChild escalatingKill expects. The
  // synthesized `exited` promise resolves on the child's `'exit'` event, which
  // is what drives escalatingKill's reaped-latch + grace-timer disarm.
  // FORWARD-DEDUP: this node-'exit'→Promise synthesis is currently the ONLY
  // node-fork+escalatingKill site (the Bun sites use the native `.exited`). If a
  // SECOND node-fork surface needs tree-kill, extract `nodeChildToKillable(cp)`
  // to `@/runtime` rather than copy this block.
  const esc = escalatingKill(
    {
      kill: (signal) => void cp.kill(signal),
      exited: new Promise<number>((resolve) => cp.once("exit", (code) => resolve(code ?? 0))),
      // `exactOptionalPropertyTypes`: omit `pid` entirely when absent (never pass
      // an explicit `undefined`) — escalatingKill's `pid > 0` guard treats a
      // missing pid as "no tree, single-PID fallback".
      ...(cp.pid !== undefined ? { pid: cp.pid } : {}),
    },
    killer,
  )
  return {
    pid: cp.pid ?? -1,
    send(msg: SideAgentIpcMessage): void {
      if (exited || cp.killed) return
      // `cp.send` can throw ERR_IPC_CHANNEL_CLOSED on a racing exit — swallow.
      try {
        cp.send(msg)
      } catch {
        /* dead channel — the onExit path will fire */
      }
    },
    onMessage(handler): () => void {
      const wrapped = (raw: unknown): void => {
        // Trust-boundary: only forward well-formed messages from our own worker.
        if (raw !== null && typeof raw === "object" && "kind" in raw) {
          handler(raw as SideAgentIpcMessage)
        }
      }
      cp.on("message", wrapped)
      return () => void cp.off("message", wrapped)
    },
    onExit(handler): () => void {
      const wrapped = (code: number | null, signal: NodeJS.Signals | null): void => {
        exited = true
        handler({ code, signal: signal ?? null })
      }
      cp.once("exit", wrapped)
      return () => void cp.off("exit", wrapped)
    },
    kill(): void {
      if (exited) return
      // Whole-tree SIGTERM now + escalate to SIGKILL after the grace window
      // unless the child (and its tree) exits first. escalatingKill is no-throw
      // and reaped-safe; the raw single-PID `cp.kill` is gone (it leaked the
      // fork's descendants).
      esc.kill()
    },
  }
}

/** The real fork port over `node:child_process`. */
export const nodeProcessForkPort: ProcessForkPort = {
  fork(spec: ProcessForkSpec): ChildProcessHandle {
    const cp = nodeFork(spec.modulePath, [...(spec.args ?? [])], {
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      ...(spec.env !== undefined ? { env: { ...process.env, ...spec.env } } : {}),
      // serialization:'advanced' keeps structured-clone fidelity for our typed
      // IPC messages (vs JSON which drops e.g. undefined-vs-absent distinctions).
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    })
    return wrapChild(cp)
  },
}
