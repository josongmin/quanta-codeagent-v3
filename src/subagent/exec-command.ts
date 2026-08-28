/**
 * `exec_command` runtime owner for the six-tool subagent surface.
 *
 * Kept separate from `handlers-6.ts`: process lifetime, PTY retention, and
 * kill escalation form one cohesive boundary, while the remaining handlers
 * only consume the `PtyTable` port. The public facade re-exports this module
 * to preserve the established `@/subagent` API.
 */

import type { Subprocess } from "bun"
import { abortableSleep, errMessage, scrubEnvFrom } from "@/shared"
import { legacyKillHandle, type MakeProcKill, type ProcKillHandle } from "./exec-kill"
import type { ExecCommandInput, ExecCommandOutput } from "./tools-6"

/** Bound on concurrent long-running PTYs retained across tool calls. */
export const MAX_PTY = 32

/** Startup grace before a still-running pty is retained for write_stdin. */
const PTY_ATTACH_GRACE_MS = 75

const errExec = (message: string, cause?: string): ExecCommandOutput =>
  cause !== undefined ? { kind: "error", message, cause } : { kind: "error", message }

interface PtySlot {
  proc: Subprocess<"pipe", "pipe", "pipe">
  startedAt: number
  command: string
  exited: Promise<number>
  killHandle?: ProcKillHandle
}

/** Live PTYs keyed by pid. Session shutdown calls {@link closeAll}. */
export class PtyTable {
  private readonly slots = new Map<number, PtySlot>()

  size(): number {
    return this.slots.size
  }

  has(pid: number): boolean {
    return this.slots.has(pid)
  }

  get(pid: number): PtySlot | undefined {
    return this.slots.get(pid)
  }

  set(pid: number, slot: PtySlot): void {
    this.slots.set(pid, slot)
  }

  delete(pid: number): boolean {
    return this.slots.delete(pid)
  }

  snapshot(): ReadonlyArray<{ pid: number; command: string; startedAt: number }> {
    const out: Array<{ pid: number; command: string; startedAt: number }> = []
    for (const [pid, s] of this.slots.entries()) {
      out.push({ pid, command: s.command, startedAt: s.startedAt })
    }
    return out
  }

  closeAll(): void {
    for (const [, s] of this.slots) {
      try {
        const killHandle = s.killHandle ?? legacyKillHandle(s.proc)
        killHandle.kill()
      } catch {
        // already dead — ignore
      }
    }
    this.slots.clear()
  }
}

interface CwdJailPort {
  readonly resolve: (requested: string, jailRoot: string) => string
  readonly jailRoot: string
}

interface ExecCommandDeps {
  ptyTable?: PtyTable
  cwdJail?: CwdJailPort
  makeKill?: MakeProcKill
}

interface StreamPump {
  readonly done: Promise<void>
  snapshot(): string
  stopCapturing(): string
}

const concatChunks = (chunks: readonly Uint8Array[]): Uint8Array => {
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** Drain retained PTY output continuously so its OS pipes cannot deadlock. */
const createStreamPump = (stream: ReadableStream<Uint8Array>): StreamPump => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let capture = true
  const done = (async (): Promise<void> => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        if (capture && value !== undefined && value.byteLength > 0) chunks.push(value)
      }
    } catch {
      // Kill/abort/pipe-close can race the reader; capture remains best-effort.
    } finally {
      reader.releaseLock()
    }
  })()
  const decode = (): string => new TextDecoder("utf-8").decode(concatChunks(chunks))
  return {
    done,
    snapshot: decode,
    stopCapturing(): string {
      const text = decode()
      capture = false
      chunks.length = 0
      return text
    },
  }
}

type PreparedExec =
  | { readonly kind: "error"; readonly result: ExecCommandOutput }
  | {
      readonly kind: "ready"
      readonly proc: Subprocess<"pipe", "pipe", "pipe">
      readonly table: PtyTable | undefined
      readonly wantPty: boolean
    }

/** Validate resource/jail preconditions, then spawn the exact validated cwd. */
const prepareExec = (input: ExecCommandInput, deps: ExecCommandDeps): PreparedExec => {
  const table = deps.ptyTable
  const wantPty = input.pty === true
  if (wantPty && table === undefined) {
    return {
      kind: "error",
      result: errExec(
        "exec_command requested pty:true but no PTY table is wired (write_stdin/close_agent would be unreachable).",
        "pty_unsupported",
      ),
    }
  }
  if (wantPty && table !== undefined && table.size() >= MAX_PTY) {
    return {
      kind: "error",
      result: errExec(`PTY cap exceeded: ${MAX_PTY} concurrent ptys already open.`, "pty_cap"),
    }
  }

  let cwd = input.cwd
  if (deps.cwdJail !== undefined) {
    try {
      cwd = deps.cwdJail.resolve(input.cwd, deps.cwdJail.jailRoot)
    } catch (e: unknown) {
      return {
        kind: "error",
        result: errExec(
          `Refusing to run in cwd outside the workspace: ${errMessage(e)}`,
          "cwd_outside_workspace",
        ),
      }
    }
  }

  // SCRUBBED, and never inherit-by-omission. The command below is
  // `bash -lc <input.command>` with the command text supplied by the MODEL, and
  // this env was built two ways that are both the shapes the exec-cluster ban
  // forbids: absent ⇒ the `env` key was omitted and Bun handed over
  // `process.env` wholesale; present ⇒ `{ ...process.env, ...input.env }` raw.
  // Either way every `*_API_KEY` this process holds reached a process whose
  // argv the model chose. The ban never covered this file — its scan list named
  // five cluster files and this was not one of them.
  //
  // `scrubEnvFrom` is allowlist-based, so the child gets what a shell
  // legitimately needs and nothing else; the caller's own `input.env` still
  // layers on top, which is the only part that was ever intentional. The bag is
  // passed EXPLICITLY: the scrubber is a pure `@/shared` leaf (that slice may
  // not read `process.env`), and this file is one of the two the subagent
  // slice's `envAllowFiles` carve-out admits precisely because propagating env
  // to a spawned child is its job.
  const env: Record<string, string | undefined> = {
    ...scrubEnvFrom(process.env),
    ...(input.env ?? {}),
  }
  try {
    const proc = Bun.spawn(["bash", "-lc", input.command], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    }) as Subprocess<"pipe", "pipe", "pipe">
    return { kind: "ready", proc, table, wantPty }
  } catch (e: unknown) {
    return {
      kind: "error",
      result: errExec(`Failed to spawn command: ${errMessage(e)}`, "spawn_error"),
    }
  }
}

interface ExecutionState {
  timedOut: boolean
  aborted: boolean
}

const terminationResult = (
  input: ExecCommandInput,
  state: ExecutionState,
): ExecCommandOutput | undefined => {
  if (state.timedOut) return errExec(`Command timed out after ${input.timeoutMs}ms`, "timeout")
  if (state.aborted) return errExec("Command aborted", "abort")
  return undefined
}

const runBufferedExec = async (
  proc: Subprocess<"pipe", "pipe", "pipe">,
  input: ExecCommandInput,
  state: ExecutionState,
): Promise<ExecCommandOutput> => {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited as Promise<number>,
  ])
  return (
    terminationResult(input, state) ?? {
      kind: "success",
      exitCode,
      stdout,
      stderr,
    }
  )
}

const runPtyExec = async (
  proc: Subprocess<"pipe", "pipe", "pipe">,
  table: PtyTable,
  input: ExecCommandInput,
  killHandle: ProcKillHandle,
  state: ExecutionState,
  signal: AbortSignal | undefined,
): Promise<ExecCommandOutput> => {
  const stdoutPump = createStreamPump(proc.stdout as ReadableStream<Uint8Array>)
  const stderrPump = createStreamPump(proc.stderr as ReadableStream<Uint8Array>)
  const winner = await Promise.race([
    (proc.exited as Promise<number>).then(() => "exited" as const),
    // The grace race must settle on caller cancellation too; a raw timer here
    // would leave an aborted turn parked until the full attach window elapsed.
    abortableSleep(PTY_ATTACH_GRACE_MS, signal)
      .then(() => "attach" as const)
      .catch(() => "cancelled" as const),
  ])
  // Bun can publish `exitCode` before the `proc.exited` promise's subscribers
  // run. Re-check the authoritative process state before retaining: otherwise
  // a short-lived command that has already exited can be misclassified as a
  // live PTY when the grace timer wins that fanout race.
  if (
    winner === "attach" &&
    !state.timedOut &&
    !state.aborted &&
    typeof proc.exitCode !== "number"
  ) {
    const stdout = stdoutPump.stopCapturing()
    const stderr = stderrPump.stopCapturing()
    table.set(proc.pid, {
      proc,
      startedAt: Date.now(),
      command: input.command,
      exited: proc.exited as Promise<number>,
      killHandle,
    })
    void (proc.exited as Promise<number>).finally(() => table.delete(proc.pid))
    return { kind: "success", exitCode: -1, stdout, stderr, pid: proc.pid }
  }

  const exitCode = await (proc.exited as Promise<number>)
  await Promise.all([stdoutPump.done, stderrPump.done])
  return (
    terminationResult(input, state) ?? {
      kind: "success",
      exitCode,
      stdout: stdoutPump.snapshot(),
      stderr: stderrPump.snapshot(),
    }
  )
}

/** Execute a shell command, optionally retain a live PTY, and always disarm cleanup. */
export const handleExecCommand = async (
  input: ExecCommandInput,
  deps: ExecCommandDeps = {},
  signal?: AbortSignal,
): Promise<ExecCommandOutput> => {
  const prepared = prepareExec(input, deps)
  if (prepared.kind === "error") return prepared.result

  const { proc, table, wantPty } = prepared
  const killHandle = deps.makeKill?.(proc) ?? legacyKillHandle(proc)
  const state: ExecutionState = { timedOut: false, aborted: false }
  const timer = setTimeout(() => {
    state.timedOut = true
    killHandle.kill()
  }, input.timeoutMs)
  const onAbort = () => {
    state.aborted = true
    killHandle.kill()
  }
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    return wantPty && table !== undefined
      ? await runPtyExec(proc, table, input, killHandle, state, signal)
      : await runBufferedExec(proc, input, state)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
    killHandle.disarm()
  }
}
