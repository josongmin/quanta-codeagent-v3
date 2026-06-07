/**
 * CLI-03 — Session-bound slash-command registry (ADR-0306).
 *
 * This file owns slash commands whose body needs the live LLM, the agent
 * transcript, or a session-time side-loop:
 *
 *   - `/retry-with` — `@/llm` model-swap rebroadcast (ADR-0065/0066).
 *   - `/side`       — Claude A9 isolated agent loop via `SideConversationPort`.
 *   - `/why`        — meta-LLM reasoning query over a recorded tool call.
 *   - `/debug`      — runtime debug-tracer toggle (session-scoped state).
 *
 * Each command's `*-cmd.ts` module is allowed to import from `@/agent` /
 * `@/llm`. The registry file itself only references the cmd objects so
 * there is no widening of the surface fence beyond what the per-command
 * modules already do.
 *
 * Composition: `slash-commands.ts` concatenates
 * `[...SURFACE_SLASH_COMMANDS, ...SESSION_SLASH_COMMANDS,
 *   ...APP_SLASH_COMMANDS]` into the historic `BUILTINS`.
 */

import { ALL_INBOUND_MODES, parseInboundMode } from "@/agent/inbound-mode"
import { runDebugCmd } from "../debug-cmd"
import { retryWithCmd } from "../retry-with"
import { sideCmd } from "../side-cmd"
import type { SlashCommand } from "../slash-contract"
import { whyCmd } from "../why-cmd"

/** Track D — `/debug` runtime toggle. Pure handler in `../debug-cmd`; the
 *  slash adapter delegates and applies the new state back through the
 *  `ctx.debug.set` seam. The handler never throws, so unknown arguments
 *  surface as a clean message (return 1) and the state stays prev. */
const debugCmd: SlashCommand = {
  name: "/debug",
  describe: "Toggle developer debug tracer (on | off | status | <categories>)",
  category: "config",
  async run(args, ctx) {
    if (ctx.debug === undefined) {
      ctx.out(
        "/debug: not wired in this surface (boot with QUANTA_DEBUG=1 to enable runtime toggle)\n",
      )
      return 0
    }
    const prev = ctx.debug.get()
    const result = runDebugCmd(args.join(" "), prev)
    // Unknown-argument case: handler returns `state === prev` and message
    // starts with the error prefix. Apply the unchanged state regardless
    // (idempotent) and surface the message to stderr + exit 1 for shell
    // chain-ability. Status / toggle / on / off / categories all share
    // the success path.
    if (result.message.startsWith("/debug: unknown argument")) {
      ctx.err(result.message)
      return 1
    }
    // `status` (and any future read-only sub-cmd) returns `state === prev`
    // by reference. Skip the set() to keep the side-effect strictly tied to
    // actual mutations — surfaces relying on a set-callback for instrumentation
    // (telemetry, render-bridge) don't see spurious no-op transitions.
    if (result.state !== prev) ctx.debug.set(result.state)
    ctx.out(result.message)
    return 0
  },
}

/** `/cancel` — enqueue a mid-turn cancel of the active turn (ADR-0071). The
 *  loop drains the action at the next turn-poll; the surface only queues it.
 *  Absent surface ⇒ "not wired" (boot with QUANTA_CONVERSATION_ACTIONS=on). */
const cancelCmd: SlashCommand = {
  name: "/cancel",
  describe: "Cancel the active turn (mid-turn typed control, ADR-0071)",
  category: "session",
  async run(args, ctx) {
    if (ctx.conversationActions === undefined) {
      ctx.out("/cancel: not wired in this surface (boot with QUANTA_CONVERSATION_ACTIONS=on)\n")
      return 0
    }
    const reason = args.join(" ").trim() || "user requested cancel"
    ctx.conversationActions.pushCancel(reason)
    ctx.out(`/cancel: queued (applies at next turn boundary): ${reason}\n`)
    return 0
  },
}

/** `/summarize-now` — request a mid-turn conversation summarization (ADR-0071). */
const summarizeNowCmd: SlashCommand = {
  name: "/summarize-now",
  describe: "Request a mid-turn conversation summarization (ADR-0071)",
  category: "session",
  async run(_args, ctx) {
    if (ctx.conversationActions === undefined) {
      ctx.out(
        "/summarize-now: not wired in this surface (boot with QUANTA_CONVERSATION_ACTIONS=on)\n",
      )
      return 0
    }
    ctx.conversationActions.pushSummarize()
    ctx.out("/summarize-now: queued (applies at next turn boundary)\n")
    return 0
  },
}

/** `/inbound` — §steer: show or set the inbound message-delivery mode. A fired
 *  message while a turn is in flight is handled per mode:
 *    queue     — runs as the NEXT turn (default; FIFO follow-up)
 *    weave     — injected into the CURRENT turn (Claude-IDE live blend)
 *    interrupt — aborts the current turn + restarts with the message (Codex barge-in)
 *  weave/interrupt need `QUANTA_CONVERSATION_ACTIONS=on` + `QUANTA_MIDTURN_CAPTURE=on`
 *  to actually take effect (else the loop degrades to queue). */
const inboundCmd: SlashCommand = {
  name: "/inbound",
  describe: "Show/set inbound message delivery mode (queue | weave | interrupt)",
  category: "config",
  async run(args, ctx) {
    if (ctx.inboundMode === undefined) {
      ctx.out("/inbound: not wired in this surface\n")
      return 0
    }
    const arg = args.join(" ").trim().toLowerCase()
    if (arg === "" || arg === "show" || arg === "status") {
      ctx.out(`/inbound: ${ctx.inboundMode.current} (modes: queue | weave | interrupt)\n`)
      return 0
    }
    const parsed = parseInboundMode(arg)
    if (parsed === undefined) {
      ctx.out(`/inbound: unknown mode '${arg}' — use queue | weave | interrupt\n`)
      return 1
    }
    ctx.inboundMode.current = parsed
    const needsSurface = parsed !== "queue" && ctx.conversationActions === undefined
    const note = needsSurface
      ? " (NOTE: weave/interrupt need QUANTA_CONVERSATION_ACTIONS=on + QUANTA_MIDTURN_CAPTURE=on)"
      : ""
    ctx.out(`/inbound: mode → ${parsed}${note}\n`)
    return 0
  },
  complete(_args, partial) {
    const p = partial.toLowerCase()
    return ALL_INBOUND_MODES.filter((m) => m.startsWith(p)).map((m) => ({
      value: m,
      kind: "argument" as const,
    }))
  },
}

/** Slot order matches the layered ordering. The historic slot of
 *  `/retry-with` (index 6 in the old BUILTINS) is intentionally NOT
 *  preserved — see ADR-0306 §"Slot ordering" for the rationale. */
export const SESSION_SLASH_COMMANDS: readonly SlashCommand[] = [
  retryWithCmd,
  sideCmd,
  debugCmd,
  whyCmd,
  cancelCmd,
  summarizeNowCmd,
  inboundCmd,
]
