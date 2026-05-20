import { z } from "zod"
import { runShell } from "@/runtime"
import type { HITLTier, Tool, ToolContext, ToolEvent } from "../types"

const schema = z.object({
  command: z.string().describe("Shell command to run via bash -lc"),
  timeout_ms: z.number().optional().describe("Timeout in ms (default 120000)"),
})

type Input = z.infer<typeof schema>

const MAX_OUTPUT = 30_000
const CMD_PREVIEW = 80

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
const GIT_PREFIX = String.raw`(?:--[A-Za-z][A-Za-z0-9_-]*(?:=\S+)?\s+|-[A-Za-z](?:\s+\S+)?\s+|[^-\s]\S*\s+)*`

const ALWAYS_CONFIRM_PATTERNS: RegExp[] = [
  // Network egress: curl/wget/gh api/git push/git fetch.
  /\bcurl\b/,
  /\bwget\b/,
  /\bgh\s+api\b/,
  new RegExp(String.raw`\bgit\b\s+${GIT_PREFIX}push\b`),
  // `git fetch` with NO remote argument fetches `origin` by default; `git
  // fetch upstream` is just as risky as `git fetch origin`. We deliberately
  // drop the `\borigin\b` requirement that previously narrowed this rule —
  // any fetch is a network egress that should ride the always-confirm tier.
  new RegExp(String.raw`\bgit\b\s+${GIT_PREFIX}fetch\b`),
  // Mutating git operations that are hard / impossible to undo locally.
  new RegExp(String.raw`\bgit\b\s+${GIT_PREFIX}commit\b[\s\S]*--amend\b`),
  new RegExp(String.raw`\bgit\b\s+${GIT_PREFIX}reset\b[\s\S]*--hard\b`),
]

const bashHitlTier = (input: Input): HITLTier => {
  const cmd = input.command ?? ""
  for (const pat of ALWAYS_CONFIRM_PATTERNS) {
    if (pat.test(cmd)) return "always-confirm"
  }
  return "pre-approval-ok"
}

export const bashTool: Tool<Input> = {
  name: "bash",
  description:
    "Run a shell command (bash). Returns combined stdout/stderr and exit code. " +
    "Non-zero exit is reported, not thrown.",
  inputSchema: schema,
  isReadOnly: () => false,
  // Arbitrary shell side effects are unknowable; never run concurrently.
  isConcurrencySafe: () => false,
  hitlTier: bashHitlTier,

  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const cmd = input.command
    const shown = cmd.length > CMD_PREVIEW ? `${cmd.slice(0, CMD_PREVIEW)}…` : cmd
    yield { type: "progress", message: `running: ${shown}` }

    const r = await runShell(cmd, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      ...(input.timeout_ms ? { timeoutMs: input.timeout_ms } : {}),
    })

    let body = [r.stdout, r.stderr].filter(Boolean).join("\n").trimEnd()
    if (body.length > MAX_OUTPUT) {
      body = `${body.slice(0, MAX_OUTPUT)}\n… (truncated, ${body.length - MAX_OUTPUT} more chars)`
    }
    const status = r.timedOut ? "timed out" : r.exitCode === 0 ? "exit 0" : `exit ${r.exitCode}`
    yield {
      type: "result",
      result: {
        ok: r.exitCode === 0 && !r.timedOut,
        output: `[${status}]\n${body || "(no output)"}`,
      },
    }
  },
}
