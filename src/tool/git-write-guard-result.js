/**
 * ADR-0091 git-write-protection shared deny helper for the `write`/`edit`
 * tools.
 *
 * Consults the duck-typed {@link ToolContext.gitWriteGuard} detector with the
 * tool's resolved target `path`. When the detector returns a non-null escape-
 * vector reason (`.git/hooks`, `.git/config{,.worktree}`, `.git/info/attributes`,
 * `.vscode/**`) this returns the terminal `ok:false` `ToolEvent` the tool must
 * yield (then `return`) BEFORE any filesystem call — mirroring the FsJailError
 * hard-stop posture so a denied write is NEVER a partial write. The model-facing
 * `output` and the typed `permission_denied` failure are constructed identically
 * for both tools (single source of truth).
 *
 * Returns `null` when the guard is unwired (`ctx.gitWriteGuard` absent —
 * DEFAULT-OFF, byte-identical legacy path) or the path is not an escape vector,
 * so the caller proceeds normally. Extracted into one function so neither tool
 * inlines the branch (keeps their `execute` cognitive-complexity flat).
 */
export const gitWriteGuardDeny = (path, ctx) => {
    const reason = ctx.gitWriteGuard?.(path);
    if (reason == null)
        return null;
    return {
        type: "result",
        result: {
            ok: false,
            output: `git-escape-vector denial: cannot write ${path} (${reason}); use a different path`,
            failure: { mode: "permission_denied", path },
        },
    };
};
