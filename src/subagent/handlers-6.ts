/**
 * Handlers for the six-tool standard (ADR-0041).
 *
 * The frozen contract lives in `./tools-6.ts`. This module supplies the
 * runtime implementation — kept on a separate slice so the contract surface
 * (pure zod schemas) stays import-light.
 *
 * SOTA reference (Codex `terminalManager`):
 *   - `createOrAttach` is idempotent by (conversationId, sessionId) — we model
 *     the same with a per-handler `ProcessTable` keyed by pid.
 *   - `getSnapshot` is checkpoint-friendly for turn boundaries — `snapshot()`
 *     exposes the live set so the agent loop can dump it into session-state.
 *   - `exec_command_{begin,end,output_delta}` events — surfaced via the
 *     existing tool `progress` channel from the caller's perspective; the
 *     handlers themselves return final discriminated results only.
 *
 * Resource hygiene:
 *   - Hard cap on concurrent PTYs (`MAX_PTY`); a `spawn` over the cap returns
 *     a structured error instead of OOM-spawning unbounded children.
 *   - On `close_agent` we forceStop the runner AND, if a pty handle is owned
 *     by the same id, kill it too — no orphan processes.
 *
 * Slice isolation: this module imports ONLY zod, the contract module, and
 * `./registry` (`TaskRegistry`/`TaskOwnerToken`) + `./types` (`SubagentRunner`).
 * It does NOT import `@/agent`; the recursive runner is injected.
 */
import type { Subprocess } from "bun"
import { errMessage } from "@/shared"
// Reuse the foreground `agent` tool's PROVEN continue_from lineage gate +
// checkpoint-path builder + per-registry owners ledger (T04 — no cross-lineage
// disclosure). The ledger is keyed by TaskRegistry identity, and the 6-tool
// router shares the SAME registry as the `agent` tool, so a task stamped by one
// is gated identically by the other (single SSOT for the security invariant).
import {
  buildCheckpointPath,
  loadContinueFromForOwner,
  ownersForRegistry,
  ROOT_LINEAGE,
} from "./agent-tool"
import type { TaskOwnerToken, TaskRegistry } from "./registry"
import type {
  CloseAgentInput,
  CloseAgentOutput,
  ExecCommandInput,
  ExecCommandOutput,
  SendInputInput,
  SendInputOutput,
  SpawnAgentInput,
  SpawnAgentOutput,
  WaitAgentInput,
  WaitAgentOutput,
  WriteStdinInput,
  WriteStdinOutput,
} from "./tools-6"
import type { SubagentRequest, SubagentRunner } from "./types"

/** Bound on concurrent long-running PTYs we will keep alive across calls.
 *  A normal agent run uses 0–2; this cap exists to defend against runaway
 *  spawn_loops (LLM hallucination / runaway tool). Hits return a structured
 *  error with cause:"pty_cap". */
export const MAX_PTY = 32

/** (d) Built-in recursion-depth ceiling for `spawn_agent` — applied when
 *  NEITHER `input.maxDepth` NOR `deps.maxDepth` is supplied, so the fan-out
 *  path is never fail-open unbounded. Mirrors `subagent-runner`'s
 *  `DEFAULT_MAX_DEPTH` (kept as a local literal to honor the slice fence —
 *  handlers-6 imports no `@/agent` code). A child whose depth exceeds this is
 *  rejected with `cause:"depth_exceeded"`. */
export const DEFAULT_MAX_DEPTH = 3

/** Soft default for `wait_agent` blocking timeouts. Mirrors `task_output`'s
 *  30s upper bound; callers can override via `timeoutMs`. */
const DEFAULT_WAIT_AGENT_TIMEOUT_MS = 30_000

/**
 * B2 — closed-port bound on the caller-supplied blocking timeout.
 *
 * `wait_agent` / `task_output(block:true)` previously accepted ANY positive int
 * (`tools-6.ts WaitAgentInputSchema.timeoutMs`) and applied it verbatim, with a
 * hardcoded 30s default. That left two holes: (1) no default policy seam, and
 * (2) an unbounded per-call override (a hostile / hallucinated `timeoutMs:
 * 999_999_999` pins a loop slot for ~11 days). This policy clamps the supplied
 * value into `[minMs, maxMs]` (CLAMP, not reject — robustness over rigidity)
 * and supplies `defaultMs` when omitted. Injected via the deps struct (closed
 * port): handlers never read a global.
 */
export interface WaitTimeoutPolicy {
  /** Floor for the effective timeout. A supplied value below this is raised. */
  readonly minMs: number
  /** Ceiling for the effective timeout. A supplied value above this is lowered. */
  readonly maxMs: number
  /** Effective timeout when the caller omits `timeoutMs`. */
  readonly defaultMs: number
}

/**
 * The default policy — byte-identical to the pre-B2 behavior: omitted ⇒ 30s.
 * `maxMs` is deliberately generous (1h) so every pre-B2 caller's override stays
 * inside the band (no existing call is clamped). `minMs` is 1ms (the schema
 * already rejects ≤0), so the only callers it affects are pathological ones.
 */
export const DEFAULT_WAIT_TIMEOUT_POLICY: WaitTimeoutPolicy = {
  minMs: 1,
  maxMs: 3_600_000,
  defaultMs: DEFAULT_WAIT_AGENT_TIMEOUT_MS,
}

/**
 * Resolve the effective blocking timeout. Pure + total: when `requested` is
 * omitted ⇒ `policy.defaultMs`; otherwise the requested value clamped into
 * `[minMs, maxMs]`. A degenerate policy (`minMs > maxMs`) collapses to `maxMs`
 * (the ceiling wins — never returns a value above the hard ceiling). With
 * {@link DEFAULT_WAIT_TIMEOUT_POLICY} and any pre-B2 caller this is the
 * identity on the requested value (or 30s when omitted).
 */
export const clampWaitTimeout = (
  policy: WaitTimeoutPolicy,
  requested: number | undefined,
): number => {
  const want = requested ?? policy.defaultMs
  const raised = Math.max(want, policy.minMs)
  return Math.min(raised, policy.maxMs)
}
/** Startup grace for `exec_command({pty:true})`: if the child is still alive
 *  after this window, we attach it into the PTY table and return its pid
 *  instead of blocking until natural exit. Short-lived commands that exit
 *  inside the window keep the old fully-buffered synchronous behavior. */
const PTY_ATTACH_GRACE_MS = 75

/** Per-tool error helpers — guarantees the discriminator + message shape that
 *  matches the frozen contract (`ErrorShape` in tools-6.ts). */
const errExec = (message: string, cause?: string): ExecCommandOutput =>
  cause !== undefined ? { kind: "error", message, cause } : { kind: "error", message }
const errWrite = (message: string, cause?: string): WriteStdinOutput =>
  cause !== undefined ? { kind: "error", message, cause } : { kind: "error", message }
const errSpawn = (message: string, cause?: string): SpawnAgentOutput =>
  cause !== undefined ? { kind: "error", message, cause } : { kind: "error", message }
const errWait = (message: string, cause?: string): WaitAgentOutput =>
  cause !== undefined ? { kind: "error", message, cause } : { kind: "error", message }
const errClose = (message: string, cause?: string): CloseAgentOutput =>
  cause !== undefined ? { kind: "error", message, cause } : { kind: "error", message }
const errSendInput = (message: string, cause?: string): SendInputOutput =>
  cause !== undefined ? { kind: "error", message, cause } : { kind: "error", message }

// ─── PTY table — Bun.spawn handles that exec_command kept open ─────────────

/** A live child process handle, keyed by pid, so subsequent `write_stdin`
 *  calls can route to the right child without re-spawning. */
interface PtySlot {
  proc: Subprocess<"pipe", "pipe", "pipe">
  // Used for traceability + reuse decisions (Codex `getSnapshot`).
  startedAt: number
  command: string
  /** Resolved when the child exits naturally. We hold this so `close_agent`
   *  can await final exit after issuing kill. */
  exited: Promise<number>
}

/** Internal pty registry. Module-scoped (one process worth of state) — the
 *  agent runs a single Bun process; the registry is the source of truth for
 *  the host's living children. Exposed for tests via {@link snapshotPtyTable}. */
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

  /** Codex `getSnapshot` analogue — readable view for turn-checkpoint dumps. */
  snapshot(): ReadonlyArray<{ pid: number; command: string; startedAt: number }> {
    const out: Array<{ pid: number; command: string; startedAt: number }> = []
    for (const [pid, s] of this.slots.entries()) {
      out.push({ pid, command: s.command, startedAt: s.startedAt })
    }
    return out
  }

  /** Force-kill every live process and clear the table. Idempotent. Used by
   *  test cleanup; production sessions call this from their shutdown path. */
  closeAll(): void {
    for (const [, s] of this.slots) {
      try {
        s.proc.kill()
      } catch {
        // already dead — ignore
      }
    }
    this.slots.clear()
  }
}

// ─── exec_command ──────────────────────────────────────────────────────────

/** Injected path-jail port so `exec_command`'s model-supplied `cwd` cannot
 *  escape the session workspace. Structurally the `resolveJailed(requested,
 *  jailRoot)` contract (`@/storage`): returns the resolved absolute path,
 *  THROWS on a jail escape. Injected (closed port) so this slice keeps its
 *  fence — handlers-6 imports no storage code; the composition root wires the
 *  real `resolveJailed`. Absent ⇒ NO jail (byte-identical legacy path) — the
 *  port is opt-in so existing callers that never wired a workspace root stay
 *  unchanged. Present ⇒ a cwd outside `jailRoot` is rejected fail-closed with
 *  `cause:"cwd_outside_workspace"` BEFORE any process is spawned. */
interface CwdJailPort {
  /** Resolve `requested` against `jailRoot`; throw when it escapes the jail. */
  readonly resolve: (requested: string, jailRoot: string) => string
  /** The workspace root the child `cwd` is confined to (the session cwd). */
  readonly jailRoot: string
}

interface ExecCommandDeps {
  ptyTable?: PtyTable
  /** Confine `input.cwd` to the session workspace before spawning. Absent ⇒
   *  no jail (legacy). See {@link CwdJailPort}. */
  cwdJail?: CwdJailPort
}

interface StreamPump {
  readonly done: Promise<void>
  snapshot(): string
  stopCapturing(): string
}

/** Drain a subprocess pipe continuously so long-lived PTYs cannot deadlock on
 *  a full stdout/stderr buffer. While capture is enabled we retain bytes for
 *  the eventual tool result; after an attached PTY returns we discard future
 *  bytes but keep draining until the child exits. */
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
      // Kill/abort/pipe-close can race the reader; stdout/stderr capture is
      // best-effort and must not throw past the handler.
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

/**
 * `exec_command` — spawn a shell command via `Bun.spawn` with piped stdio.
 * When `pty:true` is requested AND the child is still running at return time,
 * the handle is held in the {@link PtyTable} so subsequent `write_stdin`
 * calls can reach it; the child's pid is returned to the model.
 *
 * Failure modes (all returned as `{kind:"error", ...}` — never thrown):
 *   - spawn failure (bad command / bad cwd / ENOENT)        → `cause:"spawn_error"`
 *   - timeout (kills the child, returns timed-out result)   → `cause:"timeout"`
 *   - pty cap exceeded                                      → `cause:"pty_cap"`
 *   - abort via ctx signal (caller-cancelled mid-exec)      → `cause:"abort"`
 */
export const handleExecCommand = async (
  input: ExecCommandInput,
  deps: ExecCommandDeps = {},
  signal?: AbortSignal,
): Promise<ExecCommandOutput> => {
  const table = deps.ptyTable
  const wantPty = input.pty === true

  // (e) A `pty:true` request with NO ptyTable wired would otherwise fall
  // through to the synchronous branch and run an UNTRACKED child — the host
  // could never `write_stdin` / `close_agent` it, and the cleanup path would
  // never see it. Fail-closed with a structured error instead of silently
  // degrading to a non-PTY run.
  if (wantPty && table === undefined) {
    return errExec(
      "exec_command requested pty:true but no PTY table is wired (write_stdin/close_agent would be unreachable).",
      "pty_unsupported",
    )
  }

  if (wantPty && table !== undefined && table.size() >= MAX_PTY) {
    return errExec(`PTY cap exceeded: ${MAX_PTY} concurrent ptys already open.`, "pty_cap")
  }

  // (c) Path jail — confine the model-supplied cwd to the session workspace
  // BEFORE spawning. When the port is wired, an escaping cwd is rejected
  // fail-closed (the jail's `resolve` throws). Absent ⇒ no jail (legacy).
  //
  // Hole-fix: the jail must determine the cwd the child ACTUALLY runs in, not
  // merely validate-then-discard. A RELATIVE `input.cwd` (e.g. "../escape")
  // resolves against the jailRoot here, but Bun.spawn resolves a relative cwd
  // against `process.cwd()` — so when process.cwd() != jailRoot the raw value
  // would execute OUTSIDE the workspace even after passing the check. We bind
  // the spawn `cwd` to the JAILED absolute path so the validated path is the
  // executed path. No jail wired ⇒ raw `input.cwd` (byte-identical legacy).
  let spawnCwd: string = input.cwd
  if (deps.cwdJail !== undefined) {
    try {
      spawnCwd = deps.cwdJail.resolve(input.cwd, deps.cwdJail.jailRoot)
    } catch (e: unknown) {
      return errExec(
        `Refusing to run in cwd outside the workspace: ${errMessage(e)}`,
        "cwd_outside_workspace",
      )
    }
  }

  // Build env: only set when caller supplied an overlay (so the default Bun
  // semantics — inherit current env — applies on the no-overlay path). When
  // a record is passed we MERGE onto process.env so unrelated vars survive.
  const env =
    input.env !== undefined
      ? ({ ...(process.env as Record<string, string | undefined>), ...input.env } as Record<
          string,
          string | undefined
        >)
      : undefined

  let proc: Subprocess<"pipe", "pipe", "pipe">
  try {
    proc = Bun.spawn(["bash", "-lc", input.command], {
      cwd: spawnCwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      ...(env !== undefined ? { env } : {}),
    }) as Subprocess<"pipe", "pipe", "pipe">
  } catch (e: unknown) {
    const msg = errMessage(e)
    return errExec(`Failed to spawn command: ${msg}`, "spawn_error")
  }

  let timedOut = false
  let aborted = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      proc.kill()
    } catch {
      // already dead
    }
  }, input.timeoutMs)

  const onAbort = () => {
    aborted = true
    try {
      proc.kill()
    } catch {
      // already dead
    }
  }
  signal?.addEventListener("abort", onAbort, { once: true })

  try {
    if (wantPty && table !== undefined) {
      const stdoutPump = createStreamPump(proc.stdout as ReadableStream<Uint8Array>)
      const stderrPump = createStreamPump(proc.stderr as ReadableStream<Uint8Array>)
      const winner = await Promise.race([
        (proc.exited as Promise<number>).then(() => "exited" as const),
        new Promise<"attach">((resolve) =>
          setTimeout(() => resolve("attach"), PTY_ATTACH_GRACE_MS),
        ),
      ])

      if (winner === "attach" && !timedOut && !aborted) {
        const stdoutText = stdoutPump.stopCapturing()
        const stderrText = stderrPump.stopCapturing()
        table.set(proc.pid, {
          proc,
          startedAt: Date.now(),
          command: input.command,
          exited: proc.exited as Promise<number>,
        })
        void (proc.exited as Promise<number>).finally(() => {
          table.delete(proc.pid)
        })
        return {
          kind: "success",
          exitCode: -1,
          stdout: stdoutText,
          stderr: stderrText,
          pid: proc.pid,
        }
      }

      const exitCode = await (proc.exited as Promise<number>)
      await Promise.all([stdoutPump.done, stderrPump.done])
      if (timedOut) {
        return errExec(`Command timed out after ${input.timeoutMs}ms`, "timeout")
      }
      if (aborted) {
        return errExec("Command aborted", "abort")
      }
      return {
        kind: "success",
        exitCode,
        stdout: stdoutPump.snapshot(),
        stderr: stderrPump.snapshot(),
      }
    }

    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited as Promise<number>,
    ])

    if (timedOut) {
      return errExec(`Command timed out after ${input.timeoutMs}ms`, "timeout")
    }
    if (aborted) {
      return errExec("Command aborted", "abort")
    }

    return { kind: "success", exitCode, stdout: stdoutText, stderr: stderrText }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

// ─── write_stdin ───────────────────────────────────────────────────────────

interface WriteStdinDeps {
  ptyTable: PtyTable
}

/** Write to an existing PTY's stdin. Returns `bytesWritten` or a structured
 *  error if the pid is unknown / the pipe is closed / the encode fails. */
export const handleWriteStdin = async (
  input: WriteStdinInput,
  deps: WriteStdinDeps,
): Promise<WriteStdinOutput> => {
  const slot = deps.ptyTable.get(input.pid)
  if (slot === undefined) {
    return errWrite(`No live PTY found with pid ${input.pid}`, "pid_unknown")
  }
  const data = input.appendNewline === true ? `${input.data}\n` : input.data
  const bytes = new TextEncoder().encode(data)

  // `proc.stdin` is a FileSink in Bun. Writes are sync up to the OS buffer,
  // but on a closed pipe they throw — we catch and return a structured error.
  const stdin = slot.proc.stdin
  if (stdin === null) {
    return errWrite(`PTY pid ${input.pid} has no stdin pipe`, "no_stdin")
  }
  try {
    stdin.write(bytes)
    await stdin.flush()
  } catch (e: unknown) {
    const msg = errMessage(e)
    return errWrite(`Failed to write to PTY pid ${input.pid}: ${msg}`, "write_failed")
  }
  return { kind: "success", bytesWritten: bytes.byteLength }
}

// ─── spawn_agent ───────────────────────────────────────────────────────────

interface SpawnAgentDeps {
  runner: SubagentRunner
  registry: TaskRegistry
  /** When set, applied to spawns whose `maxDepth` exceeds this cap. Used to
   *  thread `AgentToolOptions.maxDepth` through to the same enforcement
   *  point. Absent ⇒ no enforcement here (caller's responsibility). */
  maxDepth?: number
  /** Caller's own current recursion depth, used to compute the child's depth
   *  (parent + 1). Defaults to 0 (root). */
  parentDepth?: number
  /** RFC-04 / ADR-0437 — OPT-IN side-table the spawn path records `{depth,
   *  label}` into so `list_agents` can show richer rows WITHOUT mutating the
   *  frozen `TaskRecord` contract. Absent ⇒ no write (byte-identical spawn
   *  path). Typed structurally (a `set(id,{depth,label})` method) so this slice
   *  does not depend on the concrete `AgentMetaRegistry` class import shape.
   *  Optional `delete` lets the spawn path drop the entry when the child
   *  settles so the side-table does not grow unbounded; a `{set}`-only stub
   *  (older host wiring / tests) is still accepted and simply skips cleanup. */
  agentMeta?: {
    set(agentId: string, meta: { depth: number; label: string }): void
    delete?(agentId: string): void
  }
  /** B3 — closed-port per-session cap on CONCURRENT running subagents. When
   *  set, `spawn_agent` counts currently-running TaskRegistry records and
   *  rejects (cause:"concurrency_cap") any spawn that would exceed it. Absent
   *  ⇒ UNLIMITED (opt-in): the default preserves every existing test (which
   *  spawns without a cap) byte-for-byte. The value comes from deps/config,
   *  never an inlined constant at the call site. Mirrors the background
   *  scheduler's `DEFAULT_MAX_CONCURRENT` knob (`subagent-background.ts`) but
   *  applies to the FOREGROUND spawn path, which had no cap. */
  maxConcurrent?: number
  /** Parent workspace cwd — used to build the `checkpoint` path
   *  (`<cwd>/.subagent-state/<taskId>.md`). Injected by the dispatch seam from
   *  `ctx.cwd`. Absent ⇒ `checkpoint` is ignored (no path to write to). */
  cwd?: string
  /** The REQUESTING agent's stable lineage label (`ctx.agentLabel`). Gates
   *  `continue_from`: a task stamped by a DIFFERENT lineage is denied before any
   *  finalText read (T04). Absent ⇒ root lineage (`"root"`). */
  requesterLineage?: string
}

/** Count currently-running tasks in the registry — the B3 concurrency gauge.
 *  Reuses the registry's existing `pendingIds()` (running-only snapshot), so
 *  only RUNNING records count against the cap (settled tasks free a slot). */
const countRunning = (registry: TaskRegistry): number => registry.pendingIds().length

/** Spawn a child subagent through the injected runner. Returns the registry
 *  task id which `wait_agent` / `close_agent` / `send_input` reference. The
 *  caller MUST stash the returned ownerToken to authorize a later close. */
export const handleSpawnAgent = async (
  input: SpawnAgentInput,
  deps: SpawnAgentDeps,
): Promise<SpawnAgentOutput & { ownerToken?: TaskOwnerToken }> => {
  const parentDepth = deps.parentDepth ?? 0
  const childDepth = parentDepth + 1
  // (d) Fail-CLOSED depth cap: when neither the per-call nor the dep-level
  // `maxDepth` is supplied, fall back to the built-in `DEFAULT_MAX_DEPTH`
  // (mirrors the runner) instead of running unbounded recursion.
  //
  // Hole-fix: the model-supplied `input.maxDepth` may only TIGHTEN the host
  // ceiling, never RAISE it. The prior `??` chain let a hostile/hallucinated
  // `input.maxDepth:99` override a host `deps.maxDepth:3`, fanning out 33x
  // deeper than the host allowed. We `Math.min` the model request against the
  // host cap (`deps.maxDepth ?? DEFAULT_MAX_DEPTH`) so the effective cap is the
  // STRICTER of the two — the model can shrink its own budget but the host
  // ceiling is binding.
  const hostCap = deps.maxDepth ?? DEFAULT_MAX_DEPTH
  const cap = Math.min(input.max_depth ?? Number.POSITIVE_INFINITY, hostCap)
  if (childDepth > cap) {
    return errSpawn(
      `Subagent denied: depth ${childDepth} exceeds maxDepth ${cap}`,
      "depth_exceeded",
    )
  }

  // B3 — per-session concurrency cap. Counted BEFORE registering this task so
  // the cap is the number of OTHER running children (a cap of N admits exactly
  // N concurrent). Opt-in: an omitted `maxConcurrent` means unbounded fan-out
  // (byte-identical default — the codebase pins this as a deliberate
  // no-regression invariant; a built-in numeric ceiling would be an arbitrary
  // threshold, so concurrency bounding stays caller-configured).
  if (deps.maxConcurrent !== undefined && countRunning(deps.registry) >= deps.maxConcurrent) {
    return errSpawn(
      `Subagent denied: ${deps.maxConcurrent} concurrent subagents already running (cap reached).`,
      "concurrency_cap",
    )
  }

  // T04 — `continue_from` lineage gate (shared with the foreground `agent` tool
  // via the per-registry owners ledger). Resolve BEFORE minting the task so a
  // cross-lineage denial fails the spawn with no side effects.
  // Use the SAME root sentinel as the `agent` tool so an unlabeled root agent's
  // tasks are continue_from-able across BOTH tools (no false ownership denial).
  const lineage = deps.requesterLineage ?? ROOT_LINEAGE
  let priorAttempt: string | undefined
  if (input.continue_from !== undefined) {
    const loaded = loadContinueFromForOwner(
      deps.registry,
      ownersForRegistry(deps.registry),
      input.continue_from,
      lineage,
    )
    if (loaded.kind === "not_owner") {
      return errSpawn(
        `Cannot continue from ${input.continue_from}: it belongs to a different agent lineage (ownership denied).`,
        "ownership_denied",
      )
    }
    if (loaded.kind === "ok") priorAttempt = loaded.text
  }

  const taskId = deps.registry.newId()
  const { abort, ownerToken } = deps.registry.register({
    id: taskId,
    description: input.prompt.slice(0, 120),
    ...(input.agent_type !== undefined ? { agentType: input.agent_type } : {}),
  })
  // T04 — stamp the launching lineage so a later `continue_from` of THIS task
  // from a foreign lineage is denied (mirrors the `agent` tool's recordOwner).
  ownersForRegistry(deps.registry).set(taskId, lineage)

  // RFC-04 — record depth/label into the optional side-table so list_agents can
  // show richer rows. No-op when the host didn't wire one (byte-identical).
  deps.agentMeta?.set(taskId, {
    depth: childDepth,
    label: input.agent_type ?? input.prompt.slice(0, 40),
  })

  // Per-child budget from the optional turn/token caps (parity with the
  // foreground `agent` tool). Built only when at least one is set.
  const budget =
    input.max_turns !== undefined || input.max_tokens !== undefined
      ? {
          ...(input.max_turns !== undefined ? { maxTurns: input.max_turns } : {}),
          ...(input.max_tokens !== undefined ? { maxTokens: input.max_tokens } : {}),
        }
      : undefined

  // `checkpoint` ⇒ tell the child to write interim findings to a parent-readable
  // path. Skipped under `isolation:"worktree"` (parent cannot read inside a
  // throwaway worktree) and when no cwd was injected (nowhere to point it).
  const checkpointPath =
    input.checkpoint === true && input.isolation !== "worktree" && deps.cwd !== undefined
      ? buildCheckpointPath(deps.cwd, taskId)
      : undefined

  const req: SubagentRequest = {
    prompt: input.prompt,
    depth: childDepth,
    signal: abort.signal,
    // ADR-0437 follow-up — thread the registry task id so the runner can
    // register a per-child turn waker under the SAME id `followup_task` uses.
    taskId,
    ...(input.agent_type !== undefined ? { agentType: input.agent_type } : {}),
    ...(input.tool_filter !== undefined ? { toolFilter: input.tool_filter } : {}),
    // Parity passthroughs — the runner already honors each (buildChildConfig /
    // buildSeedPrompt). Conditional-spread so an unset field is byte-identical.
    ...(input.isolation !== undefined ? { isolation: input.isolation } : {}),
    ...(input.owned_surfaces !== undefined ? { ownedSurfaces: input.owned_surfaces } : {}),
    ...(input.forbidden_surfaces !== undefined
      ? { forbiddenSurfaces: input.forbidden_surfaces }
      : {}),
    ...(input.task_kind !== undefined ? { taskKind: input.task_kind } : {}),
    ...(input.result_shape !== undefined ? { resultShape: input.result_shape } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(priorAttempt !== undefined ? { priorAttempt } : {}),
    ...(checkpointPath !== undefined ? { checkpointPath } : {}),
  }

  // Fire-and-forget: the registry record settles when the runner returns.
  // On EITHER terminal path (complete/fail) drop the optional agentMeta entry
  // so the side-table is bounded by the set of RUNNING agents, not every agent
  // ever spawned. Idempotent + no-op when the host wired a `{set}`-only stub or
  // no side-table at all (byte-identical default-OFF path). Mirrors how the
  // registry record itself stops being a live `pendingIds()` entry on settle.
  // Tracked on the registry so session `cleanup` can DRAIN the actual runner
  // unwind (forceStop resolves the settler synchronously; the runner promise
  // otherwise keeps running past teardown). The `.finally` agentMeta cleanup is
  // wrapped INSIDE the tracked chain so it still fires on either terminal path.
  deps.registry.trackRunner(
    deps
      .runner(req)
      .then((r) => deps.registry.complete(taskId, r))
      .catch((e: unknown) => deps.registry.fail(taskId, errMessage(e)))
      .finally(() => deps.agentMeta?.delete?.(taskId)),
  )

  return { kind: "success", agentId: taskId, ownerToken }
}

// ─── wait_agent ────────────────────────────────────────────────────────────

interface WaitAgentDeps {
  registry: TaskRegistry
  /** B2 — closed-port timeout bounds. Absent ⇒ {@link DEFAULT_WAIT_TIMEOUT_POLICY}
   *  (30s default, generous ceiling) so the legacy no-policy call path is
   *  byte-identical. */
  timeoutPolicy?: WaitTimeoutPolicy
}

/** Map a settled TaskRecord status string to the contract-narrowed union
 *  the WaitAgent output expects. Extracted to keep handleWaitAgent under
 *  the biome cognitive-complexity cap. */
const renderSettled = (rec: import("./registry").TaskRecord): WaitAgentOutput => {
  const status =
    rec.status === "completed" ? "completed" : rec.status === "failed" ? "failed" : "stopped"
  return {
    kind: "success",
    status,
    finalText: rec.result?.finalText ?? rec.error ?? "",
    turns: rec.result?.turns ?? 0,
  }
}

/** Race the registry's settle promise against a timeout. Returns whichever
 *  arrived first. Extracted to bound handleWaitAgent's complexity. */
const raceSettleWithTimeout = async (
  registry: TaskRegistry,
  agentId: string,
  timeoutMs: number,
): Promise<"settled" | "timeout"> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs)
  })
  try {
    return await Promise.race([
      registry.waitForSettle(agentId).then(() => "settled" as const),
      timeout,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Block until the named child reaches a terminal state, or `timeoutMs`
 *  elapses (default 30s). On timeout the child remains running and may be
 *  re-awaited or closed. */
export const handleWaitAgent = async (
  input: WaitAgentInput,
  deps: WaitAgentDeps,
): Promise<WaitAgentOutput> => {
  const rec = deps.registry.get(input.agentId)
  if (rec === undefined) {
    return errWait(`No agent found with id ${input.agentId}`, "id_unknown")
  }
  // B2 — clamp the caller-supplied timeout into the injected policy band.
  // Default policy ⇒ omitted yields 30s; any pre-B2 override passes through.
  const timeoutMs = clampWaitTimeout(
    deps.timeoutPolicy ?? DEFAULT_WAIT_TIMEOUT_POLICY,
    input.timeoutMs,
  )

  if (rec.status !== "running") return renderSettled(rec)

  const winner = await raceSettleWithTimeout(deps.registry, input.agentId, timeoutMs)
  if (winner === "timeout") {
    return errWait(`wait_agent timed out after ${timeoutMs}ms`, "timeout")
  }

  const after = deps.registry.get(input.agentId)
  if (after === undefined) {
    return errWait(`agent ${input.agentId} disappeared from registry`, "id_unknown")
  }
  return renderSettled(after)
}

// ─── close_agent ───────────────────────────────────────────────────────────

interface CloseAgentDeps {
  registry: TaskRegistry
  ptyTable?: PtyTable
  /** Owner-token authorisation matches `task_stop`'s capability surface. The
   *  spawn_agent return value carries the token to the caller; without it
   *  another sibling cannot DoS-close a peer. When omitted, close uses the
   *  host-authority `forceStop` path (host code path only). */
  ownerToken?: string
}

/** Idempotent terminate. Returns `wasRunning:false` if the agent was already
 *  settled (so the LLM can call this defensively without checking state). */
export const handleCloseAgent = async (
  input: CloseAgentInput,
  deps: CloseAgentDeps,
): Promise<CloseAgentOutput> => {
  const rec = deps.registry.get(input.agentId)
  if (rec === undefined) {
    return errClose(`No agent found with id ${input.agentId}`, "id_unknown")
  }
  if (rec.status !== "running") {
    return { kind: "success", wasRunning: false }
  }
  let stopped: "stopped" | "denied" | "not-found"
  if (deps.ownerToken !== undefined) {
    stopped = deps.registry.stop(input.agentId, deps.ownerToken)
  } else {
    // Host-authority path (no LLM-supplied token) — used when close_agent is
    // routed from a trusted internal caller, e.g. a session shutdown hook.
    stopped = deps.registry.forceStop(input.agentId) ? "stopped" : "not-found"
  }
  if (stopped === "denied") {
    return errClose(`close_agent denied: owner_token does not match for ${input.agentId}`, "denied")
  }
  if (stopped === "not-found") {
    // Race: it settled between our read and our stop — idempotent path.
    return { kind: "success", wasRunning: false }
  }
  // Drop any pty owned by the same id (defensive — spawn_agent doesn't own
  // ptys today, but close_agent is the centralised teardown hook).
  return { kind: "success", wasRunning: true }
}

// ─── send_input ────────────────────────────────────────────────────────────

interface SendInputDeps {
  registry: TaskRegistry
  /** Per-task input channel. When a child enters a "paused" state awaiting
   *  user input, the spawn site MUST register a callback under the agentId
   *  here; `send_input` routes the message through that callback and clears
   *  the entry (one-shot). Absence ⇒ structured error (the child is not in a
   *  state that accepts conversational input). */
  inputChannel?: InputChannelRegistry
}

/** Per-agent one-shot input channel. The runner is responsible for
 *  registering a receiver under `agentId` when the child pauses awaiting
 *  conversational input; `send_input` calls the receiver and removes the
 *  entry. This is the only seam in the slice that bridges "host input" into
 *  a paused fork. */
export class InputChannelRegistry {
  private readonly channels = new Map<string, (message: string) => void>()

  /** Register a receiver for `agentId`. Returns a disposer the runner uses
   *  to remove the channel if the child resumes/terminates without input. */
  register(agentId: string, receiver: (message: string) => void): () => void {
    this.channels.set(agentId, receiver)
    return () => this.channels.delete(agentId)
  }

  has(agentId: string): boolean {
    return this.channels.has(agentId)
  }

  /** One-shot deliver: pops the entry and invokes the receiver. Returns true
   *  iff the message was delivered. */
  deliver(agentId: string, message: string): boolean {
    const receiver = this.channels.get(agentId)
    if (receiver === undefined) return false
    this.channels.delete(agentId)
    try {
      receiver(message)
    } catch {
      // Receiver throws ⇒ treat as delivery failure (caller sees structured
      // error from the surrounding handler).
      return false
    }
    return true
  }
}

/** Route a conversational message to a paused child. Different from
 *  `write_stdin` — this is into the child's loop, not into a PTY. */
export const handleSendInput = async (
  input: SendInputInput,
  deps: SendInputDeps,
): Promise<SendInputOutput> => {
  const rec = deps.registry.get(input.agentId)
  if (rec === undefined) {
    return errSendInput(`No agent found with id ${input.agentId}`, "id_unknown")
  }
  if (rec.status !== "running") {
    return errSendInput(
      `Agent ${input.agentId} is not running (status=${rec.status})`,
      "not_running",
    )
  }
  if (deps.inputChannel === undefined || !deps.inputChannel.has(input.agentId)) {
    return errSendInput(
      `Agent ${input.agentId} is not waiting for input (no registered input channel)`,
      "not_paused",
    )
  }
  const ok = deps.inputChannel.deliver(input.agentId, input.message)
  if (!ok) {
    return errSendInput(
      `Failed to deliver input to ${input.agentId} (channel rejected)`,
      "deliver_failed",
    )
  }
  return { kind: "success", delivered: true }
}
