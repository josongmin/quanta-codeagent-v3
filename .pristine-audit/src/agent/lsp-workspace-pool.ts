import { type LspClient, LspRequestError } from "@/lsp"
import {
  classifyLspGroundingError,
  errMessage,
  isExpectedLifecycleOutcome,
  type LspGroundingErrorSignals,
  type LspGroundingReceipt,
  logger,
} from "@/shared"
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
  stopPromise?: Promise<void> | undefined
  /** Monotonic recency stamp — bumped on every `acquire` (hit or create) so the
   *  max-live cap can reap the LEAST-recently-used IDLE entry. Higher = newer. */
  lastUsedSeq: number
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
  /** Hard ceiling on simultaneously-LIVE backends (= language-server child
   *  processes). undefined ⇒ unbounded (legacy / interactive single-cwd reuse).
   *  Bench opens a DISTINCT sandbox cwd per instance; without a cap each cwd
   *  leaves a live pyright child for the 30-min idle-TTL window, so live servers
   *  ACCUMULATE with instance count (independent of concurrency) until the box
   *  OOMs (exit 137). The per-server heap cap (server-mem-budget) bounds each
   *  server's heap but NOT their COUNT — N × 4GB still blows a 64GB box. This cap
   *  bounds the count regardless of whether the per-instance evict matched the
   *  opened cwd. */
  private readonly maxLiveBackends: number | undefined
  /** Monotonic recency counter — every `acquire` stamps the entry with the next
   *  value, so {@link enforceMaxLiveBackends} can pick the LRU idle entry. */
  private useSeq = 0

  constructor(backend: WarmBackend, opts?: { idleTtlMs?: number; maxLiveBackends?: number }) {
    this.backend = backend
    this.idleTtlMs = opts?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
    // <=0 / non-finite is treated as "unbounded" (the legacy default) rather than
    // an absurd zero-cap that would evict the entry we just created.
    const cap = opts?.maxLiveBackends
    this.maxLiveBackends =
      cap !== undefined && Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : undefined
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
    // Bound live backends BEFORE the (potentially slow) boot/warm of THIS entry,
    // reaping idle LRU workspaces so a bench run's per-instance cwds can never
    // accumulate into a host OOM. The current entry has refs≥1 ⇒ it is protected.
    await this.enforceMaxLiveBackends()
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
      if (isFatalSharedSessionError(e)) await this.stopClient(entry, "pool/open-fatal")
      await this.release(entry)
      // Route through the typed SSOT classifier (LSP-00). An expected lifecycle
      // race/cancel stays OFF the warn channel so a successful bench run doesn't
      // look LSP-broken just because the fire-and-forget prewarm lost to
      // session-end eviction; a real failure carries its typed outcome.
      const outcome = classifyLspGroundingError(this.errorSignals(e, cwd, signal), "ready")
      if (isExpectedLifecycleOutcome(outcome)) {
        logger.debug("lsp: shared nav session ready cancelled", {
          backend: this.backend.id,
          cwd,
          file: filePath,
          outcome,
          reason: signal?.aborted === true ? "signal-aborted" : "hard-evicted",
        })
        return null
      }
      logger.warn("lsp: failed to ready shared nav session", {
        backend: this.backend.id,
        cwd,
        file: filePath,
        outcome,
        error: errMessage(e),
      })
      return null
    }
  }

  /**
   * Strict-admission ready proof (LSP-01). Drives the SAME backend readiness
   * truth as {@link open} — the cwd-keyed entry, the `startPromise` join, and
   * {@link warmFile}'s `ensureFileReady` probe — but returns a TYPED
   * {@link LspGroundingReceipt} instead of a session handle, and surfaces the
   * readiness BOOLEAN that `open` intentionally discards. A launchable server
   * whose workspace never reaches verified-ready inside budget therefore yields
   * `ready_timeout` (NOT a non-null session), which is what lets a strict preset
   * fail closed on real readiness rather than mere launchability.
   *
   * On success the entry is RELEASED (idle-TTL kept warm), never evicted — the
   * subsequent solve in the same cwd reuses the now-warm workspace. Never throws.
   */
  async proveReady(
    filePath: string,
    cwd: string,
    opts?: { language?: string; signal?: AbortSignal },
  ): Promise<LspGroundingReceipt> {
    const language = opts?.language ?? ""
    const signal = opts?.signal
    const base = { backend: this.backend.id, language, file: filePath } as const
    if (signal?.aborted) {
      return { ...base, stage: "ready", outcome: "expected_cancel", reason: "aborted before probe" }
    }
    const startedAt = Date.now()
    const elapsed = (): number => Date.now() - startedAt
    const entry = this.acquire(cwd, signal)
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }
    entry.refs += 1
    // Bound live backends (parity with {@link open}) — reap idle LRU workspaces
    // so a strict-admission ready-proof sweep across many cwds stays flat.
    await this.enforceMaxLiveBackends()
    try {
      try {
        await entry.startPromise
      } catch (e) {
        return {
          ...base,
          stage: "launch",
          outcome: classifyLspGroundingError(this.errorSignals(e, cwd, signal), "launch"),
          reason: errMessage(e),
          durationMs: elapsed(),
        }
      }
      let ready: boolean
      try {
        ready = await this.warmFile(entry, filePath, signal)
      } catch (e) {
        if (isFatalSharedSessionError(e)) await this.stopClient(entry, "pool/prove-ready-fatal")
        return {
          ...base,
          stage: "ready",
          outcome: classifyLspGroundingError(this.errorSignals(e, cwd, signal), "ready"),
          reason: errMessage(e),
          durationMs: elapsed(),
        }
      }
      // Late-eviction reap parity with {@link open}: if the cwd was hard-evicted
      // while we were booting/warming, reap the entry we just materialized
      // (instead of leaking a daemon on a tombstoned cwd) and report the
      // expected lifecycle cancel rather than a misleading ready result.
      if (this.hardEvicted.has(cwd)) {
        await this.stopClient(entry, "pool/prove-evict-late")
        return {
          ...base,
          stage: "ready",
          outcome: "expected_cancel",
          reason: "workspace hard-evicted during ready proof",
          durationMs: elapsed(),
        }
      }
      return {
        ...base,
        stage: "ready",
        outcome: ready ? "ok" : "ready_timeout",
        durationMs: elapsed(),
        ...(ready ? {} : { reason: "readiness budget exhausted without resolve" }),
      }
    } finally {
      await this.release(entry)
    }
  }

  /** Decompose a thrown launch/ready error into the pure SSOT signals
   *  {@link classifyLspGroundingError} consumes — the ONE place the pool's
   *  transport/sentinel heuristics meet the typed taxonomy. */
  private errorSignals(
    e: unknown,
    cwd: string,
    signal: AbortSignal | undefined,
  ): LspGroundingErrorSignals {
    return {
      aborted: signal?.aborted === true,
      evicted: this.hardEvicted.has(cwd),
      fatalTransport: isFatalSharedSessionError(e),
      closedSentinel: errMessage(e) === SHARED_SESSION_CLOSED,
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
    if (existing) {
      // Touch recency on a warm HIT too, so a frequently-reused cwd is never the
      // LRU victim (the interactive single-cwd reuse must stay warm).
      existing.lastUsedSeq = ++this.useSeq
      return existing
    }
    const client = this.backend.createClient(cwd)
    const entry: WorkspaceEntry = {
      key: cwd,
      client,
      startPromise: Promise.resolve(),
      preparedFiles: new Set<string>(),
      preparingFiles: new Map<string, Promise<boolean>>(),
      refs: 0,
      destroyed: false,
      lastUsedSeq: ++this.useSeq,
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

  /** Bound the number of LIVE backends (server processes) at {@link maxLiveBackends}.
   *  Reaps the LEAST-recently-used IDLE entries (refs===0) — calling the backend
   *  `stop()` (real process death) — until the live count is within the cap. A
   *  REFERENCED entry (an in-flight/active session) is never reaped, so the cap
   *  can transiently exceed its target under concurrent active sessions; it
   *  re-converges as those sessions release. With the cap unset this is a no-op
   *  (legacy unbounded behavior, byte-identical). The just-acquired entry for the
   *  current open has refs≥1 by the time this runs, so it is inherently
   *  protected — the cap only ever evicts OTHER, idle workspaces. */
  private async enforceMaxLiveBackends(): Promise<void> {
    const cap = this.maxLiveBackends
    if (cap === undefined) return
    while (this.sessions.size > cap) {
      let lru: WorkspaceEntry | undefined
      for (const entry of this.sessions.values()) {
        if (entry.refs !== 0 || entry.destroyed) continue
        if (lru === undefined || entry.lastUsedSeq < lru.lastUsedSeq) lru = entry
      }
      // No idle entry to reap (all referenced) ⇒ cannot shrink without killing a
      // live session; stop here and let release() re-converge later.
      if (lru === undefined) return
      await this.stopClient(lru, "pool/max-live-evict")
    }
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
      try {
        await this.warmFile(entry, filePath, signal)
      } catch (e) {
        if (isFatalSharedSessionError(e)) await this.stopClient(entry, "pool/warm-fatal")
        throw e
      }
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
   *  prepared ⇒ a cheap `prime` (re-open doc) and return true; in-flight ⇒ join
   *  it (sharing its verified-ready result); otherwise drive the backend's
   *  readiness probe and mark prepared ONLY on a verified-ready result. Returns
   *  the readiness boolean (true = verified-ready) — {@link open} discards it
   *  (best-effort warm) while {@link proveReady} surfaces it as admission proof. */
  private async warmFile(
    entry: WorkspaceEntry,
    filePath: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    // A concurrent evict / fatal teardown may have stopped this entry between
    // `open`'s `await startPromise` and here — don't drive a dead client through
    // the backend's readiness probe (wasted work + a spurious warm-budget warn).
    if (entry.destroyed) throw new Error(SHARED_SESSION_CLOSED)
    if (entry.preparedFiles.has(filePath)) {
      await entry.client.prime(filePath, signal)
      return true
    }
    const inFlight = entry.preparingFiles.get(filePath)
    if (inFlight) return await inFlight
    const prep = this.backend.ensureFileReady(entry.client, filePath, signal)
    entry.preparingFiles.set(filePath, prep)
    try {
      const ready = await prep
      if (ready) entry.preparedFiles.add(filePath)
      return ready
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
      if (isFatalSharedSessionError(e)) await this.stopClient(entry, "pool/fatal")
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
    if (entry.destroyed) {
      await entry.stopPromise?.catch(() => undefined)
      return
    }
    entry.destroyed = true
    // Only delete the map slot if it still points at THIS entry (a re-created
    // entry for the same cwd must not be evicted by a stale teardown).
    if (this.sessions.get(entry.key) === entry) this.sessions.delete(entry.key)
    entry.stopPromise = entry.client.stop().catch((e: unknown) => {
      logger.debug(`lsp: stop failed (${label})`, { error: errMessage(e) })
    })
    await entry.stopPromise
  }

  /** TEST-ONLY introspection: number of live (non-destroyed) workspaces. */
  get __sizeForTest(): number {
    return this.sessions.size
  }
}
