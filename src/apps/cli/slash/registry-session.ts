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

import { ALL_INBOUND_MODES, invertInboundModeOnce, parseInboundMode } from "@/agent/inbound-mode"
import { runDebugCmd } from "../debug-cmd"
import { goalCmd } from "./goal-cmd"
import { hooksCmd } from "../hooks-cmd"
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

/** `/steer` — T02 thread-follower `steer-turn`: inject ONE message into the
 *  CURRENT in-flight turn (the §steer weave path) REGARDLESS of the session's
 *  base inbound mode — i.e. the per-message invert (Codex Cmd-Ctrl+Shift+Enter)
 *  realized as an explicit verb. Lease-safe: it rides `pushUserMessage`, which
 *  the loop drains as a `user_message` ConversationAction injected into the lease
 *  holder's running turn — NOT a second writer. Absent surface ⇒ "not wired". */
const steerCmd: SlashCommand = {
  name: "/steer",
  describe: "Steer the current turn: inject one message into the in-flight turn (T02 follower verb)",
  category: "session",
  async run(args, ctx) {
    if (ctx.conversationActions === undefined) {
      ctx.out("/steer: not wired in this surface (boot with QUANTA_CONVERSATION_ACTIONS=on)\n")
      return 0
    }
    const text = args.join(" ").trim()
    if (text === "") {
      ctx.err("/steer: needs a message to inject (usage: /steer <text>)\n")
      return 1
    }
    ctx.conversationActions.pushUserMessage(text)
    ctx.out(`/steer: queued — woven into the current turn at the next step: ${text}\n`)
    return 0
  },
}

/** `/interrupt` — T02 thread-follower `interrupt-turn`: abort the active turn
 *  (the lease-bypassing cancel path). Synonym of `/cancel` framed as the Codex
 *  follower barge-in verb; both push the SAME typed `cancel` action the loop
 *  drains per-turn. Absent surface ⇒ "not wired". */
const interruptCmd: SlashCommand = {
  name: "/interrupt",
  describe: "Interrupt (abort) the active turn — Codex follower barge-in (T02)",
  category: "session",
  async run(args, ctx) {
    if (ctx.conversationActions === undefined) {
      ctx.out("/interrupt: not wired in this surface (boot with QUANTA_CONVERSATION_ACTIONS=on)\n")
      return 0
    }
    const reason = args.join(" ").trim() || "follower requested interrupt"
    ctx.conversationActions.pushCancel(reason)
    ctx.out(`/interrupt: queued (applies at next turn boundary): ${reason}\n`)
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
    // T02 (UC5) — flip the base mode via the queue/weave invert (Codex per-message
    // invert, here applied to the session default). `/steer` is the true one-shot
    // per-message invert; this flips the standing default.
    if (arg === "invert" || arg === "toggle") {
      const next = invertInboundModeOnce(ctx.inboundMode.current)
      ctx.inboundMode.current = next
      ctx.out(`/inbound: inverted → ${next}\n`)
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
    return [...ALL_INBOUND_MODES, "invert"]
      .filter((m) => m.startsWith(p))
      .map((m) => ({ value: m, kind: "argument" as const }))
  },
}

/** `/resume-turn` — §11.5: resume the most-recently interrupted turn. The loop
 *  re-injects the captured partial work from the session buffer (a no-op when
 *  nothing was interrupted). Distinct from `/resume` (which un-snoozes idle). */
const resumeTurnCmd: SlashCommand = {
  name: "/resume-turn",
  describe: "Resume the most-recently interrupted turn (§11.5 interrupt restore)",
  category: "session",
  async run(_args, ctx) {
    if (ctx.conversationActions === undefined) {
      ctx.out(
        "/resume-turn: not wired in this surface (boot with QUANTA_CONVERSATION_ACTIONS=on)\n",
      )
      return 0
    }
    ctx.conversationActions.pushResume()
    ctx.out("/resume-turn: queued — restores the interrupted turn at the next turn boundary\n")
    return 0
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
  steerCmd,
  interruptCmd,
  summarizeNowCmd,
  inboundCmd,
  resumeTurnCmd,
  hooksCmd,
  goalCmd,
]
