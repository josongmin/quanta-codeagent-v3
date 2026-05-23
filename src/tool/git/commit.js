/** `git_commit` — Claude Desktop 1.7196.3 `commitWipForBranchSwitch` pattern
 *  absorption. Two modes:
 *
 *    • mode="regular" (default): `git add <paths|.> && git commit -m <msg>`.
 *      Tier = "always-confirm" — this commit can be pushed; permanent.
 *    • mode="wip": session-boundary checkpoint. Auto-generates `wip: <ts>`
 *      message when caller omits one, stages everything, but does NOT pass
 *      `--no-verify` so hooks still run. Tier = "pre-approval-ok" — reversible
 *      checkpoint that user trust-scope eligibly elides per HITL 4-tier.
 *
 *  All git invocations are argv-based (`Bun.spawn(['git', ...args])` via the
 *  injected `GitRunner`), so a commit message with shell metacharacters is
 *  carried as a single argv slot — no shell expansion. */
import { mutate } from "./_shared";
import { gitCommitInputSchema } from "./types";
/** Build the auto-generated `wip:` message when the caller did not supply one.
 *  Format: `wip: <ISO timestamp>` — short enough to read in `git log` but
 *  stable enough to surface in a diff against the prior session boundary. */
const autoWipMessage = () => `wip: ${new Date().toISOString()}`;
const buildAddArgs = (paths) => {
    if (paths && paths.length > 0)
        return ["add", "--", ...paths];
    return ["add", "--", "."];
};
/** Resolve the final commit message based on mode. Returns either the message
 *  string or an `err` shape the caller yields as the terminal result. */
const resolveMessage = (mode, message) => {
    if (mode === "wip") {
        const value = message && message.length > 0 ? message : autoWipMessage();
        return { ok: true, value };
    }
    if (!message || message.length === 0) {
        return { ok: false, output: "regular commit requires a non-empty message" };
    }
    return { ok: true, value: message };
};
export const gitCommitTool = (runner) => ({
    name: "git_commit",
    description: "Create a git commit. mode='regular' (default) stages + commits as a permanent commit; mode='wip' stages all files + auto-generates a session-boundary checkpoint message.",
    inputSchema: gitCommitInputSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    hitlTier: (input) => input.mode === "wip" ? "pre-approval-ok" : "always-confirm",
    async *execute(input, ctx) {
        const parsed = gitCommitInputSchema.safeParse(input);
        if (!parsed.success) {
            yield {
                type: "result",
                result: { ok: false, output: `invalid input: ${parsed.error.message}` },
            };
            return;
        }
        const { message, mode, paths } = parsed.data;
        const effectiveMode = mode ?? "regular";
        // Resolve message — wip auto-generates when absent; regular requires it.
        const resolved = resolveMessage(effectiveMode, message);
        if (!resolved.ok) {
            yield { type: "result", result: { ok: false, output: resolved.output } };
            return;
        }
        const finalMessage = resolved.value;
        // Stage.
        yield { type: "progress", message: "git add" };
        const addArgs = buildAddArgs(paths);
        const addOut = await mutate(runner, addArgs, ctx.cwd, "git add", ctx.signal);
        if (addOut.kind === "err") {
            yield { type: "result", result: { ok: false, output: addOut.output } };
            return;
        }
        // Commit. Argv-based — `finalMessage` is one slot, no shell expansion.
        yield { type: "progress", message: "git commit" };
        const commitArgs = ["commit", "-m", finalMessage];
        const commitOut = await mutate(runner, commitArgs, ctx.cwd, "git commit", ctx.signal);
        if (commitOut.kind === "err") {
            yield { type: "result", result: { ok: false, output: commitOut.output } };
            return;
        }
        yield {
            type: "result",
            result: {
                ok: true,
                output: `committed (${effectiveMode}): ${finalMessage}`,
            },
        };
    },
});
