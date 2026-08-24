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
 *
 * COMPILED-BINARY LIMIT: this backer is a SOURCE-ONLY capability. In a
 * `bun build --compile` artifact the fork is structurally impossible (not merely
 * mis-pathed) and the port REFUSES with {@link SideAgentForkUnsupportedError}
 * rather than re-execing the application as its own worker. The worker bytes are
 * embedded so the path at least stops escaping to `/`. Pinned in
 * `tools/dev/compiled-binary-assets.json`; proven by
 * `tests/unit/side-agent-fork-port-compiled-binary-hellgate.test.ts`.
 */

import { type ChildProcess, fork as nodeFork } from "node:child_process"
import { defaultPpidWalkKiller, escalatingKill, type ProcessTreeKiller } from "@/runtime"
import type {
  ChildProcessHandle,
  ProcessForkPort,
  ProcessForkSpec,
  SideAgentIpcMessage,
} from "@/side-agent"
// EMBEDDED, not walked to from disk. `bun build --compile` produces a single-file
// binary whose module root is bun's virtual `/$bunfs/root`, so the old relative
// walk (`new URL("../../side-agent/worker-entry.mjs", import.meta.url)`) ran off
// the top of that root and escaped to the FILESYSTEM ROOT.
//
// Measured, from a cwd OUTSIDE the repo:
//   FROM SOURCE  workerPath=/…/src/side-agent/worker-entry.mjs  exists=true
//   COMPILED     workerPath=/side-agent/worker-entry.mjs        exists=false
//
// `with { type: "file" }` embeds the bytes and hands back a path that resolves in
// BOTH modes — the same mechanism `permission/shell/parser.ts` and
// `skill/system-skills` already use. From source the value is byte-identical to
// the old walk, so the working path is unchanged.
import workerEntryAssetPath from "@/side-agent/worker-entry.mjs" with { type: "file" }

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
 * (`@/side-agent/worker-entry.mjs`) the process-backed registry forks.
 *
 * EMBEDDED (see the import header): the bytes travel inside the artifact, so the
 * path is real in both modes instead of escaping to `/`. The worker stays a
 * dependency-free `.mjs` (no `@/…` aliases) so it runs under the bun OR node
 * `execPath` that `child_process.fork` selects without a tsconfig path-resolver.
 *
 * ⚠️ In a COMPILED binary this path is real but NOT forkable — the embed fixes
 * the path, not the fork. {@link nodeProcessForkPort} refuses before it is ever
 * used; see {@link SideAgentForkUnsupportedError} for the measurement.
 */
export const sideAgentWorkerModulePath = (): string => workerEntryAssetPath

/** Bun's virtual filesystem root inside a `bun build --compile` single-file
 *  binary. This is the ONE self-rooting read left in this module, and it is a
 *  question about the RUNTIME ("am I inside a single-file binary?"), not an
 *  attempt to locate a file. */
const SINGLE_FILE_BINARY_MARKER = "/$bunfs/"

/**
 * Is this module executing inside a `bun build --compile` single-file binary?
 *
 * MEASURED, not guessed — `import.meta.url` is
 * `file:///Users/…/side-agent-fork-port.ts` from source and
 * `file:///$bunfs/root/…` when compiled.
 */
const inCompiledSingleFileBinary = (): boolean =>
  import.meta.url.includes(SINGLE_FILE_BINARY_MARKER)

/**
 * The forked side-agent backer is UNAVAILABLE in a compiled single-file binary.
 * A typed, named refusal — deliberately NOT a silent degrade, and deliberately
 * not an env override (none exists and inventing one would only let an operator
 * re-enable something that cannot work).
 *
 * WHY IT CANNOT WORK — two independent measurements, both from a cwd outside the
 * repo:
 *
 *  1. `child_process.fork` launches `process.execPath`. In a compiled binary that
 *     is THE APPLICATION BINARY ITSELF, and a single-file binary IGNORES argv[1]
 *     as a module — it re-runs its own embedded entry. So each "worker" child is
 *     a second copy of the whole app, which forks again: a probe that forked ONCE
 *     produced 328 recursive processes before it was killed. A FORK BOMB, which
 *     is strictly worse than the ENOENT it replaced.
 *  2. The embedded worker path is PROCESS-PRIVATE. An external
 *     `bun /$bunfs/root/worker-entry-*.mjs` answers `Module not found` and `ls`
 *     answers `No such file or directory`, so pointing `fork` at a real runtime
 *     via `execPath` cannot rescue it either.
 *
 * Making this backer work when compiled needs the app to re-exec ITSELF under a
 * worker subcommand its own entry recognises — an architecture change in the CLI
 * entry, not a path fix. Until then the DEFAULT in-process side-agent backer is
 * unaffected and remains the shipped path.
 */
export class SideAgentForkUnsupportedError extends Error {
  constructor(readonly modulePath: string) {
    super(
      "side-agent process fork is unavailable in a compiled single-file binary: " +
        "child_process.fork() launches process.execPath, which here is the application " +
        "binary itself, and that binary ignores argv[1] as a module — every forked " +
        "'worker' would be another copy of the whole app (measured: one fork produced " +
        `328 recursive processes). The worker module is embedded at ${modulePath}, ` +
        "which is private to this process and unreadable by any external runtime. " +
        "Run from source to use QUANTA_SIDE_AGENT_PROCESS; the default in-process " +
        "side-agent backer is unaffected.",
    )
    this.name = "SideAgentForkUnsupportedError"
  }
}

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

/** The real fork port over `node:child_process`.
 *
 *  Throws {@link SideAgentForkUnsupportedError} inside a compiled single-file
 *  binary INSTEAD of forking. That refusal is the whole point: the fork would
 *  otherwise re-exec the application as its own "worker" and recurse. The check
 *  is on the RUNTIME, not on the spec, so a caller cannot route around it with a
 *  different `modulePath`. From source this is a no-op — the port behaves exactly
 *  as before — and with `QUANTA_SIDE_AGENT_PROCESS` off (the default) nothing
 *  constructs this port at all. */
export const nodeProcessForkPort: ProcessForkPort = {
  fork(spec: ProcessForkSpec): ChildProcessHandle {
    if (inCompiledSingleFileBinary()) throw new SideAgentForkUnsupportedError(spec.modulePath)
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
