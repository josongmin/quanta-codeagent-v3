/**
 * Track C — interactive MCP elicitation prompter for the CLI surface.
 *
 * Builds an {@link ElicitationPrompterFactory} that the CLI threads into
 * `loadMcpTools` so an inbound MCP `elicitation/create` request reaches the
 * user on the terminal instead of being auto-declined by the client's
 * `headlessRejecter` default.
 *
 * Reuse, not reinvent: the line IO mirrors the SAME `readline`-on-stdin /
 * prompt-to-stderr pattern the REPL already uses for its `ask`-based ports
 * (`src/apps/cli/repl/runtime-context-compose.ts#askLine` — a module-private
 * helper that is NOT reachable from `loadFeatures`, which runs earlier in the
 * bootstrap before the runtime context is composed). We construct an ad-hoc
 * `readline` interface per read (output on stderr so a piped stdout stays
 * clean), exactly like `askLine`, then adapt it to the {@link CliPrompterIO}
 * `{ write, read }` shape `cliPrompter` consumes.
 *
 * Default-OFF / interactive-only: when stdin is NOT a TTY (headless run, pipe,
 * CI), {@link buildCliElicitationPrompterFactory} returns `undefined` so the
 * caller passes no factory to `loadMcpTools` and every `McpClient` keeps its
 * `headlessRejecter` default — byte-identical to the pre-Track-C load path.
 *
 * Per-server lease key: a SINGLE {@link ElicitationLeasePool} is built over the
 * shared interactive prompter, and the returned factory binds it per server via
 * `pool.forContext({ serverId })`. Two concurrent tool calls on the SAME server
 * asking the SAME titled question coalesce to one prompt; different servers
 * never share a lease key.
 */

import * as readline from "node:readline/promises"
import type { ElicitationPrompterFactory } from "@/agent"
import {
  type CliPrompterIO,
  cliPrompter,
  ElicitationLeasePool,
  type ElicitationPrompter,
  type ElicitationResult,
  type EnumOption,
  enumOptionLabel,
} from "@/mcp"
import { currentMidTurnApprovalChannel } from "./repl/mid-turn-approval-channel"

/** AskUserQuestion parity (jul-03 A1) — the synthetic free-text escape option
 *  the framework auto-adds so the user is never boxed into the model's
 *  enumerated choices. The label is the sentinel the decorator detects on the
 *  way back; a real option colliding with it is de-duped (the escape is only
 *  appended when no option already carries the label). */
const OTHER_LABEL = "Other (type your own answer)"
const OTHER_PROMPT = "Your answer"

/** Append the synthetic Other escape to an option list. Two guards preserve
 *  base semantics:
 *   - an EMPTY list is left empty (never add "Other") so the base prompter still
 *     short-circuits to `empty-enum` — the escape must not mask that failure;
 *   - a list already carrying the sentinel label is not double-added. */
const withOther = (options: readonly EnumOption[]): EnumOption[] => {
  if (options.length === 0) return []
  const has = options.some((o) => enumOptionLabel(o) === OTHER_LABEL)
  return has ? [...options] : [...options, { label: OTHER_LABEL }]
}

/**
 * Wrap a base prompter so every enum prompt carries the auto-"Other" free-text
 * escape (AskUserQuestion parity). Picking "Other" re-prompts via the base
 * `promptString` and returns the typed value in place of the sentinel — the
 * sentinel NEVER leaks as the answer. Non-enum prompts pass straight through.
 * Picking a REAL option is byte-identical to the un-decorated prompter (the
 * extra option never shifts a real answer).
 */
export const withOtherEscape = (base: ElicitationPrompter): ElicitationPrompter => {
  const freeText = async (signal?: AbortSignal): Promise<ElicitationResult<string>> =>
    base.promptString({ prompt: OTHER_PROMPT }, signal)
  return {
    ...base,
    async promptEnum(req, signal) {
      const r = await base.promptEnum({ ...req, options: withOther(req.options) }, signal)
      if (r.ok && r.value === OTHER_LABEL) return freeText(signal)
      return r
    },
    async promptSingleEnum(req, signal) {
      const r = await base.promptSingleEnum({ ...req, options: withOther(req.options) }, signal)
      if (r.ok && r.value === OTHER_LABEL) return freeText(signal)
      return r
    },
    async promptMultiEnum(req, signal) {
      const r = await base.promptMultiEnum({ ...req, options: withOther(req.options) }, signal)
      if (!r.ok) return r
      // Replace any picked sentinel with the user's free-typed value. When the
      // ONLY pick was Other, the result is the single free-text value.
      if (!r.value.includes(OTHER_LABEL)) return r
      const typed = await freeText(signal)
      if (!typed.ok) return typed
      const rest = r.value.filter((v) => v !== OTHER_LABEL)
      return { ok: true, value: [...rest, typed.value] }
    },
  }
}

/** Ad-hoc readline read mirroring the REPL's `askLine` (prompt → stderr, read
 *  one line from stdin). Resolves `null` on EOF / abort so `cliPrompter`'s
 *  `withRetry` treats it as cancellation. */
const readLine = async (prompt: string, signal: AbortSignal): Promise<string | null> => {
  if (signal.aborted) return null
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    // `readline/promises` honors an AbortSignal on `question`, rejecting with an
    // AbortError when the signal fires mid-read; we map that (and EOF) to null.
    return await rl.question(prompt, { signal })
  } catch {
    return null
  } finally {
    rl.close()
  }
}

/**
 * WS-B (jul-10, UUX-1-05) — the elicitation/ask_user read routes through the
 * SESSION's mid-turn approval channel when an in-turn reader owns stdin,
 * exactly like the REPL's own `askLine`. The old behavior (always open a
 * fresh readline) FOUGHT the in-turn reader mid-turn: two consumers on one
 * raw-mode stdin, the question never received a usable line, and the ask
 * fail-closed. A typed channel RELEASE (turn ended with the ask unanswered)
 * maps to `null` — the same cancellation `withRetry` already handles.
 *
 * Exported for the hellgate; production reaches it via the prompter io.
 */
export const readViaMidTurnChannelOrReadline = async (
  signal: AbortSignal,
): Promise<string | null> => {
  const channel = currentMidTurnApprovalChannel()
  if (channel?.active === true) {
    if (signal.aborted) return null
    const result = await channel.awaitLine()
    return result.kind === "line" ? result.line : null
  }
  return readLine("", signal)
}

/** The interactive {@link CliPrompterIO}: writes go to stderr (so stdout stays
 *  a clean data channel), reads come from the mid-turn channel when a turn's
 *  reader owns stdin, else a fresh readline (between turns). */
const interactiveCliPrompterIo = (): CliPrompterIO => ({
  write: (s: string): void => {
    process.stderr.write(s)
  },
  read: (signal: AbortSignal): Promise<string | null> => readViaMidTurnChannelOrReadline(signal),
})

/**
 * Build the per-server elicitation prompter factory for the CLI surface, or
 * `undefined` when no interactive seam is available (non-TTY stdin).
 *
 * The single shared interactive prompter is wrapped in ONE
 * {@link ElicitationLeasePool}; the returned factory binds the lease context
 * per server so the coalescing key is `(serverId, title|prompt)`.
 *
 * @param io test seam — inject a {@link CliPrompterIO} (and force `interactive`)
 *   to exercise the mapping without a real TTY. Production omits it.
 */
export const buildCliElicitationPrompterFactory = (opts?: {
  readonly io?: CliPrompterIO
  /** Override the TTY gate (tests). Default = `process.stdin.isTTY === true`. */
  readonly interactive?: boolean
}): ElicitationPrompterFactory | undefined => {
  const interactive = opts?.interactive ?? (process.stdin as { isTTY?: boolean }).isTTY === true
  if (!interactive) return undefined
  const io = opts?.io ?? interactiveCliPrompterIo()
  // Auto-"Other" free-text escape (AskUserQuestion parity) wraps the base
  // prompter BEFORE the lease pool so every enum prompt — whether it arrives
  // via the MCP elicitation path or the agent's `ask_user` tool — gains the
  // escape uniformly.
  const base: ElicitationPrompter = withOtherEscape(cliPrompter(io))
  const pool = new ElicitationLeasePool(base)
  return (serverId: string): ElicitationPrompter => pool.forContext({ serverId })
}
