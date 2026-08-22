/**
 * ADR-0311 / ADR-0313 — Delivery dedup + idempotency key derivation.
 *
 * Two concerns, one file:
 *   1. Delivery store — set-like, bounded (default 1024 entries, FIFO
 *      eviction). Two flavours:
 *        - {@link createDeliveryStore}: pure in-memory (ephemeral processes).
 *        - {@link createDurableDeliveryStore}: lazy-hydrated from disk +
 *          best-effort atomic persist on every new id (audit L9 H9). This is
 *          the flavour the webhook server (a long-lived process) MUST use so
 *          delivery-id dedup state survives a restart — otherwise a GitHub
 *          re-delivery (`X-GitHub-Delivery` reused) re-fires the trigger that
 *          dedup exists to suppress.
 *   2. `computeIdempotencyKey(deliveryId, action)` — sha256 truncated to 16
 *      hex chars. Stable across processes; embedded in outgoing comment
 *      bodies as `<!-- quanta:idempotency=<key> -->`.
 */

import { createHash } from "node:crypto"

import { defaultDeliveryPersist } from "./adapters/delivery-persist-fs"
import { asIdempotencyKey, type IdempotencyKey } from "./types"

const DEFAULT_MAX_ENTRIES = 1024

export interface DeliveryStore {
  has(deliveryId: string): boolean
  add(deliveryId: string): void
  /** Snapshot — used by the file-persisted variant before save. */
  snapshot(): readonly string[]
}

export interface DeliveryStoreOpts {
  readonly maxEntries?: number
  /**
   * Optional initial seed (e.g. from a previous on-disk dump). Validated
   * shape; non-strings ignored.
   */
  readonly seed?: readonly string[]
}

/** Mutable membership core shared by both flavours. */
const makeBoundedSet = (cap: number, seed: readonly string[] | undefined) => {
  const m = new Map<string, true>()
  /** Returns true when `id` was newly inserted (i.e. NOT a duplicate). */
  const add = (id: string): boolean => {
    if (typeof id !== "string" || id.length === 0) return false
    if (m.has(id)) return false
    if (m.size >= cap) {
      const oldest = m.keys().next().value
      if (oldest !== undefined) m.delete(oldest)
    }
    m.set(id, true)
    return true
  }
  if (seed) for (const id of seed) add(id)
  return {
    add,
    has: (id: string): boolean => m.has(id),
    snapshot: (): readonly string[] => [...m.keys()],
  }
}

/**
 * Create a bounded, **in-memory** delivery-id dedup store. Caps at `maxEntries`
 * (default 1024) with FIFO eviction — insertion-order via `Map`. Loses all
 * state on process exit; use {@link createDurableDeliveryStore} for the
 * long-lived webhook path.
 */
export const createDeliveryStore = (opts: DeliveryStoreOpts = {}): DeliveryStore => {
  const cap = Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES)
  const core = makeBoundedSet(cap, opts.seed)
  return {
    has: core.has,
    add: (id) => {
      core.add(id)
    },
    snapshot: core.snapshot,
  }
}

/**
 * Persistence port — load the prior dump and atomically save a snapshot. The
 * default adapter ({@link defaultDeliveryPersist}) reads a JSON `string[]` and
 * writes it via the shared atomic-write primitive (tmp+rename). Injected so
 * unit tests can drive durability without touching the filesystem.
 */
export interface DeliveryPersistPort {
  load(path: string): Promise<readonly string[]>
  save(path: string, ids: readonly string[]): Promise<void>
}

/** The real-fs adapter for {@link DeliveryPersistPort} now lives in
 *  `./adapters/delivery-persist-fs` (outside the slice import fence, since it
 *  touches `node:fs` + the atomic-write primitive). Re-exported from the slice
 *  barrel; injected here as the default for {@link createDurableDeliveryStore}. */

export interface DurableDeliveryStore extends DeliveryStore {
  /** Resolves once the on-disk dump has been hydrated into memory. Until this
   *  resolves `has()` only reflects the constructor seed (NOT yet the disk
   *  state), so the webhook server should `await ready` before serving. */
  readonly ready: Promise<void>
  /** Force any pending best-effort save to complete and resolve. Tests await
   *  this to assert the on-disk dump deterministically; production callers can
   *  await it on graceful shutdown. */
  flush(): Promise<void>
}

export interface DurableDeliveryStoreOpts extends DeliveryStoreOpts {
  /** On-disk dump location. REQUIRED for the durable flavour — this is the
   *  whole point (audit L9 H9: a store that advertised `persistPath` but never
   *  touched disk was a false durability claim). */
  readonly persistPath: string
  /** Persistence seam (default real-fs atomic). */
  readonly persist?: DeliveryPersistPort
  /** Optional fault sink — surfaces a failed best-effort save instead of
   *  swallowing it silently. */
  readonly onError?: (message: string) => void
}

/**
 * Durable delivery-id dedup store (audit L9 H9). Hydrates from `persistPath`
 * at construction and persists the membership snapshot (atomic tmp+rename) on
 * every NEWLY-inserted id. Dedup state therefore survives a process restart:
 * a redelivered `X-GitHub-Delivery` is recognised after reboot and the trigger
 * is NOT re-fired.
 *
 * Save policy: best-effort + coalesced. A save in flight when a new id arrives
 * schedules exactly one follow-up save (so a burst of deliveries collapses to
 * at most two writes), and a save failure is surfaced via `onError` rather
 * than throwing into the request path. `flush()` drains pending saves.
 */
export const createDurableDeliveryStore = (
  opts: DurableDeliveryStoreOpts,
): DurableDeliveryStore => {
  const cap = Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES)
  const persist = opts.persist ?? defaultDeliveryPersist
  const core = makeBoundedSet(cap, opts.seed)

  let saving: Promise<void> | null = null
  let dirtyDuringSave = false

  const runSave = async (): Promise<void> => {
    try {
      // Audit R2 H-R2-1: wait for disk hydration before snapshotting. An add()
      // that races ahead of load() would otherwise persist a PARTIAL set (only
      // the freshly-added id) and atomically clobber the on-disk dump, losing
      // every prior id across a restart → suppressed deliveries re-fire. `ready`
      // self-catches load errors, so this never throws here.
      await ready
      await persist.save(opts.persistPath, core.snapshot())
    } catch (e) {
      opts.onError?.(
        `github.idempotency.persist.save failed (${opts.persistPath}): ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  const drive = async (): Promise<void> => {
    // Coalesce: while a save runs, mark dirty; loop until no new writes queued.
    do {
      dirtyDuringSave = false
      await runSave()
    } while (dirtyDuringSave)
    saving = null
  }

  const scheduleSave = (): void => {
    if (saving !== null) {
      dirtyDuringSave = true
      return
    }
    saving = drive()
  }

  const ready = persist
    .load(opts.persistPath)
    .then((ids) => {
      for (const id of ids) core.add(id)
    })
    .catch((e) => {
      opts.onError?.(
        `github.idempotency.persist.load failed (${opts.persistPath}): ${e instanceof Error ? e.message : String(e)}`,
      )
    })

  return {
    ready,
    has: core.has,
    add: (id) => {
      if (core.add(id)) scheduleSave()
    },
    snapshot: core.snapshot,
    async flush() {
      await ready
      // Ensure a final save reflecting the latest membership, then drain any
      // in-flight chain.
      scheduleSave()
      while (saving !== null) await saving
    },
  }
}

/**
 * Derive a stable, short idempotency key from `(deliveryId, action)`. SHA-256
 * truncated to 16 hex chars (64 bits) — collision-resistant for the volume of
 * GH deliveries per repo (millions per year still <2^-30 collision).
 *
 * The result is branded ({@link IdempotencyKey}) so the sink can't accept an
 * arbitrary string as a key.
 */
export const computeIdempotencyKey = (deliveryId: string, action: string): IdempotencyKey => {
  const safeDelivery = typeof deliveryId === "string" ? deliveryId : ""
  const safeAction = typeof action === "string" ? action : ""
  const digest = createHash("sha256").update(`${safeDelivery}:${safeAction}`).digest("hex")
  return asIdempotencyKey(digest.slice(0, 16))
}
