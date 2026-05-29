/**
 * `/side <question>` — Claude Code A9 "side chat" slash command.
 *
 * Surfaces the {@link runSideChat} domain seam at the CLI: a quick question
 * answered in an ISOLATED agent loop, with its output painted to stderr
 * (where the rest of the CLI chrome paints) and its cost reported separately
 * from the main session.
 *
 * Surface contract:
 *
 *   - `/side <question>`               → run with defaults (system-prompt-only
 *                                        inheritance, read-only allowlist,
 *                                        maxTurns=3, capped at
 *                                        {@link SIDE_CMD_MAX_TURNS_CAP}).
 *   - `/side --inherit=<mode> <q>`     → override context inheritance
 *                                        (`none|system|last-turn`).
 *   - `/side --tools=<csv> <q>`        → override the default tool allowlist.
 *                                        Names that resolve to a forbidden
 *                                        tool (write/edit/bash/…) are silently
 *                                        dropped by {@link runSideChat}.
 *   - `/side --help`                   → print usage + the default allowlist.
 *
 * Default-OFF: without an injected {@link SideCmdSlashState} on
 * {@link SlashContext.side}, the command prints "side chat not wired in this
 * surface" and exits 0 (byte-identical to NOT registering the command). The
 * surface (REPL / one-shot session) is responsible for wiring a runtime-owned
 * side-conversation starter + an abort signal.
 *
 * Slice contract: lives in `src/apps/cli/**`. The command body NEVER reads
 * `process.env` — the surface composer maps `QUANTA_SIDE_*` env onto the
 * adapter's defaults at construction. The slash command itself NEVER imports
 * `OrchestrateDeps` / `RunOnceInput` / `assembleConfig` — those belong with
 * the runtime/session host adapter.
 */

import type { RuntimeSideConversationArgs, RuntimeSideConversationResult } from "@/sdk/runtime"
import { errMessage } from "@/shared"
import type { SlashCommand, SlashContext } from "./slash-commands"

type SideChatContextInheritance = NonNullable<RuntimeSideConversationArgs["inherit"]>
type SideCmdStartArgs = Pick<
  RuntimeSideConversationArgs,
  "question" | "inherit" | "tools" | "maxTurns" | "signal"
>

const SIDE_CMD_MAX_TURNS_CAP = 5
const SIDE_CMD_DEFAULT_MAX_TURNS = 3
const SIDE_CMD_DEFAULT_READ_ONLY: readonly string[] = Object.freeze([
  "read",
  "search_codebase",
  "grep",
  "glob",
  "file_tree_summary",
  "parse_test_failure",
  "localize",
  "diagnostics",
  "git_log",
  "git_diff",
  "git_blame",
  "git_blame_heatmap",
  "git_churn",
  "git_status",
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_type_definition",
  "lsp_implementation",
  "lsp_document_symbol",
  "lsp_workspace_symbol",
])

/**
 * Session-time state required by `/side`. Injected by the surface
 * (`apps/cli/repl.ts` or a future session loop) onto its
 * {@link SlashContext.side} field. Absent ⇒ "/side: not wired" + exit 0.
 *
 *  - `start` — runtime-owned starter. The surface owns the live runtime
 *    session and injects a closure that snapshots history at call time before
 *    delegating to `session.side.start(...)`.
 *  - `isWired` — live runtime-session availability probe. False means the
 *    current surface has not attached a side-conversation starter yet.
 *  - `defaultTools` — surface-resolved default allowlist (typically
 *    {@link SIDE_CMD_DEFAULT_READ_ONLY}, optionally overridden via
 *    `QUANTA_SIDE_DEFAULT_TOOLS`). A per-call `--tools=` flag wins.
 *  - `defaultMaxTurns` — surface-resolved default max-turns cap (typically
 *    read from `QUANTA_SIDE_MAX_TURNS` if set). Forwarded to the port when
 *    no per-call override is supplied; the runner additionally clamps to
 *    {@link SIDE_CMD_MAX_TURNS_CAP}.
 *  - `signal` — surface-supplied abort signal. Passed through `start`
 *    per-call (every invocation re-reads the surface's current signal).
 */
export interface SideCmdSlashState {
  readonly start: (args: SideCmdStartArgs) => Promise<RuntimeSideConversationResult>
  readonly isWired: () => boolean
  readonly defaultTools?: readonly string[]
  readonly defaultMaxTurns?: number
  readonly signal: AbortSignal
}

/** Parsed `/side` argv. Pure value object so the parser is unit-testable in
 *  isolation from the dispatch path. */
export interface SideCmdArgs {
  readonly help: boolean
  readonly prompt: string
  readonly inherit?: SideChatContextInheritance
  readonly tools?: readonly string[]
}

const VALID_INHERIT = new Set<string>(["none", "system", "last-turn"])

/** Parse `--inherit=<mode>`. Throws on an unknown mode. */
const parseInherit = (raw: string): SideChatContextInheritance => {
  const v = raw.slice("--inherit=".length)
  if (!VALID_INHERIT.has(v)) {
    throw new Error(`/side: invalid --inherit value: ${v} (valid: none | system | last-turn)`)
  }
  return v as SideChatContextInheritance
}

const resolveHelpDefaultTools = (ctx: SlashContext): readonly string[] => {
  const wired = ctx.side?.defaultTools
  return wired !== undefined && wired.length > 0 ? wired : SIDE_CMD_DEFAULT_READ_ONLY
}

const resolveHelpDefaultMaxTurns = (ctx: SlashContext): number =>
  ctx.side?.defaultMaxTurns ?? SIDE_CMD_DEFAULT_MAX_TURNS

/** Parse `--tools=<csv>` into a non-empty trimmed list. Throws on empty. */
const parseToolsCsv = (raw: string): string[] => {
  const csv = raw.slice("--tools=".length)
  const list = csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (list.length === 0) {
    throw new Error("/side: --tools= must list at least one tool name")
  }
  return list
}

/** Parse `/side` args. Tolerates flag-anywhere (`--inherit=x` may come before
 *  OR after positional tokens) — the remaining non-flag tokens are joined as
 *  the prompt. Throws on shape errors so the caller paints a user message. */
export const parseSideCmdArgs = (args: readonly string[]): SideCmdArgs => {
  let inherit: SideChatContextInheritance | undefined
  let tools: readonly string[] | undefined
  let help = false
  const positional: string[] = []
  for (const raw of args) {
    if (raw === "--help" || raw === "-h") {
      help = true
    } else if (raw.startsWith("--inherit=")) {
      inherit = parseInherit(raw)
    } else if (raw.startsWith("--tools=")) {
      tools = parseToolsCsv(raw)
    } else if (raw.startsWith("--")) {
      throw new Error(`/side: unknown flag: ${raw}`)
    } else {
      positional.push(raw)
    }
  }
  const prompt = positional.join(" ").trim()
  return {
    help,
    prompt,
    ...(inherit !== undefined ? { inherit } : {}),
    ...(tools !== undefined ? { tools } : {}),
  }
}

const renderHelp = (ctx: SlashContext): number => {
  const helpText = `\
/side <question>                Ask a quick question in an isolated agent loop.
/side --inherit=<mode> <q>      Inherit context: none | system (default) | last-turn.
/side --tools=<csv> <q>         Override the read-only tool allowlist.
/side --help                    Show this help.

Defaults:
  - inheritance: system (system prompt reused; main history NOT carried)
  - max turns:   ${resolveHelpDefaultMaxTurns(ctx)} (hard cap ${SIDE_CMD_MAX_TURNS_CAP})
  - tools:       ${resolveHelpDefaultTools(ctx).join(", ")}

Isolation: the main conversation history, working state, and cost tally are
NOT affected. Mutating tools (write/edit/bash/git_commit/…) are physically
absent from the side-chat registry — they cannot be invoked even if listed
on --tools.`
  ctx.out(`${helpText}\n`)
  return 0
}

/** Format a USD cost from input/output tokens. Crude heuristic at $0.000003/in
 *  and $0.000015/out tokens — purely cosmetic, the real billing happens at
 *  the provider. The function returns `null` when BOTH counters are zero so
 *  the rendered footer can omit the cost segment entirely. */
const formatCost = (inputTokens: number, outputTokens: number): string | null => {
  if (inputTokens === 0 && outputTokens === 0) return null
  const usd = inputTokens * 0.000003 + outputTokens * 0.000015
  return `$${usd.toFixed(4)}`
}

/** Render the side-chat footer: tool count + token count + (optional) cost +
 *  separation note. Always prefixed with the divider so a scanner can spot
 *  side-chat output amid main-session output. */
const renderFooter = (
  ctx: SlashContext,
  toolsAvailable: number,
  inputTokens: number,
  outputTokens: number,
): void => {
  const tok = inputTokens + outputTokens
  const cost = formatCost(inputTokens, outputTokens)
  const segments: string[] = [
    `${toolsAvailable} tool${toolsAvailable === 1 ? "" : "s"}`,
    `${tok} tok`,
  ]
  if (cost !== null) segments.push(`${cost} (separate from main session)`)
  else segments.push("(separate from main session)")
  ctx.out(`  -- side - ${segments.join(" - ")} --\n`)
}

/** Render the side-chat header — divider + the question echo. Painted to
 *  stdout so a piping consumer can grep for it. Kept ASCII so terminals
 *  without unicode box-drawing don't render mojibake. */
const renderHeader = (ctx: SlashContext, prompt: string): void => {
  const preview = prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt
  ctx.out(`- /side - ${preview}\n`)
}

export const sideCmd: SlashCommand = {
  name: "/side",
  describe: "Ask a quick question in an isolated agent loop (read-only)",
  category: "session",
  async run(args, ctx) {
    // Parse FIRST so a shape error never depends on session state.
    let parsed: SideCmdArgs
    try {
      parsed = parseSideCmdArgs(args)
    } catch (e) {
      ctx.err(`${errMessage(e)}\n`)
      return 1
    }

    if (parsed.help) return renderHelp(ctx)

    if (parsed.prompt.length === 0) {
      ctx.err("/side: expected a question (try /side --help)\n")
      return 1
    }

    const state = ctx.side
    if (state === undefined || state.isWired() !== true) {
      ctx.out("/side: not wired in this surface\n")
      return 0
    }

    renderHeader(ctx, parsed.prompt)
    try {
      const result = await state.start({
        question: parsed.prompt,
        signal: state.signal,
        ...(parsed.inherit !== undefined ? { inherit: parsed.inherit } : {}),
        ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}),
        ...(state.defaultMaxTurns !== undefined ? { maxTurns: state.defaultMaxTurns } : {}),
      })
      if (result.answerText.length > 0) {
        ctx.out(`${result.answerText}\n`)
      } else {
        ctx.out("(no answer — side-chat ended without an assistant message)\n")
      }
      renderFooter(ctx, result.toolsAvailable, result.inputTokens, result.outputTokens)
      return 0
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      ctx.err(`/side: ${msg}\n`)
      return 1
    }
  },
}
