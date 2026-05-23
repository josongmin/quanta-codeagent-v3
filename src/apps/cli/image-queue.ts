import type { ImageBlock } from "@/llm"

/**
 * Single-shot image queue for the CLI multi-modal entry point.
 *
 * Design:
 *   - Default-OFF compatible: an unused queue is a no-op (no images attach,
 *     no diff vs. today's text-only path).
 *   - Single-shot per turn: {@link ImageQueue.drain} atomically returns the
 *     current contents AND clears the queue. The REPL adapter calls `drain()`
 *     exactly once per `PromptSource.next()` invocation — images attach to
 *     THAT turn and ONLY that turn. The user re-queues with another
 *     `/image add <path>` if they want images on the next turn too.
 *   - Capacity cap: `QUANTA_IMAGE_MAX_QUEUE` (default 5). `add()` returns the
 *     reason for rejection so the slash handler can render a clear message;
 *     a silent drop would be a footgun ("why isn't my image attached?").
 *
 * The queue holds {@link ImageBlock}s already produced by `loadImageBlock`
 * (path validation + base64 encoding + 20MB cap). Path resolution and type
 * checking live in `image-loader.ts` (SRP: this module is a tiny FIFO that
 * holds already-validated blocks).
 */

export const IMAGE_QUEUE_DEFAULT_MAX = 5

export interface ImageQueueEntry {
  /** Original filesystem path passed to `/image add` — surfaced verbatim by
   *  `/image list` so the user sees what's currently queued. */
  readonly path: string
  /** The loaded block (base64 + mediaType — see `loadImageBlock`). */
  readonly block: ImageBlock
}

/** Add-result discriminant: `ok` ⇒ entry was queued; `over_cap` ⇒ the queue
 *  is already at its max and the add was REJECTED (no partial enqueue). */
export type AddResult =
  | { readonly kind: "ok" }
  | { readonly kind: "over_cap"; readonly cap: number }

export interface ImageQueue {
  add(entry: ImageQueueEntry): AddResult
  /** Snapshot of currently-queued entries. Returns a fresh array; mutating
   *  it has no effect on the queue (no aliasing). */
  list(): readonly ImageQueueEntry[]
  /** Empty the queue. Idempotent. */
  clear(): void
  size(): number
  /** Atomically return + clear. Single-shot drain semantics — every
   *  `PromptSource.next()` call invokes this exactly once. */
  drain(): readonly ImageQueueEntry[]
}

export interface ImageQueueOpts {
  /** Capacity cap. Defaults to {@link IMAGE_QUEUE_DEFAULT_MAX}. */
  readonly maxSize?: number
}

/**
 * Build a fresh in-memory image queue. Owned by the REPL surface (per-process
 * lifetime); a multi-tab Web/Tauri surface would allocate one per session.
 */
export const createImageQueue = (opts: ImageQueueOpts = {}): ImageQueue => {
  const cap =
    Number.isFinite(opts.maxSize) && (opts.maxSize ?? 0) > 0
      ? (opts.maxSize as number)
      : IMAGE_QUEUE_DEFAULT_MAX
  const items: ImageQueueEntry[] = []
  return {
    add(entry: ImageQueueEntry): AddResult {
      if (items.length >= cap) return { kind: "over_cap", cap }
      items.push(entry)
      return { kind: "ok" }
    },
    list(): readonly ImageQueueEntry[] {
      return items.slice()
    },
    clear(): void {
      items.length = 0
    },
    size(): number {
      return items.length
    },
    drain(): readonly ImageQueueEntry[] {
      if (items.length === 0) return []
      const out = items.slice()
      items.length = 0
      return out
    },
  }
}
