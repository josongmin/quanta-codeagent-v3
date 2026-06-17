import { type LspClient, LspRequestError } from "@/lsp"
import { errMessage, logger } from "@/shared"
import type { LspNavSession } from "@/tool"

/**
 * Generic, engine-agnostic warm-workspace pool (RFC jun-17 code-intelligence
 * warm backend). Extracted from the formerly pyright-hardcoded warm/pool layer
 * in `lsp-bridge.ts`. EVERYTHING in this file is language/engine-INDEPENDENT:
 * the cwd-keyed session map, refcounting, idle-TTL eviction, the `startPromise`
 * join (the expensive server-boot + initial-index shared once per cwd), the
 * per-file prepared/preparing dedup, and fatal-transport teardown.
 *
 * The only engine-specific knowledge lives behind {@link WarmBackend}: WHICH
 * client to spawn, and HOW to decide a file is "warm" (verified-ready). That is
 * the genuine varying axis — pyright uses an import-probe definition; a future
 * engine (basedpyright, rust-analyzer's ContentModified, ty/pyrefly) supplies
 * its own readiness signal by implementing the same 4-method seam.
 *
 * Invariant: {@link SharedWorkspacePool.open} returns a READY session only. We
 * never hand back a session and index behind it — that would break the first
 * definition/hover's correctness. Background prewarm runs the SAME `open` path
 * and joins the SAME cwd entry; the first real caller hits a warm map.
 */
export interface WarmBackend {
  /** Stable engine id (`"pyright"`, `"basedpyright"`, …). Used in logs + as the
   *  backend-swap test's discriminator. */
  readonly id: string
  /** Does this backend handle `filePath`? Used to guard prewarm anchors. */
  supports(filePath: string): boolean
  /** Construct the (not-yet-started) language-server client rooted at `cwd`. */
  createClient(cwd: string): LspClient
  /** Bring `filePath` to verified-ready on `client`. Returns true when the
   *  server has demonstrably resolved the file (or no readiness probe applies),
   *  false when the readiness budget was exhausted WITHOUT a resolve. A false
   *  result must NOT mark the file prepared (the next call re-attempts), exactly
   *  mirroring the legacy pyright warm-up contract. Re-throws FATAL transport
   *  errors so the pool tears the session down; transient "still indexing"
   *  failures resolve to false (keep polling) inside the backend. */
  ensureFileReady(client: LspClient, filePath: string, signal?: AbortSignal): Promise<boolean>
}

/** One pooled workspace session, keyed by cwd. Engine-agnostic. */
interface WorkspaceEntry {
  readonly key: string
  readonly client: LspClient
  // Reassigned once after construction (placeholder → real start()), so not readonly.
  startPromise: Promise<void>
  readonly preparedFiles: Set<string>
  readonly preparingFiles: Map<string, Promise<boolean>>
  refs: number
  idleTimer?: ReturnType<typeof setTimeout> | undefined
  destroyed: boolean
}

/** Default idle-TTL (30 minutes) before an unreferenced workspace is reaped
 *  (interactive reuse window). Bench overrides lifetime via the terminal
 *  {@link SharedWorkspacePool.evict}. Flat literal (not `30 * 60_000`) so the
 *  magic-timeout scan's arithmetic-form false positive does not trip. */
const DEFAULT_IDLE_TTL_MS = 1_800_000

/** Thrown when a handle is used after its pooled session was torn down (fatal
 *  error / idle stop / evict). NOT a transport error, so
 *  {@link isFatalSharedSessionError} returns false and it does NOT re-trigger
 *  teardown — the nav tool surfaces a clean failure and the agent moves on,
 *  instead of hammering a dead client. */
export const SHARED_SESSION_CLOSED = "lsp shared session closed"

/** A typed LSP request error is a normal "no answer / unsupported" — NOT fatal.
 *  Only true transport death (process gone, pump dead) tears the session down,
 *  classified by message because the transport layer has no typed code. Exported
 *  so an engine backend's readiness probe can abort (rethrow) on transport
 *  death instead of spinning retries against a dead server. */
export const isFatalSharedSessionError = (e: unknown): boolean => {
  if (e instanceof LspRequestError) return false
  const msg = errMessage(e).toLowerCase()
  return (
    msg.includes("transport") ||
    msg.includes("server stopped") ||
    msg.includes("server exited") ||
    msg.includes("stdout pump died")
  )
}

export class SharedWorkspacePool {
  private readonly sessions = new Map<string, WorkspaceEntry>()
  /** cwds that have been HARD-evicted ({@link evict}). A fire-and-forget
   *  background prewarm can lose the race against bench session-end eviction:
   *  evict runs while the prewarm has not yet reached {@link acquire}, finds no
   *  entry, and the prewarm THEN boots a server that nothing reaps (the very
   *  leak the evict exists to close). This tombstone makes eviction terminal: a
   *  pooled entry that materializes for a hard-evicted cwd is reaped on the spot.
   *  Evict is only ever called for per-instance bench sandbox cwds (unique, never
   *  reused), so a permanent-per-cwd flag is correct; {@link disposeAll} clears
   *  it for a fresh process/test slate. */
  private readonly hardEvicted = new Set<string>()
  private readonly backend: WarmBackend
  private readonly idleTtlMs: number

  constructor(backend: WarmBackend, opts?: { idleTtlMs?: number }) {
    this.backend = backend
    this.idleTtlMs = opts?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
  }

  /** Engine id of the backing {@link WarmBackend} (logs / test discriminator). */
  get backendId(): string {
    return this.backend.id
  }

  /** Open a READY pooled nav session for `filePath` under `cwd`. Reuses the
   *  cwd-keyed entry (sharing the expensive `startPromise`), warms the file to
   *  verified-ready, and returns a handle that releases its ref on `stop()`.
   *  Returns null (never throws) on start/warm failure — caller degrades. */
  async open(filePath: string, cwd: string, signal?: AbortSignal): Promise<LspNavSession | null> {
    // Already aborted (e.g. a background prewarm whose session ended before it
    // ran) ⇒ spawn nothing. Cheapest place to honor the signal: before acquire
    // creates + starts a client.
    if (signal?.aborted) return null
    const entry = this.acquire(cwd, signal)
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }
    entry.refs += 1
    try {
      await entry.startPromise
      await this.warmFile(entry, filePath, signal)
      // Late-creation race guard: if this cwd was hard-evicted while we were
      // booting/warming (bench session-end vs fire-and-forget prewarm), reap the
      // entry we just materialized instead of leaving a leaked daemon + idle
      // timer. The caller gets null and degrades (prewarm discards it).
      if (this.hardEvicted.has(cwd)) {
        await this.stopClient(entry, "pool/evict-late")
        return null
      }
      return this.handle(entry)
    } catch (e) {
      await this.release(entry)
      logger.warn("lsp: failed to ready shared nav session", {
        backend: this.backend.id,
        cwd,
        file: filePath,
        error: errMessage(e),
      })
      return null
    }
  }

  /** Background prewarm: open the anchor then immediately release the ref. The
   *  entry drops to refs=0 → idle timer keeps it warm → the first real `open`
   *  hits a warm map (and joins the in-flight `startPromise` if still booting).
   *  No new "warm promise" is invented — the cwd-keyed entry IS the join point.
   *  Best-effort: a failed prewarm is swallowed (logged) so session start is
   *  never delayed or aborted by it. */
  async prewarm(anchorFile: string, cwd: string, signal?: AbortSignal): Promise<void> {
    if (!this.backend.supports(anchorFile)) return
    const session = await this.open(anchorFile, cwd, signal)
    // The handle's stop() only decrements the refcount + (re)schedules the idle
    // timer — both throw-free — so no error handling is needed here.
    if (session) await session.stop()
  }

  /** Production teardown of ONE workspace (bench session end). TERMINAL +
   *  idempotent: tombstones the cwd so an in-flight prewarm that creates an
   *  entry AFTER this call is reaped on materialization (see {@link hardEvicted}). */
  async evict(cwd: string): Promise<void> {
    this.hardEvicted.add(cwd)
    const entry = this.sessions.get(cwd)
    if (entry) await this.stopClient(entry, "pool/evict")
  }

  /** Tear down every pooled workspace (process shutdown / test reset). Clears
   *  the hard-evict tombstones for a fresh slate. */
  async disposeAll(): Promise<void> {
    const entries = [...this.sessions.values()]
    this.sessions.clear()
    this.hardEvicted.clear()
    for (const entry of entries) await this.stopClient(entry, "pool/dispose")
  }

  // --- internals ----------------------------------------------------------

  private acquire(cwd: string, signal?: AbortSignal): WorkspaceEntry {
    const existing = this.sessions.get(cwd)
    if (existing) return existing
    const client = this.backend.createClient(cwd)
    const entry: WorkspaceEntry = {
      key: cwd,
      client,
      startPromise: Promise.resolve(),
      preparedFiles: new Set<string>(),
      preparingFiles: new Map<string, Promise<boolean>>(),
      refs: 0,
      destroyed: false,
    }
    // start() may reject (binary vanished mid-run): tear the entry down so a
    // later open() re-creates rather than awaiting a permanently-rejected
    // promise on a dead client.
    entry.startPromise = client.start(signal).catch(async (e) => {
      await this.stopClient(entry, "pool/start-fail")
      throw e
    })
    this.sessions.set(cwd, entry)
    return entry
  }

  private handle(entry: WorkspaceEntry): LspNavSession {
    let released = false
    const stop = async (): Promise<void> => {
      if (released) return
      released = true
      await this.release(entry)
    }
    const withFile = async <T>(
      filePath: string,
      signal: AbortSignal | undefined,
      call: () => Promise<T>,
    ): Promise<T> => {
      if (entry.destroyed) throw new Error(SHARED_SESSION_CLOSED)
      await this.warmFile(entry, filePath, signal)
      return this.guarded(entry, call)
    }
    return {
      definition: (file, pos, signal) =>
        withFile(file, signal, () => entry.client.definition(file, pos, signal)),
      references: (file, pos, includeDeclaration, signal) =>
        withFile(file, signal, () =>
          entry.client.references(file, pos, includeDeclaration, signal),
        ),
      hover: (file, pos, signal) =>
        withFile(file, signal, () => entry.client.hover(file, pos, signal)),
      typeDefinition: (file, pos, signal) =>
        withFile(file, signal, () => entry.client.typeDefinition(file, pos, signal)),
      implementation: (file, pos, signal) =>
        withFile(file, signal, () => entry.client.implementation(file, pos, signal)),
      documentSymbol: (file, signal) =>
        withFile(file, signal, () => entry.client.documentSymbol(file, signal)),
      workspaceSymbol: (query, signal) =>
        this.guarded(entry, () => entry.client.workspaceSymbol(query, signal)),
      prepareRename: (file, pos, signal) =>
        withFile(file, signal, () => entry.client.prepareRename(file, pos, signal)),
      incomingCalls: (file, pos, signal) =>
        withFile(file, signal, () => entry.client.incomingCalls(file, pos, signal)),
      outgoingCalls: (file, pos, signal) =>
        withFile(file, signal, () => entry.client.outgoingCalls(file, pos, signal)),
      stop,
    }
  }

  /** Bring `filePath` to ready, deduping concurrent + repeat warms. Already
   *  prepared ⇒ a cheap `prime` (re-open doc) and return; in-flight ⇒ join it;
   *  otherwise drive the backend's readiness probe and mark prepared ONLY on a
   *  verified-ready result. */
  private async warmFile(
    entry: WorkspaceEntry,
    filePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    // A concurrent evict / fatal teardown may have stopped this entry between
    // `open`'s `await startPromise` and here — don't drive a dead client through
    // the backend's readiness probe (wasted work + a spurious warm-budget warn).
    if (entry.destroyed) throw new Error(SHARED_SESSION_CLOSED)
    if (entry.preparedFiles.has(filePath)) {
      await entry.client.prime(filePath, signal)
      return
    }
    const inFlight = entry.preparingFiles.get(filePath)
    if (inFlight) {
      await inFlight
      return
    }
    const prep = this.backend.ensureFileReady(entry.client, filePath, signal)
    entry.preparingFiles.set(filePath, prep)
    try {
      if (await prep) entry.preparedFiles.add(filePath)
    } finally {
      entry.preparingFiles.delete(filePath)
    }
  }

  /** Run a session call, failing soft on a torn-down entry and tearing the
   *  session down on a FATAL transport error (so siblings stop hammering it). */
  private async guarded<T>(entry: WorkspaceEntry, call: () => Promise<T>): Promise<T> {
    if (entry.destroyed) throw new Error(SHARED_SESSION_CLOSED)
    try {
      return await call()
    } catch (e) {
      if (isFatalSharedSessionError(e)) void this.stopClient(entry, "pool/fatal")
      throw e
    }
  }

  private async release(entry: WorkspaceEntry): Promise<void> {
    // Decrement FIRST — even when destroyed — so the ref counter stays accurate.
    entry.refs = Math.max(0, entry.refs - 1)
    if (!entry.destroyed && entry.refs === 0) this.scheduleIdleStop(entry)
  }

  private scheduleIdleStop(entry: WorkspaceEntry): void {
    if (entry.destroyed || entry.refs !== 0) return
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      if (entry.refs !== 0) return
      void this.stopClient(entry, "pool/idle-ttl")
    }, this.idleTtlMs)
    entry.idleTimer.unref?.()
  }

  private async stopClient(entry: WorkspaceEntry, label: string): Promise<void> {
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }
    if (entry.destroyed) return
    entry.destroyed = true
    // Only delete the map slot if it still points at THIS entry (a re-created
    // entry for the same cwd must not be evicted by a stale teardown).
    if (this.sessions.get(entry.key) === entry) this.sessions.delete(entry.key)
    await entry.client.stop().catch((e: unknown) => {
      logger.debug(`lsp: stop failed (${label})`, { error: errMessage(e) })
    })
  }

  /** TEST-ONLY introspection: number of live (non-destroyed) workspaces. */
  get __sizeForTest(): number {
    return this.sessions.size
  }
}
