import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type {
  PlanInputRequestedMessage,
  RatelimitSnapshotMessage,
  ToolProgressMessage,
} from "../types/protocol"
import { AgentStatePanel, type AgentStateView, EMPTY_AGENT_STATE } from "./AgentStatePanel"

const progress = (toolCallId: string, toolName: string, message: string): ToolProgressMessage => ({
  kind: "tool.progress",
  toolCallId,
  toolName,
  message,
  emittedAt: 0,
})

const planPrompt = (prompt: string, choices?: readonly string[]): PlanInputRequestedMessage => ({
  kind: "plan.input.requested",
  promptId: "p1",
  prompt,
  ...(choices !== undefined ? { choices } : {}),
  emittedAt: 0,
})

const view = (over: Partial<AgentStateView>): AgentStateView => ({ ...EMPTY_AGENT_STATE, ...over })

describe("AgentStatePanel", () => {
  // Default-OFF: an empty view (gate OFF / no frame) renders nothing.
  it("renders nothing for the empty view (default-OFF)", () => {
    const markup = renderToStaticMarkup(<AgentStatePanel state={EMPTY_AGENT_STATE} />)
    expect(markup).toBe("")
  })

  it("renders the mode badge from the current collaboration mode", () => {
    const markup = renderToStaticMarkup(<AgentStatePanel state={view({ mode: "plan" })} />)
    expect(markup).toContain('data-testid="agent-state-mode"')
    expect(markup).toContain("plan")
    // The plan-mode badge uses the info tone, not the neutral default tone.
    expect(markup).toContain("text-info")
  })

  it("renders one tool_progress line per active tool (name + clamped message)", () => {
    const markup = renderToStaticMarkup(
      <AgentStatePanel
        state={view({
          toolProgress: new Map([
            ["t1", progress("t1", "bash", "running tests")],
            ["t2", progress("t2", "grep", "scanning files")],
          ]),
        })}
      />,
    )
    expect(markup).toContain('data-testid="agent-state-progress"')
    // Both tools surface — one line each, name + message.
    expect(markup).toContain("bash")
    expect(markup).toContain("running tests")
    expect(markup).toContain("grep")
    expect(markup).toContain("scanning files")
  })

  it("renders an expandable compaction marker whose summary is in the markup", () => {
    const markup = renderToStaticMarkup(
      <AgentStatePanel
        state={view({ compaction: { summary: "compacted 12 turns into a digest", tokens: 4096 } })}
      />,
    )
    expect(markup).toContain('data-testid="agent-state-compaction"')
    // Native <details>/<summary> ⇒ the summary text is present even collapsed.
    expect(markup).toContain("<details")
    expect(markup).toContain("compacted 12 turns into a digest")
    expect(markup).toContain("4096")
  })

  // The rate-limit chip TOLERATES any field subset — including the empty subset
  // (a bare ratelimit.snapshot with only the two required stamps). It must still
  // render the chip frame so a waiting agent's signal is not silently invisible.
  it("renders the rate-limit chip for the empty field subset", () => {
    const bare: RatelimitSnapshotMessage = {
      kind: "ratelimit.snapshot",
      observedAt: 1,
      emittedAt: 1,
    }
    const markup = renderToStaticMarkup(<AgentStatePanel state={view({ ratelimit: bare })} />)
    expect(markup).toContain('data-testid="agent-state-ratelimit"')
    // No quota fields ⇒ a graceful placeholder, not a crash / blank.
    expect(markup).toContain("No quota fields reported.")
  })

  it("renders a rate-limit chip per present field (partial subset)", () => {
    const partial: RatelimitSnapshotMessage = {
      kind: "ratelimit.snapshot",
      requestsRemaining: 7,
      tokensResetMs: 30_000,
      observedAt: 1,
      emittedAt: 1,
    }
    const markup = renderToStaticMarkup(<AgentStatePanel state={view({ ratelimit: partial })} />)
    expect(markup).toContain('data-testid="agent-state-ratelimit"')
    expect(markup).toContain("7")
    // tokensResetMs is rendered as a `<seconds>s` hint (30_000ms ⇒ 30s).
    expect(markup).toContain("30s")
    // The absent placeholder must NOT show when a field is present.
    expect(markup).not.toContain("No quota fields reported.")
  })

  it("renders a PASSIVE plan-input prompt card (notice only, no answer affordance)", () => {
    const markup = renderToStaticMarkup(
      <AgentStatePanel state={view({ planPrompt: planPrompt("Pick a strategy", ["a", "b"]) })} />,
    )
    expect(markup).toContain('data-testid="agent-state-plan-prompt"')
    expect(markup).toContain("Waiting on you")
    expect(markup).toContain("Pick a strategy")
    // Offered choices surface as a passive list.
    expect(markup).toContain("a")
    expect(markup).toContain("b")
    // PASSIVE: no interactive answer affordance (no input / submit button).
    expect(markup).not.toContain("<textarea")
    expect(markup).not.toContain("<button")
    // The interactive answer wrapper is absent without `onAnswer`.
    expect(markup).not.toContain('data-testid="agent-state-plan-answer"')
  })

  // INTERACTIVE: with `onAnswer` the card grows a text input + Submit/Cancel so a
  // WEB user can close the loop. (The passive byte-identical case is above.)
  it("renders the ANSWER affordance (input + Submit/Cancel) when onAnswer is provided", () => {
    const markup = renderToStaticMarkup(
      <AgentStatePanel
        state={view({ planPrompt: planPrompt("Pick a strategy") })}
        onAnswer={() => {}}
      />,
    )
    expect(markup).toContain('data-testid="agent-state-plan-prompt"')
    expect(markup).toContain("Waiting on you")
    expect(markup).toContain("Pick a strategy")
    // The interactive affordance is present.
    expect(markup).toContain('data-testid="agent-state-plan-answer"')
    expect(markup).toContain('data-testid="agent-state-plan-input"')
    expect(markup).toContain('data-testid="agent-state-plan-submit"')
    expect(markup).toContain('data-testid="agent-state-plan-cancel"')
    expect(markup).toContain("<textarea")
    expect(markup).toContain("Submit")
    expect(markup).toContain("Cancel")
  })

  it("renders a choice button per offered choice in the ANSWER affordance", () => {
    const markup = renderToStaticMarkup(
      <AgentStatePanel
        state={view({ planPrompt: planPrompt("Pick one", ["red", "blue"]) })}
        onAnswer={() => {}}
      />,
    )
    // Each choice becomes a clickable button (not a passive <li>).
    const choiceButtons = markup.split('data-testid="agent-state-plan-choice"').length - 1
    expect(choiceButtons).toBe(2)
    expect(markup).toContain("red")
    expect(markup).toContain("blue")
  })

  // UUX-2-17 (jul-10 W4) — ask_user option structure reaches the chips: when the
  // wire carries `choiceDetails`, each chip renders its description as subtext
  // (interactive AND passive). Label-only prompts render exactly as before.
  describe("choice description subtext (UUX-2-17)", () => {
    const richPrompt: PlanInputRequestedMessage = {
      kind: "plan.input.requested",
      promptId: "p1",
      prompt: "How to integrate?",
      choices: ["merge", "rebase"],
      choiceDetails: [{ label: "merge" }, { label: "rebase", description: "replay commits" }],
      emittedAt: 0,
    }

    it("interactive chips render the description under the label", () => {
      const markup = renderToStaticMarkup(
        <AgentStatePanel state={view({ planPrompt: richPrompt })} onAnswer={() => {}} />,
      )
      expect(markup).toContain("rebase")
      expect(markup).toContain("replay commits")
      expect(markup).toContain('data-testid="agent-state-plan-choice-description"')
      // Still exactly one chip per choice — the subtext lives INSIDE the chip.
      expect(markup.split('data-testid="agent-state-plan-choice"').length - 1).toBe(2)
    })

    it("passive list renders the description too (read-only surface stays honest)", () => {
      const markup = renderToStaticMarkup(
        <AgentStatePanel state={view({ planPrompt: richPrompt })} />,
      )
      expect(markup).toContain("replay commits")
      expect(markup).toContain('data-testid="agent-state-plan-choice-description"')
    })

    it("label-only prompts render no description chrome (byte-identical baseline)", () => {
      const markup = renderToStaticMarkup(
        <AgentStatePanel
          state={view({ planPrompt: planPrompt("Pick one", ["red", "blue"]) })}
          onAnswer={() => {}}
        />,
      )
      expect(markup).not.toContain('data-testid="agent-state-plan-choice-description"')
    })
  })
})
