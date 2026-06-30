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
import { errMessage, sliceTailWholeChars, sliceWholeChars } from "@/shared"
import { neutralizeTerminalOutput } from "../terminal-sanitize"
import type { Tool, ToolEvent, ToolResult } from "../types"
import type { ContainerExec } from "./port"

/** Per-STREAM head+tail cap. Each of stdout/stderr gets its own budget so a stdout FLOOD can
 *  never evict stderr (where the diagnostic the agent needs usually lives) from the window —
 *  capping the joined body would let a noisy stdout starve stderr (RFC §13 #4). head+tail keeps
 *  the command echo/early errors AND the final result; tail-only loses the start.
 *  NB: this is PER-STREAM at 8K (so total ≤ ~16K); `pty_read` caps the whole pane at 32K
 *  (`PTY_MAX_READ_OUTPUT`) — deliberately different scopes (one pane vs two separable streams). */
const MAX_STREAM = 8 * 1024

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

const schema = z.object({
  command: z
    .string()
    .min(1)
    .describe("Shell command to run inside the container (e.g. `ls -la /`)."),
})
export type ContainerExecInput = z.infer<typeof schema>

const one = (result: ToolResult): AsyncIterable<ToolEvent> => ({
  async *[Symbol.asyncIterator]() {
    yield { type: "result", result }
  },
})

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
  execute(input, ctx) {
    const parsed = schema.safeParse(input)
    if (!parsed.success) return one({ ok: false, output: `invalid input: ${parsed.error.message}` })
    if (ctx.signal.aborted) return one({ ok: false, output: "aborted before start" })
    return {
      async *[Symbol.asyncIterator]() {
        let result: ToolResult
        try {
          // Signal threaded to the transport: a well-behaved transport aborts the in-flight
          // command (and may surface partial output + a code). No host-side race wrapper here —
          // it would leak a per-call abort listener on the long-lived turn signal AND discard the
          // transport's partial output. The pre-start guard + threaded signal matches the pty path.
          const r = await port.exec(parsed.data.command, ctx.signal)
          // exit + both streams always render (renderStream emits `(empty)` for an empty/null
          // stream — the agent sees "no stderr" explicitly rather than an ambiguous omission).
          const body = [
            `exit: ${r.code}`,
            renderStream("stdout", r.stdout),
            renderStream("stderr", r.stderr),
          ].join("\n")
          // A non-zero exit is NOT a tool failure — it's a real, useful observation the agent
          // reasons over (the command ran). Surface it as ok:true with the exit code visible.
          result = { ok: true, output: body }
        } catch (e) {
          const msg = errMessage(e)
          result = {
            ok: false,
            output: `container_exec backend error: ${msg}`,
            failure: { mode: "error", modelVisibleError: msg },
          }
        }
        yield { type: "result", result }
      },
    }
  },
})
