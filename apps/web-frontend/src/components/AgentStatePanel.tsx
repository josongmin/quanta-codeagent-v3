/**
 * QUANTA_WEB_AGENT_STATE — AgentStatePanel.
 *
 * Renders the agent-state axes the in-band session protocol DROPS, carried
 * out-of-band on the `QUANTA_WEB_AGENT_STATE` channel (mirrors the canvas /
 * observability panes):
 *
 *   - **Mode badge** — the current collaboration mode (`default` / `plan`)
 *     from the latest `mode.changed` frame.
 *   - **Tool progress** — one line per active tool from `tool.progress`
 *     (latest-wins per `toolCallId`; the daemon already clamped the message
 *     to 256 chars).
 *   - **Compaction marker** — an expandable `context.compacted` summary
 *     (native `<details>` so the summary is in the static markup; the daemon
 *     clamped it to 256 chars).
 *   - **Rate-limit chip** — a `ratelimit.snapshot` readout. ALL fields are
 *     optional; any subset (or the empty subset) renders gracefully.
 *   - **Plan input prompt** — a PASSIVE notice that the plan flow paused to
 *     ask the user (`plan.input.requested`). The interactive answer path is
 *     out of scope; this is a read-only "agent is waiting on you" card.
 *
 * The view is produced by a future `useAgentState` hook over
 * `client.onAgentState` (mirrors `useObservabilityState` → `ObservabilityPane`).
 * The panel owns + exports its prop contract here so the hook can target it.
 *
 * Default-OFF: with an empty view (the gate is OFF / no frame has arrived) the
 * panel renders nothing — chat UI unchanged.
 */

import { memo, useState } from "react"
import type {
  PlanInputRequestedMessage,
  RatelimitSnapshotMessage,
  ToolProgressMessage,
} from "../types/protocol"

/** The CLOSED 2-arm outcome an answer affordance emits — mirrors the daemon's
 *  `UserInputOutcome` (an `answer` carries the operator's reply; a `cancelled`
 *  carries no payload). The host maps it to the wire `planInputAnswer` frame. */
export type PlanInputAnswer = { decision: "answer"; text: string } | { decision: "cancelled" }

/** The interactive answer callback. When provided to {@link AgentStatePanel} the
 *  plan-input card renders an ANSWER affordance (text input + Submit/Cancel, plus
 *  choice buttons when the prompt offers choices). Absent ⇒ the card stays
 *  PASSIVE (notice only), byte-identical to the read-only baseline. */
export type OnPlanInputAnswer = (promptId: string, outcome: PlanInputAnswer) => void

/** The current collaboration mode (mirrors `ModeChangedMessage.to`). */
export type AgentMode = "default" | "plan"

/** A clamped compaction marker — the fields the panel reads from the latest
 *  `context.compacted` frame (the daemon already clamped `summary` to 256). */
export interface CompactionMarker {
  readonly summary: string
  readonly tokens: number
}

/**
 * The agent-state view the panel renders — the public contract of the future
 * `useAgentState` hook (mirrors `ObservabilityState`). Every axis is nullable /
 * empty by default so an idle channel renders nothing.
 */
export interface AgentStateView {
  /** The current collaboration mode, or `null` before any `mode.changed`. */
  readonly mode: AgentMode | null
  /** Active tool-progress lines, latest-wins per `toolCallId`. */
  readonly toolProgress: ReadonlyMap<string, ToolProgressMessage>
  /** The latest compaction marker, or `null` if none. */
  readonly compaction: CompactionMarker | null
  /** The latest rate-limit snapshot, or `null` if none. All inner fields
   *  optional — render any subset. */
  readonly ratelimit: RatelimitSnapshotMessage | null
  /** The latest UNRESOLVED plan-input prompt, or `null`. The host clears this
   *  on the matching `plan.input.resolved`. */
  readonly planPrompt: PlanInputRequestedMessage | null
}

/** The empty view — what `useAgentState` returns before any frame arrives.
 *  Exported so callers + tests share one default-OFF baseline. */
export const EMPTY_AGENT_STATE: AgentStateView = {
  mode: null,
  toolProgress: new Map(),
  compaction: null,
  ratelimit: null,
  planPrompt: null,
}

/* shared card + section-label primitives (mirror ObservabilityPane tokens) */
const CARD = "rounded-xl border border-line-subtle bg-surface p-3"
const LABEL = "text-[11px] font-semibold uppercase tracking-wide text-ink-tertiary"

/**
 * Does this view carry any agent-state axis (mode / tool-progress / compaction /
 * ratelimit / plan-prompt)? SSOT for the panel's self-hide AND the App-level
 * column-visibility gate (so the two never drift). NOTE: deliberately EXCLUDES
 * `plan` — a live plan is rendered by `PlanPanel`, not this panel; the App gates
 * the column on `plan !== null || agentStateHasContent(...)`.
 */
export const agentStateHasContent = (state: AgentStateView): boolean =>
  state.mode !== null ||
  state.toolProgress.size > 0 ||
  state.compaction !== null ||
  state.ratelimit !== null ||
  state.planPrompt !== null

export interface AgentStatePanelProps {
  readonly state: AgentStateView
  /**
   * Optional interactive answer callback for the plan-input prompt card. When
   * provided, the card renders a text input + Submit/Cancel (and choice buttons
   * if the prompt offers choices) so a WEB user can ANSWER the paused agent.
   * Absent ⇒ the card stays PASSIVE (notice only), byte-identical.
   */
  readonly onAnswer?: OnPlanInputAnswer
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export const AgentStatePanel = memo(
  ({ state, onAnswer }: AgentStatePanelProps): JSX.Element | null => {
    const { mode, toolProgress, compaction, ratelimit, planPrompt } = state
    // Default-OFF: an idle channel renders nothing (chat UI unchanged). Shares
    // the exported predicate so the panel's self-hide and the App-level column
    // gate can never disagree.
    if (!agentStateHasContent(state)) return null
    return (
      <section
        aria-label="agent state"
        data-testid="agent-state-panel"
        className="flex flex-col gap-2"
      >
        <header className="flex items-center justify-between">
          <span className={LABEL}>Agent state</span>
          {mode !== null ? <ModeBadge mode={mode} /> : null}
        </header>
        <PlanPromptCard prompt={planPrompt} {...(onAnswer !== undefined ? { onAnswer } : {})} />
        <ToolProgressList progress={toolProgress} />
        <CompactionMarkerCard marker={compaction} />
        <RatelimitChip snapshot={ratelimit} />
      </section>
    )
  },
)

/* ------------------------------------------------------------------ */
/* Mode badge (mode.changed)                                           */
/* ------------------------------------------------------------------ */

const ModeBadge = ({ mode }: { mode: AgentMode }): JSX.Element => {
  const tone = mode === "plan" ? "bg-info/15 text-info" : "bg-black/[0.05] text-ink-secondary"
  return (
    <span
      data-testid="agent-state-mode"
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}
    >
      {mode}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Tool progress (tool.progress)                                       */
/* ------------------------------------------------------------------ */

/** One line per active tool (latest-wins per `toolCallId`, insertion-ordered).
 *  Empty ⇒ renders nothing. */
const ToolProgressList = memo(
  ({ progress }: { progress: ReadonlyMap<string, ToolProgressMessage> }): JSX.Element | null => {
    if (progress.size === 0) return null
    return (
      <section className={CARD} data-testid="agent-state-progress">
        <h3 className={LABEL}>Tool progress</h3>
        <ul className="mt-1.5 space-y-1">
          {[...progress.values()].map((p) => (
            <li key={p.toolCallId} className="flex gap-1.5 text-xs text-ink-secondary">
              <span className="shrink-0 font-mono text-ink-tertiary">{p.toolName}</span>
              <span className="break-words">{p.message}</span>
            </li>
          ))}
        </ul>
      </section>
    )
  },
)

/* ------------------------------------------------------------------ */
/* Compaction marker (context.compacted)                              */
/* ------------------------------------------------------------------ */

/** A compaction marker with an EXPANDABLE summary. Uses native `<details>`
 *  so the summary text is present in static markup (no JS toggle needed) and
 *  the card collapses by default. Null ⇒ renders nothing. */
const CompactionMarkerCard = memo(
  ({ marker }: { marker: CompactionMarker | null }): JSX.Element | null => {
    if (marker === null) return null
    return (
      <details className={CARD} data-testid="agent-state-compaction">
        <summary className="cursor-pointer list-none">
          <span className={LABEL}>Context compacted</span>{" "}
          <span className="text-[10px] text-ink-tertiary">({marker.tokens} tokens)</span>
        </summary>
        <p className="mt-1.5 whitespace-pre-wrap break-words text-xs text-ink-secondary">
          {marker.summary}
        </p>
      </details>
    )
  },
)

/* ------------------------------------------------------------------ */
/* Rate-limit chip (ratelimit.snapshot)                               */
/* ------------------------------------------------------------------ */

/** Render a `<seconds>s` reset hint from a millisecond field. */
const fmtResetMs = (ms: number): string => `${Math.max(0, Math.round(ms / 1000))}s`

/** A compact rate-limit readout. EVERY field is optional — any subset (or the
 *  empty subset) renders gracefully: only the present fields surface, and a
 *  snapshot with no quota fields still renders the chip frame (so a bare
 *  `ratelimit.snapshot` is not silently invisible). Null ⇒ renders nothing. */
const RatelimitChip = memo(
  ({ snapshot }: { snapshot: RatelimitSnapshotMessage | null }): JSX.Element | null => {
    if (snapshot === null) return null
    const fields: { label: string; value: string }[] = []
    if (snapshot.requestsRemaining !== undefined)
      fields.push({ label: "req", value: String(snapshot.requestsRemaining) })
    if (snapshot.requestsResetMs !== undefined)
      fields.push({ label: "req reset", value: fmtResetMs(snapshot.requestsResetMs) })
    if (snapshot.tokensRemaining !== undefined)
      fields.push({ label: "tok", value: String(snapshot.tokensRemaining) })
    if (snapshot.tokensResetMs !== undefined)
      fields.push({ label: "tok reset", value: fmtResetMs(snapshot.tokensResetMs) })
    return (
      <section className={CARD} data-testid="agent-state-ratelimit">
        <h3 className={LABEL}>Rate limit</h3>
        {fields.length === 0 ? (
          <p className="mt-1 text-xs text-ink-tertiary">No quota fields reported.</p>
        ) : (
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {fields.map((f) => (
              <li
                key={f.label}
                className="rounded-full bg-surface-input px-2 py-0.5 text-[11px] text-ink-secondary"
              >
                <span className="text-ink-tertiary">{f.label}:</span> {f.value}
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  },
)

/* ------------------------------------------------------------------ */
/* Plan input prompt (plan.input.requested) — PASSIVE notice           */
/* ------------------------------------------------------------------ */

/** UUX-2-17 — the description subtext for one choice label, from the wire's
 *  optional `choiceDetails` (matched by label). `undefined` for label-only
 *  prompts and for details without a description ⇒ chip renders label-only,
 *  byte-identical to the pre-fix markup. */
const choiceDescription = (prompt: PlanInputRequestedMessage, label: string): string | undefined =>
  prompt.choiceDetails?.find((d) => d.label === label)?.description

/** A "agent is waiting on you" card for a paused plan flow.
 *
 *  PASSIVE (no `onAnswer`): surfaces the prompt + any offered choices so a
 *  waiting agent is not invisible — byte-identical to the read-only baseline.
 *
 *  INTERACTIVE (`onAnswer` provided): adds an ANSWER affordance — a text input +
 *  Submit/Cancel, and a button per offered choice — so a WEB user can close the
 *  loop. Submitting calls `onAnswer(promptId, {decision:"answer",text})`;
 *  Cancel calls `onAnswer(promptId, {decision:"cancelled"})`. Null ⇒ nothing. */
const PlanPromptCard = memo(
  ({
    prompt,
    onAnswer,
  }: {
    prompt: PlanInputRequestedMessage | null
    onAnswer?: OnPlanInputAnswer
  }): JSX.Element | null => {
    if (prompt === null) return null
    return (
      <section
        className="rounded-xl border border-warn/30 bg-warn/5 p-3"
        data-testid="agent-state-plan-prompt"
      >
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-warn">
          Waiting on you
        </h3>
        <p className="mt-1.5 break-words text-sm text-ink">{prompt.prompt}</p>
        {onAnswer === undefined ? (
          // PASSIVE: offered choices surface as a read-only list (byte-identical).
          prompt.choices !== undefined && prompt.choices.length > 0 ? (
            <ul className="mt-2 list-inside list-disc space-y-0.5 marker:text-ink-faint">
              {prompt.choices.map((c) => {
                const description = choiceDescription(prompt, c)
                return (
                  <li key={c} className="text-xs text-ink-secondary">
                    {c}
                    {description !== undefined ? (
                      <span
                        data-testid="agent-state-plan-choice-description"
                        className="ml-1.5 text-[11px] text-ink-tertiary"
                      >
                        — {description}
                      </span>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : null
        ) : (
          <PlanPromptAnswerForm prompt={prompt} onAnswer={onAnswer} />
        )}
      </section>
    )
  },
)

/** The interactive answer affordance for a paused plan-input prompt. Rendered
 *  ONLY when `onAnswer` is provided (the passive card has no form). A free-text
 *  reply (Submit) + a Cancel, plus a button per offered choice that answers with
 *  the choice text verbatim. */
const PlanPromptAnswerForm = ({
  prompt,
  onAnswer,
}: {
  prompt: PlanInputRequestedMessage
  onAnswer: OnPlanInputAnswer
}): JSX.Element => {
  const [text, setText] = useState("")
  const submit = (): void => {
    onAnswer(prompt.promptId, { decision: "answer", text })
    setText("")
  }
  const cancel = (): void => onAnswer(prompt.promptId, { decision: "cancelled" })
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="agent-state-plan-answer">
      {prompt.choices !== undefined && prompt.choices.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {prompt.choices.map((c) => {
            const description = choiceDescription(prompt, c)
            return (
              <button
                key={c}
                type="button"
                data-testid="agent-state-plan-choice"
                onClick={() => onAnswer(prompt.promptId, { decision: "answer", text: c })}
                className="rounded-full bg-surface-input px-2 py-0.5 text-left text-[11px] text-ink-secondary hover:bg-surface"
              >
                {c}
                {description !== undefined ? (
                  // UUX-2-17 — description subtext INSIDE the chip (the label
                  // stays the answered value; the subtext is context only).
                  <span
                    data-testid="agent-state-plan-choice-description"
                    className="block text-[10px] font-normal text-ink-tertiary"
                  >
                    {description}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}
      <textarea
        data-testid="agent-state-plan-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type your answer…"
        rows={2}
        className="w-full resize-y rounded-lg border border-line-subtle bg-surface px-2 py-1 text-xs text-ink"
      />
      <div className="flex gap-1.5">
        <button
          type="button"
          data-testid="agent-state-plan-submit"
          onClick={submit}
          className="rounded-lg bg-info/15 px-2.5 py-1 text-xs font-medium text-info hover:bg-info/25"
        >
          Submit
        </button>
        <button
          type="button"
          data-testid="agent-state-plan-cancel"
          onClick={cancel}
          className="rounded-lg bg-black/[0.05] px-2.5 py-1 text-xs font-medium text-ink-secondary hover:bg-black/[0.08]"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
