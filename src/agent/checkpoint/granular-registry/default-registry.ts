/**
 * Pure in-memory `GranularRegistryPort` impl. See `./port.ts` for the
 * full contract — this file mirrors the `conversation-checkpoint.ts`
 * implementation posture (Map-based LRU, no I/O, no-throw).
 */

import type { Message } from "@/llm"
import type {
  GranularRegistryOpts,
  GranularRegistryPort,
  RecordResult,
  ToolSnapshot,
  ToolSnapshotMeta,
} from "./port"

const DEFAULT_MAX_ENTRIES = 50
const DEFAULT_MAX_FILES_PER_SNAP = 20
const DEFAULT_MAX_BYTES_PER_SNAP = 5 * 1024 * 1024

/** Sum of UTF-16 code-unit lengths across all content strings. We use
 *  `.length` (not `Buffer.byteLength`) intentionally: no Node imports,
 *  deterministic on every runtime, and the cap is a soft sanity bound
 *  (not a precise filesystem-byte limit). */
const sumContentBytes = (files: ReadonlyMap<string, string>): number => {
  let total = 0
  for (const v of files.values()) total += v.length
  return total
}

/** Build a frozen snapshot record. The inner `filesBefore` Map is
 *  copy-constructed (so a caller mutating the original Map post-record
 *  cannot corrupt the snapshot) and the messages array is shallow-
 *  frozen. Inner Message objects are NOT deep-frozen (matches
 *  `ConversationCheckpointStore` posture). */
const freezeSnap = (snap: ToolSnapshot): ToolSnapshot => {
  const filesCopy = new Map<string, string>()
  for (const [k, v] of snap.filesBefore) filesCopy.set(k, v)
  return {
    toolCallId: snap.toolCallId,
    turn: snap.turn,
    takenAt: snap.takenAt,
    filesBefore: filesCopy,
    taskMessagesBefore: Object.freeze(snap.taskMessagesBefore.slice()) as ReadonlyArray<Message>,
  }
}

/**
 * Construct the default in-memory registry. Pure — construction performs
 * NO I/O and spawns NO background work; the returned port is safe to
 * leave un-wired (every method is a no-op on an empty store).
 */
export const defaultGranularRegistry = (opts?: GranularRegistryOpts): GranularRegistryPort => {
  const maxEntries = Math.max(1, opts?.maxEntries ?? DEFAULT_MAX_ENTRIES)
  const maxFilesPerSnap = Math.max(0, opts?.maxFilesPerSnap ?? DEFAULT_MAX_FILES_PER_SNAP)
  const maxBytesPerSnap = Math.max(0, opts?.maxBytesPerSnap ?? DEFAULT_MAX_BYTES_PER_SNAP)
  const now = opts?.now ?? Date.now

  // Map preserves insertion order; we use that for LRU. Replacement is
  // `delete + set` so the entry moves to the newest position.
  const store = new Map<string, ToolSnapshot>()

  const evictIfOver = (): void => {
    while (store.size > maxEntries) {
      const oldestKey = store.keys().next().value
      if (oldestKey === undefined) break
      store.delete(oldestKey)
    }
  }

  return {
    record(snap) {
      if (snap.filesBefore.size > maxFilesPerSnap) {
        return { ok: false, reason: "over-cap" } satisfies RecordResult
      }
      if (sumContentBytes(snap.filesBefore) > maxBytesPerSnap) {
        return { ok: false, reason: "over-cap" } satisfies RecordResult
      }
      // Caller-supplied snapshot may already carry a `takenAt`; we
      // overwrite with the injected clock so test injection is SSOT.
      const frozen = freezeSnap({
        toolCallId: snap.toolCallId,
        turn: snap.turn,
        takenAt: now(),
        filesBefore: snap.filesBefore,
        taskMessagesBefore: snap.taskMessagesBefore,
      })
      if (store.has(frozen.toolCallId)) store.delete(frozen.toolCallId)
      store.set(frozen.toolCallId, frozen)
      evictIfOver()
      return { ok: true } satisfies RecordResult
    },

    restore(toolCallId) {
      const snap = store.get(toolCallId)
      return snap === undefined ? null : snap
    },

    list() {
      // Map iteration is oldest→newest; surface newest-first.
      const out: ToolSnapshotMeta[] = []
      for (const s of store.values()) {
        out.push({ toolCallId: s.toolCallId, turn: s.turn, takenAt: s.takenAt })
      }
      out.reverse()
      return out
    },

    clear() {
      store.clear()
    },
  }
}
