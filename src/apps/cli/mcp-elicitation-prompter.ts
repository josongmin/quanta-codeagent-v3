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
} from "@/mcp"

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

/** The interactive {@link CliPrompterIO}: writes go to stderr (so stdout stays
 *  a clean data channel), reads come from stdin via {@link readLine}. */
const interactiveCliPrompterIo = (): CliPrompterIO => ({
  write: (s: string): void => {
    process.stderr.write(s)
  },
  read: (signal: AbortSignal): Promise<string | null> => readLine("", signal),
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
  const base: ElicitationPrompter = cliPrompter(io)
  const pool = new ElicitationLeasePool(base)
  return (serverId: string): ElicitationPrompter => pool.forContext({ serverId })
}
