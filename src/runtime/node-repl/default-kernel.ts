/**
 * ADR-0249 — production `Bun.spawn(["node","-i"])`-backed kernel adapter.
 *
 * Sibling to the deterministic `headless-stub.ts` test adapter. The slice
 * (`port.ts`) consumes a closed `NodeReplKernel` port; this adapter is the
 * ONLY production implementation, instantiated at the composition root and
 * threaded into whatever tool wires it (deferred; this round delivers the
 * kernel primitive only).
 *
 * Line-protocol around node's interactive REPL:
 *   1. spawn `node -i --no-warnings` with stdin/stdout/stderr piped.
 *   2. consume the banner ("Welcome to Node…", `>` prompt) until a
 *      caller-side warm-up sentinel echoes back — marks `state = "ready"`.
 *   3. on each `exec(code)`:
 *        write `code + "\n" + ";\"__quanta_repl_done_${execNonce}__\";\n"`
 *      then read stdout until the sentinel echoes. Everything before is
 *      the exec's stdout body. Stderr is drained in parallel into a
 *      separate buffer.
 *   4. AbortSignal → write `.exit\n` to stdin; state → "dead";
 *      resolve with `{ kind: "exec-aborted" }`.
 *
 * Synchronous `Bun.spawn` throw on ENOENT (`node` not on PATH) becomes
 * `{ kind: "node-missing", detail }` — same idiom as
 * `shell-snapshot/bun-spawner.ts`.
 *
 * Plane-clean: imports only state-store helpers + the port types. No reach
 * across slices.
 */

import { err, errMessage, ok, type Result } from "@/shared"
import { scrubEnv } from "../sandbox"
import { asScrubbedEnv, bunScrubbedSpawner } from "../scrubbed-spawn"
import type {
  KernelListing,
  NodeReplExecOptions,
  NodeReplKernel,
  NodeReplSpawnOptions,
} from "./port"
import { mkId, removeKernel, touchKernel, writeKernel } from "./state-store"
import type { ExecResult, KernelError, KernelId, KernelSpec, KernelState } from "./types"

/** Factory options for the production kernel. */
export interface DefaultKernelOptions {
  /** Override for the `node` binary path. Default: `"node"` (PATH lookup). */
  readonly nodeBin?: string
  /** Filesystem `HOME` for the on-disk handle store (`<home>/.quanta/…`). Omitted, the
   *  store is the Quanta home (`QUANTA_CONFIG_DIR ?? QUANTA_HOME ?? ~/.quanta`). */
  readonly home?: string
  /** Hard cap on the initial banner-consume window. Default 5_000 ms. */
  readonly readyTimeoutMs?: number
}

/** Erased shape we keep on a `LiveKernel` — Bun's `getReader()` returns
 *  a `stream/web` ReadableStreamDefaultReader, but `tsc` resolves the
 *  global lib variant differently. We narrow to the two methods this
 *  slice actually calls to keep the field assignable across both
 *  type-spaces. */
interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  releaseLock(): void
}

interface LiveKernel {
  spec: KernelSpec
  state: KernelState
  proc: ReturnType<typeof Bun.spawn>
  stdoutReader: ChunkReader
  stderrBuf: string[]
  /** Mutex — one exec at a time; the second call awaits this. */
  pending: Promise<unknown>
}

const DEFAULT_READY_TIMEOUT_MS = 5_000
const SENTINEL_PREFIX = "__quanta_repl_done_"

/** Build a production-shaped `NodeReplKernel`. STATEFUL — call once at
 *  composition-root and reuse across the session. */
/**
 * The kernel's shared state: the session table and the helpers every operation
 * resolves through. Split out of `createDefaultNodeReplKernel` (god-function
 * burndown).
 */
const kernelState = (opts: DefaultKernelOptions = {}) => {
  const nodeBin = opts.nodeBin ?? "node"
  const home = opts.home
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const kernels = new Map<KernelId, LiveKernel>()

  const writeIfHome = (spec: KernelSpec): void => {
    if (home !== undefined) writeKernel(spec, home)
    else writeKernel(spec)
  }
  const touchIfHome = (id: KernelId, ms: number): void => {
    if (home !== undefined) touchKernel(id, ms, home)
    else touchKernel(id, ms)
  }
  const removeIfHome = (id: KernelId): void => {
    if (home !== undefined) removeKernel(id, home)
    else removeKernel(id)
  }
  const dropKernel = (id: KernelId): void => {
    kernels.delete(id)
  }
  return {
    nodeBin,
    home,
    readyTimeoutMs,
    kernels,
    writeIfHome,
    touchIfHome,
    removeIfHome,
    dropKernel,
  }
}

/** The state every operation group shares, inferred from {@link kernelState} so it
 *  can never drift from what that function actually builds. */
type KernelCtx = ReturnType<typeof kernelState>

interface SpawnedProcess {
  readonly proc: ReturnType<typeof Bun.spawn>
  readonly stdoutReader: ChunkReader
  readonly stderrBuf: string[]
}

const killQuietly = (proc: ReturnType<typeof Bun.spawn>): void => {
  try {
    proc.kill()
  } catch {
    /* already dead */
  }
}

/**
 * Launch `node -i` with a SCRUBBED environment.
 *
 * This called `Bun.spawn` with no `env`, so the child inherited the whole parent
 * environment — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and every other credential the
 * agent process holds — and the REPL exists to run model-authored JavaScript, which can
 * read `process.env` and print it. Measured with the key present at process start: the
 * kernel printed `KEY=probe-startup-secret`. Production builds this kernel when
 * `QUANTA_NODE_REPL` is on.
 *
 * It was missed twice. The exec-cluster scrub ban classified `node -i` as "not a shell;
 * a different charter", and the unit test that claimed to pin it set the key with
 * `process.env.ANTHROPIC_API_KEY = …` inside the running test — which a Bun child does
 * not inherit — so it could not see the leak it named, and passed or failed on how the
 * REPL split its output.
 *
 * Now it goes through the branded funnel: `env` is required and must be minted by
 * `asScrubbedEnv(scrubEnv())`, so an inherit-by-omission spawn is a type error here.
 */
const launchNode = (nodeBin: string): Result<SpawnedProcess, KernelError> => {
  try {
    const proc = bunScrubbedSpawner([nodeBin, "-i", "--no-warnings"], {
      cwd: process.cwd(),
      env: asScrubbedEnv(scrubEnv()),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }) as ReturnType<typeof Bun.spawn>
    const stdoutReader = (
      proc.stdout as ReadableStream<Uint8Array>
    ).getReader() as unknown as ChunkReader
    const stderrBuf: string[] = []
    void drainStderr(proc, stderrBuf)
    return ok({ proc, stdoutReader, stderrBuf })
  } catch (e) {
    const detail = errMessage(e)
    if (detail.toLowerCase().includes("enoent")) return err({ kind: "node-missing", detail })
    return err({ kind: "spawn-failed", detail })
  }
}

const drainStderr = async (
  proc: ReturnType<typeof Bun.spawn>,
  stderrBuf: string[],
): Promise<void> => {
  try {
    const text = await new Response(proc.stderr as ReadableStream<Uint8Array>).text()
    if (text.length > 0) stderrBuf.push(text)
  } catch {
    // process died; nothing to drain
  }
}

const warmUpNode = async (
  proc: ReturnType<typeof Bun.spawn>,
  stdoutReader: ChunkReader,
  readyTimeoutMs: number,
): Promise<{ ok: true } | { ok: false; detail: string }> => {
  const sentinel = `${SENTINEL_PREFIX}${randomNonce()}__`
  try {
    ;(proc.stdin as { write: (s: string) => unknown }).write(`;"${sentinel}";\n`)
  } catch (e) {
    killQuietly(proc)
    return { ok: false, detail: errMessage(e) }
  }
  const read = await readUntil(stdoutReader, sentinel, readyTimeoutMs)
  if (read.ok) return { ok: true }
  killQuietly(proc)
  return { ok: false, detail: read.error }
}

const reapWhenExited = (
  proc: ReturnType<typeof Bun.spawn>,
  id: KernelId,
  kernels: Map<KernelId, LiveKernel>,
  removeIfHome: (id: KernelId) => void,
): void => {
  void (async () => {
    try {
      await proc.exited
    } finally {
      const k = kernels.get(id)
      if (k !== undefined) k.state = "dead"
      removeIfHome(id)
      kernels.delete(id)
    }
  })()
}

const releaseDeadKernel = (release: () => void, id: KernelId): Result<never, KernelError> => {
  release()
  return err({ kind: "kernel-dead", id })
}

const executeWithLock = async (
  k: LiveKernel,
  id: KernelId,
  code: string,
  execOpts: NodeReplExecOptions | undefined,
  ctx: KernelCtx,
  release: () => void,
): Promise<Result<ExecResult, KernelError>> => {
  const { removeIfHome, dropKernel, touchIfHome } = ctx
  if (execOpts?.signal?.aborted === true) {
    markDeadAndExit(k, id, removeIfHome, dropKernel)
    release()
    return err({ kind: "exec-aborted", id })
  }
  const write = writeExec(k, code)
  if (!write.ok) {
    markDead(k, id, removeIfHome, dropKernel)
    release()
    return err({ kind: "spawn-failed", detail: write.detail })
  }
  const read = await readUntilWithAbort(
    k.stdoutReader,
    write.sentinel,
    execOpts?.timeoutMs ?? 0,
    execOpts?.signal,
  )
  if (read.ok) return finishExec(k, id, read.body, touchIfHome, release)
  const aborted = read.error === "aborted"
  if (aborted) markDeadAndExit(k, id, removeIfHome, dropKernel)
  else markDead(k, id, removeIfHome, dropKernel)
  release()
  return err({ kind: aborted ? "exec-aborted" : "kernel-dead", id })
}

/** Session spawn — the long pole: allocate the child, wire its streams, and
 *  register the session so `exec`/`kill` can find it. */
const spawnOps = (ctx: KernelCtx): Pick<NodeReplKernel, "spawn"> => {
  const { nodeBin, readyTimeoutMs, kernels, writeIfHome, removeIfHome } = ctx
  return {
    async spawn(spawnOpts: NodeReplSpawnOptions): Promise<Result<KernelSpec, KernelError>> {
      if (spawnOpts.signal?.aborted === true) {
        return err({ kind: "spawn-failed", detail: "aborted before spawn" })
      }
      const idStr = mkId(spawnOpts.id)
      if (idStr === null) {
        return err({ kind: "invalid-id", raw: spawnOpts.id ?? "" })
      }
      const id = idStr as KernelId
      const launched = launchNode(nodeBin)
      if (!launched.ok) return launched
      const { proc, stdoutReader, stderrBuf } = launched.value

      const now = Date.now()
      const pid = proc.pid ?? 0
      const spec: KernelSpec = {
        id,
        pid,
        startedAtMs: now,
        lastUseMs: now,
        sessionId: spawnOpts.sessionId,
      }

      const warmup = await warmUpNode(proc, stdoutReader, readyTimeoutMs)
      if (!warmup.ok) return err({ kind: "spawn-failed", detail: warmup.detail })

      kernels.set(id, {
        spec,
        state: "ready",
        proc,
        stdoutReader,
        stderrBuf,
        pending: Promise.resolve(),
      })
      writeIfHome(spec)
      reapWhenExited(proc, id, kernels, removeIfHome)

      return ok(spec)
    },
  }
}

/** Operations over an already-spawned session: evaluate, report, terminate,
 *  enumerate. */
const sessionOps = (ctx: KernelCtx): Pick<NodeReplKernel, "exec" | "status" | "kill" | "list"> => {
  const { kernels, removeIfHome } = ctx
  return {
    async exec(
      id: KernelId,
      code: string,
      execOpts?: NodeReplExecOptions,
    ): Promise<Result<ExecResult, KernelError>> {
      const k = kernels.get(id)
      if (k === undefined || k.state === "dead") return err({ kind: "kernel-dead", id })
      // Pre-aborted fast path: do NOT kill a kernel that another exec
      // currently owns. Kernels are addressed by id and reused, so killing
      // here (before acquiring the lock) could tear a kernel out from under
      // a concurrent exec. Acquire the lock first so this aborted call can
      // only act on its own turn — by which point the in-flight exec has
      // finished and released. (If the signal is *still* aborted after we
      // own the lock we tear down; otherwise we proceed normally.)
      const release = await acquireExecLock(k)
      // Re-validate liveness after waiting on the lock — a concurrent
      // teardown may have killed the kernel (state → "dead" + Map eviction)
      // while we were queued behind the in-flight exec.
      const live = kernels.get(id)
      if (live === undefined || live.state === "dead") {
        return releaseDeadKernel(release, id)
      }
      return executeWithLock(k, id, code, execOpts, ctx, release)
    },

    status(id: KernelId): KernelState {
      const k = kernels.get(id)
      return k?.state ?? "dead"
    },

    async kill(id: KernelId): Promise<void> {
      const k = kernels.get(id)
      if (k === undefined) return
      try {
        k.proc.kill()
      } catch {
        /* already dead */
      }
      k.state = "dead"
      removeIfHome(id)
      kernels.delete(id)
    },

    list(): ReadonlyArray<KernelListing> {
      const out: KernelListing[] = []
      for (const k of kernels.values()) {
        out.push({
          spec: k.spec,
          state: k.state,
          inUse: k.state === "running",
        })
      }
      return out
    },
  }
}

export const createDefaultNodeReplKernel = (opts: DefaultKernelOptions = {}): NodeReplKernel => {
  const ctx = kernelState(opts)
  return {
    ...spawnOps(ctx),
    ...sessionOps(ctx),
  }
}

const randomNonce = (): string => crypto.randomUUID().replace(/-/g, "").slice(0, 16)

const writeStdin = (k: LiveKernel, s: string): { ok: true } | { ok: false; detail: string } => {
  try {
    ;(k.proc.stdin as { write: (s: string) => unknown }).write(s)
    return { ok: true }
  } catch (e) {
    return { ok: false, detail: errMessage(e) }
  }
}

/** Terminate the live child + tear down its handle. Mirrors `kill()`:
 *  flips state to `dead`, kills the OS process (so the piped stdin/stdout/
 *  stderr fds are reaped and the `proc.exited` promise resolves), removes
 *  the on-disk handle, and evicts the entry from the in-memory Map so dead
 *  kernels are never retained. Without the `k.proc.kill()` the timeout /
 *  write-failure paths would orphan a live `node -i` child forever (the
 *  reaper parks on `proc.exited`, which never resolves on its own). */
const markDead = (
  k: LiveKernel,
  id: KernelId,
  removeIfHome: (id: KernelId) => void,
  dropKernel: (id: KernelId) => void,
): void => {
  k.state = "dead"
  try {
    k.proc.kill()
  } catch {
    /* already dead */
  }
  removeIfHome(id)
  dropKernel(id)
}

/** Sibling to `markDead` — additionally issues `.exit` on stdin so the
 *  spawned REPL terminates gracefully when the caller's signal aborted,
 *  then falls through to the same teardown (kill + handle removal + Map
 *  eviction). */
const markDeadAndExit = (
  k: LiveKernel,
  id: KernelId,
  removeIfHome: (id: KernelId) => void,
  dropKernel: (id: KernelId) => void,
): void => {
  // Best-effort graceful exit — a dead pipe just no-ops.
  writeStdin(k, ".exit\n")
  markDead(k, id, removeIfHome, dropKernel)
}

/** Mutex acquire — once the prior exec's tail resolves, transition to
 *  `running` and return a release fn the caller invokes on completion.
 *  Fail-closed: if a concurrent teardown killed the kernel while we were
 *  queued behind the prior exec, do NOT resurrect it to `running` — leave
 *  it `dead` so the caller's post-lock liveness check returns kernel-dead. */
const acquireExecLock = async (k: LiveKernel): Promise<() => void> => {
  const prev = k.pending
  let release!: () => void
  const next = new Promise<void>((r) => {
    release = r
  })
  k.pending = prev.then(() => next)
  await prev
  if (k.state !== "dead") k.state = "running"
  return release
}

/** Send the wrapped exec payload + per-exec sentinel. */
const writeExec = (
  k: LiveKernel,
  code: string,
): { ok: true; sentinel: string } | { ok: false; detail: string } => {
  const sentinel = `${SENTINEL_PREFIX}${randomNonce()}__`
  const wrapped = `${code}\n;"${sentinel}";\n`
  const w = writeStdin(k, wrapped)
  if (!w.ok) return { ok: false, detail: w.detail }
  return { ok: true, sentinel }
}

/** Finalise a successful read: drain stderr buffer, bump lastUseMs,
 *  transition to idle, release the lock, and return the ExecResult. */
const finishExec = (
  k: LiveKernel,
  id: KernelId,
  body: string,
  touchIfHome: (id: KernelId, ms: number) => void,
  release: () => void,
): Result<ExecResult, KernelError> => {
  const stderrText = k.stderrBuf.join("")
  k.stderrBuf.length = 0
  const now = Date.now()
  k.spec = { ...k.spec, lastUseMs: now }
  touchIfHome(id, now)
  k.state = "idle"
  release()
  return ok({
    id,
    stdout: scrubReplNoise(body),
    stderr: stderrText,
    hadError: stderrText.length > 0,
  })
}

/** Strip REPL prompt / undefined echoes from a captured body. node's
 *  interactive REPL pads `>` prompts and `undefined` lines around each
 *  statement; for downstream consumers the noise is irrelevant.
 *
 *  A leading prompt is STRIPPED, not a reason to drop the line. The REPL can deliver a
 *  statement's output on the same chunk as the prompt, as `"> SCRUBBED"`; the old filter
 *  dropped every line starting with `"> "`, so that output vanished and `exec` returned
 *  an empty stdout for a statement that printed. Measured: raw capture showed the line
 *  arriving that way on some runs, and the credential test then saw `""`. */
export const scrubReplNoise = (raw: string): string =>
  raw
    .split("\n")
    .map((line) => line.replace(/^\s*(?:(?:>|\.\.\.)(?:\s+|$))+/, ""))
    .filter((line) => {
      const t = line.trim()
      return t !== "" && t !== "undefined"
    })
    .join("\n")

interface ReadResult {
  ok: true
  body: string
}
interface ReadFail {
  ok: false
  error: string
}

/** Read from `reader` until `sentinel` appears in the accumulated text.
 *  Returns the body *before* the sentinel. A timeout returns
 *  `{ ok: false, error }`.
 *
 *  Exported for the timeout-race hellgate: the timer-cleanup-on-reject path
 *  cannot be driven through a real `node -i` child (its stdout reader does not
 *  reject mid-wait on demand), so the test injects a `ChunkReader` whose
 *  `read()` rejects and asserts the bounded race timer is still cleared. */
/** Injectable timer pair for the race below. Defaults to the ambient globals;
 *  the timer-leak hellgate injects LOCAL spies so it never monkeypatches
 *  `globalThis.setTimeout` (a process-global mutation that leaks across
 *  concurrently-running test files and makes the assertion flaky). */
export interface ReadUntilTimers {
  readonly set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clear: (handle: ReturnType<typeof setTimeout>) => void
}
const DEFAULT_TIMERS: ReadUntilTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle),
}

type ReadChunk = { done: boolean; value?: Uint8Array }
type TimedRead = ReadChunk | typeof READ_TIMED_OUT
const READ_TIMED_OUT = Symbol("read-timeout")

const readChunkWithin = async (
  reader: ChunkReader,
  remainingMs: number,
  timers: ReadUntilTimers,
): Promise<TimedRead> => {
  if (remainingMs <= 0) return READ_TIMED_OUT
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<typeof READ_TIMED_OUT>((resolve) => {
        timer = timers.set(() => resolve(READ_TIMED_OUT), remainingMs)
      }),
    ])
  } finally {
    if (timer !== undefined) timers.clear(timer)
  }
}

const remainingReadMs = (timeoutMs: number, startMs: number): number => {
  return timeoutMs > 0 ? timeoutMs - (Date.now() - startMs) : -1
}

type ReadNext = { ok: true; value?: Uint8Array } | ReadFail

const readNext = async (
  reader: ChunkReader,
  timeoutMs: number,
  remainingMs: number,
  timers: ReadUntilTimers,
): Promise<ReadNext> => {
  try {
    const chunk =
      timeoutMs > 0 ? await readChunkWithin(reader, remainingMs, timers) : await reader.read()
    if (chunk === READ_TIMED_OUT) {
      return { ok: false, error: `read timeout after ${timeoutMs}ms` }
    }
    if (chunk.done) return { ok: false, error: "stream closed" }
    if (chunk.value === undefined) return { ok: true }
    return { ok: true, value: chunk.value }
  } catch (e) {
    return { ok: false, error: errMessage(e) }
  }
}

export const readUntil = async (
  reader: ChunkReader,
  sentinel: string,
  timeoutMs: number,
  timers: ReadUntilTimers = DEFAULT_TIMERS,
): Promise<ReadResult | ReadFail> => {
  const decoder = new TextDecoder()
  let buf = ""
  const start = Date.now()
  while (true) {
    const remainingMs = remainingReadMs(timeoutMs, start)
    if (timeoutMs > 0 && remainingMs <= 0) {
      return { ok: false, error: `read timeout after ${timeoutMs}ms` }
    }
    // A bare `await reader.read()` blocks forever on a silent child; this
    // bounded helper also clears its race timer when a reader rejects.
    const next = await readNext(reader, timeoutMs, remainingMs, timers)
    if (!next.ok) return next
    if (next.value !== undefined) buf += decoder.decode(next.value, { stream: true })
    const idx = buf.indexOf(sentinel)
    if (idx >= 0) {
      return { ok: true, body: buf.slice(0, idx) }
    }
  }
}

interface AbortRead extends ReadFail {
  error: "aborted" | string
}

/** `readUntil` with an external AbortSignal. */
const readUntilWithAbort = async (
  reader: ChunkReader,
  sentinel: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ReadResult | AbortRead> => {
  if (signal === undefined) {
    const r = await readUntil(reader, sentinel, timeoutMs)
    return r
  }
  // Race: the read against the abort. We can't cancel `reader.read()`
  // directly without releasing the lock; the abort path simply causes
  // the caller to write `.exit` so the next `read()` resolves with
  // `done: true`. We poll on abort by chunking.
  return new Promise((resolve) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      resolve({ ok: false, error: "aborted" })
    }
    signal.addEventListener("abort", onAbort, { once: true })
    void readUntil(reader, sentinel, timeoutMs).then((r) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      resolve(r)
    })
  })
}
