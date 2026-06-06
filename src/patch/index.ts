// V4A apply_patch — public API barrel.
//
// Stable surface for consumers (agent / tool slice). Internal modules are
// not exported; cross-slice imports go through this file.

export { applyPatch } from "./applier"
export { parsePatch } from "./parser"
// ADR-0464 — additive, default-OFF structured per-file apply path. The
// throwing `applyPatch` above is unchanged; callers opt into `applyPatchStructured`
// to receive a Cursor-faithful per-file outcome instead of a wholesale throw.
export { applyPatchStructured, messageForModel } from "./structured"
export type { AppliedChange, ApplyChangeType, StructuredApplyOutcome } from "./structured-types"
export type {
  ApplyResult,
  Change,
  Hunk,
  Patch,
  PatchFileSystemPort,
  PatchObservation,
  PatchObserver,
  PatchOp,
  PatchTracePort,
} from "./types"
export { PatchAnchorNotFoundError, PatchApplyError, PatchParseError } from "./types"
