import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { type AgentConfig, runAgent } from "@/agent"
import { createSubagentMailbox, type MailboxPort } from "@/agent/subagent-mailbox"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, text, toolUse, withTimeout } from "./_harness"

/**
 * REAL-LOOP FAKE-LLM e2e for `subagent-read-inbox` (ADR-0419 —
 * `subagent_read_messages`, gate `AgentConfig.subagentMailbox`).
 *
 * The GAP this closes: every prior test drives the read tool either at the TOOL
 * level (`tool.execute(...)` in `subagent-mailbox-read-hellgate.test.ts`) or at
 * the BUILDER level (`buildSubagentMailboxBlock(cfg)` returns the tools). NOTHING
 * drives the FULL `runAgent × scripted-LLM` chain — i.e. that setting
 * `config.subagentMailbox` actually causes `buildSessionFeatures` →
 * `buildSubagentMailboxBlock` → `buildEffectiveConfig` to REGISTER the tool into
 * the live registry the loop dispatches against, so the model can call
 * `subagent_read_messages` and receive a peer's mail mid-run. "the tool works in
 * isolation" ≠ "the config slot wires the tool into the real loop".
 *
 * This drives the WHOLE path through the REAL loop:
 *
 *   a peer agent's message is pre-seeded into a REAL `createSubagentMailbox()`
 *   port (broadcast so it delivers to whatever identity the top-level agent
 *   resolves to)
 *     → runAgent(config.subagentMailbox = port) → session-bootstrap →
 *       buildSessionFeatures → buildSubagentMailboxBlock registers the tool →
 *         scripted model turn 1 calls `subagent_read_messages`
 *           → dispatch runs the REAL tool against the REAL port
 *             → the tool_result the model sees carries the peer's body AND the
 *               REAL port marks it delivered (pendingFor → 0)
 *   scripted model turn 2 → final text → completed
 *
 * Control (OFF): NO `subagentMailbox` on the config ⇒ the tool is never
 * registered ⇒ the SAME scripted call yields the loop's `Unknown tool:` deny and
 * the seeded message stays UNDELIVERED in the port (byte-identical default-OFF).
 * That discriminator proves the ON assertion is non-vacuous: it keys on the tool
 * actually being wired into the loop, not merely on the port holding a message.
 */

const PEER_BODY = "handoff: the failing repro lives in tests/regress/XINBOX-903.spec.ts"
const PEER_FROM = "peer-agent/1"

/** Scripted model: turn 1 calls `subagent_read_messages` (default read mode),
 *  turn 2 finishes. Records the tool_result text it received so the test can
 *  assert the peer body actually reached the model. */
class InboxReadingLLM implements LLMPort {
  readonly model = "subagent-inbox-test-model"
  calls = 0
  private readTurn = false
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    if (!this.readTurn) {
      this.readTurn = true
      for (const e of toolUse("r1", "subagent_read_messages", {})) yield e
      return
    }
    for (const e of text("acknowledged the handoff")) yield e
  }
}

const inboxConfig = (llm: LLMPort, mailbox: MailboxPort | undefined): AgentConfig =>
  cfg({
    llm,
    registry: new ToolRegistry([...defaultTools]),
    stream: new RecordingStream(),
    messages: [{ role: "user", content: [{ type: "text", text: "check your inbox" }] }],
    maxTurns: 5,
    ...(mailbox !== undefined ? ({ subagentMailbox: mailbox } as Partial<AgentConfig>) : {}),
  })

/** Pull every tool_result body out of the completed transcript. */
const toolResultTexts = (messages: readonly Message[]): string[] =>
  messages
    .flatMap((m) => m.content)
    .filter((b) => b.type === "tool_result")
    .map((b) => String((b as { content: unknown }).content))

describe("subagent-read-inbox — real runAgent loop registers subagent_read_messages from the config slot", () => {
  beforeEach(() => {
    __resetRuntimeConfig()
  })
  afterEach(() => {
    __resetRuntimeConfig()
  })

  test("ON: config.subagentMailbox ⇒ the model reads a peer's message through the real loop", async () => {
    // A REAL mailbox port pre-seeded with a peer's BROADCAST message (delivers to
    // every OTHER reader regardless of the top-level agent's resolved identity).
    const port = createSubagentMailbox({ now: () => 1_000 })
    const seeded = port.send({ from: PEER_FROM, to: "*", kind: "broadcast", body: PEER_BODY })
    // Sanity: the message is in the port and undelivered before the run.
    expect(port.list({ from: PEER_FROM })).toHaveLength(1)

    const llm = new InboxReadingLLM()
    const out = await withTimeout(
      runAgent(inboxConfig(llm, port)),
      15_000,
      "subagent-read-inbox-on",
    )

    // 1. The outer loop completed (read turn → tool_result → final turn).
    expect(out.reason).toBe("completed")
    // 2. The loop actually dispatched the read tool then finished (2+ turns).
    expect(llm.calls).toBeGreaterThanOrEqual(2)

    // 3. GROUND TRUTH: the peer's body reached the model as a REAL tool_result —
    //    the tool was registered from the config slot and dispatched live.
    const results = toolResultTexts(out.messages)
    const inboxResult = results.find((r) => r.includes(PEER_BODY))
    expect(inboxResult).toBeDefined()
    // The one-line inbox render carries sender + kind, not an "Unknown tool" deny.
    expect(inboxResult).toContain(PEER_FROM)
    expect(inboxResult).toContain("[broadcast]")
    expect(inboxResult).not.toContain("Unknown tool")

    // 4. REAL SIDE EFFECT on the port: default read mode MARKED the broadcast
    //    delivered for this reader, so a fresh peek by that same reader sees it
    //    no longer pending. We can't know the exact reader id, but SOME reader
    //    consumed it: the message now carries a deliveredAt stamp.
    const afterRun = port.list({ from: PEER_FROM })
    expect(afterRun).toHaveLength(1)
    expect(afterRun[0]?.id).toBe(seeded.id)
    expect(afterRun[0]?.deliveredAt).toBeDefined()
  })

  // ── OFF-PARITY + NON-VACUITY CONTROL ──────────────────────────────────────
  // NO `subagentMailbox` on the config ⇒ `buildSubagentMailboxBlock` returns []
  // ⇒ `subagent_read_messages` is NEVER registered. The SAME scripted call now
  // hits the loop's unknown-tool deny, and no port is touched. If the ON test's
  // assertion were vacuous (e.g. the body leaked in from elsewhere) this control
  // would still surface it — it must NOT.
  test("CONTROL: no config slot ⇒ subagent_read_messages is unregistered (Unknown tool deny)", async () => {
    const port = createSubagentMailbox({ now: () => 1_000 })
    port.send({ from: PEER_FROM, to: "*", kind: "broadcast", body: PEER_BODY })

    const llm = new InboxReadingLLM()
    const out = await withTimeout(
      runAgent(inboxConfig(llm, undefined)),
      15_000,
      "subagent-read-inbox-off",
    )

    expect(out.reason).toBe("completed")
    const results = toolResultTexts(out.messages)
    // The DISCRIMINATOR: the tool was not registered, so the loop denied the
    // call — the peer body NEVER reached the model, and the deny names the tool.
    expect(results.some((r) => r.includes(PEER_BODY))).toBe(false)
    expect(results.some((r) => r.includes("Unknown tool: subagent_read_messages"))).toBe(true)

    // The unrelated port was never consulted by the loop: the seeded message is
    // still UNDELIVERED (no reader touched it).
    const still = port.list({ from: PEER_FROM })
    expect(still).toHaveLength(1)
    expect(still[0]?.deliveredAt).toBeUndefined()
  })
})
