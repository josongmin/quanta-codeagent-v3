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
  test("ACCEPTS the full Codex spec: none | all | positive integer", () => {
    for (const spec of ["none", "all", 1, 2, 42] as const) {
      const r = SpawnAgentInputSchema.safeParse({ prompt: "x", fork_turns: spec })
      expect(r.success).toBe(true)
      if (r.success) expect(r.data.fork_turns).toBe(spec)
    }
  })

  test("REJECTS 0, negatives, fractions, non-finite, and numeric strings", () => {
    for (const bad of [0, -1, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2", "all "]) {
      const r = SpawnAgentInputSchema.safeParse({ prompt: "x", fork_turns: bad })
      expect(r.success).toBe(false)
    }
  })

  test("still REJECTS genuinely unknown keys (strict preserved)", () => {
    expect(SpawnAgentInputSchema.safeParse({ prompt: "x", bogus_key: 1 }).success).toBe(false)
  })

  test("absent fork_turns parses and stays undefined (byte-identical legacy)", () => {
    const r = SpawnAgentInputSchema.safeParse({ prompt: "x" })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.fork_turns).toBeUndefined()
  })
})
