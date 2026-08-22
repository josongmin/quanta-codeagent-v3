/**
 * The terminal brain declares its surface via a SurfaceProfile (TB21-06 TC-4 —
 * `docs/plans/aug-21-bench-terminal-2-1/TB21-06-transferred-contracts.md`) — the
 * multi-surface-correct form of the env-posture lever.
 *
 * HELLGATE:
 *   - The brain owned-env prompt now arrives via a DECLARED profile
 *     (`TERMINAL_SURFACE_PROFILE`, envPosture:"owned") composed through the pure
 *     `composeSystemPromptForSurface` seam — NOT an inline ad-hoc
 *     `buildSystemPrompt({ envPosture:"owned" })` at the launch site.
 *   - `QUANTA_TB_ENV_OWNED` still GATES it (default-OFF ⇒ frozen ⇒
 *     byte-identical to today).
 *   - The composed owned SYSTEM prompt the loop feeds the model EQUALS
 *     `composeSystemPromptForSurface(TERMINAL_SURFACE_PROFILE, …)` byte-for-byte
 *     (proves the declared profile is what actually renders — no drift between
 *     the declaration and the launch site).
 *
 * Surface-isolation: this test stays INSIDE `src/apps/terminal/**` (mirrors
 * `brain-mode.test.ts`) — it MUST NOT import the headless surface.
 */

import { describe, expect, test } from "bun:test"
import { composeSystemPromptForSurface } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { TERMINAL_OPERATOR_GUIDE } from "@/tool"
import { runTerminalBrain, TB_ENV_OWNED_ENV, TERMINAL_SURFACE_PROFILE } from "./brain-mode"

/** Minimal replay LLM (mirrors brain-mode.test.ts' FakeLlm, kept local to honor the fence). */
class FakeLlm implements LLMPort {
  readonly model = "terminal-fake"
  readonly provider = "terminal"
  readonly authMode = "fake"
  readonly seen: StreamInput[] = []
  private readonly scripts: StreamEvent[][]
  private last: StreamEvent[] = []
  constructor(scripts: StreamEvent[][]) {
    if (scripts.length === 0) throw new Error("FakeLlm requires at least one script")
    this.scripts = scripts
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.seen.push(input)
    const next = this.scripts.shift()
    if (next) this.last = next
    for (const ev of next ?? this.last) yield ev
  }
}

/** One exec turn then a text-final turn. */
const execThenDoneScripts = (command: string): StreamEvent[][] => [
  [
    { type: "tool_use_start", id: "c1", name: "container_exec" },
    { type: "tool_use_end", id: "c1", input: { command } },
    { type: "usage", inputTokens: 5, outputTokens: 2, model: "terminal-fake" },
    { type: "message_stop", stop_reason: "tool_use" },
  ],
  [
    { type: "text_delta", delta: "done" },
    { type: "usage", inputTokens: 2, outputTokens: 1, model: "terminal-fake" },
    { type: "message_stop", stop_reason: "end_turn" },
  ],
]

/** In-memory stdio pair with a hands side that answers any exec frame with a clean exec_result. */
const makeStdio = () => {
  const inBuf: string[] = []
  const resolvers: Array<(v: IteratorResult<string>) => void> = []
  let ended = false
  const pushIn = (line: string): void => {
    const r = resolvers.shift()
    if (r) r({ value: line, done: false })
    else inBuf.push(line)
  }
  const endIn = (): void => {
    ended = true
    for (const r of resolvers.splice(0)) r({ value: "", done: true })
  }
  const stdin: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<string>> {
          const buffered = inBuf.shift()
          if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false })
          if (ended) return Promise.resolve({ value: "", done: true })
          return new Promise((resolve) => resolvers.push(resolve))
        },
      }
    },
  }
  const stdout = {
    write(line: string): void {
      let frame: { type?: string; id?: string }
      try {
        frame = JSON.parse(line)
      } catch {
        return
      }
      if (frame.type === "exec") {
        pushIn(
          JSON.stringify({ type: "exec_result", id: frame.id, stdout: "", stderr: "", code: 0 }),
        )
      }
    },
  }
  return { stdin, stdout, endIn }
}

/** The BRAIN's turn — the one carrying the terminal tool surface (`container_exec`). Selecting by
 *  tool surface (not `seen[0]`) makes the assertion robust to an interleaved background memory-
 *  consolidator turn (a separate LLM call the shared `/tmp` memory store can trigger) whose system
 *  prompt would otherwise masquerade as turn 0. */
const brainTurn = (llm: FakeLlm): StreamInput => {
  const turn = llm.seen.find((s) => (s.tools ?? []).some((t) => t.name === "container_exec"))
  if (!turn) throw new Error("the brain must have streamed at least one turn with its tool surface")
  return turn
}

/** The SYSTEM prompt (string OR block list) the loop fed the model on the brain's turn. */
const brainSystemText = (llm: FakeLlm): string => {
  const sys = brainTurn(llm).system
  if (sys === undefined) return ""
  return typeof sys === "string" ? sys : sys.map((b) => b.text).join("\n")
}

/** The brain turn's offered tool names, sorted. */
const brainToolNames = (llm: FakeLlm): string[] =>
  (brainTurn(llm).tools ?? []).map((t) => t.name).sort()

/** Run the brain once, return the captured LLM. */
const runAndCapture = async (env?: Record<string, string>): Promise<FakeLlm> => {
  const { stdin, stdout, endIn } = makeStdio()
  const llm = new FakeLlm(execThenDoneScripts("echo hi"))
  await runTerminalBrain({
    instruction: "do the task",
    reportOut: "/tmp/brain-surface-profile.json",
    stdin,
    stdout,
    llm,
    writeReport: () => undefined,
    ...(env !== undefined ? { env } : {}),
  })
  endIn()
  return llm
}

describe("terminal brain declares its surface via SurfaceProfile (multi-surface env-posture)", () => {
  test("TERMINAL_SURFACE_PROFILE is a DECLARED value object: owned posture + the terminal operator guide", () => {
    // The lever is a declared profile, not an inline branch at the launch site.
    expect(TERMINAL_SURFACE_PROFILE.envPosture).toBe("owned")
    expect(TERMINAL_SURFACE_PROFILE.operatorGuide).toBe(TERMINAL_OPERATOR_GUIDE)
    // PROMPT-TEXT-ONLY: no runtime-enforcement key rides on the declaration.
    for (const forbidden of ["sandbox", "sandboxPolicy", "policy", "permissions"]) {
      expect(Object.hasOwn(TERMINAL_SURFACE_PROFILE, forbidden)).toBe(false)
    }
  })

  test("knob ON: the brain SYSTEM prompt is EXACTLY the profile composition (declaration ≡ launch-site render)", async () => {
    const llm = await runAndCapture({ [TB_ENV_OWNED_ENV]: "1" })
    const rendered = brainSystemText(llm)
    // The owned prompt the loop actually fed the model matches the pure composer output for the
    // declared profile byte-for-byte — proving the launch site composes the DECLARED profile (no
    // inline ad-hoc build that could drift from the declaration).
    const expected = composeSystemPromptForSurface(TERMINAL_SURFACE_PROFILE, {
      persona: "default",
    })
    expect(rendered).toBe(expected)
    // And that composition IS the owned posture.
    expect(rendered).toContain("[R-ENV-OWNED]")
    expect(rendered).not.toContain("[R-ENV]")
  })

  test("DEFAULT-OFF byte-identical: unset ≡ explicit-off, and both are the FROZEN prompt (no profile applied)", async () => {
    const unset = brainSystemText(await runAndCapture(undefined))
    const off = brainSystemText(await runAndCapture({ [TB_ENV_OWNED_ENV]: "0" }))
    expect(off).toBe(unset)
    // Frozen: the un-applied path keeps today's SWE-bench env guardrails.
    expect(unset).toContain("[R-ENV]")
    expect(unset).not.toContain("[R-ENV-OWNED]")
  })

  test("PROMPT-TEXT-ONLY: applying the owned profile does not change the offered tools", async () => {
    const frozen = brainToolNames(await runAndCapture(undefined))
    const owned = brainToolNames(await runAndCapture({ [TB_ENV_OWNED_ENV]: "1" }))
    expect(owned).toEqual(frozen)
    expect(owned).toContain("container_exec")
    // BASE host tools never leak under either posture.
    for (const base of ["read", "write", "edit", "bash", "grep"]) {
      expect(owned).not.toContain(base)
    }
  })
})
