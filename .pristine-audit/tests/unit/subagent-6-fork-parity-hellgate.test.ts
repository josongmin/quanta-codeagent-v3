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
  type SubagentRequest,
  type SubagentResult,
  type SubagentRunner,
  TaskRegistry,
} from "@/subagent"
import { agentSchema } from "@/subagent/agent-tool"

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
  for await (const _ev of tool.execute({ prompt, fork_turns: spec } as never, ctx())) void _ev
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

// C5059-04 STRENGTHENING (adversarial test-audit gaps): the two schemas are
// hand-copied duplicates whose "EXACTLY in sync" contract had NO test — a
// one-sided edit (e.g. 6-tool positive() while trio stays min(0)) silently
// diverged and every parity test stayed green. These pin the real seams.
describe("ALBB-16 / C5059-04 — fork_turns schema + default + boundary hardening", () => {
  test("trio and 6-tool FORK_TURNS accept-sets are IDENTICAL (permanent divergence guard)", () => {
    // Scope is the fork_turns FIELD (valid prompt held fixed) — the two schemas
    // are hand-copied unions that must stay in lockstep. NOTE: the schemas
    // intentionally DIFFER on the `prompt` field (below), so this parity is
    // deliberately fork_turns-only, not whole-schema.
    const cases = [
      "none",
      "all",
      0,
      1,
      2,
      1_000_000_000,
      -1,
      1.5,
      "2",
      true,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]
    for (const v of cases) {
      const six = SpawnAgentInputSchema.safeParse({ prompt: "x", fork_turns: v }).success
      const trio = agentSchema.safeParse({ prompt: "x", fork_turns: v }).success
      expect(six, `divergence on ${JSON.stringify(v)}`).toBe(trio)
    }
  })

  test("6-tool prompt is STRICTER than trio (empty prompt rejected) — an intentional, pinned difference", () => {
    // The audit flagged that a blanket "accept-sets identical" claim is false for
    // the prompt field: 6-tool has .min(1).max(32768), trio has neither. Pin the
    // intended asymmetry so it can't silently flip.
    expect(SpawnAgentInputSchema.safeParse({ prompt: "" }).success).toBe(false)
    expect(agentSchema.safeParse({ prompt: "" }).success).toBe(true)
  })

  test("ABSENT fork_turns ⇒ cold start (default is 'none', NOT 'all')", async () => {
    // Kills the `?? "all"` handler mutation — the existing helper always passes a
    // spec, so the default-when-absent branch was untested.
    const seen: string[] = []
    const runner: SubagentRunner = async (req) => {
      seen.push(req.prompt)
      return { ok: true, finalText: "done", turns: 1 }
    }
    const parsed = SpawnAgentInputSchema.parse({ prompt: "plain" }) // no fork_turns key
    await handleSpawnAgent(parsed, { runner, registry: new TaskRegistry(), forkPrompt } as never)
    await new Promise<void>((r) => setTimeout(r, 5))
    expect(seen.at(-1)).toBe("plain")
    expect(seen.at(-1)).not.toContain("Inherited parent context")
  })

  test("fork_turns:0 is end-to-end byte-identical to 'none' (schema→handler)", async () => {
    const zero = await sixToolChildPrompt("task", 0)
    const none = await sixToolChildPrompt("task", "none")
    expect(zero).toBe("task")
    expect(zero).toBe(none)
  })

  test("large N (1e9) end-to-end clamps to all available turns", async () => {
    const big = await sixToolChildPrompt("task", 1_000_000_000)
    expect(big).toContain("what is X?") // inherited back to the first user turn
    expect(big).toBe(await sixToolChildPrompt("task", "all"))
  })
})
