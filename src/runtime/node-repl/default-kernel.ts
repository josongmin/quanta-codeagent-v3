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
  /** Filesystem `HOME` for the on-disk handle store. Defaults to the
   *  caller's HOME (state-store falls back to `os.homedir()`). */
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
export const createDefaultNodeReplKernel = (opts: DefaultKernelOptions = {}): NodeReplKernel => {
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
    async spawn(spawnOpts: NodeReplSpawnOptions): Promise<Result<KernelSpec, KernelError>> {
      if (spawnOpts.signal?.aborted === true) {
        return err({ kind: "spawn-failed", detail: "aborted before spawn" })
      }
      const idStr = mkId(spawnOpts.id)
      if (idStr === null) {
        return err({ kind: "invalid-id", raw: spawnOpts.id ?? "" })
      }
      const id = idStr as KernelId

      let proc: ReturnType<typeof Bun.spawn>
      try {
        proc = Bun.spawn([nodeBin, "-i", "--no-warnings"], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        })
      } catch (e) {
        const detail = errMessage(e)
        // ENOENT on `node` → node-missing; anything else (EACCES, EAGAIN)
        // surfaces as spawn-failed with the platform detail.
        if (detail.toLowerCase().includes("enoent")) {
          return err({ kind: "node-missing", detail })
        }
        return err({ kind: "spawn-failed", detail })
      }

      const stdoutReader = (
        proc.stdout as ReadableStream<Uint8Array>
      ).getReader() as unknown as ChunkReader
      const stderrBuf: string[] = []
      // Drain stderr in the background — accumulate into stderrBuf the
      // caller's `exec` will consume.
      void (async () => {
        try {
          const text = await new Response(proc.stderr as ReadableStream<Uint8Array>).text()
          if (text.length > 0) stderrBuf.push(text)
        } catch {
          // process died; nothing to drain
        }
      })()

      const now = Date.now()
      const pid = proc.pid ?? 0
      const spec: KernelSpec = {
        id,
        pid,
        startedAtMs: now,
        lastUseMs: now,
        sessionId: spawnOpts.sessionId,
      }

      // Warm-up: send a sentinel and consume the banner until it echoes.
      const warmupNonce = randomNonce()
      const warmupSentinel = `${SENTINEL_PREFIX}${warmupNonce}__`
      try {
        const writer = (proc.stdin as { write: (s: string) => unknown }).write
        ;(proc.stdin as { write: (s: string) => unknown }).write(`;"${warmupSentinel}";\n`)
        void writer // silence unused
      } catch (e) {
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
        return err({
          kind: "spawn-failed",
          detail: errMessage(e),
        })
      }
      const warmRead = await readUntil(stdoutReader, warmupSentinel, readyTimeoutMs)
      if (!warmRead.ok) {
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
        return err({ kind: "spawn-failed", detail: warmRead.error })
      }

      kernels.set(id, {
        spec,
        state: "ready",
        proc,
        stdoutReader,
        stderrBuf,
        pending: Promise.resolve(),
      })
      writeIfHome(spec)
      // Reap on process death — mark dead, drop the on-disk handle, and
      // evict from the in-memory Map so dead kernels are not retained.
      void (async () => {
        try {
          await proc.exited
        } finally {
          const k = kernels.get(id)
          if (k !== undefined) {
            k.state = "dead"
          }
          removeIfHome(id)
          kernels.delete(id)
        }
      })()

      return ok(spec)
    },

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
        release()
        return err({ kind: "kernel-dead", id })
      }
      if (execOpts?.signal?.aborted === true) {
        markDeadAndExit(k, id, removeIfHome, dropKernel)
        release()
        return err({ kind: "exec-aborted", id })
      }
      const writeRes = writeExec(k, code)
      if (!writeRes.ok) {
        markDead(k, id, removeIfHome, dropKernel)
        release()
        return err({ kind: "spawn-failed", detail: writeRes.detail })
      }
      const readRes = await readUntilWithAbort(
        k.stdoutReader,
        writeRes.sentinel,
        execOpts?.timeoutMs ?? 0,
        execOpts?.signal,
      )
      if (!readRes.ok) {
        const aborted = readRes.error === "aborted"
        if (aborted) markDeadAndExit(k, id, removeIfHome, dropKernel)
        else markDead(k, id, removeIfHome, dropKernel)
        release()
        return err({ kind: aborted ? "exec-aborted" : "kernel-dead", id })
      }
      return finishExec(k, id, readRes.body, touchIfHome, release)
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
 *  statement; for downstream consumers the noise is irrelevant. */
const scrubReplNoise = (raw: string): string => {
  return raw
    .split("\n")
    .filter((line) => {
      const t = line.trim()
      if (t === "") return false
      if (t === ">" || t === "...") return false
      if (t === "undefined") return false
      if (t.startsWith("> ") || t.startsWith("... ")) return false
      return true
    })
    .join("\n")
}

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
 *  `{ ok: false, error }`. */
const readUntil = async (
  reader: ChunkReader,
  sentinel: string,
  timeoutMs: number,
): Promise<ReadResult | ReadFail> => {
  const decoder = new TextDecoder()
  let buf = ""
  const start = Date.now()
  while (true) {
    if (timeoutMs > 0 && Date.now() - start > timeoutMs) {
      return { ok: false, error: `read timeout after ${timeoutMs}ms` }
    }
    let done: boolean
    let value: Uint8Array | undefined
    try {
      const chunk = await reader.read()
      done = chunk.done
      value = chunk.value
    } catch (e) {
      return { ok: false, error: errMessage(e) }
    }
    if (done) {
      return { ok: false, error: "stream closed" }
    }
    if (value !== undefined) {
      buf += decoder.decode(value, { stream: true })
    }
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
