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
import type {
  ChildProcessHandle,
  ProcessForkPort,
  ProcessForkSpec,
  SideAgentIpcMessage,
} from "@/side-agent"

/** Wrap a live `ChildProcess` as a {@link ChildProcessHandle}. NO-THROW —
 *  `send`/`kill` on a dead child are swallowed (the supervisor's `onExit` is the
 *  authoritative liveness signal, not a thrown EPIPE). */
const wrapChild = (cp: ChildProcess): ChildProcessHandle => {
  let exited = false
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
      try {
        cp.kill("SIGTERM")
      } catch {
        /* already dead */
      }
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
