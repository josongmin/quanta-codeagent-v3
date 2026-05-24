/** Shadow-store tools (ADR-0119 + ADR-0122 + ADR-0201) — agent-level (NOT in defaultTools).
 *  The assembly layer registers them ONLY when the corresponding port is set,
 *  mirroring `branch_search` from ADR-0083. */
import type { ShadowOdb } from "@/storage/shadow-odb"
import type { Tool } from "../types"
import { forkSessionTool, type SessionForkerLike } from "./fork"
import { shadowRestorePartialTool } from "./restore-partial"
import { shadowRewindTool } from "./rewind"
import { shadowSnapshotsTool } from "./snapshots"

export {
  type ForkSessionInput,
  forkSessionInputSchema,
  forkSessionTool,
  type SessionForkerLike,
} from "./fork"
export {
  type ShadowRestorePartialInput,
  shadowRestorePartialInputSchema,
  shadowRestorePartialTool,
} from "./restore-partial"
export {
  type ShadowRewindInput,
  shadowRewindInputSchema,
  shadowRewindTool,
} from "./rewind"
export {
  type ShadowSnapshotsInput,
  shadowSnapshotsInputSchema,
  shadowSnapshotsTool,
} from "./snapshots"

/** Build the shadow tools wired to a `ShadowOdb` port. Order: read-only first
 *  (snapshots), then destructive (restore_partial → rewind). Matches `gitTools`
 *  convention of read-only-first; `restore_partial` precedes `rewind` because
 *  it is the more-surgical of the two destructive operations. */
export const shadowTools = (odb: ShadowOdb): Tool[] => [
  shadowSnapshotsTool(odb) as Tool,
  shadowRestorePartialTool(odb) as Tool,
  shadowRewindTool(odb) as Tool,
]

/** ADR-0201 — build the `fork_session` tool when a `SessionForker` port is
 *  supplied. Returned as a SINGLE-element array (or empty) so the assembly
 *  composer can spread it into the registry without conditionals. Default-OFF:
 *  no forker ⇒ empty ⇒ tool not registered ⇒ byte-identical. */
export const forkSessionTools = (forker: SessionForkerLike | undefined): Tool[] =>
  forker === undefined ? [] : [forkSessionTool(forker) as Tool]
