import { z } from "zod";
import { runShell } from "@/runtime";
import { classifyCommandShape } from "@/security";
const schema = z.object({
    command: z.string().describe("Shell command to run via bash -lc"),
    timeout_ms: z.number().optional().describe("Timeout in ms (default 120000)"),
});
const MAX_OUTPUT = 30_000;
const CMD_PREVIEW = 80;
/** Local stderr-tail cap on `evidence.stderr`. Dispatch re-trims to its own
 *  smaller `STDERR_TAIL_CAP` (2000) as a defense-in-depth backstop, so this
 *  cap only bounds the per-tool attachment size. */
const STDERR_CAP = 4_000;
/* HITL tier patterns (Codex hitl-audit.md). HARD_DENY (RCE, root-rm, fork
 * bomb, …) is enforced upstream by @/permission and maps to hand-off-required
 * via the dispatch seam — bash itself only distinguishes "always-confirm"
 * (irreversible network egress + mutating git ops) from the default
 * "pre-approval-ok". `git -C <dir>` (capital C) is legit; only the listed
 * mutating subcommands escalate.
 *
 * SECURITY: the prefix matcher between `git` and the dangerous subcommand
 * must accept ALL legal git global-option forms — otherwise simple bypasses
 * like `git --no-pager push`, `git -C dir push`, `git -c k=v push`, and
 * `git --git-dir=. push` all look ordinary while sneaking past the gate. The
 * pattern below enumerates the three legal pre-subcommand token shapes:
 *   1. `-x` short option (with an optional operand: `-C dir`)
 *   2. `--long-option` (with optional `=value` or space-separated value)
 *   3. positional / env-prefix tokens (`FOO=1 git ... push`, environment
 *      already lives BEFORE `git` so this branch covers `git <subcommand>`
 *      where the matcher between is empty — i.e. zero global options at all)
 * Greedy zero-or-more of the three branches lets a chain of options through,
 * but the final mandatory subcommand boundary (`\bpush\b`, etc.) is what
 * actually identifies the dangerous call. */
const GIT_PREFIX = String.raw `(?:--[A-Za-z][A-Za-z0-9_-]*(?:=\S+)?\s+|-[A-Za-z](?:\s+\S+)?\s+|[^-\s]\S*\s+)*`;
const ALWAYS_CONFIRM_PATTERNS = [
    // Network egress: curl/wget/gh api/git push/git fetch.
    /\bcurl\b/,
    /\bwget\b/,
    /\bgh\s+api\b/,
    new RegExp(String.raw `\bgit\b\s+${GIT_PREFIX}push\b`),
    // `send-pack` is the low-level plumbing command behind `git push`; same
    // network egress, same irreversibility. A motivated bypass would reach for
    // it precisely because `push` is gated — escalate both paths identically.
    new RegExp(String.raw `\bgit\b\s+${GIT_PREFIX}send-pack\b`),
    // `git fetch` with NO remote argument fetches `origin` by default; `git
    // fetch upstream` is just as risky as `git fetch origin`. We deliberately
    // drop the `\borigin\b` requirement that previously narrowed this rule —
    // any fetch is a network egress that should ride the always-confirm tier.
    new RegExp(String.raw `\bgit\b\s+${GIT_PREFIX}fetch\b`),
    // Mutating git operations that are hard / impossible to undo locally.
    new RegExp(String.raw `\bgit\b\s+${GIT_PREFIX}commit\b[\s\S]*--amend\b`),
    new RegExp(String.raw `\bgit\b\s+${GIT_PREFIX}reset\b[\s\S]*--hard\b`),
];
/** Derive a TYPED {@link ToolFailure} from the existing `ShellResult` shape
 *  WITHOUT touching `runtime/shell.ts` (owned by another track). Only the two
 *  cases cleanly recoverable from `{exitCode, timedOut, stderr}`:
 *   - `timeout`: the runtime already flags `timedOut` — carry the deadline.
 *   - `spawn_error`: `bash -lc` exits 127 with `command not found` on stderr
 *     when the program can't be launched at all (Cursor `ShellSpawnError`). The
 *     127+stderr heuristic is the ONLY signal available without editing the
 *     runtime to surface a real spawn ENOENT; a script that legitimately exits
 *     127 without that stderr text is NOT misclassified.
 *  Any other non-zero exit stays a plain command failure (no `failure` field —
 *  byte-identical to the pre-migration result). */
const deriveBashFailure = (r, timeoutMs) => {
    if (r.timedOut) {
        return timeoutMs !== undefined ? { mode: "timeout", timeoutMs } : { mode: "timeout" };
    }
    if (r.exitCode === 127 && /command not found/i.test(r.stderr)) {
        return { mode: "spawn_error", error: r.stderr.trim().slice(-STDERR_CAP) || "command not found" };
    }
    return undefined;
};
const bashHitlTier = (input) => {
    const cmd = input.command ?? "";
    for (const pat of ALWAYS_CONFIRM_PATTERNS) {
        if (pat.test(cmd))
            return "always-confirm";
    }
    return "pre-approval-ok";
};
export const bashTool = {
    name: "bash",
    description: "Run a shell command (bash). Returns combined stdout/stderr and exit code. " +
        "Non-zero exit is reported, not thrown.",
    inputSchema: schema,
    isReadOnly: () => false,
    // Arbitrary shell side effects are unknowable; never run concurrently.
    isConcurrencySafe: () => false,
    hitlTier: bashHitlTier,
    // S16: expose the raw shell command so the permission policy applies the
    // HARD_DENY denylist UNIFORMLY to any tool that accepts a shell command,
    // not just one whose `name === "bash"`. A future sibling shell tool
    // (`shell`/`exec`/MCP `run`) only needs to set this method to opt into the
    // same gate.
    extractShellCommand: (input) => input.command ?? "",
    // PR-2 self-audit fix (ADR-0078): DECLARED source-class classifier. Pre-fix
    // this lived as a hard-coded `COMMAND_TOOL_NAMES` set in `dispatch.ts`; now
    // the tool that runs the shell command declares its own classification —
    // a future `shell`/`exec`/MCP `run` tool opts into Layer-1 redaction by
    // implementing this same method (in parallel to its `extractShellCommand`).
    classifySource: (input) => classifyCommandShape(input.command ?? ""),
    async *execute(input, ctx) {
        const cmd = input.command;
        const shown = cmd.length > CMD_PREVIEW ? `${cmd.slice(0, CMD_PREVIEW)}…` : cmd;
        yield { type: "progress", message: `running: ${shown}` };
        // PR-5 / ADR-0081: forward the optional shell-event observer through to
        // `runShell`. Absent (default) ⇒ buffered legacy path, byte-identical.
        const r = await runShell(cmd, {
            cwd: ctx.cwd,
            signal: ctx.signal,
            ...(input.timeout_ms ? { timeoutMs: input.timeout_ms } : {}),
            ...(ctx.onShellEvent ? { onShellEvent: ctx.onShellEvent } : {}),
        });
        let body = [r.stdout, r.stderr].filter(Boolean).join("\n").trimEnd();
        if (body.length > MAX_OUTPUT) {
            body = `${body.slice(0, MAX_OUTPUT)}\n… (truncated, ${body.length - MAX_OUTPUT} more chars)`;
        }
        const status = r.timedOut ? "timed out" : r.exitCode === 0 ? "exit 0" : `exit ${r.exitCode}`;
        // RFC-0002 §5.2 evidence. Attach via the typed `evidence` field (CR3:
        // no more duck-typed extras on ToolResult). Each subfield is conditional-
        // spread so `exactOptionalPropertyTypes` never sees `undefined`.
        const evidence = {
            ...(r.stderr ? { stderr: r.stderr.slice(-STDERR_CAP) } : {}),
            exitCode: r.exitCode,
        };
        // Typed failure on the ok:false path only (additive; `output`+`evidence`
        // unchanged). Conditional-spread so a plain non-zero exit stays
        // byte-identical (no `failure` key at all).
        const failure = deriveBashFailure(r, input.timeout_ms);
        yield {
            type: "result",
            result: {
                ok: r.exitCode === 0 && !r.timedOut,
                output: `[${status}]\n${body || "(no output)"}`,
                evidence,
                ...(failure ? { failure } : {}),
            },
        };
    },
};
