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
import { type AttachApprovalAnswer, attachToDaemon } from "./attach"
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

Type a line to run a turn on the shared session. Approval prompts offer
[y]es / [a]lways session / [N]o / deny+s[t]eer.
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

/** Line-by-line async iterator over stdin (closeable for clean shutdown).
 *  C3 (jul-10 W4) — an optional `onLine` tap observes every line AT ARRIVAL
 *  (the readline `line` event, i.e. when the operator hit Enter), so the
 *  approval line-claim gate can order arrivals against prompt renders even
 *  though the read loop pulls lines later. */
const createStdinLines = (opts?: {
  readonly onLine?: () => void
}): { lines: AsyncIterable<string>; close: () => void } => {
  const rl = readline.createInterface({ input: process.stdin })
  if (opts?.onLine !== undefined) rl.on("line", opts.onLine)
  const lines = rl[Symbol.asyncIterator]() as AsyncIterableIterator<string>
  return {
    lines: { [Symbol.asyncIterator]: () => lines },
    close: () => rl.close(),
  }
}

/** C3 (jul-10 W4, mitigation) — the approval line-claim GATE. The read loop's
 *  `claimApprovalLine` previously claimed a line whenever a channel waiter was
 *  pending — inverting causality for a line the operator had ALREADY typed
 *  before the approval prompt rendered (it got eaten as the prompt's answer).
 *  The gate orders line ARRIVALS (readline `line` tap) against the prompt
 *  RENDER: only a line typed after the prompt appeared may answer it; earlier
 *  lines flow to the session. A line pulled without an arrival record (no tap
 *  wired — bare test harnesses) is treated as fresh (legacy behavior).
 *
 *  C2 re-verification (jul-10 audit) — anchors are INTERACTION-scoped now that
 *  the channel is a FIFO ask queue and approval interactions can OVERLAP (B's
 *  verb prompt renders — head promotion — before A's finally runs). A single
 *  shared anchor broke both ways: A's `markPromptAnswered` clobbered B's fresh
 *  anchor (B's answer then leaked to the session), and B's render overwrote
 *  A's sticky steer anchor (a pasted "t\n<steer>" burst lost its claim). Each
 *  interaction keeps its own FIRST-render anchor; renders fire at head
 *  activation in queue order, so the LAST `markPromptRendered` is always the
 *  current head's — `claim` checks arrivals against exactly that anchor. */
export interface ApprovalLineGate {
  /** Called at readline `line` arrival (operator pressed Enter). */
  noteLineArrival(): void
  /** Mint an id grouping all sub-prompts of ONE approval interaction. */
  newInteraction(): number
  /** Called when an ask's prompt renders (channel head activation). The steer
   *  sub-prompts of one interaction keep its FIRST anchor (a pasted
   *  "t\n<steer>" burst stays claimed). */
  markPromptRendered(interaction: number): void
  /** Called when the approval interaction fully settles. */
  markPromptAnswered(interaction: number): void
  /** Read-loop seam: claim `line` for the pending approval, or let it flow. */
  claim(line: string): boolean
}

export const createApprovalLineGate = (channel: MidTurnApprovalChannel): ApprovalLineGate => {
  let seq = 0
  let nextInteraction = 0
  /** interaction id → its FIRST prompt-render arrival-seq (sticky). */
  const anchors = new Map<number, number>()
  /** The anchor of the CURRENT channel head (the last-rendered ask). */
  let headAnchor: number | undefined
  const arrivals: number[] = []
  return {
    noteLineArrival() {
      seq += 1
      arrivals.push(seq)
    },
    newInteraction() {
      nextInteraction += 1
      return nextInteraction
    },
    markPromptRendered(interaction: number) {
      const anchor = anchors.get(interaction) ?? seq
      anchors.set(interaction, anchor)
      // Renders fire in head order (channel activation), so this ask IS the
      // head — its (sticky) anchor becomes the claim reference.
      headAnchor = anchor
    },
    markPromptAnswered(interaction: number) {
      anchors.delete(interaction)
      // Another interaction's ask may already be head (promoted + rendered
      // before this finally ran) — only a fully-quiet gate drops the anchor.
      if (anchors.size === 0) headAnchor = undefined
    },
    claim(line: string): boolean {
      // Pop THIS line's arrival record even when not claiming — FIFO stays in
      // sync with the read loop (one claim call per pulled line). No record ⇒
      // untapped source ⇒ treat as freshly typed.
      let arrival = arrivals.shift()
      if (arrival === undefined) {
        seq += 1
        arrival = seq
      }
      if (headAnchor === undefined) return false // no prompt visible
      if (arrival <= headAnchor) return false // typed BEFORE the prompt ⇒ session input
      return channel.tryResolve(line)
    },
  }
}

/** WS-B (jul-10, UUX-3-02) — the approval prompt no longer opens a SECOND
 *  readline on the stdin the read-loop iterator already owns (the two raced:
 *  the operator's "y" could be consumed by the loop and sent to the session
 *  as input). ONE stdin owner: the prompt renders on stderr and awaits the
 *  next line ROUTED from the read loop via the channel (`claimApprovalLine`
 *  in attach-client consults it before treating a line as session input).
 *  A typed channel release maps to a plain deny (fail-closed).
 *
 *  UUX-1-19 (jul-10 W4) — verb upgrade. The wire (`ApprovalRespondCommand`)
 *  carries `scope` + `steer` and the kernel scheduler forwards both to
 *  `host.resolveApproval`, so the prompt offers the SAME answer vocabulary the
 *  daemon accepts: [y]es / [a]lways session (scope:"session" — the standing
 *  grant) / [N]o / deny+s[t]eer (corrective steer on the deny lease). An empty
 *  steer re-prompts ONCE (UUX-2-18) before degrading to a plain deny. */
type AskLine = (prompt: string) => Promise<string | undefined>

/** UUX-2-18 (attach half) — deny+steer sub-flow: an empty steer re-asks ONCE
 *  ("steer text required (or N to deny)") before degrading to a plain deny.
 *  `undefined` from `ask` = channel release ⇒ fail-closed plain deny. */
const askDenySteer = async (ask: AskLine): Promise<AttachApprovalAnswer> => {
  const steer = (await ask("Steer (what to do instead): "))?.trim()
  if (steer === undefined) return { decision: "deny" }
  if (steer.length > 0) return { decision: "deny", steer }
  const retry = (await ask("steer text required (or N to deny): "))?.trim()
  if (retry === undefined || retry.length === 0 || retry.toLowerCase() === "n") {
    return { decision: "deny" }
  }
  return { decision: "deny", steer: retry }
}

export const buildChannelApprovalPrompt = (
  channel: MidTurnApprovalChannel,
  gate: ApprovalLineGate,
): ((reason: string) => Promise<AttachApprovalAnswer>) => {
  return async (reason: string): Promise<AttachApprovalAnswer> => {
    const interaction = gate.newInteraction()
    /** Render one sub-prompt and await its routed line; `undefined` = released.
     *  C2 (jul-10 audit) — the channel is a FIFO ask queue: render + gate-mark
     *  in `onActive` (fired when THIS ask becomes head; synchronously for the
     *  single-ask case) so a queued approval never prints over an unanswered
     *  one, and the claim gate only anchors against a prompt the operator can
     *  actually SEE (head + rendered). */
    const ask: AskLine = async (prompt) => {
      const result = await channel.awaitLine(undefined, "approval", () => {
        process.stderr.write(prompt)
        gate.markPromptRendered(interaction)
      })
      if (result.kind === "line") return result.line
      process.stderr.write("\n[quanta] approval prompt released unanswered — treated as deny.\n")
      return undefined
    }
    try {
      const first = await ask(
        `Approve "${reason}"? [y]es / [a]lways session / [N]o / deny+s[t]eer: `,
      )
      if (first === undefined) return { decision: "deny" }
      const ans = first.trim().toLowerCase()
      if (ans === "y" || ans === "yes") return { decision: "approve" }
      if (ans === "a" || ans === "always") return { decision: "approve", scope: "session" }
      // `await` is load-bearing: the enclosing finally (markPromptAnswered)
      // must run AFTER the steer sub-flow settles, not when its promise mints.
      if (ans === "t") return await askDenySteer(ask)
      return { decision: "deny" }
    } finally {
      gate.markPromptAnswered(interaction)
    }
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
  // WS-B (UUX-3-02) — one stdin owner: approval answers ride the read loop.
  const approvalChannel = createMidTurnApprovalChannel()
  approvalChannel.active = true // the iterator owns stdin for the whole attach
  // C3 (jul-10 W4) — the claim gate orders line arrivals against prompt
  // renders so a line typed BEFORE an approval prompt appeared is never eaten
  // as its answer (it flows to the session instead).
  const approvalGate = createApprovalLineGate(approvalChannel)
  const stdin = createStdinLines({ onLine: () => approvalGate.noteLineArrival() })

  process.stderr.write(`attaching to ${args.url} …\n`)
  const session = await attach({
    url: args.url,
    ...(args.token !== undefined ? { token: args.token } : {}),
    stdin: stdin.lines,
    write: (chunk) => void process.stdout.write(chunk),
    promptApproval: buildChannelApprovalPrompt(approvalChannel, approvalGate),
    claimApprovalLine: (line) => approvalGate.claim(line),
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
