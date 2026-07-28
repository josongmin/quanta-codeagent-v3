import type { Subprocess } from "bun"
import { PUMP_DEATH_EXIT_GRACE_MS } from "@/plugin-isolation"
import { errMessage, logger, sliceTailWholeChars } from "@/shared"
import { buildLspServerEnv, resolveLspMemBudgetMb } from "../../server-mem-budget"
import {
  type LspRssWatchdogHandle,
  resolveLspRssBudgetMb,
  startLspRssWatchdog,
} from "../../server-rss-watchdog"
import { encodeMessage, type JsonRpcMessage, MessageReader } from "../jsonrpc"
import type { LspClientOptions, LspProcessTreeSignal } from "./config"
import { STDERR_TAIL_MAX } from "./config"

/** Ports the {@link LspTransport} needs from its host `LspClient` (pure
 *  structural motion — no behavior change). */
export interface LspTransportPorts {
  /** Fan-out sink for a decoded inbound JSON-RPC message (the client's
   *  `dispatch`). */
  onMessage(msg: JsonRpcMessage): void
  /** Deliberate-stop flag (owned by the client). Read by the pump-death judge
   *  so a stop()-driven pump end stays quiet. */
  isStopped(): boolean
  /** Reject every pending request (owned by the client / correlator). Invoked
   *  when the read channel dies while the process still lives. */
  failAllPending(reason: Error): void
}

/** State owner for the stdio subprocess transport split out of `LspClient`
 *  (pure structural motion — no behavior change).
 *
 *  Owns `proc`, `reader` (MessageReader), `readPump`, `stderrPump`,
 *  `stderrTail`, `rssWatchdog`, `exited`, `processTreeKiller`, `command`,
 *  `cwd`. Exposes `write(bytes)` for outbound payloads, drives the read pump
 *  through the injected `onMessage` sink, and preserves — exactly — the RSS
 *  watchdog SIGKILL-on-exceed, stderr-tail cap, and pump-death grace race. */
export class LspTransport {
  readonly command: string[]
  readonly cwd: string
  private readonly processTreeKiller: LspClientOptions["processTreeKiller"]

  proc: Subprocess<"pipe", "pipe", "pipe"> | null = null
  /** RSS watchdog over `proc` — kills a server whose total resident memory blows
   *  past the budget (off-heap pyright OOM that `--max-old-space-size` cannot
   *  catch). null when disabled (budget 0) or before start. */
  rssWatchdog: LspRssWatchdogHandle | null = null
  reader = new MessageReader()
  readPump: Promise<void> | null = null
  stderrPump: Promise<void> | null = null
  exited = false
  /** Bounded tail of the server's most recent stderr (decoded). The drain pump
   *  exists to keep the OS pipe empty (deadlock guard); we ALSO retain the tail
   *  so an unexpected exit (crash / OOM SIGKILL) logs the reason the server
   *  printed — formerly every stderr byte was discarded, so a dying pyright left
   *  no diagnosable trace. Capped at {@link STDERR_TAIL_MAX}. */
  stderrTail = ""

  constructor(
    command: string[],
    cwd: string,
    processTreeKiller: LspClientOptions["processTreeKiller"],
    private readonly ports: LspTransportPorts,
  ) {
    this.command = command
    this.cwd = cwd
    this.processTreeKiller = processTreeKiller
  }

  /** Spawn the server and start the read/stderr pumps + exit watcher + RSS
   *  watchdog. Idempotent: returns immediately if already spawned. `onExit`
   *  is the client's exit handler (fail-pending + classify). */
  spawn(onExit: () => void | Promise<void>): void {
    if (this.proc) return
    this.proc = Bun.spawn(this.command, {
      cwd: this.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Cap the V8 old-space heap of Node-based servers (pyright /
      // typescript-language-server) so one can never OOM the host: a large repo
      // balloons pyright's heap, and with bench concurrency + warm-pool-retained
      // servers the combined RSS OOM-killed a 64GB box (jun-26). DEFAULT-ON 4096
      // MB; `QUANTA_LSP_MEM_BUDGET_MB=0` opts out (env passed through unchanged,
      // byte-identical). Non-Node servers (clangd/gopls/rust-analyzer) ignore
      // NODE_OPTIONS — harmless. Read here (not via runtime-config) to match
      // base.ts already sourcing process.{pid,cwd} directly at the spawn site.
      env: buildLspServerEnv(process.env, resolveLspMemBudgetMb(process.env)),
    })
    this.readPump = this.pumpStdout()
    // Drain stderr to completion so a verbose language server (tsserver /
    // Pyright debug output) can never fill the OS stderr pipe (~64KB) and block
    // its own next stderr write — which would stall the stdout JSON-RPC channel
    // and hang every pending request to its `requestTimeoutMs`. Bytes are
    // discarded; this is purely a deadlock guard. Mirrors the stdout pump.
    this.stderrPump = this.drainStderr()
    this.watchExit(onExit)

    // DEFENSIVE guard for OFF-heap RSS runaway: `--max-old-space-size` (above)
    // caps only V8 old-space, so a server whose memory grows OUTSIDE old-space
    // (external / ArrayBuffer / native) can still climb RSS to the host limit
    // without Node ever throwing its own heap OOM. This watchdog kills such a
    // runaway tree → the pool degrades that cwd to no-LSP (grep/read still work)
    // and the host survives. NOTE (jun-28): budget DEFAULT (8GB) sits ABOVE the
    // 4GB heap cap, so it does NOT govern an ON-heap balloon (that self-OOMs at
    // 247 first — measured on xarray); this guard is for the off-heap path only.
    // Opt out with QUANTA_LSP_RSS_BUDGET_MB=0.
    const rssBudgetMb = resolveLspRssBudgetMb(process.env)
    const pid = this.proc.pid
    if (rssBudgetMb > 0 && typeof pid === "number") {
      logger.info("lsp: RSS watchdog armed", {
        command: this.command[0],
        pid,
        budgetMb: rssBudgetMb,
      })
      this.rssWatchdog = startLspRssWatchdog({
        pid,
        budgetMb: rssBudgetMb,
        onExceed: (rssMb) => {
          logger.warn("lsp: server RSS over budget — killing to protect host", {
            command: this.command[0],
            cwd: this.cwd,
            rssMb: Math.round(rssMb),
            budgetMb: rssBudgetMb,
          })
          // SIGKILL the runaway tree IMMEDIATELY — a graceful stop() would await
          // a `shutdown` request (up to requestTimeoutMs) while the server keeps
          // ballooning and could still OOM the box. The proc death cascades into
          // watchExit (fails pending) → the pool's reactive teardown.
          const proc = this.proc
          if (proc) this.signalServerProcess(proc, "SIGKILL")
        },
      })
    }
  }

  /** Encode + write a JSON-RPC payload to the server's stdin. Returns an
   *  `Error` on a dead/broken channel (so the correlator can reject the pending
   *  entry synchronously) or `null` on success. */
  write(payload: unknown): Error | null {
    const stdin = this.proc?.stdin
    if (!stdin) {
      const err = new Error("LSP transport unavailable: stdin closed")
      logger.warn("lsp: failed to write to server stdin", { error: err.message })
      return err
    }
    try {
      stdin.write(encodeMessage(payload))
      return null
    } catch (e) {
      const err = e instanceof Error ? e : new Error(errMessage(e))
      logger.warn("lsp: failed to write to server stdin", { error: err.message })
      return new Error(`LSP transport write failed: ${err.message}`)
    }
  }

  signalServerProcess(
    proc: Subprocess<"pipe", "pipe", "pipe">,
    signal: LspProcessTreeSignal,
  ): void {
    const pid = proc.pid
    if (this.processTreeKiller !== undefined && typeof pid === "number" && pid > 0) {
      try {
        this.processTreeKiller.signalTree(pid, signal)
        return
      } catch (e) {
        // injected killer is expected no-throw; keep stop() defensive anyway.
        logger.warn("lsp: process-tree signal threw (defensive)", {
          pid,
          signal,
          error: errMessage(e),
        })
      }
    }
    try {
      proc.kill(signal)
    } catch (e) {
      // process may have already exited
      logger.warn("lsp: proc.kill threw (likely already exited)", {
        pid,
        signal,
        error: errMessage(e),
      })
    }
  }

  async waitForProcessExit(
    proc: Subprocess<"pipe", "pipe", "pipe">,
    timeoutMs: number,
  ): Promise<boolean> {
    let exited = false
    await Promise.race([
      proc.exited
        .then(() => {
          exited = true
        })
        .catch(() => {
          exited = true
        }),
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs).unref?.()
      }),
    ])
    return exited
  }

  private async pumpStdout(): Promise<void> {
    const proc = this.proc
    const stdout = proc?.stdout
    if (!proc || !stdout) return
    let pumpError: unknown = null
    try {
      for await (const chunk of stdout) {
        for (const msg of this.reader.push(chunk)) {
          this.ports.onMessage(msg)
        }
      }
    } catch (e) {
      pumpError = e
    }
    const detail = pumpError === null ? "stdout closed (EOF)" : errMessage(pumpError)
    // A natural server exit closes stdout (settling this pump) BEFORE Bun sets
    // `proc.exitCode` and fans out `proc.exited` — by MORE than one microtask
    // (EOF can beat the exit by a full macrotask hop). Judging liveness with no
    // yield therefore misfires the "stdout pump died" warn on EVERY normal
    // shutdown. Run the SAME bounded exit-settlement race the Bun spawner and
    // the MCP stdio transport use (shared {@link PUMP_DEATH_EXIT_GRACE_MS})
    // before judging: a natural/killed exit wins in sub-millisecond and stays
    // quiet; a genuine wedge (stdout closed, server alive forever) times out
    // and still warns.
    if (typeof proc.exitCode !== "number" && !proc.killed) {
      await Promise.race([
        proc.exited.catch(() => undefined),
        new Promise<void>((r) => {
          setTimeout(r, PUMP_DEATH_EXIT_GRACE_MS).unref?.()
        }),
      ])
    }
    // A pump that ends during a deliberate stop() or after process death is
    // routine — stop()/watchExit() already fail the pending set. Otherwise the
    // read channel died while the server process still LIVES: the client is
    // half-dead and every pending + future request would silently burn its full
    // `requestTimeoutMs`. Mirror send()'s warn and propagate the same
    // exit/fail-pending the process-death path takes. A clean early EOF and a
    // stream error are the same defect from the caller's view — both land here.
    if (this.ports.isStopped() || this.exited || proc.exitCode !== null || proc.killed) {
      logger.debug("lsp: stdout pump ended", { error: detail })
      return
    }
    logger.warn("lsp: stdout pump died while the server process is alive", { error: detail })
    this.exited = true
    this.ports.failAllPending(new Error(`LSP transport read channel closed: ${detail}`))
  }

  /** Background drain of the server's stderr. A verbose server (tsserver /
   *  Pyright debug logs) that fills the OS stderr pipe would block on its next
   *  stderr write, stop answering stdout JSON-RPC, and hang every pending
   *  request to timeout. Reading to completion keeps the pipe empty; bytes are
   *  discarded (deadlock guard, not a diagnostics sink). Tolerant of a test
   *  subclass whose `proc` has no stderr (same guard as {@link pumpStdout}). */
  private async drainStderr(): Promise<void> {
    const stderr = this.proc?.stderr
    if (!stderr || typeof stderr === "number") return
    const decoder = new TextDecoder()
    try {
      for await (const chunk of stderr) {
        // Keep the pipe empty (deadlock guard) AND retain a bounded tail: when the
        // server dies, the reason it prints here (crash stack / OOM notice) is the
        // ONLY diagnosable signal — formerly discarded. Cap so a verbose server
        // (pyright debug output) can't grow it unbounded.
        const text = decoder.decode(chunk as Uint8Array, { stream: true })
        if (text.length > 0)
          this.stderrTail = sliceTailWholeChars(this.stderrTail + text, STDERR_TAIL_MAX)
      }
    } catch (e) {
      logger.debug("lsp: stderr drain ended", { error: errMessage(e) })
    }
  }

  private watchExit(onExit: () => void | Promise<void>): void {
    const proc = this.proc
    if (!proc) return
    void proc.exited.then(onExit).catch(onExit)
  }
}
