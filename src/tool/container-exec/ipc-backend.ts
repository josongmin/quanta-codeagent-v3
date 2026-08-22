/**
 * IPC-bridge {@link ContainerExec} (TB21-06 TC-1a — the impl-B IPC bridge). The cross-language transport: a
 * brain process (this TS side) decides WHAT command to run; a separate hands process (e.g. a
 * Python shim holding a container-orchestrator `environment`) actually runs it and returns the
 * result. They speak a line-delimited JSON protocol over an injected duplex — backend-agnostic
 * (the hands side abstracts local-Docker / Daytona / E2B), so NO orchestrator/harness specifics
 * leak here (ownership boundary). This is the sibling of `dockerContainerExec` (the standalone
 * docker-exec path); the tool sees only the {@link ContainerExec} port and is blind to which.
 *
 * Wire protocol (one JSON object per line, `\n`-framed):
 *   →  `{ id, type: "exec", command }`            request: run `command` in the bound container
 *   →  `{ id, type: "cancel" }`                   best-effort abort of an in-flight request
 *   ←  `{ id, type: "exec_result", stdout, stderr, code }`   stdout/stderr nullable; `code` = exit
 *   ←  `{ id, type: "error", message }`           the hands side could not run it (transport error)
 *
 * A non-zero `code` is a NORMAL result (the command ran) — it RESOLVES, never rejects (the tool
 * surfaces the exit code). Only a transport `error` (or a closed duplex) rejects, which the tool
 * maps to a typed `ok:false`. NO listener leak: the abort listener is removed when the call settles.
 */
import { toError } from "@/shared"
import type { ContainerExec, ContainerExecResult } from "./port"

/** Injected line-duplex: `write` one JSON line (no trailing newline — the impl frames it); `lines`
 *  yields inbound JSON lines (already split on `\n`). A real wiring backs this with the hands
 *  process's stdin/stdout; tests back it with an in-memory pair. */
export interface JsonLineDuplex {
  write(line: string): void
  readonly lines: AsyncIterable<string>
}

type Pending = {
  resolve: (r: ContainerExecResult) => void
  reject: (e: Error) => void
}

/** Build a {@link ContainerExec} over a JSON-line duplex to the hands process. Starts a read loop
 *  that correlates responses to requests by `id`; the loop ends (and rejects every still-pending
 *  call) when `lines` completes or throws — a closed transport must never hang a caller forever. */
export const containerExecOverIpc = (duplex: JsonLineDuplex): ContainerExec => {
  let nextId = 0
  const pending = new Map<number, Pending>()

  // Latched once the read loop ends (close or throw). A NEW exec issued after this must reject
  // synchronously — the loop is dead and would never settle it, so awaiting would hang forever.
  let closed: Error | null = null
  const settleAll = (err: Error): void => {
    closed = err
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  }

  /** Parse one inbound line to a frame addressed to a known pending id, or null (skip). */
  const parseFrame = (line: string): { p: Pending; m: Record<string, unknown> } | null => {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      return null // malformed line — skip, never crash the loop or settle the wrong call
    }
    if (typeof msg !== "object" || msg === null) return null
    const m = msg as Record<string, unknown>
    if (typeof m.id !== "number") return null
    const p = pending.get(m.id)
    return p ? { p, m } : null // unknown / already-settled id — drop
  }

  const toResult = (m: Record<string, unknown>): ContainerExecResult => ({
    stdout: typeof m.stdout === "string" ? m.stdout : null,
    stderr: typeof m.stderr === "string" ? m.stderr : null,
    code: typeof m.code === "number" ? m.code : -1,
  })

  const route = (line: string): void => {
    const frame = parseFrame(line)
    if (!frame) return
    const { p, m } = frame
    if (m.type === "exec_result") p.resolve(toResult(m))
    else if (m.type === "error") {
      p.reject(new Error(typeof m.message === "string" ? m.message : "ipc exec error"))
    }
    // any other type for a known id: ignore (do not settle on an unrecognized frame)
  }

  // Read loop — one per bridge. Rejects all in-flight calls when the duplex ends (close or throw).
  ;(async () => {
    try {
      for await (const line of duplex.lines) route(line)
      settleAll(new Error("ipc transport closed"))
    } catch (e) {
      settleAll(toError(e))
    }
  })()

  return {
    exec(command: string, signal?: AbortSignal, timeoutMs?: number): Promise<ContainerExecResult> {
      if (closed) return Promise.reject(closed) // transport already dead — never register a never-settled call
      // Already-aborted BEFORE start: reject immediately and send NO frame. Sending `exec` would run a
      // command the caller already abandoned (the hands side has never seen this id, so a `cancel`
      // frame is a no-op — it cannot recall an exec we have not yet sent). No id is consumed, no
      // pending entry is registered, no listener is attached. Mirrors tool.ts's pre-start guard, but
      // since the export rejects (the tool maps that to ok:false), surface a typed AbortError.
      if (signal?.aborted) {
        const e = new Error("aborted before start")
        e.name = "AbortError"
        return Promise.reject(e)
      }
      const id = nextId++
      return new Promise<ContainerExecResult>((resolve, reject) => {
        // Settle wrapper removes the abort listener + the pending entry + the deadline timer on
        // EVERY exit path (resolve OR reject) so a long-lived signal never accumulates listeners
        // (R7 leak lesson) and a settled call never fires a stray timeout.
        let deadline: ReturnType<typeof setTimeout> | undefined
        const done =
          <T>(fn: (v: T) => void) =>
          (v: T) => {
            pending.delete(id)
            signal?.removeEventListener("abort", onAbort)
            if (deadline !== undefined) clearTimeout(deadline)
            fn(v)
          }
        const resolveClean = done(resolve)
        const rejectClean = done(reject)
        // A failing transport `write` must route through `done` (clean pending + listener) and reject
        // ONCE — a raw throw out of the executor would reject but leak the entry + listener.
        const safeWrite = (line: string): void => {
          try {
            duplex.write(line)
          } catch (e) {
            rejectClean(toError(e))
          }
        }
        const onAbort = () => safeWrite(JSON.stringify({ id, type: "cancel" }))
        pending.set(id, { resolve: resolveClean, reject: rejectClean })
        if (signal) {
          if (signal.aborted) onAbort()
          else signal.addEventListener("abort", onAbort, { once: true })
        }
        // B1 (RFC jul-3) HOST-SYNTHESIZED deadline: the bridge is completion-only (the
        // orchestrator's env-exec returns only on completion; a cancelled exec yields
        // `error("cancelled")`, never a partial result — serve-loop contract), so waiting for the hands' terminal frame after a
        // deadline would block the turn for the full command duration. On expiry we best-effort
        // `cancel` (frees the hands slot / kills the in-container process where the env supports it)
        // and RESOLVE immediately with a typed timeout result (code 124 — the `timeout(1)` kill
        // convention — and NO partial output, which this transport cannot produce). The pending
        // entry is deleted by the settle wrapper, so the hands' late terminal frame for this id is
        // dropped by `parseFrame` (unknown id) — structurally race-free.
        if (timeoutMs !== undefined && timeoutMs > 0) {
          deadline = setTimeout(() => {
            safeWrite(JSON.stringify({ id, type: "cancel" }))
            resolveClean({ stdout: null, stderr: null, code: 124, timedOut: true })
          }, timeoutMs)
        }
        // Abort: send `cancel` and KEEP awaiting — the hands side replies with a TERMINAL frame for
        // this id (an `error` "cancelled", or a partial `exec_result` if the env yields one), so the
        // call always settles (never hangs). Cross-end cancel contract; see the Python serve loop.
        // (Deliberately different from the DEADLINE path above, which resolves without waiting:
        // an abort is the caller tearing the turn down — a late frame is harmless; a deadline is a
        // liveness bound — the turn must get its result NOW.)
        safeWrite(JSON.stringify({ id, type: "exec", command }))
      })
    },
  }
}
