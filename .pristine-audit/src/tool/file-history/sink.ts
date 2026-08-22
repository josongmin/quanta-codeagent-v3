/**
 * file_history_rewind — store→sink adapter.
 *
 * Wraps a {@link FileHistoryStore} as the duck-typed `FileHistorySink` the
 * write/edit capture helper calls. The adapter does the path resolution: it
 * jails `path` against `cwd` through the SAME `@/storage#resolveJailed`
 * chokepoint the `file_history_rewind` tool uses, so the key it records under
 * is byte-identical to the key the tool resolves on list/restore (relative vs
 * absolute spelling collapses to one absolute key).
 *
 * NO-THROW by contract: an escaping path (jail rejection) is silently dropped —
 * the file mutation that triggered the capture already succeeded, and a capture
 * failure must never surface as a tool failure. (Defense in depth: the
 * mutating tool itself already rejected an escaping write before the bytes
 * landed, so this branch is only reachable for a path the FS port jailed
 * differently — we record nothing rather than key under a half-resolved path.)
 *
 * The host composition root constructs ONE store + ONE adapter per session and
 * passes the SAME store to `makeFileHistoryRewindTool` (so the tool reads what
 * the sink wrote). Default-OFF: built only when `QUANTA_FILE_HISTORY` is on.
 */

import { resolveJailed } from "@/storage"
import type { FileHistorySink } from "../types"
import type { FileHistoryStore } from "./store"

export const createFileHistorySink = (store: FileHistoryStore): FileHistorySink => ({
  record({ path, cwd, content }) {
    let key: string
    try {
      key = resolveJailed(path, cwd)
    } catch {
      // Escaping / unresolvable path — drop the capture (NO-THROW). The mutation
      // already succeeded; we simply do not record an out-of-jail key.
      return
    }
    store.record(key, content)
  },
})
