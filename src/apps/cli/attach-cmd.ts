/**
 * `quanta attach [ws-url]` — join a RUNNING daemon's shared session over WS.
 *
 * Default-OFF / no-regression: inert unless the `attach` subcommand is typed; a
 * bare `quanta` run never reaches here (see `index.ts` routing), so the
 * in-process REPL path stays byte-identical.
 *
 * This is the thin, impure CLI shell around the `@/apps/cli/attach` slice: it
 * parses argv (URL positional / `--token` / env), builds a real line-by-line
 * stdin iterator + stdout writer + an interactive y/N approval prompt, then
 * delegates to `attachToDaemon`. Ctrl-C (SIGINT) ⇒ best-effort `turn.cancel` +
 * clean socket close (handled by `attachToDaemon.close()`).
 */

import * as readline from "node:readline/promises"
import { attachToDaemon } from "./attach"
import {
  createMidTurnApprovalChannel,
  type MidTurnApprovalChannel,
} from "./repl/mid-turn-approval-channel"

const DEFAULT_ATTACH_URL = "ws://127.0.0.1:4096/"

export interface AttachCmdArgs {
  readonly url: string
  readonly token?: string
  readonly help: boolean
}

const ATTACH_USAGE = `quanta attach — join a running daemon's shared session over WebSocket

USAGE:
  quanta attach [ws-url] [--token <token>]

ARGS:
  ws-url            Daemon session WS URL (default: ${DEFAULT_ATTACH_URL})

OPTIONS:
  --token <token>   Bearer token (or set QUANTA_WEB_AUTH_TOKEN)
  -h, --help        Show this help

Type a line to run a turn on the shared session. Approval prompts ask y/N.
Ctrl-C cancels the in-flight turn and detaches.
`

/** Pure argv → {url, token, help}. The first non-flag positional is the URL;
 *  `--token X` / `--token=X` sets the token; env `QUANTA_WEB_AUTH_TOKEN` is the
 *  fallback (an explicit `--token` wins). */
export const parseAttachArgs = (argv: readonly string[], env: NodeJS.ProcessEnv): AttachCmdArgs => {
  let url: string | undefined
  let token: string | undefined
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === undefined) continue
    if (tok === "-h" || tok === "--help") {
      help = true
      continue
    }
    if (tok === "--token") {
      token = argv[i + 1]
      i += 1
      continue
    }
    if (tok.startsWith("--token=")) {
      token = tok.slice("--token=".length)
      continue
    }
    if (!tok.startsWith("-") && url === undefined) {
      url = tok
    }
  }
  const resolvedToken = token ?? env.QUANTA_WEB_AUTH_TOKEN
  return {
    url: url ?? DEFAULT_ATTACH_URL,
    ...(resolvedToken !== undefined && resolvedToken.length > 0 ? { token: resolvedToken } : {}),
    help,
  }
}

/** Line-by-line async iterator over stdin (closeable for clean shutdown). */
const createStdinLines = (): { lines: AsyncIterable<string>; close: () => void } => {
  const rl = readline.createInterface({ input: process.stdin })
  const lines = rl[Symbol.asyncIterator]() as AsyncIterableIterator<string>
  return {
    lines: { [Symbol.asyncIterator]: () => lines },
    close: () => rl.close(),
  }
}

/** WS-B (jul-10, UUX-3-02) — the approval prompt no longer opens a SECOND
 *  readline on the stdin the read-loop iterator already owns (the two raced:
 *  the operator's "y" could be consumed by the loop and sent to the session
 *  as input). ONE stdin owner: the prompt renders on stderr and awaits the
 *  next line ROUTED from the read loop via the channel (`claimApprovalLine`
 *  in attach-client consults it before treating a line as session input).
 *  A typed channel release maps to "n" (fail-closed deny). */
const buildChannelApprovalPrompt = (
  channel: MidTurnApprovalChannel,
): ((reason: string) => Promise<string>) => {
  return async (reason: string): Promise<string> => {
    process.stderr.write(`Approve "${reason}"? [y/N] `)
    const result = await channel.awaitLine()
    return result.kind === "line" ? result.line : "n"
  }
}

export interface RunAttachCmdDeps {
  /** Override the attach driver (tests). Defaults to the real `attachToDaemon`. */
  readonly attach?: typeof attachToDaemon
  /** Override usage sink (tests). Defaults to stdout. */
  readonly writeUsage?: (s: string) => void
}

/**
 * Run the `attach` subcommand. Returns the process exit code. `--help` renders
 * usage and returns 0 WITHOUT opening a socket.
 */
export const runAttachCmd = async (
  argv: readonly string[],
  deps: RunAttachCmdDeps = {},
): Promise<number> => {
  const args = parseAttachArgs(argv, process.env)
  const writeUsage = deps.writeUsage ?? ((s: string) => void process.stdout.write(s))
  if (args.help) {
    writeUsage(ATTACH_USAGE)
    return 0
  }

  const attach = deps.attach ?? attachToDaemon
  const stdin = createStdinLines()
  // WS-B (UUX-3-02) — one stdin owner: approval answers ride the read loop.
  const approvalChannel = createMidTurnApprovalChannel()
  approvalChannel.active = true // the iterator owns stdin for the whole attach

  process.stderr.write(`attaching to ${args.url} …\n`)
  const session = await attach({
    url: args.url,
    ...(args.token !== undefined ? { token: args.token } : {}),
    stdin: stdin.lines,
    write: (chunk) => void process.stdout.write(chunk),
    promptApproval: buildChannelApprovalPrompt(approvalChannel),
    claimApprovalLine: (line) => approvalChannel.tryResolve(line),
  })

  // Ctrl-C ⇒ best-effort turn.cancel + close (attachToDaemon.close handles it),
  // then drain stdin and exit. Both SIGINT and an EOF/closed read loop converge
  // on `session.done`.
  const onSig = (): void => {
    void session.close()
    stdin.close()
  }
  process.on("SIGINT", onSig)
  process.on("SIGTERM", onSig)
  try {
    await session.done
  } finally {
    process.off("SIGINT", onSig)
    process.off("SIGTERM", onSig)
    stdin.close()
  }
  return 0
}
