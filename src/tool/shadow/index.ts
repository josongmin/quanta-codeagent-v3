/** Shadow-store tools (ADR-0119) — agent-level (NOT in defaultTools). The
 *  assembly layer registers them ONLY when `AgentConfig.shadowOdb` is set,
 *  mirroring `branch_search` from ADR-0083. */
import type { ShadowOdb } from "@/storage/shadow-odb"
import type { Tool } from "../types"
import { shadowRewindTool } from "./rewind"
import { shadowSnapshotsTool } from "./snapshots"

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
 *  (snapshots), then mutating (rewind) — matches `gitTools` convention. */
export const shadowTools = (odb: ShadowOdb): Tool[] => [
  shadowSnapshotsTool(odb) as Tool,
  shadowRewindTool(odb) as Tool,
]
