import { redactValue, type TerminalWriter, writeStdout } from "@/shared"
import type { StreamPort } from "../ports"
import type { AgentEvent } from "../types"

const DIM = "\x1b[2m"
const CYAN = "\x1b[36m"
const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const RESET = "\x1b[0m"

/** Optional hook that rewrites the assistant text stream as it goes to
 *  stdout. The CLI surface injects an inline markdown highlighter
 *  (`src/apps/cli/markdown-painter.ts`) when stdout is a TTY and the env
 *  knobs allow it; non-CLI surfaces (recorders, Web) leave it undefined so
 *  the byte stream is verbatim (RFC §1.2 default-OFF byte-identical). */
export interface AssistantTextPainter {
  /** Rewrite a single delta. Returning the input unchanged is a valid
   *  no-op. The painter may buffer (return empty) when it is awaiting more
   *  bytes to disambiguate a markdown token. */
  write(delta: string): string
  /** Drain any pending buffer at turn-end (called from the `tool_call` /
   *  `done` / non-text-event branches). Implementations that don't buffer
   *  may return the empty string. */
  flush(): string
}

export interface StdoutStreamOptions {
  /** When supplied AND `assistant_text` arrives, every delta is funneled
   *  through `painter.write(...)` before being written to stdout. Other
   *  event types call `painter.flush()` first so any pending partial line
   *  is emitted before the boundary marker. */
  readonly painter?: AssistantTextPainter
  /** Host-owned sink. Absent ⇒ the registered shared stdout port. */
  readonly write?: TerminalWriter
}

/** Human-readable stdout renderer. Assistant text streams inline; tool
 *  activity and lifecycle render as dim status lines. */
export class StdoutStream implements StreamPort {
  private inText = false
  private readonly painter: AssistantTextPainter | undefined
  private readonly write: TerminalWriter

  constructor(opts: StdoutStreamOptions = {}) {
    this.painter = opts.painter
    this.write = opts.write ?? writeStdout
  }

  /** Drain the markdown painter buffer (if wired) immediately before
   *  emitting a non-text boundary marker — otherwise a partial header at
   *  end-of-turn would be silently dropped. Hoisted out of `emit` to keep
   *  its cognitive complexity under the biome budget. */
  private drainPainterTail(): void {
    if (this.painter === undefined) return
    const tail = this.painter.flush()
    if (tail !== "") this.write(tail)
  }

  /** Write a single `assistant_text` delta — redacted, then routed through
   *  the markdown painter when wired (byte-identical pass-through when
   *  not). Hoisted out of `emit` so the switch case stays a single
   *  statement (keeps `emit`'s cognitive complexity under the budget). */
  private writeAssistantText(delta: string): void {
    const safe = redactStr(delta)
    const out = this.painter !== undefined ? this.painter.write(safe) : safe
    if (out !== "") this.write(out)
    this.inText = true
  }

  emit(event: AgentEvent): void {
    if (event.type !== "assistant_text" && this.inText) {
      this.drainPainterTail()
      this.write("\n")
      this.inText = false
    }

    switch (event.type) {
      case "session_start":
        this.write(`${DIM}— session start —${RESET}\n`)
        break
      case "turn_start":
        this.write(`${DIM}— turn ${event.turn} —${RESET}\n`)
        break
      case "assistant_text":
        // S4: a secret pasted into model output must not hit the terminal.
        // ADR: inline markdown highlighter — when wired, route the delta
        // through the painter's streaming FSM. When absent, write the
        // delta verbatim (byte-identical to the pre-painter path).
        this.writeAssistantText(event.delta)
        break
      case "tool_call":
        this.write(`${CYAN}⚙ ${event.name}${RESET} ${DIM}${compact(event.input)}${RESET}\n`)
        break
      case "tool_progress":
        this.write(`${DIM}  ↳ ${event.name}: ${oneLine(event.message)}${RESET}\n`)
        break
      case "tool_result": {
        const mark = event.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
        const tail =
          event.stderrTail !== undefined && event.stderrTail !== ""
            ? ` ${DIM}stderr: ${oneLine(redactStr(event.stderrTail))}${RESET}`
            : ""
        this.write(
          `${mark} ${DIM}${event.name}: ${oneLine(redactStr(event.preview))}${RESET}${tail}\n`,
        )
        break
      }
      case "recovery": {
        const detail =
          event.detail !== undefined && event.detail !== ""
            ? `: ${oneLine(redactStr(event.detail))}`
            : ""
        this.write(`${DIM}↺ recovery (${event.reason})${detail}${RESET}\n`)
        break
      }
      case "context_compacted":
        // ADR-0075: one-line proactive-compaction marker — `from..to` lets a
        // grep distinguish the new emit from the legacy `↺ recovery (compact)`
        // line that fires immediately before it.
        this.write(
          `${DIM}↺ context_compacted (${event.fromTurnId}..${event.toTurnId}, ${event.tokens}t)${RESET}\n`,
        )
        break
      case "error":
        this.write(`${RED}error: ${redactStr(event.message)}${RESET}\n`)
        break
      case "llm_request": {
        // Render an unambiguous auth-mode badge so the user can see at a
        // glance whether this turn is on a ChatGPT subscription token or
        // a BYOK API key. ADR-0094 §SOTA — the on-wire path differs
        // (chatgpt.com/backend-api/codex vs api.openai.com / api.anthropic.com)
        // and so does the billing line; do not hide that.
        const badge = event.authMode !== undefined ? ` · ${event.authMode}` : ""
        this.write(`${DIM}— llm request (${event.model})${badge} —${RESET}\n`)
        break
      }
      case "in_progress":
        // ADR-0048: provider "thinking…" heartbeat. The two optional-field
        // branches live in `renderInProgress` so this case stays a single
        // statement (keeps `emit`'s cognitive complexity under the budget).
        this.write(renderInProgress(event))
        break
      case "response_queued":
        this.write(renderResponseQueued(event))
        break
      case "interrupted":
        this.write(renderInterrupted(event))
        break
      case "subagent_cancel":
        this.write(renderSubagentCancel(event))
        break
      case "plan_created":
        this.write(renderPlanCreated(event))
        break
      case "plan_updated":
        this.write(renderPlanUpdated(event))
        break
      case "plan_snapshot":
        this.write(renderPlanSnapshot(event))
        break
      case "plan_user_input_requested":
        this.write(renderPlanUserInputRequested(event))
        break
      case "plan_user_input_resolved":
        this.write(renderPlanUserInputResolved(event))
        break
      case "mode_changed":
        this.write(renderModeChanged(event))
        break
      case "usage":
        this.write(
          `${DIM}— usage ${event.inputTokens}/${event.outputTokens} (${event.model}) —${RESET}\n`,
        )
        break
      case "done":
        this.write(`${DIM}— done (${event.reason}, ${event.turns} turns) —${RESET}\n`)
        break
      case "turn_diff_updated":
        // ADR-0102 turn-diff: one-line dim status summarizing the cumulative
        // diff. The full unified body is recorded by jsonl-recorder; stdout
        // surface shows just the shape (turn, sha range, stats) so a user
        // watching the CLI sees the shape without scrolling through 64 KiB
        // of diff text.
        this.write(
          `${DIM}— turn ${event.turn} diff: ${event.filesChanged} files, +${event.insertions} -${event.deletions} (${event.fromSha.slice(0, 8)}..${event.toSha.slice(0, 8)}) —${RESET}\n`,
        )
        break
      case "decision":
        // Debug/developer-mode (Track A, 2026-05-25): gate-decision tracer
        // line. One-liner — kind/outcome/reason are the three salient facts.
        // The reason is scrubbed (the gate caller is responsible for not
        // leaking secrets in `reason`/`metadata` per the type doc, but we
        // route through `redactStr` anyway as defence-in-depth).
        this.write(
          `${DIM}• decision (${event.kind} → ${event.outcome}): ${oneLine(redactStr(event.reason))}${RESET}\n`,
        )
        break
      case "knobs_applied":
        // Knob telemetry (2026-05-26): per-run resolved knob posture. Render
        // a single dim-status line summarising the surface + active count +
        // cost multiplier. Full id→value/source map lives in the jsonl
        // trajectory line for after-the-fact comparison — stdout is a
        // monitor, not a log. The recorder is the canonical sink; this
        // line is the operator-visible hint that knobs were resolved.
        this.write(renderKnobsApplied(event))
        break
      default: {
        // Exhaustiveness guard: a new AgentEvent variant must be handled
        // explicitly rather than silently rendered (or crashing) here.
        const _exhaustive: never = event
        void _exhaustive
        break
      }
    }
  }
}

/** ADR control-op cluster (L3→L4 promotion 2026-05-23): back-pressure
 *  one-line dim status. PausedReason taxonomy (model_streaming /
 *  awaiting_approval / network_retry / ...) + control_op_pending. Extracted
 *  from `emit` so the switch case stays a single statement (keeps `emit`'s
 *  cognitive complexity under the budget). */
const renderResponseQueued = (event: Extract<AgentEvent, { type: "response_queued" }>): string => {
  const hint = event.hint !== undefined && event.hint !== "" ? `: ${oneLine(event.hint)}` : ""
  return `${DIM}⏸ queued (${event.reason})${hint}${RESET}\n`
}

/** ADR control-op cluster: typed-interrupt observation. `reason` is the
 *  verbatim cancel reason from `conversation_action_cancel` (redacted). */
const renderInterrupted = (event: Extract<AgentEvent, { type: "interrupted" }>): string => {
  const reason =
    event.reason !== undefined && event.reason !== "" ? `: ${oneLine(redactStr(event.reason))}` : ""
  return `${DIM}⛔ interrupted (${event.source})${reason}${RESET}\n`
}

/** ADR control-op cluster: subagent cancel routing observation. Parent KEEPS
 *  running — this is not a finish trigger. */
const renderSubagentCancel = (event: Extract<AgentEvent, { type: "subagent_cancel" }>): string =>
  `${DIM}✂ subagent ${event.subagentId} (${event.outcome}, via ${event.source})${RESET}\n`

/** ADR-0048: render the `in_progress` heartbeat one-liner, appending the
 *  optional percentage + status when the provider carried them. Extracted from
 *  `emit` so the switch case stays a single statement. */
const renderInProgress = (event: Extract<AgentEvent, { type: "in_progress" }>): string => {
  const pct = event.progress !== undefined ? ` ${Math.round(event.progress * 100)}%` : ""
  const msg =
    event.message !== undefined && event.message !== "" ? `: ${oneLine(event.message)}` : ""
  return `${DIM}… thinking${pct}${msg}${RESET}\n`
}

/** Plan-mode cluster (P3): plan_created one-liner. Format pin —
 *  `plan_created` discriminant token is greppable; `name` is quoted; todo
 *  count rendered last. */
const renderPlanCreated = (event: Extract<AgentEvent, { type: "plan_created" }>): string => {
  const count = event.plan.todos.length
  return `${DIM}📋 plan_created "${oneLine(redactStr(event.plan.name))}" (${count} todos)${RESET}\n`
}

/** Plan-mode cluster (P3): plan_updated one-liner. Format pin —
 *  `plan_updated` discriminant token + version + delta kind. */
const renderPlanUpdated = (event: Extract<AgentEvent, { type: "plan_updated" }>): string => {
  const title =
    event.delta.todoTitle !== undefined && event.delta.todoTitle !== ""
      ? ` "${oneLine(redactStr(event.delta.todoTitle))}"`
      : ""
  return `${DIM}📋 plan_updated v${event.version} ${event.delta.kind}${title}${RESET}\n`
}

/** Plan-mode cluster (P3): plan_snapshot one-liner. Format pin —
 *  `plan_snapshot` discriminant token + name + todo count. */
const renderPlanSnapshot = (event: Extract<AgentEvent, { type: "plan_snapshot" }>): string => {
  const count = event.plan.todos.length
  return `${DIM}📋 plan_snapshot "${oneLine(redactStr(event.plan.name))}" (${count} todos)${RESET}\n`
}

/** Plan-mode cluster (P3): plan_user_input_requested one-liner. The
 *  `plan_user_input_requested` discriminant token is greppable. Choices
 *  rendered as a small `[a|b|c]` suffix when present. */
const renderPlanUserInputRequested = (
  event: Extract<AgentEvent, { type: "plan_user_input_requested" }>,
): string => {
  const choices =
    event.choices !== undefined && event.choices.length > 0
      ? ` [${event.choices.map((c) => oneLine(redactStr(c))).join("|")}]`
      : ""
  return `${DIM}❓ plan_user_input_requested "${oneLine(redactStr(event.prompt))}"${choices}${RESET}\n`
}

/** Plan-mode cluster (P3): plan_user_input_resolved one-liner. */
const renderPlanUserInputResolved = (
  event: Extract<AgentEvent, { type: "plan_user_input_resolved" }>,
): string => {
  const text =
    event.text !== undefined && event.text !== "" ? `: "${oneLine(redactStr(event.text))}"` : ""
  return `${DIM}✓ plan_user_input_resolved (${event.decision})${text}${RESET}\n`
}

/** Plan-mode cluster (P3): mode_changed one-liner. */
const renderModeChanged = (event: Extract<AgentEvent, { type: "mode_changed" }>): string => {
  const reason =
    event.reason !== undefined && event.reason !== "" ? `: ${oneLine(redactStr(event.reason))}` : ""
  return `${DIM}↻ mode_changed ${event.from} → ${event.to}${reason}${RESET}\n`
}

/** Knob telemetry (2026-05-26): per-run resolved knob posture one-liner.
 *  Compact summary — full payload is in the jsonl recorder; stdout shows
 *  surface + active count + cost so the operator immediately sees "knobs
 *  ON" without needing to grep the trajectory file. */
const renderKnobsApplied = (event: Extract<AgentEvent, { type: "knobs_applied" }>): string => {
  const activeCount = Object.keys(event.knobs).length
  const presetSegment = event.preset !== null ? ` preset=${event.preset}` : ""
  return `${DIM}⚙ knobs_applied (${event.surface}): ${activeCount} active${presetSegment}, ~${event.costMultiplier}× cost${RESET}\n`
}

/** Mask secrets in a free-text string via the single-source @/shared scrub.
 *  redactValue returns the input unchanged for benign strings. */
const redactStr = (s: string): string => {
  const r = redactValue(s)
  return typeof r === "string" ? r : s
}

const compact = (input: unknown): string => oneLine(JSON.stringify(redactValue(input)) ?? "")

const oneLine = (s: string, max = 160): string => {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
