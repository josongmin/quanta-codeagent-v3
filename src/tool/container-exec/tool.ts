/**
 * `container_exec` — the terminal surface's one-shot exec tool (RFC §13 lever #1/#2/#4).
 * Runs a command in the bound container via an injected {@link ContainerExec}, returns
 * stdout/stderr + the EXIT CODE (the completion signal). Non-interactive work routes here
 * (clean exit code, no pane-scraping); the tmux pane is reserved for genuinely-interactive
 * programs. Container-bound by construction (the port is docker-exec / orchestrator-env-bound) —
 * there is NO host execution path here (spec S3: host bash is never on the terminal surface;
 * the port is docker-exec / orchestrator-env-bound, wired by the entry-point adapter).
 *
 * SECURITY: `extractShellCommand` exposes the command to the host's HARD_DENY denylist (the same
 * categorical screen `bash`/`pty_write` get) — without it a shell-equivalent tool silently
 * bypasses that gate. Output is run through the shared `neutralizeTerminalOutput` forge-defence
 * (caret-visible controls + bidi/ZW/surrogate strip) before it reaches the transcript.
 *
 * ABORT: `ctx.signal` is threaded into `port.exec` so a transport that honours it aborts the
 * in-flight command (and SHOULD kill the underlying process — best-effort, transport-dependent;
 * the docker backend forwards the signal but `docker exec` does not propagate a host-side kill
 * into the container by default, so orphan-kill is not guaranteed here — see port.ts). A
 * transport that resolves with PARTIAL output + a code on abort has that surfaced normally (the
 * model recovers a hung build from the partial view).
 *
 * NO-THROW (a misbehaving transport maps to a typed error result, never rejects dispatch).
 */
import { z } from "zod"
import { classifyCommandShape } from "@/security"
import { errMessage, sliceTailWholeChars, sliceWholeChars } from "@/shared"
import { neutralizeTerminalOutput } from "../terminal-sanitize"
import type { Tool, ToolEvent, ToolResult } from "../types"
import type { ContainerExec, ContainerExecResult } from "./port"

/** Per-STREAM head+tail cap. Each of stdout/stderr gets its own budget so a stdout FLOOD can
 *  never evict stderr (where the diagnostic the agent needs usually lives) from the window —
 *  capping the joined body would let a noisy stdout starve stderr (RFC §13 #4). head+tail keeps
 *  the command echo/early errors AND the final result; tail-only loses the start.
 *  NB: this is PER-STREAM at 8K (so total ≤ ~16K); `pty_read` caps the whole pane at 32K
 *  (`PTY_MAX_READ_OUTPUT`) — deliberately different scopes (one pane vs two separable streams). */
const DEFAULT_MAX_STREAM = 8 * 1024
const STREAM_CAP_HARD_MAX = 32 * 1024

/** P3-C (RFC jul-3): per-stream cap, env-tunable via `QUANTA_TB_STREAM_CAP`. Unset / non-numeric /
 *  ≤0 ⇒ the 8K default (byte-identical). A set value is floored and CLAMPED to `[1024, 32768]` so a
 *  fat env can never blow the transcript / token budget (pty_read's 32K is the precedent ceiling). PURE. */
export const resolveStreamCap = (env: Record<string, string | undefined>): number => {
  const raw = env.QUANTA_TB_STREAM_CAP
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_STREAM
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_STREAM
  return Math.min(Math.max(Math.floor(n), 1024), STREAM_CAP_HARD_MAX)
}

const MAX_STREAM = resolveStreamCap(process.env)

const cap = (s: string): string => {
  if (s.length <= MAX_STREAM) return s
  const keep = Math.floor(MAX_STREAM / 2)
  const head = sliceWholeChars(s, keep)
  const tail = sliceTailWholeChars(s, keep)
  return `${head}\n… [${s.length - head.length - tail.length} chars truncated] …\n${tail}`
}

/** Defang + per-stream cap one stream for the transcript. Null (a real env-exec bridge may report
 *  `None` for an empty stream) coerces to empty — never reaches the string-typed sanitizer. */
const renderStream = (label: string, raw: string | null): string => {
  if (!raw) return `${label}: (empty)`
  return `${label}:\n${cap(neutralizeTerminalOutput(raw))}`
}

/** B1 (RFC jul-3): model-settable per-command deadline. OPT-IN — no default kill (long builds are
 *  legitimate on this surface; a default deadline was rejected as a regression risk for the
 *  compile-compcert class). Cap mirrors the Claude-Code bash precedent (600s max). */
const TIMEOUT_MS_MAX = 600_000

const schema = z.object({
  command: z
    .string()
    .min(1)
    .describe("Shell command to run inside the container (e.g. `ls -la /`)."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(TIMEOUT_MS_MAX)
    .optional()
    .describe(
      "Optional per-command deadline in ms (max 600000). On expiry the result is exit 124 with " +
        "timed-out marked and any partial output; the container-side process may keep running. " +
        "Omit for no deadline. For work that legitimately runs long, either set a generous " +
        "timeout or run it in the background (`nohup cmd > /tmp/log 2>&1 &`) and poll the log.",
    ),
})
export type ContainerExecInput = z.infer<typeof schema>

const one = (result: ToolResult): AsyncIterable<ToolEvent> => ({
  async *[Symbol.asyncIterator]() {
    yield { type: "result", result }
  },
})

/** Classify ONE completed exec into the tool result. PURE and module-level —
 *  it used to sit three closures deep (factory → execute → async iterator) and
 *  paid a nesting surcharge on every branch. `timeoutMs` is the CALLER's value
 *  (absent ⇒ the transport's own backstop fired). */
const execResultFrom = (
  r: ContainerExecResult,
  command: string,
  timeoutMs?: number,
): ToolResult => {
  // exit + both streams always render (renderStream emits `(empty)` for an empty/null
  // stream — the agent sees "no stderr" explicitly rather than an ambiguous omission).
  const body = [
    `exit: ${r.code}`,
    renderStream("stdout", r.stdout),
    renderStream("stderr", r.stderr),
  ].join("\n")
  // RFC-0002 §5.2 evidence: carry the exit code (and the B1 `timedOut` marker) on the
  // TYPED seam (`ToolResult.evidence`) — dispatch flattens it onto the enriched
  // `tool_result` AgentEvent, which is what the verify-gate/OC1 inspectors and the report
  // cassette read. Text-only exit (`output`) left them blind: every run looked
  // exitCode-less, so a crash (exit 2) was indistinguishable from a clean run (jul-3 RCA).
  const evidence = {
    exitCode: r.code,
    executedCommand: command,
    ...(r.stderr ? { stderr: r.stderr } : {}),
    ...(r.timedOut === true ? { timedOut: true } : {}),
  }
  if (r.timedOut !== true) {
    // A non-zero exit is NOT a tool failure — it's a real, useful observation the agent
    // reasons over (the command ran). Surface it as ok:true with the exit code visible.
    return { ok: true, output: body, evidence }
  }
  // B1: a DEADLINE expiry is a typed TOOL FAILURE (the command did NOT complete — its
  // exit code is a kill sentinel, not a completion signal). `failure.mode:"timeout"`
  // lets the model branch per R-FAILURE-MODE (raise timeout_ms / background+poll /
  // narrow the command) instead of regex-reading the body. Partial output still renders
  // so a hung build is recoverable from what it printed before the deadline.
  // The deadline may be the caller's `timeout_ms` OR the transport's own backstop (the
  // standalone docker path keeps a 60s wall-clock even with no `timeout_ms`), so the
  // message must not interpolate a possibly-undefined value.
  const deadlineLabel =
    timeoutMs !== undefined ? `after ${timeoutMs}ms` : "at the transport's default deadline"
  return {
    ok: false,
    output: `command timed out ${deadlineLabel} (the container-side process may still be running)\n${body}`,
    failure: {
      mode: "timeout",
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    },
    evidence,
  }
}

/** One exec round-trip, with a transport THROW mapped to a typed backend error.
 *  A unit because a transport that blew up has no exit code at all — it cannot
 *  go through {@link execResultFrom}'s table. */
const runExec = async (
  port: ContainerExec,
  command: string,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<ToolResult> => {
  try {
    // Signal threaded to the transport: a well-behaved transport aborts the in-flight
    // command (and may surface partial output + a code). No host-side race wrapper here —
    // it would leak a per-call abort listener on the long-lived turn signal AND discard the
    // transport's partial output. The pre-start guard + threaded signal matches the pty path.
    return execResultFrom(await port.exec(command, signal, timeoutMs), command, timeoutMs)
  } catch (e) {
    const msg = errMessage(e)
    return {
      ok: false,
      output: `container_exec backend error: ${msg}`,
      failure: { mode: "error", modelVisibleError: msg },
    }
  }
}

/** The `container_exec` tool bound to a {@link ContainerExec} transport. */
export const containerExecTool = (port: ContainerExec): Tool<ContainerExecInput> => ({
  name: "container_exec",
  description:
    "Run a one-shot shell command INSIDE the task container and get stdout/stderr + exit code. " +
    "Use for non-interactive steps (the exit code tells you if it succeeded). For interactive " +
    "programs (vim, a REPL, a TUI, a prompt) use the pty_* tools instead.",
  inputSchema: schema,
  isReadOnly: () => false, // exec-risk (mutates container state)
  isConcurrencySafe: () => false,
  // Expose the command to the host HARD_DENY denylist (rm -rf / curl|sh / fork-bomb) — a
  // shell-equivalent tool that omits this silently evades the categorical command gate.
  extractShellCommand: (input: ContainerExecInput): string => input.command,
  classifySource: (input: ContainerExecInput) => classifyCommandShape(input.command),
  execute(input, ctx) {
    const parsed = schema.safeParse(input)
    if (!parsed.success) return one({ ok: false, output: `invalid input: ${parsed.error.message}` })
    if (ctx.signal.aborted) return one({ ok: false, output: "aborted before start" })
    const { command, timeout_ms: timeoutMs } = parsed.data
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "result", result: await runExec(port, command, ctx.signal, timeoutMs) }
      },
    }
  },
})
