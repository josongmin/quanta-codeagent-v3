/**
 * E2E (jul-13 prompt design-system) — proves the shared role/identity primitives
 * survive the FULL execution path, all the way to what a model actually receives.
 *
 * Unlike the unit wiring proofs, these drive the REAL surface builders and the
 * REAL sub-agent code paths (repro-gen, localize) with a capturing fake LLM, and
 * assert the `system` prompt the model is handed carries the primitive-sourced
 * role. If the wiring were severed anywhere between the shared const and the
 * provider call, the captured system prompt would differ.
 */

import { describe, expect, test } from "bun:test"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { DEFAULT_IDENTITIES } from "../identity"
import { agentlessLocalize } from "../issue-hint/agentless-localize"
import { buildTurnContext } from "../prompt"
import { generateReproTests } from "../repro-test/generate"
import { buildSystemPromptForMode, MODE_VARIANT_KEYS } from "../system-prompt"
import { AGENT_NAME, agentOpener, ROLE } from "./shared"

/** Fake LLM that RECORDS the `system` prompt each `stream()` receives, then
 *  yields one valid text chunk so the sub-agent's collector succeeds. This is
 *  the model's-eye view: whatever lands in `sink` is exactly what the provider
 *  would have been sent. */
const capturingLLM = (sink: string[]): LLMPort => ({
  model: "capture",
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    sink.push(typeof input.system === "string" ? input.system : JSON.stringify(input.system))
    yield { type: "text_delta", delta: "def test_probe():\n    assert True\n" }
  },
})

const USER: Message[] = [{ role: "user", content: [{ type: "text", text: "fix the bug" }] }]

/** Assert-and-narrow the first element (fails loudly on empty rather than
 *  silently coercing to a value that would let a broken wiring pass). */
const first = <T>(xs: readonly T[]): T => {
  const v = xs[0]
  if (v === undefined) throw new Error("expected a non-empty array")
  return v
}

describe("role-e2e — primitives reach the model across the real execution path", () => {
  test("real turn assembly (buildTurnContext) ships the opener as the model's system prefix", () => {
    const { system } = buildTurnContext({ baseMessages: USER, cwd: "/repo" })
    const base = first(system).text
    expect(base.split("\n")[0]).toBe(
      agentOpener({ name: AGENT_NAME, role: ROLE.principal, tail: "working autonomously in a" }),
    )
    // paired control: the main surface carries principal, never the sub-agent role.
    expect(base).toContain(ROLE.principal)
    expect(base).not.toContain(ROLE.senior)
  })

  test("buildSystemPromptForMode ships the SSOT identity line for EVERY mode", () => {
    for (const mode of MODE_VARIANT_KEYS) {
      const prompt = buildSystemPromptForMode({ mode })
      // The identity text the SSOT owns for this mode appears verbatim in the
      // full surface prompt — the derivation reaches the real builder output.
      expect(prompt).toContain(first(DEFAULT_IDENTITIES[mode]))
    }
  })

  test("repro-gen sub-agent sends ROLE.pyEngineer as the model's system prompt", async () => {
    const sink: string[] = []
    const out = await generateReproTests({
      issue: "x() returns None instead of []",
      llm: capturingLLM(sink),
      config: { samples: 1 },
    })
    expect(out.length).toBe(1) // the real generate path ran end-to-end
    expect(sink.length).toBe(1) // the model was actually called
    const captured = first(sink)
    expect(captured.split("\n")[0]).toBe(
      agentOpener({
        role: ROLE.pyEngineer,
        tail: "writing a single self-contained pytest test that reproduces a reported bug.",
      }),
    )
    // paired control: the sub-agent got ITS role, not the main-agent role.
    expect(captured).toContain(ROLE.pyEngineer)
    expect(captured).not.toContain(ROLE.principal)
  })

  test("localize sub-agent sends ROLE.senior as the model's system prompt", async () => {
    const sink: string[] = []
    await agentlessLocalize("issue: crash in parser", {
      llm: capturingLLM(sink),
      fileTree: async () => ["src/parser.py", "src/main.py"],
    })
    expect(sink.length).toBe(1)
    const captured = first(sink)
    expect(captured.split("\n")[0]).toBe(
      agentOpener({ role: ROLE.senior, tail: "doing precise file-level fault localization." }),
    )
    expect(captured).not.toContain(ROLE.principal)
  })

  test("cross-surface: agent name is consistent, each surface carries only its OWN role", async () => {
    const main = first(buildTurnContext({ baseMessages: USER, cwd: "/r" }).system).text
    const reproSink: string[] = []
    await generateReproTests({ issue: "bug", llm: capturingLLM(reproSink), config: { samples: 1 } })
    const locSink: string[] = []
    await agentlessLocalize("bug", { llm: capturingLLM(locSink), fileTree: async () => ["a.py"] })
    const repro = first(reproSink)
    const loc = first(locSink)

    // Single name across the whole surface set (drift check).
    expect(main).toContain(`You are ${AGENT_NAME},`)
    // Each surface's role is exactly its own — no foreign seniority variant leaked.
    expect(main).toContain(ROLE.principal)
    expect(repro).toContain(ROLE.pyEngineer)
    expect(loc).toContain(ROLE.senior)
    expect(repro).not.toContain(ROLE.senior) // pyEngineer ≠ senior software engineer
  })
})
