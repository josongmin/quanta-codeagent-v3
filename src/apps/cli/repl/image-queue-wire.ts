import { createImageQueue, type ImageQueue } from "../image-queue"
import { env } from "../internal"

/** Build the per-REPL multi-modal image queue (ADR-0083 extension). Default-ON
 *  with cap 5; `QUANTA_IMAGE_QUEUE=0` returns `undefined` so the surface
 *  short-circuits (`/image …` falls through to the surface-agnostic dispatcher
 *  which prints "unknown command"). Extracted from `runRepl` so the host stays
 *  under biome's cognitive-complexity budget. */
export const buildImageQueue = (): ImageQueue | undefined => {
  const imageQueueEnabled = env("QUANTA_IMAGE_QUEUE", "1") !== "0"
  if (!imageQueueEnabled) return undefined
  const raw = Number(env("QUANTA_IMAGE_MAX_QUEUE", "5"))
  return createImageQueue({
    maxSize: Number.isFinite(raw) && raw > 0 ? raw : 5,
  })
}
