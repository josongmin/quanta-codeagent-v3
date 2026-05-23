// V4A apply_patch — type definitions.
//
// Reference: [[codex-v4a-patch-grammar]] (full EBNF).
// All grammar tokens are derived directly from that spec; magic strings live
// only here.
/** Literal sentinels from the V4A grammar (spec §EBNF). Single source of truth. */
export const PATCH_SENTINELS = {
    beginPatch: "*** Begin Patch",
    endPatch: "*** End Patch",
    addFile: "*** Add File: ",
    deleteFile: "*** Delete File: ",
    updateFile: "*** Update File: ",
    moveTo: "*** Move to: ",
    hunkHeader: "@@", // hunk anchor; "@@" alone or "@@ <context>"
    endOfFile: "*** End of File",
};
/** Line-level prefixes inside hunks / Add-File bodies (spec §change_line / §add_line). */
export const PATCH_LINE_PREFIX = {
    context: " ", // unchanged context
    delete: "-", // removed line
    insert: "+", // added line
};
/** Thrown by `parsePatch` on any grammar violation. Never swallowed. */
export class PatchParseError extends Error {
    lineNumber;
    constructor(message, lineNumber) {
        super(`Patch parse error at line ${lineNumber}: ${message}`);
        this.name = "PatchParseError";
        this.lineNumber = lineNumber;
    }
}
/** Thrown by `applyPatch` on a non-anchor apply failure (ambiguous ctx, missing file, etc.). */
export class PatchApplyError extends Error {
    path;
    hunkIndex;
    constructor(message, path, hunkIndex) {
        const suffix = hunkIndex !== undefined ? ` (hunk ${hunkIndex})` : "";
        super(`Patch apply error on ${path}${suffix}: ${message}`);
        this.name = "PatchApplyError";
        this.path = path;
        this.hunkIndex = hunkIndex;
    }
}
/**
 * Thrown when the hunk's context (context + delete lines) cannot be located
 * in the target file even after the deterministic fuzzy pass. Distinct from
 * `PatchApplyError` so callers can surface a "regenerate patch with fresh
 * context" message specifically.
 */
export class PatchAnchorNotFoundError extends Error {
    path;
    hunkIndex;
    constructor(path, hunkIndex, detail) {
        super(`Patch anchor not found in ${path} (hunk ${hunkIndex}): ${detail}`);
        this.name = "PatchAnchorNotFoundError";
        this.path = path;
        this.hunkIndex = hunkIndex;
    }
}
