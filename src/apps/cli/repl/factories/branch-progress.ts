import {
  type BranchProgressTracker,
  createBranchProgressTracker,
} from "../../branch-search-progress"
import type { CliFeatureConfig } from "../cli-feature-config"

/** S3 branch-search progress tracker — built ONCE per session. Returns
 *  `undefined` when the env/TTY gate refuses so the `/branches` slash command
 *  keeps its existing "not wired" output (byte-identical). The tracker itself
 *  is empty-state until a search ingests events; the `/branches` panel prints
 *  "(no branch search recorded yet)" until that happens. */
export const buildBranchProgressOrUndefined = (
  featureCfg: CliFeatureConfig,
): BranchProgressTracker | undefined => {
  if (!featureCfg.branchProgress.enabled) return undefined
  return createBranchProgressTracker()
}
