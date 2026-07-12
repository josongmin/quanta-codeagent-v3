/**
 * HELLGATE — C5059-04: `fork_turns` must be REACHABLE through the strict 6-tool
 * `SpawnAgentInputSchema`. The core (`selectForkTurns`/`buildForkTurnsPreamble`
 * + the shared `forkPrompt` closure) already lands, and `handleSpawnAgent` reads
 * `input.fork_turns ?? "none"` — but the model-visible path was INERT because the
 * `.strict()` schema REJECTED the key (`unrecognized key: fork_turns`). Every prior
 * fork test bypassed the schema with `as never`, so no test proved the model could
 * actually pass the field.
 *
 * This gate pins the schema contract itself (parse-level), so the activation can
 * never silently regress back to inert.
 *
 * MUTATION (red-on-injection): removing the `fork_turns` field from the schema
 * (back to the pre-activation `.strict()` object) makes the accept cases RED.
 */
import { describe, expect, test } from "bun:test"
import { SpawnAgentInputSchema } from "@/subagent/tools-6"

describe("C5059-04 — fork_turns reachable through strict 6-tool schema", () => {
  // `0` is ACCEPTED, mirroring the trio `agent` tool's `z.number().int().min(0)`
  // (adversarial-audit R1/F1): `0` ≡ `"none"` (selectForkTurns maps ≤0 ⇒ []). A
  // stricter `.positive()` here would break ALBB-16 trio↔6-tool parity.
  test("ACCEPTS the full Codex spec: none | all | non-negative integer (incl. 0, large N)", () => {
    for (const spec of ["none", "all", 0, 1, 2, 42, 1_000_000] as const) {
      const r = SpawnAgentInputSchema.safeParse({ prompt: "x", fork_turns: spec })
      expect(r.success, `expected accept for ${JSON.stringify(spec)}`).toBe(true)
      if (r.success) expect(r.data.fork_turns).toBe(spec)
    }
  })

  test("REJECTS negatives, fractions, non-finite, numeric strings, and booleans", () => {
    for (const bad of [-1, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2", "all ", true]) {
      const r = SpawnAgentInputSchema.safeParse({ prompt: "x", fork_turns: bad })
      expect(r.success, `expected REJECT for ${JSON.stringify(bad)}`).toBe(false)
    }
  })

  test("still REJECTS genuinely unknown keys (strict preserved)", () => {
    expect(SpawnAgentInputSchema.safeParse({ prompt: "x", bogus_key: 1 }).success).toBe(false)
  })

  test("absent AND explicit-undefined both parse to undefined (byte-identical legacy)", () => {
    const absent = SpawnAgentInputSchema.safeParse({ prompt: "x" })
    const explicit = SpawnAgentInputSchema.safeParse({ prompt: "x", fork_turns: undefined })
    expect(absent.success).toBe(true)
    expect(explicit.success).toBe(true)
    if (absent.success) expect(absent.data.fork_turns).toBeUndefined()
    if (explicit.success) expect(explicit.data.fork_turns).toBeUndefined()
  })

  test("is model-visible: the field renders a description into the generated schema", () => {
    // F2 (R1): a doc-comment alone renders `{type:"object"}` with no prose; only
    // `.describe(...)` survives zodToJsonSchema so the model learns none/all/N.
    const shape = SpawnAgentInputSchema.shape.fork_turns
    expect(shape.description).toBeDefined()
    expect(shape.description).toContain("none")
    expect(shape.description).toContain("last N turns")
  })
})
