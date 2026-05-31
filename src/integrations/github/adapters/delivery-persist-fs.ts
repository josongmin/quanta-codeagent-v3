/**
 * Real-filesystem adapter for {@link DeliveryPersistPort} (T12, audit L9 H9).
 *
 * This lives in the `adapters/` subdirectory — OUTSIDE the github slice's
 * static import fence (ADR-0311 scans only top-level slice files) — precisely
 * because it is the infrastructure boundary that touches `node:fs` and the
 * shared atomic-write primitive. The pure dedup store in `../idempotency`
 * depends only on the injected port; this is the one concrete wiring of it.
 */
import { readFile } from "node:fs/promises"

import { writeFileAtomic } from "@/storage"
import type { DeliveryPersistPort } from "../idempotency"

/** Real-fs persistence: lazy read of a JSON `string[]`, atomic write on save.
 *  A missing / corrupt file loads as empty (best-effort durability — a torn
 *  dump must not crash the webhook boot). */
export const defaultDeliveryPersist: DeliveryPersistPort = {
  async load(path) {
    let raw: string
    try {
      raw = await readFile(path, "utf8")
    } catch {
      return [] // ENOENT / EACCES on first boot — start empty.
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter((x): x is string => typeof x === "string" && x.length > 0)
    } catch {
      return [] // torn / non-JSON dump — degrade to empty, do not throw.
    }
  },
  async save(path, ids) {
    await writeFileAtomic(path, JSON.stringify([...ids]))
  },
}
