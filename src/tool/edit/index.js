import { z } from "zod";
import { defaultFileSystemPort, FsJailError } from "@/storage";
import { gitWriteGuardDeny } from "../git-write-guard-result";
import { applyExactEdit } from "./exact";
import { applyFuzzyEdit } from "./fuzzy";
import { classifyMismatch, formatEditMismatchMarker, formatStrategyHint } from "./strategy-hint";
const schema = z.object({
    path: z.string().describe("File path to edit"),
    old_string: z.string().describe("Exact text to replace (must be unique unless replace_all)"),
    new_string: z.string().describe("Replacement text"),
    replace_all: z.boolean().optional().describe("Replace every occurrence (default false)"),
    fuzzy: z
        .boolean()
        .optional()
        .describe("If exact match fails, retry with whitespace-tolerant fuzzy matching (default false)"),
});
/** Build the `ok:false` mismatch `ToolResult` when neither the exact nor the
 *  fuzzy edit applied. Extracted from `execute` (pure: no I/O) so the generator
 *  body stays flat. Phase-4 strategy-hint semantics are unchanged — it
 *  classifies via the structural `result.kind` tag when present and appends the
 *  stable `[edit-mismatch:<kind>]` marker so out-of-process consumers can
 *  recover the kind without re-sniffing the message text. */
const buildMismatchResult = (result, path) => {
    const next = classifyMismatch(result.kind !== undefined ? { kind: result.kind } : result.message);
    const hint = formatStrategyHint(next);
    const marker = result.kind !== undefined ? ` ${formatEditMismatchMarker(result.kind)}` : "";
    // The old_string did not match: the target text was not found in the file.
    // Typed as `not_found` so the model branches to re-read / fuzzy instead of
    // regex-sniffing the hint text. `output` is unchanged (byte-identical).
    return {
        ok: false,
        output: `${result.message}${marker}\n\n${hint}`,
        failure: { mode: "not_found", path },
    };
};
/** Build the `edit` tool against an injected {@link FileSystemPort} (#13).
 *  `fs` defaults to the real `@/storage`-backed port, so the exported
 *  {@link editTool} is byte-identical to the pre-port direct-call version;
 *  tests pass an in-memory port for isolation. */
export const makeEditTool = (fs = defaultFileSystemPort) => ({
    name: "edit",
    description: "Exact string replacement in an existing file. old_string must match verbatim.",
    inputSchema: schema,
    isReadOnly: () => false,
    // Mutates the filesystem; conservatively never run concurrently.
    isConcurrencySafe: () => false,
    // HITL secure-by-default (ADR-0020 follow-up): targeted edit on an
    // existing file is reversible-in-VCS — pre-approval covers it. Required
    // explicit opt-in since the fallback for mutating tools is now
    // `always-confirm`.
    hitlTier: () => "pre-approval-ok",
    async *execute(input, ctx) {
        // ADR-0091 git-write-protection: an edit targeting `.git/{hooks,config,
        // config.worktree,info/attributes}` or `.vscode/**` is a code-execution /
        // policy-escape vector. Static-deny BEFORE the read, mirroring the
        // FsJailError hard-stop below — never a partial write. Default-OFF: absent
        // `ctx.gitWriteGuard` the helper returns null (byte-identical legacy path).
        const guardDeny = gitWriteGuardDeny(input.path, ctx);
        if (guardDeny) {
            yield guardDeny;
            return;
        }
        // Resolve relative paths against the session cwd, not process.cwd().
        // The jail check fires in readFile() (and again in writeFile()) BEFORE
        // any write, so a denied path is NEVER a partial write.
        try {
            const source = await fs.readFile(input.path, ctx.cwd);
            const replaceAll = input.replace_all ?? false;
            let result = applyExactEdit(source, input.old_string, input.new_string, replaceAll);
            if ((!result.ok || result.next === undefined) && input.fuzzy) {
                result = applyFuzzyEdit(source, input.old_string, input.new_string, replaceAll);
            }
            if (!result.ok || result.next === undefined) {
                // Phase 4: surface a structured next-strategy hint so the LLM can
                // switch to `scripted_replace` / re-read instead of re-trying the same
                // patch. Exit semantics unchanged (still ok:false). Built by the
                // extracted `buildMismatchResult` helper (keeps this generator flat).
                yield { type: "result", result: buildMismatchResult(result, input.path) };
                return;
            }
            await fs.writeFile(input.path, result.next, ctx.cwd);
            yield { type: "result", result: { ok: true, output: `${input.path}: ${result.message}` } };
        }
        catch (e) {
            if (e instanceof FsJailError) {
                yield {
                    type: "result",
                    result: {
                        ok: false,
                        output: e.message,
                        failure: { mode: "permission_denied", path: input.path, isReadonly: false },
                    },
                };
                return;
            }
            throw e;
        }
    },
});
/** Default-port `edit` tool used by the registry. */
export const editTool = makeEditTool();
