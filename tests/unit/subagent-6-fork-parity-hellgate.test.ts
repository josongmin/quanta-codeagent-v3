/**
 * HELLGATE — ALBB-16 #2: the 6-tool `spawn_agent` path must inherit the SAME
 * fork-turns context the trio `agent` tool does — from ONE shared `forkPrompt`
 * source, so the two child prompts are byte-identical (no divergent second impl).
 *
 * The buggy impl: `forkPrompt` existed ONLY on the trio `createAgentTool`. The
 * 6-tool dispatch (`Subagent6Deps` → `handleSpawnAgent`) had no `forkPrompt`
 * field, so `spawn_agent(fork_turns:"all")` built the child request with the RAW
 * prompt — zero inheritance (feature-parity hole).
 *
 * Fix: `forkPrompt?` added to `Subagent6Deps`, forwarded in `routeSpawnAgent`,
 * composed in `handleSpawnAgent` reading `input.fork_turns ?? "none"`. The
 * composition root injects the SAME closure both surfaces use.
 *
 * PROOF (paired control): drive the trio + the 6-tool over the SAME transcript +
 * spec with the SAME `forkPrompt`, capture each child's `req.prompt`, assert
 * BYTE-IDENTICAL. MUTATION: the no-`forkPrompt`-in-`Subagent6Deps` impl leaves
 * the 6-tool prompt RAW (no preamble) ⇒ the two prompts diverge ⇒ RED.
 */
import { describe, expect, test } from "bun:test"
import { buildForkTurnsPreamble, composeForkedPrompt } from "@/agent/fork-turns"
import { redactTranscript } from "@/agent/tier1/advisor"
import type { Message } from "@/llm"
import {
  createAgentTool,
  handleSpawnAgent,
  SpawnAgentInputSchema,
  TaskRegistry,
  type SubagentRequest,
  type SubagentResult,
  type SubagentRunner,
} from "@/subagent"

const u = (t: string): Message => ({ role: "user", content: [{ type: "text", text: t }] })
const a = (t: string): Message => ({ role: "assistant", content: [{ type: "text", text: t }] })

// Shared transcript both surfaces inherit from, and the ONE shared forkPrompt
// closure (mirrors what `buildSubagentBlock` wires for BOTH surfaces).
const transcript: Message[] = [u("what is X?"), a("X is Y"), u("now do Z")]
const forkPrompt = (prompt: string, spec: "none" | "all" | number): string =>
  composeForkedPrompt(prompt, buildForkTurnsPreamble(transcript, spec, redactTranscript))

const ctx = () => ({ cwd: "/tmp", signal: new AbortController().signal }) as never

/** Capture the composed `req.prompt` the trio `agent` tool hands the runner. */
const trioChildPrompt = async (prompt: string, spec: "none" | "all" | number): Promise<string> => {
  const seen: string[] = []
  const runner: SubagentRunner = async (req: SubagentRequest): Promise<SubagentResult> => {
    seen.push(req.prompt)
    return { ok: true, finalText: "done", turns: 1 }
  }
  const registry = new TaskRegistry()
  const tool = createAgentTool({ runner, registry, forkPrompt })
  for await (const _ev of tool.execute(
    { prompt, fork_turns: spec } as never,
    ctx(),
  )) void _ev
  const last = seen.at(-1)
  if (last === undefined) throw new Error("trio runner never invoked")
  return last
}

/** Capture the composed `req.prompt` the 6-tool spawn handler hands the runner. */
const sixToolChildPrompt = async (
  prompt: string,
  spec: "none" | "all" | number,
): Promise<string> => {
  const seen: string[] = []
  const runner: SubagentRunner = async (req: SubagentRequest): Promise<SubagentResult> => {
    seen.push(req.prompt)
    return { ok: true, finalText: "done", turns: 1 }
  }
  const registry = new TaskRegistry()
  // C5059-04: route through the REAL strict schema parse (no `as never` on the
  // input) so this exercises the model-visible path: schema.parse → handler. A
  // pre-activation schema would throw on `fork_turns` here.
  const parsed = SpawnAgentInputSchema.parse({ prompt, fork_turns: spec })
  await handleSpawnAgent(parsed, { runner, registry, forkPrompt } as never)
  // Spawn is fire-and-forget; let the runner receive the request.
  await new Promise<void>((r) => setTimeout(r, 5))
  const last = seen.at(-1)
  if (last === undefined) throw new Error("6-tool runner never invoked")
  return last
}

describe("ALBB-16 #2 — 6-tool spawn_agent fork parity (shared source)", () => {
  test("fork_turns:'all' — trio and 6-tool child prompts are BYTE-IDENTICAL", async () => {
    const trio = await trioChildPrompt("child task", "all")
    const six = await sixToolChildPrompt("child task", "all")
    // Both must carry the inherited-context preamble…
    expect(six).toContain("Inherited parent context")
    expect(six).toContain("now do Z")
    // …and be produced by the SAME shared source (no divergent reimplementation).
    expect(six).toBe(trio)
  })

  test("fork_turns:'none' — both cold-start byte-identical to the raw prompt", async () => {
    const trio = await trioChildPrompt("plain", "none")
    const six = await sixToolChildPrompt("plain", "none")
    expect(trio).toBe("plain")
    expect(six).toBe("plain")
    expect(six).toBe(trio)
  })

  test("fork_turns:N — the last-N selection is identical across both surfaces", async () => {
    const trio = await trioChildPrompt("t", 1)
    const six = await sixToolChildPrompt("t", 1)
    expect(six).toContain("now do Z")
    expect(six).not.toContain("what is X?")
    expect(six).toBe(trio)
  })
})
