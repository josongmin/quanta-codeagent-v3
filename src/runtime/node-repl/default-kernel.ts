/**
 * ADR-0249 — production node-REPL-backed kernel adapter.
 *
 * Sibling to the deterministic `headless-stub.ts` test adapter. The slice
 * (`port.ts`) consumes a closed `NodeReplKernel` port; this adapter is the
 * ONLY production implementation, instantiated at the composition root and
 * threaded into whatever tool wires it (deferred; this round delivers the
 * kernel primitive only).
 *
 * Line-protocol around a node REPL that prints ONLY the program's output:
 *   1. spawn `node --no-warnings -e <REPL_BOOT>` with stdin/stdout/stderr piped. The
 *      boot script starts `node:repl` with an empty prompt, `displayPrompt` disabled
 *      and `ignoreUndefined` — no banner, no `> ` / `| ` prompts, no `undefined` echoes.
 *   2. write the sentinel statement and read until it arrives — `state = "ready"`.
 *   3. on each `exec(code)`: write `code`, a newline, and the sentinel statement, which
 *      prints `"\n" + sentinel` to stderr and then stdout, and nothing after it. Each
 *      stream is read up to its own sentinel: before it is that exec's stdout / stderr.
 *      Uncaught errors go to stderr (REPL `handleError`), so `hadError` means it threw.
 *
 *   It spawned `node -i` and scrubbed prompts out of the capture afterwards. Measured
 *   on Node 25.9, `node -i` interleaves a banner, `> ` prompts, `| ` continuation
 *   prompts and `undefined` echoes with real output, and the sentinel's own echo
 *   arrived as `> '__sentinel__'` — so every exec returned a stray `'` once the scrub
 *   began stripping prompts instead of dropping lines (round-8 audit), and output that
 *   legitimately began with `> ` or `... `, or was the word `undefined`, was mangled
 *   or dropped. There is nothing to scrub when nothing is printed.
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
  stderrReader: ChunkReader
  /** Mutex — one exec at a time; the second call awaits this. */
  pending: Promise<unknown>
}

const DEFAULT_READY_TIMEOUT_MS = 5_000
const SENTINEL_PREFIX = "__quanta_repl_done_"
/** How long, after an exec's STDOUT sentinel arrived, its STDERR sentinel may take. Both
 *  are written by one statement (stderr first); only pipe delivery separates them. */
const STDERR_SENTINEL_GRACE_MS = 5_000

/**
 * `node -e` program: a REPL on stdin/stdout that prints no prompt of any kind, does not
 * echo `undefined`, sends uncaught errors to STDERR, and evaluates one command at a time.
 *
 * Errors. The REPL prints an uncaught error to its OUTPUT stream (`Uncaught Error: boom`),
 * as `node -i` does, so the kernel's stderr-based `hadError` was false for every thrown
 * error and the `node_repl` tool reported `ok:true` for code that threw (measured on
 * Node 25.9). `handleError` is the REPL's own hook, consulted before it prints.
 *
 * Serial evaluation. With top-level `await`, the REPL starts evaluating the NEXT line —
 * the sentinel statement — while the awaited promise is pending, so an awaited result or
 * rejection arrived AFTER the sentinel: measured, `await Promise.reject(…)` returned no
 * error and the next exec carried it; a throw after `await` was lost. `r.eval` is wrapped
 * so a command starts only when the previous one COMPLETED. Measured completion signals:
 * success and `Recoverable` (multi-line input) call the eval callback; an uncaught error,
 * sync or awaited, never does — it reaches `handleError` instead. So either releases the
 * queue. Limit: an error from a timer an EARLIER exec scheduled, arriving while a later
 * awaited command is pending, releases that command's queue early.
 *
 * On a Node without `handleError` the option is ignored: errors stay on stdout, and an
 * awaited command that rejects never releases the queue, so the exec times out.
 */
const REPL_BOOT = [
  'const repl=require("node:repl"),util=require("node:util");',
  "let busy=false;const queue=[];",
  "const next=()=>{const n=queue.shift();if(n)start(n);else busy=false};",
  "const start=(a)=>{busy=true;ev.call(r,a[0],a[1],a[2],(e,v)=>{try{a[3](e,v)}finally{next()}})};",
  'const r=repl.start({prompt:"",input:process.stdin,output:process.stdout,terminal:false,',
  "ignoreUndefined:true,handleError:(e)=>{",
  'process.stderr.write("Uncaught "+(e instanceof Error&&e.stack?e.stack:util.inspect(e))+"\\n");',
  'if(busy)next();return "ignore"}});',
  "r.displayPrompt=()=>{};const ev=r.eval;",
  "r.eval=(c,x,f,cb)=>{if(busy)queue.push([c,x,f,cb]);else start([c,x,f,cb])};",
].join("")

/** The statement that ends every write: prints a newline and the sentinel to STDERR and
 *  then STDOUT, and returns `undefined` (so nothing is echoed after it). Each stream is
 *  read up to its own copy, which is what attributes stderr to one exec. */
const sentinelStatement = (sentinel: string): string => {
  const marker = JSON.stringify(`\n${sentinel}`)
  return `;void (process.stderr.write(${marker}), process.stdout.write(${marker}));\n`
}

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
  readonly stderrReader: ChunkReader
}

const killQuietly = (proc: ReturnType<typeof Bun.spawn>): void => {
  try {
    proc.kill()
  } catch {
    /* already dead */
  }
}

/**
 * Launch the node REPL with a SCRUBBED environment.
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
 *
 * WHAT THE SCRUB IS NOT: a secret boundary. It removes credentials from the CHILD's
 * environment only. Code in the REPL runs as the same OS user as the agent, and that
 * user can read the parent's startup environment — measured on macOS, a child spawned
 * with a scrubbed env printed the parent's key via `ps eww -o command= -p $PPID` — and
 * can read any key file the user can. e0c1912c0 said "neither provider key reaches the
 * REPL"; that holds for `process.env` and not beyond it. The controls that bound this
 * tool are its approval (`node_repl` is always-confirm) and the OS sandbox, not the scrub.
 */
const launchNode = (nodeBin: string): Result<SpawnedProcess, KernelError> => {
  try {
    const proc = bunScrubbedSpawner([nodeBin, "--no-warnings", "-e", REPL_BOOT], {
      cwd: process.cwd(),
      env: asScrubbedEnv(scrubEnv()),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }) as ReturnType<typeof Bun.spawn>
    const stdoutReader = (
      proc.stdout as ReadableStream<Uint8Array>
    ).getReader() as unknown as ChunkReader
    // Read per exec, up to that exec's sentinel. It was drained with
    // `new Response(stderr).text()`, which resolves only when the stream CLOSES — at
    // process exit — so a live kernel's stderr buffer was always empty when an exec
    // finished, and `hadError` could not be true for a running kernel at all.
    const stderrReader = (
      proc.stderr as ReadableStream<Uint8Array>
    ).getReader() as unknown as ChunkReader
    return ok({ proc, stdoutReader, stderrReader })
  } catch (e) {
    const detail = errMessage(e)
    if (detail.toLowerCase().includes("enoent")) return err({ kind: "node-missing", detail })
    return err({ kind: "spawn-failed", detail })
  }
}

const warmUpNode = async (
  proc: ReturnType<typeof Bun.spawn>,
  stdoutReader: ChunkReader,
  stderrReader: ChunkReader,
  readyTimeoutMs: number,
): Promise<{ ok: true } | { ok: false; detail: string }> => {
  const sentinel = `${SENTINEL_PREFIX}${randomNonce()}__`
  try {
    ;(proc.stdin as { write: (s: string) => unknown }).write(sentinelStatement(sentinel))
  } catch (e) {
    killQuietly(proc)
    return { ok: false, detail: errMessage(e) }
  }
  const read = await readUntil(stdoutReader, sentinel, readyTimeoutMs)
  const readErr = read.ok ? await readUntil(stderrReader, sentinel, readyTimeoutMs) : read
  if (readErr.ok) return { ok: true }
  killQuietly(proc)
  return { ok: false, detail: readErr.error }
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
  if (read.ok) {
    const errRead = await readUntil(k.stderrReader, write.sentinel, STDERR_SENTINEL_GRACE_MS)
    if (errRead.ok) return finishExec(k, id, read.body, errRead.body, touchIfHome, release)
    // The stdout sentinel arrived and the stderr one did not: the streams are out of step,
    // and every later exec would read the wrong stderr. Nothing trustworthy is left.
    markDead(k, id, removeIfHome, dropKernel)
    release()
    return err({ kind: "kernel-dead", id })
  }
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
      const { proc, stdoutReader, stderrReader } = launched.value

      const now = Date.now()
      const pid = proc.pid ?? 0
      const spec: KernelSpec = {
        id,
        pid,
        startedAtMs: now,
        lastUseMs: now,
        sessionId: spawnOpts.sessionId,
      }

      const warmup = await warmUpNode(proc, stdoutReader, stderrReader, readyTimeoutMs)
      if (!warmup.ok) return err({ kind: "spawn-failed", detail: warmup.detail })

      kernels.set(id, {
        spec,
        state: "ready",
        proc,
        stdoutReader,
        stderrReader,
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
  const wrapped = `${code}\n${sentinelStatement(sentinel)}`
  const w = writeStdin(k, wrapped)
  if (!w.ok) return { ok: false, detail: w.detail }
  return { ok: true, sentinel }
}

/** Finalise a successful read: bump lastUseMs, transition to idle, release the lock,
 *  and return the ExecResult built from both streams' bodies. */
const finishExec = (
  k: LiveKernel,
  id: KernelId,
  body: string,
  stderrBody: string,
  touchIfHome: (id: KernelId, ms: number) => void,
  release: () => void,
): Result<ExecResult, KernelError> => {
  const stderrText = replOutput(stderrBody)
  const now = Date.now()
  k.spec = { ...k.spec, lastUseMs: now }
  touchIfHome(id, now)
  k.state = "idle"
  release()
  return ok({
    id,
    stdout: replOutput(body),
    stderr: stderrText,
    hadError: stderrText.length > 0,
  })
}

/**
 * The exec's stdout from a captured body: the sentinel statement's leading newline is
 * removed, then one trailing newline (a result echo or `console.log` ends with one). No
 * line is dropped or rewritten — the REPL prints no prompts, so nothing needs scrubbing.
 */
export const replOutput = (body: string): string => body.replace(/\n$/, "").replace(/\n$/, "")

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
