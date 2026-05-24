// V4A apply_patch — public API barrel.
//
// Stable surface for consumers (agent / tool slice). Internal modules are
// not exported; cross-slice imports go through this file.

export { applyPatch } from "./applier"
export { parsePatch } from "./parser"
export type {
  ApplyResult,
  Change,
  Hunk,
  Patch,
  PatchFileSystemPort,
  PatchObservation,
  PatchObserver,
  PatchOp,
} from "./types"
export { PatchAnchorNotFoundError, PatchApplyError, PatchParseError } from "./types"
