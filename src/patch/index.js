// V4A apply_patch — public API barrel.
//
// Stable surface for consumers (agent / tool slice). Internal modules are
// not exported; cross-slice imports go through this file.
export { applyPatch } from "./applier.js";
export { parsePatch } from "./parser.js";
export { PatchAnchorNotFoundError, PatchApplyError, PatchParseError } from "./types.js";
